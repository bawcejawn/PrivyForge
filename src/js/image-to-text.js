// Image → text: OCR with tesseract.js in a Web Worker. Images are decoded in the page and
// never uploaded; the OCR engine and English data come from this site's own origin.
import '../css/ocr.css';
import { $, formatBytes, downloadBlob, baseName, setupDropzone } from './util.js';
import { recognize, imageToCanvas, OCR_DOWNLOAD_LABEL, ocrCachedBefore } from './ocr-engine.js';

const drop = $('#drop'), results = $('#results'), notice = $('#ocr-notice'), status = $('#status'), allBtn = $('#download-all');
const items = [];
const say = (msg, err = false) => { status.textContent = msg; status.classList.toggle('err', err); };

notice.querySelector('[data-size]').textContent = OCR_DOWNLOAD_LABEL;
notice.hidden = ocrCachedBefore();

const txtBlob = (s) => new Blob([s.endsWith('\n') ? s : s + '\n'], { type: 'text/plain;charset=utf-8' });

function card(file) {
  const li = document.createElement('li');
  li.className = 'ocr-card';
  li.innerHTML = `<div class="ocr-head"><img alt="" /><div><div class="name"></div><div class="meta">Waiting…</div>
      <div class="ocr-progress"><i></i></div></div></div>
    <textarea class="ocr-text" spellcheck="false" hidden></textarea>
    <div class="ocr-actions" hidden><button class="btn sm" data-copy>Copy text</button>
      <button class="btn sm ghost" data-dl>Download .txt</button><span class="status" role="status"></span></div>`;
  const url = URL.createObjectURL(file);
  const img = li.querySelector('img');
  img.src = url; img.onerror = () => { img.removeAttribute('src'); };
  li.querySelector('.name').textContent = file.name || 'Pasted image';
  li.querySelector('textarea').setAttribute('aria-label', `Text from ${file.name || 'image'}`);
  const item = { file, li, url, text: '', meta: li.querySelector('.meta'), bar: li.querySelector('.ocr-progress'), ta: li.querySelector('textarea') };
  item.ta.addEventListener('input', () => { item.text = item.ta.value; });
  const s = li.querySelector('.ocr-actions .status');
  li.querySelector('[data-copy]').onclick = async () => {
    try { await navigator.clipboard.writeText(item.ta.value); s.textContent = 'Copied.'; }
    catch { item.ta.select(); s.textContent = 'Press Ctrl+C (⌘C) to copy.'; }
  };
  li.querySelector('[data-dl]').onclick = () => downloadBlob(txtBlob(item.ta.value), `${baseName(file.name || 'image')}.txt`);
  results.append(li);
  return item;
}

let running = false;
async function processQueue() {
  if (running) return;
  running = true; $('#clear').disabled = true;
  try {
    for (let next; (next = items.find((i) => !i.started));) {
      next.started = true;
      const { meta, bar, ta } = next;
      const fill = bar.querySelector('i');
      const n = items.indexOf(next) + 1;
      say(`Reading image ${n} of ${items.length}…`);
      try {
        meta.textContent = 'Opening image…';
        const canvas = await imageToCanvas(next.file);
        const r = await recognize(canvas, ({ label, progress }) => {
          meta.textContent = `${label} · ${Math.round(progress * 100)}%`;
          fill.style.width = `${Math.round(progress * 100)}%`;
        });
        canvas.width = canvas.height = 0;
        next.text = r.text;
        ta.value = r.text; ta.hidden = false;
        next.li.querySelector('.ocr-actions').hidden = false;
        const words = r.text ? r.text.split(/\s+/).filter(Boolean).length : 0;
        meta.textContent = words
          ? `${words} word${words === 1 ? '' : 's'} · confidence ${r.confidence}% · ${formatBytes(next.file.size)}`
          : 'No text found. Try a sharper or larger image.';
        notice.hidden = true;
      } catch (e) {
        console.error(e);
        meta.classList.add('err');
        meta.textContent = /format/.test(e.message)
          ? `${e.message} Convert it to JPG first (HEIC photos: use HEIC to JPG).`
          : `Couldn’t read this image: ${e.message || 'unknown error'}`;
      }
      bar.hidden = true;
      refreshAll();
    }
    const done = items.filter((i) => i.text).length;
    say(`Done: text found in ${done} of ${items.length} image${items.length === 1 ? '' : 's'}. Nothing was uploaded.`);
  } finally { running = false; $('#clear').disabled = false; }
}

function refreshAll() {
  allBtn.hidden = items.filter((i) => i.text).length < 2;
}

allBtn.onclick = () => {
  const parts = items.filter((i) => i.text).map((i) => `--- ${i.file.name || 'image'} ---\n\n${i.ta.value.trim()}`);
  downloadBlob(txtBlob(parts.join('\n\n')), 'image-text.txt');
};

$('#clear').onclick = () => {
  if (running) return;
  items.splice(0).forEach((i) => { URL.revokeObjectURL(i.url); i.li.remove(); });
  refreshAll(); say('');
};

setupDropzone(drop, {
  accept: 'image/*,.heic,.heif',
  onFiles(files) {
    for (const f of files) items.push(card(f));
    processQueue();
  },
});
