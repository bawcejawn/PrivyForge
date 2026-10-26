import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import {
  normRotation, pageFrame, displayToPdf, pdfToDisplay, itemMatrix, applyMatrix, clientToDisplay,
  clampBox, boxAt, formatDate, parseISODate, todayISO, DATE_FORMATS, removeWhite, inkBounds, strokeWidth,
} from '../src/js/lib/pdf-sign.js';
import { fieldKind, fieldLabel, listFields, applyValues, unencodable, xfaStatus } from '../src/js/lib/pdf-form.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const nearPt = (p, q) => { near(p[0], q[0]); near(p[1], q[1]); };
const LETTER = [0, 0, 612, 792], A4 = [0, 0, 595.28, 841.89];

test('normRotation handles negatives, >360 and junk', () => {
  assert.deepEqual([0, 90, 180, 270, 360, 450, -90, -270, 720, undefined, 'x'].map(normRotation), [0, 90, 180, 270, 0, 90, 270, 90, 0, 0, 0]);
});

test('pageFrame swaps width/height for 90/270 and orders the box', () => {
  assert.deepEqual([pageFrame(A4, 0).width, pageFrame(A4, 0).height], [595.28, 841.89]);
  assert.deepEqual([pageFrame(A4, 90).width, pageFrame(A4, 90).height], [841.89, 595.28]);
  assert.deepEqual([pageFrame(A4, -90).width, pageFrame(A4, 270).height], [841.89, 595.28]);
  const f = pageFrame([612, 792, 0, 0]);
  assert.deepEqual([f.x0, f.y0, f.x1, f.y1], [0, 0, 612, 792]);
});

// Where each displayed corner must land in user space, by rotation. Box offset (x0,y0)=(10,20)
// and a non-letter size (300 x 500) so mistakes that assume 0,0 or letter show up.
test('displayToPdf: corners map correctly for every rotation and box offset', () => {
  const box = [10, 20, 310, 520]; // W=300, H=500
  const cases = {
    0: { tl: [10, 520], tr: [310, 520], bl: [10, 20], br: [310, 20] },
    // Rotate 90 CW for display: user's lower-left corner appears top-left.
    90: { tl: [10, 20], tr: [10, 520], bl: [310, 20], br: [310, 520] },
    180: { tl: [310, 20], tr: [10, 20], bl: [310, 520], br: [10, 520] },
    270: { tl: [310, 520], tr: [310, 20], bl: [10, 520], br: [10, 20] },
  };
  for (const [r, exp] of Object.entries(cases)) {
    const f = pageFrame(box, +r);
    const W = f.width, H = f.height;
    nearPt(displayToPdf(f, 0, 0), exp.tl);
    nearPt(displayToPdf(f, W, 0), exp.tr);
    nearPt(displayToPdf(f, 0, H), exp.bl);
    nearPt(displayToPdf(f, W, H), exp.br);
  }
});

test('pdfToDisplay is the exact inverse of displayToPdf', () => {
  for (const r of [0, 90, 180, 270]) {
    const f = pageFrame([-50, 30, 545.28, 871.89], r);
    for (const [dx, dy] of [[0, 0], [12.5, 400], [f.width, f.height], [f.width / 3, 7]]) {
      const [x, y] = displayToPdf(f, dx, dy);
      nearPt(pdfToDisplay(f, x, y), [dx, dy]);
    }
  }
});

test('pdfToDisplay matches pdf.js convention for /Rotate 90 (dx = y - y0, dy = x - x0)', () => {
  const f = pageFrame(A4, 90);
  nearPt(pdfToDisplay(f, 100, 200), [200, 100]);
});

test('itemMatrix: an item drawn in local space lands on its display box, upright', () => {
  for (const box of [LETTER, A4, [10, 20, 310, 520]]) {
    for (const r of [0, 90, 180, 270]) {
      const f = pageFrame(box, r);
      const item = { x: 40, y: 60, w: 120, h: 30 };
      const M = itemMatrix(f, item);
      // local (0,0) = display bottom-left, (w,h) = display top-right
      nearPt(applyMatrix(M, 0, 0), displayToPdf(f, item.x, item.y + item.h));
      nearPt(applyMatrix(M, item.w, 0), displayToPdf(f, item.x + item.w, item.y + item.h));
      nearPt(applyMatrix(M, 0, item.h), displayToPdf(f, item.x, item.y));
      nearPt(applyMatrix(M, item.w, item.h), displayToPdf(f, item.x + item.w, item.y));
      // pure rotation/flip-free: determinant +1 (no mirroring) and unit scale
      const [a, b, c, d] = M;
      near(a * d - b * c, 1);
    }
  }
});

test('itemMatrix on rotated pages counter-rotates content (so it reads upright)', () => {
  // On /Rotate 90 the viewer turns the page clockwise; text must run along user +y.
  const [a, b] = itemMatrix(pageFrame(A4, 90), { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual([a, b], [0, 1]);
  const [a2, b2] = itemMatrix(pageFrame(A4, 270), { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual([a2, b2], [0, -1]);
  const [a3, b3] = itemMatrix(pageFrame(A4, 180), { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual([a3, b3], [-1, 0]);
});

test('itemMatrix matches pdf-lib drawing for a real rotated page (round trip through user space)', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  page.setRotation(degrees(270));
  const cb = page.getCropBox();
  const f = pageFrame([cb.x, cb.y, cb.x + cb.width, cb.y + cb.height], page.getRotation().angle);
  assert.equal(f.width, 841.89);
  const M = itemMatrix(f, { x: 700, y: 500, w: 100, h: 50 });
  const corners = [[0, 0], [100, 0], [0, 50], [100, 50]].map(([u, v]) => applyMatrix(M, u, v));
  for (const [x, y] of corners) {
    assert.ok(x >= 0 && x <= 595.28 && y >= 0 && y <= 841.89, `corner off page: ${x},${y}`);
  }
});

test('clientToDisplay scales and clamps pointer positions', () => {
  const f = pageFrame(A4, 90);
  const rect = { left: 100, top: 50, width: 400, height: 400 * f.height / f.width };
  nearPt(clientToDisplay(rect, 300, 50 + rect.height / 2, f), [f.width / 2, f.height / 2]);
  nearPt(clientToDisplay(rect, 0, 9999, f), [0, f.height]);
});

test('clampBox / boxAt keep items on the page', () => {
  const f = pageFrame(LETTER);
  assert.deepEqual(clampBox({ x: -10, y: 780, w: 100, h: 40 }, f), { x: 0, y: 752, w: 100, h: 40 });
  assert.deepEqual(clampBox({ x: 0, y: 0, w: 1000, h: 10 }, f), { x: 0, y: 0, w: 612, h: 10 });
  const b = boxAt(f, 306, 396, 200, 4);
  assert.deepEqual(b, { x: 206, y: 371, w: 200, h: 50 });
});

test('formatDate: all formats, zero padding, invalid input', () => {
  const iso = '2026-03-07';
  const want = { 'MM/DD/YYYY': '03/07/2026', 'DD/MM/YYYY': '07/03/2026', 'YYYY-MM-DD': '2026-03-07', 'MMMM D, YYYY': 'March 7, 2026', 'D MMMM YYYY': '7 March 2026', 'DD.MM.YYYY': '07.03.2026' };
  assert.deepEqual(Object.keys(DATE_FORMATS).sort(), Object.keys(want).sort());
  for (const [fmt, s] of Object.entries(want)) assert.equal(formatDate(iso, fmt), s);
  assert.equal(formatDate(iso), '03/07/2026');
  assert.equal(formatDate('2026-02-30'), '');
  assert.equal(formatDate('not a date'), '');
  assert.equal(formatDate('2024-02-29', 'MMMM D, YYYY'), 'February 29, 2024');
  assert.equal(parseISODate('2025-02-29'), null);
});

test('todayISO uses the local calendar date', () => {
  assert.equal(todayISO(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('removeWhite: white -> transparent, ink kept, edges ramp', () => {
  const px = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 200, 200, 200, 255, 20, 40, 160, 255]);
  removeWhite(px, 225, 40);
  assert.equal(px[3], 0);
  assert.equal(px[7], 255);
  assert.ok(px[11] > 0 && px[11] < 255, String(px[11])); // lum 200 is in the ramp
  assert.equal(px[15], 255); // dark blue ink untouched
});

test('inkBounds finds the drawn area (with padding) or null', () => {
  const w = 10, h = 8, d = new Uint8ClampedArray(w * h * 4);
  assert.equal(inkBounds(d, w, h), null);
  const set = (x, y) => { d[(y * w + x) * 4 + 3] = 255; };
  set(3, 2); set(6, 5);
  assert.deepEqual(inkBounds(d, w, h), { x: 3, y: 2, w: 4, h: 4 });
  assert.deepEqual(inkBounds(d, w, h, 8, 5), { x: 0, y: 0, w: 10, h: 8 });
});

test('strokeWidth: pens follow pressure, fast strokes thin out', () => {
  assert.ok(strokeWidth(3, { pen: true, pressure: 1 }) > strokeWidth(3, { pen: true, pressure: 0.2 }));
  assert.ok(strokeWidth(3, { speed: 3 }) < strokeWidth(3, { speed: 0 }));
});

// ---------------------------------------------------------------- forms

async function sampleForm() {
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([612, 792]), p2 = doc.addPage([595.28, 841.89]);
  const form = doc.getForm();
  const name = form.createTextField('applicant.name');
  name.addToPage(p1, { x: 72, y: 700, width: 200, height: 20 });
  name.acroField.dict.set((await import('pdf-lib')).PDFName.of('TU'), (await import('pdf-lib')).PDFHexString.fromText('Full legal name'));
  const notes = form.createTextField('notes'); notes.enableMultiline(); notes.addToPage(p2, { x: 72, y: 500, width: 300, height: 80 });
  const zip = form.createTextField('zip'); zip.setMaxLength(5); zip.addToPage(p1, { x: 300, y: 700, width: 80, height: 20 });
  const agree = form.createCheckBox('agree'); agree.addToPage(p1, { x: 72, y: 600, width: 14, height: 14 });
  const color = form.createRadioGroup('color');
  color.addOptionToPage('Red', p1, { x: 72, y: 550, width: 14, height: 14 });
  color.addOptionToPage('Blue', p1, { x: 120, y: 550, width: 14, height: 14 });
  const state = form.createDropdown('state'); state.addOptions(['CA', 'NY', 'TX']); state.addToPage(p1, { x: 72, y: 500, width: 100, height: 20 });
  const tags = form.createOptionList('tags'); tags.addOptions(['a', 'b', 'c']); tags.enableMultiselect(); tags.addToPage(p2, { x: 72, y: 300, width: 100, height: 60 });
  const locked = form.createTextField('locked'); locked.setText('fixed'); locked.enableReadOnly(); locked.addToPage(p2, { x: 72, y: 700, width: 100, height: 20 });
  const btn = form.createButton('go'); btn.addToPage('Go', p2, { x: 300, y: 100, width: 50, height: 20 });
  return doc;
}

test('listFields: kinds, labels (tooltip first), page order', async () => {
  const doc = await sampleForm();
  const f = listFields(doc);
  const byName = Object.fromEntries(f.map((e) => [e.name, e]));
  assert.equal(byName['applicant.name'].label, 'Full legal name');
  assert.equal(byName.zip.label, 'zip');
  assert.deepEqual(f.map((e) => [e.name, e.kind, e.page]), [
    ['applicant.name', 'text', 0], ['zip', 'text', 0], ['agree', 'checkbox', 0], ['color', 'radio', 0], ['state', 'dropdown', 0],
    ['locked', 'text', 1], ['notes', 'multiline', 1], ['tags', 'optionlist', 1], ['go', 'button', 1],
  ]);
  assert.deepEqual(byName.color.options, ['Red', 'Blue']);
  assert.equal(byName.color.rects.length, 2);
  assert.equal(byName.zip.maxLength, 5);
  assert.equal(byName.tags.multiSelect, true);
  assert.equal(byName.locked.readOnly, true);
  assert.equal(byName.agree.value, false);
});

test('fieldKind / fieldLabel on a single field', async () => {
  const doc = await sampleForm();
  const fld = doc.getForm().getField('notes');
  assert.equal(fieldKind(fld), 'multiline');
  assert.equal(fieldLabel(fld), 'notes');
  assert.equal(fieldKind({}), 'unknown');
});

test('applyValues fills every kind, skips read-only, survives save/reload', async () => {
  const doc = await sampleForm();
  const entries = listFields(doc);
  const changed = applyValues(entries, {
    'applicant.name': 'Jane Q. Public', zip: '9410799', agree: true, color: 'Blue', state: 'NY', tags: ['a', 'c'], notes: 'line 1\nline 2', locked: 'hacked', go: 'x',
  });
  assert.deepEqual(changed.sort(), ['agree', 'applicant.name', 'color', 'notes', 'state', 'tags', 'zip']);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.getForm().updateFieldAppearances(font);
  const again = await PDFDocument.load(await doc.save());
  const vals = Object.fromEntries(listFields(again).map((e) => [e.name, e.value]));
  assert.equal(vals['applicant.name'], 'Jane Q. Public');
  assert.equal(vals.zip, '94107'); // max length respected
  assert.equal(vals.agree, true);
  assert.equal(vals.color, 'Blue');
  assert.equal(vals.state, 'NY');
  assert.deepEqual(vals.tags, ['a', 'c']);
  assert.equal(vals.locked, 'fixed');
});

test('applyValues with unchanged values changes nothing', async () => {
  const doc = await sampleForm();
  const entries = listFields(doc);
  assert.deepEqual(applyValues(entries, { agree: false, 'applicant.name': '', color: '', tags: [] }), []);
});

test('unencodable reports characters Helvetica cannot draw', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  assert.deepEqual(unencodable(font, 'José Müller – 5€\n'), []);
  assert.deepEqual(unencodable(font, 'ok → 東'), ['→', '東']);
});

test('xfaStatus: plain AcroForm has no XFA; XFA detected before pdf-lib strips it', async () => {
  const doc = await sampleForm();
  assert.deepEqual(xfaStatus(doc), { hasXFA: false, fieldCount: 9 });
  const { PDFName } = await import('pdf-lib');
  const x = await sampleForm();
  x.catalog.lookup(PDFName.of('AcroForm')).set(PDFName.of('XFA'), x.context.obj([]));
  const reloaded = await PDFDocument.load(await x.save({ updateFieldAppearances: false }));
  const warn = console.warn; console.warn = () => {};
  try { assert.deepEqual(xfaStatus(reloaded), { hasXFA: true, fieldCount: 9 }); } finally { console.warn = warn; }
  const empty = await PDFDocument.create();
  assert.deepEqual(xfaStatus(empty), { hasXFA: false, fieldCount: 0 });
});
