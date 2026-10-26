import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTargetSize, PDF_LADDER, MB, settingLabel } from '../src/js/lib/size-search.js';
import { layoutImage, renderSize, sniffImage, jpegOrientation, stripOrientation, orientedDraw, PAGE_SIZES } from '../src/js/lib/pdf-layout.js';

// Fake encoder: size grows with pixels (dpi²) and quality, like JPEG roughly does.
const model = (k) => (s) => (s.lossless ? k.lossless : Math.round(k.perPixel * s.dpi * s.dpi * (0.2 + s.quality)));

test('size search: lossless re-save wins when it already fits (no rasterizing)', async () => {
  const tried = [];
  const r = await findTargetSize({ target: MB, trySettings: (s) => { tried.push(s); return 900_000; } });
  assert.equal(r.ok, true);
  assert.equal(r.settings.lossless, true);
  assert.equal(tried.length, 1);
});

test('size search: walks the ladder and stops at the first fit, then refines quality upward', async () => {
  const f = model({ lossless: 5e6, perPixel: 60 }); // 150/.72 ≈ 1.24 MB, 120/.65 ≈ 734 KB
  const r = await findTargetSize({ target: MB, trySettings: f });
  assert.equal(r.ok, true);
  assert.ok(r.size <= MB, String(r.size));
  assert.equal(r.settings.dpi, 120);
  // refined quality is between the fitting step (0.65) and the failed one (0.72)
  assert.ok(r.settings.quality > 0.65 && r.settings.quality <= 0.72, String(r.settings.quality));
  assert.equal(r.attempts[0].settings.lossless, true);
  assert.deepEqual(r.attempts.slice(0, 3).map((a) => a.fits), [false, false, true]);
  // every attempt is recorded with its size, and the chosen one is the largest that fits at that DPI
  const fitting120 = r.attempts.filter((a) => a.fits && a.settings.dpi === 120).map((a) => a.size);
  assert.equal(r.size, Math.max(...fitting120));
});

test('size search: refine=0 returns the plain ladder step', async () => {
  const r = await findTargetSize({ target: MB, trySettings: model({ lossless: 5e6, perPixel: 60 }), refine: 0 });
  assert.deepEqual(r.settings, PDF_LADDER[2]);
  assert.equal(r.attempts.length, 3);
});

test('size search: unreachable target returns the smallest output and ok=false', async () => {
  const r = await findTargetSize({ target: 10_000, trySettings: model({ lossless: 5e6, perPixel: 60 }) });
  assert.equal(r.ok, false);
  assert.equal(r.settings.dpi, 72);
  assert.equal(r.size, Math.min(...r.attempts.map((a) => a.size)));
  assert.equal(r.attempts.length, PDF_LADDER.length);
});

test('size search: accepts byte arrays, async callbacks and reports attempts', async () => {
  const seen = [];
  const r = await findTargetSize({
    target: 100,
    ladder: [{ dpi: 100, quality: 0.9 }, { dpi: 50, quality: 0.5 }],
    trySettings: async (s) => new Uint8Array(s.dpi === 100 ? 150 : 80),
    onAttempt: (a) => seen.push(a.size),
  });
  assert.equal(r.ok, true);
  assert.ok(r.result instanceof Uint8Array);
  assert.equal(r.size, 80);
  assert.equal(seen[0], 150);
  assert.equal(r.settings.dpi, 50);
});

test('size search: lossless step that is smaller than a later fit is never refined against', async () => {
  const r = await findTargetSize({ target: 500, ladder: [{ lossless: true }, { dpi: 72, quality: 0.4 }], trySettings: (s) => (s.lossless ? 900 : 300) });
  assert.equal(r.ok, true); assert.equal(r.attempts.length, 2);
  await assert.rejects(findTargetSize({ target: 0, trySettings: () => 1 }));
  assert.match(settingLabel({ dpi: 120, quality: 0.65 }), /120 DPI, JPEG quality 65/);
});

test('layout: fit-to-image page is the image at 96 DPI plus margins', () => {
  const l = layoutImage(800, 600, { pageSize: 'fit', margin: 36 });
  assert.deepEqual(l, { pageW: 672, pageH: 522, x: 36, y: 36, w: 600, h: 450 });
  const huge = layoutImage(40000, 1000, { pageSize: 'fit' }); // capped at 14400 pt
  assert.ok(Math.abs(huge.pageW - 14400) < 1e-6 && Math.abs(huge.h - 360) < 1e-6);
});

test('layout: A4 / Letter pick orientation from the image and centre it', () => {
  const p = layoutImage(1000, 2000, { pageSize: 'a4', margin: 0 });
  assert.deepEqual([p.pageW, p.pageH], PAGE_SIZES.a4);
  assert.ok(Math.abs(p.h - 841.89) < 1e-6 && Math.abs(p.x - (595.28 - p.w) / 2) < 1e-6);
  const l = layoutImage(2400, 1600, { pageSize: 'letter', margin: 36 });
  assert.deepEqual([l.pageW, l.pageH], [792, 612]);
  assert.equal(l.w, 720); assert.equal(l.h, 480); assert.equal(l.x, 36); assert.equal(l.y, 66);
  assert.throws(() => layoutImage(0, 10));
});

test('renderSize: DPI scaling and the 16 MP cap', () => {
  assert.deepEqual(renderSize(612, 792, 150), { scale: 150 / 72, width: 1275, height: 1650, capped: false });
  assert.equal(renderSize(612, 792, 72).width, 612);
  const big = renderSize(612, 792, 600); // 5100×6600 = 33.7 MP → capped
  assert.equal(big.capped, true);
  assert.ok(big.width * big.height <= 16e6 + 2 * (big.width + big.height));
  assert.ok(Math.abs(big.width / big.height - 612 / 792) < 0.001);
});

// Minimal JPEG with an EXIF APP1 orientation tag.
function jpegWithOrientation(o, le = true) {
  const u16 = (v) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v) => (le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
  const tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(o), 0, 0, ...u32(0)];
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = app1.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xe1, len >> 8, len & 255, ...app1, 0xff, 0xd9]);
}

test('image sniffing and EXIF orientation', () => {
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])), 'png');
  assert.equal(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(sniffImage(new Uint8Array([1, 2, 3])), null);
  for (const o of [1, 3, 6, 8, 2]) {
    assert.equal(jpegOrientation(jpegWithOrientation(o, true)), o);
    assert.equal(jpegOrientation(jpegWithOrientation(o, false)), o);
  }
  assert.equal(jpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), 1);
  for (const le of [true, false]) {
    const src = jpegWithOrientation(6, le), out = stripOrientation(src);
    assert.equal(jpegOrientation(out), 1);
    assert.equal(jpegOrientation(src), 6, 'input untouched');
    assert.equal(out.reduce((n, v, i) => n + (v !== src[i]), 0), 1); // only the tag value changes
  }
  assert.equal(jpegOrientation(jpegWithOrientation(6).slice(0, 20)), 1); // truncated → safe default
});

test('orientedDraw: rotated image covers exactly the target box', () => {
  // pdf-lib rotates CCW around (x, y). Check the four corners of the drawn rect land on the box.
  const corners = ({ x, y, width, height, rotate }) => {
    const r = (rotate * Math.PI) / 180, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
    return [[0, 0], [width, 0], [0, height], [width, height]].map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]);
  };
  const box = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  // Where the raw image's top-left pixel (local (0, height)) must end up for an upright result.
  const rawTopLeft = { 1: [10, 420], 3: [310, 20], 6: [310, 420], 8: [10, 20] };
  for (const o of [1, 3, 6, 8]) {
    const d = orientedDraw(o, 10, 20, 300, 400), c = corners(d);
    assert.deepEqual(box(c), [10, 20, 310, 420], `orientation ${o}`);
    assert.deepEqual(c[2], rawTopLeft[o], `orientation ${o} top-left`);
  }
  assert.equal(orientedDraw(2, 0, 0, 1, 1), null);
});
