'use strict';

/**
 * 广州公积金买房贷款测算器 —— 服务端
 * ------------------------------------------------------------------
 * 完全离线：不调用任何外部接口，不做任何上报。
 * 前端为纯静态文件，数据落在本地 SQLite。
 * ------------------------------------------------------------------
 */

const path = require('path');
const fs = require('fs');
const express = require('express');

const R = require('./rules');
const { calculate } = require('./calc');
const { db } = require('./db');
const auth = require('./auth');

const app = express();
const PORT = Number(process.env.PORT) || 8888;

app.disable('x-powered-by');
app.set('trust proxy', false);
app.use(express.json({ limit: '1mb' }));

/* ============================== 访问门禁 ==============================
 * 个人 / 家庭自用：一个口令、一套内容，不建账号。
 * 初始化放最前面，保证任何请求进来时密码状态都已经就绪。
 * ==================================================================== */
auth.init();
auth.mountGuard(app);

/** 接口响应一律不缓存，避免口令失配后浏览器还拿旧的隐私数据 */
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/api/auth/status', auth.statusHandler);
app.post('/api/auth/login', auth.loginHandler);
app.post('/api/auth/logout', auth.logoutHandler);
app.post('/api/auth/logout-all', auth.logoutAllHandler);
app.post('/api/auth/password', auth.changePasswordHandler);

function readVersion() {
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();
  } catch {
    return 'dev';
  }
}
const VERSION = readVersion();

/** 统一用北京时间（UTC+8）落库与返回；不带时区后缀，界面直接展示。
 *  容器时区是 UTC，toISOString() 会差 8 小时，因此显式按 Asia/Shanghai 格式化。 */
const BJ_FMT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});
const nowStr = () => BJ_FMT.format(new Date()).replace(' ', 'T');
const trim = (s, n) => String(s == null ? '' : s).slice(0, n).trim();

/* ============================== 元信息 ============================== */

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: VERSION, time: nowStr() });
});

app.get('/api/meta', (req, res) => {
  const cfg = R.rules();
  const custom = db.prepare('SELECT rate, label FROM presets ORDER BY rate ASC').all();
  res.json({
    version: VERSION,
    city: cfg.city,
    asOf: cfg.as_of,
    policyEffective: cfg.policy_effective,
    freshness: R.freshness(null),
    loan: cfg.loan,
    deposit: cfg.deposit,
    withdraw: cfg.withdraw,
    commercial: cfg.commercial,
    retirement: cfg.retirement,
    sources: cfg.sources,
    disclaimer: cfg.disclaimer,
    customRates: custom,
    defaultInput: {
      mode: 'couple',
      persons: [
        { label: '借款人', birth: '1992-06', category: 'male', balance: 86000, monthlyDeposit: 2600 },
        { label: '共同借款人', birth: '1994-03', category: 'female_manager', balance: 62000, monthlyDeposit: 1900 }
      ],
      loanNeed: 2000000,
      houseTotalPrice: 2600000,
      downRatio: 20,
      loanType: 'first',
      termYears: 30,
      childPolicy: 'one',
      qualityPolicy: 'none',
      isAffordableHousing: false,
      secondHandAge: 0,
      builtAt: null,
      familyMonthlyIncome: 38000,
      commercialRate: 3.0,
      customRates: [3.0, 3.1, 3.25, 3.5, 3.7],
      repayment: 'equal_installment'
    }
  });
});

/* ============================== 测算 ============================== */

app.post('/api/calc', (req, res) => {
  try {
    res.json({ ok: true, result: calculate(req.body || {}) });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

/* ============================ 记录管理 ============================ */

function toRecord(row, withSnapshot) {
  if (!row) return null;
  let payload = {};
  let snapshot = null;
  try { payload = JSON.parse(row.payload); } catch { /* 保持空对象 */ }
  if (withSnapshot && row.snapshot) {
    try { snapshot = JSON.parse(row.snapshot); } catch { snapshot = null; }
  }
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    payload,
    ...(withSnapshot ? { snapshot } : {})
  };
}

function summarizeForSnapshot(payload) {
  try {
    const r = calculate(payload);
    if (!r.ok) return null;
    return {
      asOf: r.asOf,
      loanNeed: r.loanNeed,
      gjjAmount: r.gjjAmount,
      commercialAmount: r.commercialAmount,
      fullCover: r.fullCover,
      maxLoanGjj: r.maxLoanGjj,
      firstMonth: r.payment.total.first,
      totalInterest: r.payment.total.totalInterest,
      termYears: r.termYears,
      rate: r.rate,
      withdrawOnce: r.withdraw.onceLimit
    };
  } catch {
    return null;
  }
}

app.get('/api/records', (req, res) => {
  const rows = db.prepare('SELECT * FROM records ORDER BY updated_at DESC, id DESC').all();
  res.json({ ok: true, records: rows.map((r) => toRecord(r, false)) });
});

app.get('/api/records/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM records WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ ok: false, error: '记录不存在' });
  res.json({ ok: true, record: toRecord(row, true) });
});

app.post('/api/records', (req, res) => {
  const name = trim(req.body && req.body.name, 80) || `测算 ${nowStr().slice(0, 16).replace('T', ' ')}`;
  const payload = (req.body && req.body.payload) || {};
  const t = nowStr();
  const info = db.prepare(
    'INSERT INTO records (name, payload, snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(name, JSON.stringify(payload), JSON.stringify(summarizeForSnapshot(payload)), t, t);
  const row = db.prepare('SELECT * FROM records WHERE id = ?').get(info.lastInsertRowid);
  res.json({ ok: true, record: toRecord(row, true) });
});

/** 更名 / 覆盖保存（在历史数据上改） */
app.put('/api/records/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: '记录不存在' });

  const name = req.body && req.body.name !== undefined ? (trim(req.body.name, 80) || row.name) : row.name;
  const payload = req.body && req.body.payload !== undefined ? req.body.payload : JSON.parse(row.payload);

  db.prepare('UPDATE records SET name = ?, payload = ?, snapshot = ?, updated_at = ? WHERE id = ?')
    .run(name, JSON.stringify(payload), JSON.stringify(summarizeForSnapshot(payload)), nowStr(), id);

  res.json({ ok: true, record: toRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(id), true) });
});

/** 复制为新记录（在原方案上接着改） */
app.post('/api/records/:id/duplicate', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: '记录不存在' });
  const t = nowStr();
  const name = trim(req.body && req.body.name, 80) || `${row.name} 副本`;
  const info = db.prepare(
    'INSERT INTO records (name, payload, snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(name, row.payload, row.snapshot, t, t);
  res.json({ ok: true, record: toRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(info.lastInsertRowid), true) });
});

app.delete('/api/records/:id', (req, res) => {
  const info = db.prepare('DELETE FROM records WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true, deleted: info.changes });
});

/* ---------------------------- 备份 / 恢复 ---------------------------- */

app.get('/api/export', (req, res) => {
  const rows = db.prepare('SELECT * FROM records ORDER BY id ASC').all().map((r) => toRecord(r, true));
  res.setHeader('Content-Disposition', 'attachment; filename="gz-gjj-records.json"');
  res.json({
    ok: true,
    app: 'gz-gjj-loan-calculator',
    version: VERSION,
    exportedAt: nowStr(),
    records: rows
  });
});

app.post('/api/import', (req, res) => {
  const list = req.body && Array.isArray(req.body.records) ? req.body.records : [];
  if (!list.length) return res.status(400).json({ ok: false, error: '没有可导入的记录' });
  const t = nowStr();
  const stmt = db.prepare(
    'INSERT INTO records (name, payload, snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  );
  let n = 0;
  db.transaction(() => {
    list.forEach((r) => {
      if (!r || typeof r !== 'object') return;
      stmt.run(
        trim(r.name, 80) || '导入记录',
        JSON.stringify(r.payload || {}),
        JSON.stringify(summarizeForSnapshot(r.payload || {})),
        t, t
      );
      n += 1;
    });
  })();
  res.json({ ok: true, imported: n });
});

/* --------------------------- 商贷利率预设 --------------------------- */

app.get('/api/presets', (req, res) => {
  res.json({ ok: true, custom: db.prepare('SELECT * FROM presets ORDER BY rate ASC').all() });
});

app.post('/api/presets', (req, res) => {
  const raw = Number(req.body && req.body.rate);
  if (!(raw > 0)) return res.status(400).json({ ok: false, error: '利率需大于 0' });
  const rate = raw > 1 ? raw / 100 : raw;
  const label = trim(req.body && req.body.label, 60) || `商贷 ${(rate * 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
  try {
    const info = db.prepare('INSERT INTO presets (rate, label, created_at) VALUES (?, ?, ?)').run(rate, label, nowStr());
    res.json({ ok: true, preset: db.prepare('SELECT * FROM presets WHERE id = ?').get(info.lastInsertRowid) });
  } catch {
    return res.status(409).json({ ok: false, error: '该利率已存在' });
  }
});

app.delete('/api/presets/:id', (req, res) => {
  const info = db.prepare('DELETE FROM presets WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true, deleted: info.changes });
});

/* ============================== 静态资源 ============================== */

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '1h' }));
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  /* eslint-disable no-console */
  console.log(`[gz-gjj-loan-calculator] ${VERSION} listening on 0.0.0.0:${PORT}`);
  console.log(`[gz-gjj-loan-calculator] 访问 http://<本机IP>:${PORT}`);
  console.log('[gz-gjj-loan-calculator] 需要访问密码才能查看内容（个人 / 家庭单口令门禁）');
  console.log('[gz-gjj-loan-calculator] 完全离线运行，数据仅保存在本地 SQLite');
});
