'use strict';

/**
 * 断言式自检
 * ------------------------------------------------------------------
 * 只依赖 src/rules.js 与 src/calc.js（不碰 SQLite / 不依赖网络），
 * 可以在 CI 的无依赖环境里直接跑： node test/engine.test.js
 * ------------------------------------------------------------------
 */

const assert = require('assert');
const R = require('../src/rules');
const { calculate, payment, principalByPayment } = require('../src/calc');

let pass = 0;
const cases = [];
function it(name, fn) {
  cases.push({ name, fn });
}

const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1 : tol);

/* ---------------------- 1. 渐进式延迟退休对照表 ---------------------- */

it('男职工 1965-01 出生 → 60 岁 1 个月', () => {
  const r = R.retireAge('1965-01', 'male');
  assert.strictEqual(r.ageMonths, 60 * 12 + 1);
});

it('男职工 1965-05 出生 → 60 岁 2 个月', () => {
  assert.strictEqual(R.retireAge('1965-05', 'male').ageMonths, 60 * 12 + 2);
});

it('男职工 1976-08 出生 → 62 岁 11 个月（对照表上限）', () => {
  assert.strictEqual(R.retireAge('1976-08', 'male').ageMonths, 62 * 12 + 11);
});

it('男职工 1976-09 及以后出生 → 63 岁', () => {
  assert.strictEqual(R.retireAge('1976-09', 'male').ageMonths, 63 * 12);
  assert.strictEqual(R.retireAge('1995-07', 'male').ageMonths, 63 * 12);
});

it('男职工 1964-12 出生 → 60 岁（不受影响）', () => {
  assert.strictEqual(R.retireAge('1964-12', 'male').ageMonths, 60 * 12);
});

it('原 55 岁女职工 1970-01 → 55 岁 1 个月；1981-09 → 58 岁', () => {
  assert.strictEqual(R.retireAge('1970-01', 'female_manager').ageMonths, 55 * 12 + 1);
  assert.strictEqual(R.retireAge('1981-09', 'female_manager').ageMonths, 58 * 12);
});

it('原 50 岁女职工 1975-01 → 50 岁 1 个月；1984-10 → 54 岁 11 个月；1984-11 → 55 岁', () => {
  assert.strictEqual(R.retireAge('1975-01', 'female_worker').ageMonths, 50 * 12 + 1);
  assert.strictEqual(R.retireAge('1984-10', 'female_worker').ageMonths, 54 * 12 + 11);
  assert.strictEqual(R.retireAge('1984-11', 'female_worker').ageMonths, 55 * 12);
});

/* ------------------------------ 2. 月供 ------------------------------ */

it('等额本息：100 万 / 2.6% / 30 年 → 月供约 4003.4 元', () => {
  const p = payment(1000000, 0.026, 360, 'equal_installment');
  assert.ok(near(p.monthly, 4003.4, 1), `实际 ${p.monthly}`);
  assert.ok(near(p.totalInterest, 441224.07, 500), `总利息 ${p.totalInterest}`);
});

it('等额本金：100 万 / 2.6% / 30 年 → 首月 4944.44 元、总利息约 39.11 万', () => {
  const p = payment(1000000, 0.026, 360, 'equal_principal');
  assert.ok(near(p.first, 4944.44, 1), `首月 ${p.first}`);
  assert.ok(near(p.totalInterest, 391083.33, 500), `总利息 ${p.totalInterest}`);
  assert.ok(p.last < p.first, '等额本金末期月供应小于首期');
});

it('等额本金总利息 < 等额本息总利息（同额同期同率）', () => {
  const a = payment(1500000, 0.03075, 300, 'equal_installment');
  const b = payment(1500000, 0.03075, 300, 'equal_principal');
  assert.ok(b.totalInterest < a.totalInterest);
});

it('反解：月供上限 → 本金上限，来回算得回去', () => {
  const P = principalByPayment(5000, 0.026, 360, 'equal_installment');
  const back = payment(P, 0.026, 360, 'equal_installment');
  assert.ok(near(back.monthly, 5000, 1), `反解回来月供 ${back.monthly}`);
  const P2 = principalByPayment(6000, 0.026, 360, 'equal_principal');
  assert.ok(near(payment(P2, 0.026, 360, 'equal_principal').first, 6000, 1));
});

/* ---------------------------- 3. 端到端 ---------------------------- */

const AS_OF = '2026-09-21';

const base = {
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
  childPolicy: 'none',
  qualityPolicy: 'none',
  familyMonthlyIncome: 0,
  commercialRate: 3.0,
  customRates: [3.0, 3.5],
  repayment: 'equal_installment',
  asOf: AS_OF
};

it('基础额度：余额×10 + 月缴存额×到退休月数', () => {
  const r = calculate(base);
  assert.strictEqual(r.ok, true);
  const p1 = r.perPerson[0];
  assert.strictEqual(p1.balancePart, 860000, '余额部分应为 86 万');
  // 1992-06 男 → 2055-06 退休；2026-09 起还有 345 个月
  assert.strictEqual(p1.retire.monthsLeft, 345, `到退休月数 ${p1.retire.monthsLeft}`);
  assert.strictEqual(p1.depositPart, 2600 * 345);
  assert.strictEqual(p1.formulaAmount, 860000 + 2600 * 345);
  assert.strictEqual(r.formulaTotal, p1.formulaAmount + r.perPerson[1].formulaAmount);
});

it('上浮叠加封顶 +80%，并取三者（公式/上限/总价）最小值', () => {
  // 小额账户 → 让「额度公式」成为唯一的约束项
  const r = calculate({
    ...base,
    childPolicy: 'three_plus',
    qualityPolicy: 'good_house',
    houseTotalPrice: 5000000,
    persons: [
      { label: 'A', birth: '1992-06', category: 'male', balance: 20000, monthlyDeposit: 800 },
      { label: 'B', birth: '1994-03', category: 'female_manager', balance: 15000, monthlyDeposit: 600 }
    ]
  });
  assert.strictEqual(r.uplift.rate, 0.8, '两类上浮叠加应封顶 80%');
  assert.strictEqual(r.uplift.upliftCap, 2000000 * 1.8);
  assert.strictEqual(r.binding.key, 'formula');
  assert.strictEqual(r.maxLoanGjj, r.formulaTotal);
  // (200000 + 800×345) + (150000 + 600×306) = 476000 + 333600 = 809600
  assert.strictEqual(r.formulaTotal, 809600);
});

it('大额账户时最高限额生效，且可贷额始终等于三项最小值', () => {
  const r = calculate({
    ...base,
    childPolicy: 'three_plus',
    qualityPolicy: 'good_house'
  });
  const candidates = [r.formulaTotal, r.uplift.upliftCap, r.totalPrice * (1 - r.downRatio)];
  assert.strictEqual(r.binding.key, 'price');
  assert.strictEqual(r.maxLoanGjj, Math.min(...candidates));
});

it('最高限额生效：公式很大时被 100 万 / 200 万 卡住', () => {
  const r = calculate({
    ...base,
    persons: [
      { label: 'A', birth: '1992-06', category: 'male', balance: 900000, monthlyDeposit: 9000 },
      { label: 'B', birth: '1994-03', category: 'female_manager', balance: 900000, monthlyDeposit: 9000 }
    ]
  });
  assert.strictEqual(r.binding.key, 'cap');
  assert.strictEqual(r.maxLoanGjj, 2000000);
});

it('总价约束生效：贷款额 ≤ 总价 ×（1 − 首付）', () => {
  const r = calculate({
    ...base,
    persons: [
      { label: 'A', birth: '1992-06', category: 'male', balance: 900000, monthlyDeposit: 9000 },
      { label: 'B', birth: '1994-03', category: 'female_manager', balance: 900000, monthlyDeposit: 9000 }
    ],
    childPolicy: 'three_plus',
    qualityPolicy: 'good_house',
    houseTotalPrice: 1500000,
    loanNeed: 1300000
  });
  assert.strictEqual(r.binding.key, 'price');
  assert.ok(near(r.maxLoanGjj, 1500000 * 0.8, 1), `实际 ${r.maxLoanGjj}`);
});

it('满贷判定与组合贷缺口', () => {
  // 双人基础额度（无上浮）上限 200 万；本例公式额 ≈ 169.9 万 < 200 万 → 贷 150 万可满贷
  const r = calculate({ ...base, loanNeed: 1500000 });
  assert.strictEqual(r.fullCover, true);
  assert.strictEqual(r.commercialAmount, 0);
  assert.strictEqual(r.gjjAmount, 1500000);
  assert.ok(r.plans.rows.some((x) => x.key === 'pure_gjj' && x.feasible === true));

  // 需求 300 万 → 必有商贷缺口
  const r2 = calculate({ ...base, loanNeed: 3000000, houseTotalPrice: 4000000 });
  assert.strictEqual(r2.fullCover, false);
  assert.ok(r2.commercialAmount > 0);
  assert.strictEqual(r2.gjjAmount + r2.commercialAmount, 3000000);
});

it('利率档次：>5 年用 2.6%，≤5 年用 2.1%；二套用 3.075%', () => {
  assert.strictEqual(calculate({ ...base, termYears: 30 }).rate.gjj, 0.026);
  assert.strictEqual(calculate({ ...base, termYears: 5 }).rate.gjj, 0.021);
  assert.strictEqual(calculate({ ...base, termYears: 30, loanType: 'second' }).rate.gjj, 0.03075);
});

it('提取额度 = min(账户余额, 实际支付的首期房款)', () => {
  const r = calculate({ ...base, loanNeed: 1500000 });     // 总价 260 万，首付 110 万
  assert.strictEqual(r.withdraw.downPayment, 1100000);
  assert.strictEqual(r.withdraw.totalBalance, 148000);
  assert.strictEqual(r.withdraw.onceLimit, 148000, '余额少于首付 → 只能提全部余额');
  assert.strictEqual(r.withdraw.remainInAccount, 0);

  // 首付很小、余额很大的情形
  const r2 = calculate({
    ...base,
    persons: [
      { label: 'A', birth: '1992-06', category: 'male', balance: 500000, monthlyDeposit: 3000 },
      { label: 'B', birth: '1994-03', category: 'female_manager', balance: 400000, monthlyDeposit: 2500 }
    ],
    houseTotalPrice: 2000000,
    loanNeed: 1600000
  });
  assert.strictEqual(r2.withdraw.downPayment, 400000);
  assert.strictEqual(r2.withdraw.onceLimit, 400000, '余额多于首付 → 上限为首付');
  assert.strictEqual(r2.withdraw.remainInAccount, 500000);
});

it('期限受年龄约束：1967-09 生男职工最多 9 年（68 − 59）', () => {
  const r = calculate({
    ...base,
    mode: 'single',
    persons: [{ label: 'A', birth: '1967-09', category: 'male', balance: 200000, monthlyDeposit: 3000 }],
    loanNeed: 800000,
    houseTotalPrice: 1000000,
    termYears: 30
  });
  assert.strictEqual(r.termChecks[0].age.years, 59);
  assert.strictEqual(r.maxTermAllowed, 9, `实际 ${r.maxTermAllowed}`);
  assert.strictEqual(r.termOk, false);
  assert.ok(r.warnings.some((w) => /超出可贷上限/.test(w)));
});

it('二手楼：期限 + 楼龄 ≤ 50 年', () => {
  const r = calculate({ ...base, secondHandAge: 25, termYears: 30 });
  assert.strictEqual(r.maxTermAllowed, 25);
  assert.ok(r.warnings.some((w) => /楼龄/.test(w)));
});

it('收入 50% 硬约束：月供超限要报警', () => {
  const r = calculate({ ...base, loanNeed: 2000000, houseTotalPrice: 2600000, familyMonthlyIncome: 10000 });
  assert.strictEqual(r.income.ok, false);
  assert.ok(r.income.overBy > 0);
  assert.ok(r.warnings.some((w) => /家庭月收入的 50%/.test(w)));
});

it('公积金账户可覆盖月供时，现金支出被正确冲抵', () => {
  const r = calculate({
    ...base,
    persons: [
      { label: 'A', birth: '1992-06', category: 'male', balance: 500000, monthlyDeposit: 6000 },
      { label: 'B', birth: '1994-03', category: 'female_manager', balance: 400000, monthlyDeposit: 5000 }
    ],
    loanNeed: 1800000,
    houseTotalPrice: 2300000,
    familyMonthlyIncome: 40000
  });
  assert.strictEqual(r.cashflow.monthlyDeposit, 11000);
  assert.ok(r.cashflow.accountCoversGjj, '月缴存应覆盖公积金月供');
  assert.ok(r.cashflow.cashMonthly >= 0);
});

it('方案对比表覆盖预设利率且无重复', () => {
  const r = calculate(base);
  const rows = r.plans.rows;
  assert.ok(rows.length >= 4);
  const rateRows = rows.filter((x) => x.key.startsWith('rate_'));
  assert.strictEqual(rateRows.length, 2, '应生成 2 档商贷利率方案');
  const seen = new Set();
  rateRows.forEach((x) => {
    assert.ok(!seen.has(x.commercialRate), '利率重复');
    seen.add(x.commercialRate);
  });
  rows.forEach((x) => {
    assert.ok(near(x.gjjAmount + x.commercialAmount, base.loanNeed, 1), `${x.label} 金额对不上`);
  });
  const pure = rows.find((x) => x.key === 'pure_commercial');
  assert.strictEqual(pure.gjjAmount, 0);
  assert.strictEqual(pure.commercialAmount, base.loanNeed);
});

it('还款方式对比：等额本金总利息少于等额本息', () => {
  const r = calculate(base);
  const a = r.methods.find((m) => m.key === 'equal_installment');
  const b = r.methods.find((m) => m.key === 'equal_principal');
  assert.ok(b.totalInterest < a.totalInterest);
  assert.ok(b.last < b.first);
  assert.ok(near(a.first, a.last, 0.01), '等额本息每月月供应恒定');
});

it('参数时效检测：参数日期在未来/今天为 ok，一年以上为 stale', () => {
  assert.strictEqual(R.freshness('2026-09-21').level, 'ok');
  assert.strictEqual(R.freshness('2028-01-01').level, 'stale');
});

it('参数时效的基准日必须是完整日期（曾因只到月而显示「距今 -20 天」）', () => {
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(R.todayStr()), `todayStr=${R.todayStr()}`);
  assert.strictEqual(R.fullDate('2026-09'), '2026-09-01', '年月要补齐为当月 1 日');
  assert.strictEqual(R.fullDate('2026-09-21'), '2026-09-21');
  assert.strictEqual(R.fullDate(null), null);

  // 走缺省基准日分支（界面就是这条路径）：asOf 必须是完整日期，否则天数差会差出整月
  const r = calculate({ ...base, asOf: undefined });
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.asOf), `asOf 应为完整日期，实际 ${r.asOf}`);
  assert.ok(Number.isInteger(r.freshness.ageDays) && r.freshness.ageDays >= 0,
    `ageDays 应为非负整数，实际 ${r.freshness.ageDays}`);
  assert.ok(!/距今 -\d/.test(r.freshness.text), r.freshness.text);

  // 参数复核日 == 今天 → 文案里是「距今 0 天」
  const same = R.freshness(R.todayStr());
  assert.strictEqual(same.ageDays, 0);
  assert.ok(/距今 0 天/.test(same.text), same.text);
});

it('入参缺失时给出可读错误而不是抛异常', () => {
  assert.strictEqual(calculate({}).ok, false);
  assert.ok(calculate({ persons: [], loanNeed: 100 }).error);
  assert.ok(calculate({ persons: [{ birth: '1990-01' }], loanNeed: 0 }).error);
});

it('出生日期填到「日」时，与只填「年月」结果完全一致', () => {
  // 界面上的出生日期控件允许填年-月-日，但官方对照表是按「出生年月」划档，
  // 日不参与计算 —— 这条断言把这个口径钉死，防止以后有人误按日去算退休年龄。
  const monthOnly = calculate({
    ...base,
    persons: [
      { label: '借款人', birth: '1992-06', category: 'male', balance: 86000, monthlyDeposit: 2600 },
      { label: '共同借款人', birth: '1994-03', category: 'female_manager', balance: 62000, monthlyDeposit: 1900 }
    ]
  });
  const fullDate = calculate({
    ...base,
    persons: [
      { label: '借款人', birth: '1992-06-15', category: 'male', balance: 86000, monthlyDeposit: 2600 },
      { label: '共同借款人', birth: '1994-03-28', category: 'female_manager', balance: 62000, monthlyDeposit: 1900 }
    ]
  });
  assert.strictEqual(fullDate.maxLoanGjj, monthOnly.maxLoanGjj, '可贷额度不该受「日」影响');
  assert.strictEqual(fullDate.formulaTotal, monthOnly.formulaTotal, '额度公式不该受「日」影响');
  assert.strictEqual(fullDate.maxTermAllowed, monthOnly.maxTermAllowed, '可贷期限不该受「日」影响');
  assert.deepStrictEqual(
    fullDate.perPerson.map((p) => p.retire.retireDate),
    monthOnly.perPerson.map((p) => p.retire.retireDate),
    '退休年月不该受「日」影响'
  );
  // 退休口径里回显的出生信息统一归一化成「YYYY-MM」，不把无意义的「日」带进来
  assert.ok(/^\d{4}-\d{2}$/.test(fullDate.perPerson[0].retire.birth), fullDate.perPerson[0].retire.birth);
  assert.strictEqual(fullDate.perPerson[0].retire.birth, '1992-06');
  assert.strictEqual(fullDate.perPerson[1].retire.birth, '1994-03');
});

it('同一月内的不同「日」，退休年龄按月划档应完全相同', () => {
  assert.strictEqual(
    R.retireAge('1970-05-01', 'male').ageMonths,
    R.retireAge('1970-05-31', 'male').ageMonths
  );
  assert.strictEqual(
    R.monthsToRetire('1970-05-01', 'male', '2026-09-21').monthsLeft,
    R.monthsToRetire('1970-05-31', 'male', '2026-09-21').monthsLeft
  );
  assert.strictEqual(
    R.retireAge('1970-05-31', 'male').retireDate,
    R.retireAge('1970-05-01', 'male').retireDate
  );
});

/* ------------------------------ 执行 ------------------------------ */

let failed = 0;
cases.forEach((c) => {
  try {
    c.fn();
    pass += 1;
    console.log(`  ✓ ${c.name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${c.name}\n      ${e.message}`);
  }
});

console.log(`\n${pass}/${cases.length} 项断言通过${failed ? `，${failed} 项失败` : ''}`);
process.exit(failed ? 1 : 0);
