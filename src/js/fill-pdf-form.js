// Fill PDF Form — fill AcroForm fields in the browser with pdf-lib; pdf.js shows the pages.
// Field discovery and value-setting live in lib/pdf-form.js (unit-tested).
import '../css/sign.css';
import { StandardFonts } from 'pdf-lib';
import { $, downloadBlob, baseName, setupDropzone, formatBytes } from './util.js';
import { loadPdf, openForRender, renderPage } from './pdf-common.js';
import { listFields, applyValues, unencodable, xfaStatus, FILLABLE } from './lib/pdf-form.js';
import { pageFrame, pdfToDisplay } from './lib/pdf-sign.js';

const drop = $('#drop'), editor = $('#editor'), fieldsEl = $('#fields'), preview = $('#preview');
const status = $('#status'), msg = $('#msg'), xfaNote = $('#xfa-note');
const say = (m, err = false) => { status.textContent = m; status.classList.toggle('err', err); };

// Sticky panels sit below the site's sticky header; track its height.
const syncHeader = () => document.documentElement.style.setProperty('--pf-hdr', `${document.querySelector('.site-header')?.offsetHeight || 0}px`);
syncHeader(); window.addEventListener('resize', syncHeader);

const KIND_LABEL = { text: 'Text', multiline: 'Text (multi-line)', checkbox: 'Checkbox', radio: 'Choice', dropdown: 'Dropdown', optionlist: 'List', button: 'Button', signature: 'Signature field', unknown: 'Unsupported field' };
let cur = null; // { file, bytes, entries, frames, renderDoc, hasXFA }

setupDropzone(drop, { accept: 'application/pdf,.pdf', multiple: false, onFiles: ([f]) => open(f) });
$('#reset').onclick = reset;

function reset() {
  cur?.renderDoc?.destroy(); cur = null;
  preview.querySelectorAll('.sign-page').forEach((el) => renderObs.unobserve(el));
  fieldsEl.replaceChildren(); preview.replaceChildren();
  editor.hidden = true; msg.hidden = true; drop.hidden = false; say('');
}

function showMessage(html) {
  msg.innerHTML = html; msg.hidden = false;
}

async function open(file) {
  reset(); say('Opening…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await loadPdf(bytes);
    const { hasXFA, fieldCount } = xfaStatus(doc);
    if (!fieldCount) {
      say('');
      if (hasXFA) {
        showMessage(`<h3>This is an XFA form, which isn't supported</h3>
          <p>The file uses Adobe's older XFA form technology (often from government agencies) instead of standard PDF form fields. The PDF library this tool uses can't read or fill XFA forms, and many browsers and PDF apps can't either. Open it in Adobe Acrobat Reader to fill it in.</p>
          <p>If you only need to write on it, <a href="/sign-pdf/">Sign PDF</a> can place text boxes, dates and checkmarks on any page, though some XFA files only show a "please wait" page outside Adobe Reader.</p>`);
      } else {
        showMessage(`<h3>This PDF has no fillable form fields</h3>
          <p>It's a flat or scanned document, so there are no boxes to fill in. You can still type on it: use <a href="/sign-pdf/">Sign PDF</a> to place text boxes, dates, checkmarks and your signature anywhere on the page.</p>`);
      }
      msg.querySelector('h3').insertAdjacentHTML('beforebegin', `<p class="hint"></p>`);
      msg.querySelector('.hint').textContent = file.name;
      return;
    }
    const entries = listFields(doc);
    const frames = doc.getPages().map((p) => {
      const b = p.getCropBox();
      return pageFrame([b.x, b.y, b.x + b.width, b.y + b.height], p.getRotation().angle);
    });
    cur = { file, bytes, entries, frames, hasXFA, renderDoc: await openForRender(bytes) };
    xfaNote.hidden = !hasXFA;
    buildFields(entries);
    buildPreview();
    drop.hidden = true; editor.hidden = false;
    const fillable = entries.filter((e) => FILLABLE.includes(e.kind) && !e.readOnly).length;
    $('#file-label').textContent = `${file.name} · ${frames.length} page${frames.length > 1 ? 's' : ''} · ${formatBytes(file.size)}`;
    say(`Found ${entries.length} field${entries.length > 1 ? 's' : ''} (${fillable} fillable). Fill them in, then download.`);
  } catch (e) { console.error(e); say(`${file.name}: ${e.message}`, true); }
}

// ------------------------------------------------------------------ generated form
function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

function buildFields(entries) {
  let lastPage = null;
  entries.forEach((e, i) => {
    if (e.page !== lastPage) {
      fieldsEl.append(el('h3', { textContent: e.page >= 0 ? `Page ${e.page + 1}` : 'Other fields' }));
      lastPage = e.page;
    }
    const id = `f${i}`;
    const box = el('div', { className: `ff k-${e.kind}${e.readOnly ? ' ro' : ''}` });
    box.dataset.idx = i;
    const labelText = el('span', { className: 'flabel', textContent: e.label });
    const nameText = e.label !== e.name ? el('span', { className: 'fname', textContent: e.name }) : null;
    const extra = [];
    if (e.readOnly) extra.push('read-only');
    if (e.required) extra.push('required');
    const meta = extra.length ? el('span', { className: 'fname', textContent: extra.join(' · ') }) : null;
    const disabled = e.readOnly;
    const tag = (n) => { n.dataset.field = e.name; n.id ||= id; n.disabled = disabled; return n; };

    switch (e.kind) {
      case 'text': case 'multiline': {
        const input = tag(e.kind === 'multiline' ? el('textarea', { rows: 3 }) : el('input', { type: 'text' }));
        input.value = e.value || '';
        if (e.maxLength) { input.maxLength = e.maxLength; }
        box.append(el('label', { htmlFor: id }, labelText, nameText, meta), input);
        break;
      }
      case 'checkbox': {
        const input = tag(el('input', { type: 'checkbox', checked: !!e.value }));
        box.append(el('label', { className: 'inline-check', htmlFor: id }, input, labelText), nameText, meta);
        break;
      }
      case 'radio': {
        const opts = el('div', { className: 'opts' });
        e.options.forEach((o, k) => {
          const input = tag(el('input', { type: 'radio', name: `r${i}`, value: o, id: `${id}-${k}`, checked: e.value === o }));
          opts.append(el('label', {}, input, el('span', { textContent: o })));
        });
        const clear = el('button', { type: 'button', className: 'btn ghost sm', textContent: 'Clear', disabled });
        clear.onclick = () => box.querySelectorAll('input').forEach((r) => { r.checked = false; });
        box.append(el('fieldset', {}, el('legend', {}, labelText, nameText, meta), opts, e.options.length ? null : el('span', { className: 'hint', textContent: 'No options defined.' })), clear);
        clear.style.marginTop = '6px';
        break;
      }
      case 'dropdown': case 'optionlist': {
        const sel = tag(el('select', { multiple: e.kind === 'optionlist' && e.multiSelect }));
        if (e.kind === 'dropdown') sel.append(el('option', { value: '', textContent: '—' }));
        const selected = new Set([].concat(e.value || []));
        for (const o of e.options) sel.append(el('option', { value: o, textContent: o, selected: selected.has(o) }));
        if (e.kind === 'optionlist') sel.size = Math.min(6, Math.max(2, e.options.length));
        box.append(el('label', { htmlFor: id }, labelText, nameText, meta), sel);
        if (e.kind === 'dropdown' && e.value && !e.options.includes(e.value)) {
          sel.append(el('option', { value: e.value, textContent: e.value, selected: true }));
        }
        break;
      }
      default:
        box.append(el('span', { className: 'flabel', textContent: e.label }), nameText,
          el('span', { className: 'fname', textContent: `${KIND_LABEL[e.kind]}: can't be filled here` }));
        box.classList.add('ro');
    }
    box.addEventListener('focusin', () => highlight(i, true));
    fieldsEl.append(box);
  });
}

function readValues() {
  const values = {};
  cur.entries.forEach((e, i) => {
    const box = fieldsEl.querySelector(`.ff[data-idx="${i}"]`);
    if (!box || e.readOnly) return;
    switch (e.kind) {
      case 'text': case 'multiline': values[e.name] = box.querySelector('[data-field]').value; break;
      case 'checkbox': values[e.name] = box.querySelector('[data-field]').checked; break;
      case 'radio': values[e.name] = box.querySelector('input:checked')?.value || ''; break;
      case 'dropdown': values[e.name] = box.querySelector('select').value; break;
      case 'optionlist': values[e.name] = [...box.querySelector('select').selectedOptions].map((o) => o.value); break;
    }
  });
  return values;
}

// ------------------------------------------------------------------ preview with field boxes
const renderObs = new IntersectionObserver((ents) => { for (const en of ents) if (en.isIntersecting) renderInto(en.target); }, { rootMargin: '400px 0px' });

function buildPreview() {
  cur.frames.forEach((f, p) => {
    const page = el('div', { className: 'sign-page' });
    page.dataset.page = p;
    page.style.aspectRatio = `${f.width} / ${f.height}`;
    page.append(el('canvas', { ariaHidden: 'true' }), el('div', { className: 'sign-layer' }), el('span', { className: 'sign-pno', textContent: `Page ${p + 1}` }));
    preview.append(page);
    renderObs.observe(page);
  });
  cur.entries.forEach((e, i) => {
    for (const r of e.rects) {
      if (r.page < 0 || !cur.frames[r.page]) continue;
      const f = cur.frames[r.page];
      const [ax, ay] = pdfToDisplay(f, r.x, r.y), [bx, by] = pdfToDisplay(f, r.x + r.width, r.y + r.height);
      const x0 = Math.min(ax, bx), y0 = Math.min(ay, by), w = Math.abs(bx - ax), h = Math.abs(by - ay);
      const b = el('div', { className: 'fbox', title: e.label });
      b.dataset.idx = i;
      Object.assign(b.style, { left: `${(x0 / f.width) * 100}%`, top: `${(y0 / f.height) * 100}%`, width: `${(w / f.width) * 100}%`, height: `${(h / f.height) * 100}%` });
      b.onclick = () => {
        const box = fieldsEl.querySelector(`.ff[data-idx="${i}"]`);
        const target = box?.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
        box?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        target ? target.focus({ preventScroll: true }) : highlight(i, false);
      };
      preview.querySelector(`.sign-page[data-page="${r.page}"] .sign-layer`).append(b);
    }
  });
}

function highlight(i, scroll) {
  fieldsEl.querySelectorAll('.ff.active').forEach((n) => n.classList.remove('active'));
  preview.querySelectorAll('.fbox.active').forEach((n) => n.classList.remove('active'));
  fieldsEl.querySelector(`.ff[data-idx="${i}"]`)?.classList.add('active');
  const boxes = preview.querySelectorAll(`.fbox[data-idx="${i}"]`);
  boxes.forEach((n) => n.classList.add('active'));
  // Only auto-scroll the preview when it sits beside the form (wide screens).
  if (scroll && boxes[0] && matchMedia('(min-width: 900px)').matches) {
    const pv = preview, r = boxes[0].getBoundingClientRect(), pr = pv.getBoundingClientRect();
    if (r.top < pr.top || r.bottom > pr.bottom) pv.scrollTo({ top: pv.scrollTop + r.top - pr.top - pr.height / 3, behavior: 'smooth' });
  }
}

async function renderInto(pageEl) {
  if (!cur || pageEl.dataset.rendered) return;
  pageEl.dataset.rendered = '1';
  const doc = cur.renderDoc;
  try {
    const page = await doc.getPage(+pageEl.dataset.page + 1);
    const vp = page.getViewport({ scale: 1 });
    const px = Math.max(300, pageEl.clientWidth * (window.devicePixelRatio || 1));
    const c = pageEl.querySelector('canvas');
    await renderPage(page, (72 * px) / vp.width, c);
    page.cleanup();
  } catch (e) { if (cur && doc === cur.renderDoc) console.warn('render failed', e); }
}

// ------------------------------------------------------------------ save
$('#save').onclick = async () => {
  if (!cur) return;
  const btn = $('#save'); btn.disabled = true; say('Saving…');
  try {
    const doc = await loadPdf(cur.bytes);
    const entries = listFields(doc);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const values = readValues();
    for (const e of entries) {
      const v = values[e.name];
      if (typeof v !== 'string' && !Array.isArray(v)) continue;
      const bad = unencodable(font, [].concat(v).join(''));
      if (bad.length) throw new Error(`"${e.label}" contains characters the standard PDF font can't show (${bad.join(' ')}). Replace them and try again.`);
    }
    const changed = applyValues(entries, values);
    const form = doc.getForm();
    if (cur.hasXFA) form.deleteXFA();
    form.updateFieldAppearances(font);
    const flatten = $('#flatten').checked;
    if (flatten) form.flatten({ updateFieldAppearances: false });
    const out = await doc.save({ useObjectStreams: true, updateFieldAppearances: false });
    const name = `${baseName(cur.file.name)}-filled.pdf`;
    downloadBlob(new Blob([out], { type: 'application/pdf' }), name);
    say(`Saved ${name} (${formatBytes(out.length)}): ${changed.length} field${changed.length === 1 ? '' : 's'} changed${flatten ? ', form flattened' : ''}. Nothing was uploaded.`);
  } catch (e) {
    console.error(e);
    say(/flatten|appearance/i.test(e.message) && $('#flatten').checked
      ? `Couldn't flatten this form (${e.message}). Try again with "Flatten form" unticked.`
      : e.message || 'Something went wrong.', true);
  } finally { btn.disabled = false; }
};
