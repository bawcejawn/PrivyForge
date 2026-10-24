// Mortgage & loan calculator UI: KPIs, canvas chart, amortization table, CSV, shareable URL.
import { schedule, byYear } from './amortization.js';
import { $, downloadBlob } from './util.js';

const MODE = document.body.dataset.calc; // 'mortgage' | 'loan'
const form = $('#calc');
const money = (n, d = 0) => (Number.isFinite(n) ? n : 0).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: d, minimumFractionDigits: d });
const num = (name) => parseFloat(String(form.elements[name]?.value ?? '').replace(/[^\d.]/g, '')) || 0;

// Restore inputs from the URL (shareable links + long-tail landing pages).
const qs = new URLSearchParams(location.search);
for (const el of form.elements) if (el.name && qs.has(el.name)) el.value = qs.get(el.name);

// Keep down payment $ and % in sync.
if (MODE === 'mortgage') {
  const sync = (from) => {
    const price = num('price');
    if (from === 'pct') form.elements.down.value = Math.round(price * num('downPct') / 100);
    else form.elements.downPct.value = price ? +(num('down') / price * 100).toFixed(1) : 0;
  };
  form.elements.downPct.addEventListener('input', () => sync('pct'));
  form.elements.down.addEventListener('input', () => sync('amt'));
  form.elements.price.addEventListener('input', () => sync('pct'));
}

let view = 'year';
let last;

function compute() {
  const rate = num('rate'), years = num('term'), extra = num('extra');
  const months = Math.round(years * 12);
  let principal, price = 0;
  if (MODE === 'mortgage') { price = num('price'); principal = Math.max(0, price - num('down')); }
  else principal = num('amount');

  const base = schedule(principal, rate, months, 0);
  const plan = extra > 0 ? schedule(principal, rate, months, extra) : base;

  // Escrow-style extras (mortgage only)
  let tax = 0, ins = 0, hoa = 0, pmi = 0, pmiMonths = 0;
  if (MODE === 'mortgage') {
    tax = num('tax') / 12; ins = num('insurance') / 12; hoa = num('hoa');
    const ltv = price ? principal / price : 0;
    if (ltv > 0.8) {
      pmi = principal * (num('pmi') / 100) / 12;
      // Lenders must auto-cancel PMI at 78% of the original value (US Homeowners Protection Act).
      const idx = plan.rows.findIndex((r) => r.balance <= price * 0.78);
      pmiMonths = idx === -1 ? plan.months : idx + 1;
    }
  }
  return { principal, price, rate, months, extra, base, plan, tax, ins, hoa, pmi, pmiMonths };
}

function payoffDate(monthsFromNow) {
  const start = form.elements.start?.value ? new Date(`${form.elements.start.value}-01T00:00`) : new Date();
  const d = new Date(start.getFullYear(), start.getMonth() + monthsFromNow - 1, 1);
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function render() {
  const c = (last = compute());
  const pi = c.base.payment;
  const total = pi + c.extra + c.tax + c.ins + c.hoa + c.pmi;
  const saved = c.base.totalInterest - c.plan.totalInterest;
  const kpis = [
    ['big', MODE === 'mortgage' ? 'Monthly payment' : 'Monthly payment', money(total, 2)],
    ['', 'Principal & interest', money(pi, 2)],
    MODE === 'mortgage' && ['', 'Taxes, insurance, HOA', money(c.tax + c.ins + c.hoa, 2)],
    c.pmi > 0 && ['', `PMI (ends after ${c.pmiMonths} mo)`, money(c.pmi, 2)],
    ['', 'Loan amount', money(c.principal)],
    ['', 'Total interest', money(c.plan.totalInterest)],
    ['', 'Paid off', payoffDate(c.plan.months)],
    c.extra > 0 && ['', `Saved with +${money(c.extra)}/mo`, `${money(saved)} · ${c.base.months - c.plan.months} mo sooner`],
  ].filter(Boolean);
  $('#kpis').innerHTML = kpis.map(([cls, k, v]) => `<div class="kpi ${cls}"><span>${k}</span><b>${v}</b></div>`).join('');
  drawChart(c);
  renderTable(c);
  history.replaceState(null, '', `?${new URLSearchParams([...new FormData(form)].filter(([, v]) => v !== '')).toString()}`);
}

// ---------- Chart (hand-rolled canvas: ~0 KB vs ~200 KB for a chart library)
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function drawChart(c) {
  const cv = $('#chart'), dpr = devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);
  const rows = c.plan.rows; if (!rows.length) return;
  const pad = { l: 58, r: 12, t: 12, b: 26 };
  let cumI = 0, cumP = 0;
  const series = rows.map((r) => { cumI += r.interest; cumP += r.principal + r.extra; return { b: r.balance, i: cumI, p: cumP }; });
  const max = Math.max(c.principal, cumI, cumP) * 1.05;
  const x = (i) => pad.l + (i / Math.max(1, rows.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  ctx.font = '11px system-ui'; ctx.fillStyle = cssVar('--ink-2'); ctx.strokeStyle = cssVar('--line'); ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k, yy = y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
    ctx.fillText(v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1000)}k`, 4, yy + 4);
  }
  const yearsTotal = Math.ceil(rows.length / 12), step = yearsTotal > 20 ? 5 : yearsTotal > 8 ? 2 : 1;
  for (let yr = step; yr <= yearsTotal; yr += step) ctx.fillText(`Yr ${yr}`, Math.min(W - pad.r - 30, x(Math.min(rows.length - 1, yr * 12 - 1)) - 12), H - 8);
  const line = (key, color, width = 2.5) => {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width;
    series.forEach((s, i) => (i ? ctx.lineTo(x(i), y(s[key])) : ctx.moveTo(x(i), y(s[key]))));
    ctx.stroke();
  };
  line('b', cssVar('--ember')); line('p', cssVar('--ok')); line('i', cssVar('--warn'));
}

function renderTable(c) {
  const rows = view === 'year' ? byYear(c.plan.rows) : c.plan.rows;
  const head = view === 'year' ? ['Year', 'Principal', 'Interest', 'Extra', 'Balance'] : ['Month', 'Payment', 'Principal', 'Interest', 'Extra', 'Balance'];
  const body = rows.map((r) => view === 'year'
    ? [r.year, money(r.principal), money(r.interest), money(r.extra), money(r.balance)]
    : [r.n, money(r.payment, 2), money(r.principal, 2), money(r.interest, 2), money(r.extra, 2), money(r.balance, 2)]);
  $('#table').innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((v) => `<td>${v}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  view = b.dataset.view;
  document.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  renderTable(last);
}));
$('#csv').onclick = () => {
  const lines = [['Month', 'Payment', 'Principal', 'Interest', 'Extra', 'Balance'].join(',')];
  for (const r of last.plan.rows) lines.push([r.n, r.payment, r.principal, r.interest, r.extra, r.balance].map((v) => (typeof v === 'number' ? v.toFixed(2) : v)).join(','));
  downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv' }), `${MODE}-amortization.csv`);
};
$('#share').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); $('#share').textContent = 'Link copied ✓'; }
  catch { prompt('Copy this link:', location.href); }
  setTimeout(() => { $('#share').textContent = 'Copy link'; }, 1800);
};

form.addEventListener('input', render);
addEventListener('resize', () => last && drawChart(last));
render();
