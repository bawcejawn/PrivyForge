import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { SITE } from './site.config.js';
import { loadSite, loadTools, toolGrid, footerTools, applyAffiliates, announcement, esc, normalizeMeta, relatedBlock, categoryGrids, syncFaqSchema } from './scripts/render-data.mjs';

const root = resolve(__dirname);

// Every folder containing an index.html becomes a page (multi-page static build).
// /admin/ is a local tool: served by `npm run dev`, never included in production builds.
const SKIP = ['node_modules', 'dist', 'dist-test', 'public', 'src', 'scripts', 'tests', 'content', '.git', '.github', 'admin'];
function findPages(dir, out = {}) {
  for (const name of readdirSync(dir)) {
    if (SKIP.includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) findPages(p, out);
    else if (name === 'index.html') out[relative(root, dir) || 'home'] = p;
  }
  return out;
}

// Tiny build-time templating: <!-- @include header --> and {{SITE_URL}} / {{SITE_NAME}}
function partials() {
  return {
    name: 'privyforge-partials',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        let out = html;
        for (let i = 0; i < 3; i++) {
          out = out.replace(/<!--\s*@include\s+([\w-]+)\s*-->/g, (_, n) =>
            readFileSync(resolve(root, 'src/partials', `${n}.html`), 'utf8'));
        }
        // Data-driven blocks (edited from /admin/): tool grid, footer tool columns, affiliates.
        const site = loadSite(), tools = loadTools();
        out = out
          .replace('<!-- @tools-grid -->', toolGrid(tools))
          .replace(/<!--\s*@tools-grid:[^>]+-->/g, (m) => categoryGrids(m, tools))
          .replace('<!-- @footer-tools -->', footerTools(tools))
          .replace('<!-- @announcement -->', announcement(site));
        out = applyAffiliates(out, site);
        const pagePath = ('/' + (ctx?.path || '/').replace(/^\//, '')).replace(/index\.html$/, '').replace(/404\.html$/, '/404/');
        const isTool = tools.some((t) => t.enabled !== false && t.href.split('?')[0] === pagePath);
        if (isTool && !out.includes('<!-- @related -->')) out = out.replace(/(\s*<aside class="affiliate">|\s*<\/article>)/, '\n      <!-- @related -->$1');
        out = out.replace('<!-- @related -->', isTool ? relatedBlock(tools, pagePath) : '');
        out = normalizeMeta(out, pagePath);
        out = syncFaqSchema(out);
        return out
          .replaceAll('{{SITE_URL}}', SITE.url)
          .replaceAll('{{SITE_NAME}}', SITE.name)
          .replaceAll('{{CONTACT_EMAIL}}', esc(site.contactEmail || ''))
          .replaceAll('{{YEAR}}', String(new Date().getFullYear()));
      },
    },
  };
}

// GitHub Pages project sites live under /<repo>/. Vite prefixes its own assets with `base`;
// this prefixes our hand-written internal links (href="/merge-pdf/") after Vite is done.
const BASE = process.env.BASE_PATH || '/';
function basePathLinks() {
  return {
    name: 'privyforge-base-links',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (BASE === '/') return html;
        return html.replace(/(\s(?:href|src|action)=")\/(?!\/)/g, (m, attr, off, s) =>
          s.startsWith(BASE, off + attr.length) ? m : `${attr}${BASE}`);
      },
    },
  };
}

// OCR (tesseract.js) assets are self-hosted under /ocr/, never fetched from a CDN. Paths carry
// the package versions so long-lived caches stay correct after an upgrade. They are copied out
// of node_modules at build time, served from node_modules in dev, and NOT precached (≈7 MB):
// the service worker caches them on first use (runtimeCaching below).
function ocrAssets() {
  const pkg = (p) => JSON.parse(readFileSync(resolve(root, 'node_modules', p, 'package.json'), 'utf8')).version;
  const tjs = `ocr/tesseract.js-${pkg('tesseract.js')}`;
  const core = `ocr/tesseract.js-core-${pkg('tesseract.js-core')}`;
  const lang = 'ocr/eng-4.0.0_best_int';
  // Only the LSTM cores are needed (we always use OEM 1, LSTM only); tesseract.js picks
  // relaxed-SIMD, SIMD or plain at runtime from a corePath directory.
  const files = {
    [`${tjs}/worker.min.js`]: 'tesseract.js/dist/worker.min.js',
    ...Object.fromEntries(['relaxedsimd-lstm', 'simd-lstm', 'lstm'].map((v) =>
      [`${core}/tesseract-core-${v}.wasm.js`, `tesseract.js-core/tesseract-core-${v}.wasm.js`])),
    [`${lang}/eng.traineddata.gz`]: '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
  };
  const src = (f) => resolve(root, 'node_modules', files[f]);
  const ID = 'virtual:ocr-assets';
  return {
    name: 'privyforge-ocr-assets',
    resolveId: (id) => (id === ID ? '\0' + ID : null),
    load: (id) => (id === '\0' + ID
      ? `export const OCR = ${JSON.stringify({ worker: `${tjs}/worker.min.js`, core, lang, bytes: statSync(src(`${core}/tesseract-core-relaxedsimd-lstm.wasm.js`)).size + statSync(src(`${tjs}/worker.min.js`)).size + statSync(src(`${lang}/eng.traineddata.gz`)).size })};`
      : null),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent((req.url || '').split('?')[0]).slice(BASE.length);
        if (!files[path]) return next();
        res.setHeader('Content-Type', path.endsWith('.gz') ? 'application/gzip' : 'text/javascript');
        createReadStream(src(path)).pipe(res);
      });
    },
    generateBundle() {
      for (const f of Object.keys(files)) this.emitFile({ type: 'asset', fileName: f, source: readFileSync(src(f)) });
    },
  };
}

export default defineConfig({
  base: BASE,
  // Default repo for /admin/ (Actions sets GITHUB_REPOSITORY automatically).
  define: { __REPO__: JSON.stringify(process.env.GITHUB_REPOSITORY || 'bawcejawn/PrivyForge') },
  appType: 'mpa',
  build: { rollupOptions: { input: { ...findPages(root), notFound: resolve(root, '404.html') } }, target: 'es2022' },
  worker: { format: 'es' },
  // jSquash ships its own wasm loaders; pre-bundling breaks their relative wasm URLs.
  optimizeDeps: { exclude: ['@jsquash/jpeg', '@jsquash/png', '@jsquash/oxipng', '@jsquash/webp', '@jsquash/avif'] },
  plugins: [
    partials(),
    basePathLinks(),
    ocrAssets(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      manifest: {
        name: SITE.name, short_name: SITE.name,
        description: 'Free private PDF, image and money tools that run in your browser: compress files, find forgotten subscriptions, plan debt payoff. Nothing is uploaded.',
        theme_color: '#14110f', background_color: '#14110f', display: 'standalone',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // HTML/JS/CSS precached; large wasm codecs cached on first use -> tools work offline.
        globPatterns: ['**/*.{html,js,css,svg}'],
        globIgnores: ['**/pdf.worker*.mjs', '**/admin*', 'admin/**', 'ocr/**'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: null,
        runtimeCaching: [{
          urlPattern: ({ url }) => /\.(wasm|mjs)$/.test(url.pathname),
          handler: 'CacheFirst',
          options: { cacheName: 'codecs', expiration: { maxEntries: 40 } },
        }, {
          // OCR engine + English data (self-hosted, versioned paths): cached on first OCR.
          // (A RegExp, not a function: workbox serializes functions without their closure.)
          urlPattern: new RegExp(`^[^?#]*?://[^/]+${BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}ocr/`),
          handler: 'CacheFirst',
          options: { cacheName: 'ocr', expiration: { maxEntries: 12 } },
        }],
      },
    }),
  ],
});
