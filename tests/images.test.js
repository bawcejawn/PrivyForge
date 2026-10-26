import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchTargetSize, kbToBytes, DEFAULTS } from '../src/js/lib/target-size.js';
import { outputSize, MAX_SIDE } from '../src/js/lib/resize.js';

// A fake encoder that behaves like JPEG: size grows with pixel count and with quality.
function model(width, height, { header = 600, bpp = (q) => 0.02 + (q / 100) ** 3 * 1.2 } = {}) {
  const calls = [];
  const encode = async (q, scale) => {
    calls.push([q, scale]);
    const w = Math.round(width * scale), h = Math.round(height * scale);
    return { size: Math.round(header + w * h * bpp(q)), width: w, height: h };
  };
  return { encode, calls };
}

test('target-size: already small enough -> top quality, full size, one encode', async () => {
  const m = model(200, 100);
  const r = await searchTargetSize({ target: 1e6, encode: m.encode, width: 200, height: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.quality, 95);
  assert.equal(r.scale, 1);
  assert.equal(r.attempts, 1);
});

test('target-size: finds the highest quality that fits at full size', async () => {
  const m = model(2400, 1600);
  const target = kbToBytes(1000);
  const r = await searchTargetSize({ target, encode: m.encode, width: 2400, height: 1600 });
  assert.equal(r.ok, true);
  assert.equal(r.scale, 1);
  assert.ok(r.result.size <= target, `${r.result.size} > ${target}`);
  assert.ok(r.quality > 30 && r.quality < 95, String(r.quality));
  // Next quality up must not fit (the model is monotonic, so this proves "largest quality").
  const up = await m.encode(r.quality + 1, 1);
  assert.ok(up.size > target, `q${r.quality + 1} also fits (${up.size})`);
  assert.ok(r.attempts <= 2 + 8, String(r.attempts));
});

test('target-size: downscales when even q30 is too big, and never exceeds the target', async () => {
  for (const kb of [100, 50, 20]) {
    const m = model(2400, 1600);
    const target = kbToBytes(kb);
    const r = await searchTargetSize({ target, encode: m.encode, width: 2400, height: 1600 });
    assert.equal(r.ok, true, `${kb} KB`);
    assert.ok(r.scale < 1, `${kb} KB: scale ${r.scale}`);
    assert.ok(r.result.size <= target, `${kb} KB: ${r.result.size}`);
    assert.ok(r.result.width < 2400 && r.result.width / r.result.height > 1.49 && r.result.width / r.result.height < 1.51, 'aspect kept');
    // Every downscale step is between 0.5x and 0.85x.
    const scales = [...new Set(m.calls.map((c) => c[1]))];
    for (let i = 1; i < scales.length; i++) {
      const f = scales[i] / scales[i - 1];
      assert.ok(f >= 0.5 - 1e-9 && f <= 0.85 + 1e-9, `step ${f}`);
    }
  }
});

test('target-size: impossible target is reported, with the smallest attempt', async () => {
  const m = model(400, 300, { header: 5000 }); // a fixed 5 KB of overhead can never get under 1 KB
  const r = await searchTargetSize({ target: 1000, encode: m.encode, width: 400, height: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.quality, DEFAULTS.qMin);
  assert.ok(r.result.size > 1000);
  const min = Math.min(...(await Promise.all(m.calls.map(([q, s]) => m.encode(q, s)))).map((x) => x.size));
  assert.equal(r.result.size, min);
  assert.ok(Math.min(r.result.width, r.result.height) >= 8, 'stops shrinking near the minimum side'); // minSide 16 x one 0.5 step
});

test('target-size: a non-monotonic encoder still never returns an oversize "ok" result', async () => {
  // Size wobbles with quality, as real encoders sometimes do.
  const encode = async (q, s) => ({ size: Math.round(s * s * (40000 + q * 900 + ((q * 7919) % 13) * 4000)) });
  for (const target of [60000, 80000, 100000, 120000]) {
    const r = await searchTargetSize({ target, encode, width: 1000, height: 1000 });
    assert.equal(r.ok, true);
    assert.ok(r.result.size <= target, `${target}: ${r.result.size}`);
  }
});

test('target-size: input validation and options', async () => {
  const { encode } = model(10, 10);
  await assert.rejects(searchTargetSize({ target: 0, encode, width: 10, height: 10 }));
  await assert.rejects(searchTargetSize({ target: 10, encode: null, width: 10, height: 10 }));
  await assert.rejects(searchTargetSize({ target: 10, encode, width: 0, height: 10 }));
  await assert.rejects(searchTargetSize({ target: 10, encode: async () => ({}), width: 10, height: 10 }));
  const m = model(2400, 1600);
  const r = await searchTargetSize({ target: 400000, encode: m.encode, width: 2400, height: 1600, qMin: 50, qMax: 80 });
  assert.ok(r.quality >= 50 && r.quality <= 80);
  assert.equal(kbToBytes(100), 100000);
});

test('resize: contain keeps aspect, never upscales unless allowed', () => {
  assert.deepEqual(outputSize(2400, 1600, { maxWidth: 800 }), { width: 800, height: 533, changed: true });
  assert.deepEqual(outputSize(2400, 1600, { maxHeight: 400 }), { width: 600, height: 400, changed: true });
  assert.deepEqual(outputSize(2400, 1600, { maxWidth: 800, maxHeight: 200 }), { width: 300, height: 200, changed: true });
  assert.deepEqual(outputSize(800, 600, { maxWidth: 1600 }), { width: 800, height: 600, changed: false });
  assert.deepEqual(outputSize(800, 600, { maxWidth: 1600, allowUpscale: true }), { width: 1600, height: 1200, changed: true });
  assert.deepEqual(outputSize(800, 600), { width: 800, height: 600, changed: false });
});

test('resize: exact stretches to the given box; huge sizes are capped', () => {
  assert.deepEqual(outputSize(2400, 1600, { maxWidth: 1000, maxHeight: 1000, fit: 'exact' }), { width: 1000, height: 1000, changed: true });
  assert.deepEqual(outputSize(2400, 1600, { maxWidth: 1000, fit: 'exact' }), { width: 1000, height: 1600, changed: true });
  assert.deepEqual(outputSize(100, 100, { maxWidth: 300, maxHeight: 50, fit: 'exact' }), { width: 100, height: 50, changed: true });
  const big = outputSize(1000, 500, { maxWidth: 100000, allowUpscale: true });
  assert.equal(big.width, MAX_SIDE); assert.equal(big.height, MAX_SIDE / 2);
  assert.throws(() => outputSize(0, 10));
});
