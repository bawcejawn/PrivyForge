// Find recurring charges in a bank/card CSV export. Runs entirely in the browser.

/** RFC 4180-ish CSV parser (quotes, escaped quotes, CRLF). Returns array of string arrays. */
export function parseCSV(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  text = text.replace(/^﻿/, '');
  // Delimiter = whichever of , ; TAB appears most in the first line (EU banks use ;).
  const first = text.split(/\r?\n/, 1)[0];
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

export function parseAmount(s) {
  if (s == null) return NaN;
  let t = String(s).trim();
  if (!t) return NaN;
  const neg = /^\(.*\)$/.test(t) || /-/.test(t) || /\bDR\b/i.test(t);
  t = t.replace(/[()$€£¥\s-]|CR|DR/gi, '');
  // 1.234,56 (EU) -> 1234.56 ; 1,234.56 -> 1234.56
  if (/\d\.\d{3},\d{1,2}$/.test(t) || /^\d+,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Math.abs(parseFloat(t.replace(/-/g, '')));
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

export function parseDate(s) {
  const t = String(s || '').trim();
  let m;
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return Date.UTC(+m[1], m[2] - 1, +m[3]);
  if ((m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/))) {
    let y = +m[3]; if (y < 100) y += 2000;
    let a = +m[1], b = +m[2];
    // assume US month/day unless the first part can't be a month
    const [mo, d] = a > 12 ? [b, a] : [a, b];
    return Date.UTC(y, mo - 1, d);
  }
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : NaN;
}

/** Guess which columns hold date / description / amount (or debit+credit). */
export function detectColumns(rows) {
  const header = rows[0].map((h) => h.toLowerCase().trim());
  const find = (re) => header.findIndex((h) => re.test(h));
  let date = find(/date|posted|time/);
  let desc = find(/desc|merchant|payee|name|memo|details|narrative|transaction/);
  let amount = find(/^amount|amount\b|value|sum/);
  const debit = find(/debit|withdraw|out|spent/);
  const credit = find(/credit|deposit|in\b/);
  const hasHeader = date !== -1 || desc !== -1 || amount !== -1 || debit !== -1;
  if (!hasHeader) {
    // No header: sniff from first data row
    const r = rows[0];
    date = r.findIndex((c) => Number.isFinite(parseDate(c)) && /\d/.test(c));
    amount = r.findIndex((c, i) => i !== date && Number.isFinite(parseAmount(c)) && /\d/.test(c));
    desc = r.reduce((best, c, i) => (i !== date && i !== amount && c.length > (r[best]?.length || 0) ? i : best), -1);
  }
  return { hasHeader, date, desc, amount: amount !== -1 ? amount : -1, debit: amount === -1 ? debit : -1, credit: amount === -1 ? credit : -1 };
}

/** Merchant normalization: "NETFLIX.COM 866-579-7172 CA #1234" -> "NETFLIX" */
export function normalizeMerchant(s) {
  return String(s).toUpperCase()
    .replace(/^(POS|DEBIT|CREDIT|CARD|PURCHASE|RECURRING|ACH|PAYPAL \*|SQ \*|TST\*|SP \*|AMZN MKTP|CHECKCARD)\s*/g, '')
    .replace(/\*.*$/, (m) => (m.length > 3 ? '' : m))
    .replace(/\.(COM|NET|ORG|IO|CO)\b.*/, '')
    .replace(/WWW\./, '')
    .replace(/[#\d]{3,}.*$/, '')
    .replace(/\b(INC|LLC|LTD|CORP|CO)\b\.?/g, '')
    .replace(/[^A-Z&+ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ').slice(0, 3).join(' ') || String(s).trim().slice(0, 24).toUpperCase();
}

export function toTransactions(rows, cols) {
  const data = cols.hasHeader ? rows.slice(1) : rows;
  const tx = [];
  for (const r of data) {
    const date = parseDate(r[cols.date]);
    let amt;
    if (cols.amount !== -1) amt = parseAmount(r[cols.amount]);
    else {
      const d = parseAmount(r[cols.debit]), c = parseAmount(r[cols.credit]);
      amt = Number.isFinite(d) && d !== 0 ? -Math.abs(d) : Number.isFinite(c) ? Math.abs(c) : NaN;
    }
    const desc = (r[cols.desc] || '').trim();
    if (!Number.isFinite(date) || !Number.isFinite(amt) || !desc) continue;
    tx.push({ date, amount: amt, desc, merchant: normalizeMerchant(desc) });
  }
  // Spending sign: if most rows are positive, the export lists spending as positive.
  const pos = tx.filter((t) => t.amount > 0).length;
  const spendPositive = pos > tx.length / 2;
  return tx.map((t) => ({ ...t, spend: spendPositive ? t.amount : -t.amount })).filter((t) => t.spend > 0);
}

const CADENCES = [
  { name: 'Weekly', days: 7, tol: 2, perYear: 52 },
  { name: 'Every 2 weeks', days: 14, tol: 3, perYear: 26 },
  { name: 'Monthly', days: 30.44, tol: 4, perYear: 12 },
  { name: 'Quarterly', days: 91.3, tol: 8, perYear: 4 },
  { name: 'Yearly', days: 365.25, tol: 15, perYear: 1 },
];
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Returns recurring merchants sorted by yearly cost. */
export function findRecurring(tx) {
  const groups = new Map();
  for (const t of tx) (groups.get(t.merchant) || groups.set(t.merchant, []).get(t.merchant)).push(t);
  const out = [];
  for (const [merchant, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.date - b.date);
    const gaps = list.slice(1).map((t, i) => (t.date - list[i].date) / 864e5).filter((g) => g > 0.5);
    if (!gaps.length) continue;
    const gap = median(gaps);
    const cad = CADENCES.find((c) => Math.abs(gap - c.days) <= c.tol);
    if (!cad) continue;
    const regular = gaps.filter((g) => Math.abs(g - cad.days) <= cad.tol * 1.5).length / gaps.length;
    const amt = median(list.map((t) => t.spend));
    const similar = list.filter((t) => Math.abs(t.spend - amt) <= Math.max(1, amt * 0.15)).length / list.length;
    if (regular < 0.6 || similar < 0.6) continue;
    const confidence = Math.min(1, (list.length >= 3 ? 0.5 : 0.3) + regular * 0.25 + similar * 0.25);
    out.push({
      merchant, cadence: cad.name, amount: Math.round(amt * 100) / 100,
      yearly: Math.round(amt * cad.perYear * 100) / 100,
      count: list.length, last: list.at(-1).date,
      nextExpected: list.at(-1).date + cad.days * 864e5,
      example: list.at(-1).desc, confidence,
      priceChanged: list.length >= 2 && Math.abs(list.at(-1).spend - list.at(-2).spend) > 0.5,
    });
  }
  return out.sort((a, b) => b.yearly - a.yearly);
}
