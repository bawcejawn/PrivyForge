// PDF → text: read each page's text layer with pdf.js (exact and fast). Pages with no real
// text (scans, photos of documents) are rendered to a canvas and OCR'd with tesseract.js.
// Everything happens in this tab; the OCR engine and data are served from this site.
import '../css/ocr.css';
import { $, formatBytes, downloadBlob, baseName, setupDropzone, parseRanges } from './util.js';
import { openForRender, renderPage } from './pdf-common.js';
import { recognize, OCR_DOWNLOAD_LABEL, ocrCachedBefore } from './ocr-engine.js';
import { itemsToText, needsOcr, cleanText, joinPages } from './lib/ocr-text.js';

const OCR_DPI = 300;
const drop = $('#drop'), list = $('#files'), runBtn = $('#run'), status = $('#status');
const ranges = $('#ranges'), ocrAll = $('#ocr-all'), out = $('#out'), outBox = $('#out-box'), pagesList = $('#page-kinds');
const notice = $('#ocr-notice'), bar = $('#progress'), fill = bar.querySelector('i');
let item = null;
const say = (msg, err = false) => { status.textContent = msg; status.classList.toggle('err', err); };

notice.querySelector('[data-size]').textContent = OCR_DOWNLOAD_LABEL;
const showNotice = () => { notice.hidden = ocrCachedBefore(); };
showNotice();

async function add([file]) {
  say(''); outBox.hidden = true;
  let doc;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try { doc = await openForRender(bytes); }
    catch (e) {
      throw new Error(e?.name === 'PasswordException'
        ? 'This PDF is password-protected. Open it in your PDF reader, save an unlocked copy, and try that.'
        : 'This file does not look like a valid PDF.');
    }
    if (item) item.row.remove();
    item = { file, bytes, pages: doc.numPages };
    const li = document.createElement('li');
    li.className = 'file';
    li.innerHTML = `<span class="thumb" aria-hidden="true">PDF</span>
      <div><div class="name"></div><div class="meta"></div></div>
      <div class="act"><button class="icon-btn" data-remove aria-label="Remove">✕</button></div>`;
    li.querySelector('.name').textContent = file.name;
    li.querySelector('.meta').textContent = `${formatBytes(file.size)} · ${item.pages} page${item.pages > 1 ? 's' : ''}`;
    li.querySelector('[data-remove]').onclick = () => { li.remove(); item = null; outBox.hidden = true; refresh(); };
    item.row = li; list.append(li);
    ranges.placeholder = item.pages > 1 ? `All pages (or e.g. 1-${Math.min(3, item.pages)}, ${item.pages})` : 'All pages';
  } catch (e) { say(`${file.name}: ${e.message}`, true); }
  finally { doc?.destroy(); }
  refresh();
}

function refresh() {
  runBtn.disabled = !item;
  if (!status.classList.contains('err')) say(item ? 'Ready.' : '');
}

setupDropzone(drop, { accept: 'application/pdf,.pdf', multiple: false, onFiles: add });

const progress = (p) => { bar.hidden = p == null; fill.style.width = `${Math.round((p || 0) * 100)}%`; };

async function extract() {
  let pages;
  if (ranges.value.trim()) {
    const g = parseRanges(ranges.value, item.pages);
    if (!g) return say(`Couldn't read that page range. Use numbers between 1 and ${item.pages}, like "1-3, 5".`, true);
    pages = [...new Set(g.flat())];
  } else pages = Array.from({ length: item.pages }, (_, i) => i);

  const forceOcr = ocrAll.checked;
  const doc = await openForRender(item.bytes);
  const canvas = document.createElement('canvas');
  const done = [];
  const t0 = performance.now();
  pagesList.replaceChildren(); outBox.hidden = true;
  try {
    for (const [i, idx] of pages.entries()) {
      const n = idx + 1, of = `page ${n} (${i + 1} of ${pages.length})`;
      say(`Reading text on ${of}…`);
      progress(i / pages.length);
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      let text = cleanText(itemsToText(tc.items));
      let ocr = false, conf = null;
      if (forceOcr || needsOcr(text)) {
        await renderPage(page, OCR_DPI, canvas);
        const r = await recognize(canvas, ({ label, progress: p }) => {
          say(`OCR on ${of}: ${label.toLowerCase()} ${Math.round(p * 100)}%`);
          progress((i + p) / pages.length);
        });
        // Keep the text layer if OCR found less (e.g. "OCR all" on a page OCR can't read).
        if (!forceOcr || r.text) { text = r.text; ocr = true; conf = r.confidence; }
      }
      page.cleanup();
      done.push({ n, text, ocr, conf });
      const li = document.createElement('li');
      li.className = ocr ? 'ocr' : '';
      li.textContent = `p${n}: ${ocr ? `OCR ${conf}%` : 'text'}`;
      li.title = ocr ? `Page ${n} was read with OCR (confidence ${conf}%)` : `Page ${n} came from the PDF's own text`;
      pagesList.append(li);
    }
  } finally { doc.destroy(); canvas.width = canvas.height = 0; progress(null); showNotice(); }

  out.value = joinPages(done);
  outBox.hidden = false;
  const nOcr = done.filter((p) => p.ocr).length;
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  say(`Extracted ${done.length} page${done.length === 1 ? '' : 's'} in ${secs} s` +
    (nOcr ? ` (${nOcr} with OCR, marked "(OCR)" — check those for mistakes).` : '.') + ' Nothing was uploaded.');
}

runBtn.onclick = async () => {
  runBtn.disabled = true; say('Working…');
  try { await extract(); }
  catch (e) { console.error(e); say(e.message || 'Something went wrong.', true); }
  finally { runBtn.disabled = !item; }
};

$('#copy').onclick = async () => {
  const s = $('#copy-status');
  try { await navigator.clipboard.writeText(out.value); s.textContent = 'Copied.'; }
  catch { out.select(); s.textContent = 'Press Ctrl+C (⌘C) to copy.'; }
};
$('#download').onclick = () => downloadBlob(new Blob([out.value], { type: 'text/plain;charset=utf-8' }), `${baseName(item?.file.name || 'document')}.txt`);
