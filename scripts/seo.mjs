// Post-build: writes dist/sitemap.xml and dist/robots.txt from the pages actually built.
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SITE } from '../site.config.js';

const dist = new URL('../dist/', import.meta.url).pathname;
const EXCLUDE = new Set(['/terms/', '/contact/', '/admin/', '/my/', '/support/']);
const PRIORITY = { '/': '1.0', '/compress-image/': '0.9', '/merge-pdf/': '0.9', '/compress-pdf/': '0.9', '/split-pdf/': '0.8' };

const urls = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'assets') walk(p); }
    else if (name === 'index.html') {
      const path = `/${relative(dist, dir)}${relative(dist, dir) ? '/' : ''}`;
      if (!EXCLUDE.has(path)) urls.push(path);
    }
  }
})(dist);

const today = new Date().toISOString().slice(0, 10);
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.sort().map((u) => `  <url><loc>${SITE.url}${u}</loc><lastmod>${today}</lastmod><priority>${PRIORITY[u] || '0.6'}</priority></url>`).join('\n')}
</urlset>
`;
writeFileSync(join(dist, 'sitemap.xml'), xml);
writeFileSync(join(dist, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /admin/\n\nSitemap: ${SITE.url}/sitemap.xml\n`);
console.log(`sitemap.xml: ${urls.length} URLs`);
