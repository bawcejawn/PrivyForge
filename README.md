# PrivyForge

Free, private file tools that run **100% in the browser**. Files are never uploaded.

| Tool | URL | Engine |
|---|---|---|
| Image compressor / converter / resizer | `/compress-image/` | MozJPEG, libwebp, libavif, OxiPNG + UPNG (WebAssembly, in a Web Worker pool) |
| Merge PDF | `/merge-pdf/` | pdf-lib |
| Split PDF | `/split-pdf/` | pdf-lib |
| Compress PDF | `/compress-pdf/` | pdf.js render → JPEG → pdf-lib (or lossless re-save) |
| QR code generator | `/qr-code-generator/` | qrcode (static codes, PNG + SVG) |
| Mortgage calculator | `/mortgage-calculator/` | PITI + PMI, amortization, chart, CSV |
| Loan calculator | `/loan-calculator/` | same engine |
| Subscription finder | `/subscription-finder/` | bank CSV parsed locally; recurring-charge detection |
| Debt payoff planner | `/debt-payoff-calculator/` | snowball vs avalanche vs minimums |
| Refinance calculator | `/refinance-calculator/` | break-even + net position at move date |
| Rent vs buy | `/rent-vs-buy-calculator/` | net worth over time, invest-the-difference |

Loan math is cent-accurate (integer cents, half-up interest rounding, final-payment adjustment) and validated against published CFPB, TI BA II Plus and textbook examples. See `PRIVYFORGE.md` for the full plan, research findings and the Claude build prompt.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173 (dev shows dashed ad-slot placeholders)
npm test           # unit tests (amortization, debt, subscriptions, refinance, rent vs buy)
npm run build      # -> dist/ (+ sitemap.xml, robots.txt)
npm run preview    # serve dist/ at http://localhost:4173
```

Requires Node 18+.

## Deploy (free) — GitHub Pages

1. Push to a GitHub repo (branch `main`).
2. Settings → Pages → Source: **GitHub Actions**.
3. Done: `.github/workflows/deploy-pages.yml` runs the tests, builds and deploys on every push.
   The site appears at `https://<user>.github.io/<repo>/` (sub-path handled automatically).
4. Custom domain or a `<user>.github.io` repo: add repo variables `BASE_PATH=/` and
   `SITE_URL=https://yourdomain.com` (Settings → Secrets and variables → Actions → Variables).

GitHub Pages isn't meant for commercial services, so move to Cloudflare Pages (below, also free)
before launching paid features.

## Deploy (free) — Cloudflare Pages

1. Push this folder to a GitHub repo.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git.
3. Build command `npm run build`, output directory `dist`.
4. Environment variable `SITE_URL=https://yourdomain.com` (used for canonicals + sitemap).
5. Add your custom domain. `public/_headers` is applied automatically.

Vercel / Netlify work the same way (build `npm run build`, output `dist`). GitHub Pages also works but ignores `_headers`.

## Where to change things

| What | File |
|---|---|
| Domain / site name | `site.config.js` (or `SITE_URL` env var) |
| AdSense client + ad unit IDs | `src/js/config.js` |
| Affiliate links | `src/partials/affiliate-*.html` (replace `#AFFILIATE_…`) |
| Header nav / footer links | `src/partials/header.html`, `footer.html` |
| Styles / colors | `src/css/main.css` (`:root` tokens) |
| Add a page | create `some-slug/index.html` — it's picked up automatically |
| ads.txt | `public/ads.txt` |

HTML pages use `<!-- @include name -->` to pull in `src/partials/name.html` at build time, and `{{SITE_URL}}` is replaced with your domain.

## Privacy guarantees (and how to prove them)

* Tool code never calls `fetch`/XHR with file data; the image worker and PDF code only touch in-memory buffers.
* After first visit, a service worker caches the tools: **turn off Wi-Fi and they still work**.
* The end-to-end suites (`tests/e2e/e2e.py`, `tests/e2e/e2e_money.py`) assert zero cross-origin and zero non-GET requests while every tool runs, and that injected HTML in CSVs or share links renders as text.
* Before adding ads you can enable the strict CSP in `public/_headers` so the browser itself blocks any outbound connection.

## Known limits

* PDF "Recommended/Smallest" compression rasterizes pages (text no longer selectable); "Lossless" keeps text but saves less. A Ghostscript-WASM or qpdf-WASM engine would add true image-downsampling while keeping text — see PRIVYFORGE.md.
* Password-protected PDFs are rejected with a clear message.
* PDF merge keeps page content; document bookmarks and form fields may not carry over.
* AVIF encoding is single-threaded (no cross-origin isolation, because COOP/COEP headers would break ad scripts), so large AVIF batches take a few seconds per image.
* HEIC input only works in Safari (browser decode support).

## License notes

All dependencies are permissive (Apache-2.0 / MIT / BSD). If you later add Ghostscript-WASM, note it is AGPL.
