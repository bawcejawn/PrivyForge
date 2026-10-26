# PrivyForge

Free image, PDF and money tools that run entirely in the browser. Files and financial data never leave the visitor's device.

## Setup

Requires Node 22 (see `.nvmrc`).

```bash
npm install
npm run dev        # http://localhost:5173 — includes /admin/ (dev only)
npm test           # unit tests
npm run build      # -> dist/ (+ sitemap.xml, robots.txt); set SITE_URL first
npm run preview    # serve dist/ at http://localhost:4173
```

| Setting | Where |
|---|---|
| Public URL (canonicals, sitemap, OG tags) | `SITE_URL` environment variable, e.g. `SITE_URL=https://example.com npm run build` |
| Ads, affiliate links, support links, contact email | `src/data/site.json` (or `/admin/` → Settings under `npm run dev`) |
| Tool list, order, visibility | `src/data/tools.json` (or `/admin/` → Tools) |
| Guides | `content/guides/*.md` (or `/admin/` → Guides); built into `/blog/` |

Deployment: see [DEPLOY.md](DEPLOY.md).

### Admin (local only)

`/admin/` is excluded from production builds. Run `npm run dev`, open `http://localhost:5173/admin/`, and paste a fine-grained GitHub token scoped to this repository with **Contents: Read and write** (optionally **Actions: Read**). The token is held in `sessionStorage` for that tab only and is sent only to `api.github.com`. Admin can write only `src/data/site.json`, `src/data/tools.json` and `content/guides/*.md`.

## Privacy proof

The claim: **no tool uploads files or entered data.** Anyone can verify it:

1. **Offline test.** Open any tool, let it load, turn off Wi-Fi, and use it. It keeps working, because the processing code (WebAssembly codecs, pdf-lib, pdf.js) runs in the page and a service worker caches it.
2. **Network test.** Open DevTools → Network, run a tool, and confirm that no request carries your file. Tool code only reads files into memory (`FileReader` / `Blob.arrayBuffer`) and writes results back as `blob:` downloads.
3. **Automated test.** The Playwright suites in `tests/e2e/` run every tool in headless Chromium and fail if any cross-origin request or any non-GET request happens. They also check that hostile input (HTML in CSVs, share links, backup files) renders as plain text.

```bash
pip install playwright pypdf pypdfium2 opencv-python pillow reportlab && python -m playwright install chromium
python tests/e2e/make_fixtures.py
npm run build && npm run preview &   # serves :4173
for s in e2e e2e_money e2e_hash e2e_revenue e2e_images e2e_pdf2 e2e_calc e2e_ocr e2e_heic e2e_sign; do python tests/e2e/$s.py; done
npm run dev &                        # serves :5173 (admin is dev-only)
python tests/e2e/e2e_admin.py
```

Data saved by the `/my/` dashboard (favorites, scenarios, checkup progress) stays in the visitor's own `localStorage`.

Before ads are enabled, `public/_headers` contains an optional strict Content-Security-Policy that makes the browser itself block every outbound connection.

## License

All rights reserved. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
