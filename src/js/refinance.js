import { refinance } from './lib/finance.js';
import { lineChart, money, monthsToText, syncFormWithURL, monthAxis } from './lib/chart.js';
import { $ } from './util.js';
import site from '../data/site.json';
import { pickOffer, renderOffer } from './lib/offers.js';


const form = $('#calc');
const save = syncFormWithURL(form);
const num = (n) => parseFloat(String(form.elements[n].value).replace(/[^\d.]/g, '')) || 0;

function render() {
  const r = refinance(
    { balance: num('balance'), rate: num('rate'), monthsLeft: Math.round(num('yearsLeft') * 12) },
    { rate: num('newRate'), months: Math.round(+form.elements.newTerm.value * 12), costs: num('costs'), pointsPct: num('points'), rollCosts: form.elements.roll.checked },
    num('stay'),
  );
  const good = r.breakEven !== null && r.breakEven <= r.stay && r.savingsAtStay > 0;
  $('#verdict').className = `summary ${good ? '' : 'warn'}`;
  $('#verdict').style.background = good ? '' : 'var(--ember-soft)';
  $('#verdict').style.color = good ? '' : 'var(--ember)';
  $('#verdict').textContent = r.breakEven === null
    ? 'This refinance never pays for itself — the new loan costs more in total.'
    : good
      ? `Worth it if you stay ${num('stay')} years: you break even after ${monthsToText(r.breakEven)} and come out ${money(r.savingsAtStay)} ahead.`
      : `Breaks even after ${monthsToText(r.breakEven)} — later than the ${num('stay')} years you plan to stay. Probably not worth it.`;
  $('#kpis').innerHTML = [
    ['big', 'New monthly payment', money(r.newPmt, 2)],
    ['', 'Monthly change', `${r.monthly >= 0 ? '−' : '+'}${money(Math.abs(r.monthly), 2)}`],
    ['', 'Break-even', r.breakEven ? monthsToText(r.breakEven) : 'Never'],
    ['', `Ahead after ${num('stay')} yrs`, money(r.savingsAtStay)],
    ['', 'Closing costs + points', money(r.upfront)],
    ['', 'Lifetime interest: old → new', `${money(r.oldInterest)} → ${money(r.newInterest)}`],
    r.extendsBy > 0 && ['', 'Adds to your payoff', monthsToText(r.extendsBy)],
  ].filter(Boolean).map(([c, k, v]) => `<div class="kpi ${c}"><span>${k}</span><b>${v}</b></div>`).join('');
  const n = Math.min(r.series.old.length, Math.max(r.stay + 24, 120));
  lineChart($('#chart'), [
    { values: r.series.old.slice(0, n), color: '--warn' },
    { values: r.series.new.slice(0, n), color: '--ok' },
  ], { ...monthAxis(n, 1), minZero: false });
  renderOffer($('#offer'), pickOffer('refinance', r, site.affiliates));
  save();
}
form.addEventListener('input', render);
addEventListener('resize', render);
render();
