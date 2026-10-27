// Organize PDF: page-list logic (ordering, rotation, deletion, save plan). No DOM.
// `assemble` turns a plan into a PDF with pdf-lib. Unit-tested in tests/organize.test.js.
import { PDFDocument, degrees } from 'pdf-lib';
import { parseRanges } from '../util.js';
import { normRotation } from './pdf-sign.js';

export { normRotation };

/**
 * Page entries for one source file. `number` is the label shown on the card and used by the
 * "delete pages" box: pages are numbered 1..N across all loaded files, in load order.
 */
export function makePages(count, src = 0, firstNumber = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${src}:${i}`, src, index: i, number: firstNumber + i, rotate: 0, deleted: false,
  }));
}

/** Add a quarter turn (+90 = clockwise, −90 = counter-clockwise) to a page's user rotation. */
export const rotatePage = (page, delta) => { page.rotate = normRotation(page.rotate + delta); return page; };

/** Final /Rotate value: the page's existing rotation plus the user's, as 0/90/180/270. */
export const finalRotation = (existing, added) => normRotation(normRotation(existing) + normRotation(added));

/** Move the item at `from` to position `to` (both clamped). Returns the same array. */
export function movePage(pages, from, to) {
  if (from < 0 || from >= pages.length) return pages;
  to = Math.max(0, Math.min(pages.length - 1, to));
  if (to !== from) pages.splice(to, 0, pages.splice(from, 1)[0]);
  return pages;
}

/**
 * Parse a delete box like "3-5, 9" or "10-" into a sorted array of page numbers (1-based),
 * using the same syntax as Split PDF. Returns null when the input is empty or invalid.
 */
export function parsePageNumbers(str, total) {
  // A bare "-" means "every page" to the shared parser; too easy a slip for a delete box.
  if (String(str ?? '').split(',').some((s) => s.trim() === '-')) return null;
  const groups = parseRanges(String(str ?? ''), total);
  if (!groups) return null;
  return [...new Set(groups.flat().map((i) => i + 1))].sort((a, b) => a - b);
}

/** Mark the pages whose card number is in `numbers` as deleted. Returns how many changed. */
export function deleteNumbers(pages, numbers) {
  const want = new Set(numbers); let n = 0;
  for (const p of pages) if (want.has(p.number) && !p.deleted) { p.deleted = true; n++; }
  return n;
}

/** Back to the original order, no rotation, nothing deleted. */
export function resetPages(pages) {
  pages.sort((a, b) => a.number - b.number);
  for (const p of pages) { p.rotate = 0; p.deleted = false; }
  return pages;
}

/** The save plan: kept pages in display order, each with the quarter turns to add. */
export const buildPlan = (pages) => pages.filter((p) => !p.deleted).map(({ src, index, rotate }) => ({ src, index, rotate: normRotation(rotate) }));

/** Pages to copy from each source, ascending and de-duplicated: { [src]: [index, ...] }. */
export function sourceIndices(plan) {
  const out = {};
  for (const { src, index } of plan) (out[src] ||= new Set()).add(index);
  for (const k of Object.keys(out)) out[k] = [...out[k]].sort((a, b) => a - b);
  return out;
}

/** Counts for the status line. `changed` is false when saving would reproduce the input. */
export function summarize(pages) {
  const kept = pages.filter((p) => !p.deleted);
  const deleted = pages.length - kept.length;
  const rotated = kept.filter((p) => normRotation(p.rotate) !== 0).length;
  const sources = new Set(pages.map((p) => p.src)).size;
  const moved = pages.some((p, i) => i > 0 && p.number < pages[i - 1].number);
  return { total: pages.length, kept: kept.length, deleted, rotated, moved, changed: deleted > 0 || rotated > 0 || moved || sources > 1 };
}

/**
 * Write the plan into a new PDF with pdf-lib. `sources` are loaded PDFDocuments, indexed by
 * `src`. Pages are copied as-is (content streams, fonts and images untouched); only /Rotate
 * is set. Nothing is rendered or re-compressed.
 */
export async function assemble(sources, plan) {
  const out = await PDFDocument.create();
  const copied = {};
  for (const [src, idx] of Object.entries(sourceIndices(plan))) {
    const pages = await out.copyPages(sources[src], idx);
    copied[src] = new Map(idx.map((i, k) => [i, pages[k]]));
  }
  for (const { src, index, rotate } of plan) {
    const page = copied[src].get(index);
    page.setRotation(degrees(finalRotation(page.getRotation().angle, rotate)));
    out.addPage(page);
  }
  return out;
}
