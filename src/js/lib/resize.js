// Output dimensions for the image tools. Pure, unit-tested.
//
// fit: 'contain' (default) keeps the aspect ratio and fits inside maxWidth x maxHeight.
//      'exact' uses the given width/height as-is (a missing side keeps the original).
// allowUpscale: false (default) never enlarges; the compressor uses this. The resize tool allows it.
/** Largest side we will produce (keeps a typo like 80000 from exhausting memory). */
export const MAX_SIDE = 16384;

export function outputSize(srcW, srcH, { maxWidth = 0, maxHeight = 0, fit = 'contain', allowUpscale = false } = {}) {
  if (!(srcW > 0 && srcH > 0)) throw new Error('bad source size');
  const mw = maxWidth > 0 ? maxWidth : 0, mh = maxHeight > 0 ? maxHeight : 0;
  let w, h;
  if (fit === 'exact') {
    w = mw || srcW; h = mh || srcH;
    if (!allowUpscale) { w = Math.min(w, srcW); h = Math.min(h, srcH); }
  } else {
    let scale = Math.min(mw ? mw / srcW : Infinity, mh ? mh / srcH : Infinity);
    if (!Number.isFinite(scale)) scale = 1;
    if (!allowUpscale) scale = Math.min(1, scale);
    w = srcW * scale; h = srcH * scale;
  }
  const over = Math.max(w, h) / MAX_SIDE;
  if (over > 1) { w /= over; h /= over; }
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  return { width: w, height: h, changed: w !== srcW || h !== srcH };
}
