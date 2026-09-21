'use strict';

/* =========================================================================
   访问门禁断言 —— 纯 Node，不依赖 Express / 数据库
   跑法：node test/auth.test.js
   ========================================================================= */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AUTH_MODULE = require.resolve('../src/auth');

let pass = 0;
let fail = 0;
const failures = [];

function it(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    fail += 1;
    failures.push(`${name}\n      ${e.message}`);
    console.log(`  \u2717 ${name}`);
  }
}

/** 每个场景用全新的临时数据目录 + 干净的模块缓存，避免状态串味 */
function freshAuth(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gzgjj-auth-'));
  const saved = {};
  ['DATA_DIR', 'ACCESS_PASSWORD', 'SESSION_HOURS', 'REMEMBER_DAYS', 'MAX_LOGIN_FAILS', 'LOGIN_LOCK_SECONDS']
    .forEach((k) => { saved[k] = process.env[k]; });

  process.env.DATA_DIR = dir;
  delete process.env.ACCESS_PASSWORD;
  delete process.env.SESSION_HOURS;
  delete process.env.REMEMBER_DAYS;
  delete process.env.MAX_LOGIN_FAILS;
  delete process.env.LOGIN_LOCK_SECONDS;
  Object.keys(env || {}).forEach((k) => {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = String(env[k]);
  });

  delete require.cache[AUTH_MODULE];
  /* eslint-disable global-require */
  const mod = require(AUTH_MODULE);

  return {
    mod,
    dir,
    authFile: path.join(dir, 'auth.json'),
    initialFile: path.join(dir, 'INITIAL-PASSWORD.txt'),
    cleanup() {
      delete require.cache[AUTH_MODULE];
      Object.keys(saved).forEach((k) => {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      });
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  };
}

console.log('\n访问门禁断言');

/* ------------------------- 1. 密码存储与校验 ------------------------- */

it('scrypt 哈希：不存明文，且同一密码每次盐都不同', () => {
  const ctx = freshAuth({});
  try {
    const { hashPassword, verifyHash } = ctx.mod._internal;
    const a = hashPassword('我的家庭口令');
    const b = hashPassword('我的家庭口令');
    assert.strictEqual(a.algo, 'scrypt');
    assert.notStrictEqual(a.salt, b.salt, '盐应随机');
    assert.notStrictEqual(a.hash, b.hash, '同一密码的哈希不应相同');
    assert.ok(!a.hash.includes('我的家庭口令'), '哈希里不该出现明文');
    assert.strictEqual(verifyHash('我的家庭口令', a), true);
    assert.strictEqual(verifyHash('我的家庭口今', a), false, '错一个字符必须校验失败');
    assert.strictEqual(verifyHash('', a), false);
    assert.strictEqual(verifyHash('x', null), false);
  } finally { ctx.cleanup(); }
});

it('auth.json 落盘内容里不含明文密码', () => {
  const ctx = freshAuth({ ACCESS_PASSWORD: 'SuperSecret-9527' });
  try {
    ctx.mod.init();
    const raw = fs.readFileSync(ctx.authFile, 'utf8');
    assert.ok(!raw.includes('SuperSecret-9527'), 'auth.json 不允许出现明文密码');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.password.algo, 'scrypt');
    assert.ok(parsed.secret && parsed.secret.length >= 32, '应写入会话密钥');
  } finally { ctx.cleanup(); }
});

/* --------------------------- 2. 密码来源优先级 --------------------------- */

it('设了 ACCESS_PASSWORD：以它为准，且不生成初始密码文件', () => {
  const ctx = freshAuth({ ACCESS_PASSWORD: 'family-pass-001' });
  try {
    const { getState, verifyHash } = ctx.mod._internal;
    const st = ctx.mod.init();
    assert.strictEqual(verifyHash('family-pass-001', st.password), true);
    assert.strictEqual(st.seededFrom, 'env');
    assert.strictEqual(getState().envPinned, true);
    assert.strictEqual(fs.existsSync(ctx.initialFile), false, '不该再生成随机密码文件');
  } finally { ctx.cleanup(); }
});

it('没设 ACCESS_PASSWORD：首次启动生成随机密码并写入 INITIAL-PASSWORD.txt', () => {
  const ctx = freshAuth({});
  try {
    const st = ctx.mod.init();
    assert.strictEqual(st.seededFrom, 'generated');
    assert.ok(fs.existsSync(ctx.initialFile), '应生成初始密码文件');
    const txt = fs.readFileSync(ctx.initialFile, 'utf8');
    const m = /访问密码：(\S+)/.exec(txt);
    assert.ok(m, '文件里应能读到密码');
    assert.strictEqual(m[1].length, 12, '随机密码长度应为 12');
    assert.strictEqual(ctx.mod._internal.verifyHash(m[1], st.password), true);
  } finally { ctx.cleanup(); }
});

it('环境变量改了就按新值重置（改 compose 重启即生效）', () => {
  const ctx = freshAuth({ ACCESS_PASSWORD: 'first-pass' });
  try {
    ctx.mod.init();
    const before = JSON.parse(fs.readFileSync(ctx.authFile, 'utf8'));
    const { verifyHash } = ctx.mod._internal;
    assert.strictEqual(verifyHash('first-pass', before.password), true);

    // 模拟「改了 compose 再重启」：同目录重新加载模块
    process.env.ACCESS_PASSWORD = 'second-pass';
    delete require.cache[AUTH_MODULE];
    const mod2 = require(AUTH_MODULE);
    const st2 = mod2.init();
    assert.strictEqual(mod2._internal.verifyHash('second-pass', st2.password), true);
    assert.strictEqual(mod2._internal.verifyHash('first-pass', st2.password), false, '旧密码应失效');
    assert.ok(st2.epoch > before.epoch, 'epoch 应递增，旧会话作废');
  } finally { ctx.cleanup(); }
});

it('环境变量留空时，沿用本地 auth.json 里的密码', () => {
  const ctx = freshAuth({ ACCESS_PASSWORD: 'keep-me-please' });
  try {
    ctx.mod.init();
    delete process.env.ACCESS_PASSWORD;
    delete require.cache[AUTH_MODULE];
    const mod2 = require(AUTH_MODULE);
    const st2 = mod2.init();
    assert.strictEqual(mod2._internal.verifyHash('keep-me-please', st2.password), true);
    assert.strictEqual(st2.envPinned, false);
  } finally { ctx.cleanup(); }
});

it('出厂默认密码会被标记出来（用于前端告警）', () => {
  const c = freshAuth({ ACCESS_PASSWORD: 'gzgjj@2026' });
  try {
    const st = c.mod.init();
    assert.strictEqual(st.isDefault, true, '用出厂默认值时应标记 isDefault');

    // 换成自定义密码后，标记应消失
    process.env.ACCESS_PASSWORD = 'my-own-pass';
    delete require.cache[AUTH_MODULE];
    const m2 = require(AUTH_MODULE);
    const st2 = m2.init();
    assert.strictEqual(st2.isDefault, false, '改过之后不该再是默认值');
    assert.strictEqual(m2._internal.verifyHash('my-own-pass', st2.password), true);
  } finally { c.cleanup(); }
});

/* ----------------------------- 3. 会话令牌 ----------------------------- */

it('令牌签发 → 校验通过；篡改内容或签名一律失败', () => {
  const ctx = freshAuth({ ACCESS_PASSWORD: 'token-test' });
  try {
    ctx.mod.init();
    const { issueToken, verifyToken } = ctx.mod._internal;
    const { token } = issueToken(false);
    const payload = verifyToken(token);
    assert.ok(payload, '合法令牌应通过');
    assert.ok(payload.x > Date.now(), '应带未来过期时间');

    const [body, sig] = token.split('.');
    const tamperedBody = `${Buffer.from(JSON.stringify({ e: 99, x: Date.now() + 1e9 }), 'utf8').toString('base64url')}.${sig}`;
    assert.strictEqual(verifyToken(tamperedBody), null, '改内容必须失效');
    assert.strictEqual(verifyToken(`${body}.${sig.slice(0, -2)}xx`), null, '改签名必须失效');
    assert.strictEqual(verifyToken(''), null);
    assert.strictEqual(verifyToken(null), null);
    assert.strictEqual(verifyToken('随便一段字符串'), null);
  } finally { ctx.cleanup(); }
});

it('令牌过期即失效', () => {
  const ctx = freshAuth({ ACCESS_PASSWORD: 'expiry-test', SESSION_HOURS: '1' });
  try {
    ctx.mod.init();
    const st = ctx.mod._internal.getState();
    const { verifyToken } = ctx.mod._internal;
    // 手工造一个已过期的令牌
    const payload = { e: st.epoch, x: Date.now() - 1000, r: 0 };
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', st.secret).update(body).digest('base64url');
    assert.strictEqual(verifyToken(`${body}.${sig}`), null, '过期令牌必须失效');
  } finally { ctx.cleanup(); }
});

it('改密码会轮换密钥：之前发出去的令牌全部作废', () => {
  const ctx = freshAuth({ ACCESS_PASSWORD: 'rotate-a' });
  try {
    let st = ctx.mod.init();
    const { issueToken, verifyToken } = ctx.mod._internal;
    const { token } = issueToken(true);
    assert.ok(verifyToken(token), '改之前应有效');

    // 直接改数据目录里的 auth.json，模拟从别的进程/重启后重置密码
    const file = JSON.parse(fs.readFileSync(ctx.authFile, 'utf8'));
    assert.strictEqual(file.epoch, st.epoch);
    process.env.ACCESS_PASSWORD = 'rotate-b';
    delete require.cache[AUTH_MODULE];
    const mod2 = require(AUTH_MODULE);
    mod2.init();
    assert.strictEqual(mod2._internal.verifyToken(token), null, '旧令牌必须失效');
  } finally { ctx.cleanup(); }
});

it('未登录请求一律 401，且不泄漏任何业务数据', () => {
  const ctx = freshAuth({ ACCESS_PASSWORD: 'guard-test' });
  try {
    ctx.mod.init();
    const calls = [];
    const req = { headers: {}, socket: { remoteAddress: '10.0.0.9' }, path: '/api/records' };
    const res = {
      status(code) { calls.push(['status', code]); return this; },
      json(body) { calls.push(['json', body]); return this; }
    };
    let nexted = false;
    ctx.mod.requireAuth(req, res, () => { nexted = true; });

    assert.strictEqual(nexted, false, '未登录不允许放行');
    assert.deepStrictEqual(calls[0], ['status', 401]);
    assert.strictEqual(calls[1][1].ok, false);
    assert.ok(!('records' in calls[1][1]), '401 响应里不能夹带数据');
  } finally { ctx.cleanup(); }
});

it('带合法 Cookie 的请求可以放行', () => {
  const ctx = freshAuth({ ACCESS_PASSWORD: 'guard-ok' });
  try {
    ctx.mod.init();
    const { issueToken } = ctx.mod._internal;
    const { token } = issueToken(false);
    const req = {
      headers: { cookie: `gzgjj-theme=dark; gzgjj_auth=${token}; other=1` },
      socket: { remoteAddress: '10.0.0.9' },
      path: '/api/records'
    };
    let nexted = false;
    ctx.mod.requireAuth(req, { status() { return this; }, json() { return this; } }, () => { nexted = true; });
    assert.strictEqual(nexted, true, '合法令牌应放行');
    assert.strictEqual(req.auth.remember, false);
  } finally { ctx.cleanup(); }
});

/* ----------------------------- 4. 防爆破 ----------------------------- */

it('/api/health 与 /api/auth/* 之外的接口全部挂门禁', () => {
  const ctx = freshAuth({ ACCESS_PASSWORD: 'mount-test' });
  try {
    ctx.mod.init();
    const captured = [];
    const fakeApp = { use(fn) { captured.push(fn); } };
    ctx.mod.mountGuard(fakeApp);
    assert.strictEqual(captured.length, 1, '应挂 1 个守卫中间件');

    const guard = captured[0];
    const run = (p) => {
      let status = 0;
      let nexted = false;
      guard(
        { path: p, headers: {}, socket: { remoteAddress: '10.0.0.1' } },
        { status(c) { status = c; return this; }, json() { return this; } },
        () => { nexted = true; }
      );
      return { status, nexted };
    };

    assert.deepStrictEqual(run('/api/health'), { status: 0, nexted: true }, '健康检查必须放开（容器 healthcheck 要用）');
    assert.deepStrictEqual(run('/api/auth/status'), { status: 0, nexted: true });
    assert.deepStrictEqual(run('/api/auth/login'), { status: 0, nexted: true });
    assert.deepStrictEqual(run('/api/auth/logout'), { status: 0, nexted: true });

    ['/api/meta', '/api/calc', '/api/records', '/api/records/1', '/api/export', '/api/presets', '/api/import', '/api/auth/password', '/api/auth/logout-all']
      .forEach((p) => {
        assert.strictEqual(run(p).status, 401, `${p} 必须要求口令`);
        assert.strictEqual(run(p).nexted, false, `${p} 不该被放行`);
      });

    assert.strictEqual(run('/').nexted, true, '静态资源不拦（页面本身不含任何数据）');
  } finally { ctx.cleanup(); }
});

it('连续输错会临时锁定，正确密码也暂时不放行', () => {
  const ctx = freshAuth({ ACCESS_PASSWORD: 'lock-test', MAX_LOGIN_FAILS: '3', LOGIN_LOCK_SECONDS: '60' });
  try {
    ctx.mod.init();
    const mk = () => {
      const out = { status: 200, body: null, cookies: [] };   // 200 = 未显式改状态码
      const res = {
        status(c) { out.status = c; return this; },
        json(b) { out.body = b; return this; },
        setHeader() { return this; },
        cookie(n, v) { out.cookies.push([n, v]); return this; }
      };
      return { out, res };
    };

    // 第 1、2 次错：401 且提示还剩几次
    for (let i = 0; i < 2; i += 1) {
      const { out, res } = mk();
      ctx.mod.loginHandler({ body: { password: 'wrong' }, headers: {}, socket: { remoteAddress: '10.9.9.9' } }, res);
      assert.strictEqual(out.status, 401, `第 ${i + 1} 次错误应是 401`);
    }
    // 第 3 次错：触发锁定
    {
      const { out, res } = mk();
      ctx.mod.loginHandler({ body: { password: 'wrong' }, headers: {}, socket: { remoteAddress: '10.9.9.9' } }, res);
      assert.strictEqual(out.status, 401);
      assert.ok(/锁定|秒后再试/.test(out.body.error), `应提示锁定，实际：${out.body.error}`);
    }
    // 锁定期间：即使密码正确也 429
    {
      const { out, res } = mk();
      ctx.mod.loginHandler({ body: { password: 'lock-test' }, headers: {}, socket: { remoteAddress: '10.9.9.9' } }, res);
      assert.strictEqual(out.status, 429, '锁定期间应返回 429');
      assert.ok(out.cookies.length === 0, '锁定期间不能发通行证');
    }
    // 换一个 IP 不受影响
    {
      const { out, res } = mk();
      ctx.mod.loginHandler({ body: { password: 'lock-test' }, headers: {}, socket: { remoteAddress: '10.1.1.1' } }, res);
      assert.strictEqual(out.status, 200, '别的 IP 不该被牵连');
      assert.strictEqual(out.cookies.length, 1, '应下发通行证 Cookie');
      assert.ok(out.cookies[0][1], 'Cookie 值不应为空');
    }
  } finally { ctx.cleanup(); }
});

it('密码正确时下发 HttpOnly 通行证；退出登录会清掉它', () => {
  const ctx = freshAuth({ ACCESS_PASSWORD: 'cookie-test' });
  try {
    ctx.mod.init();
    const cookies = [];
    const cleared = [];
    const res = {
      setHeader() { return this; },
      cookie(n, v, opts) { cookies.push({ n, v, opts }); return this; },
      clearCookie(n, opts) { cleared.push({ n, opts }); return this; },
      json() { return this; }
    };

    ctx.mod.loginHandler(
      { body: { password: 'cookie-test', remember: true }, headers: {}, socket: { remoteAddress: '10.2.2.2' } },
      res
    );
    assert.strictEqual(cookies.length, 1);
    assert.strictEqual(cookies[0].n, 'gzgjj_auth');
    assert.strictEqual(cookies[0].opts.httpOnly, true, '必须 HttpOnly，前端 JS 读不到');
    assert.strictEqual(cookies[0].opts.sameSite, 'lax');
    assert.ok(cookies[0].opts.maxAge > 20 * 86400e3, '勾了记住设备应接近 30 天');

    ctx.mod.logoutHandler({ headers: {}, socket: { remoteAddress: '10.2.2.2' } }, res);
    assert.strictEqual(cleared.length, 1);
    assert.strictEqual(cleared[0].n, 'gzgjj_auth');
  } finally { ctx.cleanup(); }
});

/* ------------------------------- 汇总 ------------------------------- */

console.log(`\n访问门禁：${pass} 项通过${fail ? `，${fail} 项失败` : ''}`);
if (fail) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exitCode = 1;
}
