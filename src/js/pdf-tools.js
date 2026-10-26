// PDF merge / split / compress — all in the browser with pdf-lib (+ pdf.js for rendering).
import { PDFDocument } from 'pdf-lib';
import { $, formatBytes, downloadBlob, baseName, setupDropzone, parseRanges } from './util.js';
import { loadPdf, thumbnail, rasterize, resave, zipBlob, makeReorderable } from './pdf-common.js';

const TOOL = document.body.dataset.tool; // 'merge' | 'split' | 'compress'
const drop = $('#drop');
const list = $('#files');
const runBtn = $('#run');
const status = $('#status');
const items = []; // { file, bytes, pages, row }

function say(msg, err = false) { status.textContent = msg; status.classList.toggle('err', err); }

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

const enableDrag = makeReorderable(list, items);

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
  else downloadBlob(zipBlob(outputs), `${name}-split.zip`);
  say(`Created ${outputs.length} PDF${outputs.length > 1 ? 's' : ''}. Nothing was uploaded.`);
}

// ---------- Compress
const LEVELS = {
  lossless: null,                       // re-save with object streams; keeps text selectable
  balanced: { dpi: 150, quality: 0.72 },
  strong: { dpi: 100, quality: 0.55 },
};

async function compress() {
  const level = document.querySelector('input[name=level]:checked').value;
  const outputs = [];
  let before = 0, after = 0;
  for (const [idx, it] of items.entries()) {
    let bytes;
    if (!LEVELS[level]) {
      bytes = await resave(it.bytes);
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
  else downloadBlob(zipBlob(outputs), 'compressed-pdfs.zip');
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
