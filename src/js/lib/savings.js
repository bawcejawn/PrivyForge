// Compound interest / savings growth (pure, no DOM).
// Deposits are made at the END of each month. Interest compounds at the account's
// effective rate: an APY is used as-is; an APR compounded n times a year becomes
// APY = (1 + APR/n)^n − 1. Each month the balance grows by (1 + APY)^(1/12).
// Results are rounded to cents for display; the running balance is not rounded,
// so results can differ from a bank statement by a few cents.

export const FREQ = { daily: 365, monthly: 12, quarterly: 4, annually: 1 };

/** Effective annual yield (%) from an APR (%) compounded `n` times a year. */
export function aprToApy(aprPct, n) {
  if (!n) return aprPct;
  return (Math.pow(1 + aprPct / 100 / n, n) - 1) * 100;
}

/** APR (%) compounded n times a year that gives this APY (%). */
export function apyToApr(apyPct, n) {
  return (Math.pow(1 + apyPct / 100, 1 / n) - 1) * n * 100;
}

/** Monthly growth factor for {rate, rateType:'apy'|'apr', freq}. */
export function monthlyFactor({ rate = 0, rateType = 'apy', freq = 'monthly' }) {
  const apy = rateType === 'apr' ? aprToApy(rate, FREQ[freq] || 12) : rate;
  return Math.pow(1 + apy / 100, 1 / 12);
}

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Grow savings month by month.
 * @param o {initial, monthly, rate, rateType, freq, years, increasePct}
 *   increasePct: the monthly contribution rises by this % at the start of each new year.
 * @returns {{final, contributed, interest, years:[{year, contributed, interest, balance, totalContributed, totalInterest}], series:{balance:number[], contributed:number[]}}}
 */
export function grow(o) {
  const g = monthlyFactor(o);
  const months = Math.max(0, Math.round((Number(o.years) || 0) * 12));
  let bal = Number(o.initial) || 0, contributed = bal, interest = 0;
  const years = [], sBal = [bal], sCon = [contributed];
  let y = null;
  for (let m = 1; m <= months; m++) {
    const yearIdx = Math.ceil(m / 12);
    const dep = (Number(o.monthly) || 0) * Math.pow(1 + (Number(o.increasePct) || 0) / 100, yearIdx - 1);
    const int = bal * (g - 1);
    bal += int + dep; interest += int; contributed += dep;
    if (!y || y.year !== yearIdx) { y = { year: yearIdx, contributed: 0, interest: 0 }; years.push(y); }
    y.contributed += dep; y.interest += int; y.balance = bal; y.totalContributed = contributed; y.totalInterest = interest;
    sBal.push(bal); sCon.push(contributed);
  }
  for (const t of years) for (const k of ['contributed', 'interest', 'balance', 'totalContributed', 'totalInterest']) t[k] = r2(t[k]);
  return { final: r2(bal), contributed: r2(contributed), interest: r2(interest), months, years, series: { balance: sBal, contributed: sCon } };
}

/** Months until the balance first reaches `target` (Infinity if not within 100 years). */
export function monthsToGoal(o, target) {
  const g = monthlyFactor(o);
  let bal = Number(o.initial) || 0;
  if (bal >= target) return 0;
  for (let m = 1; m <= 1200; m++) {
    const dep = (Number(o.monthly) || 0) * Math.pow(1 + (Number(o.increasePct) || 0) / 100, Math.ceil(m / 12) - 1);
    bal += bal * (g - 1) + dep;
    if (bal >= target - 0.005) return m;
  }
  return Infinity;
}

/**
 * Monthly contribution (first year's amount, rising by increasePct each year) needed to
 * reach `target` after `years`. The future value is linear in that contribution, so:
 * c = (target − FV of the initial deposit alone) / FV of $1/month. Rounded UP to the cent.
 * Returns 0 if the initial deposit alone gets there.
 */
export function contributionForGoal(o, target, years) {
  const base = grow({ ...o, monthly: 0, years }).series.balance.at(-1);
  if (base >= target) return 0;
  const per1 = grow({ ...o, initial: 0, monthly: 1, years }).series.balance.at(-1);
  if (!(per1 > 0)) return Infinity;
  return Math.ceil(((target - base) / per1) * 100 - 1e-6) / 100;
}
