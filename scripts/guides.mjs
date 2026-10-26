// Generates /blog/<slug>/index.html and /blog/index.html from content/guides/*.md.
// Runs before `vite build` / `vite dev`. Guides are written in /admin/ → Guides (or by hand).
//
// Front matter (between --- lines):
//   title: How to compress a PDF without uploading it
//   description: one sentence for Google (<=155 chars)
//   date: 2026-10-23
//   tool: /compress-pdf/        (optional: adds a call-to-action card)
//   draft: true                 (optional: skipped until set to false)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { marked } from 'marked';
import { parseGuide, slugify, titleTag } from '../src/js/lib/guide-format.js';
import { ogImageFor } from './render-data.mjs';

const root = resolve(import.meta.dirname, '..');
const src = join(root, 'content/guides');
const out = join(root, 'blog');
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export { parseGuide, slugify };

// Article + BreadcrumbList JSON-LD. '<' escaped so text can't close the script tag.
function ldJson(meta, slug) {
  const url = `{{SITE_URL}}/blog/${slug}/`;
  const graph = [
    { '@type': 'Article', headline: meta.title, description: meta.description, image: ogImageFor(slug), datePublished: meta.date, dateModified: meta.updated || meta.date,
      author: { '@type': 'Organization', name: 'PrivyForge', url: '{{SITE_URL}}/' }, publisher: { '@type': 'Organization', name: 'PrivyForge', logo: { '@type': 'ImageObject', url: '{{SITE_URL}}/icon-512.png' } }, mainEntityOfPage: url },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: '{{SITE_URL}}/' },
      { '@type': 'ListItem', position: 2, name: 'Guides', item: '{{SITE_URL}}/blog/' },
      { '@type': 'ListItem', position: 3, name: meta.title, item: url }] },
  ];
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
}

function page(meta, html, slug) {
  const cta = meta.tool ? `<div class="tool-grid"><a class="tool-card" href="${esc(meta.tool)}"><b>Try the free tool →</b><span>Private, unlimited, nothing uploaded.</span></a></div>` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <!-- @include head -->
  <!-- GENERATED from content/guides/${slug}.md — edit that file, not this one. -->
  <title>${esc(titleTag(meta))}</title>
  <meta name="description" content="${esc(meta.description)}" />
  <link rel="canonical" href="{{SITE_URL}}/blog/${slug}/" />
  <meta property="og:type" content="article" />
  <meta property="og:image" content="${ogImageFor(slug)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="article:published_time" content="${esc(meta.date || '')}" />
  <meta property="og:title" content="${esc(meta.seoTitle || meta.title)}" />
  <meta property="og:description" content="${esc(meta.description)}" />
  <script type="application/ld+json">
  ${ldJson(meta, slug)}
  </script>
</head>
<body>
  <!-- @include header -->
  <main class="wrap narrow content">
    <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/blog/">Guides</a> › ${esc(meta.title)}</nav>
    <h1>${esc(meta.title)}</h1>
    ${meta.description ? `<p class="lede">${esc(meta.description)}</p>` : ''}
    ${html}
    ${cta}
    <!-- @include affiliate-${/pdf/.test(meta.tool || '') ? 'pdf' : /image/.test(meta.tool || '') ? 'image' : 'finance'} -->
  </main>
  <!-- @include footer -->
</body>
</html>
`;
}

export function buildGuides() {
  if (existsSync(out)) rmSync(out, { recursive: true });
  mkdirSync(out, { recursive: true });
  const files = existsSync(src) ? readdirSync(src).filter((f) => f.endsWith('.md')) : [];
  const list = [];
  for (const f of files) {
    const { meta, body } = parseGuide(readFileSync(join(src, f), 'utf8'));
    if (String(meta.draft) === 'true' || !meta.title) continue;
    const slug = slugify(f.replace(/\.md$/, ''));
    // Insert the mid-article ad after the 2nd heading.
    let html = marked.parse(body, { gfm: true });
    let n = 0; html = html.replace(/<h2/g, (m) => (++n === 2 ? `<!-- @include ad-content -->\n<h2` : m));
    mkdirSync(join(out, slug), { recursive: true });
    if (!existsSync(join(root, 'public/og', `${slug}.png`))) console.warn(`guides: no share image for "${slug}" yet — run python scripts/make-images.py (using og.png meanwhile)`);
    writeFileSync(join(out, slug, 'index.html'), page(meta, html, slug));
    list.push({ ...meta, slug });
  }
  list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  writeFileSync(join(out, 'index.html'), `<!doctype html>
<html lang="en">
<head>
  <!-- @include head -->
  <!-- GENERATED from content/guides/*.md -->
  <title>Guides — Image, PDF &amp; Money How-Tos | PrivyForge</title>
  <meta name="description" content="Practical guides to compressing images and PDFs, saving money, and keeping your files and finances private." />
  <link rel="canonical" href="{{SITE_URL}}/blog/" />
</head>
<body>
  <!-- @include header -->
  <main class="wrap narrow content">
    <h1>Guides</h1>
    <div class="tool-grid">
${list.map((g) => `      <a class="tool-card" href="/blog/${g.slug}/"><em>${esc(g.date || '')}</em><b>${esc(g.title)}</b><span>${esc(g.description || '')}</span></a>`).join('\n')}
    </div>
  </main>
  <!-- @include footer -->
</body>
</html>
`);
  return list;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const list = buildGuides();
  console.log(`guides: ${list.length} published`);
}
