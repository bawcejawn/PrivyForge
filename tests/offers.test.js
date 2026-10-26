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
