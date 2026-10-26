// Compress a PDF to a target size (default 1 MB) — entirely in the browser.
// Strategy: lossless re-save first; if that's too big, re-render pages as JPEG images down a
// DPI/quality ladder (src/js/lib/size-search.js) until the file fits.
import '../css/pdf2.css';
import { $, formatBytes, downloadBlob, baseName, setupDropzone } from './util.js';
import { loadPdf, thumbnail, rasterize, resave } from './pdf-common.js';
import { findTargetSize, PDF_LADDER, settingLabel } from './lib/size-search.js';

const drop = $('#drop'), list = $('#files'), runBtn = $('#run'), status = $('#status');
const targetSel = $('#target'), box = $('#result');
let item = null; // { file, bytes, pages, row }
let lastOut = null;

const say = (msg, err = false) => { status.textContent = msg; status.classList.toggle('err', err); };
const fmtExact = (n) => `${n.toLocaleString('en-US')} bytes`;

async function add([file]) {
  say(''); box.hidden = true; lastOut = null;
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
    li.querySelector('[data-remove]').onclick = () => { li.remove(); item = null; box.hidden = true; refresh(); };
    item.row = li; list.append(li);
    thumbnail(bytes, li.querySelector('canvas'));
  } catch (e) { say(`${file.name}: ${e.message}`, true); }
  refresh();
}

function refresh() {
  runBtn.disabled = !item;
  if (!status.classList.contains('err')) say(item ? 'Ready.' : '');
}

setupDropzone(drop, { accept: 'application/pdf,.pdf', multiple: false, onFiles: add });

function showResult(r, target) {
  const label = targetSel.selectedOptions[0].text.replace(/\s*\(.*$/, '');
  const original = item.bytes.length;
  const lossless = !!(r.settings.lossless || r.settings.original);
  box.hidden = false;
  box.className = `result-box ${r.ok ? 'ok' : 'warn'}`;
  box.innerHTML = `<h3></h3><div class="big"></div><p class="how"></p><p class="note"></p>
    <button class="btn sm" id="again" type="button">Download again</button><ul class="attempts" aria-label="Settings tried"></ul>`;
  box.querySelector('h3').textContent = r.ok ? `Done — under ${label}` : `Couldn't reach ${label}`;
  box.querySelector('.big').textContent = `${formatBytes(original)} → ${formatBytes(r.size)}`;
  box.querySelector('.how').textContent = r.settings.original
    ? `Your original file already fits (${fmtExact(r.size)}), so it was returned unchanged.`
    : `Setting used: ${settingLabel(r.settings)} · ${fmtExact(r.size)} (target ${fmtExact(target)}).`;
  box.querySelector('.note').textContent = !r.ok
    ? `This is the smallest version we could make (lowest setting tried: 72 DPI). Try splitting the PDF into parts with Split PDF, or pick a larger target.`
    : lossless
      ? 'Text is still selectable and searchable: pages were not converted to images.'
      : 'Pages are now images, so text in this file can no longer be selected or searched. Check that small print is still readable before you send it.';
  if (!r.ok) {
    const a = document.createElement('a'); a.href = '/split-pdf/'; a.textContent = 'Open Split PDF';
    box.querySelector('.note').append(' ', a);
  }
  const ul = box.querySelector('.attempts');
  for (const a of r.attempts) {
    const li = document.createElement('li');
    const chosen = a.settings === r.settings;
    li.innerHTML = '<span></span><span></span>';
    li.children[0].textContent = (chosen ? '▸ ' : '') + settingLabel(a.settings);
    li.children[1].textContent = `${formatBytes(a.size)} ${a.fits ? '✓ fits' : '✗ too big'}`;
    if (a.fits) li.children[1].className = 'fit';
    if (chosen) li.classList.add('chosen');
    ul.append(li);
  }
  $('#again').onclick = () => lastOut && downloadBlob(lastOut.blob, lastOut.name);
}

async function run() {
  const target = +targetSel.value;
  const name = `${baseName(item.file.name)}-compressed.pdf`;
  box.hidden = true;

  let r;
  if (item.bytes.length <= target) {
    // Already fits: offer a lossless re-save if it's smaller, otherwise the untouched original.
    say('Already under the target — trying a lossless re-save…');
    const out = await resave(item.bytes);
    const orig = { settings: { original: true, label: 'Original file' }, size: item.bytes.length, fits: true };
    const re = { settings: PDF_LADDER[0], size: out.length, fits: out.length <= target };
    r = { ok: true, ...(out.length < item.bytes.length ? { ...re, result: out } : { ...orig, result: item.bytes }), attempts: [orig, re] };
  } else {
    r = await findTargetSize({
      target,
      trySettings: async (s) => {
        if (s.lossless) {
          say('Trying a lossless re-save…');
          const out = await resave(item.bytes);
          return out.length < item.bytes.length ? out : item.bytes;
        }
        return rasterize(item.bytes, s, (n, total) => say(`Trying ${settingLabel(s)} — page ${n} of ${total}…`));
      },
      onAttempt: (a) => say(`${settingLabel(a.settings)}: ${formatBytes(a.size)} ${a.fits ? '— fits.' : '— too big, trying smaller…'}`),
    });
  }
  lastOut = { blob: new Blob([r.result], { type: 'application/pdf' }), name };
  downloadBlob(lastOut.blob, name);
  showResult(r, target);
  say(r.ok ? `Saved ${name} (${formatBytes(r.size)}). Nothing was uploaded.` : `Saved the smallest version (${formatBytes(r.size)}) — still over the target.`, !r.ok);
}

runBtn.onclick = async () => {
  runBtn.disabled = true; targetSel.disabled = true; say('Working…');
  try { await run(); }
  catch (e) { console.error(e); say(e.message || 'Something went wrong.', true); }
  finally { runBtn.disabled = !item; targetSel.disabled = false; }
};
