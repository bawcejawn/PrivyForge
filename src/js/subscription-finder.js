// Recurring-charge finder. The CSV is read with FileReader and parsed in memory; nothing is sent anywhere.
import { parseCSV, detectColumns, toTransactions, findRecurring } from './lib/subscriptions.js';
import { money } from './lib/chart.js';
import { $, setupDropzone, downloadBlob } from './util.js';

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

let rows = [], cols = null, found = [];
const cancel = new Set();

setupDropzone($('#drop'), { accept: '.csv,text/csv,.txt,text/plain', multiple: true, onFiles: load });

async function load(files) {
  rows = [];
  for (const f of files) {
    const r = parseCSV(await f.text());
    rows.push(...(rows.length ? r.slice(detectColumns(r).hasHeader ? 1 : 0) : r)); // merge multiple exports
  }
  if (!rows.length) return status('That file looks empty.', true);
  cols = detectColumns(rows);
  renderMapping();
  analyze();
}

function status(msg, err = false) { const s = $('#status'); s.textContent = msg; s.classList.toggle('err', err); }

function renderMapping() {
  const header = cols.hasHeader ? rows[0] : rows[0].map((_, i) => `Column ${i + 1}`);
  const opts = (sel) => `<option value="-1">—</option>${header.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(h || `Column ${i + 1}`)}</option>`).join('')}`;
  $('#mapping').hidden = false;
  $('#mapping').innerHTML = `
    <label class="field">Date column<select data-k="date">${opts(cols.date)}</select></label>
    <label class="field">Description column<select data-k="desc">${opts(cols.desc)}</select></label>
    <label class="field">Amount column<select data-k="amount">${opts(cols.amount)}</select></label>
    <label class="field">…or Debit column<select data-k="debit">${opts(cols.debit)}</select></label>`;
  $('#mapping').querySelectorAll('select').forEach((s) => s.addEventListener('change', () => { cols[s.dataset.k] = +s.value; analyze(); }));
}

function analyze() {
  const tx = toTransactions(rows, cols);
  if (!tx.length) { found = []; render(); return status('No spending rows recognised. Check the column choices above.', true); }
  found = findRecurring(tx);
  const span = (Math.max(...tx.map((t) => t.date)) - Math.min(...tx.map((t) => t.date))) / 864e5;
  status(`Scanned ${tx.length} transactions over ${Math.round(span)} days — on your device. ${span < 60 ? 'Tip: export 3–12 months to catch quarterly and yearly charges.' : ''}`);
  render();
}

function render() {
  const total = found.reduce((s, f) => s + f.yearly, 0);
  const saving = found.filter((f) => cancel.has(f.merchant)).reduce((s, f) => s + f.yearly, 0);
  $('#kpis').innerHTML = found.length ? `
    <div class="kpi"><span>Recurring charges found</span><b>${found.length}</b></div>
    <div class="kpi"><span>Yearly cost</span><b>${money(total)}</b></div>
    <div class="kpi"><span>Monthly cost</span><b>${money(total / 12)}</b></div>
    <div class="kpi big"><span>You'd save per year</span><b>${money(saving)}</b></div>` : '';
  $('#subs').innerHTML = found.length ? `
    <thead><tr><th>Cancel?</th><th>Merchant</th><th>How often</th><th>Amount</th><th>Per year</th><th>Last charge</th><th>Next expected</th></tr></thead>
    <tbody>${found.map((f, i) => `<tr>
      <td><input type="checkbox" data-i="${i}" ${cancel.has(f.merchant) ? 'checked' : ''} aria-label="Mark ${esc(f.merchant)} to cancel"></td>
      <td style="text-align:left"><b>${esc(f.merchant)}</b>${f.priceChanged ? ' <span class="pill neutral" title="Last charge differs from the one before">price changed</span>' : ''}<br><small style="color:var(--ink-2)">${esc(f.example)}</small></td>
      <td>${f.cadence}${f.confidence < 0.7 ? ' <small>(likely)</small>' : ''}</td><td>${money(f.amount, 2)}</td><td><b>${money(f.yearly, 2)}</b></td>
      <td>${fmtDate(f.last)}</td><td>${fmtDate(f.nextExpected)}</td></tr>`).join('')}</tbody>` : '';
  $('#subs').querySelectorAll('input[type=checkbox]').forEach((c) => c.addEventListener('change', () => {
    const m = found[+c.dataset.i].merchant; c.checked ? cancel.add(m) : cancel.delete(m); render();
  }));
  $('#export').disabled = !found.length;
}

$('#export').onclick = () => {
  const lines = [['Merchant', 'Cadence', 'Amount', 'Yearly', 'Last charge', 'Next expected', 'Cancel'].join(',')];
  for (const f of found) lines.push([`"${f.merchant.replace(/"/g, '""')}"`, f.cadence, f.amount.toFixed(2), f.yearly.toFixed(2), new Date(f.last).toISOString().slice(0, 10), new Date(f.nextExpected).toISOString().slice(0, 10), cancel.has(f.merchant) ? 'yes' : ''].join(','));
  downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv' }), 'my-subscriptions.csv');
};

// Demo data so visitors can see the result before trusting it with their own statement.
$('#sample').onclick = () => {
  const L = ['Date,Description,Amount'];
  const d = (m, day) => `2026-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  for (let m = 1; m <= 9; m++) {
    L.push(`${d(m, 3)},NETFLIX.COM 866-579-7172 CA,-${m > 6 ? '17.99' : '15.49'}`, `${d(m, 9)},SPOTIFY USA #${4400 + m},-11.99`,
      `${d(m, 14)},PLANET FITNESS #2231,-24.99`, `${d(m, 17)},ADOBE *CREATIVE CLOUD,-59.99`, `${d(m, 21)},ICLOUD STORAGE APPLE.COM/BILL,-2.99`,
      `${d(m, 5 + m)},WHOLE FOODS MARKET,-${(60 + m * 9).toFixed(2)}`, `${d(m, 1)},PAYROLL DEPOSIT,3100.00`);
  }
  L.push('2025-11-02,AMAZON PRIME*AB12CD,-139.00', '2026-11-02,AMAZON PRIME*ZX98YU,-139.00');
  rows = parseCSV(L.join('\n')); cols = detectColumns(rows); renderMapping(); analyze();
};
