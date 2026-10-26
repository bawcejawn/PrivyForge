// AcroForm helpers for Fill PDF Form. Works on pdf-lib documents (browser or node),
// no DOM. Unit-tested in tests/sign.test.js with forms built by pdf-lib itself.
import {
  PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList,
  PDFButton, PDFSignature, PDFName, PDFString, PDFHexString, PDFArray, PDFDict,
} from 'pdf-lib';

/** Field kinds we can fill, plus 'button' / 'signature' / 'unknown' which we only list. */
export const FILLABLE = ['text', 'multiline', 'checkbox', 'radio', 'dropdown', 'optionlist'];

/** pdf-lib field instance -> normalized kind. Uses instanceof (constructor names get minified). */
export function fieldKind(field) {
  if (field instanceof PDFTextField) return field.isMultiline() ? 'multiline' : 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'optionlist';
  if (field instanceof PDFButton) return 'button';
  if (field instanceof PDFSignature) return 'signature';
  return 'unknown';
}

/** Human label for a field: tooltip (/TU) if present, otherwise the last part of its name. */
export function fieldLabel(field) {
  let tu;
  try { tu = field.acroField.dict.lookup(PDFName.of('TU')); } catch { tu = undefined; }
  const text = tu instanceof PDFString || tu instanceof PDFHexString ? tu.decodeText().trim() : '';
  if (text) return text;
  const name = field.getName();
  return name.split('.').filter(Boolean).pop() || name;
}

/** Map every annotation dict to its page index, so widgets can be placed in page order. */
function annotPages(doc) {
  const map = new Map();
  doc.getPages().forEach((page, i) => {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) return;
    for (let k = 0; k < annots.size(); k++) {
      const a = annots.lookup(k);
      if (a instanceof PDFDict) map.set(a, i);
    }
  });
  return map;
}

function currentValue(field, kind) {
  switch (kind) {
    case 'text': case 'multiline': return field.getText() ?? '';
    case 'checkbox': return field.isChecked();
    case 'radio': return field.getSelected() ?? '';
    case 'dropdown': return field.getSelected()[0] ?? '';
    case 'optionlist': return field.getSelected();
    default: return null;
  }
}

/**
 * Describe all fields in reading order (page, then top-to-bottom, then left-to-right).
 * Each entry: { name, label, kind, page (0-based, -1 if unknown), rects: [{page,x,y,width,height}],
 *               value, options, readOnly, required, maxLength, multiSelect, editable, field }
 */
export function listFields(doc) {
  const form = doc.getForm();
  const pages = annotPages(doc);
  const pageRefs = new Map(doc.getPages().map((p, i) => [p.ref, i]));
  const out = [];
  for (const field of form.getFields()) {
    const kind = fieldKind(field);
    const rects = [];
    for (const w of field.acroField.getWidgets()) {
      let page = pages.get(w.dict);
      if (page === undefined) page = pageRefs.get(w.P()) ?? -1;
      const r = w.getRectangle();
      rects.push({ page, x: r.x, y: r.y, width: r.width, height: r.height });
    }
    const first = rects.filter((r) => r.page >= 0).sort((a, b) => a.page - b.page || b.y + b.height - (a.y + a.height) || a.x - b.x)[0];
    const e = {
      name: field.getName(), label: fieldLabel(field), kind, field,
      page: first ? first.page : -1, top: first ? first.y + first.height : 0, left: first ? first.x : 0,
      rects, value: null, options: [], readOnly: field.isReadOnly(), required: field.isRequired(),
      maxLength: undefined, multiSelect: false, editable: false,
    };
    try {
      e.value = currentValue(field, kind);
      if (kind === 'radio' || kind === 'dropdown' || kind === 'optionlist') e.options = field.getOptions();
      if (kind === 'text' || kind === 'multiline') e.maxLength = field.getMaxLength();
      if (kind === 'dropdown') { e.editable = field.isEditable(); e.multiSelect = field.isMultiselect(); }
      if (kind === 'optionlist') e.multiSelect = field.isMultiselect();
    } catch { e.kind = 'unknown'; }
    out.push(e);
  }
  // Unknown page sorts last; then higher on the page first (PDF y grows upward).
  out.sort((a, b) => ((a.page < 0) - (b.page < 0)) || a.page - b.page || b.top - a.top || a.left - b.left);
  return out;
}

/**
 * Apply values to fields. `values` maps field name -> value:
 * text: string, checkbox: boolean, radio/dropdown: string ('' clears), optionlist: string[].
 * Read-only and non-fillable fields are skipped. Returns the names actually changed.
 */
export function applyValues(entries, values) {
  const changed = [];
  for (const e of entries) {
    if (!(e.name in values) || e.readOnly || !FILLABLE.includes(e.kind)) continue;
    const v = values[e.name], f = e.field;
    switch (e.kind) {
      case 'text': case 'multiline': {
        const s = String(v ?? '');
        if (s === (e.value ?? '')) continue;
        f.setText(e.maxLength ? s.slice(0, e.maxLength) : s); break;
      }
      case 'checkbox':
        if (!!v === e.value) continue;
        v ? f.check() : f.uncheck(); break;
      case 'radio':
        if (v === e.value) continue;
        v ? f.select(v) : f.clear(); break;
      case 'dropdown':
        if (v === e.value) continue;
        v ? f.select(v, false) : f.clear(); break;
      case 'optionlist': {
        const arr = (Array.isArray(v) ? v : [v]).filter(Boolean);
        if (JSON.stringify(arr) === JSON.stringify(e.value)) continue;
        arr.length ? f.select(e.multiSelect ? arr : arr.slice(0, 1), false) : f.clear(); break;
      }
    }
    changed.push(e.name);
  }
  return changed;
}

/** Characters Helvetica (WinAnsi) can't draw, so we can explain instead of failing silently. */
export function unencodable(font, text) {
  const bad = new Set();
  for (const ch of String(text)) {
    if (ch === '\n' || ch === '\r') continue;
    try { font.encodeText(ch); } catch { bad.add(ch); }
  }
  return [...bad];
}

/**
 * Does this document carry an XFA form, and does it have AcroForm fields to fall back on?
 * Must look at the catalog directly: pdf-lib's getForm() silently strips XFA.
 */
export function xfaStatus(doc) {
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const hasXFA = !!acro && acro.has(PDFName.of('XFA'));
  return { hasXFA, fieldCount: doc.getForm().getFields().length };
}
