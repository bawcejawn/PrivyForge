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
