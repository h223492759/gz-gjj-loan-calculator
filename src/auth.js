'use strict';

/**
 * 访问门禁 —— 单一口令，无账号体系
 * ------------------------------------------------------------------
 * 设计目标（个人 / 家庭自托管场景）：
 *   1. 全家人共用一个访问密码，不建账号、不做注册、不发邮件。
 *   2. 密码只以 scrypt 加盐哈希形式落盘，可执行文件里没有明文。
 *   3. 登录后发一个 HMAC 签名的 Cookie（HttpOnly），服务端不存会话表，
 *      重启容器不掉线；改密码会自动轮换密钥，旧会话立刻失效。
 *   4. 连续输错会被临时锁定（内存计数），避免被暴力枚举。
 *   5. 不联网、不引用外部服务、不发任何埋点。
 *
 * 密码来源优先级：
 *   - 环境变量 ACCESS_PASSWORD 一旦设置，就是「唯一真源」：
 *     每次启动都会用它覆盖库里的密码（改 compose 重启即生效）。
 *   - 未设置时用本地 data/auth.json 里的密码；
 *     两者都没有 → 首次启动随机生成一个 12 位密码，
 *     写进容器日志，并落到 data/INITIAL-PASSWORD.txt。
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const INITIAL_PASSWORD_FILE = path.join(DATA_DIR, 'INITIAL-PASSWORD.txt');

/** 出厂默认口令（docker-compose.yml 里带的那个值）。仍在用它时前端会报警。 */
const DEFAULT_PASSWORD = 'gzgjj@2026';

const COOKIE_NAME = 'gzgjj_auth';
const MIN_PASSWORD_LEN = 4;
const MAX_PASSWORD_LEN = 128;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function clampInt(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const SESSION_HOURS = clampInt(process.env.SESSION_HOURS, 12, 1, 24 * 30);
const REMEMBER_DAYS = clampInt(process.env.REMEMBER_DAYS, 30, 1, 365);
const MAX_FAILS = clampInt(process.env.MAX_LOGIN_FAILS, 5, 1, 1000);
const LOCK_SECONDS = clampInt(process.env.LOGIN_LOCK_SECONDS, 60, 0, 24 * 3600);

/* ============================ 基础工具 ============================ */

function normalizePassword(v) {
  if (typeof v !== 'string') return '';
  return v.normalize('NFKC');
}

/** 定长比较，避免按字节短路泄漏信息 */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem
  });
  return {
    algo: 'scrypt',
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    salt: salt.toString('base64'),
    hash: hash.toString('base64')
  };
}

function verifyHash(password, rec) {
  if (!rec || rec.algo !== 'scrypt' || !rec.salt || !rec.hash) return false;
  let expect;
  try {
    expect = Buffer.from(rec.hash, 'base64');
  } catch {
    return false;
  }
  let got;
  try {
    got = crypto.scryptSync(password, Buffer.from(rec.salt, 'base64'), expect.length, {
      N: rec.N || SCRYPT.N,
      r: rec.r || SCRYPT.r,
      p: rec.p || SCRYPT.p,
      maxmem: SCRYPT.maxmem
    });
  } catch {
    return false;
  }
  return safeEqual(got.toString('hex'), expect.toString('hex'));
}

/** 可读、去掉了易混字符（0/O、1/l/I）的随机口令 */
function randomPassword(len) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len || 12);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function readCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return part.slice(idx + 1).trim();
      }
    }
  }
  return null;
}

/* ============================ 状态读写 ============================ */

let state = null;

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${AUTH_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, AUTH_FILE);
  try { fs.chmodSync(AUTH_FILE, 0o600); } catch { /* Windows 上忽略 */ }
}

function applyPassword(password, source) {
  state.password = hashPassword(password);
  state.seededFrom = source;                 // 'env' | 'generated' | 'ui'
  state.isDefault = password === DEFAULT_PASSWORD;
  state.updatedAt = new Date().toISOString();
  state.secret = crypto.randomBytes(32).toString('hex');   // 轮换密钥 → 所有旧会话失效
  state.epoch = (state.epoch || 0) + 1;
  return state;
}

function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  let loaded = null;
  if (fs.existsSync(AUTH_FILE)) {
    try { loaded = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { loaded = null; }
  }

  const envPw = normalizePassword(process.env.ACCESS_PASSWORD);
  const envPinned = envPw.length > 0;

  if (!loaded || !loaded.password || !loaded.secret) {
    state = {
      version: 1,
      secret: crypto.randomBytes(32).toString('hex'),
      epoch: 1,
      password: null,
      seededFrom: null,
      isDefault: false,
      envPinned,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (envPinned) {
      applyPassword(envPw, 'env');
      save();
      announce('已按环境变量 ACCESS_PASSWORD 初始化访问密码（未打印明文）。');
    } else {
      const gen = randomPassword(12);
      applyPassword(gen, 'generated');
      save();
      writeInitialPasswordFile(gen);
      announce([
        '未检测到 ACCESS_PASSWORD，已自动生成一个随机访问密码：',
        '',
        `    访问密码：${gen}`,
        '',
        `（同一串也已写入 ${INITIAL_PASSWORD_FILE}，首次登录后可以删掉该文件）`,
        '想自己指定密码：在 docker-compose.yml 的 ACCESS_PASSWORD 里填一个值，重启容器即可生效。'
      ].join('\n'));
    }
    return state;
  }

  state = loaded;
  state.epoch = Number(state.epoch) || 1;
  state.envPinned = envPinned;

  if (envPinned && !verifyHash(envPw, state.password)) {
    applyPassword(envPw, 'env');
    save();
    announce('检测到 ACCESS_PASSWORD 与本地密码不一致，已按环境变量重置访问密码。');
  } else if (!envPinned && state.isDefault) {
    announce(`⚠️ 当前访问密码仍是出厂默认值，建议尽快在网页「设置」里修改。`, true);
  }

  return state;
}

function writeInitialPasswordFile(gen) {
  const body = [
    '广州公积金买房贷款测算器 —— 首次启动自动生成的访问密码',
    '=========================================================',
    '',
    `访问密码：${gen}`,
    '',
    '登录成功之后，建议：',
    '  1. 在网页「设置」里把它改成自己好记的密码；',
    '  2. 然后删除本文件。',
    '',
    '想固定密码：在 docker-compose.yml 里设置 ACCESS_PASSWORD，重启容器即生效。',
    `生成时间：${new Date().toISOString()}`
  ].join('\n');
  try {
    fs.writeFileSync(INITIAL_PASSWORD_FILE, body, { encoding: 'utf8', mode: 0o600 });
  } catch { /* 写不进去不影响运行 */ }
}

function announce(msg, isWarn) {
  /* eslint-disable no-console */
  const tag = isWarn ? '[auth][警告]' : '[auth]';
  String(msg).split('\n').forEach((line) => console.log(`${tag} ${line}`));
}

/* ============================ 会话令牌 ============================ */

function issueToken(remember) {
  const ttlMs = (remember ? REMEMBER_DAYS * 86400 : SESSION_HOURS * 3600) * 1000;
  const payload = { e: state.epoch, x: Date.now() + ttlMs, r: remember ? 1 : 0 };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', state.secret).update(body).digest('base64url');
  return { token: `${body}.${sig}`, ttlMs };
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', state.secret).update(body).digest('base64url');
  if (!safeEqual(sig, expect)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || Number(payload.e) !== state.epoch) return null;
  if (!Number.isFinite(payload.x) || payload.x < Date.now()) return null;
  return payload;
}

function setAuthCookie(res, token, ttlMs) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ttlMs
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', path: '/' });
}

/* ============================ 防爆破 ============================ */

const attempts = new Map();   // ip -> { fails, until, last }

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function lockState(ip) {
  const rec = attempts.get(ip);
  if (!rec) return { locked: false, fails: 0, retryAfter: 0 };
  if (rec.until && rec.until > Date.now()) {
    return { locked: true, fails: rec.fails, retryAfter: Math.ceil((rec.until - Date.now()) / 1000) };
  }
  return { locked: false, fails: rec.fails, retryAfter: 0 };
}

function noteFail(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { fails: 0, until: 0, last: now };
  // 距离上次失败超过 10 分钟，重新计数
  if (now - rec.last > 10 * 60 * 1000) rec.fails = 0;
  rec.fails += 1;
  rec.last = now;
  if (LOCK_SECONDS > 0 && rec.fails >= MAX_FAILS) {
    rec.until = now + LOCK_SECONDS * 1000;
    rec.fails = 0;
  }
  attempts.set(ip, rec);
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) {
      if (!v.until || v.until < now - 3600e3) attempts.delete(k);
    }
  }
  return lockState(ip);
}

function noteSuccess(ip) {
  attempts.delete(ip);
}

/* ============================ Express 中间件 ============================ */

function requireAuth(req, res, next) {
  const payload = verifyToken(readCookie(req, COOKIE_NAME));
  if (!payload) {
    return res.status(401).json({
      ok: false,
      code: 'UNAUTHORIZED',
      error: '需要访问密码才能查看内容'
    });
  }
  req.auth = { remember: !!payload.r, expiresAt: payload.x };
  return next();
}

/* ============================ 路由处理器 ============================ */

function statusHandler(req, res) {
  const authed = !!verifyToken(readCookie(req, COOKIE_NAME));
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    authed,
    configured: true,
    pinnedByEnv: !!state.envPinned && state.seededFrom === 'env',
    // 默认密码是否仍在用 —— 只在已登录时告知，避免向未登录访客泄漏
    usingDefaultPassword: authed ? !!state.isDefault : false,
    sessionHours: SESSION_HOURS,
    rememberDays: REMEMBER_DAYS,
    minPasswordLength: MIN_PASSWORD_LEN
  });
}

function loginHandler(req, res) {
  const ip = clientIp(req);
  const lock = lockState(ip);
  if (lock.locked) {
    return res.status(429).json({
      ok: false,
      error: `密码输错次数过多，请 ${lock.retryAfter} 秒后再试`
    });
  }

  const password = normalizePassword(req.body && req.body.password);
  if (!password) {
    return res.status(400).json({ ok: false, error: '请输入访问密码' });
  }

  if (!verifyHash(password, state.password)) {
    const after = noteFail(ip);
    const left = Math.max(0, MAX_FAILS - after.fails);
    return res.status(401).json({
      ok: false,
      error: after.locked
        ? `密码不正确。已连续输错 ${MAX_FAILS} 次，请 ${after.retryAfter} 秒后再试`
        : `访问密码不正确${left > 0 && left <= 2 ? `（再错 ${left} 次将暂时锁定）` : ''}`
    });
  }

  noteSuccess(ip);
  const remember = !!(req.body && req.body.remember);
  const { token, ttlMs } = issueToken(remember);
  setAuthCookie(res, token, ttlMs);
  guardNoStore(res);
  return res.json({ ok: true, remember, expiresAt: Date.now() + ttlMs });
}

function logoutHandler(req, res) {
  clearAuthCookie(res);
  guardNoStore(res);
  res.json({ ok: true });
}

/** 退出所有设备：轮换 epoch，已发出的令牌全部作废 */
function logoutAllHandler(req, res) {
  state.epoch = (state.epoch || 0) + 1;
  save();
  clearAuthCookie(res);
  guardNoStore(res);
  res.json({ ok: true, message: '已退出所有设备，请重新输入访问密码' });
}

function changePasswordHandler(req, res) {
  const current = normalizePassword(req.body && req.body.current);
  const next = normalizePassword(req.body && req.body.next);

  if (!verifyHash(current, state.password)) {
    const ip = clientIp(req);
    noteFail(ip);
    return res.status(401).json({ ok: false, error: '当前密码不正确' });
  }
  if (next.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ ok: false, error: `新密码至少 ${MIN_PASSWORD_LEN} 位` });
  }
  if (next.length > MAX_PASSWORD_LEN) {
    return res.status(400).json({ ok: false, error: `新密码最长 ${MAX_PASSWORD_LEN} 位` });
  }
  if (next === current) {
    return res.status(400).json({ ok: false, error: '新密码与当前密码相同' });
  }
  if (state.envPinned) {
    return res.status(409).json({
      ok: false,
      error: '当前密码由 docker-compose 的 ACCESS_PASSWORD 固定，网页修改会在重启后被覆盖。请先清空该环境变量再改。'
    });
  }

  applyPassword(next, 'ui');
  save();

  // 密钥已轮换，给当前设备补发一张新票，其余设备自动掉线
  const { token, ttlMs } = issueToken(true);
  setAuthCookie(res, token, ttlMs);
  guardNoStore(res);
  return res.json({ ok: true, message: '密码已更新，其他已登录设备需要重新输入新密码' });
}

function guardNoStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

/* ============================ 挂载 ============================ */

const PUBLIC_API_PATHS = new Set([
  '/api/health',
  '/api/auth/status',
  '/api/auth/login',
  '/api/auth/logout'
]);

/**
 * 把「/api/* 一律需要口令」的守卫挂到 app 上。
 * 必须在所有业务路由之前调用。
 */
function mountGuard(app) {
  app.use((req, res, next) => {
    const p = req.path || '';
    if (!p.startsWith('/api/')) return next();
    if (PUBLIC_API_PATHS.has(p)) return next();
    return requireAuth(req, res, next);
  });
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_PASSWORD,
  AUTH_FILE,
  INITIAL_PASSWORD_FILE,
  MIN_PASSWORD_LEN,
  init,
  mountGuard,
  requireAuth,
  // 处理器
  statusHandler,
  loginHandler,
  logoutHandler,
  logoutAllHandler,
  changePasswordHandler,
  // 供测试使用
  _internal: {
    hashPassword,
    verifyHash,
    issueToken,
    verifyToken,
    randomPassword,
    getState: () => state,
    readCookie
  }
};
