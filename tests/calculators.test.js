// Credit card payoff, car loan and compound interest calculators.
// Expected values are hand-worked (shown in comments), closed-form, or from an independent
// Decimal reference implementation (Python, half-up cents) noted as "ref".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardPayoff, paymentForMonths, minimumPayoff, balanceTransfer } from '../src/js/lib/debt.js';
import { amountFinanced, carLoan, compareTerms, TERMS } from '../src/js/lib/autoloan.js';
import { grow, aprToApy, apyToApr, monthsToGoal, contributionForGoal, monthlyFactor } from '../src/js/lib/savings.js';
import { schedule, monthlyPayment } from '../src/js/amortization.js';

const near = (a, b, tol = 0.005, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);

// ---------------------------------------------------------------- credit card
test('card: fixed payment, hand-worked 3 months', () => {
  // $1,000 at 12% (1%/mo), $500/mo:
  // m1 int 10.00 -> 1010 - 500 = 510.00; m2 int 5.10 -> 515.10 - 500 = 15.10;
  // m3 int 0.151 -> 0.15 -> 15.25 paid in full.
  const r = cardPayoff(1000, 12, 500);
  assert.equal(r.ok, true);
  assert.equal(r.months, 3);
  assert.equal(r.totalInterest, 15.25);
  assert.equal(r.totalPaid, 1015.25);
  assert.equal(r.lastPayment, 15.25);
  assert.deepEqual(r.timeline, [510, 15.1, 0]);
});

test('card: matches independent reference ($5,000 at 22.99%, $200/mo)', () => {
  const r = cardPayoff(5000, 22.99, 200);
  assert.equal(r.months, 35); // ref
  assert.equal(r.totalInterest, 1871.1); // ref
  assert.equal(r.firstInterest, 95.79); // 5000 × 22.99% ÷ 12 = 95.7917
  assert.equal(r.lastPayment, 71.1);
});

test('card: payment that does not cover interest is reported, not looped', () => {
  // $5,000 at 24% -> $100.00 interest in month 1
  const r = cardPayoff(5000, 24, 100);
  assert.equal(r.ok, false); assert.equal(r.reason, 'interest'); assert.equal(r.firstInterest, 100);
  assert.equal(r.months, Infinity);
  assert.equal(cardPayoff(5000, 24, 100.01).ok, true);
  assert.equal(cardPayoff(0, 24, 100).months, 0);
});

test('card: pay-off-in-N-months payment clears the card in exactly N months', () => {
  for (const [bal, apr, n] of [[5000, 22.99, 24], [12345.67, 29.99, 36], [800, 0, 7], [3000, 18, 12]]) {
    const p = paymentForMonths(bal, apr, n);
    const r = cardPayoff(bal, apr, p);
    assert.equal(r.months, n, `${bal}@${apr} in ${n}: payment ${p}`);
    // a cent less must take longer (smallest payment that works)
    assert.ok(cardPayoff(bal, apr, p - 0.01).months > n);
    // and it agrees with the amortization engine (rounded-up payment)
    const s = schedule(bal, apr, n, { rounding: 'up' });
    assert.equal(p, s.payment); near(r.totalInterest, s.totalInterest, 0.001);
  }
  assert.equal(paymentForMonths(5000, 0, 10), 500);
  assert.equal(paymentForMonths(0, 20, 10), 0);
});

test('card: minimum payments (1% + interest, $25 floor)', () => {
  // $10,000 at 12%: m1 interest 100 + 1% 100 = 200 -> balance 9,900; m2 99 + 99 = 198 -> 9,801.
  const r = minimumPayoff(10000, 12, { pct: 1, floor: 25 });
  assert.equal(r.firstPayment, 200);
  assert.deepEqual(r.timeline.slice(0, 2), [9900, 9801]);
  // floor dominates for small balances: $1,000 at 12% -> max(25, 10 + 10) = 25
  assert.equal(minimumPayoff(1000, 12).firstPayment, 25);
  // independent reference
  const a = minimumPayoff(5000, 22.99, { pct: 1, floor: 25 });
  assert.deepEqual([a.months, a.totalInterest, a.firstPayment], [232, 8488.89, 145.79]);
  const b = minimumPayoff(3000, 19.99, { pct: 2, floor: 35 });
  assert.deepEqual([b.months, b.totalInterest, b.firstPayment], [94, 2032.41, 109.98]);
  // last payment never overshoots: totalPaid = balance + interest
  assert.equal(a.totalPaid, 13488.89);
});

test('balance transfer: paid off inside a 0% promo (hand-worked)', () => {
  // $5,000 + 3% fee ($150) = $5,150 at 0%, $300/mo: 17 × 300 = 5,100, then $50 -> 18 months.
  const r = balanceTransfer(5000, 300, { feePct: 3, promoApr: 0, promoMonths: 18, afterApr: 24 });
  assert.equal(r.ok, true); assert.equal(r.months, 18); assert.equal(r.fee, 150);
  assert.equal(r.totalInterest, 0); assert.equal(r.totalCost, 150); assert.equal(r.totalPaid, 5150);
});

test('balance transfer: balance left after the promo accrues the go-to rate (hand-worked)', () => {
  // 0% for 12 months: 5,150 − 12 × 300 = 1,550 left. Then 12% (1%/mo):
  // 15.50, 12.655->12.66, 9.7816->9.78, 6.8794->6.88, 3.9482->3.95, 0.9877->0.99 = 49.76
  const r = balanceTransfer(5000, 300, { feePct: 3, promoApr: 0, promoMonths: 12, afterApr: 12 });
  assert.equal(r.promoBalanceLeft, 1550);
  assert.equal(r.months, 18); assert.equal(r.totalInterest, 49.76); assert.equal(r.totalCost, 199.76);
  // independent reference: $200/mo, 18 months 0%, then 22.99%
  const s = balanceTransfer(5000, 200, { feePct: 3, promoApr: 0, promoMonths: 18, afterApr: 22.99 });
  assert.deepEqual([s.months, s.totalInterest, s.fee], [27, 144.39, 150]);
});

test('balance transfer: payment below post-promo interest is reported', () => {
  const r = balanceTransfer(20000, 100, { feePct: 5, promoApr: 0, promoMonths: 6, afterApr: 25 });
  assert.equal(r.ok, false); assert.equal(r.reason, 'interest'); assert.equal(r.promoBalanceLeft, 20400);
});

// ---------------------------------------------------------------- car loan
test('car: amount financed — tax after trade-in credit, fees untaxed', () => {
  const deal = { price: 30000, down: 3000, tradeIn: 8000, owed: 5000, taxPct: 6, fees: 500 };
  // equity 3,000; taxable 30,000 − 8,000 = 22,000; tax 1,320; 30,000 + 1,320 + 500 − 3,000 − 3,000
  assert.deepEqual(amountFinanced({ ...deal, taxAfterTrade: true }), { equity: 3000, taxable: 22000, tax: 1320, financed: 25820 });
  // tax on full price: 1,800 -> 26,300
  assert.deepEqual(amountFinanced({ ...deal, taxAfterTrade: false }), { equity: 3000, taxable: 30000, tax: 1800, financed: 26300 });
  // negative equity is rolled in: trade 5,000, owe 8,000 -> −3,000; tax on 25,000 = 1,500
  assert.deepEqual(amountFinanced({ ...deal, tradeIn: 5000, owed: 8000 }), { equity: -3000, taxable: 25000, tax: 1500, financed: 32000 });
  // big down payment can't make the loan negative
  assert.equal(amountFinanced({ price: 10000, down: 20000 }).financed, 0);
  // trade-in worth more than the car: tax base floors at 0
  assert.equal(amountFinanced({ price: 10000, tradeIn: 12000, taxPct: 7 }).tax, 0);
});

test('car: payment matches the closed-form annuity formula', () => {
  // textbook: $25,000 at 6% for 60 months = $483.32
  assert.equal(carLoan({ price: 25000 }, 6, 60).payment, 483.32);
  const deal = { price: 30000, down: 3000, tradeIn: 8000, owed: 5000, taxPct: 6, fees: 500 };
  for (const n of TERMS) {
    const r = 0.065 / 12, P = 25820;
    const closed = Math.round(P * r / (1 - Math.pow(1 + r, -n)) * 100) / 100;
    const c = carLoan(deal, 6.5, n);
    assert.equal(c.payment, closed, `term ${n}`);
    // total of payments = financed + interest; total cost adds cash down + positive equity
    near(c.totalOfPayments, 25820 + c.totalInterest, 0.001);
    near(c.totalCost, c.totalOfPayments + 3000 + 3000, 0.001);
    assert.equal(c.rows.length, n);
  }
});

test('car: term comparison — longer terms lower the payment and raise the interest', () => {
  const t = compareTerms({ price: 30000, down: 3000, tradeIn: 8000, owed: 5000, taxPct: 6, fees: 500 }, 6.5, [48, 60, 72]);
  assert.deepEqual(t.map((x) => x.payment), [612.32, 505.2, 434.03]);
  assert.deepEqual(t.map((x) => x.totalInterest), [3571.38, 4491.9, 5430.4]);
  for (let i = 1; i < t.length; i++) { assert.ok(t[i].payment < t[i - 1].payment); assert.ok(t[i].totalInterest > t[i - 1].totalInterest); }
  assert.equal(t[0].rows, undefined);
});

test('car: 0% APR and zero-financed edge cases', () => {
  const z = carLoan({ price: 24000 }, 0, 48);
  assert.equal(z.payment, 500); assert.equal(z.totalInterest, 0); assert.equal(z.totalCost, 24000);
  const cash = carLoan({ price: 20000, down: 20000 }, 7, 60);
  assert.equal(cash.payment, 0); assert.equal(cash.totalCost, 20000); assert.equal(cash.rows.length, 0);
  // negative equity: total cost includes paying off the old loan through the new one
  const neg = carLoan({ price: 20000, tradeIn: 5000, owed: 8000 }, 0, 60);
  assert.equal(neg.financed, 23000); assert.equal(neg.totalCost, 23000);
});

// ---------------------------------------------------------------- compound interest
test('savings: $10,000 at 5% APY for 10 years = $16,288.95 (10000 × 1.05^10)', () => {
  const r = grow({ initial: 10000, monthly: 0, rate: 5, rateType: 'apy', years: 10 });
  assert.equal(r.final, 16288.95); assert.equal(r.contributed, 10000); assert.equal(r.interest, 6288.95);
  assert.equal(r.years.length, 10); assert.equal(r.years[0].balance, 10500); assert.equal(r.years[1].balance, 11025);
});

test('savings: future value of an annuity ($100/mo, 6% APR monthly, 10 yrs = $16,387.93)', () => {
  // FV = 100 × ((1.005^120 − 1) / 0.005)
  const r = grow({ initial: 0, monthly: 100, rate: 6, rateType: 'apr', freq: 'monthly', years: 10 });
  assert.equal(r.final, 16387.93); assert.equal(r.contributed, 12000); assert.equal(r.interest, 4387.93);
  // combined: 5,000 × 1.005^120 + annuity
  const c = grow({ initial: 5000, monthly: 100, rate: 6, rateType: 'apr', freq: 'monthly', years: 10 });
  near(c.final, 5000 * Math.pow(1.005, 120) + 16387.93, 0.011);
});

test('savings: APR vs APY conversions', () => {
  near(aprToApy(5, 365), 5.12675, 0.00001); // (1 + .05/365)^365 − 1
  near(aprToApy(5, 12), 5.11619, 0.00001);
  near(aprToApy(5, 4), 5.09453, 0.00001);
  near(aprToApy(5, 1), 5, 1e-12);
  near(apyToApr(aprToApy(4.5, 365), 365), 4.5, 1e-9);
  // annually-compounded APR == APY: one year of $1,000 -> $1,050 either way
  near(grow({ initial: 1000, rate: 5, rateType: 'apr', freq: 'annually', years: 1 }).final, 1050, 0.001);
  near(grow({ initial: 1000, rate: 5, rateType: 'apr', freq: 'daily', years: 1 }).final, 1051.27, 0.005);
  near(monthlyFactor({ rate: 12, rateType: 'apr', freq: 'monthly' }), 1.01, 1e-12);
});

test('savings: annual contribution increase', () => {
  // 0%: $100/mo in year 1, $110/mo in year 2 -> 1,200 + 1,320 = 2,520
  const r = grow({ initial: 0, monthly: 100, rate: 0, years: 2, increasePct: 10 });
  assert.equal(r.final, 2520); assert.equal(r.years[1].contributed, 1320); assert.equal(r.interest, 0);
  // year rows add up
  const g = grow({ initial: 2500, monthly: 250, rate: 4.5, years: 15, increasePct: 3 });
  near(g.years.reduce((s, y) => s + y.interest, 0), g.interest, 0.06);
  near(2500 + g.years.reduce((s, y) => s + y.contributed, 0), g.contributed, 0.06);
  near(g.contributed + g.interest, g.final, 0.011);
});

test('savings goal: time to reach a target', () => {
  assert.equal(monthsToGoal({ initial: 0, monthly: 100, rate: 0 }, 1000), 10);
  assert.equal(monthsToGoal({ initial: 5000, monthly: 0, rate: 5 }, 4000), 0);
  // closed form: n = ln(1 + T·r/P) / ln(1 + r) = ln(1.5)/ln(1.005) = 81.3 -> 82 months
  assert.equal(monthsToGoal({ initial: 0, monthly: 100, rate: 6, rateType: 'apr', freq: 'monthly' }, 10000), 82);
  // 5% APY doubles $10,000 in ln 2 / ln 1.05 = 14.2 years -> 171 months
  assert.equal(monthsToGoal({ initial: 10000, monthly: 0, rate: 5 }, 20000), 171);
  assert.equal(monthsToGoal({ initial: 0, monthly: 0, rate: 5 }, 1000), Infinity);
});

test('savings goal: monthly contribution needed', () => {
  // inverse of the annuity test above
  assert.equal(contributionForGoal({ initial: 0, rate: 6, rateType: 'apr', freq: 'monthly' }, 16387.93, 10), 100);
  // already there with the initial deposit alone
  assert.equal(contributionForGoal({ initial: 10000, rate: 5 }, 16000, 10), 0);
  // 0%: $12,000 in 2 years = $500/mo
  assert.equal(contributionForGoal({ initial: 0, rate: 0 }, 12000, 2), 500);
  // round-trip: the answer actually reaches the goal, and a cent less doesn't
  const o = { initial: 3000, rate: 4.25, increasePct: 2 };
  const c = contributionForGoal(o, 50000, 12);
  assert.ok(grow({ ...o, monthly: c, years: 12 }).final >= 50000 - 0.005);
  assert.ok(grow({ ...o, monthly: c - 0.01, years: 12 }).final < 50000);
});
