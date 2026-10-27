// Remove Photo Location & Metadata. JPEG/PNG/WebP are stripped losslessly by lib/metadata.js;
// HEIC/HEIF is decoded (natively in Safari, otherwise by the lazily loaded libheif decoder)
// and re-saved as a JPG, which carries no metadata. Everything happens in this tab.
import { zipSync } from 'fflate';
import { $, formatBytes, downloadBlob, baseName, setupDropzone } from './util.js';
import { detectFormat, inspect, strip, summarize, MetadataError } from './lib/metadata.js';
import { isHeicFile, nativeHeic, decodeHeic, DecoderLoadError } from './heic.js';
import '../css/images.css';
import '../css/metadata.css';

const drop = $('#drop');
const list = $('#files');
const summary = $('#summary');
const zipBtn = $('#zip');
const clearBtn = $('#clear');
const items = []; // { file, card, result: { blob, name, hadLocation }, url }

const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});

function cardFor(file) {
  const li = el('li', 'mcard');
  li.innerHTML = `
    <div class="mcard-head">
      <div class="mthumb" aria-hidden="true">IMG</div>
      <div class="mcard-info"><div class="name"></div><div class="msize"><span class="before"></span> → <span class="out">working…</span></div></div>
      <div class="act"></div>
    </div>
    <div class="mcard-body"></div>`;
  li.querySelector('.name').textContent = file.name;
  li.querySelector('.before').textContent = formatBytes(file.size);
  return li;
}

function renderFound(card, entries, note) {
  const body = card.querySelector('.mcard-body');
  body.replaceChildren();
  const removed = entries.filter((e) => e.kind !== 'kept');
  const kept = entries.filter((e) => e.kind === 'kept');
  if (removed.length || !note) body.append(el('p', 'mfound-h', removed.length ? 'Found and removed:' : 'No location or camera data found. The file was already clean.'));
  if (removed.length) {
    const ul = el('ul', 'mfound');
    for (const e of removed) {
      const li = el('li', `mf-${e.kind}`);
      li.append(el('b', '', `${e.label}${e.value ? ': ' : ''}`));
      if (e.value) li.append(el('span', '', e.value));
      if (e.kind === 'location') li.append(el('span', 'mf-why', ' — anyone with this file can see where it was taken'));
      ul.append(li);
    }
    body.append(ul);
  }
  if (kept.length) body.append(el('p', 'mkept', `Kept: ${kept.map((k) => k.label.replace(' (kept)', '') + (k.value ? ` (${k.value})` : '')).join(', ')}. ${kept.some((k) => k.label.startsWith('Orientation')) ? 'Keeping the orientation stops the photo from showing up sideways.' : ''}`.trim()));
  if (note) body.append(el('p', 'mkept', note));
}

async function heicToJpeg(file, onStage) {
  let bitmap;
  if (await nativeHeic()) bitmap = await createImageBitmap(file);
  else { onStage('loading HEIC decoder…'); bitmap = await decodeHeic(file); }
  onStage('converting…');
  const c = document.createElement('canvas');
  c.width = bitmap.width; c.height = bitmap.height;
  c.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('JPEG encode failed'))), 'image/jpeg', 0.92));
  c.width = c.height = 0;
  return blob;
}

async function process(item) {
  const { file, card } = item;
  const out = card.querySelector('.out');
  const stage = (s) => { out.textContent = s; };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = detectFormat(bytes) || ((await isHeicFile(file)) ? 'heic' : null);
  let blob, name, entries, note = '';
  if (format === 'heic') {
    if (!(await nativeHeic())) $('#heic-decoder').hidden = false;
    blob = await heicToJpeg(file, stage);
    name = `${baseName(file.name)}-clean.jpg`;
    entries = [];
    note = 'HEIC photo converted to JPG. The new file is a fresh image with no metadata at all (no location, dates or camera details), and the rotation is applied to the pixels so it displays upright. This step re-encodes the image at high quality (92).';
    item.hadLocation = false;
  } else if (format) {
    const report = inspect(bytes);
    const clean = strip(bytes);
    // Belt and braces: re-read our own output.
    const after = inspect(clean);
    if (after.gps || after.xmp || after.iptc || after.textKeys.length || after.comments.length) throw new Error('Metadata still present after stripping');
    blob = new Blob([clean], { type: MIME[format] });
    name = `${baseName(file.name)}-clean.${EXT[format]}`;
    entries = summarize(report);
    item.hadLocation = entries.some((e) => e.kind === 'location');
  } else {
    throw new MetadataError('unsupported');
  }
  item.result = { blob, name };
  if (item.url) URL.revokeObjectURL(item.url);
  item.url = URL.createObjectURL(blob);
  const diff = file.size - blob.size;
  out.textContent = formatBytes(blob.size);
  if (format !== 'heic' && diff > 0) out.append(el('span', 'save', ` −${formatBytes(diff)} of metadata`));
  card.dataset.bytes = blob.size;
  card.dataset.format = format;
  renderFound(card, entries, note);
  const img = new Image(); img.alt = ''; img.src = item.url;
  img.onload = () => card.querySelector('.mthumb').replaceChildren(img);
  const dl = el('button', 'btn sm', 'Download');
  dl.onclick = () => downloadBlob(blob, name);
  card.querySelector('.act').replaceChildren(dl);
}

function failMessage(e) {
  if (e instanceof DecoderLoadError) return 'Couldn’t load the HEIC decoder (a one-time download). Check your connection and add the photo again.';
  if (e?.heic) return 'Couldn’t read this HEIC photo. The file may be damaged or incomplete.';
  if (e instanceof MetadataError && e.message === 'unsupported') return 'This isn’t a JPG, PNG, WebP or HEIC photo, so it can’t be cleaned here. Nothing was changed.';
  if (e instanceof MetadataError) return `${e.message} Nothing was changed.`;
  return 'Couldn’t clean this file. It may be damaged. Nothing was changed.';
}

let chain = Promise.resolve();
function add(files) {
  for (const file of files) {
    const card = cardFor(file);
    const item = { file, card };
    items.push(item); list.append(card);
    chain = chain.then(() => process(item)).catch((e) => {
      item.result = null;
      card.classList.add('mcard-err');
      card.querySelector('.out').replaceChildren(el('span', 'file-err', 'not cleaned'));
      const p = el('p', 'file-err', failMessage(e)); p.title = e?.message || '';
      card.querySelector('.mcard-body').replaceChildren(p);
    }).finally(update);
  }
  update();
}

function update() {
  const done = items.filter((i) => i.result);
  zipBtn.hidden = done.length < 2;
  zipBtn.disabled = done.length < 2;
  clearBtn.disabled = !items.length;
  if (!done.length) { summary.hidden = true; return; }
  const before = done.reduce((s, i) => s + i.file.size, 0);
  const after = done.reduce((s, i) => s + i.result.blob.size, 0);
  const loc = done.filter((i) => i.hadLocation).length;
  summary.hidden = false;
  summary.textContent = `${done.length} photo${done.length > 1 ? 's' : ''} cleaned: ${formatBytes(before)} → ${formatBytes(after)}.${loc ? ` Location removed from ${loc}.` : ''} Done on your device, nothing uploaded.`;
}

setupDropzone(drop, { accept: '*/*', onFiles: add });

zipBtn.onclick = async () => {
  const files = {};
  for (const i of items.filter((x) => x.result)) {
    let n = i.result.name, k = 1;
    while (files[n]) n = i.result.name.replace(/(\.\w+)$/, `-${k++}$1`);
    files[n] = [new Uint8Array(await i.result.blob.arrayBuffer()), { level: 0 }];
  }
  downloadBlob(new Blob([zipSync(files)], { type: 'application/zip' }), 'photos-without-metadata.zip');
};
clearBtn.onclick = () => {
  items.forEach((i) => i.url && URL.revokeObjectURL(i.url));
  items.length = 0; list.replaceChildren(); update();
};
