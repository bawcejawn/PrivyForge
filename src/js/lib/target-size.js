// Target-size compression search ("make this photo smaller than 100 KB").
// Pure logic: the actual encoder is injected, so this runs (and is unit-tested) without a browser.
//
// encode(quality, scale) -> Promise<{ size: number, ... }>
//   quality: integer qMin..qMax, scale: 0 < scale <= 1 (fraction of the starting dimensions).
//   Whatever else the encoder returns (bytes, width, height) is passed through untouched.
//
// Strategy, per scale:
//   1. Try qMax. If it fits, that is the best possible result at this size: done.
//   2. Try qMin. If even that is too big, shrink the image and start again.
//   3. Otherwise binary-search qMin..qMax for the highest quality that still fits.
// Shrinking uses 0.85x steps, or a bigger step (never below 0.5x) when the size at qMin shows
// the image is far over target: file size grows roughly with pixel count, so the side length
// needs about sqrt(target / size). That keeps 40-megapixel phone photos from taking 15 rounds.

export const DEFAULTS = { qMin: 30, qMax: 95, iterations: 8, scaleStep: 0.85, minScaleStep: 0.5, minSide: 16, maxRounds: 40 };

/**
 * @returns {Promise<{ ok: boolean, result: object, quality: number, scale: number, attempts: number }>}
 *   ok=true: result.size <= target, at the highest quality found for the largest scale tried.
 *   ok=false: the target is impossible (even a tiny, low-quality image is too big); result is the
 *   smallest file produced so the caller can show how close it got.
 */
export async function searchTargetSize({ target, encode, width, height, ...options }) {
  const o = { ...DEFAULTS, ...options };
  if (!(target > 0)) throw new Error('target must be a positive number of bytes');
  if (typeof encode !== 'function') throw new Error('encode must be a function');
  if (!(width > 0 && height > 0)) throw new Error('width and height must be positive');
  if (!(o.qMin >= 1 && o.qMax <= 100 && o.qMin <= o.qMax)) throw new Error('bad quality range');

  let attempts = 0;
  let smallest = null; // fallback for impossible targets
  const tryEncode = async (q, scale) => {
    attempts++;
    const r = await encode(q, scale);
    if (!r || !Number.isFinite(r.size)) throw new Error('encode must resolve to { size }');
    const rec = { result: r, quality: q, scale };
    if (!smallest || r.size < smallest.result.size) smallest = rec;
    return rec;
  };
  const fits = (rec) => rec.result.size <= target;

  let scale = 1;
  for (let round = 0; round < o.maxRounds; round++) {
    const top = await tryEncode(o.qMax, scale);
    if (fits(top)) return { ok: true, ...top, attempts };

    const bottom = o.qMin === o.qMax ? top : await tryEncode(o.qMin, scale);
    if (fits(bottom)) {
      // Invariant: best fits; everything above hi is known (or assumed) not to fit.
      let best = bottom, lo = o.qMin + 1, hi = o.qMax - 1;
      for (let i = 0; i < o.iterations && lo <= hi; i++) {
        const mid = Math.round((lo + hi) / 2);
        const rec = await tryEncode(mid, scale);
        if (fits(rec)) { if (rec.quality > best.quality) best = rec; lo = mid + 1; } else hi = mid - 1;
      }
      return { ok: true, ...best, attempts };
    }

    // Too big even at the lowest quality: shrink.
    const estimate = Math.sqrt(target / bottom.result.size) * 1.05;
    const step = Math.min(o.scaleStep, Math.max(o.minScaleStep, estimate));
    const next = scale * step;
    if (Math.min(width, height) * next < o.minSide) break;
    scale = next;
  }
  return { ok: false, ...smallest, attempts };
}

/** Bytes for a "KB" target. We use 1 KB = 1,000 bytes, which also satisfies sites that mean 1,024. */
export const kbToBytes = (kb) => Math.floor(kb * 1000);
