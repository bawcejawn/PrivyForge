// Post-build: writes dist/sitemap.xml and dist/robots.txt from the pages actually built.
// lastmod = date of the last git commit touching the page's source (guides: front-matter
// `updated`/`date`). If git history is unavailable (shallow clone), lastmod is omitted rather
// than guessed — search engines ignore an untrustworthy lastmod anyway.
import { readdirSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SITE } from '../site.config.js';
import { parseGuide } from '../src/js/lib/guide-format.js';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
// Utility / personal pages that shouldn't compete in search.
const EXCLUDE = new Set(['/my/', '/support/', '/contact/', '/terms/']);

const git = (args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const shallow = git(['rev-parse', '--is-shallow-repository']) !== 'false';

function lastmod(path) {
  if (path.startsWith('/blog/') && path !== '/blog/') {
    const f = join(root, 'content/guides', `${path.split('/')[2]}.md`);
    if (existsSync(f)) { const { meta } = parseGuide(readFileSync(f, 'utf8')); return meta.updated || meta.date || ''; }
  }
  if (shallow) return '';
  const src = path === '/' ? 'index.html' : path === '/blog/' ? 'content/guides' : `${path.slice(1)}index.html`;
  return git(['log', '-1', '--format=%cs', '--', src]);
}

const urls = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'assets' && name !== 'og') walk(p); }
    else if (name === 'index.html') {
      const rel = relative(dist, dir);
      const path = `/${rel}${rel ? '/' : ''}`;
      if (EXCLUDE.has(path) || /<meta\s+name="robots"\s+content="[^"]*noindex/i.test(readFileSync(p, 'utf8'))) continue;
      urls.push(path);
    }
  }
})(dist);

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.sort().map((u) => { const d = lastmod(u); return `  <url><loc>${SITE.url}${u}</loc>${d ? `<lastmod>${d}</lastmod>` : ''}</url>`; }).join('\n')}
</urlset>
`;
writeFileSync(join(dist, 'sitemap.xml'), xml);
// robots.txt must live at the host root (Cloudflare serves dist/ at the root).
writeFileSync(join(dist, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE.url}/sitemap.xml\n`);
console.log(`sitemap.xml: ${urls.length} URLs${shallow ? ' (shallow git clone: lastmod only for guides)' : ''}`);
