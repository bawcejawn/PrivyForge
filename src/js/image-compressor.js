import { zipSync } from 'fflate';
import { $, formatBytes, downloadBlob, baseName, setupDropzone } from './util.js';
import { kbToBytes } from './lib/target-size.js';
import '../css/images.css';

// ---------- Worker pool (parallel compression, UI never freezes)
const POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
const workers = [];
const queue = [];
const pending = new Map();
let seq = 0;

function spawn() {
  const w = new Worker(new URL('../workers/image.worker.js', import.meta.url), { type: 'module' });
  w.busy = false;
  w.onmessage = ({ data }) => {
    const p = pending.get(data.id); pending.delete(data.id);
    w.busy = false; pump();
    data.ok ? p.resolve(data) : p.reject(new Error(data.error));
  };
  w.onerror = (e) => { console.error(e); };
  return w;
}
function pump() {
  for (const job of [...queue]) {
    let w = workers.find((x) => !x.busy);
    if (!w && workers.length < POOL_SIZE) { w = spawn(); workers.push(w); }
    if (!w) return;
    queue.splice(queue.indexOf(job), 1);
    w.busy = true;
    w.postMessage(job.msg, [job.msg.buffer]);
  }
}
function compress(file, opts) {
  return file.arrayBuffer().then((buffer) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    queue.push({ msg: { id, buffer, type: file.type, opts } });
    pump();
  }));
}

// ---------- UI
// One script serves every image page. Each page configures it with data-attributes on the
// tool section (all optional):
//   data-mode="compress|convert|resize|target|heic"  data-format="webp|jpeg|png|avif|auto"
//   data-accept=".heic,image/heic"  data-max-width="1600"  data-target-kb="100"  data-suffix="-min"
// Controls are optional too: a page only includes the inputs that make sense for it.
const tool = $('section.tool');
const cfg = tool?.dataset || {};
const mode = cfg.mode || 'compress';
const drop = $('#drop');
const list = $('#files');
const summary = $('#summary');
const zipBtn = $('#zip');
const clearBtn = $('#clear');
const els = {
  format: $('#format'), quality: $('#quality'), qv: $('#qv'), maxW: $('#maxw'), maxH: $('#maxh'),
  keep: $('#keep'), upscale: $('#upscale'), target: $('#target'),
};
const DEFAULT_ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/gif,image/bmp,.heic,.heif,image/heic,image/heif';

// Deep links like /compress-image/?format=webp let one tool serve many keywords.
const qs = new URLSearchParams(location.search);
if (els.format && qs.get('format') && [...els.format.options].some((o) => o.value === qs.get('format'))) els.format.value = qs.get('format');
if (qs.get('resize') && els.maxW) els.maxW.focus();
if (els.quality) {
  els.quality.addEventListener('input', () => { els.qv.textContent = els.quality.value; });
  els.qv.textContent = els.quality.value;
}

const items = []; // { file, row, result, url }
const num = (el) => (el && +el.value > 0 ? +el.value : 0);

function targetKb() {
  if (mode !== 'target') return 0;
  return num(els.target) || +cfg.targetKb || 0;
}

function opts() {
  const keep = els.keep ? els.keep.checked : true;
  return {
    format: els.format?.value || cfg.format || 'auto',
    quality: els.quality ? +els.quality.value : 75,
    maxWidth: num(els.maxW) || +cfg.maxWidth || 0,
    maxHeight: num(els.maxH) || +cfg.maxHeight || 0,
    fit: keep ? 'contain' : 'exact',
    allowUpscale: mode === 'resize' && !!els.upscale?.checked,
    targetBytes: kbToBytes(targetKb()),
  };
}

const isHeic = (file) => /\.(heic|heif)$/i.test(file.name) || /image\/hei[cf]/i.test(file.type);
// Rounded down so a 99,989-byte file never reads as "100.0 KB" next to "under 100 KB".
const kb = (n) => `${(Math.floor(n / 100) / 10).toFixed(1)} KB`;

function rowFor(file) {
  const li = document.createElement('li');
  li.className = 'file';
  li.innerHTML = `
    <button class="thumb" title="Compare before / after" aria-label="Compare before and after">IMG</button>
    <div><div class="name"></div><div class="meta">${formatBytes(file.size)} → <span class="out">working…</span></div><div class="bar"><i></i></div></div>
    <div class="act"></div>`;
  li.querySelector('.name').textContent = file.name;
  const thumb = li.querySelector('.thumb');
  const img = new Image(); img.className = 'thumb'; img.alt = '';
  img.src = URL.createObjectURL(file);
  img.onload = () => thumb.replaceChildren(img);
  img.onerror = () => { thumb.textContent = isHeic(file) ? 'HEIC' : 'IMG'; };
  return li;
}

function outName(file, r) {
  const base = baseName(file.name);
  if (r.target) return `${base}-under-${Math.round(r.target.bytes / 1000)}kb.${r.ext}`;
  if (r.keptOriginal) return `${base}.${r.ext}`;
  if (mode === 'resize') return `${base}-${r.width}x${r.height}.${r.ext}`;
  const suffix = cfg.suffix ?? '-min';
  return `${base}${suffix}.${r.ext}`;
}

function describe(file, blob, r) {
  if (r.target) {
    const t = r.target;
    const head = t.ok
      ? `${kb(blob.size)} (${blob.size.toLocaleString('en-US')} bytes) <span class="save">✓ under ${Math.round(t.bytes / 1000)} KB</span>`
      : `${kb(blob.size)} <span class="target-miss">can't reach ${Math.round(t.bytes / 1000)} KB, this is the smallest possible</span>`;
    return `${head} · quality ${t.quality} · ${r.width}×${r.height}${r.flattenedAlpha ? ' · transparency → white' : ''}`;
  }
  const pct = Math.round((1 - blob.size / file.size) * 100);
  return `${formatBytes(blob.size)} <span class="save ${pct > 0 ? '' : 'none'}">${
    r.keptOriginal ? 'already optimized' : pct > 0 ? `−${pct}%` : `+${-pct}%`}</span> · ${r.width}×${r.height}${r.flattenedAlpha ? ' · transparency → white' : ''}`;
}

function failMessage(file) {
  if (isHeic(file) && heicSupport !== true) {
    return 'This browser can’t open HEIC photos. Safari can: open this page in Safari on an iPhone, iPad or Mac, or set your iPhone camera to “Most Compatible” so it saves JPGs.';
  }
  return 'Couldn’t read this image. It may be damaged or in a format this browser can’t open.';
}

async function run(item) {
  const { file, row } = item;
  row.querySelector('.bar').hidden = false;
  row.querySelector('.out').textContent = 'working…';
  row.querySelector('.act').replaceChildren();
  try {
    const r = await compress(file, opts());
    const blob = new Blob([r.buffer], { type: r.mime });
    if (item.url) URL.revokeObjectURL(item.url);
    item.result = { blob, name: outName(file, r), target: r.target };
    item.url = URL.createObjectURL(blob);
    row.querySelector('.out').innerHTML = describe(file, blob, r);
    row.dataset.bytes = blob.size;
    const dl = Object.assign(document.createElement('button'), { className: 'btn sm', textContent: 'Download' });
    dl.onclick = () => downloadBlob(blob, item.result.name);
    row.querySelector('.act').append(dl);
  } catch (e) {
    item.result = null;
    const out = row.querySelector('.out');
    const span = Object.assign(document.createElement('span'), { className: 'file-err', textContent: failMessage(file) });
    span.title = e.message;
    out.replaceChildren(span);
  } finally {
    row.querySelector('.bar').hidden = true;
    updateSummary();
  }
}

function updateSummary() {
  const done = items.filter((i) => i.result);
  zipBtn.disabled = done.length < 2;
  clearBtn.disabled = !items.length;
  if (!done.length) { summary.hidden = true; return; }
  const before = done.reduce((s, i) => s + i.file.size, 0);
  const after = done.reduce((s, i) => s + i.result.blob.size, 0);
  summary.hidden = false;
  const n = `${done.length} image${done.length > 1 ? 's' : ''}`;
  if (mode === 'target') {
    const missed = done.filter((i) => !i.result.target?.ok).length;
    summary.textContent = `${n}: ${formatBytes(before)} → ${formatBytes(after)}. ${missed ? `${missed} couldn't reach the target (see above).` : `All under ${targetKb()} KB.`} Processed on your device.`;
    summary.classList.toggle('warn', missed > 0);
    return;
  }
  summary.textContent = `${n}: ${formatBytes(before)} → ${formatBytes(after)} (saved ${Math.max(0, Math.round((1 - after / before) * 100))}%). Processed on your device.`;
}

function add(files) {
  for (const file of files) {
    const row = rowFor(file);
    const item = { file, row };
    row.querySelector('.thumb').addEventListener('click', () => item.url && openCompare(URL.createObjectURL(file), item.url));
    items.push(item); list.append(row);
    run(item);
  }
  updateSummary();
}

setupDropzone(drop, { accept: cfg.accept || DEFAULT_ACCEPT, onFiles: add });

// Re-run everything when settings change (debounced) so users can tune live.
let t;
const rerun = () => { clearTimeout(t); t = setTimeout(() => items.forEach(run), 150); };
for (const el of Object.values(els)) if (el && el.tagName !== 'B') el.addEventListener('change', rerun);

// Resize presets: <button data-preset-w="1920">
for (const b of document.querySelectorAll('[data-preset-w]')) {
  b.addEventListener('click', () => {
    if (els.maxW) els.maxW.value = b.dataset.presetW;
    if (els.maxH) els.maxH.value = '';
    if (els.keep) els.keep.checked = true;
    rerun();
  });
}

// ---------- HEIC support (Safari decodes HEIC natively; Chrome, Firefox and Edge don't)
// A 402-byte 64x64 HEIC: if the browser can decode it, it can decode iPhone photos too.
const HEIC_PROBE = 'AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAVZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABegABAAAAAAAAABgAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAA5waXRtAAAAAAABAAAA1mlwcnAAAAC3aXBjbwAAAHhodmNDAQNwAAAAkAAAAAAAHvAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQArQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbqSSmubgIaDAgAAAMAyAAAAwAIQGIAAQAHRAHBcrAiQAAAABNjb2xybmNseAABAA0ABoAAAAAUaXNwZQAAAAAAAABAAAAAQAAAABBwaXhpAAAAAAMICAgAAAAXaXBtYQAAAAAAAAABAAEEgQIDBAAAACBtZGF0AAAAFCgBrwQY/Hk46//uPj91wFtDxHQ4';
let heicSupport = null;
async function probeHeic() {
  try {
    const bytes = Uint8Array.from(atob(HEIC_PROBE), (c) => c.charCodeAt(0));
    const bmp = await Promise.race([
      createImageBitmap(new Blob([bytes], { type: 'image/heic' })),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ]);
    const ok = bmp.width === 64 && bmp.height === 64; bmp.close?.();
    return ok;
  } catch { return false; }
}
if (mode === 'heic') {
  probeHeic().then((ok) => {
    heicSupport = ok;
    document.documentElement.dataset.heic = ok ? 'supported' : 'unsupported';
    const yes = $('#heic-supported'), no = $('#heic-unsupported');
    if (yes) yes.hidden = !ok;
    if (no) no.hidden = ok;
    tool.classList.toggle('heic-off', !ok);
  });
}

zipBtn.onclick = async () => {
  const files = {};
  for (const i of items.filter((x) => x.result)) {
    let n = i.result.name, k = 1;
    while (files[n]) n = i.result.name.replace(/(\.\w+)$/, `-${k++}$1`);
    // level 0 = store only: images are already compressed, so zipping them again just wastes time.
    files[n] = [new Uint8Array(await i.result.blob.arrayBuffer()), { level: 0 }];
  }
  downloadBlob(new Blob([zipSync(files)], { type: 'application/zip' }), 'privyforge-images.zip');
};
clearBtn.onclick = () => { items.forEach((i) => i.url && URL.revokeObjectURL(i.url)); items.length = 0; list.replaceChildren(); updateSummary(); };

// ---------- Before/after slider
function openCompare(beforeUrl, afterUrl) {
  const box = $('#compare');
  box.innerHTML = `
    <button class="btn ghost sm compare-close">Close ✕</button>
    <div class="compare-box">
      <img class="before" src="${beforeUrl}" alt="Original">
      <div class="after"><img src="${afterUrl}" alt="Compressed"></div>
      <div class="divider"></div>
      <span class="compare-label" style="left:8px">Original</span>
      <span class="compare-label" style="right:8px">Compressed</span>
    </div>`;
  box.hidden = false;
  const wrap = box.querySelector('.compare-box');
  const after = box.querySelector('.after');
  const afterImg = after.querySelector('img');
  const divider = box.querySelector('.divider');
  const set = (x) => {
    const r = wrap.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (x - r.left) / r.width));
    after.style.clipPath = `inset(0 0 0 ${p * 100}%)`;
    divider.style.left = `${p * 100}%`;
    afterImg.style.width = `${r.width}px`; afterImg.style.height = `${r.height}px`;
  };
  box.querySelector('.before').onload = () => set(wrap.getBoundingClientRect().left + wrap.getBoundingClientRect().width / 2);
  wrap.addEventListener('pointermove', (e) => set(e.clientX));
  wrap.addEventListener('pointerdown', (e) => set(e.clientX));
  const close = () => { box.hidden = true; box.innerHTML = ''; URL.revokeObjectURL(beforeUrl); };
  box.querySelector('.compare-close').onclick = close;
  box.onclick = (e) => { if (e.target === box) close(); };
  addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); removeEventListener('keydown', esc); } });
}
