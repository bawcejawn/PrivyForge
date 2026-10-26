// Pure helpers for spotting HEIC/HEIF photos. No browser APIs, so they're unit-tested in Node.

/** heic-to version shipped as public/vendor/heic-to/heic-to-csp-<version>.mjs (see ../heic.js). */
export const HEIC_TO_VERSION = '1.6.6';

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
const HEIF_GENERIC = new Set(['mif1', 'msf1', 'mif2']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

/** By name or MIME type only (what the file picker tells us). */
export function looksLikeHeic(name = '', type = '') {
  return /\.(heic|heif|hif)$/i.test(name) || /^image\/hei[cf](-sequence)?$/i.test(type);
}

/**
 * By content: reads the ISO-BMFF `ftyp` box at the start of the file.
 * True for HEIC/HEIF (HEVC-coded) images, false for AVIF (same container, AV1 codec) and
 * everything else. Catches HEIC photos with a wrong extension (some apps save them as .jpg).
 * @param {Uint8Array} bytes the first 64+ bytes of the file
 */
export function sniffHeic(bytes) {
  if (!bytes || bytes.length < 16) return false;
  const str = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (str(4) !== 'ftyp') return false;
  const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const end = Math.min(bytes.length, boxSize >= 16 ? boxSize : 16);
  const brands = [str(8)];
  for (let o = 16; o + 4 <= end; o += 4) brands.push(str(o)); // skip minor_version at 12
  if (brands.some((b) => HEIC_BRANDS.has(b))) return true;
  if (brands.some((b) => AVIF_BRANDS.has(b))) return false;
  return HEIF_GENERIC.has(brands[0]);
}

// ---------- Primary image first
// heic-to decodes the first "top-level" image libheif lists, which is ordered by item ID, not
// the file's primary image ('pitm'). For files with several independent images (bursts, some
// edited or multi-frame HEIFs) that can be the wrong one. markPrimaryOnly() flags every other
// stand-alone image item as "hidden" (ISO/IEC 23008-12: hidden items are not meant to be shown),
// which removes it from libheif's top-level list, so the primary is decoded. Items referenced by
// anything (grid tiles, thumbnails, alpha/depth maps, Exif) are left alone.

const IMAGE_TYPES = new Set(['hvc1', 'grid', 'iden', 'iovl', 'av01', 'jpeg', 'j2k1', 'unci', 'avc1', 'vvc1', 'tmap']);

function* boxes(d, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = d.getUint32(o), head = 8;
    const type = String.fromCharCode(d.getUint8(o + 4), d.getUint8(o + 5), d.getUint8(o + 6), d.getUint8(o + 7));
    if (size === 1) { size = Number(d.getBigUint64(o + 8)); head = 16; } else if (size === 0) size = end - o;
    if (size < head || o + size > end) return;
    yield { type, start: o, body: o + head, end: o + size };
    o += size;
  }
}

/**
 * @param {Uint8Array} bytes the whole HEIC file (modified in place)
 * @returns {{ primary: number, hidden: number[] } | null} what was changed, or null if not a
 *   parseable HEIF with a primary item. `hidden` is empty when nothing needed changing.
 */
export function markPrimaryOnly(bytes) {
  try {
    const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const meta = [...boxes(d, 0, d.byteLength)].find((b) => b.type === 'meta');
    if (!meta) return null;
    let primary = null;
    const infes = [];
    const referenced = new Set();
    for (const b of boxes(d, meta.body + 4, meta.end)) {
      const version = d.getUint8(b.body);
      if (b.type === 'pitm') primary = version === 0 ? d.getUint16(b.body + 4) : d.getUint32(b.body + 4);
      if (b.type === 'iinf') {
        const first = b.body + 4 + (version === 0 ? 2 : 4);
        for (const e of boxes(d, first, b.end)) {
          if (e.type !== 'infe') continue;
          const v = d.getUint8(e.body);
          if (v < 2) continue; // v0/v1 entries don't describe image items
          const id = v === 2 ? d.getUint16(e.body + 4) : d.getUint32(e.body + 4);
          const t = e.body + 4 + (v === 2 ? 2 : 4) + 2;
          const type = String.fromCharCode(d.getUint8(t), d.getUint8(t + 1), d.getUint8(t + 2), d.getUint8(t + 3));
          infes.push({ id, type, flagsAt: e.body + 3, hidden: (d.getUint8(e.body + 3) & 1) === 1 });
        }
      }
      if (b.type === 'iref') {
        const wide = version !== 0;
        for (const r of boxes(d, b.body + 4, b.end)) {
          let o = r.body;
          const read = () => { const v = wide ? d.getUint32(o) : d.getUint16(o); o += wide ? 4 : 2; return v; };
          referenced.add(read());
          const n = d.getUint16(o); o += 2;
          for (let i = 0; i < n && o <= r.end - (wide ? 4 : 2); i++) referenced.add(read());
        }
      }
    }
    if (primary == null || !infes.some((e) => e.id === primary)) return null;
    const hidden = [];
    for (const e of infes) {
      if (e.id === primary || e.hidden || !IMAGE_TYPES.has(e.type) || referenced.has(e.id)) continue;
      bytes[e.flagsAt] |= 1;
      hidden.push(e.id);
    }
    return { primary, hidden };
  } catch { return null; }
}
