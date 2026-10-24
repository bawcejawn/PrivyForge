// Build-time rendering of site.json / tools.json into HTML. Used by vite.config.js.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
export const loadSite = () => JSON.parse(readFileSync(resolve(root, 'src/data/site.json'), 'utf8'));
export const loadTools = () => JSON.parse(readFileSync(resolve(root, 'src/data/tools.json'), 'utf8'));

export const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https:\/\//i.test(u || '') ? u : '');

export function toolGrid(tools) {
  const on = tools.filter((t) => t.enabled !== false);
  const sorted = [...on.filter((t) => t.featured), ...on.filter((t) => !t.featured)];
  return sorted.map((t) => `<a class="tool-card" href="${esc(t.href)}" data-tool="${esc(t.slug)}"><em>${esc(t.category)}</em><b>${esc(t.title)}</b><span>${esc(t.blurb)}</span></a>`).join('\n');
}

export function footerTools(tools) {
  const cats = {};
  for (const t of tools.filter((x) => x.enabled !== false)) (cats[t.category] ||= []).push(t);
  return Object.entries(cats).map(([c, list]) => `<div><h4>${esc(c)}</h4>${list.map((t) => `<a href="${esc(t.href)}">${esc(t.title)}</a>`).join('')}</div>`).join('\n');
}

/** Replace #AFFILIATE_KEY links with configured URLs; drop unset items and empty boxes. */
export function applyAffiliates(html, site) {
  let out = html.replace(/<li>\s*<a href="#AFFILIATE_([A-Z_]+)"([^>]*)>([\s\S]*?)<\/li>/g, (m, key, attrs, rest) => {
    const url = safeUrl(site.affiliates?.[key]?.url);
    return url ? `<li><a href="${esc(url)}"${attrs}>${rest}</li>` : '';
  });
  out = out.replace(/<aside class="affiliate">([\s\S]*?)<\/aside>/g, (m, inner) => (/<li>/.test(inner) ? m : ''));
  return out;
}

export function announcement(site) {
  return site.announcement ? `<div class="announce" role="status">${esc(site.announcement)}</div>` : '';
}
