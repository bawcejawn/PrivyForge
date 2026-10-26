import '../css/calculators.css';
import { carLoan, compareTerms, TERMS } from './lib/autoloan.js';
import { byYear } from './amortization.js';
import { lineChart, money, monthsToText, dateAfterMonths, syncFormWithURL, monthAxis } from './lib/chart.js';
import { $, downloadBlob } from './util.js';
import site from '../data/site.json';
import { pickOffer, renderOffer } from './lib/offers.js';

const form = $('#calc');
const save = syncFormWithURL(form);
const num = (n) => parseFloat(String(form.elements[n].value).replace(/[^\d.]/g, '')) || 0;
const kpi = ([c, k, v]) => `<div class="kpi ${c}"><span>${k}</span><b>${v}</b></div>`;
let view = 'year', last;

function input() {
  return { price: num('price'), down: num('down'), tradeIn: num('tradeIn'), owed: num('owed'), taxPct: num('tax'), fees: num('fees'), taxAfterTrade: form.elements.taxAfterTrade.checked };
}

function render() {
  const deal = input(), apr = num('apr');
  if (!form.elements.term.value) form.elements.term.value = '60'; // bad value in a shared link
  const months = +form.elements.term.value;
  const c = (last = carLoan(deal, apr, months));
  save();
  renderOffer($('#offer'), pickOffer('car', { financed: c.financed, apr, totalInterest: c.totalInterest }, site.affiliates));
  const v = $('#verdict');
  if (!(deal.price > 0)) { v.className = 'summary warn'; v.textContent = 'Enter the vehicle price to see your payment.'; }
  else if (c.financed === 0) { v.className = 'summary'; v.textContent = 'Nothing to finance: your down payment and trade-in cover the whole price.'; }
  else {
    v.className = 'summary';
    v.textContent = `${money(c.payment, 2)} a month for ${months} months. You'd borrow ${money(c.financed)} and pay ${money(c.totalInterest, 2)} in interest.`;
  }
  $('#kpis').innerHTML = [
    ['big', 'Monthly payment', money(c.payment, 2)],
    ['', 'Amount financed', money(c.financed)],
    ['', 'Total interest', money(c.totalInterest, 2)],
    ['', 'Total cost of the car', money(c.totalCost, 2)],
    ['', 'Paid off', c.rows.length ? dateAfterMonths(c.rows.length) : '—'],
  ].map(kpi).join('');
  const eq = c.equity;
  $('#breakdown').textContent = `Sales tax ${money(c.tax, 2)} on ${money(c.taxable)}`
    + (deal.tradeIn || deal.owed ? ` · trade-in ${eq >= 0 ? 'equity' : 'negative equity (added to the loan)'} ${money(Math.abs(eq))}` : '')
    + ` · fees ${money(deal.fees)}. Total cost = cash down${eq > 0 ? ' + trade-in equity' : ''} + all loan payments.`;

  const terms = compareTerms(deal, apr, TERMS);
  const base = terms.find((t) => t.months === months);
  $('#terms').innerHTML = `<thead><tr><th>Term</th><th class="num">Monthly</th><th class="num">Interest</th><th class="num">Total cost</th><th class="num">vs ${months} mo</th></tr></thead><tbody>${terms.map((t) => {
    const d = t.totalInterest - base.totalInterest;
    return `<tr class="${t.months === months ? 'sel' : ''}" data-term="${t.months}"><td>${t.months} mo (${monthsToText(t.months)})</td><td class="num">${money(t.payment, 2)}</td><td class="num">${money(t.totalInterest)}</td><td class="num">${money(t.totalCost)}</td><td class="num">${t.months === months ? '—' : `${d > 0 ? '+' : '−'}${money(Math.abs(d))}`}</td></tr>`;
  }).join('')}</tbody>`;
  const short = terms[0], long = terms.at(-1);
  $('#terms-note').textContent = c.financed > 0 && apr > 0
    ? `Stretching from ${short.months} to ${long.months} months lowers the payment by ${money(short.payment - long.payment, 2)} but adds ${money(long.totalInterest - short.totalInterest)} of interest.`
    : '';
  drawChart(c); renderTable(c);
}

function drawChart(c) {
  let ci = 0, cp = 0;
  const bal = [c.financed], int = [0], prin = [0];
  for (const r of c.rows) { ci += r.interest; cp += r.principal + r.extra; bal.push(r.balance); int.push(ci); prin.push(cp); }
  lineChart($('#chart'), [{ values: bal, color: '--ember' }, { values: prin, color: '--ok' }, { values: int, color: '--warn' }], monthAxis(bal.length));
}

function renderTable(c) {
  const rows = view === 'year' ? byYear(c.rows) : c.rows;
  const head = view === 'year' ? ['Year', 'Principal', 'Interest', 'Balance'] : ['Month', 'Payment', 'Principal', 'Interest', 'Balance'];
  const body = rows.map((r) => view === 'year'
    ? [r.year, money(r.principal, 2), money(r.interest, 2), money(r.balance, 2)]
    : [r.n, money(r.payment, 2), money(r.principal, 2), money(r.interest, 2), money(r.balance, 2)]);
  $('#table').innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((x) => `<td>${x}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  view = b.dataset.view;
  document.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  renderTable(last);
}));
$('#terms').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-term]');
  if (!tr || ![...form.elements.term.options].some((o) => o.value === tr.dataset.term)) return;
  form.elements.term.value = tr.dataset.term; render();
});
$('#csv').onclick = () => {
  const lines = ['Month,Payment,Principal,Interest,Balance', ...last.rows.map((r) => [r.n, r.payment, r.principal, r.interest, r.balance].map((x, i) => (i ? x.toFixed(2) : x)).join(','))];
  downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv' }), 'car-loan-amortization.csv');
};
form.addEventListener('input', render);
form.addEventListener('change', render);
addEventListener('resize', () => last && drawChart(last));
render();
