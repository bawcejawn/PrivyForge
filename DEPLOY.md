# Deploying PrivyForge

PrivyForge is a static site. Production hosting is **Cloudflare Pages** (free, allows commercial use, honors `public/_headers`).

## Cloudflare Pages (production)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → choose this repository.
2. Build settings:

   | Setting | Value |
   |---|---|
   | Framework preset | None |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Root directory | *(leave empty)* |

3. **Settings → Environment variables** (Production *and* Preview):

   | Variable | Value |
   |---|---|
   | `SITE_URL` | `https://your-domain.com` — no trailing slash. Used for canonical URLs, OG tags and the sitemap. |
   | `NODE_VERSION` | `22` (also pinned in `.nvmrc`) |

   Leave `BASE_PATH` unset; the site is served from the domain root.

4. **Custom domains** → add your domain and follow the DNS steps.
5. **Web Analytics** → enable it for the Pages project (no code change; Cloudflare injects the beacon). The privacy policy already describes it.
6. Every push to `main` builds and deploys. Pull-request branches get preview URLs.

After the first deploy, check:

- `https://your-domain.com/sitemap.xml` lists your domain (not `localhost`).
- `https://your-domain.com/robots.txt` points at that sitemap.
- An unknown URL returns the PrivyForge 404 page with HTTP status 404.
- Then submit the sitemap in Google Search Console and Bing Webmaster Tools.

## Retire the GitHub Pages copy (after Cloudflare is live)

The GitHub Pages workflow (`.github/workflows/deploy-pages.yml`) no longer runs on push; it only runs if started by hand. Once the Cloudflare site is live:

1. GitHub repo → **Settings → Pages** → **Unpublish site** (or set Source to *None*).
2. Optionally delete `.github/workflows/deploy-pages.yml`.

Until then, `https://bawcejawn.github.io/PrivyForge/` keeps serving the last version it built.

## Admin

`/admin/` is not deployed. Run `npm run dev` and open `http://localhost:5173/admin/` (see README). Saves are committed to `main`, which Cloudflare then deploys.
