'use strict';

/**
 * 测算引擎
 * ------------------------------------------------------------------
 * 广州公积金买房贷款测算。全部为纯函数，不依赖网络、不依赖数据库。
 *
 * 核心口径（依据 config/guangzhou-2026.json，逐条可回溯官方文件）：
 *   公积金可贷额 = min(
 *        Σ(账户余额 × 10 + 月缴存额 × 到退休年龄月数),
 *        (100 万 / 200 万) × (1 + 上浮系数),
 *        购房总价 × (1 − 最低首付比例)
 *   )
 *   月还贷额 ≤ 家庭月收入 × 50%
 * ------------------------------------------------------------------
 */

const R = require('./rules');

const yuan = (v) => Math.round(v * 100) / 100;
const MIN = 1e-6;

/* ============================ 还款计算 ============================ */

/** 等额本息 / 等额本金 */
function payment(P, annualRate, months, method) {
  const empty = {
    method, principal: 0, monthly: 0, first: 0, last: 0,
    totalInterest: 0, totalPay: 0, monthlyPrincipal: 0
  };
  if (!(P > 0) || !(months > 0)) return empty;

  const i = annualRate / 12;
  const principal = yuan(P);

  if (method === 'equal_principal') {
    const per = P / months;
    const first = per + P * i;
    const last = per + per * i;
    const totalInterest = (i * P * (months + 1)) / 2;
    return {
      method,
      principal,
      monthly: yuan(first),          // 首月
      first: yuan(first),
      last: yuan(last),
      monthlyPrincipal: yuan(per),
      totalInterest: yuan(totalInterest),
      totalPay: yuan(P + totalInterest)
    };
  }

  // 等额本息
  let m;
  if (i <= MIN) {
    m = P / months;
  } else {
    const p = Math.pow(1 + i, months);
    m = (P * i * p) / (p - 1);
  }
  const totalPay = m * months;
  return {
    method,
    principal,
    monthly: yuan(m),
    first: yuan(m),
    last: yuan(m),
    monthlyPrincipal: 0,
    totalInterest: yuan(totalPay - P),
    totalPay: yuan(totalPay)
  };
}

/** 反解：给定期望的首月月供上限，求可承受本金上限 */
function principalByPayment(maxMonthly, annualRate, months, method) {
  if (!(maxMonthly > 0) || !(months > 0)) return 0;
  const i = annualRate / 12;
  if (method === 'equal_principal') {
    const denom = 1 / months + i;
    return denom > 0 ? maxMonthly / denom : 0;
  }
  if (i <= MIN) return maxMonthly * months;
  const p = Math.pow(1 + i, months);
  const factor = (i * p) / (p - 1);
  return maxMonthly / factor;
}

/* ============================ 主流程 ============================ */

function graftRate(termYears, loanType, cfg) {
  const key = termYears <= 5 ? 'le5y' : 'gt5y';
  const set = cfg.loan.rate[loanType === 'second' ? 'second' : 'first'];
  return { rate: set[key], key, termBand: termYears <= 5 ? '1–5 年（含）' : '5 年以上' };
}

function normalizePerson(p, idx) {
  return {
    index: idx + 1,
    label: p.label || (idx === 0 ? '借款人' : '共同借款人'),
    birth: p.birth || '',
    category: p.category || 'male',
    balance: Number(p.balance) || 0,
    monthlyDeposit: Number(p.monthlyDeposit) || 0
  };
}

function calculate(input) {
  const cfg = R.rules();
  const warnings = [];
  const notes = [];

  // 基准日取完整日期：参数时效要算「距今几天」，用只到月的 toDateStr 会差出整月
  const asOf = input.asOf && R.parseYM(input.asOf) ? input.asOf : R.todayStr();
  const mode = input.mode === 'couple' ? 'couple' : 'single';
  const persons = (mode === 'couple' ? (input.persons || []).slice(0, 2) : (input.persons || []).slice(0, 1))
    .filter((p) => p && p.birth)
    .map(normalizePerson);

  if (!persons.length) {
    return { ok: false, error: '请至少填写一位借款人的出生年月', asOf, warnings, notes };
  }

  const loanNeed = Math.max(0, Number(input.loanNeed) || 0);
  if (!(loanNeed > 0)) {
    return { ok: false, error: '请填写需要贷款的金额', asOf, warnings, notes };
  }

  const loanType = input.loanType === 'second' ? 'second' : 'first';
  const isAffordable = !!input.isAffordableHousing;
  const downRatio = Number.isFinite(Number(input.downRatio)) && Number(input.downRatio) >= 0
    ? Number(input.downRatio) / (Number(input.downRatio) > 1 ? 100 : 1)
    : (isAffordable ? cfg.loan.down_payment.affordable_housing : cfg.loan.down_payment.normal);
  const minDownRatio = isAffordable ? cfg.loan.down_payment.affordable_housing : cfg.loan.down_payment.normal;
  if (downRatio < minDownRatio - 1e-9) {
    warnings.push(`首付比例 ${(downRatio * 100).toFixed(0)}% 低于现行最低 ${(minDownRatio * 100).toFixed(0)}%，政策口径下不成立。`);
  }

  const method = input.repayment === 'equal_principal' ? 'equal_principal' : 'equal_installment';
  const termYears = Math.max(1, Math.min(50, Math.round(Number(input.termYears) || 30)));
  const secondHandAge = Math.max(0, Number(input.secondHandAge) || 0);
  const familyIncome = Math.max(0, Number(input.familyMonthlyIncome) || 0);
  const commercialRate = Number.isFinite(Number(input.commercialRate)) && Number(input.commercialRate) > 0
    ? Number(input.commercialRate) / (Number(input.commercialRate) > 1 ? 100 : 1)
    : cfg.commercial.presets[0].rate;

  /* ---------------- 1. 上浮与额度上限 ---------------- */
  const childMul = cfg.loan.child_uplift[input.childPolicy] ?? 0;
  const qualityMul = cfg.loan.quality_uplift[input.qualityPolicy] ?? 0;
  const rawUplift = childMul + qualityMul;
  const upliftRate = Math.min(rawUplift, cfg.loan.max_uplift);
  if (rawUplift > cfg.loan.max_uplift) {
    notes.push(`育儿类与住房品质类上浮合计 ${(rawUplift * 100).toFixed(0)}%，已按上限 ${(cfg.loan.max_uplift * 100).toFixed(0)}% 封顶。`);
  }
  const baseCap = mode === 'couple' ? cfg.loan.base_cap.couple : cfg.loan.base_cap.single;
  const upliftCap = baseCap * (1 + upliftRate);

  /* ---------------- 2. 每人公式额 ---------------- */
  const perPerson = persons.map((p) => {
    const ret = R.monthsToRetire(p.birth, p.category, asOf);
    const age = R.ageAt(p.birth, asOf);
    const byBalance = p.balance * cfg.loan.balance_multiplier;
    const byDeposit = p.monthlyDeposit * (ret ? ret.monthsLeft : 0);
    return {
      ...p,
      genderKey: String(p.category).startsWith('female') ? 'female' : 'male',
      age,
      retire: ret,
      balancePart: yuan(byBalance),
      depositPart: yuan(byDeposit),
      formulaAmount: yuan(byBalance + byDeposit)
    };
  });

  const formulaTotal = yuan(perPerson.reduce((s, p) => s + p.formulaAmount, 0));

  perPerson.forEach((p) => {
    if (p.retire && p.retire.monthsLeftRaw <= 0) {
      warnings.push(`${p.label} 距法定退休已无可贷月数（${p.retire.retireDate} 退休），按现行口径无法作为借款人申请公积金贷款。`);
    }
    if (p.balance <= 0 && p.monthlyDeposit <= 0) {
      warnings.push(`${p.label} 的账户余额与月缴存额均为 0，公式可贷额为 0。`);
    }
  });

  /* ---------------- 3. 总价 / 首付 约束 ---------------- */
  const priceGiven = Number(input.houseTotalPrice) > 0;
  const derivedTotalPrice = loanNeed / Math.max(1 - downRatio, 0.05);
  const totalPrice = priceGiven ? Number(input.houseTotalPrice) : derivedTotalPrice;
  const priceCap = priceGiven ? totalPrice * (1 - downRatio) : Infinity;
  notes.push(priceGiven
    ? '已按填写的购房总价校验「贷款额 ≤ 总价 ×（1 − 首付比例）」。'
    : '未填写购房总价，已按「贷款金额 ÷（1 − 首付比例）」反推总价；填写总价可获得更准确的首付与提取额度。');

  /* ---------------- 4. 公积金可贷额 ---------------- */
  const cap = upliftCap;
  const candidates = [
    { key: 'formula', label: '额度公式（余额×10 + 月缴存额×到退休月数）', value: formulaTotal },
    { key: 'cap', label: `最高限额（${(baseCap / 10000)} 万 × 上浮 ${(upliftRate * 100).toFixed(0)}%）`, value: cap }
  ];
  if (priceGiven) candidates.push({ key: 'price', label: '购房总价 ×（1 − 首付比例）', value: priceCap });

  const binding = candidates.reduce((a, b) => (b.value < a.value ? b : a));
  const maxLoanGjj = Math.max(0, yuan(binding.value));

  /* ---------------- 5. 期限校验 ---------------- */
  const byAge = perPerson.map((p) => {
    const limit = cfg.loan.age_limit[p.genderKey] ?? cfg.loan.age_limit.male;
    const remainMonths = limit * 12 - p.age.months;
    return { label: p.label, limitAge: limit, age: p.age, remainMonths, years: Math.floor(Math.max(0, remainMonths) / 12) };
  });
  const ageCap = byAge.length ? Math.min(...byAge.map((x) => x.years)) : cfg.loan.max_term_years;
  const secondHandCap = secondHandAge > 0 ? cfg.loan.second_hand_age_plus_term - secondHandAge : Infinity;
  const maxTermAllowed = Math.max(0, Math.min(cfg.loan.max_term_years, ageCap, secondHandCap));

  const termOk = termYears <= maxTermAllowed;
  if (!termOk) {
    warnings.push(`所填期限 ${termYears} 年超出可贷上限 ${maxTermAllowed} 年（受年龄/楼龄/30 年上限约束）。`);
  }
  if (secondHandAge > 0 && termYears + secondHandAge > cfg.loan.second_hand_age_plus_term) {
    warnings.push(`二手楼「贷款期限 + 楼龄」= ${termYears + secondHandAge} 年，超过 ${cfg.loan.second_hand_age_plus_term} 年上限。`);
  }

  /* ---------------- 6. 额度拆分 ---------------- */
  const gjjAmount = yuan(Math.min(loanNeed, maxLoanGjj));
  const commercialAmount = yuan(Math.max(0, loanNeed - gjjAmount));
  const fullCover = commercialAmount <= 0;

  /* ---------------- 7. 利率与月供 ---------------- */
  const gr = graftRate(termYears, loanType, cfg);
  const months = termYears * 12;

  const gjjPay = payment(gjjAmount, gr.rate, months, method);
  const commPay = payment(commercialAmount, commercialRate, months, method);

  const total = {
    principal: yuan(gjjAmount + commercialAmount),
    monthly: yuan(gjjPay.monthly + commPay.monthly),
    first: yuan(gjjPay.first + commPay.first),
    last: yuan(gjjPay.last + commPay.last),
    totalInterest: yuan(gjjPay.totalInterest + commPay.totalInterest),
    totalPay: yuan(gjjPay.totalPay + commPay.totalPay)
  };

  /* ---------------- 8. 收入校验（月还贷额 ≤ 收入 50%） ---------------- */
  let income = null;
  if (familyIncome > 0) {
    const budget = familyIncome * cfg.loan.income_ratio_limit;
    const pGjj = Math.min(maxLoanGjj, principalByPayment(budget, gr.rate, months, method));
    const payGjj = payment(pGjj, gr.rate, months, method);
    const remain = Math.max(0, budget - (method === 'equal_principal' ? payGjj.first : payGjj.monthly));
    const pComm = principalByPayment(remain, commercialRate, months, method);
    income = {
      familyIncome,
      ratioLimit: cfg.loan.income_ratio_limit,
      budget: yuan(budget),
      monthlyDue: total.first,
      ok: total.first <= budget + 1,
      overBy: yuan(Math.max(0, total.first - budget)),
      maxLoanByIncome: yuan(pGjj + pComm),
      achieved: loanNeed <= pGjj + pComm + 1
    };
    if (!income.ok) {
      warnings.push(`首月月供 ${yuan(total.first).toLocaleString('zh-CN')} 元超过家庭月收入的 50%（${yuan(budget).toLocaleString('zh-CN')} 元）。按此收入水平，可贷上限约 ${(income.maxLoanByIncome / 10000).toFixed(1)} 万元，可考虑延长期限、降低贷款额或补充共同还款人。`);
    }
  } else {
    notes.push('未填写家庭月收入，已跳过「月还贷额 ≤ 家庭月收入 50%」这一硬性校验。');
  }

  /* ---------------- 9. 提取额度 ---------------- */
  const downPayment = yuan(Math.max(0, totalPrice - loanNeed));
  const totalBalance = yuan(perPerson.reduce((s, p) => s + p.balance, 0));
  const withdrawOnce = yuan(Math.min(totalBalance, downPayment));
  const withdraw = {
    downPayment,
    totalBalance,
    onceLimit: withdrawOnce,
    remainInAccount: yuan(totalBalance - withdrawOnce),
    totalLimit: yuan(totalPrice + total.totalInterest),
    perPerson: (() => {
      let left = withdrawOnce;
      const out = [];
      const share = totalBalance > 0 ? totalBalance : 1;
      perPerson.forEach((p) => {
        const own = totalBalance > 0 ? yuan(withdrawOnce * (p.balance / share)) : 0;
        const v = Math.min(own, left);
        left = yuan(left - v);
        out.push({ label: p.label, balance: p.balance, withdrawable: v });
      });
      if (left > 0 && out.length) out[out.length - 1].withdrawable = yuan(out[out.length - 1].withdrawable + left);
      return out;
    })(),
    note: cfg.withdraw.once_limit
  };

  /* ---------------- 10. 月度现金流（公积金账户抵扣） ---------------- */
  const monthlyDeposit = yuan(perPerson.reduce((s, p) => s + p.monthlyDeposit, 0));
  const gjjMonthly = gjjPay.first;
  const netIntoAccount = yuan(monthlyDeposit - gjjMonthly);
  let cashflow;
  if (netIntoAccount >= 0) {
    const toBank = yuan(Math.min(netIntoAccount, commercialAmount > 0 ? commPay.first : 0));
    cashflow = {
      monthlyDeposit,
      gjjMonthly,
      commMonthly: commPay.first,
      accountCoversGjj: true,
      netIntoAccount,
      transferToBank: toBank,
      cashMonthly: yuan(Math.max(0, commPay.first - toBank)),
      text: commercialAmount > 0
        ? `每月缴存 ${monthlyDeposit} 元足以覆盖公积金月供 ${gjjMonthly} 元，剩余 ${netIntoAccount} 元中最多 ${toBank} 元每月自动转入本人银行账户用于还商贷，实际每月自掏现金约 ${yuan(Math.max(0, commPay.first - toBank))} 元。`
        : `每月缴存 ${monthlyDeposit} 元覆盖公积金月供 ${gjjMonthly} 元后仍有结余 ${netIntoAccount} 元（可留存或用于提前还款），月供无需额外出钱。`
    };
  } else {
    cashflow = {
      monthlyDeposit,
      gjjMonthly,
      commMonthly: commPay.first,
      accountCoversGjj: false,
      netIntoAccount,
      transferToBank: 0,
      cashMonthly: yuan(commPay.first - netIntoAccount),
      text: `每月缴存 ${monthlyDeposit} 元不足以覆盖公积金月供 ${gjjMonthly} 元，每月需自付差额 ${Math.abs(netIntoAccount)} 元${commercialAmount > 0 ? `，加上商贷月供 ${commPay.first} 元` : ''}，合计每月现金支出约 ${yuan(commPay.first - netIntoAccount)} 元。`
    };
  }

  /* ---------------- 11. 方案对比（多商贷利率 + 两种还款方式） ---------------- */
  const rates = [];
  const pushRate = (rate, label) => {
    const r = Number(rate);
    if (!(r > 0)) return;
    const v = r > 1 ? r / 100 : r;
    if (rates.some((x) => Math.abs(x.rate - v) < 1e-9)) return;
    rates.push({ rate: v, label: label || `商贷 ${(v * 100).toFixed(3).replace(/\.?0+$/, '')}%` });
  };
  (Array.isArray(input.customRates) ? input.customRates : []).forEach((r) => pushRate(r, typeof r === 'object' ? r.label : null));
  if (!rates.length || !rates.some((x) => Math.abs(x.rate - commercialRate) < 1e-9)) {
    pushRate(commercialRate, '当前商贷利率');
  }

  const plans = buildPlans({
    rates, loanNeed, maxLoanGjj, gr, termYears, months, method, cfg
  });
  const methods = buildMethods({ gjjAmount, commercialAmount, gr, commercialRate, months, cfg });

  /* ---------------- 12. 参数时效 ---------------- */
  const fresh = R.freshness(asOf);
  if (fresh.level === 'stale') warnings.push(fresh.text);

  return {
    ok: true,
    asOf,
    city: cfg.city,
    mode,
    loanType,
    isAffordableHousing: isAffordable,
    method,
    termYears,
    maxTermAllowed,
    termOk,
    downRatio,
    minDownRatio,
    totalPrice: yuan(totalPrice),
    totalPriceDerived: !priceGiven,
    loanNeed,
    rate: {
      gjj: gr.rate,
      gjjTermBand: gr.termBand,
      commercial: commercialRate,
      label: cfg.loan.rate.labels[loanType]
    },
    uplift: {
      childPct: childMul,
      qualityPct: qualityMul,
      rate: upliftRate,
      baseCap,
      upliftCap,
      text: `上浮 ${(upliftRate * 100).toFixed(0)}%，上限 ${(upliftCap / 10000).toFixed(0)} 万元`
    },
    formulaTotal,
    perPerson,
    binding,
    maxLoanGjj,
    gjjAmount,
    commercialAmount,
    fullCover,
    payment: { gjj: gjjPay, commercial: commPay, total },
    income,
    withdraw,
    cashflow,
    plans,
    methods,
    termChecks: byAge,
    warnings,
    notes,
    sources: cfg.sources,
    freshness: fresh,
    disclaimer: cfg.disclaimer
  };
}

/** 不同商贷利率下的方案对比 */
function buildPlans({ rates, loanNeed, maxLoanGjj, gr, termYears, months, method, cfg }) {
  const rows = [];
  rows.push({
    key: 'pure_gjj',
    label: '纯公积金（不借用商贷）',
    commercialRate: null,
    gjjAmount: Math.min(loanNeed, maxLoanGjj),
    commercialAmount: Math.max(0, loanNeed - maxLoanGjj),
    feasible: loanNeed <= maxLoanGjj + 1,
    ...summarize(Math.min(loanNeed, maxLoanGjj), Math.max(0, loanNeed - maxLoanGjj), gr.rate, null, months, method)
  });

  rates.forEach((r) => {
    const gjj = Math.min(loanNeed, maxLoanGjj);
    const comm = Math.max(0, loanNeed - gjj);
    rows.push({
      key: `rate_${r.rate}`,
      label: comm > 0 ? `组合贷 · ${r.label}` : `纯公积金（${r.label} 用不上）`,
      commercialRate: r.rate,
      gjjAmount: gjj,
      commercialAmount: comm,
      feasible: true,
      ...summarize(gjj, comm, gr.rate, r.rate, months, method)
    });
  });

  // 纯商贷（极端对照：公积金一分不用）
  rows.push({
    key: 'pure_commercial',
    label: '纯商贷（住房公积金一分不贷）',
    commercialRate: rates[0] ? rates[0].rate : cfg.commercial.presets[0].rate,
    gjjAmount: 0,
    commercialAmount: loanNeed,
    feasible: true,
    ...summarize(0, loanNeed, gr.rate, rates[0] ? rates[0].rate : cfg.commercial.presets[0].rate, months, method)
  });

  return { termYears, rows };
}

function summarize(gjjAmount, commAmount, gjjRate, commRate, months, method) {
  const a = payment(gjjAmount, gjjRate, months, method);
  const b = payment(commAmount, commRate == null ? 0 : commRate, months, method);
  return {
    first: yuan(a.first + b.first),
    last: yuan(a.last + b.last),
    monthly: yuan(a.monthly + b.monthly),
    totalInterest: yuan(a.totalInterest + b.totalInterest),
    totalPay: yuan(a.totalPay + b.totalPay),
    gjjInterest: a.totalInterest,
    commInterest: b.totalInterest
  };
}

/** 同一笔贷款下，等额本息 vs 等额本金 */
function buildMethods({ gjjAmount, commercialAmount, gr, commercialRate, months, cfg }) {
  return [
    { key: 'equal_installment', label: '等额本息' },
    { key: 'equal_principal', label: '等额本金' }
  ].map((m) => {
    const s = summarize(gjjAmount, commercialAmount, gr.rate, commercialRate, months, m.key);
    return { ...m, ...s };
  });
}

module.exports = { calculate, payment, principalByPayment, summarize };
