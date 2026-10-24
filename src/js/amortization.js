// Cent-accurate amortization engine (pure, no DOM).
//
// Matches US lender statements: payment rounded once to cents, each month's interest
// rounded half-up on the rounded balance, final payment adjusted to clear the balance.
// Money is integer cents; interest uses BigInt so half-cent boundaries are exact
// (CFPB H-25(B) month 1 = 523.125 -> 523.13).
// Method & test vectors validated against CFPB, TI BA II Plus, Fannie Mae and textbook
// examples collected by murraystokely/mortgagemath (MIT) — see tests/amortization.test.js.

const toCents = (dollars) => Math.round(dollars * 100);
const fromCents = (c) => c / 100;
const RATE_SCALE = 1_000_000n; // rate stored as micro-percent: 3.875% -> 3_875_000n

function rateMicro(annualPct) { return BigInt(Math.round(annualPct * 1e6)); }

/** round(num/den) half-up for non-negative BigInts */
function divHalfUp(num, den) { return (2n * num + den) / (2n * den); }

/** Monthly interest in cents on a balance in cents (30/360). */
export function monthlyInterestCents(balCents, annualPct) {
  if (balCents <= 0) return 0;
  return Number(divHalfUp(BigInt(balCents) * rateMicro(annualPct), 1200n * RATE_SCALE));
}

/** Fixed payment, rounded once to cents. rounding: 'half-up' (default, CFPB/TI) | 'up' */
export function monthlyPayment(principal, annualPct, months, rounding = 'half-up') {
  if (principal <= 0 || months <= 0) return 0;
  const r = annualPct / 1200;
  const raw = r === 0 ? principal / months : (principal * r) / (1 - Math.pow(1 + r, -months));
  const c = raw * 100;
  // epsilon guards float noise like 76177.99999999 -> 76178
  return (rounding === 'up' ? Math.ceil(c - 1e-6) : Math.round(c + 1e-7)) / 100;
}

/**
 * Full schedule.
 * opts.extra: extra principal every month ($)
 * opts.lumpSums: { [month]: dollars } one-off extra principal (applied with that month's payment)
 * opts.rounding: 'half-up' | 'up'
 * Rows: { n, payment (P+I actually paid this month), principal, interest, extra, balance }
 */
export function schedule(principal, annualPct, months, opts = {}) {
  if (typeof opts === 'number') opts = { extra: opts }; // back-compat: schedule(p, r, n, extra)
  const { extra = 0, lumpSums = {}, rounding = 'half-up' } = opts;
  const pmtC = toCents(monthlyPayment(principal, annualPct, months, rounding));
  const extraC = toCents(extra);
  let bal = toCents(principal);
  const rows = [];
  let totalInterestC = 0, n = 0;
  const zeroRate = annualPct === 0;
  while (bal > 0 && n < months) {
    n++;
    const intC = zeroRate ? 0 : monthlyInterestCents(bal, annualPct);
    let princC = pmtC - intC;
    if (n === months || princC >= bal) princC = bal; // final-payment adjustment
    if (princC < 0) princC = 0; // payment below interest (shouldn't happen for fixed loans)
    let exC = Math.min(extraC + toCents(lumpSums[n] || 0), bal - princC);
    if (exC < 0) exC = 0;
    bal -= princC + exC;
    totalInterestC += intC;
    rows.push({ n, payment: fromCents(princC + intC), principal: fromCents(princC), interest: fromCents(intC), extra: fromCents(exC), balance: fromCents(bal) });
  }
  return { payment: fromCents(pmtC), rows, totalInterest: fromCents(totalInterestC), months: n };
}

/** Roll monthly rows into years (year 1 = first 12 payments). */
export function byYear(rows) {
  const years = [];
  for (const row of rows) {
    const y = Math.ceil(row.n / 12);
    const t = (years[y - 1] ||= { year: y, principal: 0, interest: 0, extra: 0, balance: 0 });
    t.principal += row.principal; t.interest += row.interest; t.extra += row.extra; t.balance = row.balance;
  }
  for (const t of years) { t.principal = Math.round(t.principal * 100) / 100; t.interest = Math.round(t.interest * 100) / 100; t.extra = Math.round(t.extra * 100) / 100; }
  return years;
}

/** Months needed to repay `principal` at `payment`/month (Infinity if payment <= interest). */
export function monthsToPayoff(principal, annualPct, payment) {
  const r = annualPct / 1200;
  if (r === 0) return Math.ceil(principal / payment);
  if (payment <= principal * r) return Infinity;
  return Math.ceil(Math.log(payment / (payment - r * principal)) / Math.log(1 + r));
}

/** Remaining balance after k payments of a fixed-rate loan (cent-accurate via schedule). */
export function balanceAfter(principal, annualPct, months, k) {
  if (k <= 0) return principal;
  const s = schedule(principal, annualPct, months);
  return s.rows[Math.min(k, s.rows.length) - 1]?.balance ?? 0;
}

/**
 * Reg Z-style APR: the monthly IRR (×12) that equates the net amount financed
 * (loan − points − financed fees) with the payment stream. Returns annual %.
 */
export function apr(principal, annualPct, months, pointsPct = 0, fees = 0) {
  const pmt = monthlyPayment(principal, annualPct, months);
  const net = principal - principal * pointsPct / 100 - fees;
  if (net <= 0 || pmt <= 0) return NaN;
  let lo = 0, hi = 1; // monthly rate bounds
  const pv = (i) => (i === 0 ? pmt * months : pmt * (1 - Math.pow(1 + i, -months)) / i);
  for (let k = 0; k < 200; k++) { const mid = (lo + hi) / 2; if (pv(mid) > net) lo = mid; else hi = mid; }
  return ((lo + hi) / 2) * 1200;
}
