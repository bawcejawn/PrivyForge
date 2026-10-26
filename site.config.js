// Central site settings. The public URL comes from the SITE_URL environment variable
// (set it in Cloudflare Pages → Settings → Environment variables). No trailing slash.
const FALLBACK = 'http://localhost:4173';
const url = (process.env.SITE_URL || '').trim().replace(/\/+$/, '');

if (!url && process.argv.some((a) => a === 'build' || a.endsWith('seo.mjs'))) {
  console.warn(`\n⚠  SITE_URL is not set — canonical URLs, OG tags and the sitemap will use ${FALLBACK}.\n   Set SITE_URL=https://your-domain before a production build.\n`);
}

export const SITE = {
  name: 'PrivyForge',
  url: url || FALLBACK,
};
