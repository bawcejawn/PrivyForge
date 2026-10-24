// Refinance break-even and rent-vs-buy engines (pure, no DOM).
import { schedule, monthlyPayment } from '../amortization.js';

/**
 * Refinance analysis.
 * cur: { balance, rate, monthsLeft }   new: { rate, months, costs, pointsPct, rollCosts }
 * stayYears: how long the owner expects to keep the loan.
 */
export function refinance(cur, nw, stayYears = 7) {
  const points = cur.balance * (nw.pointsPct || 0) / 100;
  const upfront = (nw.costs || 0) + points;
  const newPrincipal = cur.balance + (nw.rollCosts ? upfront : 0);
  const cashToClose = nw.rollCosts ? 0 : upfront;

  const oldS = schedule(cur.balance, cur.rate, cur.monthsLeft);
  const newS = schedule(newPrincipal, nw.rate, nw.months);
  const oldPmt = oldS.payment, newPmt = newS.payment;
  const monthly = Math.round((oldPmt - newPmt) * 100) / 100;

  // Break-even: first month where cumulative savings exceed cash paid at closing (or,
  // when costs are rolled in, where the new loan's balance+paid falls below the old path).
  // We use the standard "total cost to date" comparison which handles both cases.
  const horizon = Math.max(oldS.months, newS.months);
  let oldCost = 0, newCost = cashToClose, breakEven = null;
  const costOld = [], costNew = [];
  for (let m = 1; m <= horizon; m++) {
    const o = oldS.rows[m - 1], n = newS.rows[m - 1];
    oldCost += o ? o.payment : 0;
    newCost += n ? n.payment : 0;
    // Wealth view: what you've paid PLUS what you still owe.
    const oBal = o ? o.balance : 0, nBal = n ? n.balance : 0;
    costOld.push(oldCost + oBal); costNew.push(newCost + nBal);
    if (breakEven === null && newCost + nBal < oldCost + oBal) breakEven = m;
  }
  const stay = Math.round(stayYears * 12);
  const at = (arr, m) => arr[Math.min(m, arr.length) - 1];
  const savingsAtStay = Math.round((at(costOld, stay) - at(costNew, stay)) * 100) / 100;

  return {
    oldPmt, newPmt, monthly, upfront, cashToClose, newPrincipal,
    oldInterest: oldS.totalInterest, newInterest: newS.totalInterest,
    lifetime: Math.round(((oldS.totalInterest) - (newS.totalInterest + upfront)) * 100) / 100,
    breakEven, savingsAtStay, stay,
    extendsBy: newS.months - oldS.months,
    series: { old: costOld, new: costNew },
  };
}

/**
 * Rent vs buy, monthly simulation. Whichever side has lower monthly cost invests the
 * difference at `investReturn`; the renter also invests the down payment + closing costs.
 * Returns net worth for both paths by year and the first year buying comes out ahead.
 */
export function rentVsBuy(p) {
  const years = p.years || 10, months = years * 12;
  const down = p.price * p.downPct / 100;
  const loan = p.price - down;
  const s = schedule(loan, p.rate, p.term * 12);
  const buyClosing = p.price * (p.buyClosingPct ?? 3) / 100;
  const mInv = Math.pow(1 + (p.investReturn ?? 6) / 100, 1 / 12) - 1;
  const mApp = Math.pow(1 + (p.appreciation ?? 3) / 100, 1 / 12) - 1;
  const rentGrowth = (p.rentGrowth ?? 3) / 100;

  let home = p.price, rent = p.rent;
  let buyerInv = 0, renterInv = down + buyClosing;
  const out = [];
  let breakEvenYear = null;
  for (let m = 1; m <= months; m++) {
    if (m > 1 && (m - 1) % 12 === 0) rent *= 1 + rentGrowth;
    const row = s.rows[m - 1];
    const pi = row ? row.payment : 0;
    const ownCost = pi + (home * (p.taxPct ?? 1.1) / 100 + (p.insurance ?? 1500) + home * (p.maintPct ?? 1) / 100) / 12 + (p.hoa ?? 0);
    const rentCost = rent + (p.rentersIns ?? 15);
    buyerInv *= 1 + mInv; renterInv *= 1 + mInv;
    if (ownCost > rentCost) renterInv += ownCost - rentCost; else buyerInv += rentCost - ownCost;
    home *= 1 + mApp;
    if (m % 12 === 0) {
      const bal = row ? row.balance : 0;
      const buyerNW = home - bal - home * (p.sellPct ?? 6) / 100 + buyerInv;
      const renterNW = renterInv;
      out.push({ year: m / 12, buyerNW: Math.round(buyerNW), renterNW: Math.round(renterNW), ownCost: Math.round(ownCost), rentCost: Math.round(rentCost) });
      if (breakEvenYear === null && buyerNW > renterNW) breakEvenYear = m / 12;
    }
  }
  return { years: out, breakEvenYear, payment: s.payment, firstMonthOwn: out[0]?.ownCost, firstMonthRent: Math.round(p.rent + (p.rentersIns ?? 15)) };
}

export { monthlyPayment };
