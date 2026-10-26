import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { sniffHeic, looksLikeHeic, markPrimaryOnly, HEIC_TO_VERSION } from '../src/js/lib/heic.js';

// Build an ftyp box: size, 'ftyp', major brand, minor version, compatible brands.
function ftyp(major, compat = []) {
  const n = 16 + compat.length * 4;
  const b = new Uint8Array(n + 16);
  new DataView(b.buffer).setUint32(0, n);
  const put = (o, s) => [...s].forEach((c, i) => { b[o + i] = c.charCodeAt(0); });
  put(4, 'ftyp'); put(8, major);
  compat.forEach((c, i) => put(16 + i * 4, c));
  put(n + 4, 'meta'); // the next box, must not be read as a brand
  return b;
}

test('heic sniff: iPhone-style HEIC (heic + mif1)', () => {
  assert.equal(sniffHeic(ftyp('heic', ['mif1', 'heic'])), true);
  assert.equal(sniffHeic(ftyp('heix', ['mif1'])), true);
  assert.equal(sniffHeic(ftyp('hevc', ['msf1'])), true);
});

test('heic sniff: generic HEIF (mif1 major, HEVC brand in compatible list)', () => {
  assert.equal(sniffHeic(ftyp('mif1', ['heic'])), true);
  assert.equal(sniffHeic(ftyp('mif1', ['miaf'])), true); // plain HEIF, no AVIF brand
});

test('heic sniff: AVIF is not HEIC, even with mif1 as major brand', () => {
  assert.equal(sniffHeic(ftyp('avif', ['mif1', 'miaf'])), false);
  assert.equal(sniffHeic(ftyp('mif1', ['avif', 'miaf'])), false);
  assert.equal(sniffHeic(ftyp('avis', ['msf1'])), false);
});

test('heic sniff: other files and short input', () => {
  assert.equal(sniffHeic(ftyp('isom', ['mp41'])), false); // MP4 video
  assert.equal(sniffHeic(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1])), false); // JPEG
  assert.equal(sniffHeic(new Uint8Array(8)), false);
  assert.equal(sniffHeic(undefined), false);
  // brand after the ftyp box ends is ignored ('meta' box above), and a lying box size is clamped
  const b = ftyp('qt  '); assert.equal(sniffHeic(b), false);
});

test('heic sniff: the committed fixtures', () => {
  for (const f of ['photo', 'burst', 'rotated']) {
    const bytes = new Uint8Array(readFileSync(new URL(`./e2e/fx-heic/${f}.heic`, import.meta.url)));
    assert.equal(sniffHeic(bytes.subarray(0, 64)), true, f);
  }
});

test('heic: name / MIME check', () => {
  assert.equal(looksLikeHeic('IMG_0001.HEIC', ''), true);
  assert.equal(looksLikeHeic('x.heif', ''), true);
  assert.equal(looksLikeHeic('x.jpg', 'image/heic'), true);
  assert.equal(looksLikeHeic('x.jpg', 'image/heif-sequence'), true);
  assert.equal(looksLikeHeic('x.jpg', 'image/jpeg'), false);
  assert.equal(looksLikeHeic('heic.png', 'image/png'), false);
});

test('heic-to: shipped unmodified from node_modules at build, with its license (LGPL-3.0)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../node_modules/heic-to/package.json', import.meta.url)));
  assert.equal(pkg.version, HEIC_TO_VERSION, 'npm heic-to was updated: bump HEIC_TO_VERSION in src/js/lib/heic.js');
  assert.equal(pkg.license, 'LGPL-3.0');
  const lic = readFileSync(new URL('../public/vendor/heic-to/LICENSE.txt', import.meta.url), 'utf8');
  assert.match(lic, /GNU Lesser General Public License/);
  assert.ok(readFileSync(new URL('../public/vendor/heic-to/COPYING-GPL-3.txt', import.meta.url), 'utf8').includes('GNU GENERAL PUBLIC LICENSE'));
  assert.match(readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8'), /heic-to[\s\S]*libheif[\s\S]*LGPL-3\.0/);
  // The build copies the file byte-for-byte (vite.config.js vendorAssets); check dist when present.
  const built = new URL(`../dist/vendor/heic-to/heic-to-csp-${HEIC_TO_VERSION}.mjs`, import.meta.url);
  if (existsSync(built)) assert.ok(readFileSync(built).equals(readFileSync(new URL('../node_modules/heic-to/dist/csp/heic-to.js', import.meta.url))), 'built copy was modified');
});

test('heic primary: burst fixture -> the non-primary image (item 1) gets the hidden flag', () => {
  const bytes = new Uint8Array(readFileSync(new URL('./e2e/fx-heic/burst.heic', import.meta.url)));
  const before = Buffer.from(bytes);
  const r = markPrimaryOnly(bytes);
  assert.deepEqual(r, { primary: 2, hidden: [1] });
  const diff = [...bytes].map((b, i) => (b !== before[i] ? i : -1)).filter((i) => i >= 0);
  assert.equal(diff.length, 1, 'exactly one byte (the infe flags) changes');
  assert.equal(bytes[diff[0]] & 1, 1);
  assert.deepEqual(markPrimaryOnly(bytes), { primary: 2, hidden: [] }, 'idempotent');
});

test('heic primary: single-image files are left untouched', () => {
  for (const f of ['photo', 'rotated']) {
    const bytes = new Uint8Array(readFileSync(new URL(`./e2e/fx-heic/${f}.heic`, import.meta.url)));
    const before = Buffer.from(bytes);
    assert.deepEqual(markPrimaryOnly(bytes), { primary: 1, hidden: [] }, f);
    assert.ok(before.equals(bytes), f);
  }
});

test('heic primary: garbage and truncated input never throw', () => {
  assert.equal(markPrimaryOnly(new Uint8Array(0)), null);
  assert.equal(markPrimaryOnly(new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70])), null);
  const bytes = new Uint8Array(readFileSync(new URL('./e2e/fx-heic/burst.heic', import.meta.url)));
  for (const n of [20, 100, 200, 300, 500]) assert.doesNotThrow(() => markPrimaryOnly(bytes.slice(0, n)));
});
