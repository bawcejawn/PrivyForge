// Pure text helpers for PDF to Text and Image to Text (no DOM, unit-tested in tests/ocr.test.js).

/**
 * Rebuild reading-order text from pdf.js `getTextContent().items`.
 * Items are { str, transform: [a, b, c, d, x, y], width, height, hasEOL }. PDF y grows upward.
 * Items whose baselines are within ~half a line height share a line; lines are sorted top to
 * bottom and items left to right. A space is inserted where the gap between two items is wider
 * than ~0.15 em (pdf.js often splits words into runs with no explicit space). A blank line
 * separates paragraphs when the vertical gap is clearly bigger than the usual line spacing.
 */
export function itemsToText(items) {
  const runs = [];
  for (const it of items || []) {
    if (!it || typeof it.str !== 'string' || !it.transform) continue;
    const [a, b, c, d, x, y] = it.transform;
    const size = Math.abs(it.height) || Math.hypot(c, d) || Math.hypot(a, b) || 10;
    if (!it.str.trim()) { if (it.str && runs.length) runs.push({ space: true, x, y, size, w: it.width || 0 }); continue; }
    runs.push({ str: it.str, x, y, size, w: it.width || 0 });
  }
  if (!runs.some((r) => !r.space)) return '';

  // Group into lines by baseline.
  const lines = [];
  for (const r of runs) {
    let line = lines.find((l) => Math.abs(l.y - r.y) <= Math.max(l.size, r.size) * 0.5);
    if (!line) { line = { y: r.y, size: r.size, runs: [] }; lines.push(line); }
    line.runs.push(r);
    line.size = Math.max(line.size, r.size);
  }
  lines.sort((p, q) => q.y - p.y);

  const textLines = lines.map((l) => {
    l.runs.sort((p, q) => p.x - q.x);
    let out = '', end = null;
    for (const r of l.runs) {
      if (r.space) { if (out && !out.endsWith(' ')) out += ' '; end = r.x + r.w; continue; }
      if (end !== null && out && !out.endsWith(' ') && !r.str.startsWith(' ') && r.x - end > r.size * 0.15) out += ' ';
      out += r.str;
      end = r.x + r.w;
    }
    return { y: l.y, size: l.size, text: out.replace(/[ \t]+/g, ' ').trim() };
  }).filter((l) => l.text);

  // Typical line spacing = median gap between consecutive lines.
  const gaps = [];
  for (let i = 1; i < textLines.length; i++) gaps.push(textLines[i - 1].y - textLines[i].y);
  const sorted = [...gaps].sort((p, q) => p - q);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

  let out = '';
  textLines.forEach((l, i) => {
    if (i > 0) {
      const gap = gaps[i - 1];
      const para = gap > Math.max(median * 1.6, l.size * 1.9);
      out += para ? '\n\n' : '\n';
    }
    out += l.text;
  });
  return out;
}

/** Letters and digits in a string (any script). */
export const meaningfulChars = (s) => (String(s || '').match(/[\p{L}\p{N}]/gu) || []).length;

/**
 * Does a page need OCR? True when its text layer has almost nothing readable: fewer than
 * `minChars` letters/digits (default 20 — a page number or a stray header doesn't count), or
 * when most of the "text" is unmapped glyphs (U+FFFD, private-use), which some scanners and
 * broken PDF exporters produce.
 */
export function needsOcr(text, { minChars = 20 } = {}) {
  const s = String(text || '');
  const good = meaningfulChars(s);
  if (good < minChars) return true;
  const junk = (s.match(/[�-]/g) || []).length;
  return junk > good;
}

const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };

/**
 * Tidy extracted or OCR'd text: Unix newlines, ligatures expanded, soft hyphens and
 * zero-width characters removed, non-breaking spaces made normal, trailing spaces trimmed,
 * runs of 3+ newlines collapsed to one blank line. Words are never changed.
 */
export function cleanText(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ﬀ-ﬆ]/g, (m) => LIGATURES[m] || m)
    .replace(/[­​-‍﻿]/g, '')
    .replace(/[   ]/g, ' ')
    .replace(/\f/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** "--- Page 3 ---" / "--- Page 3 (OCR) ---" */
export const pageHeader = (n, ocr = false) => `--- Page ${n}${ocr ? ' (OCR)' : ''} ---`;

/** Join [{ n, text, ocr }] into one document with page separators. */
export function joinPages(pages) {
  return pages.map((p) => `${pageHeader(p.n, p.ocr)}\n\n${p.text || '(no text found on this page)'}`).join('\n\n') + '\n';
}

/**
 * Scale factor for OCR input. Tesseract reads best when body text is roughly 20–40 px tall;
 * small screenshots get upscaled (up to 2×) and huge photos are scaled down so the longest
 * side is at most `max` px (keeps memory sane on phones).
 */
export function ocrScale(w, h, { min = 1600, max = 5000 } = {}) {
  const long = Math.max(w, h);
  if (!(long > 0)) return 1;
  if (long > max) return max / long;
  if (long < min) return Math.min(2, min / long);
  return 1;
}

/** Friendly label for tesseract.js logger statuses. */
export function progressLabel(status) {
  const s = String(status || '');
  if (/loading tesseract core/.test(s)) return 'Loading OCR engine';
  if (/language traineddata/.test(s)) return 'Loading English data';
  if (/initializ/.test(s)) return 'Starting OCR engine';
  if (/recognizing/.test(s)) return 'Reading text';
  return s ? s[0].toUpperCase() + s.slice(1) : 'Working';
}
