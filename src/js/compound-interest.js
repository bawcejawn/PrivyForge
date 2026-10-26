import '../css/calculators.css';
import { grow, aprToApy, monthsToGoal, contributionForGoal } from './lib/savings.js';
import { lineChart, money, monthsToText, syncFormWithURL, monthAxis } from './lib/chart.js';
import { $ } from './util.js';
import site from '../data/site.json';
import { pickOffer, renderOffer } from './lib/offers.js';

const form = $('#calc');
const save = syncFormWithURL(form);
const num = (n) => parseFloat(String(form.elements[n].value).replace(/[^\d.]/g, '')) || 0;
const kpi = ([c, k, v]) => `<div class="kpi ${c}"><span>${k}</span><b>${v}</b></div>`;
const pct = (n) => `${(Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '')}%`;

function render() {
  const mode = form.elements.mode.value, rateType = form.elements.rateType.value;
  $('#f-monthly').hidden = mode === 'contribution';
  $('#f-years').hidden = mode === 'time';
  $('#f-target').hidden = mode === 'grow';
  $('#f-freq').hidden = rateType !== 'apr';
  const o = { initial: num('initial'), monthly: num('monthly'), rate: num('rate'), rateType, freq: form.elements.freq.value, increasePct: num('increase') };
  const target = num('target');
  let years = num('years');
  const v = $('#verdict');
  save();
  $('#apy-note').textContent = rateType === 'apr'
    ? `${pct(o.rate)} APR compounded ${o.freq} = ${pct(aprToApy(o.rate, { daily: 365, monthly: 12, quarterly: 4, annually: 1 }[o.freq]))} APY.`
    : `${pct(o.rate)} APY — the yield after compounding, as banks advertise it.`;

  let headline = null;
  if (mode === 'time') {
    const m = monthsToGoal(o, target);
    if (!Number.isFinite(m)) { fail(v, `At these numbers the balance doesn't reach ${money(target)} within 100 years. Add a monthly contribution or raise the rate.`); return; }
    years = Math.max(1, Math.ceil(m / 12));
    headline = ['big', `Time to reach ${money(target)}`, m === 0 ? 'Already there' : monthsToText(m)];
    v.className = 'summary';
    v.textContent = m === 0 ? `Your starting balance already meets the ${money(target)} goal.` : `You'd reach ${money(target)} in ${monthsToText(m)}, saving ${money(o.monthly)} a month${o.increasePct ? ` (rising ${o.increasePct}% a year)` : ''}.`;
  } else if (mode === 'contribution') {
    const c = contributionForGoal(o, target, years);
    if (!Number.isFinite(c) || !(years > 0)) { fail(v, 'Enter a number of years to solve for the monthly amount.'); return; }
    o.monthly = c;
    headline = ['big', `Monthly to reach ${money(target)} in ${years} yr`, money(c, 2)];
    v.className = 'summary';
    v.textContent = c === 0 ? `Your starting deposit alone grows past ${money(target)} in ${years} years.` : `Save ${money(c, 2)} a month${o.increasePct ? ` in year 1, rising ${o.increasePct}% a year,` : ''} to reach ${money(target)} in ${years} years.`;
  }
  if (!(years > 0)) { fail(v, 'Enter how many years to grow your savings.'); return; }
  const r = grow({ ...o, years });
  if (mode === 'grow') {
    v.className = 'summary';
    v.textContent = `After ${years} years you'd have ${money(r.final, 2)}: ${money(r.contributed, 2)} you put in and ${money(r.interest, 2)} of interest.`;
  }
  $('#kpis').innerHTML = [
    headline || ['big', `Balance after ${years} yr`, money(r.final, 2)],
    headline && ['', `Balance after ${years} yr`, money(r.final, 2)],
    ['', 'Total contributed', money(r.contributed, 2)],
    ['', 'Total interest', money(r.interest, 2)],
    ['', 'Interest share of balance', r.final > 0 ? `${Math.round(r.interest / r.final * 100)}%` : '—'],
  ].filter(Boolean).map(kpi).join('');
  lineChart($('#chart'), [{ values: r.series.balance, color: '--ok' }, { values: r.series.contributed, color: '--ember' }], monthAxis(r.series.balance.length));
  $('#table').innerHTML = `<thead><tr><th>Year</th><th>Contributed</th><th>Interest</th><th>Total contributed</th><th>Total interest</th><th>Balance</th></tr></thead><tbody>${r.years.map((y) => `<tr><td>${y.year}</td><td>${money(y.contributed, 2)}</td><td>${money(y.interest, 2)}</td><td>${money(y.totalContributed, 2)}</td><td>${money(y.totalInterest, 2)}</td><td>${money(y.balance, 2)}</td></tr>`).join('')}</tbody>`;
  renderOffer($('#offer'), pickOffer('savings', { final: r.final }, site.affiliates));
}

function fail(v, msg) {
  v.className = 'summary warn'; v.textContent = msg;
  $('#kpis').innerHTML = ''; $('#table').innerHTML = ''; lineChart($('#chart'), []);
  renderOffer($('#offer'), null);
}

form.addEventListener('input', render);
form.addEventListener('change', render);
addEventListener('resize', render);
render();
