// PDF → JPG: render each page with pdf.js in the browser, encode as JPEG, ZIP if more than one.
import '../css/pdf2.css';
import { $, formatBytes, downloadBlob, baseName, setupDropzone, parseRanges } from './util.js';
import { loadPdf, thumbnail, openForRender, renderPage, canvasToJpeg, zipBlob } from './pdf-common.js';

const drop = $('#drop'), list = $('#files'), runBtn = $('#run'), status = $('#status');
const dpiSel = $('#dpi'), quality = $('#quality'), qOut = $('#quality-out'), ranges = $('#ranges'), grid = $('#pages');
let item = null;
const urls = [];
const say = (msg, err = false) => { status.textContent = msg; status.classList.toggle('err', err); };

quality.addEventListener('input', () => { qOut.textContent = quality.value; });

async function add([file]) {
  say(''); clearGrid();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await loadPdf(bytes);
    if (item) item.row.remove();
    item = { file, bytes, pages: doc.getPageCount() };
    const li = document.createElement('li');
    li.className = 'file';
    li.innerHTML = `<canvas class="thumb" width="52" height="52" aria-hidden="true"></canvas>
      <div><div class="name"></div><div class="meta"></div></div>
      <div class="act"><button class="icon-btn" data-remove aria-label="Remove">✕</button></div>`;
    li.querySelector('.name').textContent = file.name;
    li.querySelector('.meta').textContent = `${formatBytes(file.size)} · ${item.pages} page${item.pages > 1 ? 's' : ''}`;
    li.querySelector('[data-remove]').onclick = () => { li.remove(); item = null; clearGrid(); refresh(); };
    item.row = li; list.append(li);
    ranges.placeholder = item.pages > 1 ? `All pages (or e.g. 1-${Math.min(3, item.pages)}, ${item.pages})` : 'All pages';
    thumbnail(bytes, li.querySelector('canvas'));
  } catch (e) { say(`${file.name}: ${e.message}`, true); }
  refresh();
}

function refresh() {
  runBtn.disabled = !item;
  if (!status.classList.contains('err')) say(item ? 'Ready.' : '');
}

function clearGrid() { grid.replaceChildren(); urls.splice(0).forEach((u) => URL.revokeObjectURL(u)); }

setupDropzone(drop, { accept: 'application/pdf,.pdf', multiple: false, onFiles: add });

async function convert() {
  let pages;
  if (ranges.value.trim()) {
    const g = parseRanges(ranges.value, item.pages);
    if (!g) return say(`Couldn't read that page range. Use numbers between 1 and ${item.pages}, like "1-3, 5".`, true);
    pages = [...new Set(g.flat())];
  } else pages = Array.from({ length: item.pages }, (_, i) => i);

  const dpi = +dpiSel.value, q = +quality.value / 100;
  const name = baseName(item.file.name);
  const pad = String(item.pages).length;
  clearGrid();
  const src = await openForRender(item.bytes);
  const canvas = document.createElement('canvas');
  const outputs = [];
  let capped = false, total = 0;
  try {
    for (const [i, idx] of pages.entries()) {
      say(`Rendering page ${idx + 1} (${i + 1} of ${pages.length})…`);
      const page = await src.getPage(idx + 1);
      const r = await renderPage(page, dpi, canvas);
      capped ||= r.capped;
      const blob = await canvasToJpeg(canvas, q);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const file = `${name}-page-${String(idx + 1).padStart(pad, '0')}.jpg`;
      outputs.push([file, bytes]); total += bytes.length;
      addThumb(blob, file, r);
      page.cleanup();
    }
  } finally { src.destroy(); canvas.width = canvas.height = 0; }

  if (outputs.length === 1) downloadBlob(new Blob([outputs[0][1]], { type: 'image/jpeg' }), outputs[0][0]);
  else downloadBlob(zipBlob(outputs), `${name}-jpg.zip`);
  say(`Saved ${outputs.length} JPG${outputs.length > 1 ? 's (in a ZIP)' : ''}, ${formatBytes(total)} total.` +
    (capped ? ' Some pages were very large, so they were rendered below the chosen DPI to stay within browser limits (16 megapixels).' : '') +
    ' Nothing was uploaded.');
}

function addThumb(blob, file, r) {
  const url = URL.createObjectURL(blob); urls.push(url);
  const li = document.createElement('li');
  const a = Object.assign(document.createElement('a'), { href: url, download: file, title: `Download ${file}` });
  const img = Object.assign(document.createElement('img'), { src: url, alt: file, loading: 'lazy' });
  a.append(img, `${r.width} × ${r.height} · ${formatBytes(blob.size)}`);
  li.append(a); grid.append(li);
}

runBtn.onclick = async () => {
  runBtn.disabled = true; say('Working…');
  try { await convert(); }
  catch (e) { console.error(e); say(e.message || 'Something went wrong.', true); }
  finally { runBtn.disabled = !item; }
};
