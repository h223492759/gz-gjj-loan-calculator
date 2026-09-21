'use strict';

/* =========================================================================
   广州公积金买房贷款测算器 —— 前端
   纯原生 JS，无任何外部依赖 / 无 CDN / 不发起任何跨域请求。
   ========================================================================= */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const state = {
  meta: null,
  auth: null,
  records: [],
  mode: 'couple',
  loanType: 'first',
  repayment: 'equal_installment',
  commercialRate: 3.0,
  rates: [3.0, 3.1, 3.25, 3.5, 3.7],
  lastResult: null,
  editingId: null,      // 非空 = 正在修改某条已有记录，保存时覆盖它
  editingName: null,
  currentRecordId: null,
  started: false,
  formInited: false     // 空表单只铺一次；重新登录不清掉正在填的内容
};

/* ----------------------------- 工具函数 ----------------------------- */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 出生日期 → date 控件的 value。
 * 官方《渐进式延迟法定退休年龄》是按「出生年月」划档的，日不参与计算，
 * 所以历史数据里可能只存了 'YYYY-MM'；补一个 '-01' 让 date 控件能正常显示回填。
 */
const birthToInput = (v) => {
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return '';
};

/** 元 → 「x.xx 万」 */
function wan(v, digits) {
  const d = digits == null ? 2 : digits;
  return (num(v) / 10000).toFixed(d);
}
/**
 * 元 → 千分位。
 * 余额 / 月缴存额允许填带角分的真实数值（如 123456.78），
 * 所以有角分就显示到分、是整数就还是整数，不能把用户填的数四舍五入掉。
 */
function yuan(v) {
  return num(v).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
/** 小数 → 百分比字符串 */
function pct(v, digits) {
  const d = digits == null ? 3 : digits;
  return (num(v) * 100).toFixed(d).replace(/\.?0+$/, '') + '%';
}

/**
 * 「百分点数值」→ 显示串。
 * state.rates / state.commercialRate 存的是 3.15 这种百分点（不是 0.0315），
 * 用 pct() 会把 3 显示成 300%，所以这两个字段必须走这里。
 */
function ratePct(v, digits) {
  const d = digits == null ? 2 : digits;
  return num(v).toFixed(d).replace(/\.?0+$/, '') + '%';
}

function toast(msg, ms) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms || 2200);
}

/** 底层请求：不抛异常，把状态码和响应体一并交回，便于区分「未登录」与「真出错」 */
async function req(url, options) {
  const res = await fetch(url, Object.assign({
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin'
  }, options || {}));
  let data;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: `响应解析失败（${res.status}）` };
  }
  return { status: res.status, data };
}

async function api(url, options) {
  const { status, data } = await req(url, options);
  if (status === 401) {
    showLock('登录已过期，请重新输入访问密码');
    throw new Error('需要访问密码');
  }
  if (status >= 400 || data.ok === false) {
    throw new Error(data.error || `请求失败（${status}）`);
  }
  return data;
}

/* ============================ 访问门禁 ============================ */

function showLock(msg) {
  document.body.classList.add('locked');
  const root = $('#appRoot');
  if (root) root.hidden = true;
  const err = $('#lockError');
  if (err) {
    if (msg) { err.textContent = msg; err.hidden = false; } else { err.hidden = true; }
  }
  if (state.started) {
    // 会话过期后回到锁屏，必须把内存里的隐私数据清干净
    state.records = [];
    state.lastResult = null;
    const list = $('#recordList');
    if (list) list.innerHTML = '';
    const res = $('#result');
    if (res) res.innerHTML = '';
  }
  state.started = false;
  const input = $('#lockPassword');
  if (input) setTimeout(() => input.focus(), 30);
}

function hideLock() {
  document.body.classList.remove('locked');
  const root = $('#appRoot');
  if (root) root.hidden = false;
  const err = $('#lockError');
  if (err) err.hidden = true;
}

function lockShake() {
  const card = $('#lockCard');
  if (!card) return;
  card.classList.remove('shake');
  void card.offsetWidth;
  card.classList.add('shake');
  setTimeout(() => card.classList.remove('shake'), 450);
}

function initLock() {
  const form = $('#lockForm');
  if (!form) return;

  const saved = localStorage.getItem('gzgjj-remember');
  if (saved === '1') $('#lockRemember').checked = true;

  $('#lockEyeBtn').addEventListener('click', () => {
    const input = $('#lockPassword');
    input.type = input.type === 'password' ? 'text' : 'password';
    input.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#lockPassword');
    const btn = $('#lockSubmit');
    const password = input.value;
    if (!password) {
      $('#lockError').textContent = '请输入访问密码';
      $('#lockError').hidden = false;
      lockShake();
      return;
    }

    btn.disabled = true;
    btn.textContent = '校验中…';
    try {
      const remember = $('#lockRemember').checked;
      const { status, data } = await req('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password, remember })
      });
      if (status === 200 && data.ok) {
        localStorage.setItem('gzgjj-remember', remember ? '1' : '0');
        input.value = '';
        $('#lockError').hidden = true;
        hideLock();
        await startApp();
        toast('已进入');
        return;
      }
      $('#lockError').textContent = data.error || '访问密码不正确';
      $('#lockError').hidden = false;
      input.select();
      lockShake();
    } catch (err) {
      $('#lockError').textContent = `无法连接本地服务：${err.message}`;
      $('#lockError').hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = '进入';
    }
  });
}

async function doLogout() {
  try { await req('/api/auth/logout', { method: 'POST' }); } catch { /* 忽略 */ }
  state.meta = null;
  showLock('');
  toast('已退出登录');
}

async function doLogoutAll() {
  if (!window.confirm('退出所有设备？其他已登录的设备（手机 / 电脑）都需要重新输入新密码。')) return;
  try {
    await api('/api/auth/logout-all', { method: 'POST' });
    state.meta = null;
    showLock('');
    toast('已退出所有设备');
  } catch (e) {
    toast(e.message, 3200);
  }
}

/* ------------------------------- 主题 ------------------------------- */

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  // 同步浏览器地址栏 / 状态栏配色，手机上不至于「黑底配亮条」
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#15151A' : '#F6F6F3');
}

function initTheme() {
  // 首屏主题已在 index.html 的 head 内联脚本里定好（避免深色模式白闪），
  // 这里只按同一规则再确认一次，并接管手动切换。
  const saved = localStorage.getItem('gzgjj-theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
  $('#themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('gzgjj-theme', next);
  });
}

/* ------------------------------- 页签 ------------------------------- */

function initTabs() {
  $$('#tabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#tabs .tab').forEach((b) => b.classList.toggle('active', b === btn));
      $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === btn.dataset.tab));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

function goTab(name) {
  const btn = $(`#tabs .tab[data-tab="${name}"]`);
  if (btn) btn.click();
}

/* ---------------------------- 表单元件 ---------------------------- */

function optionList(labels, selected) {
  return Object.keys(labels).map((k) =>
    `<option value="${esc(k)}"${k === selected ? ' selected' : ''}>${esc(labels[k])}</option>`
  ).join('');
}

function buildPersonBoxes(mode, preset) {
  const box = $('#personBoxes');
  const cats = state.meta.retirement.categories;
  const catLabels = {};
  Object.keys(cats).forEach((k) => { catLabels[k] = cats[k].label; });
  const count = mode === 'couple' ? 2 : 1;
  // 灰色占位用的示例值：来自 meta.defaultInput，只做提示、不预填成真实值
  const demo = ((state.meta.defaultInput || {}).persons) || [];
  const ph = demo.map((p) => ({
    balance: p.balance != null ? String(p.balance) : '86000',
    deposit: p.monthlyDeposit != null ? String(p.monthlyDeposit) : '2600'
  }));

  box.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const p = (preset && preset[i]) || {};
    const e = ph[i] || ph[0] || { balance: '86000', deposit: '2600' };
    const div = document.createElement('div');
    div.className = 'person-box';
    div.dataset.idx = String(i);
    div.innerHTML = `
      <h3>${i === 0 ? '借款人' : '共同借款人'}</h3>
      <div class="person-grid">
        <div class="span2">
          <label>出生年月日</label>
          <input type="date" class="p-birth" min="1900-01-01" max="${esc(new Date().toISOString().slice(0, 10))}" value="${esc(birthToInput(p.birth))}">
          <div class="hint">按官方《渐进式延迟法定退休年龄》对照表以「出生年月」划档，填到日即可，日不参与计算</div>
        </div>
        <div class="span2">
          <label>身份类别（决定法定退休年龄）</label>
          <select class="p-cat">${optionList(catLabels, p.category || (i === 0 ? 'male' : 'female_manager'))}</select>
        </div>
        <div>
          <label>已有公积金余额 <span class="unit">元</span></label>
          <input type="number" class="p-balance" min="0" step="0.01" inputmode="decimal" value="${p.balance != null ? p.balance : ''}" placeholder="如 ${esc(e.balance)}（可到分）">
        </div>
        <div>
          <label>每月缴存额 <span class="unit">元</span></label>
          <input type="number" class="p-deposit" min="0" step="0.01" inputmode="decimal" value="${p.monthlyDeposit != null ? p.monthlyDeposit : ''}" placeholder="如 ${esc(e.deposit)}（可到分）">
        </div>
      </div>`;
    box.appendChild(div);
  }
}

function buildRateChips() {
  const wrap = $('#rateChips');
  wrap.innerHTML = state.rates.map((r) => {
    const on = Math.abs(r - state.commercialRate) < 1e-9;
    return `<button type="button" class="chip${on ? ' on' : ''}" data-rate="${r}">${ratePct(r, 2)}</button>`;
  }).join('');
  $$('#rateChips .chip').forEach((c) => {
    c.addEventListener('click', () => {
      state.commercialRate = Number(c.dataset.rate);
      buildRateChips();
      runCalc({ quiet: true });
    });
  });

  // 可删除的自定义利率（除默认 5 档之外）
  const customBox = $('#customRateList');
  if (customBox) {
    const defaults = [3.0, 3.1, 3.25, 3.5, 3.7];
    const mine = state.rates.filter((r) => !defaults.some((d) => Math.abs(d - r) < 1e-9));
    customBox.innerHTML = mine.length
      ? mine.map((r) => `<span class="chip">${ratePct(r, 2)}<span class="x" data-del="${r}">×</span></span>`).join('')
      : '<span class="muted">暂无自定义利率</span>';
    $$('#customRateList .x').forEach((x) => {
      x.addEventListener('click', () => {
        const r = Number(x.dataset.del);
        state.rates = state.rates.filter((v) => Math.abs(v - r) > 1e-9);
        if (Math.abs(state.commercialRate - r) < 1e-9) state.commercialRate = state.rates[0] || 3.0;
        buildRateChips();
      });
    });
  }
}

/* ---------------------------- 读数 / 回填 ---------------------------- */

function collect() {
  const persons = $$('#personBoxes .person-box').map((box, i) => ({
    label: i === 0 ? '借款人' : '共同借款人',
    birth: $('.p-birth', box).value,
    category: $('.p-cat', box).value,
    balance: num($('.p-balance', box).value),
    monthlyDeposit: num($('.p-deposit', box).value)
  }));

  return {
    mode: state.mode,
    persons,
    loanNeed: num($('#loanNeed').value) * 10000,
    houseTotalPrice: num($('#houseTotalPrice').value) * 10000,
    downRatio: num($('#downRatio').value) || 20,
    loanType: state.loanType,
    termYears: num($('#termYears').value) || 30,
    childPolicy: $('#childPolicy').value,
    qualityPolicy: $('#qualityPolicy').value,
    isAffordableHousing: $('#isAffordableHousing').checked,
    builtAt: state.builtMode === 'date' ? (($('#builtAt').value || '').trim() || null) : null,
    secondHandAge: state.builtMode === 'age' ? (num($('#secondHandAge').value) || 0) : 0,
    familyMonthlyIncome: num($('#familyMonthlyIncome').value),
    commercialRate: state.commercialRate,
    customRates: state.rates.slice(),
    repayment: 'equal_installment'
  };
}

function fill(payload) {
  const p = payload || {};
  state.mode = p.mode === 'single' ? 'single' : 'couple';
  $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
  buildPersonBoxes(state.mode, p.persons);

  $('#loanNeed').value = p.loanNeed ? (num(p.loanNeed) / 10000) : '';
  $('#houseTotalPrice').value = p.houseTotalPrice ? (num(p.houseTotalPrice) / 10000) : '';
  $('#downRatio').value = p.downRatio != null ? p.downRatio : 20;
  if (p.builtAt) { setBuiltMode('date'); $('#builtAt').value = p.builtAt; }
  else if (num(p.secondHandAge) > 0) { setBuiltMode('age'); $('#secondHandAge').value = p.secondHandAge; }
  else { $('#builtAt').value = ''; $('#secondHandAge').value = ''; }
  $('#termYears').value = p.termYears != null ? Math.min(30, p.termYears) : 30;
  $('#termEcho').textContent = $('#termYears').value;
  $('#familyMonthlyIncome').value = p.familyMonthlyIncome || '';
  $('#isAffordableHousing').checked = !!p.isAffordableHousing;
  $('#childPolicy').value = p.childPolicy || 'none';
  $('#qualityPolicy').value = p.qualityPolicy || 'none';

  state.loanType = p.loanType === 'second' ? 'second' : 'first';
  $$('#typeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.type === state.loanType));

  // 两种还款方式在结果里并列展示，不再提供选择；固定等额本息作为主口径

  if (Array.isArray(p.customRates) && p.customRates.length) {
    const merged = p.customRates.map(Number).filter((v) => v > 0);
    state.rates = Array.from(new Set(merged.map((v) => (v > 1 ? v : v * 100)))).sort((a, b) => a - b);
  }
  if (p.commercialRate) state.commercialRate = num(p.commercialRate) > 1 ? num(p.commercialRate) : num(p.commercialRate) * 100;
  buildRateChips();
  updateDownHint();
}

/** 二手楼楼龄两种填法切换：按建成日期（年月）或直接填楼龄（年） */
function setBuiltMode(mode) {
  state.builtMode = mode === 'age' ? 'age' : 'date';
  $$('#builtSeg button').forEach((b) => b.classList.toggle('on', b.dataset.bmode === state.builtMode));
  const isDate = state.builtMode === 'date';
  $('#builtAt').hidden = !isDate;
  $('#secondHandAge').hidden = isDate;
  // 切换即清空两种填法，避免隐藏的那个残留旧值、切回来时悄悄生效
  $('#builtAt').value = '';
  $('#secondHandAge').value = '';
}

function updateDownHint() {
  const affordable = $('#isAffordableHousing').checked;
  const min = affordable ? state.meta.loan.down_payment.affordable_housing * 100 : state.meta.loan.down_payment.normal * 100;
  $('#downHint').textContent = `现行最低 ${min}%${affordable ? '（保障性住房）' : '（首套及第二套）'}`;
  $('#lprHint').textContent = `${state.meta.commercial.lpr_note} 组合贷首付须同时满足公积金要求。`;
}

/* ------------------------ 空表单 / 编辑态 / 最近记录 ------------------------ */

const EMPTY_RESULT_HTML = `<div class="card empty">
  <p>填好左侧信息后点「开始测算」，这里会给出<br>
  <b>能否满贷 / 需要多少商贷 / 逐年月供对照 / 能提取多少余额</b>。</p>
</div>`;

function renderEmptyState() {
  const box = $('#result');
  if (box) box.innerHTML = EMPTY_RESULT_HTML;
}

/**
 * 首次进入与「重置」都走这里：输入框一律留空，只在灰色占位文字里给示例值 ——
 * 省掉「先删掉预填的默认值再输入」这一步。留空时与服务端默认口径一致
 * （首付 20%、无二手楼建成日期、期限 30 年），所以结果与「手动填默认值」完全相同。
 */
function initBlankForm() {
  const d = (state.meta && state.meta.defaultInput) || {};
  const wanOf = (v) => String(num(v) / 10000);

  state.editingId = null;
  state.editingName = null;
  state.lastResult = null;

  state.mode = 'couple';
  $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === 'couple'));
  buildPersonBoxes('couple', null);

  $('#loanNeed').value = '';
  if (d.loanNeed) $('#loanNeed').placeholder = `例如 ${wanOf(d.loanNeed)}`;
  $('#houseTotalPrice').value = '';
  if (d.houseTotalPrice) $('#houseTotalPrice').placeholder = `如 ${wanOf(d.houseTotalPrice)}；选填，填了才能算首付与提取额`;
  $('#downRatio').value = '';
  setBuiltMode('date');
  $('#builtAt').value = '';
  $('#secondHandAge').value = '';
  $('#termYears').value = 30;
  $('#termEcho').textContent = '30';
  $('#familyMonthlyIncome').value = '';
  if (d.familyMonthlyIncome) $('#familyMonthlyIncome').placeholder = `如 ${d.familyMonthlyIncome}；用于校验月供不超收入 50%`;
  $('#isAffordableHousing').checked = false;
  $('#childPolicy').value = 'none';
  $('#qualityPolicy').value = 'none';

  state.loanType = 'first';
  $$('#typeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.type === 'first'));
  state.repayment = 'equal_installment';

  if (Array.isArray(d.customRates) && d.customRates.length) state.rates = d.customRates.slice();
  if (!state.rates.length) state.rates = [3.0, 3.1, 3.25, 3.5, 3.7];
  const cr = num(d.commercialRate);
  state.commercialRate = cr > 1 ? cr : (cr > 0 ? cr * 100 : state.rates[0]);

  buildRateChips();
  updateDownHint();
  syncEditingUi();
  renderEmptyState();
}

/** 服务端要求「至少一位借款人填了出生年月」且「贷款金额 > 0」，没填够就先别打接口 */
function hasEnoughInput() {
  const anyBirth = $$('#personBoxes .p-birth').some((el) => !!el.value);
  return anyBirth && num($('#loanNeed').value) > 0;
}

/** 编辑态界面：顶部提示 + 保存按钮文案 */
function syncEditingUi() {
  const on = !!state.editingId;
  const banner = $('#editBanner');
  if (banner) banner.hidden = !on;
  const nm = $('#editName');
  if (nm) nm.textContent = state.editingName || '';
}

/** 一条记录的「输入摘要」——记录页与顶部最近卡片共用同一套文案 */
function recordMetaText(rec) {
  const p = (rec && rec.payload) || {};
  const gp = (p.persons || []).map((x) => x.birth).filter(Boolean).join(' + ') || '—';
  const mode = p.mode === 'single' ? '单人' : '双人';
  const need = p.loanNeed ? `贷款 ${wan(p.loanNeed)} 万` : '未填贷款额';
  const totalPrice = p.houseTotalPrice ? ` · 总价 ${wan(p.houseTotalPrice)} 万` : '';
  const term = p.termYears ? ` · ${p.termYears} 年` : '';
  return `${mode} · ${gp} · ${need}${totalPrice}${term}`;
}

/** 把一条记录载入表单（editing=true 时进入编辑态，保存会覆盖该记录） */
function loadRecordIntoForm(rec, opts) {
  const o = opts || {};
  fill(rec.payload);
  state.editingId = o.editing ? rec.id : null;
  state.editingName = o.editing ? rec.name : null;
  syncEditingUi();
  goTab('calc');
  setTimeout(() => runCalc({ quiet: true }), 60);
}

/** 顶部「最近一次」卡片：没有记录就整张隐藏 */
/** 记录时间统一按北京时间显示。
 *  存量记录是 UTC ISO 串（带 Z）→ 解析后 +8 转北京时间；
 *  新记录已是北京时间（无后缀）→ 直接截取。 */
function fmtTime(s) {
  const str = String(s || '');
  if (!str) return '';
  if (/[Zz]$/.test(str) || /[+-]\d{2}:?\d{2}$/.test(str)) {
    const d = new Date(str);
    if (!isNaN(d)) {
      return d.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      }).replace(/\//g, '-');
    }
  }
  return str.slice(0, 16).replace('T', ' ');
}

function renderRecentCard() {
  const card = $('#recentCard');
  if (!card) return;
  const rec = state.records[0];
  if (!rec) { card.hidden = true; return; }
  card.hidden = false;
  card.dataset.id = String(rec.id);
  $('#recentName').textContent = rec.name;
  const t = fmtTime(rec.updatedAt);
  $('#recentMeta').textContent = `${t} · ${recordMetaText(rec)}`;
}

/** 一键复用：把最近一次的输入填回表单（不动记录本身） */
function recentReuse() {
  const rec = state.records[0];
  if (!rec) return;
  state.editingId = null;
  state.editingName = null;
  loadRecordIntoForm(rec);
  toast(`已复用「${rec.name}」的输入`);
}

/** 复制修改：先复制成一条新记录，再在副本上改（保存即覆盖副本） */
async function recentCopyEdit() {
  const rec = state.records[0];
  if (!rec) return;
  try {
    const { record } = await api(`/api/records/${rec.id}/duplicate`, {
      method: 'POST',
      body: JSON.stringify({ name: `${rec.name} 副本` })
    });
    state.records = [record].concat(state.records);
    loadRecordIntoForm(record, { editing: true });
    renderRecentCard();
    toast(`已复制为「${record.name}」，改完点「保存修改」覆盖副本`);
    await loadRecords();
  } catch (e) {
    toast(e.message, 3200);
  }
}

/* ------------------------------ 测算 ------------------------------ */

async function runCalc(opts) {
  const o = opts || {};
  // 自动重算（切换还款方式 / 换利率触发的）在表单还没填够时静默跳过，
  // 不要把「请填写需要贷款的金额」这种红字糊在刚进页面的人脸上。
  if (o.quiet && !hasEnoughInput()) { renderEmptyState(); return; }
  try {
    const { result } = await api('/api/calc', { method: 'POST', body: JSON.stringify(collect()) });
    state.lastResult = result;
    render(result);
    if (!o.quiet) {
      const box = $('#result');
      if (window.innerWidth < 1024) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // 只有主动点「开始测算」才落库；切换选项触发的自动重算（quiet）不重复保存
      await saveRecord({ auto: true });
    }
  } catch (e) {
    $('#result').innerHTML = `<div class="card"><div class="alert alert-bad">${esc(e.message)}</div></div>`;
  }
}

/* ------------------------------ 渲染 ------------------------------ */

function kpi(k, v, sub, hl) {
  return `<div class="kpi${hl ? ' hl' : ''}">
    <div class="k">${esc(k)}</div>
    <div class="v">${v}${sub ? `<small>${sub}</small>` : ''}</div>
  </div>`;
}

function render(r) {
  if (!r || r.ok === false) {
    $('#result').innerHTML = `<div class="card"><div class="alert alert-bad">${esc((r && r.error) || '测算失败')}</div></div>`;
    return;
  }

  const t = r.payment.total;
  const warnList = r.warnings || [];
  const noteList = r.notes || [];

  let html = '';

  /* ---- 结论 ---- */
  const cls = warnList.some((w) => /超出|超过|无法|不成立/.test(w)) ? 'bad' : (r.fullCover ? 'ok' : 'warn');
  html += `<div class="verdict ${cls}">
    <h2>${r.fullCover ? '✅ 可以满贷：纯公积金就够' : '⚠️ 公积金不足以覆盖，需要组合贷'}</h2>
    <p>${esc(r.city)} · ${r.mode === 'couple' ? '双人共同申请' : '单人申请'} · ${esc(r.rate.label)} · ${r.termYears} 年 · ${r.repayment === undefined ? '' : ''}${r.method === 'equal_principal' ? '等额本金' : '等额本息'}</p>
    <div class="verdict-line">
      需要贷款 <b>${wan(r.loanNeed)} 万</b> →
      公积金可贷 <b>${wan(r.gjjAmount)} 万</b>${r.commercialAmount > 0 ? `，缺口 <b>${wan(r.commercialAmount)} 万</b> 需走商贷` : '，<b>无需商贷</b>'}
    </div>
    ${r.termAdjusted ? `<div class="verdict-line">⚠️ 期限已按政策上限自动修正为 <b>${r.termYears} 年</b>（你选的是 ${r.requestedTermYears} 年）</div>` : ''}
  </div>`;

  /* ---- 关键数字 ---- */
  html += `<div class="kpis">
    ${kpi('公积金可贷额度', wan(r.gjjAmount), ' 万', true)}
    ${kpi(r.commercialAmount > 0 ? '需商贷金额' : '商贷金额', wan(r.commercialAmount), ' 万')}
    ${kpi('首月月供', yuan(t.first), ' 元')}
    ${kpi('贷款总利息', wan(t.totalInterest), ' 万')}
    ${kpi('账户余额合计', yuan(r.withdraw.totalBalance), ' 元')}
    ${kpi('能提取的余额', yuan(r.withdraw.safeLimit), ' 元', true)}
    ${kpi('每月自付现金', yuan(r.cashflow.cashMonthly), ' 元')}
  </div>
  <p class="muted" style="margin-top:8px">「能提取的余额」= 提走之后，额度公式仍撑得住本次 <b>${yuan(r.gjjAmount)} 元</b> 贷款的那部分余额，且不超过已付首期房款 ${yuan(r.withdraw.downPayment)} 元${r.totalPriceDerived ? '（总价按贷款额反推）' : ''}。已向下取整到「元」——余额是 ×${r.withdraw.balanceMultiplier} 计入额度的，少提 1 元额度只少 ${r.withdraw.balanceMultiplier} 元，但多提 1 元就会让额度掉 ${r.withdraw.balanceMultiplier} 元，所以请<b>按上面这个整数金额操作</b>，不要自己四舍五入。</p>`;

  /* ---- 预算上限：哪个约束卡住了 ---- */
  const pctOfCap = r.maxLoanGjj > 0 ? [
    ['公积金可贷上限', r.maxLoanGjj, '取三者最小值'],
    ['额度公式合计', r.formulaTotal, '余额×10 + 月缴存额×到退休月数'],
    ['最高限额（含上浮）', r.uplift.upliftCap, r.uplift.text]
  ] : [];

  html += `<div class="sec-title">额度是怎么算出来的</div>
    <div class="rows">
      ${(r.perPerson || []).map((p) => `
        <div class="row">
          <span class="rk">${esc(p.label)}</span>
          <span class="rv">${yuan(p.formulaAmount)} 元
            <small>余额 ${yuan(p.balance)} × 10 = ${yuan(p.balancePart)}　+　月缴存 ${yuan(p.monthlyDeposit)} × 到退休 ${p.retire ? p.retire.monthsLeft : 0} 个月 = ${yuan(p.depositPart)}</small>
            <small>法定退休 ${p.retire ? `${esc(p.retire.ageText)}（${esc(p.retire.retireDate)}）` : '—'}　当前 ${p.age ? `${p.age.years} 岁 ${p.age.remMonths} 个月` : '—'}</small>
          </span>
        </div>`).join('')}
      <div class="row"><span class="rk">额度公式合计</span><span class="rv">${yuan(r.formulaTotal)} 元</span></div>
      <div class="row"><span class="rk">受哪一项限制</span><span class="rv">${esc(r.binding.label)}<small>该项 = ${wan(r.binding.value)} 万</small></span></div>
      <div class="row"><span class="rk">公积金可贷额度</span><span class="rv">${yuan(r.maxLoanGjj)} 元<small>= min(公式, 最高限额${r.totalPriceDerived ? '' : ', 总价×（1−首付）'}）</small></span></div>
    </div>`;

  /* ---- 方案对比 ---- */
  const rows = (r.plans && r.plans.rows) || [];
  html += `<div class="sec-title">买房方案对比（${r.termYears} 年期 · 等额本息/本金按当前选择）</div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>方案</th><th>公积金</th><th>商贷</th><th>首月月供</th><th>总利息</th><th>本息合计</th>
        </tr></thead>
        <tbody>
          ${rows.map((p) => {
            const isCurrent = p.commercialRate != null && Math.abs(p.commercialRate - r.rate.commercial) < 1e-9;
            const hl = p.key === 'pure_gjj' || isCurrent;
            return `<tr class="${hl ? 'hl' : ''}">
              <td>${esc(p.label)}</td>
              <td>${wan(p.gjjAmount)} 万</td>
              <td>${p.commercialAmount > 0 ? `${wan(p.commercialAmount)} 万<br><small>@${pct(p.commercialRate, 2)}</small>` : '—'}</td>
              <td>${yuan(p.first)}</td>
              <td>${wan(p.totalInterest)} 万</td>
              <td>${wan(p.totalPay)} 万</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <p class="swipe-hint">← 表格可左右滑动 →</p>
    <p class="muted" style="margin-top:8px">当前方案：公积金 @${pct(r.rate.gjj, 3)}（${esc(r.rate.gjjTermBand)}），商贷 @${pct(r.rate.commercial, 3)}。${esc(state.meta.commercial.presets_note)}</p>`;

  /* ---- 还款方式差异 + 逐年月供对照表 ---- */
  const sch = (r.schedule || []);
  const mInst = (r.methods || []).find((x) => x.key === 'equal_installment') || {};
  const mPrin = (r.methods || []).find((x) => x.key === 'equal_principal') || {};
  html += `<div class="sec-title">两种还款方式：月供与最终总额对比</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>还款方式</th><th>首月月供</th><th>末月月供</th><th>本息合计</th><th>总利息</th><th>比等额本息</th></tr></thead>
        <tbody>
          ${(r.methods || []).map((m) => {
            const diff = m.totalInterest - (mInst.totalInterest || 0);
            return `<tr>
              <td>${esc(m.label)}</td>
              <td>${yuan(m.first)}</td>
              <td>${yuan(m.last)}</td>
              <td>${wan(m.totalPay)} 万</td>
              <td>${wan(m.totalInterest)} 万</td>
              <td>${diff === 0 ? '—' : `${diff < 0 ? '省' : '多'} ${wan(Math.abs(diff))} 万`}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <p class="swipe-hint">← 表格可左右滑动 →</p>`;

  if (sch.length) {
    const totalTerms = sch.reduce((s, x) => s + x.monthCount, 0);
    html += `<div class="sec-title">逐年月供对照表（${r.termYears} 年 · 共 ${totalTerms} 期 · 两种方式并列）</div>
    <div class="table-wrap">
      <table class="sch">
        <thead>
          <tr>
            <th rowspan="2">年度</th>
            <th colspan="4">等额本息</th>
            <th colspan="4">等额本金</th>
          </tr>
          <tr>
            <th>月供</th><th class="c-yearpay">当年还款</th><th>每月实付</th><th class="c-endbal">年末剩余本金</th>
            <th>月供（首 → 末）</th><th class="c-yearpay">当年还款</th><th>每月实付（首 → 末）</th><th class="c-endbal">年末剩余本金</th>
          </tr>
        </thead>
        <tbody>
          ${sch.map((row) => `<tr>
            <td>第 ${row.year} 年<small>${row.monthCount} 期</small></td>
            <td>${yuan(row.installment.first)}</td>
            <td class="c-yearpay">${yuan(row.installment.yearPay)}</td>
            <td>${yuan(row.installment.cashFirst)}${row.installment.cashFirst !== row.installment.cashLast ? `<small>→ ${yuan(row.installment.cashLast)}</small>` : ''}</td>
            <td class="c-endbal">${yuan(row.installment.endBalance)}</td>
            <td>${yuan(row.principal.first)}<small>→ ${yuan(row.principal.last)}</small></td>
            <td class="c-yearpay">${yuan(row.principal.yearPay)}</td>
            <td>${yuan(row.principal.cashFirst)}${row.principal.cashFirst !== row.principal.cashLast ? `<small>→ ${yuan(row.principal.cashLast)}</small>` : ''}</td>
            <td class="c-endbal">${yuan(row.principal.endBalance)}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr class="hl">
            <td>合计</td>
            <td>—</td>
            <td class="c-yearpay">—</td>
            <td>${yuan((r.scheduleCash || {}).totalCashInstallment || 0)}<small>实付合计</small></td>
            <td class="c-endbal">${yuan(mInst.totalPay || 0)}<small>利息 ${wan(mInst.totalInterest || 0)} 万</small></td>
            <td>—</td>
            <td class="c-yearpay">—</td>
            <td>${yuan((r.scheduleCash || {}).totalCashPrincipal || 0)}<small>实付合计</small></td>
            <td class="c-endbal">${yuan(mPrin.totalPay || 0)}<small>利息 ${wan(mPrin.totalInterest || 0)} 万</small></td>
          </tr>
        </tfoot>
      </table>
    </div>
    <p class="swipe-hint">← 表格可左右滑动 →</p>
    <p class="muted" style="margin-top:8px">等额本息每月 ${yuan(mInst.monthly || 0)} 元始终不变，前期还的多是利息；等额本金首月 ${yuan(mPrin.first || 0)} 元、每月递减到末月 ${yuan(mPrin.last || 0)} 元，总利息更少但前期压力大。</p>
    <p class="muted">「每月实付」= 月供先扣公积金账户（期初 ${yuan((r.scheduleCash || {}).acc0 || 0)} 元 + 每月缴存 ${yuan((r.scheduleCash || {}).monthlyDeposit || 0)} 元）之后，剩下要从银行卡拿的现金。${
      (r.scheduleCash || {}).emptyYear
        ? `账户在第 ${r.scheduleCash.emptyYear} 年被扣空，此后每月实付 = 月供 − 缴存 ${yuan((r.scheduleCash || {}).monthlyDeposit || 0)} 元；第 ${r.scheduleCash.emptyYear} 年之前则一分现金不用出。`
        : '按当前缴存与账户余额，整段还款期内账户都够扣，每月实付为 0（未考虑缴存调整、断缴等情形）。'
    }假设已提取「能提取的余额」、且办理了公积金委托扣款。</p>`;
  }

  /* ---- 提取与现金流 ---- */
  html += `<div class="sec-title">余额提取与每月现金流</div>
    <div class="rows">
      <div class="row"><span class="rk">实际支付的首期房款</span><span class="rv">${yuan(r.withdraw.downPayment)} 元<small>总价 ${wan(r.totalPrice)} 万 − 贷款 ${wan(r.loanNeed)} 万${r.totalPriceDerived ? '（总价按贷款额反推）' : ''}</small></span></div>
      <div class="row"><span class="rk">${r.mode === 'couple' ? '两人' : '本人'}账户余额合计</span><span class="rv">${yuan(r.withdraw.totalBalance)} 元</span></div>
      <div class="row"><span class="rk">能提取的余额<small>提取后额度公式仍够贷到本次的 ${yuan(r.gjjAmount)} 元</small></span><span class="rv">${yuan(r.withdraw.safeLimit)} 元<small>取「余额合计 ${yuan(r.withdraw.totalBalance)}」「首期房款 ${yuan(r.withdraw.downPayment)}」「公式可动用余额 ${yuan(r.withdraw.formulaSlackBalance)}」三者最小值，再向下取整到元</small></span></div>
      ${r.withdraw.afterWithdraw ? `<div class="row"><span class="rk">提取后复核</span><span class="rv">${r.withdraw.afterWithdraw.stillCovers ? '✅ 仍然贷得下来' : '⚠️ 贷不满了'}<small>${esc(r.withdraw.afterWithdraw.text)}</small></span></div>` : ''}
      <div class="row"><span class="rk">为贷到 ${yuan(r.gjjAmount)} 元须留在账户里的余额</span><span class="rv">${yuan(r.withdraw.keepBalance)} 元<small>余额 ×${r.withdraw.balanceMultiplier} 计入额度公式，少了这块钱额度就从 ${yuan(r.gjjAmount)} 元往下掉</small></span></div>
      ${(r.withdraw.perPerson || []).map((p) => `<div class="row"><span class="rk">· ${esc(p.label)}</span><span class="rv">可提取 ${yuan(p.withdrawable)} 元<small>账户余额 ${yuan(p.balance)} 元 − 须保留 ${yuan(p.keep)} 元</small></span></div>`).join('')}
      <div class="row"><span class="rk">政策一次性提取上限</span><span class="rv">${yuan(r.withdraw.onceLimit)} 元<small>不超过实际支付的首期房款，也不超过账户余额</small></span></div>
      <div class="row"><span class="rk">该套住房提取总额上限</span><span class="rv">${yuan(r.withdraw.totalLimit)} 元<small>不超过实际支付的购房本息</small></span></div>
      <div class="row"><span class="rk">每月缴存合计</span><span class="rv">${yuan(r.cashflow.monthlyDeposit)} 元</span></div>
      <div class="row"><span class="rk">每月自掏现金</span><span class="rv">${yuan(r.cashflow.cashMonthly)} 元</span></div>
    </div>
    <div class="alert alert-info" style="margin-top:10px">${esc(r.cashflow.text)}</div>
    <details class="policy-src"><summary>提取规则原文要点</summary>
      <div class="alert alert-info">${esc(state.meta.withdraw.once_limit)}<br>${esc(state.meta.withdraw.surplus_to_bank)}</div>
    </details>`;

  /* ---- 校验 ---- */
  html += `<div class="sec-title">期限与收入校验</div>
    <div class="rows">
      <div class="row"><span class="rk">可贷期限上限</span><span class="rv">${r.maxTermAllowed} 年<small>受 30 年上限、年龄、二手楼楼龄共同约束</small></span></div>
      ${r.secondHandAge > 0 ? `<div class="row"><span class="rk">二手楼楼龄</span><span class="rv">${r.secondHandAge} 年<small>${r.builtAt ? `${esc(r.builtAt)} 建成；` : ''}「期限 + 楼龄」≤ 50 年 → 期限最多 ${Math.max(0, Math.min(r.maxTermAllowed, 50 - r.secondHandAge))} 年</small></span></div>` : ''}
      ${(r.termChecks || []).map((c) => `<div class="row"><span class="rk">· ${esc(c.label)}</span><span class="rv">年龄 ${c.age.years} 岁 ${c.age.remMonths} 个月<small>不超 ${c.limitAge} 岁 → 最多可贷 ${c.years} 年</small></span></div>`).join('')}
      ${r.income ? `
        <div class="row"><span class="rk">月还贷额 / 家庭收入 50% 上限</span>
          <span class="rv">${yuan(r.income.monthlyDue)} / ${yuan(r.income.budget)} 元<small>${r.income.ok ? '✅ 未超限' : `❌ 超出 ${yuan(r.income.overBy)} 元`}</small></span></div>
        <div class="row"><span class="rk">按收入推算的可贷上限</span><span class="rv">${wan(r.income.maxLoanByIncome)} 万<small>${r.income.achieved ? '可覆盖本次贷款需求' : '不足以覆盖，需延长期限或降低贷款额'}</small></span></div>`
      : `<div class="row"><span class="rk">收入校验</span><span class="rv">已跳过<small>未填家庭月收入</small></span></div>`}
    </div>`;

  /* ---- 提示 ---- */
  if (warnList.length) {
    html += `<div class="sec-title">需要注意</div>` + warnList.map((w) =>
      `<div class="alert ${/超出|超过|无法|不成立|失效/.test(w) ? 'alert-bad' : 'alert-warn'}">${esc(w)}</div>`).join('');
  }
  if (noteList.length) {
    html += `<div class="sec-title">计算说明</div><div class="alert alert-info"><ul>${noteList.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`;
  }

  /* ---- 来源 ---- */
  html += `<details class="policy-src"><summary>政策来源与免责声明</summary>
    <div class="alert alert-info" style="margin-top:8px">
      <ul class="src-list">${(r.sources || []).map((s) =>
        `<li><b>${esc(s.name)}</b><br>${esc(s.publisher)}　${esc(s.date || '')}<br><a href="${esc(s.url)}" target="_blank" rel="noreferrer noopener">${esc(s.url)}</a></li>`).join('')}</ul>
      <div style="margin-top:10px">${esc(r.disclaimer)}</div>
      <div style="margin-top:6px">参数复核日期 ${esc(r.freshness.asOf)} · ${esc(r.freshness.text)}</div>
    </div>
  </details>`;

  html += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
    <button type="button" class="btn btn-ghost" id="printBtn">打印 / 存 PDF</button>
  </div>
  <p class="muted" style="margin-top:8px">本次测算已自动存入「全部记录」，可直接去记录页改名 / 复制 / 删除。</p>`;

  $('#result').innerHTML = html;
  $('#printBtn').addEventListener('click', () => window.print());

  const th = $('#termHint');
  if (th) {
    th.textContent = r.maxTermAllowed >= 30
      ? '本情形可贷上限 30 年（受 30 年上限 / 年龄 / 楼龄约束）'
      : `⚠️ 本情形可贷上限只有 ${r.maxTermAllowed} 年（受 30 年上限 / 年龄 / 楼龄约束）`;
  }
}

/* ---------------------------- 记录管理 ---------------------------- */

async function loadRecords() {
  try {
    const { records } = await api('/api/records');
    state.records = records;
    $('#recCount').textContent = String(records.length);
    renderRecords();
    renderRecentCard();
  } catch (e) {
    $('#recordList').innerHTML = `<div class="alert alert-bad">${esc(e.message)}</div>`;
  }
}

function renderRecords() {
  const box = $('#recordList');
  if (!state.records.length) {
    box.innerHTML = '<div class="empty-note">还没有记录。点一次「开始测算」就会自动存到这里。</div>';
    return;
  }
  box.innerHTML = state.records.map((r) => `
    <div class="record" data-id="${r.id}">
      <div class="record-top">
        <span class="record-name">${esc(r.name)}</span>
        <span class="record-time">${esc(fmtTime(r.updatedAt))}</span>
      </div>
      <div class="record-meta">${esc(recordMetaText(r))}</div>
      <div class="record-actions">
        <button type="button" class="btn btn-primary btn-sm" data-act="load">一键调用</button>
        <button type="button" class="btn btn-ghost btn-sm" data-act="overwrite">覆盖保存</button>
        <button type="button" class="btn btn-ghost btn-sm" data-act="rename">更名</button>
        <button type="button" class="btn btn-ghost btn-sm" data-act="duplicate">复制为新</button>
        <button type="button" class="btn btn-danger btn-sm" data-act="delete">删除</button>
      </div>
    </div>`).join('');

  $$('#recordList .record').forEach((el) => {
    const id = Number(el.dataset.id);
    const rec = state.records.find((x) => x.id === id);
    $$('[data-act]', el).forEach((btn) => {
      btn.addEventListener('click', () => handleRecordAction(btn.dataset.act, rec, el));
    });
  });
}

async function handleRecordAction(act, rec, el) {
  if (!rec) return;
  try {
    if (act === 'load') {
      state.editingId = null;
      state.editingName = null;
      loadRecordIntoForm(rec);
      toast(`已载入「${rec.name}」`);
      return;
    }
    if (act === 'overwrite') {
      if (!state.lastResult) return toast('请先测算一次');
      await api(`/api/records/${rec.id}`, { method: 'PUT', body: JSON.stringify({ payload: collect() }) });
      toast('已用当前输入覆盖保存');
      loadRecords();
      return;
    }
    if (act === 'rename') {
      const nameEl = $('.record-name', el);
      const old = rec.name;
      const input = document.createElement('input');
      input.className = 'rename';
      input.value = old;
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      const commit = async () => {
        const name = input.value.trim() || old;
        if (name !== old) {
          await api(`/api/records/${rec.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
          toast('已更名');
        }
        loadRecords();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.removeEventListener('blur', commit); loadRecords(); }
      });
      return;
    }
    if (act === 'duplicate') {
      const { record } = await api(`/api/records/${rec.id}/duplicate`, { method: 'POST', body: JSON.stringify({}) });
      toast(`已复制为「${record.name}」`);
      loadRecords();
      return;
    }
    if (act === 'delete') {
      if (!window.confirm(`确认删除「${rec.name}」？该操作不可撤销。`)) return;
      await api(`/api/records/${rec.id}`, { method: 'DELETE' });
      toast('已删除');
      loadRecords();
      return;
    }
  } catch (e) {
    toast(e.message, 3200);
  }
}

/** 默认记录名：双人 200 万 / 30 年 · 09-21 12:03 */
function defaultRecordName() {
  const r = state.lastResult || {};
  const p2 = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const ts = `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return `${state.mode === 'couple' ? '双人' : '单人'} ${wan(r.loanNeed || 0)} 万 / ${r.termYears || 0} 年 · ${ts}`;
}

/**
 * 保存记录。
 * - 编辑态（从「复制修改」进来）：覆盖那条记录；
 * - 自动保存（点「开始测算」）：用默认名字，入参与已有某条记录完全相同时不重复建；
 * - 手动调用：仍弹输入框让用户起名。
 */
async function saveRecord(opts) {
  const o = opts || {};
  if (!state.lastResult || state.lastResult.ok === false) {
    if (!o.auto) toast('请先测算一次');
    return null;
  }

  // 编辑态（从「复制修改」进来）：直接覆盖那条记录，不再新建
  if (state.editingId) {
    try {
      await api(`/api/records/${state.editingId}`, {
        method: 'PUT',
        body: JSON.stringify({ payload: collect() })
      });
      toast(`已更新「${state.editingName || ''}」`);
      await loadRecords();
    } catch (e) {
      toast(e.message, 3200);
    }
    return null;
  }

  const payload = collect();
  const json = JSON.stringify(payload);
  const dup = (state.records || []).find((r) => JSON.stringify(r.payload) === json);
  if (o.auto && dup) return dup;   // 连点「开始测算」不会刷出一串一样的记录

  let finalName = o.name;
  if (finalName === undefined) {
    if (o.auto) {
      finalName = defaultRecordName();
    } else {
      const guess = `${state.mode === 'couple' ? '双人' : '单人'} ${wan(state.lastResult.loanNeed)} 万 / ${state.lastResult.termYears} 年`;
      finalName = window.prompt('给这条记录起个名字（可随时更名）', guess);
      if (finalName === null) return null;
      finalName = finalName.trim() || guess;
    }
  }
  try {
    await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({ name: finalName, payload })
    });
    toast(o.auto ? `已自动保存为「${finalName}」` : '已保存到本地记录');
    await loadRecords();
    return null;
  } catch (e) {
    toast(e.message, 3200);
    return null;
  }
}

/* ---------------------------- 政策参数页 ---------------------------- */

function renderPolicy() {
  const m = state.meta;
  const fresh = m.freshness;
  const row = (k, v, sub) => `<div class="row"><span class="rk">${esc(k)}</span><span class="rv">${v}${sub ? `<small>${sub}</small>` : ''}</span></div>`;

  const cats = m.retirement.categories;
  const catRows = Object.keys(cats).map((k) => {
    const c = cats[k];
    const from = c.start_birth.replace('-', ' 年 ') + ' 月';
    const to = c.base_age + c.max_delay / 12;
    return row(c.label, `${c.base_age} → ${to} 周岁`, `出生 ${from} 起；每 ${c.band_months} 个月延迟 1 个月`);
  }).join('');

  $('#policyBox').innerHTML = `
    <div class="policy-grid">

      <div class="card">
        <div class="card-head"><h3>政策参数时效</h3>
          <span class="badge badge-${fresh.level === 'ok' ? 'ok' : fresh.level === 'warn' ? 'warn' : 'bad'}">${esc(fresh.text)}</span>
        </div>
        <div class="rows">
          ${row('参数复核日期', esc(m.asOf))}
          ${row('现行政策施行日', esc(m.policyEffective))}
          ${row('参数版本', esc(m.version))}
        </div>
        <p class="muted" style="margin-top:10px">参数集中存放在 <code>config/guangzhou-2026.json</code>，修订后重启容器即可生效；每条参数都可在下面的来源里找到出处。</p>
      </div>

      <div class="card">
        <h3>贷款额度与上浮</h3>
        <div class="rows">
          ${row('最高额度（基础）', '一人 100 万 / 两人及以上 200 万')}
          ${row('额度公式', '账户余额 × 10 + 月缴存额 × 到退休年龄月数')}
          ${row('育儿类上浮', '一孩 +10% / 二孩 +40% / 三孩及以上 +50%')}
          ${row('住房品质类上浮', '装配式或一星绿建 +10% / 二星及以上绿建 +20% /「好房子」+30%')}
          ${row('上浮叠加上限', '两类可叠加，最高 +80% → 180 万 / 360 万')}
          ${row('其他限额', '≤ 总价 ×（1 − 首付比例）；月还贷额 ≤ 家庭收入 50%')}
        </div>
      </div>

      <div class="card">
        <h3>利率 · 首付 · 期限</h3>
        <div class="rows">
          ${row('公积金利率（首套）', '1–5 年（含）2.1%　5 年以上 2.6%')}
          ${row('公积金利率（二套）', '1–5 年（含）2.525%　5 年以上 3.075%')}
          ${row('最低首付', '首套及第二套 20%；保障性住房 15%')}
          ${row('贷款期限', '≤ 30 年；二手楼「期限 + 楼龄」≤ 50 年')}
          ${row('年龄约束', '年龄 + 期限 ≤ 退休年龄后 5 年，且 ≤ 68 岁（男 68 / 女 63）')}
          ${row('套数认定', '按购房所在区认定；第三套及以上不予贷款')}
          ${row('购房资格', '全市已取消限购限售（2024-09 起）')}
        </div>
      </div>

      <div class="card">
        <h3>缴存参数（${esc(m.deposit.year)}）</h3>
        <div class="rows">
          ${row('缴存基数下限', `${yuan(m.deposit.base_min)} 元`)}
          ${row('缴存基数上限', `${yuan(m.deposit.base_max)} 元`)}
          ${row('缴存比例（单位 / 个人）', '各 5%–12%（取整数值）')}
        </div>
        <p class="muted" style="margin-top:10px">缴存参数取自 MIT 许可的 <a href="https://github.com/weante/city-salary" target="_blank" rel="noreferrer noopener">weante/city-salary</a>，并已按广州 2026 年度口径核对。</p>
      </div>

      <div class="card">
        <h3>法定退休年龄（渐进式延迟）</h3>
        <div class="rows">${catRows}</div>
        <p class="muted" style="margin-top:10px">自 2025-01-01 起施行，按出生年月查对照表。计算器已内置该对照表，用于推「到退休年龄月数」与贷款年龄上限。</p>
      </div>

      <div class="card">
        <h3>商贷参考（${esc(m.commercial.lpr_as_of)}）</h3>
        <div class="rows">
          ${row('1 年期 LPR', pct(m.commercial.lpr_1y, 2))}
          ${row('5 年期以上 LPR', pct(m.commercial.lpr_5y_plus, 2))}
          ${row('商贷最低首付', pct(m.commercial.down_payment, 0) + '（不再区分首套 / 二套）')}
        </div>
        <p class="muted" style="margin-top:10px">${esc(m.commercial.presets_note)}</p>
      </div>

      <div class="card">
        <h3>提取规则</h3>
        <div class="rows">
          ${row('按月还贷期间', esc(m.withdraw.once_limit), '')}
          ${row('账户冲还贷', esc(m.withdraw.monthly_offset), '')}
          ${row('结余转出', esc(m.withdraw.surplus_to_bank), '')}
          ${row('结清后', esc(m.withdraw.after_settle), '')}
          ${row('总额上限', esc(m.withdraw.total_limit), '')}
        </div>
      </div>

      <div class="card">
        <h3>官方来源</h3>
        <ul class="src-list">
          ${m.sources.map((s) => `<li><b>${esc(s.name)}</b><br>${esc(s.publisher)}　${esc(s.date || '')}<br>
            <a href="${esc(s.url)}" target="_blank" rel="noreferrer noopener">${esc(s.url)}</a></li>`).join('')}
        </ul>
      </div>

      <div class="card">
        <h3>约 束 与 声 明</h3>
        <p class="muted">${esc(m.disclaimer)}</p>
        <p class="muted" style="margin-top:8px">本工具不联网、无埋点，所有输入与记录仅保存在你自己的服务器上。</p>
      </div>

    </div>`;
}

/* ------------------------------ 设置页 ------------------------------ */

function applyAuthUi() {
  const a = state.auth || {};
  const banner = $('#defaultPwBanner');
  if (banner) banner.hidden = !a.usingDefaultPassword;
}

async function refreshAuth() {
  const r = await req('/api/auth/status');
  if (r.status === 200 && r.data && r.data.authed) {
    state.auth = r.data;
    applyAuthUi();
    renderSettings();
  }
}

function renderSettings() {
  const a = state.auth || {};
  const box = $('#settingsBox');
  if (!box) return;

  const pinned = !!a.pinnedByEnv;
  const isDefault = !!a.usingDefaultPassword;
  const minLen = a.minPasswordLength || 4;

  const pwPill = pinned
    ? `<span class="pill">由环境变量固定</span>`
    : isDefault
      ? `<span class="pill pill-bad">出厂默认密码</span>`
      : `<span class="pill pill-ok">已自定义</span>`;

  box.innerHTML = `
    <div class="settings-grid">

      <div class="card">
        <div class="card-head"><h3>访问密码</h3>${pwPill}</div>
        <p class="muted">全家人共用这一个口令，登录后浏览器会拿到一张 ${
          a.rememberDays || 30
        } 天有效的通行证（勾了「记住这台设备」时）。</p>

        ${pinned ? `<div class="alert alert-warn" style="margin-top:12px">
          ⚠️ 当前密码由 <code>docker-compose.yml</code> 里的 <code>ACCESS_PASSWORD</code> 固定，
          每次重启容器都会以它为准，因此这里不能改。
          想自己管理密码：先把该环境变量清空（或改成你想用的新密码）再重启容器。
        </div>` : ''}

        <form id="pwForm" autocomplete="off" style="margin-top:14px">
          <div class="field">
            <label for="pwCurrent">当前密码</label>
            <input type="password" id="pwCurrent" autocomplete="current-password" required>
          </div>
          <div class="field">
            <label for="pwNext">新密码 <span class="unit">至少 ${minLen} 位</span></label>
            <input type="password" id="pwNext" autocomplete="new-password" required>
          </div>
          <div class="field">
            <label for="pwAgain">再输一次新密码</label>
            <input type="password" id="pwAgain" autocomplete="new-password" required>
          </div>
          <div class="form-actions" style="margin-top:0">
            <button type="submit" class="btn btn-primary"${pinned ? ' disabled' : ''}>修改密码</button>
            <button type="button" class="btn btn-ghost" id="logoutAllBtn">退出所有设备</button>
          </div>
          <div class="form-msg" id="pwMsg" hidden></div>
        </form>

        <p class="muted" style="margin-top:12px">
          忘记密码怎么办：删掉数据目录下的 <code>auth.json</code> 再重启容器，
          会重新按 <code>ACCESS_PASSWORD</code> 初始化（历史记录不受影响）。
        </p>
      </div>

      <div class="card">
        <h3>会话与门禁</h3>
        <div class="rows">
          <div class="row"><span class="rk">门禁模式</span><span class="rv">单一口令 · 无账号体系</span></div>
          <div class="row"><span class="rk">默认登录有效期</span><span class="rv">${a.sessionHours || 12} 小时</span></div>
          <div class="row"><span class="rk">勾选「记住这台设备」</span><span class="rv">${a.rememberDays || 30} 天</span></div>
          <div class="row"><span class="rk">密码保存方式</span><span class="rv">scrypt 加盐哈希<small>不保存明文</small></span></div>
          <div class="row"><span class="rk">主要数据接口</span><span class="rv">全部需要口令<small>未登录一律返回 401</small></span></div>
        </div>
        <p class="muted" style="margin-top:10px">
          连续输错会临时锁定来源 IP，避免被暴力枚举。可在 compose 里用
          <code>MAX_LOGIN_FAILS</code> / <code>LOGIN_LOCK_SECONDS</code> 调整。
        </p>
      </div>

      <div class="card">
        <h3>数据与隐私</h3>
        <div class="rows">
          <div class="row"><span class="rk">联网情况</span><span class="rv">完全离线<small>不请求任何外部接口</small></span></div>
          <div class="row"><span class="rk">数据位置</span><span class="rv">本机 SQLite<small>compose 的 ./data 目录</small></span></div>
          <div class="row"><span class="rk">账号 / 上报</span><span class="rv">无账号 · 无埋点 · 无统计</span></div>
        </div>
        <p class="muted" style="margin-top:10px">
          在「记录」页可以导出 JSON 备份；换机器时把 <code>data/</code> 整个目录拷过去即可。
        </p>
      </div>

      <div class="card">
        <h3>关于</h3>
        <p class="muted">广州住房公积金买房贷款测算器，自托管版本 ${esc(state.meta ? state.meta.version : '')}。</p>
        <p class="muted" style="margin-top:8px">政策参数复核日期 ${esc(state.meta ? state.meta.asOf : '')}。测算结果仅供参考，最终以广州住房公积金管理中心核定为准。</p>
        <div class="form-actions" style="margin-top:12px">
          <button type="button" class="btn btn-ghost" id="logoutBtn2">退出登录</button>
        </div>
      </div>

    </div>`;

  $('#logoutAllBtn').addEventListener('click', doLogoutAll);
  $('#logoutBtn2').addEventListener('click', doLogout);

  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#pwMsg');
    const show = (text, ok) => {
      msg.hidden = false;
      msg.textContent = text;
      msg.className = `form-msg ${ok ? 'ok' : 'bad'}`;
    };

    const current = $('#pwCurrent').value;
    const next = $('#pwNext').value;
    const again = $('#pwAgain').value;

    if (next.length < minLen) return show(`新密码至少 ${minLen} 位`, false);
    if (next !== again) return show('两次输入的新密码不一致', false);

    try {
      const d = await api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ current, next })
      });
      $('#pwForm').reset();
      show(d.message || '密码已更新', true);
      await refreshAuth();
    } catch (err) {
      show(err.message, false);
    }
  });
}

/* ------------------------------- 初始化 ------------------------------- */

/** 已通过门禁后才跑：确保拿到元信息、绑定事件、刷新数据 */
async function startApp() {
  if (!state.auth) {
    const r = await req('/api/auth/status');
    if (r.status !== 200 || !r.data || !r.data.authed) { showLock(''); return; }
    state.auth = r.data;
  }

  if (!state.meta) {
    try {
      state.meta = await api('/api/meta');
    } catch (e) {
      $('#result').innerHTML = `<div class="card"><div class="alert alert-bad">无法连接本地服务：${esc(e.message)}</div></div>`;
      return;
    }
  }

  const m = state.meta;
  const fb = $('#freshnessBadge');
  fb.className = `badge badge-${m.freshness.level === 'ok' ? 'ok' : m.freshness.level === 'warn' ? 'warn' : 'bad'}`;
  fb.textContent = `参数 ${m.asOf}`;
  fb.title = m.freshness.text;

  $('#childPolicy').innerHTML = optionList(m.loan.child_uplift.labels, 'none');
  $('#qualityPolicy').innerHTML = optionList(m.loan.quality_uplift.labels, 'none');

  // 空表单只铺一次（首次进入 / 刷新页面后）；重新登录不会冲掉正在填的内容
  state.started = true;
  if (!state.formInited) {
    state.formInited = true;
    initBlankForm();
    bindEvents();
  } else {
    buildRateChips();
  }

  renderPolicy();
  renderSettings();
  applyAuthUi();

  await loadRecords();
  // 表单已经有内容（重新登录 / 刷新后回填）才自动算一次；
  // 空表单保持「还没测算」的引导卡片，不弹红字
  if (hasEnoughInput()) runCalc({ quiet: true });
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bindEvents() {
  $$('#modeSeg button').forEach((b) => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    $$('#modeSeg button').forEach((x) => x.classList.toggle('on', x === b));
    const cur = $$('#personBoxes .person-box').map((box) => ({
      birth: $('.p-birth', box).value,
      category: $('.p-cat', box).value,
      balance: num($('.p-balance', box).value),
      monthlyDeposit: num($('.p-deposit', box).value)
    }));
    buildPersonBoxes(state.mode, cur);
  }));

  $$('#typeSeg button').forEach((b) => b.addEventListener('click', () => {
    state.loanType = b.dataset.type;
    $$('#typeSeg button').forEach((x) => x.classList.toggle('on', x === b));
    runCalc({ quiet: true });
  }));

  $$('#builtSeg button').forEach((b) => b.addEventListener('click', () => {
    setBuiltMode(b.dataset.bmode);
  }));

  $('#termYears').addEventListener('input', () => {
    $('#termEcho').textContent = $('#termYears').value;
  });

  $('#isAffordableHousing').addEventListener('change', updateDownHint);
  $('#downRatio').addEventListener('change', updateDownHint);

  $('#addRateBtn').addEventListener('click', () => {
    const v = num($('#customRate').value);
    if (!(v > 0)) return toast('请填写大于 0 的利率');
    const r = v > 1 ? v : v * 100;
    if (!state.rates.some((x) => Math.abs(x - r) < 1e-9)) state.rates.push(r);
    state.rates.sort((a, b) => a - b);
    state.commercialRate = r;
    $('#customRate').value = '';
    buildRateChips();
    runCalc({ quiet: true });
    toast(`已加入 ${ratePct(r, 2)} 并选中`);
  });

  $('#calcForm').addEventListener('submit', (e) => {
    e.preventDefault();
    runCalc();
  });
  $('#resetBtn').addEventListener('click', () => {
    initBlankForm();
    toast('已清空表单，按灰色提示填写即可');
  });

  $('#editExitBtn').addEventListener('click', () => {
    state.editingId = null;
    state.editingName = null;
    syncEditingUi();
    toast('已退出修改，再保存会新建一条记录');
  });

  $('#recentReuseBtn').addEventListener('click', recentReuse);
  $('#recentCopyBtn').addEventListener('click', recentCopyEdit);
  $('#recentAllBtn').addEventListener('click', () => goTab('records'));

  $('#exportBtn').addEventListener('click', () => { window.location.href = '/api/export'; });
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : (data.records || []);
      const { imported } = await api('/api/import', { method: 'POST', body: JSON.stringify({ records: list }) });
      toast(`已导入 ${imported} 条记录`);
      loadRecords();
    } catch (err) {
      toast(`导入失败：${err.message}`, 3200);
    } finally {
      e.target.value = '';
    }
  });

}

/* ------------------------------- 启动 ------------------------------- */

async function boot() {
  initTheme();
  initTabs();
  initLock();

  $('#logoutBtn').addEventListener('click', doLogout);

  let st = null;
  try {
    const r = await req('/api/auth/status');
    if (r.status !== 200) throw new Error((r.data && r.data.error) || `HTTP ${r.status}`);
    st = r.data;
  } catch (e) {
    showLock(`无法连接本地服务：${e.message}`);
    return;
  }

  $('#lockRememberDays').textContent = String(st.rememberDays || 30);

  if (!st.authed) {
    showLock('');
    return;
  }

  state.auth = st;
  hideLock();
  await startApp();
}

document.addEventListener('DOMContentLoaded', boot);
