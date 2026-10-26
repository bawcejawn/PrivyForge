// Car loan math (pure, no DOM). Payments come from the cent-accurate amortization engine.
import { schedule } from '../amortization.js';

const C = (d) => Math.round((Number(d) || 0) * 100);
const D = (c) => c / 100;
export const TERMS = [36, 48, 60, 72, 84];

/**
 * What you borrow.
 * equity = trade-in value − amount still owed on it (negative = rolled into the new loan).
 * Sales tax is on (price − trade-in value) when taxAfterTrade, otherwise on the full price.
 * Fees are added untaxed. Down payment and positive equity reduce the loan.
 */
export function amountFinanced({ price = 0, down = 0, tradeIn = 0, owed = 0, taxPct = 0, fees = 0, taxAfterTrade = true }) {
  const equityC = C(tradeIn) - C(owed);
  const taxableC = Math.max(0, taxAfterTrade ? C(price) - C(tradeIn) : C(price));
  const taxC = Math.round(taxableC * (Number(taxPct) || 0) / 100);
  const financedC = Math.max(0, C(price) + taxC + C(fees) - C(down) - equityC);
  return { equity: D(equityC), taxable: D(taxableC), tax: D(taxC), financed: D(financedC) };
}

/** Full car-loan result for one term. */
export function carLoan(input, apr, months) {
  const a = amountFinanced(input);
  const s = schedule(a.financed, apr, months);
  const loanPaidC = s.rows.reduce((t, r) => t + C(r.payment), 0);
  // What the car costs you in total: cash down + positive trade-in equity + every loan payment.
  // (Negative equity is already inside the loan payments.)
  const totalCostC = C(input.down) + Math.max(0, C(a.equity)) + loanPaidC;
  return { ...a, months, payment: s.payment, totalInterest: s.totalInterest, totalOfPayments: D(loanPaidC), totalCost: D(totalCostC), rows: s.rows };
}

/** Same deal across several terms, for the side-by-side comparison. */
export function compareTerms(input, apr, terms = TERMS) {
  return terms.map((m) => { const r = carLoan(input, apr, m); delete r.rows; return r; });
}
