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
  assert.strictEqual(r.withdraw.onceLimit, 148000, '余额少于首付 → 一次性提取上限为全部余额');
  assert.strictEqual(r.withdraw.safeLimit, 145840, '按本次实际要贷的 150 万算，富余的余额可以提走');
  assert.strictEqual(r.withdraw.keepBalance, 2160, '提完后还得留下撑住公式额的那部分');
  assert.strictEqual(r.withdraw.remainInAccount, 2160);

  // 口径钉子：能提取多少按「本次实际贷款额」，不是「最高可贷上限」
  const full = calculate({ ...base, loanNeed: 2000000 });   // 贷满上限 200 万
  assert.strictEqual(full.withdraw.safeLimit, 95840, '贷到上限时只能提走 9.584 万');
  assert.strictEqual(r.withdraw.safeLimit - full.withdraw.safeLimit, 50000, '少贷 50 万 → 多提 5 万（(200万−150万)÷10）');

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

it('期限不够就自动收敛：选 30 年也只按 9 年算（不再硬拉到 30 年）', () => {
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
  assert.strictEqual(r.requestedTermYears, 30, '用户选的要留痕');
  assert.strictEqual(r.termYears, 9, '生效期限必须自动收敛到上限');
  assert.strictEqual(r.termAdjusted, true);
  assert.strictEqual(r.termOk, false);
  assert.ok(r.warnings.some((w) => /自动修正/.test(w)), '要明示「已自动修正」');
  // 月供表必须按 9 年（108 期）出，而不是用户选的 30 年
  assert.strictEqual(r.schedule.length, 9);
  assert.strictEqual(r.payment.total.monthly, r.methods.find((m) => m.key === 'equal_installment').first);
});

it('二手楼：期限 + 楼龄 ≤ 50 年', () => {
  const r = calculate({ ...base, secondHandAge: 25, termYears: 30 });
  assert.strictEqual(r.maxTermAllowed, 25);
  assert.strictEqual(r.termYears, 25, '超出上限的部分要被收敛掉');
  assert.ok(r.warnings.some((w) => /楼龄/.test(w)));
});

it('二手楼楼龄按建成（竣工）日期推算，旧的「直接给楼龄」入参仍兼容', () => {
  // 基准日 2026-09-21，建成 2001-06 → 楼龄 25 年 → 期限上限 50 − 25 = 25 年
  const byDate = calculate({ ...base, builtAt: '2001-06', termYears: 30 });
  assert.strictEqual(byDate.builtAt, '2001-06');
  assert.strictEqual(byDate.secondHandAge, 25);
  assert.strictEqual(byDate.maxTermAllowed, 25);
  assert.strictEqual(byDate.termYears, 25);

  const legacy = calculate({ ...base, secondHandAge: 25, termYears: 30 });
  assert.strictEqual(legacy.termYears, 25, '老入参算出来必须一致');
  assert.strictEqual(legacy.maxTermAllowed, byDate.maxTermAllowed);
  assert.strictEqual(legacy.maxLoanGjj, byDate.maxLoanGjj);

  // 新房：不填建成日期 → 楼龄 0，期限回到 30 年上限
  const fresh = calculate({ ...base, termYears: 30 });
  assert.strictEqual(fresh.builtAt, null);
  assert.strictEqual(fresh.secondHandAge, 0);
  assert.strictEqual(fresh.termYears, 30);
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

it('余额 / 月缴存额可以填带角分的真实数值：不丢分，额度按元向下取整', () => {
  // 公积金账户里的余额、月缴存额本来就是 12345.67 / 320.55 这种带角分的真实数值，
  // 输入层必须收得下；引擎只在「额度 / 贷款金额」这一步取整到元，不能反过来把输入砍掉。
  const r = calculate({
    asOf: '2026-09-21',
    mode: 'single',
    persons: [{ label: 'A', birth: '1992-06', category: 'male', balance: 12345.67, monthlyDeposit: 320.55 }],
    loanNeed: 200000,
    termYears: 30
  });
  const p1 = r.perPerson[0];
  assert.strictEqual(r.ok, true);
  assert.strictEqual(p1.balance, 12345.67, '余额要原样带进计算，不能被取整');
  assert.strictEqual(p1.monthlyDeposit, 320.55, '月缴存额要原样带进计算');
  assert.strictEqual(p1.balancePart, 123456.7, '余额 × 10 应保留到分');
  assert.ok(near(p1.depositPart, 320.55 * p1.retire.monthsLeft, 0.011), `月缴部分=${p1.depositPart}`);
  assert.ok(near(p1.formulaAmount, p1.balancePart + p1.depositPart, 0.011), '公式额 = 余额部分 + 月缴部分');
  // 派生金额最多两位小数（不会出现 0.30000000000000004 这种浮点尾巴）
  [p1.balancePart, p1.depositPart, p1.formulaAmount, r.formulaTotal].forEach((v) => {
    assert.ok(Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, `${v} 应最多两位小数`);
  });
  // 额度 / 金额一律整元
  assert.ok(Number.isInteger(r.maxLoanGjj), `可贷额应取整到元，实际 ${r.maxLoanGjj}`);
  assert.strictEqual(r.maxLoanGjj, Math.floor(r.formulaTotal), '公式为限制项时，可贷额 = 向下取整到元');
  assert.strictEqual(r.maxLoanGjj, 234046, '234046.45 元 → 取整到元应为 234046');
  assert.ok(Number.isInteger(r.loanNeed), `贷款金额应为整元，实际 ${r.loanNeed}`);
  assert.ok(Number.isInteger(r.gjjAmount) && Number.isInteger(r.commercialAmount), '公积金/商贷拆分应为整元');
});

it('带角分的余额不会把可贷额抬高（向下取整，不四舍五入）', () => {
  const mk = (balance) => calculate({
    asOf: '2026-09-21',
    mode: 'single',
    persons: [{ label: 'A', birth: '1992-06', category: 'male', balance, monthlyDeposit: 0 }],
    loanNeed: 100000,
    termYears: 30
  });
  // 余额 12345.67 → 公式 123456.7 → 可贷额 123456（不是 123457）
  assert.strictEqual(mk(12345.67).maxLoanGjj, 123456);
  assert.strictEqual(mk(12345.6).maxLoanGjj, 123456);
  assert.strictEqual(mk(12345).maxLoanGjj, 123450);
});

it('可提取余额 = 提完之后仍够贷到本次金额的那部分，双人按余额分摊', () => {
  const big = calculate({
    ...base,
    persons: [
      { label: 'A', birth: '1992-06', category: 'male', balance: 500000, monthlyDeposit: 3000 },
      { label: 'B', birth: '1994-03', category: 'female_manager', balance: 400000, monthlyDeposit: 2500 }
    ],
    houseTotalPrice: 2000000,
    loanNeed: 1600000
  });
  assert.strictEqual(big.withdraw.totalBalance, 900000, '余额合计 = 两人账户余额之和');
  assert.strictEqual(big.withdraw.safeLimit, 400000, '被「首期房款 40 万」卡住时只能提 40 万');
  assert.strictEqual(big.withdraw.keepBalance, 500000);

  // 每人之和必须等于合计（取整零头不能凭空多出/少掉）
  const sum = big.withdraw.perPerson.reduce((s, x) => s + x.withdrawable, 0);
  assert.strictEqual(sum, big.withdraw.safeLimit, `每人之和 ${sum} ≠ 合计 ${big.withdraw.safeLimit}`);
  big.withdraw.perPerson.forEach((p, i) => {
    const src = big.perPerson[i];
    assert.ok(Math.abs(p.withdrawable - 0) >= 0 && p.balance >= p.withdrawable - 0.01, `${p.label} 不能超过自己的余额`);
    assert.ok(near(p.keep, src.balance - p.withdrawable, 0.02), `${p.label} 保留额应为 余额 − 可提取`);
  });
  // 按余额占比分摊：50 万 : 40 万（每人各自取整到元，零头补给余额大的那个，容差 ≤ 2 元）
  const a = big.withdraw.perPerson[0];
  assert.ok(near(a.withdrawable, 400000 * (500000 / 900000), 2), `实际 ${a.withdrawable}`);
  // 报出来的数必须是整元：带角分的数用户照抄就会多提，×10 放大成几百元额度差
  big.withdraw.perPerson.forEach((p) => {
    assert.strictEqual(p.withdrawable, Math.floor(p.withdrawable), `${p.label} 可提取额 ${p.withdrawable} 必须是整元`);
  });
  assert.strictEqual(big.withdraw.safeLimit, Math.floor(big.withdraw.safeLimit), '合计可提取额必须是整元');

  // 提完之后公式额必须仍然撑得住原来的可贷额
  const after = big.perPerson.reduce((s, p, i) =>
    s + (p.balance - big.withdraw.perPerson[i].withdrawable) * big.withdraw.balanceMultiplier
      + p.monthlyDeposit * p.retire.monthsLeft, 0);
  assert.ok(after + 1 >= big.maxLoanGjj, `提完后公式额 ${after} 不该低于可贷额 ${big.maxLoanGjj}`);
});

it('额度被公式本身卡住时，本次要贷的金额已用尽公式额 → 一分钱都不能提', () => {
  const r = calculate({
    ...base,
    persons: [
      { label: 'A', birth: '1992-06', category: 'male', balance: 20000, monthlyDeposit: 800 },
      { label: 'B', birth: '1994-03', category: 'female_manager', balance: 15000, monthlyDeposit: 600 }
    ],
    houseTotalPrice: 5000000,
    termYears: 30
  });
  assert.strictEqual(r.binding.key, 'formula', '这一例应由额度公式兜底');
  assert.strictEqual(r.withdraw.formulaSlackBalance, 0);
  assert.strictEqual(r.withdraw.safeLimit, 0);
  assert.strictEqual(r.withdraw.keepBalance, r.withdraw.totalBalance, '余额必须全部留下');
  assert.ok(r.notes.some((n) => /公式额用尽/.test(n)), '要说明为什么不能提');
});

it('可提取额必须报「整元」：照报出来的数提走，本次一定还贷得下来（余额 ×10 进公式，带角分会放大成几百元额度差）', () => {
  const mk = (b2) => calculate({
    ...base,
    houseTotalPrice: 0,
    childPolicy: 'one',
    asOf: '2026-09-21',
    persons: [
      { label: '借款人', birth: '1991-09-01', category: 'male', balance: 39903.85, monthlyDeposit: 840 },
      { label: '共同借款人', birth: '1990-07-02', category: 'female_manager', balance: b2, monthlyDeposit: 1710 }
    ]
  });
  const r = mk(169724.88);
  const w = r.withdraw.safeLimit;
  assert.strictEqual(w, Math.floor(w), `可提取额 ${w} 必须是整元，不能报带角分的数`);
  assert.ok(r.withdraw.slackRaw - w < 1, `报数 ${w} 与精确上限 ${r.withdraw.slackRaw} 相差不该超过 1 元`);
  assert.strictEqual(r.withdraw.afterWithdraw.stillCovers, true, '复核必须判定为「仍贷得下来」');
  // 照报出来的数提走 → 仍然满贷 200 万
  const after = mk(169724.88 - w);
  assert.ok(after.maxLoanGjj >= 2000000, `照报出的 ${w} 元提走后只剩 ${after.maxLoanGjj}，贷不满 200 万`);
  // 反向钉住：多提 100 元就会掉 1000 元额度 —— 这就是不能报「8.27 万」这种模糊数的原因
  assert.ok(mk(169724.88 - (w + 100)).maxLoanGjj < 2000000, '多提 100 元就该贷不满，说明报数也没保守过头');
});

it('逐年月供对照表：最多 30 行，末期归零，逐年累加等于总额', () => {
  const r = calculate({ ...base, termYears: 30 });
  assert.strictEqual(r.schedule.length, 30, '30 年就 30 行');
  const last = r.schedule[r.schedule.length - 1];
  assert.strictEqual(last.installment.endBalance, 0, '等额本息末期必须还清');
  assert.strictEqual(last.principal.endBalance, 0, '等额本金末期必须还清');

  const mInst = r.methods.find((m) => m.key === 'equal_installment');
  const mPrin = r.methods.find((m) => m.key === 'equal_principal');
  const sumInst = r.schedule.reduce((s, x) => s + x.installment.yearPay, 0);
  const sumPrin = r.schedule.reduce((s, x) => s + x.principal.yearPay, 0);
  assert.ok(near(sumInst, mInst.totalPay, 0.1), `等额本息逐年合计 ${sumInst} ≈ 总额 ${mInst.totalPay}`);
  assert.ok(near(sumPrin, mPrin.totalPay, 0.1), `等额本金逐年合计 ${sumPrin} ≈ 总额 ${mPrin.totalPay}`);

  // 等额本息月供恒定；等额本金逐月递减且前期更高
  assert.strictEqual(r.schedule[0].installment.first, last.installment.last, '等额本息月供全程不变');
  assert.ok(r.schedule[0].principal.first > last.principal.last, '等额本金应递减');
  assert.ok(r.schedule[0].principal.first > r.schedule[0].installment.first, '首月等额本金压力更大');

  // 期限被收敛时行数跟着变，绝不会按用户选的年限出表
  const shortTerm = calculate({ ...base, termYears: 5 });
  assert.strictEqual(shortTerm.schedule.length, 5);
  // 中间年份都是 12 期，不会凭空多出或漏掉
  assert.strictEqual(r.schedule[0].monthCount, 12);
  assert.strictEqual(last.monthCount, 12);
});

it('逐年月供表新增「每月实付」：先扣公积金账户，账户扣空之后才从银行卡拿现金', () => {
  const r = calculate({
    ...base,
    persons: [
      { label: 'A', birth: '1992-06', category: 'male', balance: 60000, monthlyDeposit: 1200 },
      { label: 'B', birth: '1994-03', category: 'female_manager', balance: 40000, monthlyDeposit: 900 }
    ],
    loanNeed: 2000000, houseTotalPrice: 0, downRatio: 20, termYears: 30
  });
  const c = r.scheduleCash;
  assert.ok(c, '应给出公积金账户的逐月模拟结果');
  assert.ok(c.acc0 > 0, `期初账户余额 ${c.acc0} 应按「提取后留在账户里的钱」起算`);
  assert.strictEqual(c.monthlyDeposit, 2100, '每月缴存合计 = 两人之和');

  // 前期账户里有钱 → 一分现金不出
  assert.strictEqual(r.schedule[0].installment.cashFirst, 0, '第一年账户够扣，不该掏现金');
  assert.strictEqual(r.schedule[0].principal.cashFirst, 0);
  // 账户一定会在某一年被扣空（月供远大于缴存）
  assert.ok(c.emptyYear >= 1, `账户应在第 ${c.emptyYear} 年被扣空`);
  // 扣空之后：每月实付 = 月供 − 缴存
  const last = r.schedule[r.schedule.length - 1];
  assert.ok(last.installment.cashFirst > 0, '账户扣空后每月应有现金支出');
  assert.ok(near(last.installment.cashFirst, last.installment.first - c.monthlyDeposit, 1.5),
    `实付 ${last.installment.cashFirst} 应 ≈ 月供 ${last.installment.first} − 缴存 ${c.monthlyDeposit}`);
  // 实付不可能超过应还，且账户替你出钱 → 实付合计必然小于总还款
  assert.ok(c.totalCashInstallment < r.methods.find((m) => m.key === 'equal_installment').totalPay);
  assert.ok(c.totalCashPrincipal < r.methods.find((m) => m.key === 'equal_principal').totalPay);
  // 每年「实付」之和 = 实付合计
  const sumCash = r.schedule.reduce((s, x) => s + x.installment.yearCash, 0);
  assert.ok(near(sumCash, c.totalCashInstallment, 0.1), `逐年实付合计 ${sumCash} ≈ ${c.totalCashInstallment}`);
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
