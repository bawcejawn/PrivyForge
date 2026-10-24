import { compare } from './lib/debt.js';
import { lineChart, money, monthsToText, dateAfterMonths, monthAxis } from './lib/chart.js';
import { $ } from './util.js';

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const body = $('#debts tbody');
const budgetEl = $('#budget');
const DEFAULTS = [
  ['Credit card', 6500, 24.99, 180],
  ['Store card', 1200, 29.99, 45],
  ['Car loan', 14000, 7.4, 320],
  ['Personal loan', 4000, 12.5, 135],
];

function addRow([name, bal, apr, min] = ['', '', '', '']) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input aria-label="Debt name" name="name" value="${esc(name)}" placeholder="Name"></td>
    <td><input aria-label="Balance" name="balance" inputmode="decimal" value="${esc(bal)}" placeholder="0"></td>
    <td><input aria-label="APR %" name="apr" inputmode="decimal" value="${esc(apr)}" placeholder="0"></td>
    <td><input aria-label="Minimum payment" name="min" inputmode="decimal" value="${esc(min)}" placeholder="0"></td>
    <td><button class="icon-btn" aria-label="Remove debt">✕</button></td>`;
  tr.querySelector('button').onclick = () => { tr.remove(); render(); };
  body.append(tr);
}

const num = (v) => parseFloat(String(v).replace(/[^\d.]/g, '')) || 0;
function debts() {
  return [...body.rows].map((tr, i) => {
    const g = (n) => tr.querySelector(`[name=${n}]`).value;
    return { name: g('name') || `Debt ${i + 1}`, balance: num(g('balance')), apr: num(g('apr')), min: num(g('min')) };
  }).filter((d) => d.balance > 0);
}

// Restore from URL (?d=name~bal~apr~min|... &b=budget)
const qs = new URLSearchParams(location.search);
if (qs.get('d')) qs.get('d').split('|').forEach((s) => addRow(s.split('~').map((x, i) => (i ? x : decodeURIComponent(x)))));
else DEFAULTS.forEach(addRow);
budgetEl.value = qs.get('b') || 900;

function render() {
  const list = debts(), budget = num(budgetEl.value);
  const minTotal = list.reduce((s, d) => s + d.min, 0);
  $('#min-total').textContent = money(minTotal, 2);
  history.replaceState(null, '', `?d=${list.map((d) => [encodeURIComponent(d.name), d.balance, d.apr, d.min].join('~')).join('|')}&b=${budget}`);
  const out = $('#results');
  if (!list.length) { out.innerHTML = '<p class="status">Add at least one debt.</p>'; return; }
  const c = compare(list, budget);
  if (!c.avalanche.ok && c.avalanche.reason) {
    out.innerHTML = `<p class="status err">${c.avalanche.reason}</p>`;
    lineChart($('#chart'), []); return;
  }
  const best = c.avalanche, snow = c.snowball, mins = c.minimum;
  const vsMin = mins.ok ? mins.totalInterest - best.totalInterest : null;
  out.innerHTML = `
    <div class="kpis">
      <div class="kpi big"><span>Debt-free (avalanche)</span><b>${dateAfterMonths(best.months)}</b></div>
      <div class="kpi"><span>Time to debt-free</span><b>${monthsToText(best.months)}</b></div>
      <div class="kpi"><span>Total interest</span><b>${money(best.totalInterest)}</b></div>
      <div class="kpi"><span>Saved vs. minimums only</span><b>${vsMin === null ? 'Never paid off' : money(vsMin)}</b></div>
    </div>
    <table class="compare-table" style="margin-top:14px">
      <thead><tr><th>Strategy</th><th>Debt-free</th><th>Total interest</th><th>Pays off first</th></tr></thead>
      <tbody>
        <tr><td><b>Avalanche</b> (highest rate first)</td><td>${monthsToText(best.months)}</td><td>${money(best.totalInterest)}</td><td>${esc(best.debts[0].name)}</td></tr>
        <tr><td><b>Snowball</b> (smallest balance first)</td><td>${monthsToText(snow.months)}</td><td>${money(snow.totalInterest)}</td><td>${esc(snow.debts[0].name)}</td></tr>
        <tr><td>Minimum payments only</td><td>${mins.ok ? monthsToText(mins.months) : 'Never'}</td><td>${mins.ok ? money(mins.totalInterest) : '—'}</td><td>—</td></tr>
      </tbody>
    </table>
    <p class="status">Snowball costs ${money(snow.totalInterest - best.totalInterest)} more than avalanche here, but the quick early win keeps many people motivated. Either beats minimums.</p>
    <h3 style="margin:18px 0 6px">Payoff order (avalanche)</h3>
    <ol>${best.debts.map((d) => `<li>${esc(d.name)} — paid off ${dateAfterMonths(d.paidOffMonth)} (${money(d.interest)} interest)</li>`).join('')}</ol>`;
  lineChart($('#chart'), [
    { values: [list.reduce((s, d) => s + d.balance, 0), ...best.timeline], color: '--ok' },
    { values: [list.reduce((s, d) => s + d.balance, 0), ...snow.timeline], color: '--ember', dash: [6, 4] },
    ...(mins.ok ? [{ values: [list.reduce((s, d) => s + d.balance, 0), ...mins.timeline], color: '--warn' }] : []),
  ], monthAxis(Math.max(best.timeline.length, mins.ok ? mins.timeline.length : 0) + 1));
}

$('#add').onclick = () => { addRow(); body.rows[body.rows.length - 1].querySelector('input').focus(); };
document.addEventListener('input', (e) => { if (e.target.closest('#debt-form')) render(); });
addEventListener('resize', render);
render();
