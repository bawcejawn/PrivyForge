import '../css/calculators.css';
import '../css/budget.css';
import { budget, GROUPS, PRESETS, SAMPLE_INCOME, SAMPLE_LINES, serializeLines, parseLines, fmtCents, fmtPct, toPct } from './lib/budget.js';
import { $ } from './util.js';
import site from '../data/site.json';
import { pickOffer, renderOffer } from './lib/offers.js';

const form = $('#calc');
const incomeEl = $('#income'), presetEl = $('#preset');
const ratioEl = Object.fromEntries(GROUPS.map((g) => [g, $(`#r-${g}`)]));
const groupEl = Object.fromEntries(GROUPS.map((g) => [g, form.querySelector(`.bgroup[data-group="${g}"]`)]));
const NOUN = { needs: 'need', wants: 'want', savings: 'savings or debt line' };
const SAMPLE_KEY = serializeLines(SAMPLE_LINES);

function addLine(group, { name = '', amount = '' } = {}) {
  const row = document.createElement('div');
  row.className = 'bline';
  const n = Object.assign(document.createElement('input'), { className: 'bname', value: name, placeholder: 'Name', maxLength: 80 });
  n.setAttribute('aria-label', `${NOUN[group]} name`);
  const a = Object.assign(document.createElement('input'), { className: 'bamt', value: amount, placeholder: '0', inputMode: 'decimal' });
  a.setAttribute('aria-label', `${name || NOUN[group]} amount ($ a month)`);
  const x = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn', textContent: '✕' });
  x.setAttribute('aria-label', `Remove ${name || NOUN[group]}`);
  x.onclick = () => { row.remove(); render(); };
  row.append(n, a, x);
  groupEl[group].querySelector('.lines').append(row);
  return row;
}

const lines = () => GROUPS.flatMap((g) => [...groupEl[g].querySelectorAll('.bline')].map((r) => ({
  group: g, name: r.querySelector('.bname').value, amount: r.querySelector('.bamt').value,
})));
const ratios = () => Object.fromEntries(GROUPS.map((g) => [g, toPct(ratioEl[g].value)]));
const setRatios = (arr) => GROUPS.forEach((g, i) => { ratioEl[g].value = arr[i]; });
function syncPreset() {
  const cur = GROUPS.map((g) => toPct(ratioEl[g].value)).join('/');
  presetEl.value = PRESETS[cur] ? cur : 'custom';
}

// ---- Restore from the URL (?income=…&r=50-30-20&l=n~Rent~1600|…), else the labelled sample.
const qs = new URLSearchParams(location.search);
incomeEl.value = qs.has('income') ? qs.get('income').replace(/[^\d.,]/g, '').slice(0, 15) : SAMPLE_INCOME;
const r0 = (qs.get('r') || '').split('-').map((v) => String(toPct(v)));
setRatios(r0.length === 3 && qs.get('r') ? r0 : PRESETS['50/30/20']);
syncPreset();
(qs.has('l') ? parseLines(qs.get('l')) : SAMPLE_LINES).forEach((l) => addLine(l.group, l));

function save(ls) {
  const p = new URLSearchParams({ income: incomeEl.value, r: GROUPS.map((g) => ratioEl[g].value).join('-'), l: serializeLines(ls) });
  history.replaceState(null, '', `?${p}`);
}

const kpi = ([c, k, v]) => `<div class="kpi ${c}"><span>${k}</span><b>${v}</b></div>`;
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function render() {
  const ls = lines();
  const r = budget({ income: incomeEl.value, lines: ls, ratios: ratios() });
  save(ls);
  $('#sample-note').hidden = serializeLines(ls) !== SAMPLE_KEY;
  for (const g of r.groups) groupEl[g.key].querySelector('.gsum').textContent = fmtCents(g.actual);

  const v = $('#verdict');
  if (r.status === 'no-income') { v.className = 'summary warn'; v.textContent = 'Enter your monthly take-home pay to see your split.'; }
  else if (r.status === 'over') { v.className = 'summary bad'; v.textContent = `You're spending ${fmtCents(-r.leftover)} a month more than you take home.`; }
  else if (r.status === 'under') { v.className = 'summary'; v.textContent = `${fmtCents(r.leftover)} a month is left after everything listed.`; }
  else { v.className = 'summary'; v.textContent = 'Every dollar of take-home pay is assigned.'; }

  $('#kpis').innerHTML = [
    ['big', r.leftover < 0 ? 'Overspent each month' : 'Left over each month', fmtCents(Math.abs(r.leftover))],
    ['', 'Take-home pay', fmtCents(r.income)],
    ['', 'Total listed', fmtCents(r.spent)],
  ].map(kpi).join('');

  const has = r.income > 0;
  $('#bars').innerHTML = r.groups.map((g) => `
    <div class="bbar ${g.key}">
      <div class="bbar-head"><span>${g.label}</span><b>${has ? fmtPct(g.pct) : '—'}</b></div>
      <div class="bbar-track"><i style="width:${has ? Math.min(100, g.pct) : 0}%"></i><s style="left:${Math.min(100, g.guidePct)}%" title="Guideline ${fmtPct(g.guidePct)}"></s></div>
    </div>`).join('');
  $('#bars').setAttribute('aria-label', has ? r.groups.map((g) => `${g.label} ${fmtPct(g.pct)} of take-home, guideline ${fmtPct(g.guidePct)}`).join('; ') : 'Enter take-home pay to see the split');

  const diff = (g) => (!has ? '—' : g.diff === 0 ? 'On target' : `${fmtCents(Math.abs(g.diff))} ${g.diff > 0 ? 'over' : 'under'}`);
  $('#table').innerHTML = `<thead><tr><th>Group</th><th class="num">You</th><th class="num">Share</th><th class="num">Guideline</th><th class="num">Difference</th></tr></thead><tbody>${
    r.groups.map((g) => `<tr data-group="${g.key}"><td>${g.label}</td><td class="num">${fmtCents(g.actual)}</td><td class="num">${has ? fmtPct(g.pct) : '—'}</td><td class="num">${fmtCents(g.target)} (${fmtPct(g.guidePct)})</td><td class="num">${diff(g)}</td></tr>`).join('')
  }</tbody>`;
  $('#notes').innerHTML = r.notes.map((n) => `<li>${esc(n)}</li>`).join('');

  const needs = r.totals.needs;
  $('#ef-link').innerHTML = needs > 0
    ? `Next: <a href="/emergency-fund-calculator/?expenses=${(needs / 100).toFixed(2).replace(/\.00$/, '')}&amp;itemize=0">size an emergency fund from your ${fmtCents(needs)} of monthly needs →</a>`
    : '';

  renderOffer($('#offer'), pickOffer('budget', { income: r.income / 100, leftover: r.leftover / 100, savings: r.totals.savings / 100 }, site.affiliates));
}

presetEl.addEventListener('change', () => { if (PRESETS[presetEl.value]) setRatios(PRESETS[presetEl.value]); render(); });
for (const g of GROUPS) {
  ratioEl[g].addEventListener('input', syncPreset);
  groupEl[g].querySelector('.add').onclick = () => { addLine(g).querySelector('.bname').focus(); render(); };
}
$('#clear').onclick = () => { form.querySelectorAll('.bamt').forEach((a) => { a.value = ''; }); render(); };
form.addEventListener('input', (e) => {
  if (e.target.classList.contains('bname')) {
    const row = e.target.closest('.bline'), g = row.closest('.bgroup').dataset.group, nm = e.target.value || NOUN[g];
    row.querySelector('.bamt').setAttribute('aria-label', `${nm} amount ($ a month)`);
    row.querySelector('.icon-btn').setAttribute('aria-label', `Remove ${nm}`);
  }
  render();
});
render();
