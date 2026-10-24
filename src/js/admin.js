// PrivyForge admin. Static page: talks only to api.github.com with a token kept in this browser.
import { marked } from 'marked';
import { GitHub } from './lib/github.js';
import { parseGuide, serializeGuide, slugify, wordCount } from './lib/guide-format.js';
import { parseCSV } from './lib/subscriptions.js';
import { lineChart, money } from './lib/chart.js';
import { $, setupDropzone, downloadBlob } from './util.js';

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isHttps = (u) => !u || /^https:\/\/[^\s"'<>]+$/i.test(u);
const CONN_KEY = 'pf-admin:conn', REV_KEY = 'pf-admin:revenue';
const ls = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } } };
const ss = { get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } } };

let gh, site, tools, guides = [], current = null;

function toast(msg, ok = true) {
  const t = $('#toast'); t.hidden = false; t.textContent = msg;
  t.style.background = ok ? '' : 'var(--ember-soft)'; t.style.color = ok ? '' : 'var(--err)';
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 6000);
}
async function guard(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { console.error(e); toast(e.message, false); } finally { btn.disabled = false; }
}

// ---------------- Connect
const cf = $('#connect-form');
const saved = ss.get(CONN_KEY) || ls.get(CONN_KEY, null);
cf.repo.value = saved?.repo || __REPO__;
cf.branch.value = saved?.branch || 'main';
if (saved?.token) { cf.token.value = saved.token; cf.remember.checked = !!ls.get(CONN_KEY, null); }

$('#connect-btn').onclick = () => guard($('#connect-btn'), async () => {
  $('#connect-status').textContent = 'Checking token…';
  gh = new GitHub({ repo: cf.repo.value.trim(), branch: cf.branch.value.trim() || 'main', token: cf.token.value.trim() });
  const repo = await gh.verify();
  if (repo.permissions && !repo.permissions.push) throw new Error('This token can read the repo but not write to it. Give it "Contents: Read and write".');
  const conn = { repo: gh.repo, branch: gh.branch, token: gh.token };
  ss.set(CONN_KEY, conn);
  if (cf.remember.checked) ls.set(CONN_KEY, conn); else { try { localStorage.removeItem(CONN_KEY); } catch { /* */ } }
  await loadAll();
  $('#connect').hidden = true; $('#app').hidden = false;
  $('#who').textContent = `${gh.repo} · ${gh.branch}`;
  $('#actions-link').href = `https://github.com/${gh.repo}/actions`;
  $('#connect-status').textContent = '';
});
if (saved?.token) $('#connect-btn').click();

$('#logout').onclick = () => {
  try { sessionStorage.removeItem(CONN_KEY); localStorage.removeItem(CONN_KEY); } catch { /* */ }
  location.reload();
};

async function loadAll() {
  const [s, t] = await Promise.all([gh.read('src/data/site.json'), gh.read('src/data/tools.json')]);
  site = { sha: s.sha, data: JSON.parse(s.text) };
  tools = { sha: t.sha, data: JSON.parse(t.text) };
  fillSettings(); renderTools(); await loadGuides(); renderRevenue(); renderPro(); deployStatus();
}

async function deployStatus() {
  const runs = await gh.runs();
  if (!runs?.length) { $('#deploys').textContent = runs ? '' : 'Tip: give the token "Actions: Read" to see deploy status here.'; return; }
  const r = runs[0];
  const state = r.status !== 'completed' ? '⏳ deploying…' : r.conclusion === 'success' ? '✅ live' : `⚠️ ${r.conclusion}`;
  $('#deploys').innerHTML = `Last deploy: <b>${esc(state)}</b> — “${esc(r.display_title || r.name)}” · ${esc(new Date(r.created_at).toLocaleString())} · <a href="${esc(r.html_url)}" target="_blank" rel="noopener">details</a>`;
  if (r.status !== 'completed') setTimeout(deployStatus, 15000);
}
async function commit(path, text, message, sha) {
  const res = await gh.write(path, text, `Admin: ${message}`, sha);
  toast(`Saved — committed to ${gh.branch}. The site will redeploy in about a minute.`);
  setTimeout(deployStatus, 4000);
  return res.content.sha;
}

// ---------------- Tabs
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-tab]').forEach((x) => { const on = x === b; x.setAttribute('aria-selected', on); x.classList.toggle('ghost', !on); });
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab; });
  if (b.dataset.tab === 'traffic') renderRevenue();
}));

// ---------------- Settings
const sf = $('#settings-form');
function fillSettings() {
  const d = site.data;
  sf.adsenseClient.value = d.ads?.adsenseClient || '';
  sf['slot_tool-below'].value = d.ads?.slots?.['tool-below'] || '';
  sf['slot_content-mid'].value = d.ads?.slots?.['content-mid'] || '';
  sf.contactEmail.value = d.contactEmail || '';
  sf.announcement.value = d.announcement || '';
  sf.checkoutUrl.value = d.pro?.checkoutUrl || '';
  sf.crypto.value = (d.support?.crypto || []).map((c) => `${c.chain} | ${c.address}`).join('\n');
  $('#aff-table tbody').innerHTML = Object.entries(d.affiliates || {}).map(([k, v]) => `<tr data-key="${esc(k)}"><td><code>${esc(k)}</code></td><td><input data-f="label" value="${esc(v.label)}"></td><td><input data-f="url" value="${esc(v.url)}" placeholder="https://"></td></tr>`).join('');
  $('#support-table tbody').innerHTML = (d.support?.links || []).map((l) => `<tr><td><input data-f="label" value="${esc(l.label)}"></td><td><input data-f="url" value="${esc(l.url)}" placeholder="https://"></td></tr>`).join('');
}
function readSettings() {
  const errs = [];
  const d = structuredClone(site.data);
  const client = sf.adsenseClient.value.trim();
  if (client && !/^ca-pub-\d{10,20}$/.test(client)) errs.push('AdSense ID should look like ca-pub-1234567890123456.');
  const slots = { 'tool-below': sf['slot_tool-below'].value.trim(), 'content-mid': sf['slot_content-mid'].value.trim() };
  for (const [k, v] of Object.entries(slots)) if (v && !/^\d{6,12}$/.test(v)) errs.push(`Ad unit "${k}" should be digits only.`);
  d.ads = { adsenseClient: client, slots };
  for (const tr of $('#aff-table tbody').rows) {
    const url = tr.querySelector('[data-f=url]').value.trim();
    if (!isHttps(url)) errs.push(`Affiliate ${tr.dataset.key}: links must start with https://`);
    d.affiliates[tr.dataset.key] = { label: tr.querySelector('[data-f=label]').value.trim(), url };
  }
  d.support = d.support || {};
  d.support.links = [...$('#support-table tbody').rows].map((tr) => ({ label: tr.querySelector('[data-f=label]').value.trim(), url: tr.querySelector('[data-f=url]').value.trim() }));
  d.support.links.forEach((l) => { if (!isHttps(l.url)) errs.push(`Support "${l.label}": links must start with https://`); });
  d.support.crypto = sf.crypto.value.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter(([c, a]) => c && a)
    .map(([chain, address]) => {
      if (!/^[A-Za-z0-9:._-]{20,120}$/.test(address)) errs.push(`Crypto address for ${chain} looks invalid.`);
      return { chain: chain.slice(0, 40), address };
    });
  const checkout = sf.checkoutUrl.value.trim();
  if (!isHttps(checkout)) errs.push('Pro checkout URL must start with https://');
  d.pro = { ...(d.pro || {}), checkoutUrl: checkout };
  const email = sf.contactEmail.value.trim();
  if (email && !/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(email)) errs.push('Contact email looks invalid.');
  d.contactEmail = email;
  d.announcement = sf.announcement.value.trim().slice(0, 160);
  return { d, errs };
}
$('#save-settings').onclick = () => guard($('#save-settings'), async () => {
  const { d, errs } = readSettings();
  if (errs.length) { $('#settings-status').textContent = errs.join(' '); $('#settings-status').classList.add('err'); return; }
  $('#settings-status').textContent = ''; $('#settings-status').classList.remove('err');
  site.sha = await commit('src/data/site.json', `${JSON.stringify(d, null, 2)}\n`, 'update site settings', site.sha);
  site.data = d; renderPro();
});

// ---------------- Tools
function renderTools() {
  $('#tools-table tbody').innerHTML = tools.data.map((t, i) => `<tr data-i="${i}">
    <td style="white-space:nowrap"><button class="icon-btn" data-move="-1" aria-label="Move up" ${i ? '' : 'disabled'}>↑</button><button class="icon-btn" data-move="1" aria-label="Move down" ${i < tools.data.length - 1 ? '' : 'disabled'}>↓</button></td>
    <td><input type="checkbox" data-f="enabled" ${t.enabled !== false ? 'checked' : ''} aria-label="Show ${esc(t.title)}" style="width:18px;min-width:0"></td>
    <td><input type="checkbox" data-f="featured" ${t.featured ? 'checked' : ''} aria-label="Feature ${esc(t.title)}" style="width:18px;min-width:0"></td>
    <td><input data-f="title" value="${esc(t.title)}" maxlength="40"></td>
    <td><input data-f="blurb" value="${esc(t.blurb)}" maxlength="90" style="min-width:240px"></td>
    <td><small>${esc(t.category)}</small></td></tr>`).join('');
}
function syncTools() {
  for (const tr of $('#tools-table tbody').rows) {
    const t = tools.data[+tr.dataset.i];
    t.enabled = tr.querySelector('[data-f=enabled]').checked; t.featured = tr.querySelector('[data-f=featured]').checked;
    t.title = tr.querySelector('[data-f=title]').value.trim() || t.title; t.blurb = tr.querySelector('[data-f=blurb]').value.trim();
  }
}
$('#tools-table').addEventListener('click', (e) => {
  const b = e.target.closest('[data-move]'); if (!b) return;
  syncTools();
  const i = +b.closest('tr').dataset.i, j = i + +b.dataset.move;
  [tools.data[i], tools.data[j]] = [tools.data[j], tools.data[i]]; renderTools();
});
$('#save-tools').onclick = () => guard($('#save-tools'), async () => {
  syncTools();
  tools.sha = await commit('src/data/tools.json', `${JSON.stringify(tools.data, null, 2)}\n`, 'update tools', tools.sha);
  $('#tools-status').textContent = `${tools.data.filter((t) => t.enabled !== false).length} tools shown.`;
});

// ---------------- Guides
const gf = $('#guide-form');
async function loadGuides() {
  gf.tool.innerHTML = '<option value="">— none —</option>' + tools.data.filter((t) => !t.href.includes('?')).map((t) => `<option value="${esc(t.href)}">${esc(t.title)}</option>`).join('');
  const files = (await gh.list('content/guides')).filter((f) => f.name.endsWith('.md'));
  guides = files.map((f) => ({ path: f.path, slug: f.name.replace(/\.md$/, ''), sha: f.sha }));
  renderGuideList();
}
function renderGuideList() {
  $('#guide-list').innerHTML = guides.length ? guides.map((g) => `<li class="file" style="grid-template-columns:1fr auto"><div class="name">${esc(g.slug)}</div><button class="btn sm ghost" data-open="${esc(g.slug)}">Edit</button></li>`).join('')
    : '<li class="status">No guides yet.</li>';
}
$('#guide-list').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) guard(b, () => openGuide(b.dataset.open)); });
$('#new-guide').onclick = () => {
  current = { slug: '', sha: null, isNew: true };
  gf.reset(); delete gf.slug.dataset.touched;
  gf.date.value = new Date().toISOString().slice(0, 10);
  gf.body.value = '## First section\n\nWrite in plain language. Answer the searcher\'s question in the first two sentences.\n\n## Second section\n\n…';
  $('#editor').hidden = false; $('#delete-guide').hidden = true; preview(); gf.title.focus();
};
async function openGuide(slug) {
  const g = guides.find((x) => x.slug === slug);
  const { text, sha } = await gh.read(g.path);
  const { meta, body } = parseGuide(text);
  current = { slug, sha, isNew: false };
  gf.title.value = meta.title || ''; gf.description.value = meta.description || ''; gf.slug.value = slug;
  gf.date.value = meta.date || ''; gf.tool.value = meta.tool || ''; gf.draft.checked = meta.draft === 'true'; gf.body.value = body;
  $('#editor').hidden = false; $('#delete-guide').hidden = false; preview();
}
// Preview: admin's own content, but still strip scripts/handlers so a pasted snippet can't run.
function sanitize(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,iframe,object,embed,style,link,meta').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((n) => [...n.attributes].forEach((a) => {
    if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name);
  }));
  return doc.body.innerHTML;
}
function preview() {
  const t = gf.title.value, d = gf.description.value;
  $('#t-count').textContent = `${t.length}/60`; $('#t-count').style.color = t.length > 60 ? 'var(--err)' : '';
  $('#d-count').textContent = `${d.length}/155`; $('#d-count').style.color = d.length > 155 || (d && d.length < 70) ? 'var(--warn)' : '';
  const words = wordCount(gf.body.value);
  $('#w-count').textContent = `${words} words${words < 600 ? ' — aim for 900+' : ''}`;
  if (current?.isNew && !gf.slug.dataset.touched) gf.slug.value = slugify(t);
  $('#preview').innerHTML = `<h1>${esc(t || 'Untitled')}</h1>${d ? `<p class="lede">${esc(d)}</p>` : ''}${sanitize(marked.parse(gf.body.value || ''))}`;
}
gf.addEventListener('input', (e) => { if (e.target.name === 'slug') gf.slug.dataset.touched = '1'; preview(); });
$('#save-guide').onclick = () => guard($('#save-guide'), async () => {
  const slug = slugify(gf.slug.value || gf.title.value);
  if (!gf.title.value.trim() || !slug) throw new Error('A guide needs a title.');
  if (current.isNew && guides.some((g) => g.slug === slug)) throw new Error(`A guide called "${slug}" already exists.`);
  const text = serializeGuide({ title: gf.title.value, description: gf.description.value, date: gf.date.value, tool: gf.tool.value, draft: gf.draft.checked }, gf.body.value);
  const path = `content/guides/${slug}.md`;
  if (!current.isNew && slug !== current.slug) { // renamed: create new, delete old
    await gh.write(path, text, `Admin: rename guide ${current.slug} → ${slug}`);
    await gh.remove(`content/guides/${current.slug}.md`, `Admin: rename guide ${current.slug} → ${slug}`, current.sha);
    toast('Guide renamed and saved.'); await loadGuides(); return openGuide(slug);
  }
  const sha = await commit(path, text, `${current.isNew ? 'add' : 'update'} guide ${slug}${gf.draft.checked ? ' (draft)' : ''}`, current.sha);
  current = { slug, sha, isNew: false };
  $('#guide-status').textContent = gf.draft.checked ? 'Saved as draft (not published).' : `Published at /blog/${slug}/ after deploy.`;
  await loadGuides();
});
$('#delete-guide').onclick = () => guard($('#delete-guide'), async () => {
  if (!current?.sha || !confirm(`Delete "${current.slug}" from the site?`)) return;
  await gh.remove(`content/guides/${current.slug}.md`, `Admin: delete guide ${current.slug}`, current.sha);
  toast('Guide deleted.'); $('#editor').hidden = true; current = null; await loadGuides();
});

// ---------------- Traffic & revenue (local only)
const rf = $('#rev-form');
const revenue = () => ls.get(REV_KEY, []).sort((a, b) => a.month.localeCompare(b.month));
const n = (v) => parseFloat(String(v).replace(/[^\d.]/g, '')) || 0;
$('#rev-add').onclick = () => {
  if (!rf.month.value) return rf.month.focus();
  const row = { month: rf.month.value, pageviews: n(rf.pageviews.value), ads: n(rf.ads.value), aff: n(rf.aff.value), pro: n(rf.pro.value) };
  ls.set(REV_KEY, [...revenue().filter((r) => r.month !== row.month), row]); rf.reset(); renderRevenue();
};
function renderRevenue() {
  const rows = revenue();
  const tot = (r) => r.ads + r.aff + r.pro, rpm = (r) => (r.pageviews ? (tot(r) / r.pageviews) * 1000 : 0);
  const last = rows.at(-1), prev = rows.at(-2);
  const growth = last && prev && tot(prev) ? Math.round((tot(last) / tot(prev) - 1) * 100) : null;
  $('#rev-kpis').innerHTML = last ? [
    ['big', `Revenue ${last.month}`, money(tot(last))],
    ['', 'RPM', money(rpm(last), 2)],
    ['', 'Pageviews', last.pageviews.toLocaleString()],
    ['', 'vs. previous month', growth === null ? '—' : `${growth >= 0 ? '+' : ''}${growth}%`],
    ['', 'Annual run-rate', money(tot(last) * 12)],
    ['', 'All-time', money(rows.reduce((s, r) => s + tot(r), 0))],
  ].map(([c, k, v]) => `<div class="kpi ${c}"><span>${k}</span><b>${v}</b></div>`).join('') : '<p class="status">Add your first month above. Numbers stay in this browser; export a CSV to back them up.</p>';
  $('#rev-table').innerHTML = rows.length ? `<thead><tr><th>Month</th><th>Pageviews</th><th>Ads</th><th>Affiliate</th><th>Pro/tips</th><th>Total</th><th>RPM</th><th></th></tr></thead><tbody>${[...rows].reverse().map((r) => `<tr><td>${esc(r.month)}</td><td>${r.pageviews.toLocaleString()}</td><td>${money(r.ads, 2)}</td><td>${money(r.aff, 2)}</td><td>${money(r.pro, 2)}</td><td><b>${money(tot(r), 2)}</b></td><td>${money(rpm(r), 2)}</td><td><button class="icon-btn" data-delmonth="${esc(r.month)}" aria-label="Delete ${esc(r.month)}">✕</button></td></tr>`).join('')}</tbody>` : '';
  if (!$('[data-panel=traffic]').hidden) lineChart($('#rev-chart'), [{ values: rows.map(tot), color: '--ember' }, { values: rows.map((r) => rpm(r) * 10), color: '--ok' }], { xLabel: (i) => rows[i]?.month.slice(2) || '', xStep: Math.max(1, Math.ceil(rows.length / 8)) });
}
$('#rev-table').addEventListener('click', (e) => { const m = e.target.closest('[data-delmonth]')?.dataset.delmonth; if (m && confirm(`Delete ${m}?`)) { ls.set(REV_KEY, revenue().filter((r) => r.month !== m)); renderRevenue(); } });
$('#rev-export').onclick = () => downloadBlob(new Blob([['month,pageviews,ads,affiliate,pro', ...revenue().map((r) => [r.month, r.pageviews, r.ads, r.aff, r.pro].join(','))].join('\n')], { type: 'text/csv' }), 'privyforge-revenue.csv');
$('#rev-import').onchange = async (e) => {
  const rows = parseCSV(await e.target.files[0].text()).slice(1).filter((r) => /^\d{4}-\d{2}$/.test(r[0]));
  const merged = Object.fromEntries(revenue().map((r) => [r.month, r]));
  for (const r of rows) merged[r[0]] = { month: r[0], pageviews: n(r[1]), ads: n(r[2]), aff: n(r[3]), pro: n(r[4]) };
  ls.set(REV_KEY, Object.values(merged)); renderRevenue(); e.target.value = ''; toast(`Imported ${rows.length} months.`);
};

// Search Console export -> opportunities (pages/queries ranking 4–20 with weak CTR)
setupDropzone($('#gsc-drop'), { accept: '.csv,text/csv', onFiles: async (files) => {
  let html = '';
  for (const f of files) {
    const rows = parseCSV(await f.text());
    const h = rows[0].map((x) => x.toLowerCase());
    const col = (re) => h.findIndex((x) => re.test(x));
    const [k, c, i, ctr, pos] = [col(/quer|page/), col(/click/), col(/impress/), col(/ctr/), col(/position/)];
    if (k < 0 || i < 0) { html += `<p class="status err">${esc(f.name)}: not a Search Console export.</p>`; continue; }
    const data = rows.slice(1).map((r) => ({ key: r[k], clicks: n(r[c]), impr: n(r[i]), ctr: n(r[ctr]), pos: n(r[pos]) }));
    const opp = data.filter((d) => d.pos >= 4 && d.pos <= 20 && d.impr >= 50).sort((a, b) => b.impr - a.impr).slice(0, 15);
    const kind = /page/.test(h[k]) ? 'pages' : 'queries';
    const totals = data.reduce((s, d) => ({ clicks: s.clicks + d.clicks, impr: s.impr + d.impr }), { clicks: 0, impr: 0 });
    html += `<h3>${esc(f.name)} — ${data.length} ${kind}, ${totals.clicks.toLocaleString()} clicks, ${totals.impr.toLocaleString()} impressions</h3>
      <p class="status">Top opportunities: ranking on page 1–2 with real impressions. Improve the title/description or add a section answering this ${kind === 'pages' ? 'page\'s main question' : 'query'}.</p>
      <div class="table-scroll"><table><thead><tr><th>${kind === 'pages' ? 'Page' : 'Query'}</th><th>Impressions</th><th>Clicks</th><th>CTR</th><th>Position</th></tr></thead><tbody>${opp.map((d) => `<tr><td style="text-align:left;white-space:normal">${esc(d.key)}</td><td>${d.impr.toLocaleString()}</td><td>${d.clicks}</td><td>${d.ctr.toFixed(1)}%</td><td>${d.pos.toFixed(1)}</td></tr>`).join('') || '<tr><td colspan="5">No page-1/2 opportunities yet — keep publishing.</td></tr>'}</tbody></table></div>`;
  }
  $('#gsc-out').innerHTML = html;
} });

// ---------------- Pro
function renderPro() {
  const d = site?.data || {};
  const proBtn = (d.support?.links || []).find((l) => /pro|ad-free/i.test(l.label));
  $('#pro-status').innerHTML = [
    ['Checkout link', d.pro?.checkoutUrl ? '✅ set' : '— not set'],
    ['Support page "Pro" button', proBtn?.url ? '✅ set' : '— not set'],
    ['Customer data stored here', 'None (by design)'],
  ].map(([k, v]) => `<div class="kpi"><span>${k}</span><b style="font-size:1rem">${v}</b></div>`).join('');
}
addEventListener('resize', () => { if (!$('[data-panel=traffic]').hidden) renderRevenue(); });
