import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickOffer } from '../src/js/lib/offers.js';

const ALL = Object.fromEntries(['REFI', 'BALANCE_TRANSFER', 'DEBT_CONSOLIDATION', 'BILL_NEGOTIATION', 'HIGH_YIELD_SAVINGS']
  .map((k) => [k, { url: `https://partner.example/${k}` }]));

test('nothing shows when affiliate URLs are empty or unsafe', () => {
  const empty = { REFI: { url: '' }, BALANCE_TRANSFER: { url: 'javascript:alert(1)' } };
  assert.equal(pickOffer('refinance', { breakEven: 20, stay: 84, savingsAtStay: 5000 }, empty), null);
  assert.equal(pickOffer('debt', { ok: true, debts: [{ apr: 25 }] }, empty), null);
  assert.equal(pickOffer('subscriptions', { found: [{}], saving: 0 }, {}), null);
});

test('refinance: only when it pays off within the stay', () => {
  assert.equal(pickOffer('refinance', { breakEven: 20, stay: 84, savingsAtStay: 5000 }, ALL).key, 'REFI');
  assert.equal(pickOffer('refinance', { breakEven: null, stay: 84, savingsAtStay: 0 }, ALL), null);
  assert.equal(pickOffer('refinance', { breakEven: 100, stay: 84, savingsAtStay: -10 }, ALL), null);
});

test('debt: balance transfer for high APR, consolidation for several lower-rate debts', () => {
  assert.equal(pickOffer('debt', { ok: true, debts: [{ apr: 24.99 }, { apr: 7 }] }, ALL).key, 'BALANCE_TRANSFER');
  assert.equal(pickOffer('debt', { ok: true, debts: [{ apr: 9 }, { apr: 7 }] }, ALL).key, 'DEBT_CONSOLIDATION');
  assert.equal(pickOffer('debt', { ok: true, debts: [{ apr: 9 }] }, ALL), null);
  assert.equal(pickOffer('debt', { ok: false, debts: [{ apr: 30 }] }, ALL), null);
  // falls back to consolidation if no balance-transfer partner is configured
  assert.equal(pickOffer('debt', { ok: true, debts: [{ apr: 24 }] }, { DEBT_CONSOLIDATION: ALL.DEBT_CONSOLIDATION }).key, 'DEBT_CONSOLIDATION');
});

test('subscriptions: savings offer once something is marked to cancel', () => {
  assert.equal(pickOffer('subscriptions', { found: [], saving: 0 }, ALL), null);
  assert.equal(pickOffer('subscriptions', { found: [{}, {}], saving: 0 }, ALL).key, 'BILL_NEGOTIATION');
  const o = pickOffer('subscriptions', { found: [{}], saving: 215.88 }, ALL);
  assert.equal(o.key, 'HIGH_YIELD_SAVINGS'); assert.match(o.title, /\$216/);
});

test('card: balance transfer only for a real, high-rate result', () => {
  assert.equal(pickOffer('card', null, ALL), null);
  assert.equal(pickOffer('card', { balance: 0, apr: 25, ok: true, totalInterest: 0 }, ALL), null);
  assert.equal(pickOffer('card', { balance: 5000, apr: 9.9, ok: true, totalInterest: 400 }, ALL), null);
  const o = pickOffer('card', { balance: 5000, apr: 22.99, ok: true, totalInterest: 1871.1 }, ALL);
  assert.equal(o.key, 'BALANCE_TRANSFER'); assert.match(o.title, /23%/); assert.match(o.body, /\$1,871/);
  // payment doesn't cover interest: still relevant, no fake interest figure
  const n = pickOffer('card', { balance: 5000, apr: 29.99, ok: false, totalInterest: Infinity }, ALL);
  assert.equal(n.key, 'BALANCE_TRANSFER'); assert.doesNotMatch(n.body, /Infinity|\$∞/);
  assert.equal(pickOffer('card', { balance: 5000, apr: 25, ok: true, totalInterest: 1 }, { DEBT_CONSOLIDATION: ALL.DEBT_CONSOLIDATION }).key, 'DEBT_CONSOLIDATION');
  assert.equal(pickOffer('card', { balance: 5000, apr: 25, ok: true, totalInterest: 1 }, {}), null);
});

test('savings: high-yield savings once a balance is projected', () => {
  assert.equal(pickOffer('savings', { final: 0 }, ALL), null);
  assert.equal(pickOffer('savings', {}, ALL), null);
  const o = pickOffer('savings', { final: 16288.95 }, ALL);
  assert.equal(o.key, 'HIGH_YIELD_SAVINGS'); assert.match(o.title, /\$16,289/);
  assert.equal(pickOffer('savings', { final: 16288.95 }, { HIGH_YIELD_SAVINGS: { url: '' } }), null);
});

test('car: auto-loan offer only with a financed amount and rate', () => {
  const A = { AUTO_LOAN: { url: 'https://partner.example/auto' } };
  assert.equal(pickOffer('car', { financed: 0, apr: 7, totalInterest: 0 }, A), null);
  assert.equal(pickOffer('car', { financed: 20000, apr: 0, totalInterest: 0 }, A), null);
  const o = pickOffer('car', { financed: 25000, apr: 6.9, totalInterest: 4630.2 }, A);
  assert.equal(o.key, 'AUTO_LOAN'); assert.match(o.body, /\$4,630/);
  assert.equal(pickOffer('car', { financed: 25000, apr: 6.9, totalInterest: 4630.2 }, {}), null);
});

test('emergency: high-yield savings when there is a gap or money already saved', () => {
  assert.equal(pickOffer('emergency', { target: 0, saved: 0, gap: 0 }, ALL), null);
  assert.equal(pickOffer('emergency', null, ALL), null);
  const g = pickOffer('emergency', { target: 18000, saved: 4000, gap: 14000 }, ALL);
  assert.equal(g.key, 'HIGH_YIELD_SAVINGS'); assert.match(g.title, /\$18,000 cushion/);
  const f = pickOffer('emergency', { target: 12000, saved: 15000, gap: 0 }, ALL);
  assert.equal(f.key, 'HIGH_YIELD_SAVINGS'); assert.match(f.title, /\$15,000 emergency fund/);
  assert.equal(pickOffer('emergency', { target: 18000, saved: 4000, gap: 14000 }, {}), null);
});

test('budget: bill-cutting when overspent, savings when money is saved or left over', () => {
  assert.equal(pickOffer('budget', { income: 0, leftover: -500, savings: 0 }, ALL), null);
  const over = pickOffer('budget', { income: 3000, leftover: -200.5, savings: 100 }, ALL);
  assert.equal(over.key, 'BILL_NEGOTIATION'); assert.match(over.title, /\$201 a month over/);
  const s = pickOffer('budget', { income: 5000, leftover: 815, savings: 600 }, ALL);
  assert.equal(s.key, 'HIGH_YIELD_SAVINGS'); assert.match(s.title, /\$1,415 a month/);
  assert.equal(pickOffer('budget', { income: 5000, leftover: 0, savings: 0 }, ALL), null);
  assert.equal(pickOffer('budget', { income: 3000, leftover: -10, savings: 0 }, { HIGH_YIELD_SAVINGS: ALL.HIGH_YIELD_SAVINGS }), null);
});
