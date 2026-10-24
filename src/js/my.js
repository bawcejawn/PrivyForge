import tools from '../data/tools.json';
import * as store from './lib/store.js';
import { $, downloadBlob } from './util.js';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const bySlug = Object.fromEntries(tools.map((t) => [t.slug, t]));
const link = (href) => BASE + href;
const card = (t, extra = '') => `<a class="tool-card" href="${esc(link(t.href))}"><em>${esc(t.category)}</em><b>${esc(t.title)}</b><span>${esc(extra || t.blurb)}</span></a>`;
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${m || 1} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(ms).toLocaleDateString(); };

const CHECKUP = [
  { id: 'subs', title: 'Find subscriptions you forgot about', tool: 'subscription-finder', why: 'The average household pays for services it no longer uses.' },
  { id: 'debt', title: 'Plan your debt-free date', tool: 'debt-payoff-calculator', why: 'Paying highest-rate debt first can save thousands.' },
  { id: 'refi', title: 'Check whether refinancing pays off', tool: 'refinance-calculator', why: 'See your break-even month before talking to a lender.' },
  { id: 'mortgage', title: 'See what an extra $100/month does to your mortgage', tool: 'mortgage-calculator', why: 'Small extra payments can cut years off a loan.' },
  { id: 'rent', title: 'Rent vs buy: run your real numbers', tool: 'rent-vs-buy-calculator', why: 'Avoid the most expensive decision made on gut feel.' },
];

function render() {
  const favs = store.favorites().map((s) => bySlug[s]).filter(Boolean);
  $('#favs').innerHTML = favs.length ? favs.map((t) => card(t)).join('')
    : '<p class="status">No favorites yet. Tap "☆ Add to favorites" on any tool.</p>';

  const rec = store.recent().filter((r) => bySlug[r.slug]);
  $('#recent').innerHTML = rec.length ? rec.map((r) => card(bySlug[r.slug], `Used ${ago(r.at)}`)).join('')
    : '<p class="status">Tools you open will show up here.</p>';

  const sc = store.scenarios();
  $('#scenarios').innerHTML = sc.length ? `<thead><tr><th>Name</th><th>Tool</th><th>Saved</th><th></th></tr></thead><tbody>${sc.map((s) => {
    const url = store.safeLocalUrl(s.url);
    return `<tr data-id="${esc(s.id)}"><td>${url ? `<a href="${esc(BASE + url.replace(BASE, ''))}">${esc(s.name)}</a>` : esc(s.name)}</td><td>${esc(bySlug[s.tool]?.title || s.tool)}</td><td>${esc(new Date(s.savedAt).toLocaleDateString())}</td>
      <td style="text-align:right"><button class="icon-btn" data-rename aria-label="Rename">✎</button><button class="icon-btn" data-del aria-label="Delete">✕</button></td></tr>`;
  }).join('')}</tbody>` : '<tbody><tr><td class="status" style="text-align:left">No saved scenarios yet.</td></tr></tbody>';

  const done = store.checkup();
  $('#checkup').innerHTML = CHECKUP.map((c, i) => {
    const t = bySlug[c.tool];
    return `<li class="file" style="grid-template-columns:auto 1fr auto">
      <input type="checkbox" data-step="${c.id}" ${done[c.id] ? 'checked' : ''} aria-label="Mark step ${i + 1} done" style="width:20px;height:20px;accent-color:var(--ember)">
      <div><div class="name" style="white-space:normal">${i + 1}. ${esc(c.title)}</div><div class="meta" style="font-family:var(--font)">${esc(c.why)}</div></div>
      ${t ? `<a class="btn sm ${done[c.id] ? 'ghost' : ''}" href="${esc(link(t.href))}">${done[c.id] ? 'Revisit' : 'Start'}</a>` : ''}</li>`;
  }).join('');
  const n = CHECKUP.filter((c) => done[c.id]).length;
  $('#ck-h').textContent = `✅ Money checkup — ${n}/${CHECKUP.length} done`;
}

document.addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (row && e.target.closest('[data-del]')) { if (confirm('Delete this saved scenario?')) { store.deleteScenario(row.dataset.id); render(); } }
  if (row && e.target.closest('[data-rename]')) {
    const s = store.scenarios().find((x) => x.id === row.dataset.id);
    const name = prompt('New name:', s?.name || ''); if (name) { store.updateScenario(row.dataset.id, { name: name.slice(0, 80) }); render(); }
  }
});
document.addEventListener('change', (e) => { const s = e.target.dataset?.step; if (s) { store.setCheck(s, e.target.checked); render(); } });

$('#export').onclick = () => downloadBlob(new Blob([JSON.stringify(store.exportAll(), null, 2)], { type: 'application/json' }), `privyforge-backup-${new Date().toISOString().slice(0, 10)}.json`);
$('#import').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { store.importAll(JSON.parse(await f.text())); $('#bk-status').textContent = 'Restored ✓'; render(); }
  catch (err) { $('#bk-status').textContent = err.message; $('#bk-status').classList.add('err'); }
  e.target.value = '';
};
$('#clear').onclick = () => { if (confirm('Remove all favorites, history, scenarios and checkup progress from this browser?')) { store.clearAll(); render(); } };

render();
