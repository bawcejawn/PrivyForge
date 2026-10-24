// PDF merge / split / compress — all in the browser with pdf-lib (+ pdf.js for rendering).
import { PDFDocument } from 'pdf-lib';
import { zipSync } from 'fflate';
import { $, formatBytes, downloadBlob, baseName, setupDropzone, parseRanges } from './util.js';

const TOOL = document.body.dataset.tool; // 'merge' | 'split' | 'compress'
const drop = $('#drop');
const list = $('#files');
const runBtn = $('#run');
const status = $('#status');
const items = []; // { file, bytes, pages, row }

let pdfjsP;
async function pdfjs() {
  return (pdfjsP ||= (async () => {
    const lib = await import('pdfjs-dist');
    lib.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    return lib;
  })());
}

function say(msg, err = false) { status.textContent = msg; status.classList.toggle('err', err); }

async function loadPdf(bytes) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(e.message)) throw new Error('This PDF is password-protected. Remove the password first.');
    throw new Error('This file does not look like a valid PDF.');
  }
}

async function thumbnail(bytes, canvas) {
  try {
    const lib = await pdfjs();
    const doc = await lib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const scale = 104 / Math.max(vp.width, vp.height);
    const v = page.getViewport({ scale });
    canvas.width = v.width; canvas.height = v.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: v }).promise;
    doc.destroy();
  } catch { /* thumbnail is cosmetic */ }
}

function makeRow(item) {
  const li = document.createElement('li');
  li.className = 'file';
  li.innerHTML = `
    <canvas class="thumb" width="52" height="52" aria-hidden="true"></canvas>
    <div><div class="name"></div><div class="meta"></div></div>
    <div class="act">${TOOL === 'merge' ? '<span class="handle" title="Drag to reorder">⋮⋮</span>' : ''}
      <button class="icon-btn" data-remove aria-label="Remove">✕</button></div>`;
  li.querySelector('.name').textContent = item.file.name;
  li.querySelector('.meta').textContent = `${formatBytes(item.file.size)} · ${item.pages} page${item.pages > 1 ? 's' : ''}`;
  li.querySelector('[data-remove]').onclick = () => { items.splice(items.indexOf(item), 1); li.remove(); refresh(); };
  if (TOOL === 'merge') enableDrag(li, item);
  thumbnail(item.bytes, li.querySelector('canvas'));
  return li;
}

// Drag-to-reorder (merge). Keyboard users get up/down via Alt+Arrow.
let dragItem = null;
function enableDrag(li, item) {
  li.draggable = true; li.tabIndex = 0;
  li.addEventListener('dragstart', () => { dragItem = item; li.classList.add('dragging'); });
  li.addEventListener('dragend', () => { li.classList.remove('dragging'); dragItem = null; });
  li.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragItem || dragItem === item) return;
    const r = li.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    li[after ? 'after' : 'before'](dragItem.row);
    syncOrder();
  });
  li.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    if (e.key === 'ArrowUp' && li.previousElementSibling) { li.previousElementSibling.before(li); syncOrder(); li.focus(); }
    if (e.key === 'ArrowDown' && li.nextElementSibling) { li.nextElementSibling.after(li); syncOrder(); li.focus(); }
  });
}
function syncOrder() {
  const order = [...list.children];
  items.sort((a, b) => order.indexOf(a.row) - order.indexOf(b.row));
}

async function add(files) {
  if (TOOL === 'split') { items.forEach((i) => i.row.remove()); items.length = 0; files = files.slice(0, 1); }
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const doc = await loadPdf(bytes);
      const item = { file, bytes, pages: doc.getPageCount() };
      item.row = makeRow(item);
      items.push(item); list.append(item.row);
    } catch (e) { say(`${file.name}: ${e.message}`, true); }
  }
  refresh();
}

function refresh() {
  const need = TOOL === 'merge' ? 2 : 1;
  runBtn.disabled = items.length < need;
  if (TOOL === 'split' && items[0]) $('#ranges').placeholder = `e.g. 1-3, 4, 5-${items[0].pages}`;
  if (!status.classList.contains('err')) {
    say(items.length ? (TOOL === 'merge' && items.length < 2 ? 'Add at least one more PDF.' : 'Ready.') : '');
  }
}

setupDropzone(drop, { accept: 'application/pdf,.pdf', multiple: TOOL !== 'split', onFiles: (f) => { say(''); add(f); } });

// ---------- Merge
async function merge() {
  const out = await PDFDocument.create();
  for (const it of items) {
    const src = await loadPdf(it.bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  out.setProducer('PrivyForge (in-browser)'); out.setCreator('PrivyForge');
  const bytes = await out.save({ useObjectStreams: true });
  downloadBlob(new Blob([bytes], { type: 'application/pdf' }), 'merged.pdf');
  say(`Merged ${items.length} files (${out.getPageCount()} pages, ${formatBytes(bytes.length)}). Nothing was uploaded.`);
}

// ---------- Split
async function split() {
  const it = items[0];
  const src = await loadPdf(it.bytes);
  const mode = document.querySelector('input[name=mode]:checked').value;
  let groups;
  if (mode === 'all') groups = src.getPageIndices().map((i) => [i]);
  else {
    groups = parseRanges($('#ranges').value, it.pages);
    if (!groups) return say(`Couldn't read those page ranges. Use numbers between 1 and ${it.pages}, like "1-3, 7".`, true);
    if (mode === 'one') groups = [groups.flat()];
  }
  const name = baseName(it.file.name);
  const outputs = [];
  for (const g of groups) {
    const doc = await PDFDocument.create();
    (await doc.copyPages(src, g)).forEach((p) => doc.addPage(p));
    const label = g.length === 1 ? `p${g[0] + 1}` : `p${g[0] + 1}-${g[g.length - 1] + 1}`;
    outputs.push([`${name}-${label}.pdf`, await doc.save({ useObjectStreams: true })]);
  }
  if (outputs.length === 1) downloadBlob(new Blob([outputs[0][1]], { type: 'application/pdf' }), outputs[0][0]);
  else downloadBlob(new Blob([zipSync(Object.fromEntries(outputs.map(([n, b]) => [n, [b, { level: 0 }]])))], { type: 'application/zip' }), `${name}-split.zip`);
  say(`Created ${outputs.length} PDF${outputs.length > 1 ? 's' : ''}. Nothing was uploaded.`);
}

// ---------- Compress
const LEVELS = {
  lossless: null,                       // re-save with object streams; keeps text selectable
  balanced: { dpi: 150, quality: 0.72 },
  strong: { dpi: 100, quality: 0.55 },
};

async function rasterize(bytes, { dpi, quality }, onPage) {
  const lib = await pdfjs();
  const src = await lib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
  const out = await PDFDocument.create();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  for (let n = 1; n <= src.numPages; n++) {
    onPage(n, src.numPages);
    const page = await src.getPage(n);
    const base = page.getViewport({ scale: 1 }); // PDF points
    let scale = dpi / 72;
    const maxPx = 16e6; // keep canvas inside mobile Safari limits
    if (base.width * base.height * scale * scale > maxPx) scale = Math.sqrt(maxPx / (base.width * base.height));
    const vp = page.getViewport({ scale });
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const jpg = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    const img = await out.embedJpg(await jpg.arrayBuffer());
    out.addPage([base.width, base.height]).drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
    page.cleanup();
  }
  src.destroy();
  return out.save({ useObjectStreams: true });
}

async function compress() {
  const level = document.querySelector('input[name=level]:checked').value;
  const outputs = [];
  let before = 0, after = 0;
  for (const [idx, it] of items.entries()) {
    let bytes;
    if (!LEVELS[level]) {
      const doc = await loadPdf(it.bytes);
      bytes = await doc.save({ useObjectStreams: true });
    } else {
      bytes = await rasterize(it.bytes, LEVELS[level], (n, total) => say(`File ${idx + 1}/${items.length}: page ${n} of ${total}…`));
    }
    const kept = bytes.length >= it.bytes.length;
    if (kept) bytes = it.bytes; // never return a bigger file
    before += it.bytes.length; after += bytes.length;
    it.row.querySelector('.meta').textContent = `${formatBytes(it.bytes.length)} → ${formatBytes(bytes.length)} ${
      kept ? '(already optimized — kept original)' : `(−${Math.round((1 - bytes.length / it.bytes.length) * 100)}%)`}`;
    outputs.push([`${baseName(it.file.name)}-compressed.pdf`, bytes]);
  }
  if (outputs.length === 1) downloadBlob(new Blob([outputs[0][1]], { type: 'application/pdf' }), outputs[0][0]);
  else downloadBlob(new Blob([zipSync(Object.fromEntries(outputs.map(([n, b]) => [n, [b, { level: 0 }]])))], { type: 'application/zip' }), 'compressed-pdfs.zip');
  say(`Done: ${formatBytes(before)} → ${formatBytes(after)} (saved ${Math.max(0, Math.round((1 - after / before) * 100))}%). Nothing was uploaded.`);
}

runBtn.onclick = async () => {
  runBtn.disabled = true; say('Working…');
  try { await ({ merge, split, compress })[TOOL](); }
  catch (e) { console.error(e); say(e.message || 'Something went wrong.', true); }
  finally { runBtn.disabled = false; }
};

if (TOOL === 'split') {
  const toggle = () => { $('#ranges-field').hidden = document.querySelector('input[name=mode]:checked').value === 'all'; };
  document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', toggle)); toggle();
}
