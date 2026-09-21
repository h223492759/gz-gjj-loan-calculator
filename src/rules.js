'use strict';

/**
 * 政策参数层
 * ------------------------------------------------------------------
 * 读出 config/guangzhou-2026.json，并对外提供：
 *   - rules()              当前参数（带冻结，避免被调用方改写）
 *   - freshness(asOf)      参数时效检测（借鉴 weante/city-salary 的「三时点过期检测」范式）
 *   - retireAge()          按《渐进式延迟法定退休年龄》对照表算退休年龄
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'guangzhou-2026.json');

let _cache = null;
let _cacheMtime = 0;

function rules() {
  const st = fs.statSync(CONFIG_PATH);
  if (!_cache || st.mtimeMs !== _cacheMtime) {
    _cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    _cacheMtime = st.mtimeMs;
  }
  return _cache;
}

/* ----------------------------- 日期工具 ----------------------------- */

function parseYM(s) {
  const m = /^(\d{4})[-/.]?(\d{1,2})?/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : 1;
  if (!y || mo < 1 || mo > 12) return null;
  return { y, m: mo };
}

function today() {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

function toDateStr(ym) {
  return `${ym.y}-${String(ym.m).padStart(2, '0')}`;
}

function addMonths(ym, n) {
  const total = ym.y * 12 + (ym.m - 1) + n;
  return { y: Math.floor(total / 12), m: (total % 12) + 1 };
}

function monthsBetween(a, b) {
  // b - a，单位月
  return (b.y - a.y) * 12 + (b.m - a.m);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/* --------------------------- 退休年龄计算 --------------------------- */

/**
 * 按全国人大常委会《关于实施渐进式延迟法定退休年龄的决定》所附对照表计算。
 * 规则：以出生年月落在「起始出生月」之后的月份数 d，
 *       delay = min(floor(d / band) + 1, max_delay)，d < 0 时 delay = 0。
 * 自检：男 1965-01 → 60岁1个月；男 1976-08 → 62岁11个月；男 1976-09 → 63岁。
 *      女（原50） 1975-01 → 50岁1个月；1984-10 → 54岁11个月；1984-11 → 55岁。
 */
function retireAge(birthStr, category) {
  const cfg = rules().retirement;
  const cat = cfg.categories[category] || cfg.categories.male;
  const birth = parseYM(birthStr);
  if (!birth) return null;

  const start = parseYM(cat.start_birth);
  const d = monthsBetween(start, birth);
  const delay = d >= 0 ? Math.min(Math.floor(d / cat.band_months) + 1, cat.max_delay) : 0;

  const ageMonths = cat.base_age * 12 + delay;
  const at = addMonths(birth, ageMonths);

  return {
    category,
    categoryLabel: cat.label,
    baseAge: cat.base_age,
    delayMonths: delay,
    ageMonths,
    ageText: delay === 0
      ? `${cat.base_age} 周岁`
      : `${cat.base_age + Math.floor(delay / 12)} 周岁 ${delay % 12} 个月`,
    retireDate: `${at.y}-${String(at.m).padStart(2, '0')}`,
    birth: toDateStr(birth)
  };
}

/** 距退休还有多少个月（基准日 = asOf 所在月） */
function monthsToRetire(birthStr, category, asOf) {
  const r = retireAge(birthStr, category);
  if (!r) return null;
  const base = parseYM(asOf) || today();
  const at = parseYM(r.retireDate);
  const left = monthsBetween(base, at);
  return { ...r, monthsLeft: Math.max(0, left), monthsLeftRaw: left, asOf: toDateStr(base) };
}

/** 年龄（整岁 + 余月） */
function ageAt(birthStr, asOf) {
  const birth = parseYM(birthStr);
  if (!birth) return null;
  const base = parseYM(asOf) || today();
  let months = monthsBetween(birth, base);
  if (months < 0) months = 0;
  return { months, years: Math.floor(months / 12), remMonths: months % 12 };
}

/* --------------------------- 参数时效检测 --------------------------- */

function freshness(asOf) {
  const cfg = rules();
  const base = asOf || toDateStr(today());
  const days = daysBetween(cfg.as_of, base);
  const limit = cfg.stale_after_days || 365;
  return {
    asOf: cfg.as_of,
    policyEffective: cfg.policy_effective,
    baseDate: base,
    ageDays: days,
    limitDays: limit,
    level: days > limit ? 'stale' : days > limit * 0.75 ? 'warn' : 'ok',
    text: days > limit
      ? `政策参数已 ${days} 天未复核，可能已失效，请回官方来源核对后再使用`
      : days > limit * 0.75
        ? `政策参数已 ${days} 天未复核，建议回官方来源核对`
        : `政策参数 ${cfg.as_of} 复核，距今 ${days} 天`
  };
}

module.exports = {
  CONFIG_PATH,
  rules,
  freshness,
  retireAge,
  monthsToRetire,
  ageAt,
  parseYM,
  addMonths,
  monthsBetween,
  toDateStr,
  today
};
