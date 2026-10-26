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
  const hub = { Image: '/image-tools/', PDF: '/pdf-tools/', Finance: '/money-tools/', 'Save money': '/money-tools/' };
  return Object.entries(cats).map(([c, list]) => `<div><h4>${hub[c] ? `<a href="${hub[c]}" style="color:inherit;padding:0">${esc(c)}</a>` : esc(c)}</h4>${list.map((t) => `<a href="${esc(t.href)}">${esc(t.title)}</a>`).join('')}</div>`).join('\n');
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

// ---------------------------------------------------------------------------
// SEO normalizer: every page ends up with canonical, og:title/description/url/image,
// twitter:title/description/image and (except home/utility pages) BreadcrumbList JSON-LD.
// Pages can set any of these themselves; we only fill what's missing.
import { existsSync } from 'node:fs';

const attr = (html, re) => (html.match(re) || [])[1];
const hasMeta = (html, key) => new RegExp(`<meta\\s+(?:property|name)="${key}"`, 'i').test(html);
const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const unescapeHtml = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Image for a page: public/og/<slug>.png if it exists, else the default. */
export function ogImageFor(slug) {
  return slug && existsSync(resolve(root, 'public/og', `${slug}.png`)) ? `{{SITE_URL}}/og/${slug}.png` : '{{SITE_URL}}/og.png';
}

/**
 * @param html  page HTML (after partial includes, before {{SITE_URL}} substitution)
 * @param pagePath  e.g. '/merge-pdf/' ('/' for home)
 */
export function normalizeMeta(html, pagePath) {
  const tags = [];
  const title = attr(html, /<title>([\s\S]*?)<\/title>/i);
  const desc = attr(html, /<meta\s+name="description"\s+content="([^"]*)"/i);
  const noindex = /<meta\s+name="robots"\s+content="[^"]*noindex/i.test(html);
  let canonical = attr(html, /<link\s+rel="canonical"\s+href="([^"]*)"/i);
  if (!canonical && !noindex) { canonical = `{{SITE_URL}}${pagePath}`; tags.push(`<link rel="canonical" href="${canonical}" />`); }
  const ogTitle = attr(html, /<meta\s+property="og:title"\s+content="([^"]*)"/i) || title;
  const ogDesc = attr(html, /<meta\s+property="og:description"\s+content="([^"]*)"/i) || desc;
  const slug = pagePath.replace(/^\/|\/$/g, '').split('/').pop();
  const ogImage = attr(html, /<meta\s+property="og:image"\s+content="([^"]*)"/i) || ogImageFor(slug);
  if (!hasMeta(html, 'og:title') && ogTitle) tags.push(`<meta property="og:title" content="${ogTitle}" />`);
  if (!hasMeta(html, 'og:description') && ogDesc) tags.push(`<meta property="og:description" content="${ogDesc}" />`);
  if (!hasMeta(html, 'og:url') && canonical) tags.push(`<meta property="og:url" content="${canonical}" />`);
  if (!hasMeta(html, 'og:image')) tags.push(`<meta property="og:image" content="${ogImage}" />`, '<meta property="og:image:width" content="1200" />', '<meta property="og:image:height" content="630" />');
  if (!hasMeta(html, 'og:image:alt') && ogTitle) tags.push(`<meta property="og:image:alt" content="${ogTitle}" />`);
  if (!hasMeta(html, 'twitter:title') && ogTitle) tags.push(`<meta name="twitter:title" content="${ogTitle}" />`);
  if (!hasMeta(html, 'twitter:description') && ogDesc) tags.push(`<meta name="twitter:description" content="${ogDesc}" />`);
  if (!hasMeta(html, 'twitter:image')) tags.push(`<meta name="twitter:image" content="${ogImage}" />`);

  // BreadcrumbList for inner pages that don't define one (home, 404 and noindex pages are skipped).
  if (pagePath !== '/' && !noindex && !/BreadcrumbList/.test(html)) {
    const h1 = unescapeHtml(stripTags(attr(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) || unescapeHtml(title).split(/\s[|—]\s/)[0]));
    const items = [{ name: 'Home', item: '{{SITE_URL}}/' }];
    if (pagePath.startsWith('/blog/') && pagePath !== '/blog/') items.push({ name: 'Guides', item: '{{SITE_URL}}/blog/' });
    items.push({ name: h1, item: canonical || `{{SITE_URL}}${pagePath}` });
    const ld = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map((x, i) => ({ '@type': 'ListItem', position: i + 1, ...x })) };
    tags.push(`<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`);
  }
  return tags.length ? html.replace(/<\/head>/i, `  ${tags.join('\n  ')}\n</head>`) : html;
}

// ---------------------------------------------------------------------------
// Related tools: same category first (in tools.json order), then neighbouring categories.
const NEIGHBOURS = { Image: ['PDF', 'Utility'], PDF: ['Image', 'Utility'], Utility: ['PDF', 'Image'], Finance: ['Save money'], 'Save money': ['Finance'] };
const pathOf = (href) => href.split('?')[0];

export function relatedTools(tools, slugOrPath, n = 4) {
  const on = tools.filter((t) => t.enabled !== false);
  const self = on.find((t) => t.slug === slugOrPath || t.href === slugOrPath);
  if (!self) return [];
  const others = on.filter((t) => t.slug !== self.slug && pathOf(t.href) !== pathOf(self.href));
  const order = [self.category, ...(NEIGHBOURS[self.category] || [])];
  const ranked = [...others].sort((a, b) => {
    const ia = order.indexOf(a.category), ib = order.indexOf(b.category);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || (b.featured ? 1 : 0) - (a.featured ? 1 : 0);
  });
  return ranked.slice(0, n);
}

export function relatedBlock(tools, pagePath) {
  const list = relatedTools(tools, pagePath);
  if (!list.length) return '';
  return `<section class="related" aria-labelledby="related-h"><h2 id="related-h">Related tools</h2><div class="tool-grid">${list.map((t) => `<a class="tool-card" href="${esc(t.href)}"><em>${esc(t.category)}</em><b>${esc(t.title)}</b><span>${esc(t.blurb)}</span></a>`).join('')}</div></section>`;
}

// ---------------------------------------------------------------------------
// Category hubs: <!-- @tools-grid:PDF --> or <!-- @tools-grid:Finance,Save money -->
export const HUBS = { Image: '/image-tools/', PDF: '/pdf-tools/', Finance: '/money-tools/', 'Save money': '/money-tools/' };

export function categoryGrids(html, tools) {
  return html.replace(/<!--\s*@tools-grid:([^>]+?)\s*-->/g, (_, cats) => {
    const want = cats.split(',').map((c) => c.trim());
    const list = tools.filter((t) => t.enabled !== false && want.includes(t.category));
    const ld = { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: list.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.title, url: `{{SITE_URL}}${t.href}` })) };
    return `${toolGrid(list)}\n<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
  });
}
