// Image compression worker. Everything happens in this thread, in memory. No network calls.
// Codecs are the same WebAssembly builds Google's Squoosh uses (MozJPEG, libwebp, libavif, OxiPNG).
import UPNG from 'upng-js';

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
  return 'webp'; // gif/bmp/heic-in-safari etc. -> modern default
}

async function decode(buffer, type, maxW, maxH) {
  // createImageBitmap applies EXIF orientation; re-encoding strips EXIF (incl. GPS location).
  const bmp = await createImageBitmap(new Blob([buffer], { type }), { imageOrientation: 'from-image' });
  let w = bmp.width, h = bmp.height;
  const scale = Math.min(1, maxW ? maxW / w : 1, maxH ? maxH / h : 1);
  w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return { imageData: ctx.getImageData(0, 0, w, h), resized: scale < 1 };
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

self.onmessage = async ({ data: job }) => {
  const { id, buffer, type, opts } = job;
  try {
    const format = pickFormat(opts.format, type);
    const { imageData, resized } = await decode(buffer, type, opts.maxWidth, opts.maxHeight);
    const width = imageData.width, height = imageData.height;
    const alpha = format === 'jpeg' && hasAlpha(imageData.data);
    let out = await encode(format, imageData, opts.quality);
    let keptOriginal = false;
    // Never hand back a bigger file than the user gave us for a same-format, same-size job.
    if (!resized && MIME[format] === type && out.byteLength >= buffer.byteLength) {
      out = buffer; keptOriginal = true;
    }
    self.postMessage({ id, ok: true, buffer: out, mime: MIME[format], ext: EXT[format], width, height, keptOriginal, flattenedAlpha: alpha }, [out]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
