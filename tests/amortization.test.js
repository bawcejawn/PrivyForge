// Test vectors are published examples (sources noted), compiled by murraystokely/mortgagemath (MIT).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyPayment, schedule, byYear, monthlyInterestCents, monthsToPayoff, apr } from '../src/js/amortization.js';

const eq = (a, b, msg) => assert.equal(Math.round(a * 100), Math.round(b * 100), `${msg ?? ''} ${a} != ${b}`);

test('CFPB H-25(B): $162,000 @ 3.875% / 360 = $761.78, month-1 interest 523.13 (half-cent boundary)', () => {
  eq(monthlyPayment(162000, 3.875, 360), 761.78);
  eq(monthlyInterestCents(16200000, 3.875) / 100, 523.13);
  eq(schedule(162000, 3.875, 360).rows[0].interest, 523.13);
});

test('TI BA II Plus: $120,000 @ 6.125% / 360 = $729.13 + interval checks', () => {
  const s = schedule(120000, 6.125, 360);
  eq(s.payment, 729.13);
  const sum = (a, b, k) => s.rows.slice(a - 1, b).reduce((t, r) => t + r[k], 0);
  eq(s.rows[8].balance, 118928.63, 'bal after 9');
  eq(sum(1, 9, 'principal'), 1071.37); eq(sum(1, 9, 'interest'), 5490.80);
  eq(s.rows[20].balance, 117421.60, 'bal after 21');
  eq(sum(10, 21, 'principal'), 1507.03); eq(sum(10, 21, 'interest'), 7242.53);
  eq(s.rows[32].balance, 115819.62, 'bal after 33');
  eq(sum(22, 33, 'interest'), 7147.58);
});

test('Full 36-row schedule: $150,000 @ 10% / 36 = $4,840.08, final payment 4,839.99', () => {
  const s = schedule(150000, 10, 36);
  eq(s.payment, 4840.08);
  assert.deepEqual([s.rows[0].interest, s.rows[0].principal, s.rows[0].balance], [1250, 3590.08, 146409.92]);
  eq(s.rows[34].balance, 4799.99, 'row 35');
  eq(s.rows[35].payment, 4839.99, 'final payment'); eq(s.rows[35].interest, 40.0); eq(s.rows[35].balance, 0);
  assert.equal(s.rows.length, 36);
});

test('Published payments', () => {
  eq(monthlyPayment(200000, 6.5, 360), 1264.14, 'Wikipedia');
  eq(monthlyPayment(100000, 7, 360), 665.30, 'Mississippi State Ext.');
  eq(monthlyPayment(400000, 6.25, 360), 2462.87);
  eq(monthlyPayment(10000, 10, 1), 10083.33);
  eq(monthlyPayment(320000, 6.5, 360), 2022.62);
  eq(monthlyPayment(25000, 7.9, 60), 505.71);
});

test('Spreadsheet example: $160,000 @ 5% / 360 = $858.91 (sheet carries full precision, so totals differ by ~$2)', () => {
  const s = schedule(160000, 5, 360);
  eq(s.payment, 858.91); eq(s.rows[0].interest, 666.67); eq(s.rows[0].balance, 159807.76);
  assert.ok(Math.abs(s.totalInterest - 149209.25) < 5);
});

test('Zero-interest promo: $999 / 24 -> 41.63, final payment 41.51', () => {
  const s = schedule(999, 0, 24);
  eq(s.payment, 41.63); eq(s.rows[0].balance, 957.37); eq(s.rows[22].balance, 41.51); eq(s.rows[23].payment, 41.51);
});

test('Round-up convention (OpenStax / jbmohler): $150,000 @ 4% / 180 = 1,109.54', () => {
  const s = schedule(150000, 4, 180, { rounding: 'up' });
  eq(s.payment, 1109.54);
  eq(s.rows[0].principal, 609.54); eq(s.rows[0].interest, 500);
  eq(s.rows.slice(0, 12).reduce((t, r) => t + r.principal, 0), 7450.10, 'first-year principal');
  eq(monthlyPayment(350000, 3.75, 360, 'up'), 1620.91);
});

test('Invariants: principal + interest = payment every row; principal sums to the loan', () => {
  const s = schedule(287345.67, 6.875, 360);
  for (const r of s.rows) eq(r.principal + r.interest, r.payment);
  eq(s.rows.reduce((t, r) => t + r.principal, 0), 287345.67);
  eq(s.rows.at(-1).balance, 0);
});

test('Extra payments shorten the loan, cut interest, and never overpay', () => {
  const base = schedule(300000, 6, 360), plan = schedule(300000, 6, 360, { extra: 300 });
  assert.ok(plan.months < base.months && plan.totalInterest < base.totalInterest);
  eq(plan.rows.at(-1).balance, 0);
  const lump = schedule(100000, 5, 360, { lumpSums: { 12: 10000 } });
  eq(lump.rows[11].extra, 10000);
});

test('Helpers', () => {
  assert.equal(byYear(schedule(100000, 4, 180).rows).length, 15);
  assert.equal(monthsToPayoff(150000, 10, 4840.08), 36);
  assert.equal(monthsToPayoff(100000, 12, 900), Infinity);
  const a = apr(300000, 6.5, 360, 1, 3000); // 1 point + $3k fees -> APR above note rate
  assert.ok(a > 6.5 && a < 6.8, `APR ${a}`);
  assert.ok(Math.abs(apr(300000, 6.5, 360) - 6.5) < 0.001);
});
