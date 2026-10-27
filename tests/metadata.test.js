import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, parseExif, inspect, strip, summarize, jpegSegments, pngChunks, webpChunks, crc32, orientationTiff, MetadataError } from '../src/js/lib/metadata.js';

// ---------------------------------------------------------------------------
// Fixture builders (hand-made bytes; no image libraries)

const enc = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const has = (hay, needle) => {
  const n = typeof needle === 'string' ? enc(needle) : needle;
  outer: for (let i = 0; i + n.length <= hay.length; i++) { for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer; return true; }
  return false;
};
const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };
const A = (tag, s) => ({ tag, type: 2, values: s });          // ASCII
const S = (tag, v) => ({ tag, type: 3, values: [v] });        // SHORT
const R = (tag, ...v) => ({ tag, type: 5, values: v });       // RATIONAL [[num, den], ...]

/**
 * Build a TIFF/EXIF block: IFD0 (+ optional Exif IFD, GPS IFD, IFD1), in either byte order.
 * Sub-IFD pointers (0x8769, 0x8825) are added automatically.
 */
function tiff({ le = true, ifd0 = [], exif = null, gps = null, ifd1 = null }) {
  const ifds = [{ name: 'ifd0', entries: [...ifd0] }];
  if (exif) { ifds[0].entries.push({ tag: 0x8769, type: 4, ptr: 'exif' }); ifds.push({ name: 'exif', entries: exif }); }
  if (gps) { ifds[0].entries.push({ tag: 0x8825, type: 4, ptr: 'gps' }); ifds.push({ name: 'gps', entries: gps }); }
  if (ifd1) ifds.push({ name: 'ifd1', entries: ifd1 });
  for (const i of ifds) i.entries.sort((a, b) => a.tag - b.tag);
  const offs = {}; let o = 8;
  for (const i of ifds) { offs[i.name] = o; o += 2 + 12 * i.entries.length + 4; }
  // data area for values > 4 bytes
  const data = []; let dataOff = o;
  const valueBytes = (e) => {
    if (e.type === 2) return [...enc(e.values), 0];
    const b = []; const w = (n, sz) => { for (let k = 0; k < sz; k++) b.push(le ? (n >>> (8 * k)) & 255 : (n >>> (8 * (sz - 1 - k))) & 255); };
    for (const v of e.values) { if (e.type === 5) { w(v[0], 4); w(v[1], 4); } else w(v, SIZE[e.type]); }
    return b;
  };
  for (const i of ifds) for (const e of i.entries) {
    if (e.ptr) { e.bytes = null; continue; }
    e.bytes = valueBytes(e);
    if (e.bytes.length > 4) { e.off = dataOff; data.push(...e.bytes); if (e.bytes.length & 1) data.push(0); dataOff = 8 + (o - 8) + data.length; }
  }
  const out = new Uint8Array(o + data.length);
  const d = new DataView(out.buffer);
  out.set(enc(le ? 'II' : 'MM')); d.setUint16(2, 42, le); d.setUint32(4, 8, le);
  for (const [idx, i] of ifds.entries()) {
    let p = offs[i.name];
    d.setUint16(p, i.entries.length, le); p += 2;
    for (const e of i.entries) {
      d.setUint16(p, e.tag, le); d.setUint16(p + 2, e.type, le);
      if (e.ptr) { d.setUint32(p + 4, 1, le); d.setUint32(p + 8, offs[e.ptr], le); }
      else {
        d.setUint32(p + 4, e.type === 2 ? e.bytes.length : e.values.length, le);
        if (e.bytes.length > 4) d.setUint32(p + 8, e.off, le); else out.set(e.bytes, p + 8);
      }
      p += 12;
    }
    d.setUint32(p, i.name === 'ifd0' && ifd1 ? offs.ifd1 : 0, le);
    void idx;
  }
  out.set(data, o);
  return out;
}

// A phone-like EXIF: San Francisco GPS (37°46'29.64"N 122°25'9.84"W), orientation 6, serials.
const PHONE = (le) => tiff({
  le,
  ifd0: [A(0x010f, 'Apple'), A(0x0110, 'iPhone 15 Pro'), S(0x0112, 6), A(0x0131, '17.1'), A(0x0132, '2024:05:12 14:03:22')],
  exif: [A(0x9003, '2024:05:12 14:03:22'), A(0x9011, '-07:00'), A(0xa431, 'SN12345'), A(0xa434, 'iPhone 15 Pro back triple camera 6.86mm f/1.78'), A(0xa433, 'Apple'), A(0xa435, 'LS999')],
  gps: [A(1, 'N'), R(2, [37, 1], [46, 1], [2964, 100]), A(3, 'W'), R(4, [122, 1], [25, 1], [984, 100]), { tag: 5, type: 1, values: [0] }, R(6, [161, 10])],
  ifd1: [{ tag: 0x0201, type: 4, values: [0] }, { tag: 0x0202, type: 4, values: [0] }],
});

const seg = (marker, body) => cat(new Uint8Array([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255]), body);
const JFIF = seg(0xe0, cat(enc('JFIF\0'), new Uint8Array([1, 1, 0, 0, 72, 0, 72, 0, 0])));
const ICC_SEG = seg(0xe2, cat(enc('ICC_PROFILE\0'), new Uint8Array([1, 1]), enc('fake-icc-profile-bytes')));
const ADOBE = seg(0xee, cat(enc('Adobe'), new Uint8Array([0, 100, 0, 0, 0, 0, 1])));
const XMP = seg(0xe1, cat(enc('http://ns.adobe.com/xap/1.0/\0'), enc('<x:xmpmeta><rdf:Description exif:GPSLatitude="37,46.494N" exif:GPSLongitude="122,25.164W"/></x:xmpmeta>')));
const IPTC = seg(0xed, cat(enc('Photoshop 3.0\0'), enc('8BIM\x04\x04\0\0\0\0\0\x05\x1c\x02\x78\0\x00')));
const COM = seg(0xfe, enc('Taken at Grandma\'s house'));
const MPF = seg(0xe2, cat(enc('MPF\0'), new Uint8Array(16)));
const DQT = seg(0xdb, new Uint8Array(65));
const SOF = seg(0xc0, new Uint8Array([8, 0, 16, 0, 16, 1, 1, 0x11, 0]));
const DHT = seg(0xc4, new Uint8Array(29));
const SOS = seg(0xda, new Uint8Array([1, 1, 0, 0, 63, 0]));
// Entropy data with byte stuffing (FF 00), a restart marker (FF D0) and fill bytes.
const SCAN = new Uint8Array([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xe1, 0xff, 0x00, 0x78, 0x9a]);
const EOI = new Uint8Array([0xff, 0xd9]);
const exifSeg = (t) => seg(0xe1, cat(enc('Exif\0\0'), t));

function phoneJpeg(le = false) {
  return cat(new Uint8Array([0xff, 0xd8]), JFIF, exifSeg(PHONE(le)), XMP, ICC_SEG, MPF, IPTC, ADOBE, COM, DQT, SOF, DHT, SOS, SCAN, EOI, enc('TRAILING-MOTION-PHOTO-VIDEO'));
}
const imageData = (b) => { const { segs } = jpegSegments(b); const sos = segs.find((s) => s.marker === 0xda); return b.subarray(sos.start, segs[segs.length - 1].end); };

// ---------------------------------------------------------------------------
test('detectFormat', () => {
  assert.equal(detectFormat(phoneJpeg()), 'jpeg');
  assert.equal(detectFormat(cat(new Uint8Array([0x89]), enc('PNG\r\n\x1a\n'), new Uint8Array(8))), 'png');
  assert.equal(detectFormat(cat(enc('RIFF'), new Uint8Array(4), enc('WEBPVP8 '))), 'webp');
  assert.equal(detectFormat(cat(new Uint8Array([0, 0, 0, 24]), enc('ftypheic'), new Uint8Array(4), enc('mif1heic'))), 'heic');
  assert.equal(detectFormat(enc('GIF89a.........')), null);
  assert.equal(detectFormat(new Uint8Array(3)), null);
});

for (const le of [true, false]) {
  test(`parseExif ${le ? 'little' : 'big'}-endian: GPS, date, camera, serials, thumbnail`, () => {
    const e = parseExif(PHONE(le));
    assert.equal(e.orientation, 6);
    assert.equal(e.make, 'Apple'); assert.equal(e.model, 'iPhone 15 Pro');
    assert.equal(e.software, '17.1');
    assert.equal(e.dateTaken, '2024:05:12 14:03:22'); assert.equal(e.offsetTime, '-07:00');
    assert.equal(e.serial, 'SN12345'); assert.equal(e.lensSerial, 'LS999');
    assert.match(e.lens, /triple camera/);
    assert.ok(e.thumbnail);
    assert.ok(e.gps.hasCoords);
    assert.ok(Math.abs(e.gps.lat - 37.7749) < 1e-4, e.gps.lat);
    assert.ok(Math.abs(e.gps.lon - -122.4194) < 1e-4, e.gps.lon);
    assert.equal(e.gps.altitude, 16.1);
  });
}

test('parseExif: southern/eastern hemisphere and below sea level', () => {
  const e = parseExif(tiff({ le: false, ifd0: [], gps: [A(1, 'S'), R(2, [33, 1], [52, 1], [0, 1]), A(3, 'E'), R(4, [151, 1], [12, 1], [36, 1]), { tag: 5, type: 1, values: [1] }, R(6, [5, 1])] }));
  assert.ok(Math.abs(e.gps.lat - -33.866667) < 1e-5);
  assert.ok(Math.abs(e.gps.lon - 151.21) < 1e-5);
  assert.equal(e.gps.altitude, -5);
});

test('parseExif: rejects garbage and survives hostile offsets/loops', () => {
  assert.equal(parseExif(enc('not a tiff at all')), null);
  const t = tiff({ ifd0: [S(0x0112, 3)] });
  const d = new DataView(t.buffer);
  d.setUint32(t.length - 4 - 0, 8, true); // next-IFD points back at IFD0: must not loop
  const loop = parseExif(t);
  assert.equal(loop.orientation, 3);
  const bad = tiff({ ifd0: [A(0x010f, 'A long make string')] });
  new DataView(bad.buffer).setUint32(8 + 2 + 8, 0xfffffff0, true); // value offset out of range
  assert.equal(parseExif(bad).make, '');
});

test('JPEG inspect: finds everything, both byte orders', () => {
  for (const le of [true, false]) {
    const r = inspect(phoneJpeg(le));
    assert.equal(r.format, 'jpeg');
    assert.ok(r.gps.hasCoords && r.xmp && r.iptc && r.icc && r.extraImages && r.makerNote === false);
    assert.deepEqual(r.comments, ["Taken at Grandma's house"]);
    assert.equal(r.trailingBytes, 'TRAILING-MOTION-PHOTO-VIDEO'.length);
    const s = summarize(r);
    const loc = s.find((x) => x.kind === 'location');
    assert.equal(loc.label, 'Location');
    assert.match(loc.value, /^37\.7749, -122\.4194/);
    const labels = s.map((x) => x.label);
    for (const l of ['Date taken', 'Camera serial number', 'Lens serial number', 'Camera', 'Lens', 'Software', 'Comment', 'Embedded thumbnail', 'XMP metadata', 'IPTC metadata', 'Extra embedded images', 'Extra data after the image', 'Orientation (kept)', 'Colour profile (kept)']) {
      assert.ok(labels.includes(l), `missing ${l}: ${labels}`);
    }
    assert.equal(s.find((x) => x.label === 'Camera').value, 'Apple iPhone 15 Pro');
    assert.equal(summarize({ ...r, make: 'Canon', model: 'Canon EOS R5' }).find((x) => x.label === 'Camera').value, 'Canon EOS R5'); // make not repeated
    assert.equal(s.find((x) => x.label === 'Date taken').value, '2024-05-12 14:03:22 (UTC-07:00)');
  }
});

test('JPEG strip: no GPS/EXIF except orientation, ICC + Adobe kept, scan byte-identical', () => {
  for (const le of [true, false]) {
    const src = phoneJpeg(le);
    const out = strip(src);
    assert.deepEqual(imageData(out), imageData(src), 'scan data must be byte-identical');
    assert.ok(has(out, 'ICC_PROFILE\0') && has(out, 'fake-icc-profile-bytes'), 'ICC kept');
    assert.ok(has(out, 'Adobe'), 'Adobe APP14 kept');
    for (const gone of ['Apple', 'iPhone', 'SN12345', 'LS999', 'http://ns.adobe.com', 'Photoshop', 'Grandma', 'MPF\0', 'TRAILING', '2024:05']) assert.ok(!has(out, gone), `still has ${gone}`);
    const r = inspect(out);
    assert.equal(r.gps, null);
    assert.equal(r.orientation, 6, 'orientation preserved');
    assert.equal(r.trailingBytes, 0);
    assert.deepEqual(summarize(r).map((x) => x.kind), ['kept', 'kept']);
    // Layout: SOI, JFIF APP0, then the orientation-only EXIF.
    const { segs } = jpegSegments(out);
    assert.deepEqual(segs.slice(0, 4).map((s) => s.marker), [0xd8, 0xe0, 0xe1, 0xe2]);
    assert.equal(segs[2].end - segs[2].start, 4 + 6 + 26);
    assert.ok(out.length < src.length);
    // Idempotent
    assert.deepEqual(strip(out), out);
  }
});

test('JPEG strip: orientation 1 or missing -> no EXIF at all; no JFIF -> EXIF after SOI', () => {
  const up = cat(new Uint8Array([0xff, 0xd8]), exifSeg(tiff({ ifd0: [S(0x0112, 1), A(0x010f, 'Canon')] })), DQT, SOF, SOS, SCAN, EOI);
  const o1 = strip(up);
  assert.ok(!has(o1, 'Exif') && !has(o1, 'Canon'));
  assert.deepEqual(imageData(o1), imageData(up));
  const rot = cat(new Uint8Array([0xff, 0xd8]), exifSeg(tiff({ le: false, ifd0: [S(0x0112, 8)] })), DQT, SOF, SOS, SCAN, EOI);
  const o2 = strip(rot);
  assert.deepEqual(jpegSegments(o2).segs.slice(0, 2).map((s) => s.marker), [0xd8, 0xe1]);
  assert.equal(inspect(o2).orientation, 8);
});

test('JPEG strip: JFIF thumbnail removed, header kept', () => {
  const jfifThumb = seg(0xe0, cat(enc('JFIF\0'), new Uint8Array([1, 2, 1, 0, 72, 0, 72, 2, 1]), new Uint8Array(6).fill(0xab)));
  const src = cat(new Uint8Array([0xff, 0xd8]), jfifThumb, DQT, SOF, SOS, SCAN, EOI);
  const out = strip(src);
  const s = jpegSegments(out).segs[1];
  assert.equal(s.end - s.start, 18);
  assert.deepEqual([...out.subarray(s.data, s.end)], [...enc('JFIF\0'), 1, 2, 1, 0, 72, 0, 72, 0, 0]);
});

test('JPEG: truncated or damaged files give a clear error', () => {
  const src = phoneJpeg();
  assert.throws(() => strip(src.subarray(0, 200)), MetadataError);
  assert.throws(() => inspect(cat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff])), MetadataError));
  assert.throws(() => strip(enc('hello world, not an image')), MetadataError);
});

// ---------------------------------------------------------------------------
// PNG
function chunk(type, data) {
  const c = new Uint8Array(12 + data.length); const d = new DataView(c.buffer);
  d.setUint32(0, data.length); c.set(enc(type), 4); c.set(data, 8); d.setUint32(8 + data.length, crc32(c, 4, 8 + data.length));
  return c;
}
const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR = chunk('IHDR', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
const IDAT = chunk('IDAT', new Uint8Array([0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00]));
const IEND = chunk('IEND', new Uint8Array());

test('crc32 matches the PNG spec (IEND = AE426082)', () => {
  assert.equal(crc32(enc('IEND')), 0xae426082);
});

test('PNG: shows text keys + eXIf GPS; strip keeps colour/image chunks byte-identical', () => {
  const keep = [chunk('iCCP', cat(enc('icc\0\0'), new Uint8Array([1, 2, 3]))), chunk('gAMA', new Uint8Array([0, 0, 0xb1, 0x8f])), chunk('pHYs', new Uint8Array(9)), chunk('sRGB', new Uint8Array([0]))];
  const src = cat(PNG_SIG, IHDR, ...keep, chunk('eXIf', PHONE(false)), chunk('tEXt', enc('Author\0Jane Doe')), chunk('zTXt', cat(enc('Comment\0\0'), new Uint8Array([0x78, 0x9c, 3, 0, 0, 0, 0, 1]))), chunk('iTXt', enc('Description\0\0\0en\0\0hello')), chunk('tIME', new Uint8Array([7, 232, 5, 12, 14, 3, 22])), IDAT, chunk('tEXt', enc('Author\0dup')), IEND);
  const r = inspect(src);
  assert.deepEqual(r.textKeys, ['Author', 'Comment', 'Description']);
  assert.ok(r.gps.hasCoords && r.modifiedTime && r.icc);
  const s = summarize(r);
  assert.equal(s[0].kind, 'location');
  assert.equal(s.find((x) => x.label === 'Text fields').value, 'Author, Comment, Description');

  const out = strip(src);
  const types = pngChunks(out).map((c) => c.type);
  assert.deepEqual(types, ['IHDR', 'iCCP', 'gAMA', 'pHYs', 'sRGB', 'eXIf', 'IDAT', 'IEND']);
  for (const c of [IHDR, ...keep, IDAT, IEND]) assert.ok(has(out, c), 'chunk kept byte-identical');
  assert.ok(!has(out, 'Jane') && !has(out, 'Apple') && !has(out, 'tIME'));
  const r2 = inspect(out);
  assert.equal(r2.gps, null); assert.equal(r2.orientation, 6); assert.deepEqual(r2.textKeys, []);
  // Every chunk CRC in the output is valid.
  for (const c of pngChunks(out)) assert.equal(new DataView(out.buffer, out.byteOffset).getUint32(c.end - 4), crc32(out, c.start + 4, c.end - 4));
});

test('PNG: eXIf without rotation is dropped entirely; truncated PNG errors', () => {
  const src = cat(PNG_SIG, IHDR, chunk('eXIf', tiff({ ifd0: [S(0x0112, 1), A(0x0110, 'X100')] })), IDAT, IEND);
  assert.deepEqual(pngChunks(strip(src)).map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  assert.throws(() => strip(src.subarray(0, src.length - 12)), MetadataError);
});

// ---------------------------------------------------------------------------
// WebP
function riff(chunks) {
  const body = cat(enc('WEBP'), ...chunks.map(([t, data]) => { const h = new Uint8Array(8); h.set(enc(t)); new DataView(h.buffer).setUint32(4, data.length, true); return cat(h, data, data.length & 1 ? new Uint8Array(1) : new Uint8Array()); }));
  const h = new Uint8Array(8); h.set(enc('RIFF')); new DataView(h.buffer).setUint32(4, body.length, true);
  return cat(h, body);
}
const VP8X = (flags) => new Uint8Array([flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const VP8 = new Uint8Array([1, 2, 3, 4, 5, 6, 7]); // odd length -> padded

test('WebP: finds EXIF GPS + XMP; strip clears flags, keeps ICC and image, fixes RIFF size', () => {
  const src = riff([['VP8X', VP8X(0x20 | 0x08 | 0x04)], ['ICCP', enc('icc!')], ['VP8 ', VP8], ['EXIF', cat(enc('Exif\0\0'), PHONE(true))], ['XMP ', enc('<x:xmpmeta exif:GPSLatitude="1,2N"/>')]]);
  const r = inspect(src);
  assert.ok(r.gps.hasCoords && r.xmp && r.icc && r.orientation === 6);
  const out = strip(src);
  const d = new DataView(out.buffer, out.byteOffset);
  assert.equal(d.getUint32(4, true), out.length - 8, 'RIFF size');
  const cs = webpChunks(out);
  assert.deepEqual(cs.map((c) => c.type), ['VP8X', 'ICCP', 'VP8 ', 'EXIF']);
  assert.equal(out[cs[0].data], 0x20 | 0x08, 'XMP flag cleared, EXIF flag kept for orientation');
  assert.ok(has(out, cat(enc('VP8 '), new Uint8Array([7, 0, 0, 0]), VP8, new Uint8Array(1))), 'image chunk byte-identical');
  const r2 = inspect(out);
  assert.equal(r2.gps, null); assert.equal(r2.orientation, 6); assert.equal(r2.xmp, false);
  assert.ok(!has(out, 'Apple'));
});

test('WebP: upright photo -> EXIF chunk and flag removed', () => {
  const src = riff([['VP8X', VP8X(0x08 | 0x04)], ['VP8 ', VP8], ['EXIF', tiff({ ifd0: [A(0x010f, 'Canon')] })], ['XMP ', enc('<x/>')]]);
  const out = strip(src);
  const cs = webpChunks(out);
  assert.deepEqual(cs.map((c) => c.type), ['VP8X', 'VP8 ']);
  assert.equal(out[cs[0].data], 0);
  assert.equal(new DataView(out.buffer).getUint32(4, true), out.length - 8);
});

test('orientationTiff round-trips every orientation', () => {
  for (let o = 1; o <= 8; o++) assert.equal(parseExif(orientationTiff(o)).orientation, o);
});

test('unsupported formats', () => {
  assert.throws(() => inspect(enc('GIF89a-----------')), /Unsupported/);
  assert.throws(() => inspect(cat(new Uint8Array([0, 0, 0, 24]), enc('ftypheic'), new Uint8Array(4), enc('mif1heic'))), /HEIC/);
});
