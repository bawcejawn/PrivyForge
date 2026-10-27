// 50/30/20-style budget (pure, no DOM).
// All arithmetic is done in integer cents so totals never drift (0.1 + 0.2 problems).
// Percentages are shares of monthly take-home pay.

export const GROUPS = ['needs', 'wants', 'savings'];
export const LABELS = { needs: 'Needs', wants: 'Wants', savings: 'Savings & debt' };
export const PRESETS = { '50/30/20': [50, 30, 20], '60/20/20': [60, 20, 20], '70/20/10': [70, 20, 10] };

/** Clearly a sample: shown prefilled so the page isn't empty; the user edits or removes it. */
export const SAMPLE_INCOME = 5000;
export const SAMPLE_LINES = [
  { group: 'needs', name: 'Rent', amount: 1600 },
  { group: 'needs', name: 'Utilities', amount: 180 },
  { group: 'needs', name: 'Groceries', amount: 450 },
  { group: 'needs', name: 'Insurance', amount: 220 },
  { group: 'needs', name: 'Transport', amount: 350 },
  { group: 'needs', name: 'Minimum debt payments', amount: 150 },
  { group: 'wants', name: 'Dining out', amount: 300 },
  { group: 'wants', name: 'Subscriptions', amount: 85 },
  { group: 'wants', name: 'Shopping', amount: 250 },
  { group: 'savings', name: 'Savings', amount: 400 },
  { group: 'savings', name: 'Extra debt payments', amount: 200 },
];

/**
 * Parse a money amount typed by a person into whole cents, rounding half up on the third
 * decimal. Works on the decimal string, so "1.005" is 101 cents (float math would give 100).
 * Anything that isn't a positive number is 0.
 */
export function toCents(v) {
  if (typeof v === 'number') v = Number.isFinite(v) ? String(v) : '';
  const s = String(v ?? '').replace(/[^\d.]/g, '');
  const m = s.match(/^(\d*)(?:\.(\d*))?/);
  if (!m || (!m[1] && !m[2])) return 0;
  const whole = parseInt(m[1] || '0', 10);
  const frac = (m[2] || '').replace(/\./g, '');
  const cents = parseInt((frac + '00').slice(0, 2), 10);
  const up = (frac[2] || '0') >= '5' ? 1 : 0;
  return whole * 100 + cents + up;
}

/** Percentage (number) that may be a decimal like 12.5; anything invalid or negative is 0. */
export const toPct = (v) => Math.max(0, parseFloat(String(v ?? '').replace(/[^\d.]/g, '')) || 0);

/** "$1,234" for whole dollars, "$1,234.56" otherwise. Locale-fixed so notes are deterministic. */
export function fmtCents(c) {
  const neg = c < 0, a = Math.abs(c);
  const s = (a / 100).toLocaleString('en-US', { minimumFractionDigits: a % 100 ? 2 : 0, maximumFractionDigits: 2 });
  return `${neg ? '-' : ''}$${s}`;
}
/** 62 -> "62%", 12.666 -> "12.7%". */
export const fmtPct = (p) => `${Math.round(p * 10) / 10}%`;

/**
 * @param {{income, lines:{group,name,amount}[], ratios?:{needs,wants,savings}}} o
 *   amounts are anything toCents accepts; ratios are percentages of take-home.
 * @returns everything in cents plus plain-language notes.
 */
export function budget({ income, lines = [], ratios = { needs: 50, wants: 30, savings: 20 } }) {
  const incomeCents = toCents(income);
  const r = Object.fromEntries(GROUPS.map((g) => [g, toPct(ratios?.[g])]));
  const ratioSum = Math.round((r.needs + r.wants + r.savings) * 1000) / 1000;
  const totals = { needs: 0, wants: 0, savings: 0 };
  for (const l of lines) if (GROUPS.includes(l.group)) totals[l.group] += toCents(l.amount);
  const spent = totals.needs + totals.wants + totals.savings;
  const leftover = incomeCents - spent;
  const hasIncome = incomeCents > 0;

  const groups = GROUPS.map((g) => {
    const target = Math.round(incomeCents * r[g] / 100);
    return {
      key: g, label: LABELS[g], actual: totals[g], target, diff: totals[g] - target,
      pct: hasIncome ? totals[g] / incomeCents * 100 : null, guidePct: r[g],
    };
  });

  const notes = [];
  if (!hasIncome) {
    notes.push('Enter your monthly take-home pay to compare your spending with the guideline.');
  } else {
    for (const g of groups) {
      let s = `${g.label} are ${fmtPct(g.pct)} of take-home; the guideline is ${fmtPct(g.guidePct)}.`;
      if (g.diff > 0) s += ` That's ${fmtCents(g.diff)} a month over.`;
      else if (g.diff < 0) s += ` That's ${fmtCents(-g.diff)} a month under.`;
      notes.push(s);
    }
    if (leftover > 0) {
      const withLeft = (totals.savings + leftover) / incomeCents * 100;
      notes.push(`${fmtCents(leftover)} a month isn't assigned to anything. Putting it toward savings or extra debt payments would make Savings & debt ${fmtPct(withLeft)} of take-home.`);
    } else if (leftover < 0) {
      notes.push(`You're spending ${fmtCents(-leftover)} a month more than you take home.`);
    } else {
      notes.push('Every dollar of take-home pay is assigned.');
    }
  }
  if (ratioSum !== 100) notes.push(`Your guideline percentages add up to ${fmtPct(ratioSum)}, not 100%.`);

  const status = !hasIncome ? 'no-income' : leftover < 0 ? 'over' : leftover > 0 ? 'under' : 'balanced';
  return { income: incomeCents, totals, spent, leftover, groups, ratioSum, status, notes };
}

// ---- URL encoding of expense lines: "n~Rent~1600|w~Dining%20out~300". Names are
// percent-encoded (including ~ and |) so any text survives the round trip.
const G2 = { needs: 'n', wants: 'w', savings: 's' }, FROM = { n: 'needs', w: 'wants', s: 'savings' };
const encName = (s) => encodeURIComponent(s).replace(/~/g, '%7E');

export function serializeLines(lines) {
  return lines.map((l) => [G2[l.group], encName(l.name || ''), String(l.amount ?? '').replace(/[^\d.]/g, '')].join('~')).join('|');
}

export function parseLines(str) {
  if (!str) return [];
  return String(str).split('|').map((part) => {
    const [g, name = '', amount = ''] = part.split('~');
    let n = name;
    try { n = decodeURIComponent(name); } catch { /* keep raw */ }
    return FROM[g] ? { group: FROM[g], name: n.slice(0, 80), amount: amount.replace(/[^\d.]/g, '').slice(0, 15) } : null;
  }).filter(Boolean).slice(0, 60);
}
