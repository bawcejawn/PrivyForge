// Organize PDF — rotate, reorder and delete pages, then save. Thumbnails come from pdf.js
// (rendered lazily as cards scroll into view); the output is written with pdf-lib by copying
// the original pages and setting /Rotate. Nothing is rasterized. Logic: lib/pdf-organize.js.
import '../css/organize.css';
import { $, downloadBlob, baseName, setupDropzone, formatBytes } from './util.js';
import { loadPdf, openForRender } from './pdf-common.js';
import {
  makePages, rotatePage, movePage, parsePageNumbers, deleteNumbers, resetPages, buildPlan, summarize, assemble, normRotation,
} from './lib/pdf-organize.js';

const drop = $('#drop'), editor = $('#editor'), grid = $('#grid'), status = $('#status'), info = $('#info');
const rangeInput = $('#del-range'), addInput = $('#add-input');
const say = (msg, err = false) => { status.textContent = msg; status.classList.toggle('err', err); };

const THUMB_PX = 240; // longest thumbnail edge in device pixels (cap; ≈120 CSS px at 2x)
const state = { files: [], pages: [] }; // files: { file, bytes, lib (pdf-lib doc), render (pdf.js doc), sizes }

// ------------------------------------------------------------------ loading
setupDropzone(drop, { accept: 'application/pdf,.pdf', multiple: false, onFiles: ([f]) => openFile(f, false) });
$('#add').onclick = () => addInput.click();
addInput.addEventListener('change', async () => {
  for (const f of [...addInput.files]) await openFile(f, true);
  addInput.value = '';
});
$('#another').onclick = () => {
  if (summarize(state.pages).changed && !confirm('Discard your changes and choose another PDF?')) return;
  clear(); drop.hidden = false; editor.hidden = true; say(''); drop.focus();
};

function clear() {
  for (const f of state.files) f.render?.destroy();
  for (const p of state.pages) obs.unobserve(p.el);
  state.files = []; state.pages = []; grid.replaceChildren(); queue.length = 0; visible.clear();
}

async function openFile(file, append) {
  say(append ? `Adding ${file.name}…` : 'Opening…');
  try {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error('This file does not look like a valid PDF.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const lib = await loadPdf(bytes); // throws the shared "password-protected" message for encrypted files
    const sizes = lib.getPages().map((p) => {
      const { width, height } = p.getSize();
      return normRotation(p.getRotation().angle) % 180 ? [height, width] : [width, height];
    });
    if (!sizes.length) throw new Error('This PDF has no pages.');
    if (!append) clear();
    const src = state.files.length;
    const entry = { file, bytes, lib, sizes, render: null };
    state.files.push(entry);
    const pages = makePages(sizes.length, src, state.pages.length + 1);
    for (const p of pages) { p.el = makeCard(p); state.pages.push(p); grid.append(p.el); obs.observe(p.el); }
    drop.hidden = true; editor.hidden = false;
    refresh();
    say(append ? `Added ${pages.length} page${pages.length > 1 ? 's' : ''} from ${file.name}.` : 'Rotate, drag or delete pages, then click "Save PDF".');
    openForRender(bytes).then((doc) => {
      if (!state.files.includes(entry)) return doc.destroy();
      entry.render = doc;
      for (const p of state.pages) if (p.src === src && visible.has(p.el)) enqueue(p.el);
      pump();
    }).catch((e) => console.warn('thumbnails unavailable', e));
  } catch (e) {
    say(`${file.name}: ${e.message}`, true);
  }
}

// ------------------------------------------------------------------ cards
const byEl = new WeakMap();
const fileOf = (p) => state.files[p.src];

function makeCard(p) {
  const li = document.createElement('li');
  li.className = 'org-card'; li.tabIndex = 0; li.draggable = true; li.dataset.id = p.id;
  li.innerHTML = `
    <div class="org-thumb"><canvas aria-hidden="true"></canvas><span class="org-gone" aria-hidden="true">Deleted</span></div>
    <div class="org-row">
      <button type="button" class="org-btn" data-act="earlier">‹</button>
      <span class="org-no"></span>
      <button type="button" class="org-btn" data-act="later">›</button>
    </div>
    <div class="org-row">
      <button type="button" class="org-btn" data-act="left">↺</button>
      <button type="button" class="org-btn" data-act="right">↻</button>
      <button type="button" class="org-btn org-del" data-act="delete">✕</button>
    </div>`;
  const [w, h] = fileOf(p).sizes[p.index];
  const c = li.querySelector('canvas'), k = 60 / Math.max(w, h);
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k)); // placeholder shape
  if (state.files.length > 1 || p.src > 0) li.title = fileOf(p).file.name;
  byEl.set(li, p);
  return li;
}

function paint(p, pos, total) {
  const n = p.number, li = p.el, r = normRotation(p.rotate);
  li.classList.toggle('deleted', p.deleted);
  li.style.setProperty('--r', `${p.turn || 0}deg`); // keeps counting past 360 so turns animate forward
  li.querySelector('.org-no').textContent = r ? `${n} · ${r}°` : String(n);
  li.setAttribute('aria-label', `Page ${n}, position ${pos} of ${total}${r ? `, rotated ${r}° clockwise` : ''}${p.deleted ? ', deleted' : ''}. Alt+Left or Alt+Right moves it.`);
  const set = (act, label, text) => { const b = li.querySelector(`[data-act=${act}]`); b.setAttribute('aria-label', label); b.title = label; if (text) b.textContent = text; return b; };
  set('earlier', `Move page ${n} earlier`).disabled = pos === 1;
  set('later', `Move page ${n} later`).disabled = pos === total;
  set('left', `Rotate page ${n} left`); set('right', `Rotate page ${n} right`);
  const del = set('delete', p.deleted ? `Restore page ${n}` : `Delete page ${n}`, p.deleted ? 'Undo' : '✕');
  del.setAttribute('aria-pressed', String(p.deleted));
}

function refresh() {
  const total = state.pages.length;
  state.pages.forEach((p, i) => { if (grid.children[i] !== p.el) grid.insertBefore(p.el, grid.children[i] || null); paint(p, i + 1, total); });
  const s = summarize(state.pages);
  const names = state.files.map((f) => f.file.name).join(' + ');
  info.textContent = `${names} · ${s.kept} of ${s.total} page${s.total > 1 ? 's' : ''} kept${s.deleted ? ` · ${s.deleted} deleted` : ''}${s.rotated ? ` · ${s.rotated} rotated` : ''}${s.moved ? ' · reordered' : ''}`;
  for (const b of document.querySelectorAll('.org-save')) b.disabled = !s.kept;
  rangeInput.placeholder = `e.g. 3-5, ${Math.min(9, total)}`;
}

function move(p, to, announce = true) {
  const from = state.pages.indexOf(p);
  const focused = document.activeElement;
  movePage(state.pages, from, to);
  refresh();
  if (focused && p.el.contains(focused)) focused.focus();
  if (announce) say(`Page ${p.number} moved to position ${state.pages.indexOf(p) + 1}.`);
}

grid.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const p = byEl.get(btn.closest('.org-card')); const i = state.pages.indexOf(p);
  switch (btn.dataset.act) {
    case 'left': turn(p, -90); break;
    case 'right': turn(p, 90); break;
    case 'delete': p.deleted = !p.deleted; say(p.deleted ? `Page ${p.number} will be left out. Click Undo to keep it.` : `Page ${p.number} restored.`); break;
    case 'earlier': return move(p, i - 1);
    case 'later': return move(p, i + 1);
  }
  refresh();
});

grid.addEventListener('keydown', (e) => {
  if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
  const li = e.target.closest('.org-card'); if (!li) return;
  e.preventDefault();
  const p = byEl.get(li), i = state.pages.indexOf(p);
  move(p, i + (e.key === 'ArrowLeft' ? -1 : 1));
});

// Drag to reorder (mouse/pen). Cards move live; the array follows the DOM on drop.
let dragging = null;
grid.addEventListener('dragstart', (e) => {
  const li = e.target.closest?.('.org-card'); if (!li) return;
  dragging = li; li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', li.dataset.id); } catch { /* old browsers */ }
});
grid.addEventListener('dragover', (e) => {
  if (!dragging) return;
  e.preventDefault();
  const li = e.target.closest('.org-card'); if (!li || li === dragging) return;
  const r = li.getBoundingClientRect();
  li[e.clientX > r.left + r.width / 2 ? 'after' : 'before'](dragging);
});
grid.addEventListener('drop', (e) => { if (dragging) e.preventDefault(); });
grid.addEventListener('dragend', () => {
  if (!dragging) return;
  const p = byEl.get(dragging);
  dragging.classList.remove('dragging'); dragging = null;
  const order = [...grid.children];
  state.pages.sort((a, b) => order.indexOf(a.el) - order.indexOf(b.el));
  refresh();
  say(`Page ${p.number} moved to position ${state.pages.indexOf(p) + 1}.`);
});

// ------------------------------------------------------------------ toolbar
function turn(p, delta) { rotatePage(p, delta); p.turn = (p.turn || 0) + delta; }
function rotateAll(delta) {
  for (const p of state.pages) turn(p, delta);
  refresh(); say(`Rotated every page ${delta > 0 ? 'right' : 'left'}.`);
}
$('#rot-left').onclick = () => rotateAll(-90);
$('#rot-right').onclick = () => rotateAll(90);
$('#reset').onclick = () => {
  resetPages(state.pages); for (const p of state.pages) p.turn = 0;
  refresh(); say('Back to the original order, rotation and pages.');
};
$('#del-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const total = state.pages.length, nums = parsePageNumbers(rangeInput.value, total);
  if (!nums) return say(`Couldn't read those pages. Use page numbers from 1 to ${total}, like "3-5, 9".`, true);
  const n = deleteNumbers(state.pages, nums);
  refresh(); rangeInput.value = '';
  say(n ? `Deleted ${n} page${n > 1 ? 's' : ''} (${nums.join(', ')}). Use Undo on a card to bring one back.` : 'Those pages were already deleted.');
});

// ------------------------------------------------------------------ save
async function save() {
  const plan = buildPlan(state.pages);
  if (!plan.length) return say('Every page is deleted. Keep at least one page to save a PDF.', true);
  for (const b of document.querySelectorAll('.org-save')) b.disabled = true;
  say('Saving…');
  try {
    const out = await assemble(state.files.map((f) => f.lib), plan);
    out.setProducer('PrivyForge (in-browser)'); out.setCreator('PrivyForge');
    const bytes = await out.save({ useObjectStreams: true });
    const name = `${baseName(state.files[0].file.name)}-organized.pdf`;
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name);
    say(`Saved ${name}: ${plan.length} page${plan.length > 1 ? 's' : ''}, ${formatBytes(bytes.length)}. Nothing was uploaded.`);
  } catch (e) {
    console.error(e); say(e.message || 'Something went wrong while saving.', true);
  } finally { refresh(); }
}
for (const b of document.querySelectorAll('.org-save')) b.onclick = save;

// ------------------------------------------------------------------ lazy thumbnails
// Only cards near the viewport render, at most two at a time, so a 200-page PDF stays responsive.
const visible = new Set(), queue = [];
let active = 0;
const obs = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (en.isIntersecting) { visible.add(en.target); enqueue(en.target); } else visible.delete(en.target);
  }
  pump();
}, { rootMargin: '400px 0px' });

function enqueue(el) { if (!el.dataset.rendered && !queue.includes(el)) queue.push(el); }
function pump() {
  while (active < 2 && queue.length) {
    const el = queue.shift(), p = byEl.get(el);
    if (!p || el.dataset.rendered || !visible.has(el) || !fileOf(p)?.render) continue;
    active++;
    renderThumb(p).finally(() => { active--; pump(); });
  }
}

async function renderThumb(p) {
  const f = fileOf(p), doc = f.render;
  try {
    const page = await doc.getPage(p.index + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(1, THUMB_PX / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.round(vp.width)); tmp.height = Math.max(1, Math.round(vp.height));
    const ctx = tmp.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, tmp.width, tmp.height);
    await page.render({ canvasContext: ctx, viewport: vp, annotationMode: 1 }).promise;
    page.cleanup();
    if (!state.files.includes(f)) return;
    const c = p.el.querySelector('canvas');
    c.width = tmp.width; c.height = tmp.height; c.getContext('2d').drawImage(tmp, 0, 0);
    tmp.width = tmp.height = 0;
    p.el.dataset.rendered = '1';
  } catch (e) { if (state.files.includes(f)) console.warn('thumbnail failed', e); }
}
