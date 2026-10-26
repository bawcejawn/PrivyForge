// Pure helpers for the PDF tools: page layout for images, render-size caps, image sniffing.
// No DOM — unit-tested in tests/pdf2.test.js.

/** PDF page sizes in points (1 pt = 1/72 inch), portrait. */
export const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

/** Margins in points. */
export const MARGINS = { none: 0, small: 18, medium: 36, large: 72 };

/** Largest page side PDF readers accept (Acrobat's documented limit is 200 inches). */
export const MAX_PAGE_PT = 14400;

/**
 * Where an image goes on its page.
 * - pageSize 'fit': the page is the image's size (1 px = 0.75 pt, i.e. shown at 96 DPI) plus margins.
 * - 'a4' | 'letter': fixed paper; orientation follows the image (landscape image → landscape page);
 *   the image is scaled to fit inside the margins (never cropped, never enlarged past the box), centred.
 * @returns {{ pageW:number, pageH:number, x:number, y:number, w:number, h:number }}  PDF coords (origin bottom-left)
 */
export function layoutImage(imgW, imgH, { pageSize = 'fit', margin = 0 } = {}) {
  if (!(imgW > 0 && imgH > 0)) throw new Error('image has no size');
  const m = Math.max(0, +margin || 0);
  if (pageSize === 'fit') {
    let w = imgW * 0.75, h = imgH * 0.75;
    const k = Math.min(1, (MAX_PAGE_PT - 2 * m) / w, (MAX_PAGE_PT - 2 * m) / h);
    w *= k; h *= k;
    return { pageW: w + 2 * m, pageH: h + 2 * m, x: m, y: m, w, h };
  }
  const size = PAGE_SIZES[pageSize];
  if (!size) throw new Error(`unknown page size: ${pageSize}`);
  const landscape = imgW > imgH;
  const [pageW, pageH] = landscape ? [size[1], size[0]] : size;
  const boxW = pageW - 2 * m, boxH = pageH - 2 * m;
  const k = Math.min(boxW / imgW, boxH / imgH);
  const w = imgW * k, h = imgH * k;
  return { pageW, pageH, x: (pageW - w) / 2, y: (pageH - h) / 2, w, h };
}

/**
 * Pixel size for rendering a page of `wPt` × `hPt` points at `dpi`, capped to `maxPx` total pixels
 * (mobile Safari refuses canvases above ~16.7 MP).
 */
export function renderSize(wPt, hPt, dpi, maxPx = 16e6) {
  let scale = dpi / 72;
  let capped = false;
  if (wPt * hPt * scale * scale > maxPx) { scale = Math.sqrt(maxPx / (wPt * hPt)); capped = true; }
  // Round (not ceil) so 8.5 in × 150 DPI is exactly 1275 px despite floating-point noise.
  const width = Math.max(1, Math.round(wPt * scale)), height = Math.max(1, Math.round(hPt * scale));
  return { scale, width, height, capped };
}

/** 'jpeg' | 'png' | 'webp' | 'gif' | 'bmp' | null from the first bytes. */
export function sniffImage(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  return null;
}

/** EXIF orientation (1–8) of a JPEG, or 1 when absent/unreadable. */
export function jpegOrientation(b) {
  if (sniffImage(b) !== 'jpeg') return 1;
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return 1;
    const marker = b[p + 1];
    if (marker === 0xd9 || marker === 0xda) return 1; // end of image / start of scan: no EXIF
    const len = (b[p + 2] << 8) | b[p + 3];
    if (marker === 0xe1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) {
      const t = p + 10; // TIFF header
      if (t + 8 > b.length) return 1;
      const le = b[t] === 0x49;
      const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 2 ** 24
                             : b[o] * 2 ** 24 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
      const ifd = t + u32(t + 4);
      if (ifd + 2 > b.length) return 1;
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > b.length) return 1;
        if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
      }
      return 1;
    }
    p += 2 + len;
  }
  return 1;
}

/**
 * How to draw a raw (un-rotated) JPEG so it appears upright in box (X, Y, W, H) using pdf-lib's
 * drawImage, which rotates counter-clockwise around (x, y). Handles orientations 1, 3, 6, 8
 * (pure rotations); returns null for mirrored orientations (2, 4, 5, 7), which need a re-encode.
 */
export function orientedDraw(orientation, X, Y, W, H) {
  switch (orientation) {
    case 1: return { x: X, y: Y, width: W, height: H, rotate: 0 };
    case 3: return { x: X + W, y: Y + H, width: W, height: H, rotate: 180 };
    case 6: return { x: X, y: Y + H, width: H, height: W, rotate: -90 };
    case 8: return { x: X + W, y: Y, width: H, height: W, rotate: 90 };
    default: return null;
  }
}
