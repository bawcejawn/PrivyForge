// JPG / PNG / WebP → one PDF, in the browser with pdf-lib.
// JPEGs are embedded byte-for-byte (no re-compression); PNGs keep transparency; other formats
// are drawn to a canvas and embedded as high-quality JPEG.
import '../css/pdf2.css';
import { PDFDocument, degrees } from 'pdf-lib';
import { $, formatBytes, downloadBlob, baseName, setupDropzone } from './util.js';
import { makeReorderable, canvasToJpeg } from './pdf-common.js';
import { layoutImage, MARGINS, sniffImage, jpegOrientation, stripOrientation, orientedDraw, renderSize } from './lib/pdf-layout.js';

const drop = $('#drop'), list = $('#files'), runBtn = $('#run'), status = $('#status');
const items = []; // { file, bytes, kind, orientation, w, h (as displayed), url, row }
const enableDrag = makeReorderable(list, items);
const say = (msg, err = false) => { status.textContent = msg; status.classList.toggle('err', err); };

async function decode(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch { throw new Error('This image could not be read by your browser.'); }
}

function makeRow(item) {
  const li = document.createElement('li');
  li.className = 'file';
  li.innerHTML = `<img class="thumb" alt="" />
    <div><div class="name"></div><div class="meta"></div></div>
    <div class="act"><span class="handle" title="Drag to reorder">⋮⋮</span>
      <button class="icon-btn" data-remove aria-label="Remove">✕</button></div>`;
  li.querySelector('img').src = item.url;
  li.querySelector('.name').textContent = item.file.name;
  li.querySelector('.meta').textContent = `${formatBytes(item.file.size)} · ${item.w} × ${item.h}`;
  li.querySelector('[data-remove]').onclick = () => {
    items.splice(items.indexOf(item), 1); li.remove(); URL.revokeObjectURL(item.url); refresh();
  };
  enableDrag(li, item);
  return li;
}

async function add(files) {
  say('');
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const kind = sniffImage(bytes) || file.type.replace('image/', '');
      const bmp = await decode(file);
      const item = { file, bytes, kind, orientation: kind === 'jpeg' ? jpegOrientation(bytes) : 1, w: bmp.width, h: bmp.height, url: URL.createObjectURL(file) };
      bmp.close();
      item.row = makeRow(item);
      items.push(item); list.append(item.row);
    } catch (e) { say(`${file.name}: ${e.message}`, true); }
  }
  refresh();
}

function refresh() {
  runBtn.disabled = !items.length;
  if (!status.classList.contains('err')) say(items.length ? `${items.length} image${items.length > 1 ? 's' : ''} → ${items.length} page${items.length > 1 ? 's' : ''}. Ready.` : '');
}

setupDropzone(drop, { accept: 'image/jpeg,image/png,image/webp,image/gif,image/bmp,image/avif,.jpg,.jpeg,.png,.webp', onFiles: add });

/** Draw any image to a white canvas (≤ 16 MP) and return JPEG bytes. */
async function viaCanvas(item) {
  const bmp = await decode(item.file);
  const { width, height } = renderSize(bmp.width, bmp.height, 72); // 72 "dpi" = 1:1, capped at 16 MP
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bmp, 0, 0, width, height); bmp.close();
  const out = new Uint8Array(await (await canvasToJpeg(c, 0.92)).arrayBuffer());
  c.width = c.height = 0;
  return out;
}

async function build() {
  const pageSize = $('#pagesize').value, margin = MARGINS[$('#margin').value] ?? 0;
  const doc = await PDFDocument.create();
  for (const [i, it] of items.entries()) {
    say(`Adding image ${i + 1} of ${items.length}…`);
    const L = layoutImage(it.w, it.h, { pageSize, margin });
    const page = doc.addPage([L.pageW, L.pageH]);
    let img = null, draw = null;
    try {
      if (it.kind === 'jpeg' && (draw = orientedDraw(it.orientation, L.x, L.y, L.w, L.h))) img = await doc.embedJpg(it.orientation === 1 ? it.bytes : stripOrientation(it.bytes));
      else if (it.kind === 'png') { img = await doc.embedPng(it.bytes); draw = orientedDraw(1, L.x, L.y, L.w, L.h); }
    } catch { img = null; } // unusual JPEG/PNG variant → fall back to canvas
    if (!img) { img = await doc.embedJpg(await viaCanvas(it)); draw = orientedDraw(1, L.x, L.y, L.w, L.h); }
    page.drawImage(img, { x: draw.x, y: draw.y, width: draw.width, height: draw.height, rotate: degrees(draw.rotate) });
  }
  doc.setProducer('PrivyForge (in-browser)'); doc.setCreator('PrivyForge');
  const bytes = await doc.save({ useObjectStreams: true });
  const name = items.length === 1 ? `${baseName(items[0].file.name)}.pdf` : 'images.pdf';
  downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name);
  say(`Created ${name}: ${items.length} page${items.length > 1 ? 's' : ''}, ${formatBytes(bytes.length)}. Nothing was uploaded.`);
}

runBtn.onclick = async () => {
  runBtn.disabled = true; say('Working…');
  try { await build(); }
  catch (e) { console.error(e); say(e.message || 'Something went wrong.', true); }
  finally { runBtn.disabled = !items.length; }
};
