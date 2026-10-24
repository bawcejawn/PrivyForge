import { rentVsBuy } from './lib/finance.js';
import { lineChart, money, syncFormWithURL } from './lib/chart.js';
import { $ } from './util.js';

const form = $('#calc');
const save = syncFormWithURL(form);
const num = (n) => parseFloat(String(form.elements[n].value).replace(/[^\d.-]/g, '')) || 0;

function render() {
  const p = {
    price: num('price'), downPct: num('downPct'), rate: num('rate'), term: +form.elements.term.value,
    taxPct: num('taxPct'), insurance: num('insurance'), maintPct: num('maintPct'), hoa: num('hoa'),
    appreciation: num('appreciation'), rent: num('rent'), rentGrowth: num('rentGrowth'),
    investReturn: num('investReturn'), years: Math.max(1, Math.min(40, Math.round(num('years')))),
  };
  const r = rentVsBuy(p);
  const last = r.years.at(-1);
  const buyWins = last.buyerNW > last.renterNW;
  $('#verdict').textContent = r.breakEvenYear
    ? `Buying comes out ahead after ${r.breakEvenYear} year${r.breakEvenYear > 1 ? 's' : ''}. Over ${p.years} years, ${buyWins ? 'buying' : 'renting'} leaves you ${money(Math.abs(last.buyerNW - last.renterNW))} wealthier.`
    : `Renting stays ahead for all ${p.years} years — by ${money(last.renterNW - last.buyerNW)} at the end — assuming you invest the difference.`;
  $('#kpis').innerHTML = [
    ['big', `Net worth after ${p.years} yrs: buy`, money(last.buyerNW)],
    ['big', `Net worth after ${p.years} yrs: rent`, money(last.renterNW)],
    ['', 'Month 1 cost to own', money(r.firstMonthOwn)],
    ['', 'Month 1 cost to rent', money(r.firstMonthRent)],
    ['', 'Mortgage P&I', money(r.payment, 2)],
    ['', 'Buying wins after', r.breakEvenYear ? `${r.breakEvenYear} yrs` : 'Never (in range)'],
  ].map(([c, k, v]) => `<div class="kpi ${c}"><span>${k}</span><b>${v}</b></div>`).join('');
  lineChart($('#chart'), [
    { values: r.years.map((y) => y.buyerNW), color: '--ember' },
    { values: r.years.map((y) => y.renterNW), color: '--ok' },
  ], { xLabel: (i) => `Yr ${i + 1}`, minZero: false });
  save();
}
form.addEventListener('input', render);
addEventListener('resize', render);
render();
