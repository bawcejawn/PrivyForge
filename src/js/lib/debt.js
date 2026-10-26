// Debt payoff simulator: snowball (smallest balance first) vs avalanche (highest APR first).
// Pure functions, cents-rounded each month so results match what lenders actually charge.

const r2 = (n) => Math.round(n * 100) / 100;
const MAX_MONTHS = 600;

/**
 * @param {{name:string,balance:number,apr:number,min:number}[]} debts
 * @param {number} budget  total paid toward all debts each month
 * @param {'avalanche'|'snowball'|'minimum'} strategy
 */
export function simulate(debts, budget, strategy = 'avalanche') {
  const list = debts
    .filter((d) => d.balance > 0)
    .map((d, i) => ({ ...d, i, bal: r2(d.balance), paidOffMonth: null, interest: 0 }));
  const minTotal = r2(list.reduce((s, d) => s + d.min, 0));
  if (strategy === 'minimum') budget = minTotal;
  if (budget < minTotal - 0.005) return { ok: false, reason: `Your budget must cover the minimum payments (${minTotal.toFixed(2)}).`, minTotal };

  const order = () => {
    const open = list.filter((d) => d.bal > 0);
    if (strategy === 'snowball') return open.sort((a, b) => a.bal - b.bal || b.apr - a.apr);
    return open.sort((a, b) => b.apr - a.apr || a.bal - b.bal); // avalanche + minimum
  };

  let month = 0, totalInterest = 0, totalPaid = 0;
  const timeline = []; // total balance at end of each month
  while (list.some((d) => d.bal > 0) && month < MAX_MONTHS) {
    month++;
    // 1) interest accrues
    for (const d of list) {
      if (d.bal <= 0) continue;
      const int = r2(d.bal * d.apr / 100 / 12);
      d.bal = r2(d.bal + int); d.interest = r2(d.interest + int); totalInterest = r2(totalInterest + int);
    }
    // 2) minimums
    let pool = budget;
    for (const d of list) {
      if (d.bal <= 0) continue;
      const pay = Math.min(d.min, d.bal);
      d.bal = r2(d.bal - pay); pool = r2(pool - pay); totalPaid = r2(totalPaid + pay);
    }
    // 3) everything left (incl. freed-up minimums) goes to the target debt(s)
    if (strategy !== 'minimum') {
      for (const d of order()) {
        if (pool <= 0) break;
        const pay = Math.min(pool, d.bal);
        d.bal = r2(d.bal - pay); pool = r2(pool - pay); totalPaid = r2(totalPaid + pay);
      }
    }
    for (const d of list) if (d.bal <= 0 && d.paidOffMonth === null) d.paidOffMonth = month;
    timeline.push(r2(list.reduce((s, d) => s + Math.max(0, d.bal), 0)));
  }
  const done = !list.some((d) => d.bal > 0);
  return {
    ok: done,
    reason: done ? '' : 'At this budget the debt never gets paid off (payments don\'t cover the interest).',
    months: month, totalInterest, totalPaid, minTotal, timeline,
    debts: list.map(({ name, i, paidOffMonth, interest }) => ({ name, i, paidOffMonth, interest }))
      .sort((a, b) => (a.paidOffMonth ?? 1e9) - (b.paidOffMonth ?? 1e9)),
  };
}

export function compare(debts, budget) {
  return {
    avalanche: simulate(debts, budget, 'avalanche'),
    snowball: simulate(debts, budget, 'snowball'),
    minimum: simulate(debts, budget, 'minimum'),
  };
}

// ---------------------------------------------------------------------------
// Single credit card: fixed payment, payoff-by-date, minimum payments, balance transfer.
// Integer cents throughout; monthly interest = balance × APR ÷ 12, rounded half-up to the
// cent (same rule as amortization.js). Real cards charge daily interest on the average
// daily balance, so statements can differ by a few cents a month.

import { monthlyInterestCents, monthlyPayment } from '../amortization.js';

const C = (d) => Math.round((Number(d) || 0) * 100);
const D = (c) => c / 100;
const CARD_MAX = 1200; // 100 years: anything longer is reported as "never"

function cardResult(startC, rows, interestC, extra = {}) {
  return {
    ok: true, months: rows.length, totalInterest: D(interestC), totalPaid: D(startC + interestC + (extra.feeC || 0)),
    timeline: rows, ...extra.out,
  };
}

/**
 * Pay a fixed amount every month until the card is clear.
 * @returns {{ok, reason?, months, totalInterest, totalPaid, timeline:number[] (balance after each month), firstInterest}}
 */
export function cardPayoff(balance, apr, payment) {
  let bal = C(balance); const pay = C(payment);
  const firstInterest = D(monthlyInterestCents(bal, apr));
  if (bal <= 0) return { ok: true, months: 0, totalInterest: 0, totalPaid: 0, timeline: [], firstInterest: 0, payment: D(pay) };
  if (pay <= monthlyInterestCents(bal, apr)) {
    return { ok: false, reason: 'interest', months: Infinity, totalInterest: Infinity, totalPaid: Infinity, timeline: [], firstInterest, payment: D(pay) };
  }
  const start = bal, rows = []; let intC = 0;
  while (bal > 0 && rows.length < CARD_MAX) {
    const i = monthlyInterestCents(bal, apr);
    bal += i; intC += i;
    bal -= Math.min(pay, bal);
    rows.push(D(bal));
  }
  return { ...cardResult(start, rows, intC), firstInterest, payment: D(pay), lastPayment: D(start + intC - pay * (rows.length - 1)) };
}

/** Smallest whole-cent monthly payment that clears the card in `months` (never more months). */
export function paymentForMonths(balance, apr, months) {
  if (!(balance > 0) || !(months > 0)) return 0;
  return monthlyPayment(balance, apr, Math.round(months), 'up');
}

/**
 * Minimum payments only: each month pay max(floor, pct% of the balance + that month's interest),
 * or the whole balance if it's smaller. Issuers' formulas vary; this is the common
 * "1% plus interest, $25 floor" shape.
 */
export function minimumPayoff(balance, apr, { pct = 1, floor = 25 } = {}) {
  let bal = C(balance); const start = bal, floorC = C(floor);
  const rows = [], pays = []; let intC = 0;
  if (bal <= 0) return { ok: true, months: 0, totalInterest: 0, totalPaid: 0, timeline: [], firstPayment: 0 };
  if (floorC <= 0 && !(pct > 0)) return { ok: false, reason: 'interest', months: Infinity, totalInterest: Infinity, totalPaid: Infinity, timeline: [], firstPayment: 0 };
  while (bal > 0 && rows.length < CARD_MAX) {
    const i = monthlyInterestCents(bal, apr);
    const pctC = Math.round(bal * pct / 100); // pct% of the balance before this month's interest
    const due = Math.max(floorC, pctC + i);
    bal += i; intC += i;
    const pay = Math.min(due, bal);
    bal -= pay; pays.push(D(pay)); rows.push(D(bal));
  }
  if (bal > 0) return { ok: false, reason: 'too-long', months: Infinity, totalInterest: Infinity, totalPaid: Infinity, timeline: rows, firstPayment: pays[0] };
  return { ...cardResult(start, rows, intC), firstPayment: pays[0] };
}

/**
 * Move the balance to a promo card: fee% added to the balance on day one, promoApr for
 * promoMonths, then afterApr. Same fixed monthly payment as the comparison.
 * totalCost = fee + all interest.
 */
export function balanceTransfer(balance, payment, { feePct = 3, promoApr = 0, promoMonths = 18, afterApr = 0 } = {}) {
  const feeC = Math.round(C(balance) * feePct / 100);
  let bal = C(balance) + feeC; const start = C(balance), pay = C(payment);
  const rows = []; let intC = 0;
  if (start <= 0) return { ok: true, months: 0, fee: 0, totalInterest: 0, totalCost: 0, totalPaid: 0, timeline: [], promoBalanceLeft: 0 };
  let promoLeftC = null;
  while (bal > 0 && rows.length < CARD_MAX) {
    const m = rows.length + 1;
    const rate = m <= promoMonths ? promoApr : afterApr;
    const i = monthlyInterestCents(bal, rate);
    if (pay <= i) return { ok: false, reason: 'interest', months: Infinity, fee: D(feeC), totalInterest: Infinity, totalCost: Infinity, totalPaid: Infinity, timeline: rows, promoBalanceLeft: promoLeftC === null ? D(bal) : D(promoLeftC) };
    bal += i; intC += i;
    bal -= Math.min(pay, bal);
    rows.push(D(bal));
    if (m === promoMonths) promoLeftC = bal;
  }
  if (bal > 0) return { ok: false, reason: 'too-long', months: Infinity, fee: D(feeC), totalInterest: Infinity, totalCost: Infinity, totalPaid: Infinity, timeline: rows, promoBalanceLeft: D(promoLeftC ?? bal) };
  return {
    ok: true, months: rows.length, fee: D(feeC), totalInterest: D(intC), totalCost: D(feeC + intC),
    totalPaid: D(start + feeC + intC), timeline: rows, promoBalanceLeft: D(promoLeftC ?? 0),
  };
}
