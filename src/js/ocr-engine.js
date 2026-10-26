// Shared tesseract.js wrapper for Image to Text and PDF to Text.
// Privacy: the worker script, the WebAssembly engine and the English data are all served from
// this site's own origin (see the ocrAssets plugin in vite.config.js). workerPath, corePath and
// langPath are always set, so tesseract.js never falls back to its default CDN.
import { OCR } from 'virtual:ocr-assets';
import { progressLabel, ocrScale, cleanText } from './lib/ocr-text.js';

const abs = (p) => new URL(import.meta.env.BASE_URL + p, location.href).href;

/** Approximate first-use download (worker + engine + English data), in bytes. */
export const OCR_DOWNLOAD_BYTES = OCR.bytes;
/** e.g. "7.0 MB" (decimal megabytes, as download sizes are usually quoted). */
export const OCR_DOWNLOAD_LABEL = `${(OCR.bytes / 1e6).toFixed(1)} MB`;

const SEEN_KEY = 'pf-ocr-ready';
export function ocrCachedBefore() { try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; } }
function markCached() { try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ } }

let workerP = null, idleTimer = null, onLog = null;

function getWorker() {
  clearTimeout(idleTimer);
  return (workerP ||= (async () => {
    const { createWorker } = (await import('tesseract.js/dist/tesseract.esm.min.js')).default;
    return createWorker('eng', 1 /* OEM.LSTM_ONLY */, {
      workerPath: abs(OCR.worker),
      corePath: abs(OCR.core), // a directory: tesseract.js picks relaxed-SIMD / SIMD / plain
      langPath: abs(OCR.lang),
      workerBlobURL: false, // a same-origin worker URL (no blob:), friendlier to strict CSP
      cacheMethod: 'none', // the service worker caches /ocr/ files; no second copy in IndexedDB
      gzip: true,
      logger: (m) => onLog?.(m),
      errorHandler: (e) => console.error(e),
    });
  })().catch((e) => { workerP = null; throw e; }));
}

// Free the ~100 MB engine when the tab has been idle for a while; it reloads from cache.
function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const p = workerP; workerP = null;
    try { (await p)?.terminate(); } catch { /* already gone */ }
  }, 120_000);
}

let queue = Promise.resolve();

/**
 * OCR one image source (canvas, Blob or File) in the tesseract.js Web Worker.
 * onProgress({ label, progress 0..1 }). Jobs run one at a time.
 */
export function recognize(source, onProgress = () => {}) {
  const job = queue.then(async () => {
    onLog = (m) => onProgress({ label: progressLabel(m.status), progress: m.progress || 0, status: m.status });
    try {
      onProgress({ label: 'Loading OCR engine', progress: 0 });
      const worker = await getWorker();
      const { data } = await worker.recognize(source);
      markCached();
      return { text: cleanText(data.text), confidence: Math.round(data.confidence || 0) };
    } finally { onLog = null; scheduleIdle(); }
  });
  queue = job.catch(() => {});
  return job;
}

/**
 * Decode any image the browser can open (applies EXIF rotation), scale it to a size Tesseract
 * reads well, and return a white-backed canvas. Throws a friendly error if the browser can't
 * decode the format (for example HEIC outside Safari).
 */
export async function imageToCanvas(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('Your browser can’t open this image format.'); }
  const s = ocrScale(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * s));
  canvas.height = Math.max(1, Math.round(bmp.height * s));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas;
}
