// Target-size search for "compress to N MB". Pure: the caller injects `trySettings`, which
// produces an output for one setting and returns it (bytes) or just its size (number).
// Used by /compress-pdf-to-1mb/ and unit-tested in tests/pdf2.test.js.

/** 1 MB as most upload limits mean it (1024 × 1024 bytes). */
export const MB = 1024 * 1024;

/**
 * Settings tried in order, best quality first. `lossless` keeps the PDF as-is (text stays
 * selectable); every other step re-renders pages as JPEG images at that DPI and quality.
 */
export const PDF_LADDER = [
  { lossless: true, label: 'Lossless re-save (text stays selectable)' },
  { dpi: 150, quality: 0.72 },
  { dpi: 120, quality: 0.65 },
  { dpi: 100, quality: 0.55 },
  { dpi: 85, quality: 0.5 },
  { dpi: 72, quality: 0.45 },
];

export const settingLabel = (s) => s.label || `${s.dpi} DPI, JPEG quality ${Math.round(s.quality * 100)}`;

const sizeOf = (r) => (typeof r === 'number' ? r : r?.byteLength ?? r?.length ?? Infinity);

/**
 * Walk `ladder` until an output is ≤ `target` bytes.
 * When a lossy step fits right after a lossy step that did not, `refine` extra tries
 * binary-search the JPEG quality between the two (at the fitting step's DPI), so the result
 * lands as close under the target as possible instead of overshooting into blur.
 *
 * @param {{ target:number, ladder?:object[], trySettings:(s:object)=>Promise<number|Uint8Array>|number|Uint8Array,
 *           refine?:number, onAttempt?:(a:{settings:object,size:number,fits:boolean})=>void }} opts
 * @returns {Promise<{ ok:boolean, settings:object, size:number, result:any, attempts:{settings:object,size:number,fits:boolean}[] }>}
 *   ok=false means nothing fit; then `result` is the smallest output produced.
 */
export async function findTargetSize({ target, ladder = PDF_LADDER, trySettings, refine = 2, onAttempt }) {
  if (!(target > 0)) throw new Error('target must be a positive number of bytes');
  if (!ladder.length) throw new Error('ladder is empty');
  const attempts = [];
  let best = null; // best fitting (largest quality ⇒ first found, then refined upward)
  let smallest = null;

  const attempt = async (settings) => {
    const result = await trySettings(settings);
    const size = sizeOf(result);
    const a = { settings, size, fits: size <= target };
    attempts.push(a);
    onAttempt?.(a);
    if (!smallest || size < smallest.size) smallest = { settings, size, result };
    return { ...a, result };
  };

  for (let i = 0; i < ladder.length; i++) {
    const step = ladder[i];
    const r = await attempt(step);
    if (!r.fits) continue;
    best = r;
    const prev = ladder[i - 1];
    if (refine > 0 && !step.lossless && prev && !prev.lossless && prev.quality > step.quality) {
      // Quality in (step.quality, prev.quality] at this DPI may still fit: search it.
      let lo = step.quality, hi = prev.quality;
      for (let k = 0; k < refine; k++) {
        const q = Math.round(((lo + hi) / 2) * 100) / 100;
        if (q <= lo || q >= hi) break;
        const t = await attempt({ ...step, quality: q });
        if (t.fits) { best = t; lo = q; } else hi = q;
      }
    }
    break;
  }

  if (best) return { ok: true, settings: best.settings, size: best.size, result: best.result, attempts };
  return { ok: false, settings: smallest.settings, size: smallest.size, result: smallest.result, attempts };
}
