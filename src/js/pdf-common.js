// Shared browser helpers for the PDF tools (merge/split/compress, compress-to-size,
// image-to-PDF, PDF-to-JPG). Everything runs locally; nothing here touches the network
// except loading our own pdf.js worker file.
import { PDFDocument } from 'pdf-lib';
import { zipSync } from 'fflate';
import { renderSize } from './lib/pdf-layout.js';

let pdfjsP;
export async function pdfjs() {
  return (pdfjsP ||= (async () => {
    const lib = await import('pdfjs-dist');
    lib.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    return lib;
  })());
}

/** Open a PDF with pdf.js (for rendering). Caller must .destroy() it. */
export async function openForRender(bytes) {
  const lib = await pdfjs();
  return lib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
}

export async function loadPdf(bytes) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(e.message)) throw new Error('This PDF is password-protected. Remove the password first.');
    throw new Error('This file does not look like a valid PDF.');
  }
}

/** First-page thumbnail into a canvas (cosmetic; errors are ignored). */
export async function thumbnail(bytes, canvas) {
  try {
    const doc = await openForRender(bytes);
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const v = page.getViewport({ scale: 104 / Math.max(vp.width, vp.height) });
    canvas.width = v.width; canvas.height = v.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: v }).promise;
    doc.destroy();
  } catch { /* thumbnail is cosmetic */ }
}

/**
 * Render one pdf.js page onto `canvas` at `dpi` on a white background, capped to 16 MP
 * so mobile Safari doesn't refuse the canvas. Returns page size in points + pixel info.
 */
export async function renderPage(page, dpi, canvas) {
  const base = page.getViewport({ scale: 1 }); // PDF points
  const size = renderSize(base.width, base.height, dpi);
  const vp = page.getViewport({ scale: size.scale });
  canvas.width = size.width; canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { ptW: base.width, ptH: base.height, ...size };
}

export const canvasToJpeg = (canvas, quality) =>
  new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Your browser could not encode this image.'))), 'image/jpeg', quality));

/** Re-build a PDF with every page as a JPEG image at { dpi, quality }. */
export async function rasterize(bytes, { dpi, quality }, onPage = () => {}) {
  const src = await openForRender(bytes);
  const out = await PDFDocument.create();
  const canvas = document.createElement('canvas');
  try {
    for (let n = 1; n <= src.numPages; n++) {
      onPage(n, src.numPages);
      const page = await src.getPage(n);
      const r = await renderPage(page, dpi, canvas);
      const img = await out.embedJpg(await (await canvasToJpeg(canvas, quality)).arrayBuffer());
      out.addPage([r.ptW, r.ptH]).drawImage(img, { x: 0, y: 0, width: r.ptW, height: r.ptH });
      page.cleanup();
    }
  } finally {
    src.destroy();
    canvas.width = canvas.height = 0; // release memory early (Safari)
  }
  out.setProducer('PrivyForge (in-browser)'); out.setCreator('PrivyForge');
  return out.save({ useObjectStreams: true });
}

/** Lossless structural re-save (keeps text selectable). */
export async function resave(bytes) {
  const doc = await loadPdf(bytes);
  return doc.save({ useObjectStreams: true });
}

/** [[name, Uint8Array], ...] → uncompressed ZIP Blob (JPEG/PDF data doesn't deflate further). */
export const zipBlob = (entries) =>
  new Blob([zipSync(Object.fromEntries(entries.map(([n, b]) => [n, [b, { level: 0 }]])))], { type: 'application/zip' });

/**
 * Drag-to-reorder for rows in `list`. Keyboard users get Alt + ↑/↓.
 * `items` is the backing array; each item has `.row` (its <li>). Order is kept in sync.
 */
export function makeReorderable(list, items) {
  let dragItem = null;
  const sync = () => {
    const order = [...list.children];
    items.sort((a, b) => order.indexOf(a.row) - order.indexOf(b.row));
  };
  return function enable(li, item) {
    li.draggable = true; li.tabIndex = 0;
    li.addEventListener('dragstart', () => { dragItem = item; li.classList.add('dragging'); });
    li.addEventListener('dragend', () => { li.classList.remove('dragging'); dragItem = null; });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragItem || dragItem === item) return;
      const r = li.getBoundingClientRect();
      li[e.clientY > r.top + r.height / 2 ? 'after' : 'before'](dragItem.row);
      sync();
    });
    li.addEventListener('keydown', (e) => {
      if (!e.altKey) return;
      if (e.key === 'ArrowUp' && li.previousElementSibling) { e.preventDefault(); li.previousElementSibling.before(li); sync(); li.focus(); }
      if (e.key === 'ArrowDown' && li.nextElementSibling) { e.preventDefault(); li.nextElementSibling.after(li); sync(); li.focus(); }
    });
  };
}
