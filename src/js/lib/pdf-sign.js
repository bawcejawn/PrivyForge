// Pure helpers for Sign PDF: page geometry (screen <-> PDF points, incl. /Rotate),
// date formatting, and signature-image clean-up. No DOM, no pdf-lib: unit-tested in node.
//
// Coordinate systems
// ------------------
// "Display" space is the page as the reader sees it: origin top-left, x right, y down,
// measured in PDF points, already rotated by the page's /Rotate. Width/height swap for
// 90/270. All placed items are stored in display space, so they don't depend on zoom.
//
// "User" space is PDF space: origin at the box's lower-left (box may not start at 0,0),
// x right, y up, *before* /Rotate is applied by the viewer.

/** Normalize any /Rotate value (may be negative or > 360) to 0, 90, 180 or 270. */
export function normRotation(r) {
  const n = Math.round((Number(r) || 0) / 90) * 90;
  return ((n % 360) + 360) % 360;
}

/**
 * Describe a page for mapping. `box` is the visible box [x0, y0, x1, y1] (CropBox, falling
 * back to MediaBox) in user space; `rotate` is /Rotate in degrees (clockwise).
 */
export function pageFrame(box, rotate = 0) {
  let [x0, y0, x1, y1] = box.map(Number);
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  const r = normRotation(rotate);
  const w = x1 - x0, h = y1 - y0;
  const sideways = r === 90 || r === 270;
  return { x0, y0, x1, y1, rotate: r, width: sideways ? h : w, height: sideways ? w : h };
}

// display (dx, dy) -> user (x, y) is affine: x = a*dx + b*dy + tx, y = c*dx + d*dy + ty
function affine(f) {
  switch (f.rotate) {
    case 0: return { a: 1, b: 0, c: 0, d: -1, tx: f.x0, ty: f.y1 };
    case 90: return { a: 0, b: 1, c: 1, d: 0, tx: f.x0, ty: f.y0 };
    case 180: return { a: -1, b: 0, c: 0, d: 1, tx: f.x1, ty: f.y0 };
    default: return { a: 0, b: -1, c: -1, d: 0, tx: f.x1, ty: f.y1 }; // 270
  }
}

/** Display point (points, y down, rotated as seen) -> PDF user-space point. */
export function displayToPdf(frame, dx, dy) {
  const m = affine(frame);
  return [m.a * dx + m.b * dy + m.tx, m.c * dx + m.d * dy + m.ty];
}

/** PDF user-space point -> display point. Inverse of displayToPdf. */
export function pdfToDisplay(frame, x, y) {
  const m = affine(frame);
  // The 2x2 part is its own inverse up to transpose (it's a signed permutation matrix).
  const ux = x - m.tx, uy = y - m.ty;
  return [m.a * ux + m.c * uy, m.b * ux + m.d * uy];
}

/**
 * PDF `cm` matrix [a b c d e f] that maps an item's local space -> user space.
 * Local space: origin at the item's bottom-left *as displayed*, u to the right and v up
 * (as displayed), in points. Drawing an image at (0,0,w,h) or text at (0, baseline) inside
 * this matrix makes it appear upright at item = {x, y, w, h} (display space, y down) on any
 * page size, box offset and rotation.
 */
export function itemMatrix(frame, { x, y, h }) {
  const m = affine(frame);
  const by = y + h; // display y of the item's bottom edge
  return [
    m.a, m.c,          // local u axis -> user
    -m.b, -m.d,        // local v axis (up on screen = -dy) -> user
    m.a * x + m.b * by + m.tx,
    m.c * x + m.d * by + m.ty,
  ];
}

/** Apply a PDF matrix to a point (for tests and sanity checks). */
export const applyMatrix = ([a, b, c, d, e, f], u, v) => [a * u + c * v + e, b * u + d * v + f];

/** Pointer position -> display points, given the page element's client rect. Clamped to the page. */
export function clientToDisplay(rect, clientX, clientY, frame) {
  const fx = (clientX - rect.left) / rect.width, fy = (clientY - rect.top) / rect.height;
  return [clamp(fx, 0, 1) * frame.width, clamp(fy, 0, 1) * frame.height];
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Keep a box fully on the page (shrinking it if it's bigger than the page). */
export function clampBox(box, frame) {
  const w = Math.min(box.w, frame.width), h = Math.min(box.h, frame.height);
  return { ...box, w, h, x: clamp(box.x, 0, frame.width - w), y: clamp(box.y, 0, frame.height - h) };
}

/** Box of a given aspect (w/h) and width, centred on a display point, kept on the page. */
export function boxAt(frame, cx, cy, w, aspect) {
  const h = w / aspect;
  return clampBox({ x: cx - w / 2, y: cy - h / 2, w, h }, frame);
}

// ---------------------------------------------------------------- dates

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DATE_FORMATS = {
  'MM/DD/YYYY': '10/26/2026',
  'DD/MM/YYYY': '26/10/2026',
  'YYYY-MM-DD': '2026-10-26',
  'MMMM D, YYYY': 'October 26, 2026',
  'D MMMM YYYY': '26 October 2026',
  'DD.MM.YYYY': '26.10.2026',
};

/** "2026-03-07" -> {y, m, d} or null. Avoids Date parsing (which treats it as UTC). */
export function parseISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

/** Local calendar date as "YYYY-MM-DD" (what <input type=date> uses). */
export function todayISO(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Format an ISO date with one of DATE_FORMATS. Returns '' for invalid dates. */
export function formatDate(iso, fmt = 'MM/DD/YYYY') {
  const v = parseISODate(iso);
  if (!v) return '';
  const p = (n) => String(n).padStart(2, '0');
  switch (fmt) {
    case 'DD/MM/YYYY': return `${p(v.d)}/${p(v.m)}/${v.y}`;
    case 'YYYY-MM-DD': return `${v.y}-${p(v.m)}-${p(v.d)}`;
    case 'MMMM D, YYYY': return `${MONTHS[v.m - 1]} ${v.d}, ${v.y}`;
    case 'D MMMM YYYY': return `${v.d} ${MONTHS[v.m - 1]} ${v.y}`;
    case 'DD.MM.YYYY': return `${p(v.d)}.${p(v.m)}.${v.y}`;
    default: return `${p(v.m)}/${p(v.d)}/${v.y}`;
  }
}

// ---------------------------------------------------------------- signature images

/**
 * Make near-white pixels transparent, in place, on RGBA data. Pixels brighter than
 * `threshold` become fully transparent; a soft ramp of `soft` levels below it keeps
 * anti-aliased edges smooth. Returns the data for chaining.
 */
export function removeWhite(data, threshold = 225, soft = 40) {
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (lum >= threshold) data[i + 3] = 0;
    else if (lum > threshold - soft) data[i + 3] = Math.round(data[i + 3] * (threshold - lum) / soft);
  }
  return data;
}

/**
 * Bounding box of pixels with alpha > `minAlpha`, padded by `pad` and clipped to the image.
 * Returns null if the image is empty.
 */
export function inkBounds(data, width, height, minAlpha = 8, pad = 0) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > minAlpha) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Line widths for a smooth, slightly pressure/speed-sensitive pen stroke. */
export function strokeWidth(base, { pressure = 0.5, speed = 0, pen = false } = {}) {
  const p = pen ? clamp(pressure || 0.5, 0.1, 1) * 1.6 + 0.2 : 1;
  const s = clamp(1.25 - speed * 0.35, 0.55, 1.25); // faster strokes get thinner
  return base * p * s;
}
