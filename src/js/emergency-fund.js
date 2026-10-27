import '../css/calculators.css';
import '../css/budget.css';
import { emergencyPlan, coveredText } from './lib/emergency.js';
import { toCents, fmtCents } from './lib/budget.js';
import { lineChart, monthsToText, dateAfterMonths, syncFormWithURL, monthAxis } from './lib/chart.js';
import { $ } from './util.js';
import site from '../data/site.json';
import { pickOffer, renderOffer } from './lib/offers.js';

const form = $('#calc');
const save = syncFormWithURL(form);
const el = (n) => form.elements[n];
const PARTS = ['housing', 'utilities', 'food', 'insurance', 'transport', 'debt', 'other'];
const kpi = ([c, k, v]) => `<div class="kpi ${c}"><span>${k}</span><b>${v}</b></div>`;
const usd = (c) => fmtCents(c);

function render() {
  const itemize = el('itemize').checked, custom = el('target').value === 'custom';
  $('#breakdown').hidden = !itemize;
  $('#f-custom').hidden = !custom;
  el('expenses').readOnly = itemize;
  if (itemize) {
    const sum = PARTS.reduce((s, p) => s + toCents(el(p).value), 0);
    el('expenses').value = (sum / 100).toFixed(2).replace(/\.00$/, '');
  }
  save();
  const months = custom ? el('custom').value : el('target').value;
  const r = emergencyPlan({ expenses: el('expenses').value, saved: el('saved').value, monthly: el('monthly').value, months, apy: el('apy').value });
  const v = $('#verdict');
  const mLabel = `${r.months} month${r.months === 1 ? '' : 's'}`;

  if (!(r.expenses > 0) || !(r.months > 0)) {
    v.className = 'summary warn';
    v.textContent = !(r.expenses > 0) ? 'Enter your essential monthly expenses to size your emergency fund.' : 'Enter how many months of expenses you want to cover.';
    $('#kpis').innerHTML = ''; $('#table').innerHTML = ''; lineChart($('#chart'), []);
    renderOffer($('#offer'), null); return;
  }

  const reach = Number.isFinite(r.monthsToGoal);
  if (r.gap === 0) {
    v.className = 'summary';
    v.textContent = `You're there: ${usd(r.saved)} covers ${coveredText(r.covered)} months of expenses, at or above your ${mLabel} target of ${usd(r.target)}.`;
  } else if (!reach) {
    v.className = 'summary warn';
    v.textContent = `You need ${usd(r.gap)} more to reach ${usd(r.target)}. Enter an amount you can save each month to see how long it will take.`;
  } else {
    v.className = 'summary';
    v.textContent = `Saving ${usd(r.monthly)} a month, you'd reach ${usd(r.target)} (${mLabel} of expenses) in ${monthsToText(r.monthsToGoal)} — around ${dateAfterMonths(r.monthsToGoal)}.`;
  }

  $('#kpis').innerHTML = [
    ['big', `Target (${mLabel})`, usd(r.target)],
    ['', 'Months covered now', coveredText(r.covered)],
    ['', 'Still to save', usd(r.gap)],
    ['', 'Time to goal', r.gap === 0 ? 'Done' : reach ? monthsToText(r.monthsToGoal) : 'Not reachable'],
    r.apy > 0 && reach && r.gap > 0 && ['', 'Interest earned on the way', usd(r.interest)],
  ].filter(Boolean).map(kpi).join('');

  const series = r.series.length > 1 ? r.series : [r.saved, r.saved];
  lineChart($('#chart'), [
    { values: series.map((c) => c / 100), color: '--ok' },
    { values: series.map(() => r.target / 100), color: '--ember', dash: [6, 4] },
  ], monthAxis(series.length));

  $('#table').innerHTML = r.rows.length
    ? `<thead><tr><th>Month</th><th>Date</th><th>Deposit</th>${r.apy > 0 ? '<th>Interest</th>' : ''}<th>Balance</th><th>Months covered</th></tr></thead><tbody>${
      r.rows.map((x) => `<tr><td>${x.month}</td><td>${dateAfterMonths(x.month)}</td><td>${usd(x.deposit)}</td>${r.apy > 0 ? `<td>${usd(x.interest)}</td>` : ''}<td>${usd(x.balance)}</td><td>${coveredText(x.covered)}</td></tr>`).join('')}</tbody>`
    : `<tbody><tr><td>${r.gap === 0 ? 'Nothing left to save — your fund already meets the target.' : 'No plan yet: add a monthly amount.'}</td></tr></tbody>`;

  renderOffer($('#offer'), pickOffer('emergency', { target: r.target / 100, saved: r.saved / 100, gap: r.gap / 100 }, site.affiliates));
}

form.addEventListener('input', render);
form.addEventListener('change', render);
addEventListener('resize', render);
render();
