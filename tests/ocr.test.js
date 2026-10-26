import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemsToText, needsOcr, cleanText, joinPages, pageHeader, ocrScale, progressLabel, meaningfulChars } from '../src/js/lib/ocr-text.js';

// Minimal pdf.js-like text item: 12 pt text at (x, y); width ≈ 0.5 em per char.
const it = (str, x, y, size = 12, width = str.length * size * 0.5) => ({ str, transform: [size, 0, 0, size, x, y], width, height: size, hasEOL: false });

test('itemsToText: orders lines top-to-bottom and runs left-to-right', () => {
  const items = [it('world', 120, 700), it('Second line', 72, 686), it('Hello', 72, 700)];
  assert.equal(itemsToText(items), 'Hello world\nSecond line');
});

test('itemsToText: joins split runs without a gap, inserts space across a gap', () => {
  // "Inv" + "oice" touching; then "total" after a visible gap.
  const items = [it('Inv', 72, 700, 12, 18), it('oice', 90, 700, 12, 24), it('total', 130, 700)];
  assert.equal(itemsToText(items), 'Invoice total');
});

test('itemsToText: explicit space items and small baseline jitter stay on one line', () => {
  const items = [it('A', 72, 700), { str: ' ', transform: [12, 0, 0, 12, 78, 700], width: 3, height: 12 }, it('B', 81, 700.8), { str: '', transform: [12, 0, 0, 12, 87, 700], width: 0, height: 0, hasEOL: true }];
  assert.equal(itemsToText(items), 'A B');
});

test('itemsToText: bigger vertical gap starts a new paragraph', () => {
  const items = [it('Para one line one', 72, 700), it('Para one line two', 72, 686), it('Para one line three', 72, 672), it('Para two', 72, 630)];
  assert.equal(itemsToText(items), 'Para one line one\nPara one line two\nPara one line three\n\nPara two');
});

test('itemsToText: two-column-ish table row keeps a single space; empty input gives empty string', () => {
  assert.equal(itemsToText([it('Qty', 72, 500), it('12', 300, 500)]), 'Qty 12');
  assert.equal(itemsToText([]), '');
  assert.equal(itemsToText(undefined), '');
  assert.equal(itemsToText([{ str: '  ', transform: [12, 0, 0, 12, 0, 0], width: 6, height: 12 }]), '');
});

test('needsOcr: empty, page-number-only and junk text layers need OCR; real text does not', () => {
  assert.equal(needsOcr(''), true);
  assert.equal(needsOcr('  \n 3 \n'), true);
  assert.equal(needsOcr('Page 12 of 40'), true); // 11 letters/digits
  assert.equal(needsOcr('�'.repeat(200) + 'abc def ghi jkl mno pqr stu'), true);
  assert.equal(needsOcr('The quick brown fox jumps over the lazy dog.'), false);
  assert.equal(needsOcr('Größe: 12 Stück', { minChars: 5 }), false);
  assert.equal(meaningfulChars('a1 é-ß!'), 4);
});

test('cleanText: ligatures, soft hyphens, nbsp, trailing spaces, blank-line runs', () => {
  assert.equal(cleanText('ﬁnal oﬃce\r\nco­operate now   \n\n\n\nend  '), 'final office\ncooperate now\n\nend');
  assert.equal(cleanText(null), '');
});

test('joinPages / pageHeader label OCR pages and empty pages', () => {
  assert.equal(pageHeader(2, true), '--- Page 2 (OCR) ---');
  assert.equal(joinPages([{ n: 1, text: 'Hi' }, { n: 2, text: '', ocr: true }]),
    '--- Page 1 ---\n\nHi\n\n--- Page 2 (OCR) ---\n\n(no text found on this page)\n');
});

test('ocrScale: upscales small images (max 2x), downscales huge ones, keeps normal ones', () => {
  assert.equal(ocrScale(400, 300), 2);
  assert.equal(ocrScale(1000, 500), 1.6);
  assert.equal(ocrScale(2480, 3508), 1);
  assert.equal(ocrScale(10000, 5000), 0.5);
  assert.equal(ocrScale(0, 0), 1);
});

test('progressLabel maps tesseract.js statuses', () => {
  assert.equal(progressLabel('loading tesseract core'), 'Loading OCR engine');
  assert.equal(progressLabel('loading language traineddata'), 'Loading English data');
  assert.equal(progressLabel('recognizing text'), 'Reading text');
  assert.equal(progressLabel(''), 'Working');
});
