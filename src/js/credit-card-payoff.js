import '../css/calculators.css';
import { cardPayoff, paymentForMonths, minimumPayoff, balanceTransfer } from './lib/debt.js';
import { lineChart, money, monthsToText, dateAfterMonths, syncFormWithURL, monthAxis } from './lib/chart.js';
import { $ } from './util.js';
import site from '../data/site.json';
import { pickOffer, renderOffer } from './lib/offers.js';

const form = $('#calc');
const save = syncFormWithURL(form);
const num = (n) => parseFloat(String(form.elements[n].value).replace(/[^\d.]/g, '')) || 0;
const kpi = ([c, k, v]) => `<div class="kpi ${c}"><span>${k}</span><b>${v}</b></div>`;

function render() {
  const balance = num('balance'), apr = num('apr'), mode = form.elements.mode.value;
  const bt = form.elements.bt.checked;
  $('#f-payment').hidden = mode !== 'payment';
  $('#f-months').hidden = mode !== 'months';
  $('#bt-fields').hidden = !bt; $('#lg-bt').hidden = !bt;

  const payment = mode === 'months' ? paymentForMonths(balance, apr, Math.max(1, Math.round(num('months')))) : num('payment');
  const plan = cardPayoff(balance, apr, payment);
  const mins = minimumPayoff(balance, apr, { pct: num('minPct'), floor: num('minFloor') });
  const tr = bt ? balanceTransfer(balance, payment, { feePct: num('btFee'), promoApr: num('btApr'), promoMonths: Math.round(num('btMonths')), afterApr: num('btAfter') }) : null;
  const verdict = $('#verdict');
  save();

  if (!(balance > 0)) {
    verdict.className = 'summary warn'; verdict.textContent = 'Enter the card balance to see your payoff plan.';
    $('#kpis').innerHTML = ''; $('#compare').innerHTML = ''; lineChart($('#chart'), []);
    renderOffer($('#offer'), null); return;
  }

  if (!plan.ok) {
    verdict.className = 'summary bad';
    verdict.textContent = `${money(payment, 2)} a month doesn't cover the ${money(plan.firstInterest, 2)} of interest charged in the first month, so the balance never goes down. Pay at least ${money(plan.firstInterest + 0.01, 2)} — ideally much more.`;
  } else {
    verdict.className = 'summary';
    const vsMin = mins.ok ? mins.totalInterest - plan.totalInterest : null;
    verdict.textContent = `Paying ${money(payment, 2)} a month clears ${money(balance)} in ${monthsToText(plan.months)} (${dateAfterMonths(plan.months)}) with ${money(plan.totalInterest, 2)} of interest`
      + (vsMin > 0 ? ` — ${money(vsMin)} less than paying only the minimum.` : '.');
  }

  $('#kpis').innerHTML = [
    ['big', mode === 'months' ? `Pay each month to be done in ${Math.round(num('months'))} mo` : 'Debt-free', mode === 'months' ? money(payment, 2) : (plan.ok ? dateAfterMonths(plan.months) : 'Never')],
    ['', 'Time to pay off', plan.ok ? monthsToText(plan.months) : 'Never'],
    mode === 'months' && ['', 'Debt-free', plan.ok ? dateAfterMonths(plan.months) : 'Never'],
    ['', 'Total interest', plan.ok ? money(plan.totalInterest, 2) : '—'],
    ['', 'Total paid', plan.ok ? money(plan.totalPaid, 2) : '—'],
    ['', 'Interest this month', money(plan.firstInterest, 2)],
  ].filter(Boolean).map(kpi).join('');

  const row = (label, r, extra = '') => `<tr><td>${label}</td><td>${r.ok ? monthsToText(r.months) : 'Never'}</td><td class="num">${r.ok ? money(r.totalInterest, 2) : '—'}</td><td class="num">${r.ok ? money(r.totalPaid, 2) : '—'}</td>${extra}</tr>`;
  $('#compare').innerHTML = `
    <div class="table-scroll" style="max-height:none"><table class="compare-table">
      <thead><tr><th>Plan</th><th>Time</th><th class="num">Interest</th><th class="num">Total paid</th></tr></thead>
      <tbody>
        ${row(`<b>Your plan</b> (${money(payment, 2)}/mo)`, plan)}
        ${row(`Minimum only (starts at ${money(mins.firstPayment, 2)})`, mins)}
        ${tr ? row(`Balance transfer (${money(payment, 2)}/mo)`, tr) : ''}
      </tbody>
    </table></div>
    ${tr ? `<p class="status" id="bt-note">${btNote(tr, plan)}</p>` : ''}`;

  const series = [];
  if (plan.ok) series.push({ values: [balance, ...plan.timeline], color: '--ok' });
  if (mins.ok) series.push({ values: [balance, ...mins.timeline], color: '--warn' });
  if (tr?.ok) series.push({ values: [balance, ...tr.timeline], color: '--ember', dash: [6, 4] });
  const len = Math.max(...series.map((s) => s.values.length), 2);
  lineChart($('#chart'), series, monthAxis(len));

  renderOffer($('#offer'), pickOffer('card', { balance, apr, ok: plan.ok, totalInterest: plan.totalInterest }, site.affiliates));
}

function btNote(tr, plan) {
  if (!tr.ok) return `With this payment the transferred balance never gets paid off after the promo ends (${money(tr.promoBalanceLeft)} left when it does).`;
  const after = tr.promoBalanceLeft > 0 ? `${money(tr.promoBalanceLeft)} is still owed when the promo ends and is charged the after-promo rate. ` : 'The balance is gone before the promo ends. ';
  if (!plan.ok) return `${after}Transfer fee ${money(tr.fee, 2)} + interest ${money(tr.totalInterest, 2)} = ${money(tr.totalCost, 2)} total cost.`;
  const diff = plan.totalInterest - tr.totalCost;
  return `${after}Transfer fee ${money(tr.fee, 2)} + interest ${money(tr.totalInterest, 2)} = ${money(tr.totalCost, 2)}, `
    + (diff > 0 ? `${money(diff, 2)} less than staying on this card.` : `${money(-diff, 2)} more than staying on this card — the fee outweighs the savings.`);
}

form.addEventListener('input', render);
form.addEventListener('change', render);
addEventListener('resize', render);
render();
