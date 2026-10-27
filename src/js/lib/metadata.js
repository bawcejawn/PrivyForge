// Photo metadata: find it (GPS, dates, camera, serial numbers…) and strip it losslessly.
// Pure byte-level code, no browser APIs, so it is unit-tested in Node (tests/metadata.test.js).
//
// What "strip" keeps, on purpose:
//   - every byte of image data (JPEG scans, PNG IDAT, WebP VP8/VP8L/ALPH/ANIM frames), so
//     nothing is re-encoded and quality is untouched;
//   - the colour profile (JPEG APP2 ICC_PROFILE, PNG iCCP/sRGB/gAMA/cHRM, WebP ICCP) and the
//     JPEG Adobe APP14 marker, which decoders need to get colours right;
//   - the orientation: phones often store photos sideways and record "rotate 90°" in EXIF. If
//     the original says anything other than "upright", the output gets a new 32-byte EXIF block
//     holding only that Orientation tag, so the photo doesn't suddenly display sideways.
// Everything else (GPS, dates, camera make/model/serials, lens, software, thumbnails, XMP,
// IPTC, comments, maker notes, extra embedded images and data after the end of the image) goes.
import { sniffHeic } from './heic.js';

// ---------------------------------------------------------------------------
// Format detection

/** @returns {'jpeg'|'png'|'webp'|'heic'|null} */
export function detectFormat(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a) return 'png';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (sniffHeic(b)) return 'heic';
  return null;
}

export class MetadataError extends Error {}

function ascii(b, o, n) {
  let s = '';
  for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]);
  return s;
}
const startsWith = (b, o, s) => ascii(b, o, s.length) === s;
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------------------
// EXIF (TIFF structure), both byte orders

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const MAX_ENTRIES = 1000;

/** Strings in EXIF are NUL-terminated ASCII (often padded with spaces/NULs); keep printable text. */
function cleanText(s) {
  return s.replace(/\0[\s\S]*$/, '').replace(/[\x00-\x1f\x7f]/g, '').trim();
}

/**
 * Parse an EXIF/TIFF block (starting at the "II*\0" / "MM\0*" header).
 * @param {Uint8Array} t
 * @returns {object|null} what was found; null if it isn't a TIFF structure.
 */
export function parseExif(t) {
  if (!t || t.length < 8) return null;
  const order = ascii(t, 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const d = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (o) => d.getUint16(o, le), u32 = (o) => d.getUint32(o, le);
  if (u16(2) !== 42) return null;

  const visited = new Set();
  function readIfd(off) {
    const tags = new Map();
    if (!off || off + 2 > t.length || visited.has(off)) return { tags, next: 0 };
    visited.add(off);
    const n = Math.min(u16(off), MAX_ENTRIES);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > t.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const size = TYPE_SIZE[type];
      if (!size || count > t.length) continue;
      const bytes = size * count;
      const at = bytes <= 4 ? e + 8 : u32(e + 8);
      if (at + bytes > t.length) continue;
      tags.set(tag, { type, count, at });
    }
    const nextAt = off + 2 + n * 12;
    return { tags, next: nextAt + 4 <= t.length ? u32(nextAt) : 0 };
  }
  const str = (e) => (e && e.type === 2 ? cleanText(ascii(t, e.at, e.count)) : e && e.type === 7 ? cleanText(ascii(t, e.at, e.count)) : '');
  const num = (e, i = 0) => {
    if (!e) return null;
    const s = TYPE_SIZE[e.type], o = e.at + i * s;
    if (i >= e.count) return null;
    switch (e.type) {
      case 1: case 7: return t[o];
      case 3: return u16(o);
      case 4: return u32(o);
      case 9: return d.getInt32(o, le);
      case 5: { const den = u32(o + 4); return den ? u32(o) / den : null; }
      case 10: { const den = d.getInt32(o + 4, le); return den ? d.getInt32(o, le) / den : null; }
      default: return null;
    }
  };

  const ifd0 = readIfd(u32(4));
  const exif = readIfd(ifd0.tags.has(0x8769) ? num(ifd0.tags.get(0x8769)) : 0).tags;
  const gpsIfd = ifd0.tags.has(0x8825) ? readIfd(num(ifd0.tags.get(0x8825))).tags : null;
  const ifd1 = ifd0.next ? readIfd(ifd0.next).tags : new Map();
  const t0 = ifd0.tags;

  const out = {
    orientation: num(t0.get(0x0112)) || null,
    make: str(t0.get(0x010f)),
    model: str(t0.get(0x0110)),
    software: str(t0.get(0x0131)),
    modified: str(t0.get(0x0132)),
    description: str(t0.get(0x010e)),
    artist: str(t0.get(0x013b)),
    copyright: str(t0.get(0x8298)),
    dateTaken: str(exif.get(0x9003)) || str(exif.get(0x9004)),
    offsetTime: str(exif.get(0x9011)) || str(exif.get(0x9010)),
    lensMake: str(exif.get(0xa433)),
    lens: str(exif.get(0xa434)),
    owner: str(exif.get(0xa430)),
    serial: str(exif.get(0xa431)) || str(t0.get(0xc62f)),
    lensSerial: str(exif.get(0xa435)),
    uniqueId: str(exif.get(0xa420)),
    makerNote: exif.has(0x927c),
    thumbnail: ifd1.has(0x0201) || ifd1.has(0x0111),
    gps: null,
  };
  if (gpsIfd) {
    const dms = (e) => (e && e.type === 5 && e.count >= 3 ? [num(e, 0), num(e, 1), num(e, 2)] : null);
    const lat = dms(gpsIfd.get(2)), lon = dms(gpsIfd.get(4));
    const toDeg = (v, ref, neg) => {
      if (!v || v.some((x) => x == null || !Number.isFinite(x))) return null;
      const deg = v[0] + v[1] / 60 + v[2] / 3600;
      return ref === neg ? -deg : deg;
    };
    const latDeg = toDeg(lat, str(gpsIfd.get(1)).toUpperCase(), 'S');
    const lonDeg = toDeg(lon, str(gpsIfd.get(3)).toUpperCase(), 'W');
    const alt = num(gpsIfd.get(6));
    out.gps = {
      lat: latDeg, lon: lonDeg,
      altitude: alt == null ? null : num(gpsIfd.get(5)) === 1 ? -alt : alt,
      hasCoords: latDeg != null && lonDeg != null && Math.abs(latDeg) <= 90 && Math.abs(lonDeg) <= 180,
    };
  }
  return out;
}

/** A TIFF block with only IFD0 → Orientation (little-endian, 26 bytes). */
export function orientationTiff(orientation) {
  const t = new Uint8Array(26);
  const d = new DataView(t.buffer);
  t.set([0x49, 0x49, 0x2a, 0x00]);
  d.setUint32(4, 8, true);          // IFD0 at 8
  d.setUint16(8, 1, true);          // one entry
  d.setUint16(10, 0x0112, true);    // Orientation
  d.setUint16(12, 3, true);         // SHORT
  d.setUint32(14, 1, true);         // count 1
  d.setUint16(18, orientation, true);
  d.setUint32(22, 0, true);         // no next IFD
  return t;
}
const keepOrientation = (o) => Number.isInteger(o) && o >= 2 && o <= 8;

// ---------------------------------------------------------------------------
// XMP: a quick look for location in XMP packets (e.g. photos edited in Lightroom).

/** XMP stores GPS as "37,46.494N" or "37,46,29.64N". */
function xmpCoord(s) {
  const m = /^\s*(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?(?:,(\d+(?:\.\d+)?))?\s*([NSEW])\s*$/i.exec(s || '');
  if (!m) return null;
  const v = +m[1] + (m[2] ? +m[2] / 60 : 0) + (m[3] ? +m[3] / 3600 : 0);
  return /[SW]/i.test(m[4]) ? -v : v;
}
export function parseXmp(text) {
  const get = (name) => {
    const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"|<${name}>([^<]*)</${name}>`).exec(text);
    return m ? (m[1] ?? m[2]) : null;
  };
  const lat = xmpCoord(get('exif:GPSLatitude')), lon = xmpCoord(get('exif:GPSLongitude'));
  return { gps: lat != null && lon != null ? { lat, lon, hasCoords: true } : null };
}

// ---------------------------------------------------------------------------
// JPEG

const isApp = (m) => m >= 0xe0 && m <= 0xef;
const ICC = 'ICC_PROFILE\0';

/**
 * Split a JPEG into segments. Entropy-coded scan data is attached to the SOS segment that
 * precedes it (so it's copied untouched). Stops at EOI; anything after it is `trailing`.
 */
export function jpegSegments(b) {
  if (detectFormat(b) !== 'jpeg') throw new MetadataError('Not a JPEG file.');
  const segs = [{ marker: 0xd8, start: 0, end: 2 }];
  let o = 2;
  for (;;) {
    if (o >= b.length) throw new MetadataError('This JPEG is incomplete (it ends before the image does).');
    if (b[o] !== 0xff) throw new MetadataError('This JPEG looks damaged (unexpected bytes between segments).');
    while (b[o] === 0xff && o < b.length) o++; // fill bytes
    const marker = b[o];
    const start = o - 1;
    o++;
    if (marker === 0xd9) { segs.push({ marker, start, end: o }); break; }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { segs.push({ marker, start, end: o }); continue; }
    if (o + 2 > b.length) throw new MetadataError('This JPEG is incomplete.');
    const len = (b[o] << 8) | b[o + 1];
    if (len < 2 || o + len > b.length) throw new MetadataError('This JPEG is incomplete or damaged.');
    const seg = { marker, start, data: o + 2, end: o + len };
    o += len;
    if (marker === 0xda) {
      // Entropy-coded data runs until a marker that isn't stuffing (FF00) or a restart (FFD0-7).
      while (o + 1 < b.length) {
        if (b[o] === 0xff) {
          const n = b[o + 1];
          if (n !== 0 && !(n >= 0xd0 && n <= 0xd7) && n !== 0xff) break;
        }
        o++;
      }
      if (o + 1 >= b.length) throw new MetadataError('This JPEG is incomplete (it ends in the middle of the image).');
      seg.end = o;
    }
    segs.push(seg);
  }
  const last = segs[segs.length - 1];
  return { segs, trailing: b.length - last.end };
}

function describeJpegSeg(b, s) {
  const m = s.marker;
  if (m === 0xe0) return startsWith(b, s.data, 'JFIF\0') ? 'jfif' : 'app';
  if (m === 0xe1) {
    if (startsWith(b, s.data, 'Exif\0')) return 'exif';
    if (startsWith(b, s.data, 'http://ns.adobe.com/xap/1.0/\0')) return 'xmp';
    if (startsWith(b, s.data, 'http://ns.adobe.com/xmp/extension/\0')) return 'xmpext';
    return 'app';
  }
  if (m === 0xe2) {
    if (startsWith(b, s.data, ICC)) return 'icc';
    if (startsWith(b, s.data, 'MPF\0')) return 'mpf';
    return 'app';
  }
  if (m === 0xed) return 'iptc';
  if (m === 0xee) return startsWith(b, s.data, 'Adobe') ? 'adobe' : 'app';
  if (m === 0xfe) return 'comment';
  if (isApp(m)) return 'app';
  return 'image';
}

function inspectJpeg(b) {
  const { segs, trailing } = jpegSegments(b);
  const r = blankReport('jpeg');
  for (const s of segs) {
    const kind = describeJpegSeg(b, s);
    if (kind === 'exif') {
      const e = parseExif(b.subarray(s.data + 6, s.end));
      if (e) mergeExif(r, e);
      r.exif = true;
    } else if (kind === 'xmp') {
      r.xmp = true;
      const x = parseXmp(new TextDecoder().decode(b.subarray(s.data + 29, s.end)));
      if (x.gps && !r.gps) r.gps = x.gps;
    } else if (kind === 'xmpext') r.xmp = true;
    else if (kind === 'iptc') r.iptc = true;
    else if (kind === 'comment') r.comments.push(cleanText(new TextDecoder().decode(b.subarray(s.data, s.end))));
    else if (kind === 'icc') r.icc = true;
    else if (kind === 'mpf') r.extraImages = true;
    else if (kind === 'app') r.otherBlocks++;
  }
  r.trailingBytes = trailing;
  return r;
}

function stripJpeg(b) {
  const { segs } = jpegSegments(b);
  let orientation = null;
  for (const s of segs) {
    if (describeJpegSeg(b, s) === 'exif') {
      const e = parseExif(b.subarray(s.data + 6, s.end));
      if (e?.orientation) { orientation = e.orientation; break; }
    }
  }
  const parts = [];
  let inserted = false;
  const exifSeg = () => {
    const tiff = orientationTiff(orientation);
    const seg = new Uint8Array(4 + 6 + tiff.length);
    const len = seg.length - 2;
    seg.set([0xff, 0xe1, len >> 8, len & 0xff]);
    seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); // "Exif\0\0"
    seg.set(tiff, 10);
    return seg;
  };
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const kind = s.marker === 0xd8 ? 'soi' : describeJpegSeg(b, s);
    const keep = kind === 'soi' || kind === 'jfif' || kind === 'icc' || kind === 'adobe' || kind === 'image';
    if (kind === 'jfif' && s.end - s.data > 14) {
      // JFIF can carry a thumbnail; keep the header (version, density) and drop it.
      const seg = b.slice(s.start, s.data + 14);
      seg[2] = 0; seg[3] = 16; seg[s.data - s.start + 12] = 0; seg[s.data - s.start + 13] = 0;
      parts.push(seg);
    } else if (keep) parts.push(b.subarray(s.start, s.end));
    // The orientation-only EXIF goes right after SOI (and after JFIF APP0, which must come first).
    if (!inserted && keepOrientation(orientation) && (kind === 'soi' || kind === 'jfif')) {
      const next = segs[i + 1];
      const nextIsJfif = next && describeJpegSeg(b, next) === 'jfif';
      if (!(kind === 'soi' && nextIsJfif)) { parts.push(exifSeg()); inserted = true; }
    }
  }
  return concat(parts);
}

// ---------------------------------------------------------------------------
// PNG

const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

let crcTable;
export function crc32(b, start = 0, end = b.length) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function pngChunks(b) {
  if (detectFormat(b) !== 'png') throw new MetadataError('Not a PNG file.');
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const chunks = [];
  let o = 8;
  while (o + 12 <= b.length) {
    const len = d.getUint32(o);
    const type = ascii(b, o + 4, 4);
    const end = o + 12 + len;
    if (end > b.length) throw new MetadataError('This PNG is incomplete or damaged.');
    chunks.push({ type, start: o, data: o + 8, len, end });
    o = end;
    if (type === 'IEND') break;
  }
  if (!chunks.length || chunks[chunks.length - 1].type !== 'IEND') throw new MetadataError('This PNG is incomplete (no end marker).');
  return chunks;
}

function pngChunk(type, data) {
  const c = new Uint8Array(12 + data.length);
  const d = new DataView(c.buffer);
  d.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
  c.set(data, 8);
  d.setUint32(8 + data.length, crc32(c, 4, 8 + data.length));
  return c;
}

function inspectPng(b) {
  const r = blankReport('png');
  for (const c of pngChunks(b)) {
    if (c.type === 'eXIf') {
      r.exif = true;
      const e = parseExif(b.subarray(c.data, c.data + c.len));
      if (e) mergeExif(r, e);
    } else if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') {
      const body = b.subarray(c.data, c.data + c.len);
      const nul = body.indexOf(0);
      const key = cleanText(new TextDecoder('latin1').decode(body.subarray(0, nul < 0 ? Math.min(79, body.length) : nul)));
      if (key === 'XML:com.adobe.xmp') {
        r.xmp = true;
        if (c.type !== 'zTXt') {
          const x = parseXmp(new TextDecoder().decode(body));
          if (x.gps && !r.gps) r.gps = x.gps;
        }
      } else if (key && !r.textKeys.includes(key)) r.textKeys.push(key);
    } else if (c.type === 'tIME') r.modifiedTime = true;
    else if (c.type === 'iCCP' || c.type === 'sRGB') r.icc = true;
  }
  return r;
}

function stripPng(b) {
  const chunks = pngChunks(b);
  const parts = [b.subarray(0, 8)];
  for (const c of chunks) {
    if (c.type === 'eXIf') {
      const e = parseExif(b.subarray(c.data, c.data + c.len));
      if (keepOrientation(e?.orientation)) parts.push(pngChunk('eXIf', orientationTiff(e.orientation)));
      continue;
    }
    if (PNG_DROP.has(c.type)) continue;
    parts.push(b.subarray(c.start, c.end));
  }
  return concat(parts);
}

// ---------------------------------------------------------------------------
// WebP (RIFF)

export function webpChunks(b) {
  if (detectFormat(b) !== 'webp') throw new MetadataError('Not a WebP file.');
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const riffEnd = Math.min(b.length, 8 + d.getUint32(4, true));
  const chunks = [];
  let o = 12;
  while (o + 8 <= riffEnd) {
    const type = ascii(b, o, 4);
    const len = d.getUint32(o + 4, true);
    const end = o + 8 + len + (len & 1);
    if (o + 8 + len > b.length) throw new MetadataError('This WebP is incomplete or damaged.');
    chunks.push({ type, start: o, data: o + 8, len, end: Math.min(end, b.length) });
    o = end;
  }
  if (!chunks.length) throw new MetadataError('This WebP has no image data.');
  return chunks;
}

const webpExifBody = (b, c) => {
  let body = b.subarray(c.data, c.data + c.len);
  if (startsWith(body, 0, 'Exif\0\0')) body = body.subarray(6); // some writers add the JPEG prefix
  return body;
};

function inspectWebp(b) {
  const r = blankReport('webp');
  for (const c of webpChunks(b)) {
    if (c.type === 'EXIF') {
      r.exif = true;
      const e = parseExif(webpExifBody(b, c));
      if (e) mergeExif(r, e);
    } else if (c.type === 'XMP ') {
      r.xmp = true;
      const x = parseXmp(new TextDecoder().decode(b.subarray(c.data, c.data + c.len)));
      if (x.gps && !r.gps) r.gps = x.gps;
    } else if (c.type === 'ICCP') r.icc = true;
  }
  return r;
}

function stripWebp(b) {
  const chunks = webpChunks(b);
  let orientation = null;
  for (const c of chunks) if (c.type === 'EXIF') orientation = parseExif(webpExifBody(b, c))?.orientation ?? null;
  const keepExif = keepOrientation(orientation);
  const parts = [];
  for (const c of chunks) {
    if (c.type === 'XMP ') continue;
    if (c.type === 'EXIF') {
      if (!keepExif) continue;
      const tiff = orientationTiff(orientation);
      const h = new Uint8Array(8);
      h.set([0x45, 0x58, 0x49, 0x46]); // "EXIF"
      new DataView(h.buffer).setUint32(4, tiff.length, true);
      parts.push(h, tiff); // 26 bytes: even, no padding
      continue;
    }
    if (c.type === 'VP8X') {
      const copy = b.slice(c.start, c.end);
      copy[8] &= ~(0x04 | (keepExif ? 0 : 0x08)); // clear XMP flag, and EXIF flag unless kept
      parts.push(copy);
      continue;
    }
    parts.push(b.subarray(c.start, c.end));
  }
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(b.subarray(0, 12));
  new DataView(out.buffer).setUint32(4, 4 + body.length, true);
  out.set(body, 12);
  return out;
}

// ---------------------------------------------------------------------------
// Public API

function blankReport(format) {
  return {
    format, exif: false, gps: null, orientation: null, dateTaken: '', offsetTime: '', modified: '',
    make: '', model: '', lens: '', software: '', serial: '', lensSerial: '', owner: '', artist: '',
    copyright: '', description: '', uniqueId: '', makerNote: false, thumbnail: false,
    xmp: false, iptc: false, comments: [], textKeys: [], modifiedTime: false,
    icc: false, extraImages: false, otherBlocks: 0, trailingBytes: 0,
  };
}
function mergeExif(r, e) {
  for (const [k, v] of Object.entries(e)) if (v && !r[k]) r[k] = v;
}

/** What metadata a JPEG/PNG/WebP file holds. Throws MetadataError for other formats. */
export function inspect(bytes) {
  const f = detectFormat(bytes);
  if (f === 'jpeg') return inspectJpeg(bytes);
  if (f === 'png') return inspectPng(bytes);
  if (f === 'webp') return inspectWebp(bytes);
  throw new MetadataError(f === 'heic' ? 'HEIC photos are converted, not stripped.' : 'Unsupported file type.');
}

/** A copy of the file without metadata (orientation and colour profile kept). Lossless. */
export function strip(bytes) {
  const f = detectFormat(bytes);
  if (f === 'jpeg') return stripJpeg(bytes);
  if (f === 'png') return stripPng(bytes);
  if (f === 'webp') return stripWebp(bytes);
  throw new MetadataError('Unsupported file type.');
}

const ORIENTATION = { 1: 'upright', 2: 'mirrored', 3: 'rotated 180°', 4: 'flipped vertically', 5: 'mirrored and rotated 90°', 6: 'rotated 90°', 7: 'mirrored and rotated 270°', 8: 'rotated 270°' };
const fmtDate = (s) => {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s || '');
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}${m[6] ? `:${m[6]}` : ''}` : s;
};
export const formatCoord = (v) => (Math.round(v * 1e5) / 1e5).toFixed(5).replace(/0+$/, '').replace(/\.$/, '');

/**
 * Human-readable list of what was found, most sensitive first.
 * @returns {{ kind: 'location'|'personal'|'info'|'kept', label: string, value: string }[]}
 */
export function summarize(r) {
  const out = [];
  const add = (kind, label, value = '') => out.push({ kind, label, value: String(value) });
  if (r.gps) {
    if (r.gps.hasCoords) {
      add('location', 'Location', `${formatCoord(r.gps.lat)}, ${formatCoord(r.gps.lon)}${r.gps.altitude != null && Number.isFinite(r.gps.altitude) ? ` (altitude ${Math.round(r.gps.altitude)} m)` : ''}`);
    } else add('location', 'Location data', 'GPS fields present');
  }
  if (r.dateTaken) add('personal', 'Date taken', fmtDate(r.dateTaken) + (r.offsetTime ? ` (UTC${r.offsetTime})` : ''));
  if (r.serial) add('personal', 'Camera serial number', r.serial);
  if (r.lensSerial) add('personal', 'Lens serial number', r.lensSerial);
  if (r.owner) add('personal', 'Camera owner', r.owner);
  if (r.artist) add('personal', 'Artist / author', r.artist);
  if (r.uniqueId) add('personal', 'Unique image ID', r.uniqueId);
  const camera = r.make && r.model.toLowerCase().startsWith(r.make.toLowerCase()) ? r.model : [r.make, r.model].filter(Boolean).join(' ');
  if (camera) add('info', 'Camera', camera);
  if (r.lens) add('info', 'Lens', [r.lensMake && !r.lens.startsWith(r.lensMake) ? r.lensMake : '', r.lens].filter(Boolean).join(' '));
  if (r.software) add('info', 'Software', r.software);
  if (r.modified && r.modified !== r.dateTaken) add('info', 'Date modified', fmtDate(r.modified));
  if (r.copyright) add('info', 'Copyright', r.copyright);
  if (r.description) add('info', 'Description', r.description);
  for (const c of r.comments.filter(Boolean)) add('info', 'Comment', c.length > 120 ? `${c.slice(0, 117)}…` : c);
  if (r.textKeys.length) add('info', 'Text fields', r.textKeys.join(', '));
  if (r.modifiedTime) add('info', 'Last-modified time', 'PNG tIME');
  if (r.makerNote) add('info', 'Maker notes', 'camera-specific data');
  if (r.thumbnail) add('info', 'Embedded thumbnail', 'a small preview copy of the photo');
  if (r.xmp) add('info', 'XMP metadata', 'editing and descriptive data');
  if (r.iptc) add('info', 'IPTC metadata', 'captions, keywords, credits');
  if (r.extraImages) add('info', 'Extra embedded images', 'e.g. depth map or HDR data');
  if (r.otherBlocks) add('info', 'Other metadata blocks', r.otherBlocks);
  if (r.trailingBytes) add('info', 'Extra data after the image', `${r.trailingBytes.toLocaleString('en-US')} bytes (e.g. a motion photo clip)`);
  const removable = out.length;
  if (r.exif && !removable && !keepOrientation(r.orientation)) add('info', 'EXIF block', 'no notable fields');
  if (keepOrientation(r.orientation)) add('kept', 'Orientation (kept)', ORIENTATION[r.orientation]);
  if (r.icc) add('kept', 'Colour profile (kept)', '');
  return out;
}
