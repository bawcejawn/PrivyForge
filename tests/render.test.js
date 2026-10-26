import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relatedTools, applyAffiliates, normalizeMeta, loadTools } from '../scripts/render-data.mjs';

const tools = loadTools();

test('relatedTools: same category first, never itself, skips disabled', () => {
  const r = relatedTools(tools, '/merge-pdf/');
  assert.equal(r.length, 4);
  assert.ok(!r.some((t) => t.slug === 'merge-pdf'));
  assert.equal(r[0].category, 'PDF');
  const off = tools.map((t) => (t.slug === 'split-pdf' ? { ...t, enabled: false } : t));
  assert.ok(!relatedTools(off, '/merge-pdf/').some((t) => t.slug === 'split-pdf'));
  assert.deepEqual(relatedTools(tools, '/not-a-tool/'), []);
});

test('applyAffiliates: fills https links, drops empty/unsafe ones and empty boxes', () => {
  const html = '<aside class="affiliate"><ul><li><a href="#AFFILIATE_A" rel="sponsored">A</a> x</li><li><a href="#AFFILIATE_B" rel="sponsored">B</a></li></ul></aside>';
  const out = applyAffiliates(html, { affiliates: { A: { url: 'https://a.example/?r=1' }, B: { url: 'javascript:alert(1)' } } });
  assert.match(out, /href="https:\/\/a\.example\/\?r=1"/);
  assert.doesNotMatch(out, /javascript|#AFFILIATE_B/);
  assert.equal(applyAffiliates(html, { affiliates: {} }), '');
});

test('normalizeMeta: adds missing tags and one breadcrumb, keeps page-defined ones', () => {
  const page = '<html><head><title>Merge PDF | PrivyForge</title><meta name="description" content="Combine PDFs." /><meta property="og:title" content="Custom" /></head><body><h1>Merge PDF files</h1></body></html>';
  const out = normalizeMeta(page, '/merge-pdf/');
  for (const k of ['og:url', 'og:description', 'og:image', 'twitter:title', 'twitter:description', 'twitter:image']) assert.match(out, new RegExp(`"${k}"`));
  assert.match(out, /rel="canonical" href="\{\{SITE_URL\}\}\/merge-pdf\/"/);
  assert.match(out, /name="twitter:title" content="Custom"/); // reuses the page's og:title
  assert.equal((out.match(/BreadcrumbList/g) || []).length, 1);
  assert.match(out, /og\/merge-pdf\.png/); // per-page share image exists
  const noindex = normalizeMeta('<head><title>x</title><meta name="robots" content="noindex" /></head>', '/my/');
  assert.doesNotMatch(noindex, /canonical|BreadcrumbList/);
});
