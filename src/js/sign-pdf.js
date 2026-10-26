// Sign PDF — place a signature, initials, dates, text and checkmarks on a PDF, in the browser.
// Pages are rendered with pdf.js; the signed file is written with pdf-lib by drawing on top of
// the original pages (nothing is rasterized). Geometry lives in lib/pdf-sign.js (unit-tested).
import '../css/sign.css';
import { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix, LineCapStyle } from 'pdf-lib';
import { $, downloadBlob, baseName, setupDropzone, formatBytes } from './util.js';
import { loadPdf, openForRender, renderPage } from './pdf-common.js';
import {
  pageFrame, itemMatrix, clientToDisplay, clampBox, boxAt, clamp, formatDate, todayISO, DATE_FORMATS,
  removeWhite, inkBounds, strokeWidth,
} from './lib/pdf-sign.js';
import { unencodable } from './lib/pdf-form.js';

const drop = $('#drop'), editor = $('#editor'), pagesEl = $('#pages'), status = $('#status');
const props = $('#props'), fileLabel = $('#file-label');
const say = (msg, err = false) => { status.textContent = msg; status.classList.toggle('err', err); };

// Sticky panels sit below the site's sticky header; track its height.
const syncHeader = () => document.documentElement.style.setProperty('--pf-hdr', `${document.querySelector('.site-header')?.offsetHeight || 0}px`);
syncHeader(); window.addEventListener('resize', syncHeader);

const LH = 1.2;          // text line height (× font size), same in CSS
const BASELINE = 0.93;   // baseline offset from a line's top (× font size), ≈ Arial/Helvetica on screen
const STORE_KEY = 'privyforge.signature.v1';

const state = {
  file: null, bytes: null, frames: [], renderDoc: null,
  items: [], selected: null, armed: null, nextId: 1,
  assets: { signature: null, initials: null }, // { url, aspect }
  font: null,
};

// ------------------------------------------------------------------ text metrics (= export font)
const metricsP = (async () => {
  const d = await PDFDocument.create();
  state.font = await d.embedFont(StandardFonts.Helvetica);
})();
function textWidth(line, size) {
  try { return state.font.widthOfTextAtSize(line, size); } catch { return line.length * size * 0.55; }
}
function textBox(text, size) {
  const lines = String(text).split('\n');
  return { w: Math.max(size * 0.6, ...lines.map((l) => textWidth(l, size))) + 1, h: lines.length * size * LH };
}

// ------------------------------------------------------------------ remembered signature
function loadStored() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (s && typeof s === 'object') {
      for (const k of ['signature', 'initials']) {
        const a = s[k];
        if (a && typeof a.url === 'string' && a.url.startsWith('data:image/png;base64,') && a.aspect > 0) state.assets[k] = a;
      }
      return true;
    }
  } catch { /* storage unavailable */ }
  return false;
}
function saveStored(remember) {
  try {
    remembered = remember;
    if (remember) localStorage.setItem(STORE_KEY, JSON.stringify(state.assets));
    else localStorage.removeItem(STORE_KEY);
  } catch { /* private mode or full: just don't remember */ }
}
let remembered = loadStored() && !!(state.assets.signature || state.assets.initials);

// ------------------------------------------------------------------ loading
setupDropzone(drop, { accept: 'application/pdf,.pdf', multiple: false, onFiles: ([f]) => open(f) });
$('#reset').onclick = () => { if (!state.items.length || confirm('Remove all placed items and choose another PDF?')) reset(); };

function reset() {
  state.renderDoc?.destroy(); state.renderDoc = null;
  Object.assign(state, { file: null, bytes: null, frames: [], items: [], selected: null });
  pagesEl.querySelectorAll('.sign-page').forEach((el) => { renderObs.unobserve(el); sizeObs.unobserve(el); });
  pagesEl.replaceChildren(); editor.hidden = true; drop.hidden = false; arm(null); showProps(); say('');
}

async function open(file) {
  say('Opening…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await loadPdf(bytes);
    const frames = doc.getPages().map((p) => {
      const b = p.getCropBox();
      return pageFrame([b.x, b.y, b.x + b.width, b.y + b.height], p.getRotation().angle);
    });
    reset();
    Object.assign(state, { file, bytes, frames });
    state.renderDoc = await openForRender(bytes);
    fileLabel.textContent = `${file.name} · ${frames.length} page${frames.length > 1 ? 's' : ''} · ${formatBytes(file.size)}`;
    drop.hidden = true; editor.hidden = false;
    buildPages();
    say('Choose what to add, then click or tap on a page to place it.');
  } catch (e) { console.error(e); say(`${file.name}: ${e.message}`, true); }
}

// ------------------------------------------------------------------ page rendering (lazy, responsive)
const renderObs = new IntersectionObserver((entries) => {
  for (const en of entries) if (en.isIntersecting) renderInto(en.target);
}, { rootMargin: '600px 0px' });
const sizeObs = new ResizeObserver((entries) => {
  for (const en of entries) {
    const el = en.target, f = state.frames[+el.dataset.page];
    if (!f) continue;
    el.style.setProperty('--s', String(el.clientWidth / f.width)); // CSS px per PDF point
    const want = el.clientWidth * (window.devicePixelRatio || 1);
    if (el.dataset.rendered && Math.abs(want - +el.dataset.rendered) / want > 0.2) renderInto(el, true);
  }
});

function buildPages() {
  state.frames.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = 'sign-page'; el.dataset.page = i;
    el.style.aspectRatio = `${f.width} / ${f.height}`;
    el.innerHTML = `<canvas aria-hidden="true"></canvas><div class="sign-layer" tabindex="0"></div><span class="sign-pno">Page ${i + 1} of ${state.frames.length}</span>`;
    const layer = el.querySelector('.sign-layer');
    layer.setAttribute('aria-label', `Page ${i + 1}. With an item chosen, click here or press Enter to place it.`);
    layer.addEventListener('click', (e) => onLayerClick(e, i, el));
    layer.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === layer && state.armed) {
        e.preventDefault(); place(state.armed, i, f.width / 2, f.height / 2);
      }
    });
    pagesEl.append(el);
    renderObs.observe(el); sizeObs.observe(el);
  });
}

const rendering = new WeakMap();
async function renderInto(el, force = false) {
  if (!state.renderDoc || (el.dataset.rendered && !force) || rendering.get(el)) return;
  rendering.set(el, true);
  const doc = state.renderDoc;
  try {
    const page = await doc.getPage(+el.dataset.page + 1);
    const f = page.getViewport({ scale: 1 });
    const px = Math.max(300, el.clientWidth * (window.devicePixelRatio || 1));
    const tmp = document.createElement('canvas');
    await renderPage(page, (72 * px) / f.width, tmp);
    if (doc !== state.renderDoc) return;
    const c = el.querySelector('canvas');
    c.width = tmp.width; c.height = tmp.height; c.getContext('2d').drawImage(tmp, 0, 0);
    tmp.width = tmp.height = 0;
    el.dataset.rendered = String(px);
    page.cleanup();
  } catch (e) { if (doc === state.renderDoc) console.warn('render failed', e); }
  finally { rendering.delete(el); }
}

// ------------------------------------------------------------------ toolbar
const addButtons = [...document.querySelectorAll('[data-add]')];
addButtons.forEach((b) => b.addEventListener('click', () => {
  const kind = b.dataset.add;
  if (state.armed === kind) return arm(null);
  if ((kind === 'signature' || kind === 'initials') && !state.assets[kind]) return openDialog(kind, () => arm(kind));
  arm(kind);
}));

function arm(kind) {
  state.armed = kind;
  addButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.add === kind)));
  pagesEl.classList.toggle('placing', !!kind);
  if (kind) say(`Click or tap where the ${LABEL[kind].toLowerCase()} should go (or focus a page and press Enter). Esc cancels.`);
}
const LABEL = { signature: 'Signature', initials: 'Initials', date: 'Date', text: 'Text', check: 'Checkmark' };

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.armed && !$('#sigdlg').open) arm(null);
});

function onLayerClick(e, pageIdx, pageEl) {
  if (e.target !== e.currentTarget) return;
  if (!state.armed) { select(null); return; }
  const [dx, dy] = clientToDisplay(pageEl.getBoundingClientRect(), e.clientX, e.clientY, state.frames[pageIdx]);
  place(state.armed, pageIdx, dx, dy);
}

// ------------------------------------------------------------------ items
function place(kind, page, cx, cy) {
  const f = state.frames[page];
  const it = { id: state.nextId++, kind, page };
  if (kind === 'signature' || kind === 'initials') {
    const a = state.assets[kind];
    const w = Math.min(kind === 'signature' ? 170 : 64, f.width * 0.45);
    Object.assign(it, boxAt(f, cx, cy, w, a.aspect), { url: a.url, aspect: a.aspect });
  } else if (kind === 'check') {
    Object.assign(it, boxAt(f, cx, cy, 16, 1), { aspect: 1 });
  } else {
    it.size = 12;
    if (kind === 'date') { it.iso = todayISO(); it.fmt = lastDateFmt; it.text = formatDate(it.iso, it.fmt); }
    else it.text = 'Your text';
    const b = textBox(it.text, it.size);
    Object.assign(it, clampBox({ x: cx - b.w / 2, y: cy - b.h / 2, ...b }, f));
  }
  state.items.push(it);
  drawItem(it);
  arm(null);
  select(it);
  if (kind === 'text') setTimeout(() => $('#p-text')?.select(), 0);
  summary();
}
let lastDateFmt = 'MM/DD/YYYY';

function pageEl(i) { return pagesEl.querySelector(`.sign-page[data-page="${i}"]`); }

function drawItem(it) {
  if (!it.el) {
    const el = document.createElement('div');
    el.className = `sign-item k-${it.kind}`; el.tabIndex = 0; el.dataset.id = it.id;
    el.setAttribute('role', 'button');
    if (it.url) { const img = new Image(); img.src = it.url; img.alt = ''; img.draggable = false; el.append(img); }
    else if (it.kind === 'check') el.innerHTML = '<svg viewBox="0 0 1 1" aria-hidden="true"><polyline points="0.14,0.52 0.4,0.8 0.88,0.18" /></svg>';
    else el.append(Object.assign(document.createElement('span'), { className: 'sign-text' }));
    el.insertAdjacentHTML('beforeend', '<span class="sign-handle" aria-hidden="true"></span><button type="button" class="sign-x" aria-label="Remove" tabindex="-1">×</button>');
    el.querySelector('.sign-x').addEventListener('click', (e) => { e.stopPropagation(); remove(it); });
    wireDrag(it, el);
    el.addEventListener('keydown', (e) => onItemKey(e, it));
    el.addEventListener('focus', () => { if (state.selected !== it) select(it, false); });
    pageEl(it.page).querySelector('.sign-layer').append(el);
    it.el = el;
  }
  const f = state.frames[it.page], el = it.el;
  el.style.left = `${(it.x / f.width) * 100}%`; el.style.top = `${(it.y / f.height) * 100}%`;
  el.style.width = `${(it.w / f.width) * 100}%`; el.style.height = `${(it.h / f.height) * 100}%`;
  if (it.text !== undefined) { el.querySelector('.sign-text').textContent = it.text; el.style.setProperty('--fs', String(it.size)); }
  el.setAttribute('aria-label', `${LABEL[it.kind]}${it.text ? `: ${it.text}` : ''} on page ${it.page + 1}. Arrow keys move it, Delete removes it.`);
}

function select(it, focus = true) {
  if (state.selected?.el) state.selected.el.classList.remove('sel');
  state.selected = it;
  if (it) { it.el.classList.add('sel'); if (focus) it.el.focus({ preventScroll: true }); }
  showProps();
}

function remove(it) {
  state.items.splice(state.items.indexOf(it), 1);
  it.el.remove();
  if (state.selected === it) select(null);
  summary();
}

function summary() {
  const n = state.items.length, pages = new Set(state.items.map((i) => i.page)).size;
  $('#save').disabled = $('#save2').disabled = !n;
  say(n ? `${n} item${n > 1 ? 's' : ''} on ${pages} page${pages > 1 ? 's' : ''}. Drag to move, use the corner handle to resize.` : 'Choose what to add, then click or tap on a page to place it.');
}

function onItemKey(e, it) {
  const f = state.frames[it.page];
  const step = e.shiftKey ? 10 : 1;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key]) {
    e.preventDefault();
    Object.assign(it, clampBox({ ...it, x: it.x + moves[e.key][0], y: it.y + moves[e.key][1] }, f));
    drawItem(it);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault(); remove(it);
  } else if (e.key === 'Escape') { select(null); it.el.blur(); }
}

function wireDrag(it, el) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || e.target.closest('.sign-x')) return;
    e.preventDefault(); e.stopPropagation();
    select(it);
    const rect = pageEl(it.page).getBoundingClientRect(), f = state.frames[it.page];
    const k = f.width / rect.width; // points per CSS px
    const start = { cx: e.clientX, cy: e.clientY, x: it.x, y: it.y, w: it.w, h: it.h, size: it.size };
    const resizing = e.target.classList.contains('sign-handle');
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = (ev.clientX - start.cx) * k, dy = (ev.clientY - start.cy) * k;
      if (!resizing) {
        Object.assign(it, clampBox({ ...it, x: start.x + dx, y: start.y + dy }, f));
      } else if (it.text !== undefined) {
        // Text: scale the font with the box height.
        const scale = Math.max((start.w + dx) / start.w, (start.h + dy) / start.h);
        it.size = Math.round(clamp(start.size * scale, 6, 96) * 2) / 2;
        Object.assign(it, clampBox({ ...it, ...textBox(it.text, it.size) }, f));
        syncProps();
      } else {
        // Images & checkmark: keep aspect; follow whichever direction moved more.
        let w = Math.max(start.w + dx, (start.h + dy) * it.aspect);
        w = clamp(w, 8, Math.min(f.width - start.x, (f.height - start.y) * it.aspect));
        Object.assign(it, { w, h: w / it.aspect });
      }
      drawItem(it);
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
}

// ------------------------------------------------------------------ properties bar
function showProps() {
  const it = state.selected;
  props.hidden = !it;
  if (!it) { props.replaceChildren(); return; }
  const fmtOpts = Object.keys(DATE_FORMATS).map((k) => `<option value="${k}">${formatDate(todayISO(), k)}</option>`).join('');
  props.innerHTML = `<b class="sign-props-title">${LABEL[it.kind]} · page ${it.page + 1}</b>` + ({
    text: `<label class="field grow">Text<textarea id="p-text" rows="2"></textarea></label>
      <label class="field">Size<input id="p-size" type="number" min="6" max="96" step="0.5" /></label>`,
    date: `<label class="field">Date<input id="p-date" type="date" /></label>
      <label class="field">Format<select id="p-fmt">${fmtOpts}</select></label>
      <label class="field">Size<input id="p-size" type="number" min="6" max="96" step="0.5" /></label>`,
    signature: '<button type="button" class="btn ghost sm" id="p-redo">Change signature</button>',
    initials: '<button type="button" class="btn ghost sm" id="p-redo">Change initials</button>',
    check: '',
  })[it.kind] + '<button type="button" class="btn ghost sm" id="p-del">Remove</button>';
  syncProps();
  $('#p-del').onclick = () => remove(it);
  const relayout = () => { Object.assign(it, clampBox({ ...it, ...textBox(it.text, it.size) }, state.frames[it.page])); drawItem(it); };
  $('#p-text')?.addEventListener('input', (e) => { it.text = e.target.value; relayout(); });
  $('#p-size')?.addEventListener('change', (e) => { it.size = clamp(+e.target.value || 12, 6, 96); e.target.value = it.size; relayout(); });
  const dateChanged = () => {
    const iso = $('#p-date').value, fmt = $('#p-fmt').value;
    if (!iso) return;
    Object.assign(it, { iso, fmt, text: formatDate(iso, fmt) }); lastDateFmt = fmt; relayout();
  };
  $('#p-date')?.addEventListener('change', dateChanged);
  $('#p-fmt')?.addEventListener('change', dateChanged);
  $('#p-redo')?.addEventListener('click', () => openDialog(it.kind, () => {
    const a = state.assets[it.kind];
    for (const other of state.items.filter((o) => o.kind === it.kind)) {
      Object.assign(other, clampBox({ ...other, url: a.url, aspect: a.aspect, h: other.w / a.aspect }, state.frames[other.page]));
      other.el.querySelector('img').src = a.url; drawItem(other);
    }
  }));
}
function syncProps() {
  const it = state.selected; if (!it) return;
  if ($('#p-text') && document.activeElement !== $('#p-text')) $('#p-text').value = it.text;
  if ($('#p-size')) $('#p-size').value = it.size;
  if ($('#p-date')) { $('#p-date').value = it.iso; $('#p-fmt').value = it.fmt; }
}

// ------------------------------------------------------------------ signature dialog
const dlg = $('#sigdlg');
let dlgKind = 'signature', dlgDone = null, dlgTab = 'draw';
const ink = { color: '#14286e' };
const COLORS = { blue: '#14286e', black: '#111111' };

function openDialog(kind, done) {
  dlgKind = kind; dlgDone = done;
  $('#sigdlg-title').textContent = kind === 'initials' ? 'Create your initials' : 'Create your signature';
  $('#type-text').placeholder = kind === 'initials' ? 'Your initials' : 'Type your full name';
  $('#remember').checked = remembered;
  clearPad(); upload.url = null; $('#up-preview').replaceChildren(); $('#type-text').value = '';
  updateTypePreviews();
  dlg.showModal();
  setTab(dlgTab);
}
$('#sig-cancel').onclick = () => dlg.close();
dlg.addEventListener('close', () => { dlgDone = null; });

const tabs = [...dlg.querySelectorAll('[role=tab]')];
tabs.forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
tabs.forEach((t, i) => t.addEventListener('keydown', (e) => {
  const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  if (d) { const n = tabs[(i + d + tabs.length) % tabs.length]; setTab(n.dataset.tab); n.focus(); }
}));
function setTab(name) {
  dlgTab = name;
  tabs.forEach((t) => { const on = t.dataset.tab === name; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
  dlg.querySelectorAll('[role=tabpanel]').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
  if (name === 'draw') sizePad();
}
dlg.querySelectorAll('[data-ink]').forEach((b) => b.addEventListener('click', () => {
  ink.color = COLORS[b.dataset.ink];
  dlg.querySelectorAll('[data-ink]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  redrawPad(); updateTypePreviews();
}));

// --- draw pad
const pad = $('#pad'), padCtx = pad.getContext('2d');
let strokes = [], cur = null;
function sizePad() {
  const r = pad.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if (!r.width) return;
  pad.width = Math.round(r.width * dpr); pad.height = Math.round(r.height * dpr);
  redrawPad();
}
function drawStrokes(ctx, scale) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = ink.color; ctx.fillStyle = ink.color;
  for (const s of strokes) {
    if (s.length === 1) { ctx.beginPath(); ctx.arc(s[0].x * scale, s[0].y * scale, (s[0].w * scale) / 2, 0, Math.PI * 2); ctx.fill(); continue; }
    // Quadratic curves through midpoints: smooth lines from jittery pointer samples.
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1], b = s[i];
      const m0 = i === 1 ? a : { x: (s[i - 2].x + a.x) / 2, y: (s[i - 2].y + a.y) / 2 };
      const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      ctx.beginPath(); ctx.lineWidth = ((a.w + b.w) / 2) * scale;
      ctx.moveTo(m0.x * scale, m0.y * scale); ctx.quadraticCurveTo(a.x * scale, a.y * scale, m1.x * scale, m1.y * scale);
      if (i === s.length - 1) ctx.lineTo(b.x * scale, b.y * scale);
      ctx.stroke();
    }
  }
}
function redrawPad() {
  padCtx.clearRect(0, 0, pad.width, pad.height);
  drawStrokes(padCtx, pad.width / (pad.getBoundingClientRect().width || 1));
  $('#pad-hint').hidden = strokes.length > 0;
}
function clearPad() { strokes = []; cur = null; redrawPad(); }
$('#pad-clear').onclick = clearPad;
$('#pad-undo').onclick = () => { strokes.pop(); redrawPad(); };
pad.addEventListener('pointerdown', (e) => {
  if (e.button > 0) return;
  e.preventDefault(); pad.setPointerCapture(e.pointerId);
  const r = pad.getBoundingClientRect();
  cur = { pts: [], last: null, pen: e.pointerType === 'pen', r };
  strokes.push(cur.pts); addPoint(e); redrawPad();
});
function addPoint(e) {
  const { r } = cur, x = e.clientX - r.left, y = e.clientY - r.top, t = e.timeStamp;
  const last = cur.last;
  if (last && Math.hypot(x - last.x, y - last.y) < 1.2) return;
  const speed = last ? Math.hypot(x - last.x, y - last.y) / Math.max(1, t - last.t) : 0;
  let w = strokeWidth(3.4, { pressure: e.pressure, speed, pen: cur.pen });
  if (last) w = last.w * 0.6 + w * 0.4; // ease width changes
  const p = { x, y, w, t };
  cur.pts.push(p); cur.last = p;
}
pad.addEventListener('pointermove', (e) => {
  if (!cur) return;
  for (const ev of e.getCoalescedEvents ? e.getCoalescedEvents() : [e]) addPoint(ev);
  redrawPad();
});
const endStroke = () => { cur = null; };
pad.addEventListener('pointerup', endStroke); pad.addEventListener('pointercancel', endStroke);
window.addEventListener('resize', () => { if (dlg.open && dlgTab === 'draw') sizePad(); });

/** Crop a canvas to its ink and return { url, aspect } (PNG with transparency). */
function cropToInk(canvas, pad = 6) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const b = inkBounds(img.data, canvas.width, canvas.height, 8, pad);
  if (!b) return null;
  const out = document.createElement('canvas');
  out.width = b.w; out.height = b.h;
  out.getContext('2d').drawImage(canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  return { url: out.toDataURL('image/png'), aspect: b.w / b.h };
}

function fromPad() {
  if (!strokes.length) return null;
  const r = pad.getBoundingClientRect(), scale = 3;
  const c = document.createElement('canvas');
  c.width = Math.round(r.width * scale); c.height = Math.round(r.height * scale);
  drawStrokes(c.getContext('2d'), scale);
  return cropToInk(c, 9);
}

// --- type
const FONTS = [
  { label: 'Flowing', css: 'italic 400 {px} "Segoe Script", "Snell Roundhand", "Brush Script MT", "URW Chancery L", cursive' },
  { label: 'Formal', css: 'italic 600 {px} "Lucida Handwriting", "Apple Chancery", "Lucida Calligraphy", "Z003", cursive' },
  { label: 'Casual', css: '400 {px} "Ink Free", "Segoe Print", "Bradley Hand", "Noteworthy", "Comic Sans MS", cursive' },
];
let typeFont = 0;
const typeOpts = $('#type-opts');
typeOpts.innerHTML = FONTS.map((f, i) => `<label class="type-opt"><input type="radio" name="tfont" value="${i}" ${i ? '' : 'checked'} /><span class="type-sample"></span><small>${f.label}</small></label>`).join('');
typeOpts.querySelectorAll('.type-sample').forEach((s, i) => { s.style.font = FONTS[i].css.replace('{px}', '30px'); });
typeOpts.addEventListener('change', (e) => { typeFont = +e.target.value; });
$('#type-text').addEventListener('input', updateTypePreviews);
function updateTypePreviews() {
  const t = $('#type-text').value.trim() || (dlgKind === 'initials' ? 'J.D.' : 'Jane Doe');
  typeOpts.querySelectorAll('.type-sample').forEach((s) => { s.textContent = t; s.style.color = ink.color; });
}
function fromType() {
  const t = $('#type-text').value.trim();
  if (!t) return null;
  const font = FONTS[typeFont].css.replace('{px}', '120px');
  const c = document.createElement('canvas'), ctx = c.getContext('2d');
  ctx.font = font;
  c.width = Math.ceil(ctx.measureText(t).width + 120); c.height = 240;
  ctx.font = font; ctx.fillStyle = ink.color; ctx.textBaseline = 'middle';
  ctx.fillText(t, 60, 120);
  return cropToInk(c, 8);
}

// --- upload
const upload = { bitmap: null, url: null, aspect: 1 };
// setupDropzone also listens for paste on the whole page, so ignore it while the dialog is closed.
setupDropzone($('#up-drop'), { accept: 'image/png,image/jpeg,.png,.jpg,.jpeg', multiple: false, onFiles: async ([f]) => {
  if (!dlg.open) return;
  try {
    upload.bitmap?.close?.();
    upload.bitmap = await createImageBitmap(f);
    processUpload();
  } catch { $('#up-preview').textContent = 'Could not open that image. Try a PNG or JPG.'; }
} });
$('#up-white').addEventListener('change', () => upload.bitmap && processUpload());
function processUpload() {
  const bm = upload.bitmap, max = 1600;
  const s = Math.min(1, max / Math.max(bm.width, bm.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bm.width * s)); c.height = Math.max(1, Math.round(bm.height * s));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bm, 0, 0, c.width, c.height);
  if ($('#up-white').checked) {
    const img = ctx.getImageData(0, 0, c.width, c.height);
    removeWhite(img.data); ctx.putImageData(img, 0, 0);
  }
  const r = cropToInk(c, 4);
  Object.assign(upload, r || { url: null });
  const prev = $('#up-preview'); prev.replaceChildren();
  if (r) prev.append(Object.assign(new Image(), { src: r.url, alt: 'Uploaded signature preview' }));
  else prev.textContent = 'Nothing left after removing the white background. Try unticking that option.';
}

$('#sig-use').onclick = () => {
  const r = dlgTab === 'draw' ? fromPad() : dlgTab === 'type' ? fromType() : upload.url ? { url: upload.url, aspect: upload.aspect } : null;
  if (!r) {
    $('#sig-err').textContent = dlgTab === 'draw' ? 'Draw something first.' : dlgTab === 'type' ? 'Type your name first.' : 'Choose an image first.';
    return;
  }
  $('#sig-err').textContent = '';
  state.assets[dlgKind] = r;
  saveStored($('#remember').checked);
  const done = dlgDone;
  dlg.close();
  done?.();
};
$('#remember').addEventListener('change', (e) => { if (!e.target.checked) saveStored(false); });

// ------------------------------------------------------------------ export
const hex = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const TEXT_INK = hex('#111111');

async function exportPdf() {
  await metricsP;
  const doc = await loadPdf(state.bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const it of state.items) {
    if (it.text === undefined) continue;
    const bad = unencodable(font, it.text);
    if (bad.length) throw new Error(`The ${LABEL[it.kind].toLowerCase()} on page ${it.page + 1} uses characters the standard PDF font can't show (${bad.join(' ')}). Replace them and try again.`);
  }
  const pages = doc.getPages(), images = new Map();
  for (const it of state.items) {
    const page = pages[it.page];
    const b = page.getCropBox();
    const frame = pageFrame([b.x, b.y, b.x + b.width, b.y + b.height], page.getRotation().angle);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...itemMatrix(frame, it)));
    if (it.url) {
      if (!images.has(it.url)) images.set(it.url, await doc.embedPng(it.url));
      page.drawImage(images.get(it.url), { x: 0, y: 0, width: it.w, height: it.h });
    } else if (it.kind === 'check') {
      const s = it.w, t = s * 0.12, pt = (u, v) => ({ x: u * s, y: (1 - v) * s });
      const opts = { thickness: t, color: TEXT_INK, lineCap: LineCapStyle.Round };
      page.drawLine({ start: pt(0.14, 0.52), end: pt(0.4, 0.8), ...opts });
      page.drawLine({ start: pt(0.4, 0.8), end: pt(0.88, 0.18), ...opts });
    } else {
      it.text.split('\n').forEach((line, i) => {
        if (line) page.drawText(line, { x: 0, y: it.h - (i * LH + BASELINE) * it.size, size: it.size, font, color: TEXT_INK });
      });
    }
    page.pushOperators(popGraphicsState());
  }
  return doc.save({ useObjectStreams: true });
}

for (const btn of [$('#save'), $('#save2')]) {
  btn.onclick = async () => {
    if (!state.items.length) return say('Add at least one item first.', true);
    $('#save').disabled = $('#save2').disabled = true; say('Saving…');
    try {
      const out = await exportPdf();
      downloadBlob(new Blob([out], { type: 'application/pdf' }), `${baseName(state.file.name)}-signed.pdf`);
      say(`Saved ${baseName(state.file.name)}-signed.pdf (${formatBytes(out.length)}) with ${state.items.length} item${state.items.length > 1 ? 's' : ''}. Nothing was uploaded.`);
    } catch (e) { console.error(e); say(e.message || 'Something went wrong.', true); }
    finally { $('#save').disabled = $('#save2').disabled = false; }
  };
}
