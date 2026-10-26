import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { SITE } from './site.config.js';
import { loadSite, loadTools, toolGrid, footerTools, applyAffiliates, announcement, esc, normalizeMeta } from './scripts/render-data.mjs';

const root = resolve(__dirname);

// Every folder containing an index.html becomes a page (multi-page static build).
// /admin/ is a local tool: served by `npm run dev`, never included in production builds.
const SKIP = ['node_modules', 'dist', 'public', 'src', 'scripts', 'tests', 'content', '.git', '.github', 'admin'];
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
          .replace('<!-- @footer-tools -->', footerTools(tools))
          .replace('<!-- @announcement -->', announcement(site));
        out = applyAffiliates(out, site);
        const pagePath = ('/' + (ctx?.path || '/').replace(/^\//, '')).replace(/index\.html$/, '').replace(/404\.html$/, '/404/');
        out = normalizeMeta(out, pagePath);
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
        globIgnores: ['**/pdf.worker*.mjs', '**/admin*', 'admin/**'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: null,
        runtimeCaching: [{
          urlPattern: ({ url }) => /\.(wasm|mjs)$/.test(url.pathname),
          handler: 'CacheFirst',
          options: { cacheName: 'codecs', expiration: { maxEntries: 40 } },
        }],
      },
    }),
  ],
});
