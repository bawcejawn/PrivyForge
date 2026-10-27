// Budget (50/30/20) and emergency fund calculators.
// Expected values are hand-worked (shown in comments) or from an independent Python Decimal
// reference (interest rounded half-up to the cent each month) noted as "ref".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budget, toCents, fmtCents, fmtPct, serializeLines, parseLines, SAMPLE_LINES, SAMPLE_INCOME } from '../src/js/lib/budget.js';
import { emergencyPlan, coveredText } from '../src/js/lib/emergency.js';

test('toCents: exact decimal parsing with half-up rounding', () => {
  assert.equal(toCents('1,234.56'), 123456);
  assert.equal(toCents('$5,000'), 500000);
  assert.equal(toCents('1.005'), 101); // float math would give 100
  assert.equal(toCents('0.1'), 10);
  assert.equal(toCents('2.994'), 299);
  assert.equal(toCents('9.995'), 1000);
  assert.equal(toCents('.5'), 50);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents(''), 0);
  assert.equal(toCents('abc'), 0);
  assert.equal(toCents(null), 0);
  assert.equal(toCents('-40'), 4000); // the minus sign is ignored, as in the other calculators
});

test('totals add in cents with no float drift', () => {
  // 0.1 + 0.2 + 0.3 = 0.6 exactly; float sum would be 0.6000000000000001
  const r = budget({ income: '1', lines: [{ group: 'needs', amount: '0.1' }, { group: 'needs', amount: '0.2' }, { group: 'wants', amount: '0.3' }] });
  assert.equal(r.totals.needs, 30); assert.equal(r.totals.wants, 30);
  assert.equal(r.spent, 60); assert.equal(r.leftover, 40);
  // guideline targets round to the cent: 33.33 income × 50% = 16.665 -> 16.67 (1666.5 cents -> 1667)
  const t = budget({ income: '33.33', lines: [] });
  assert.deepEqual(t.groups.map((g) => g.target), [1667, 1000, 667]);
});

test('sample budget: 59 / 12.7 / 12 against 50/30/20 with $815 unassigned', () => {
  const r = budget({ income: SAMPLE_INCOME, lines: SAMPLE_LINES });
  // needs 1600+180+450+220+350+150 = 2950; wants 300+85+250 = 635; savings 400+200 = 600
  assert.deepEqual(r.totals, { needs: 295000, wants: 63500, savings: 60000 });
  assert.equal(r.leftover, 81500); assert.equal(r.status, 'under');
  assert.deepEqual(r.groups.map((g) => g.target), [250000, 150000, 100000]);
  assert.deepEqual(r.groups.map((g) => g.diff), [45000, -86500, -40000]);
  assert.equal(r.notes[0], "Needs are 59% of take-home; the guideline is 50%. That's $450 a month over.");
  assert.equal(r.notes[1], "Wants are 12.7% of take-home; the guideline is 30%. That's $865 a month under.");
  assert.equal(r.notes[2], "Savings & debt are 12% of take-home; the guideline is 20%. That's $400 a month under.");
  assert.match(r.notes[3], /^\$815 a month isn't assigned.*Savings & debt 28.3% of take-home\.$/);
});

test('zero income: no percentages, a prompt instead of a division by zero', () => {
  const r = budget({ income: '', lines: SAMPLE_LINES });
  assert.equal(r.status, 'no-income');
  assert.ok(r.groups.every((g) => g.pct === null && g.target === 0));
  assert.equal(r.leftover, -r.spent);
  assert.match(r.notes[0], /Enter your monthly take-home pay/);
  assert.ok(r.notes.every((n) => !/NaN|Infinity/.test(n)));
});

test('overspending is reported with the exact shortfall', () => {
  const r = budget({ income: '3000', lines: [{ group: 'needs', amount: '2500.50' }, { group: 'wants', amount: '700' }] });
  assert.equal(r.leftover, -20050); assert.equal(r.status, 'over');
  assert.equal(r.notes.at(-1), "You're spending $200.50 a month more than you take home.");
  const even = budget({ income: '100', lines: [{ group: 'savings', amount: '100' }] });
  assert.equal(even.status, 'balanced'); assert.equal(even.notes.at(-1), 'Every dollar of take-home pay is assigned.');
});

test('custom ratios: 70/20/10 targets, and a warning when they do not add to 100', () => {
  const r = budget({ income: '4000', lines: [{ group: 'needs', amount: '2800' }], ratios: { needs: 70, wants: 20, savings: 10 } });
  assert.deepEqual(r.groups.map((g) => g.target), [280000, 80000, 40000]);
  assert.equal(r.groups[0].diff, 0);
  assert.equal(r.notes[0], 'Needs are 70% of take-home; the guideline is 70%.');
  assert.ok(!r.notes.some((n) => /add up to/.test(n)));
  const odd = budget({ income: '4000', lines: [], ratios: { needs: 60, wants: 20, savings: 12.5 } });
  assert.equal(odd.ratioSum, 92.5);
  assert.equal(odd.notes.at(-1), 'Your guideline percentages add up to 92.5%, not 100%.');
  assert.equal(odd.groups[2].target, 50000);
});

test('formatting helpers', () => {
  assert.equal(fmtCents(123456), '$1,234.56'); assert.equal(fmtCents(500000), '$5,000');
  assert.equal(fmtCents(-20050), '-$200.50'); assert.equal(fmtPct(12.66666), '12.7%'); assert.equal(fmtPct(62), '62%');
});

test('lines survive a URL round trip, including ~ | % and markup in names', () => {
  const lines = [
    { group: 'needs', name: 'Rent ~ flat | 2', amount: '1600' },
    { group: 'wants', name: '100% <b>fun</b> & co', amount: '12.34' },
    { group: 'savings', name: '', amount: '' },
  ];
  const s = serializeLines(lines);
  assert.ok(!/[<> ]/.test(s));
  assert.deepEqual(parseLines(new URLSearchParams(new URLSearchParams({ l: s }).toString()).get('l')), lines);
  assert.deepEqual(parseLines(''), []);
  assert.deepEqual(parseLines('x~bad~1|n~%E0%A4%A~5'), [{ group: 'needs', name: '%E0%A4%A', amount: '5' }]); // bad group dropped, bad escape kept raw
});

test('emergency: $3,000 × 6 months, $4,000 saved, $400/month, no interest', () => {
  const r = emergencyPlan({ expenses: '3000', saved: '4000', monthly: '400', months: 6 });
  assert.equal(r.target, 1800000); assert.equal(r.gap, 1400000);
  assert.equal(coveredText(r.covered), '1.3');
  assert.equal(r.monthsToGoal, 35); // 14,000 / 400 = 35
  assert.equal(r.finalBalance, 1800000); assert.equal(r.interest, 0); assert.equal(r.deposits, 1400000);
  assert.equal(r.rows.length, 35); assert.equal(r.series.length, 36);
  assert.equal(r.rows[0].balance, 440000); assert.equal(coveredText(r.rows[1].covered), '1.6');
});

test('emergency: uneven gap rounds the month up', () => {
  // gap 1,000.01 at $250/mo -> 4.00004 -> 5 months
  assert.equal(emergencyPlan({ expenses: '1000', saved: '1999.99', monthly: '250', months: 3 }).monthsToGoal, 5);
});

test('emergency: with 4% APY interest shortens the wait (ref)', () => {
  const r = emergencyPlan({ expenses: '3000', saved: '4000', monthly: '400', months: 6, apy: '4' });
  // ref: 33 months, balance $18,370.95, interest $1,170.95
  assert.equal(r.monthsToGoal, 33); assert.equal(r.finalBalance, 1837095); assert.equal(r.interest, 117095);
  assert.equal(r.deposits, 1320000);
  // first month: 4000 × (1.04^(1/12) − 1) = 13.0942… -> $13.09
  assert.equal(r.rows[0].interest, 1309);
});

test('emergency: already funded, zero expenses, and unreachable goals', () => {
  const done = emergencyPlan({ expenses: '2000', saved: '15000', monthly: '0', months: 6 });
  assert.equal(done.gap, 0); assert.equal(done.funded, true); assert.equal(done.monthsToGoal, 0); assert.equal(coveredText(done.covered), '7.5');
  const none = emergencyPlan({ expenses: '', saved: '500', monthly: '100', months: 6 });
  assert.equal(none.target, 0); assert.equal(none.covered, null); assert.equal(none.funded, false); assert.equal(coveredText(none.covered), '—');
  const never = emergencyPlan({ expenses: '3000', saved: '1000', monthly: '0', months: 3 });
  assert.equal(never.monthsToGoal, Infinity); assert.equal(never.rows.length, 0);
  // interest alone on $1,000 at 5% takes ~43 years to reach $8,000 — reachable within 100 years
  const slow = emergencyPlan({ expenses: '2000', saved: '1000', monthly: '0', months: 4, apy: 5 });
  assert.ok(slow.monthsToGoal > 400 && slow.monthsToGoal < 600, String(slow.monthsToGoal));
  // custom months like 4.5 work
  assert.equal(emergencyPlan({ expenses: '2000', saved: 0, monthly: 0, months: '4.5' }).target, 900000);
});
