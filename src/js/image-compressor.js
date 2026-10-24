import { zipSync } from 'fflate';
import { $, formatBytes, downloadBlob, baseName, setupDropzone } from './util.js';

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
const drop = $('#drop');
const list = $('#files');
const summary = $('#summary');
const zipBtn = $('#zip');
const clearBtn = $('#clear');
const els = { format: $('#format'), quality: $('#quality'), qv: $('#qv'), maxW: $('#maxw'), maxH: $('#maxh') };

// Deep links like /compress-image/?format=webp let one tool serve many keywords.
const qs = new URLSearchParams(location.search);
if (qs.get('format')) els.format.value = qs.get('format');
if (qs.get('resize')) els.maxW.focus();
els.quality.addEventListener('input', () => { els.qv.textContent = els.quality.value; });
els.qv.textContent = els.quality.value;

const items = []; // { file, row, result, url }

function opts() {
  return {
    format: els.format.value,
    quality: +els.quality.value,
    maxWidth: +els.maxW.value || 0,
    maxHeight: +els.maxH.value || 0,
  };
}

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
  return li;
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
    item.result = { blob, name: `${baseName(file.name)}${r.keptOriginal ? '' : '-min'}.${r.ext}` };
    item.url = URL.createObjectURL(blob);
    const saved = 1 - blob.size / file.size;
    const pct = Math.round(saved * 100);
    row.querySelector('.out').innerHTML = `${formatBytes(blob.size)} <span class="save ${pct > 0 ? '' : 'none'}">${
      r.keptOriginal ? 'already optimized' : pct > 0 ? `−${pct}%` : `+${-pct}%`}</span> · ${r.width}×${r.height}${r.flattenedAlpha ? ' · transparency → white' : ''}`;
    const dl = Object.assign(document.createElement('button'), { className: 'btn sm', textContent: 'Download' });
    dl.onclick = () => downloadBlob(blob, item.result.name);
    row.querySelector('.act').append(dl);
  } catch (e) {
    item.result = null;
    row.querySelector('.out').innerHTML = `<span style="color:var(--err)">Couldn't read this image (${e.message}).</span>`;
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
  summary.textContent = `${done.length} image${done.length > 1 ? 's' : ''}: ${formatBytes(before)} → ${formatBytes(after)} (saved ${Math.max(0, Math.round((1 - after / before) * 100))}%). Processed on your device.`;
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

setupDropzone(drop, { accept: 'image/jpeg,image/png,image/webp,image/avif,image/gif,image/bmp,.heic', onFiles: add });

// Re-run everything when settings change (debounced) so users can tune live.
let t;
for (const el of [els.format, els.quality, els.maxW, els.maxH]) {
  el.addEventListener('change', () => { clearTimeout(t); t = setTimeout(() => items.forEach(run), 150); });
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
