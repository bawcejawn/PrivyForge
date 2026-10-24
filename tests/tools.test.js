import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, compare } from '../src/js/lib/debt.js';
import { parseCSV, parseAmount, parseDate, detectColumns, toTransactions, findRecurring, normalizeMerchant } from '../src/js/lib/subscriptions.js';
import { refinance, rentVsBuy } from '../src/js/lib/finance.js';
import { schedule } from '../src/js/amortization.js';

const DEBTS = [
  { name: 'Visa', balance: 5000, apr: 24.99, min: 150 },
  { name: 'Car', balance: 12000, apr: 6.9, min: 300 },
  { name: 'Store card', balance: 900, apr: 29.99, min: 35 },
];

test('debt: single loan with exact payment matches amortization schedule', () => {
  const s = schedule(10000, 12, 36);
  const d = simulate([{ name: 'L', balance: 10000, apr: 12, min: s.payment }], s.payment, 'avalanche');
  assert.ok(d.ok); assert.ok(d.months === 36 || d.months === 37, String(d.months)); // final-payment cents may roll one month
  assert.ok(Math.abs(d.totalInterest - s.totalInterest) < 1, `${d.totalInterest} vs ${s.totalInterest}`);
});

test('debt: avalanche never pays more interest than snowball; both beat minimums', () => {
  const c = compare(DEBTS, 800);
  assert.ok(c.avalanche.ok && c.snowball.ok);
  assert.ok(c.avalanche.totalInterest <= c.snowball.totalInterest);
  assert.ok(c.minimum.totalInterest > c.avalanche.totalInterest);
  assert.equal(c.snowball.debts[0].name, 'Store card'); // smallest first
  assert.equal(c.avalanche.debts[0].name, 'Store card'); // highest APR first (29.99%)
});

test('debt: budget below minimums and never-ending debt are reported', () => {
  assert.equal(simulate(DEBTS, 100).ok, false);
  const r = simulate([{ name: 'X', balance: 10000, apr: 30, min: 100 }], 100, 'avalanche');
  assert.equal(r.ok, false);
});

test('csv: quotes, delimiters, amounts, dates', () => {
  assert.deepEqual(parseCSV('a,"b, c","d ""e"""\r\n1,2,3'), [['a', 'b, c', 'd "e"'], ['1', '2', '3']]);
  assert.deepEqual(parseCSV('Datum;Betrag\n01.02.2026;-12,99'), [['Datum', 'Betrag'], ['01.02.2026', '-12,99']]);
  assert.equal(parseAmount('($1,234.56)'), -1234.56);
  assert.equal(parseAmount('-12,99'), -12.99);
  assert.equal(parseAmount('1.234,50'), 1234.5);
  assert.equal(parseDate('2026-03-05'), Date.UTC(2026, 2, 5));
  assert.equal(parseDate('03/05/2026'), Date.UTC(2026, 2, 5));
  assert.equal(parseDate('25/12/2025'), Date.UTC(2025, 11, 25));
  assert.equal(normalizeMerchant('NETFLIX.COM 866-579-7172 CA'), 'NETFLIX');
  assert.equal(normalizeMerchant('SPOTIFY USA #12345'), 'SPOTIFY USA');
});

function bankCSV() {
  const lines = ['Date,Description,Amount'];
  const d = (y, m, day) => `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  for (let m = 1; m <= 6; m++) {
    lines.push(`${d(2026, m, 3)},NETFLIX.COM 866-579-7172 CA,-15.49`);
    lines.push(`${d(2026, m, 12)},SPOTIFY USA #${1000 + m},-11.99`);
    lines.push(`${d(2026, m, 20)},"PLANET FITNESS #2231",-24.99`);
    lines.push(`${d(2026, m, 5 + m)},WHOLE FOODS MARKET,-${(40 + m * 7).toFixed(2)}`);
    lines.push(`${d(2026, m, 15)},PAYROLL DEPOSIT,2500.00`);
  }
  for (let w = 0; w < 20; w++) lines.push(`${new Date(Date.UTC(2026, 0, 2 + w * 7)).toISOString().slice(0, 10)},WEEKLY MEAL KIT,-59.99`);
  lines.push('2025-07-01,AMAZON PRIME*AB12CD,-139.00', '2026-07-01,AMAZON PRIME*ZX98YU,-139.00');
  return lines.join('\n');
}

test('subscriptions: finds monthly, weekly and yearly charges; ignores groceries and income', () => {
  const rows = parseCSV(bankCSV());
  const tx = toTransactions(rows, detectColumns(rows));
  const found = findRecurring(tx);
  const names = found.map((f) => `${f.merchant}|${f.cadence}`);
  for (const want of ['NETFLIX|Monthly', 'SPOTIFY USA|Monthly', 'PLANET FITNESS|Monthly', 'WEEKLY MEAL KIT|Weekly', 'AMAZON PRIME|Yearly']) {
    assert.ok(names.includes(want), `missing ${want}: ${names.join(', ')}`);
  }
  assert.ok(!names.some((n) => n.startsWith('WHOLE FOODS') || n.startsWith('PAYROLL')));
  const netflix = found.find((f) => f.merchant === 'NETFLIX');
  assert.equal(netflix.yearly, 185.88);
  assert.equal(found[0].merchant, 'WEEKLY MEAL KIT'); // sorted by yearly cost
});

test('subscriptions: debit/credit column exports', () => {
  const csv = 'Posted Date,Payee,Debit,Credit\n01/05/2026,HULU,17.99,\n02/05/2026,HULU,17.99,\n03/05/2026,HULU,17.99,\n03/10/2026,REFUND,,5.00';
  const rows = parseCSV(csv);
  const f = findRecurring(toTransactions(rows, detectColumns(rows)));
  assert.equal(f.length, 1); assert.equal(f[0].merchant, 'HULU'); assert.equal(f[0].cadence, 'Monthly');
});

test('refinance: lower rate saves monthly and breaks even; costs delay break-even', () => {
  const r = refinance({ balance: 300000, rate: 7.5, monthsLeft: 336 }, { rate: 6.0, months: 360, costs: 6000 }, 7);
  assert.ok(r.monthly > 250, `monthly ${r.monthly}`);
  assert.ok(r.breakEven > 6 && r.breakEven < 60, `break-even ${r.breakEven}`);
  assert.ok(r.savingsAtStay > 0);
  assert.equal(r.extendsBy, 24);
  const noGain = refinance({ balance: 300000, rate: 6.0, monthsLeft: 336 }, { rate: 6.0, months: 336, costs: 6000 }, 7);
  assert.equal(noGain.breakEven, null);
});

test('rent vs buy: cheap rent favors renting early; buying wins over long horizons with appreciation', () => {
  const base = { price: 400000, downPct: 20, rate: 6.5, term: 30, rent: 2000, years: 30, appreciation: 4, investReturn: 6 };
  const r = rentVsBuy(base);
  assert.equal(r.years.length, 30);
  assert.ok(r.years[0].renterNW > r.years[0].buyerNW, 'renting ahead in year 1 (closing + selling costs)');
  assert.ok(r.breakEvenYear !== null && r.breakEvenYear < 30, `break-even ${r.breakEvenYear}`);
});
