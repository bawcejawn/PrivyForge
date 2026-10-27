// Emergency fund planner (pure, no DOM).
// Money is tracked in integer cents. Deposits are made at the END of each month. With an APY,
// each month's interest is balance × ((1 + APY)^(1/12) − 1) — the same monthly factor as the
// compound interest calculator (lib/savings.js) — rounded to the cent, the way a bank posts it.
import { monthlyFactor } from './savings.js';
import { toCents } from './budget.js';

export const MAX_MONTHS = 1200; // 100 years: beyond this we report "not reachable"

/**
 * @param {{expenses, saved, monthly, months, apy}} o  money as anything toCents accepts;
 *   months = target months of expenses; apy = optional % yield.
 * @returns {{target, saved, gap, covered, funded, monthsToGoal, deposits, interest, finalBalance,
 *   rows:{month, deposit, interest, balance, covered}[], series:number[]}}  money in cents;
 *   covered = months of expenses the balance covers (null when expenses are 0).
 */
export function emergencyPlan({ expenses, saved, monthly, months, apy = 0 }) {
  const exp = toCents(expenses), start = toCents(saved), dep = toCents(monthly);
  const m = Math.max(0, parseFloat(String(months ?? '').replace(/[^\d.]/g, '')) || 0);
  const rate = Math.max(0, parseFloat(String(apy ?? '').replace(/[^\d.]/g, '')) || 0);
  const target = Math.round(exp * m);
  const cover = (b) => (exp > 0 ? b / exp : null);
  const gap = Math.max(0, target - start);
  const g = monthlyFactor({ rate, rateType: 'apy' }) - 1;

  const rows = [], series = [start];
  let bal = start, deposits = 0, interest = 0, monthsToGoal = gap === 0 ? 0 : Infinity;
  if (gap > 0 && (dep > 0 || (rate > 0 && start > 0))) {
    for (let k = 1; k <= MAX_MONTHS; k++) {
      const i = Math.round(bal * g);
      bal += i + dep; interest += i; deposits += dep;
      rows.push({ month: k, deposit: dep, interest: i, balance: bal, covered: cover(bal) });
      series.push(bal);
      if (bal >= target) { monthsToGoal = k; break; }
    }
    if (!Number.isFinite(monthsToGoal)) { rows.length = 0; series.length = 1; bal = start; deposits = 0; interest = 0; }
  }
  return {
    target, saved: start, expenses: exp, months: m, apy: rate, monthly: dep, gap,
    covered: cover(start), funded: gap === 0 && target > 0,
    monthsToGoal, deposits, interest, finalBalance: bal, rows, series,
  };
}

/** Months covered, rounded DOWN to one decimal so we never overstate the cushion. */
export const coveredText = (c) => (c == null ? '—' : `${Math.floor(c * 10 + 1e-9) / 10}`);
