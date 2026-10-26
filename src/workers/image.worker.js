// Image compression worker. Everything happens in this thread, in memory. No network calls.
// Codecs are the same WebAssembly builds Google's Squoosh uses (MozJPEG, libwebp, libavif, OxiPNG).
import UPNG from 'upng-js';
import { outputSize } from '../js/lib/resize.js';
import { searchTargetSize } from '../js/lib/target-size.js';

const codecs = {};
const load = (name) => (codecs[name] ||= {
  jpeg: () => import('@jsquash/jpeg/encode.js'),
  webp: () => import('@jsquash/webp/encode.js'),
  avif: () => import('@jsquash/avif/encode.js'),
  oxipng: () => import('@jsquash/oxipng/optimise.js'),
}[name]());

const MIME = { jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', png: 'image/png' };
const EXT = { jpeg: 'jpg', webp: 'webp', avif: 'avif', png: 'png' };

function pickFormat(requested, inputType) {
  if (requested !== 'auto') return requested;
  if (inputType === 'image/jpeg') return 'jpeg';
  if (inputType === 'image/png') return 'png';
  if (inputType === 'image/webp') return 'webp';
  if (inputType === 'image/avif') return 'avif';
  // We can't write HEIC; "keep original" for an iPhone photo means a photo format that opens everywhere.
  if (/^image\/hei[cf]/.test(inputType)) return 'jpeg';
  return 'webp'; // gif/bmp etc. -> modern default
}

async function openBitmap({ buffer, bitmap, type }) {
  // HEIC in browsers without a native decoder arrives already decoded (libheif, rotation applied).
  if (bitmap) return bitmap;
  // createImageBitmap applies EXIF orientation; re-encoding strips EXIF (incl. GPS location).
  // Safari also decodes HEIC/HEIF here natively.
  return createImageBitmap(new Blob([buffer], { type }), { imageOrientation: 'from-image' });
}

function draw(bmp, w, h) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

async function decode(job, opts) {
  const bmp = await openBitmap(job);
  const size = outputSize(bmp.width, bmp.height, { maxWidth: opts.maxWidth, maxHeight: opts.maxHeight, fit: opts.fit, allowUpscale: opts.allowUpscale });
  const imageData = draw(bmp, size.width, size.height);
  bmp.close();
  return { imageData, resized: size.changed };
}

function hasAlpha(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

async function encode(format, imageData, quality) {
  switch (format) {
    case 'jpeg': {
      // JPEG has no alpha: flatten transparent pixels onto white instead of black.
      const d = imageData.data;
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3] / 255;
        if (a < 1) { d[i] = d[i] * a + 255 * (1 - a); d[i + 1] = d[i + 1] * a + 255 * (1 - a); d[i + 2] = d[i + 2] * a + 255 * (1 - a); d[i + 3] = 255; }
      }
      return (await load('jpeg')).default(imageData, { quality, progressive: true });
    }
    case 'webp': return (await load('webp')).default(imageData, { quality, method: 4 });
    case 'avif': return (await load('avif')).default(imageData, { quality: Math.round(quality * 0.85), speed: 7 });
    case 'png': {
      // TinyPNG-style: lossy palette quantization (<=256 colors) then lossless OxiPNG pass.
      // quality >= 95 => lossless only.
      const { width, height, data } = imageData;
      const colors = quality >= 95 ? 0 : 256;
      const png = UPNG.encode([data.buffer], width, height, colors);
      const { default: optimise } = await load('oxipng');
      return optimise(png, { level: 2, interlace: false, optimiseAlpha: true });
    }
  }
  throw new Error(`Unsupported format ${format}`);
}

// "Under N KB": decode once, then let the search driver ask for (quality, scale) encodes.
async function toTarget(job, opts, format) {
  const bmp = await openBitmap(job);
  const base = outputSize(bmp.width, bmp.height, { maxWidth: opts.maxWidth, maxHeight: opts.maxHeight });
  const frames = new Map(); // scale -> ImageData (reused across qualities)
  let flattenedAlpha = false;
  const frame = (scale) => {
    if (!frames.has(scale)) {
      frames.clear(); // the driver only ever moves to smaller scales
      const w = Math.max(1, Math.round(base.width * scale)), h = Math.max(1, Math.round(base.height * scale));
      const data = draw(bmp, w, h);
      if (format === 'jpeg' && !flattenedAlpha) flattenedAlpha = hasAlpha(data.data);
      frames.set(scale, data);
    }
    return frames.get(scale);
  };
  try {
    const search = await searchTargetSize({
      target: opts.targetBytes, width: base.width, height: base.height,
      encode: async (quality, scale) => {
        const img = frame(scale);
        const bytes = await encode(format, img, quality);
        return { size: bytes.byteLength, bytes, width: img.width, height: img.height };
      },
    });
    const r = search.result;
    return { out: r.bytes, width: r.width, height: r.height, flattenedAlpha, target: { ok: search.ok, quality: search.quality, attempts: search.attempts, bytes: opts.targetBytes } };
  } finally { bmp.close(); }
}

self.onmessage = async ({ data: job }) => {
  const { id, buffer, bitmap, type, opts } = job;
  try {
    const format = pickFormat(opts.format, type);
    if (opts.targetBytes > 0) {
      if (format !== 'jpeg' && format !== 'webp') throw new Error('Target size needs JPEG or WebP output');
      const r = await toTarget(job, opts, format);
      self.postMessage({ id, ok: true, buffer: r.out, mime: MIME[format], ext: EXT[format], width: r.width, height: r.height, keptOriginal: false, flattenedAlpha: r.flattenedAlpha, target: r.target }, [r.out]);
      return;
    }
    const { imageData, resized } = await decode(job, opts);
    const width = imageData.width, height = imageData.height;
    const alpha = format === 'jpeg' && hasAlpha(imageData.data);
    let out = await encode(format, imageData, opts.quality);
    let keptOriginal = false;
    // Never hand back a bigger file than the user gave us for a same-format, same-size job.
    if (buffer && !resized && MIME[format] === type && out.byteLength >= buffer.byteLength) {
      out = buffer; keptOriginal = true;
    }
    self.postMessage({ id, ok: true, buffer: out, mime: MIME[format], ext: EXT[format], width, height, keptOriginal, flattenedAlpha: alpha }, [out]);
  } catch (err) {
    bitmap?.close();
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
