import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, StandardFonts, degrees } from 'pdf-lib';
import {
  normRotation, makePages, rotatePage, finalRotation, movePage, parsePageNumbers, deleteNumbers,
  resetPages, buildPlan, sourceIndices, summarize, assemble,
} from '../src/js/lib/pdf-organize.js';

const order = (pages) => pages.map((p) => p.number);

test('organize: rotation normalization', () => {
  assert.deepEqual([0, 90, 180, 270, 360, 450, -90, -180, -270, -360, 720, 89, 46, 44, null, undefined, 'x'].map(normRotation),
    [0, 90, 180, 270, 0, 90, 270, 180, 90, 0, 0, 90, 90, 0, 0, 0, 0]);
  // existing /Rotate + user turns
  assert.equal(finalRotation(0, 90), 90);
  assert.equal(finalRotation(270, 90), 0);
  assert.equal(finalRotation(90, -90), 0);
  assert.equal(finalRotation(180, 270), 90);
  assert.equal(finalRotation(-90, 0), 270);   // invalid negative /Rotate in the input is normalized
  assert.equal(finalRotation(540, 180), 0);
});

test('organize: rotatePage accumulates quarter turns both ways', () => {
  const [p] = makePages(1);
  rotatePage(p, 90); rotatePage(p, 90); assert.equal(p.rotate, 180);
  rotatePage(p, -90); rotatePage(p, -90); rotatePage(p, -90); assert.equal(p.rotate, 270);
  rotatePage(p, 90); assert.equal(p.rotate, 0);
});

test('organize: makePages numbers pages across appended files', () => {
  const a = makePages(3, 0), b = makePages(2, 1, 4);
  assert.deepEqual([...a, ...b].map((p) => [p.id, p.src, p.index, p.number]),
    [['0:0', 0, 0, 1], ['0:1', 0, 1, 2], ['0:2', 0, 2, 3], ['1:0', 1, 0, 4], ['1:1', 1, 1, 5]]);
});

test('organize: range parser edge cases', () => {
  assert.deepEqual(parsePageNumbers('3-5, 9', 10), [3, 4, 5, 9]);
  assert.deepEqual(parsePageNumbers(' 9 ,3 - 5 ', 10), [3, 4, 5, 9]);   // spaces, any order -> sorted
  assert.deepEqual(parsePageNumbers('2,2,1-3', 10), [1, 2, 3]);        // duplicates/overlaps merged
  assert.deepEqual(parsePageNumbers('8-', 10), [8, 9, 10]);            // open end
  assert.deepEqual(parsePageNumbers('-2', 10), [1, 2]);                // open start
  assert.deepEqual(parsePageNumbers('10', 10), [10]);
  assert.deepEqual(parsePageNumbers('1,,3,', 5), [1, 3]);              // stray commas ignored
  for (const bad of ['', '   ', ',', '0', '11', '5-3', 'a', '1-2-3', '3.5', '1;2', '-', null, undefined]) {
    assert.equal(parsePageNumbers(bad, 10), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('organize: movePage moves, clamps and ignores bad sources', () => {
  const p = makePages(5);
  movePage(p, 3, 0); assert.deepEqual(order(p), [4, 1, 2, 3, 5]);
  movePage(p, 0, 4); assert.deepEqual(order(p), [1, 2, 3, 5, 4]);
  movePage(p, 1, 99); assert.deepEqual(order(p), [1, 3, 5, 4, 2]);
  movePage(p, 2, -5); assert.deepEqual(order(p), [5, 1, 3, 4, 2]);
  movePage(p, 9, 0); movePage(p, -1, 0); assert.deepEqual(order(p), [5, 1, 3, 4, 2]);
});

test('organize: delete by number, plan, summary and reset', () => {
  const p = makePages(10);
  rotatePage(p[1], 90);              // page 2 clockwise
  rotatePage(p[6], -90);             // page 7 counter-clockwise
  movePage(p, 3, 0);                 // page 4 to the front
  assert.equal(deleteNumbers(p, parsePageNumbers('3, 9-', 10)), 3);
  assert.equal(deleteNumbers(p, [3]), 0); // already deleted
  const plan = buildPlan(p);
  assert.deepEqual(plan.map((x) => [x.index + 1, x.rotate]), [[4, 0], [1, 0], [2, 90], [5, 0], [6, 0], [7, 270], [8, 0]]);
  assert.deepEqual(sourceIndices(plan), { 0: [0, 1, 3, 4, 5, 6, 7] });
  assert.deepEqual(summarize(p), { total: 10, kept: 7, deleted: 3, rotated: 2, moved: true, changed: true });
  // a rotated page that is then deleted doesn't count as rotated
  deleteNumbers(p, [2]); assert.equal(summarize(p).rotated, 1);
  resetPages(p);
  assert.deepEqual(order(p), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(p.every((x) => x.rotate === 0 && !x.deleted));
  assert.equal(summarize(p).changed, false);
  // four quarter turns = unchanged
  for (let i = 0; i < 4; i++) rotatePage(p[0], 90);
  assert.equal(summarize(p).changed, false);
});

test('organize: plan across two sources keeps display order', () => {
  const p = [...makePages(2, 0), ...makePages(2, 1, 3)];
  movePage(p, 3, 0); // B page 2 first
  const plan = buildPlan(p);
  assert.deepEqual(plan.map((x) => `${x.src}:${x.index}`), ['1:1', '0:0', '0:1', '1:0']);
  assert.deepEqual(sourceIndices(plan), { 0: [0, 1], 1: [0, 1] });
  assert.equal(summarize(makePages(2, 0).concat(makePages(1, 1, 3))).changed, true); // appending is a change
});

async function pdfWith(labels, rotations = []) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  labels.forEach((t, i) => {
    const page = doc.addPage([300, 400]);
    page.drawText(t, { x: 20, y: 350, size: 18, font });
    if (rotations[i]) page.setRotation(degrees(rotations[i]));
  });
  return PDFDocument.load(await doc.save());
}

test('organize: assemble copies pages in order, adds to existing /Rotate, drops deleted', async () => {
  const a = await pdfWith(['A1', 'A2', 'A3', 'A4'], [0, 90, 0, 270]);
  const b = await pdfWith(['B1']);
  const pages = [...makePages(4, 0), ...makePages(1, 1, 5)];
  rotatePage(pages[1], 90);   // A2: 90 + 90 = 180
  rotatePage(pages[3], 90);   // A4: 270 + 90 = 0
  deleteNumbers(pages, [3]);
  movePage(pages, 4, 0);      // B1 first
  const out = await assemble([a, b], buildPlan(pages));
  const saved = await PDFDocument.load(await out.save());
  assert.equal(saved.getPageCount(), 4);
  assert.deepEqual(saved.getPages().map((pg) => pg.getRotation().angle), [0, 0, 180, 0]);
  assert.deepEqual(saved.getPages().map((pg) => [pg.getWidth(), pg.getHeight()]), [[300, 400], [300, 400], [300, 400], [300, 400]]);
  // Content streams are copied byte for byte, not re-drawn.
  const raw = (doc, pg) => {
    const c = pg.node.Contents();
    const list = c.asArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c];
    return Buffer.concat(list.map((x) => Buffer.from(x.getContents()))).toString('hex');
  };
  const want = [[b, 0], [a, 0], [a, 1], [a, 3]].map(([d, i]) => raw(d, d.getPage(i)));
  assert.deepEqual(saved.getPages().map((pg) => raw(saved, pg)), want);
});

test('organize: assemble honours an inherited /Rotate on the page tree', async () => {
  const doc = await pdfWith(['X1', 'X2']);
  // Move /Rotate 90 onto the parent Pages node (allowed by the spec; leaves inherit it).
  const pagesNode = doc.catalog.Pages();
  pagesNode.set(PDFName.of('Rotate'), doc.context.obj(90));
  const reloaded = await PDFDocument.load(await doc.save());
  assert.deepEqual(reloaded.getPages().map((p) => p.getRotation().angle), [90, 90]);
  const pages = makePages(2); rotatePage(pages[0], 90);
  const out = await assemble([reloaded], buildPlan(pages));
  assert.deepEqual(out.getPages().map((p) => p.getRotation().angle), [180, 90]);
});
