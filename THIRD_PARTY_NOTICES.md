# Third-party notices

PrivyForge bundles or builds on these open-source projects:

| Project | License | Used for |
|---|---|---|
| jSquash (MozJPEG, libwebp, libavif, OxiPNG builds from Squoosh) | Apache-2.0 / BSD | Image codecs |
| UPNG.js | MIT | PNG palette quantization |
| pdf-lib | MIT | PDF merge/split/save |
| pdf.js (pdfjs-dist) | Apache-2.0 | PDF rendering |
| qrcode | MIT | QR codes |
| fflate | MIT | ZIP downloads |
| marked | MIT | Markdown guides (build + admin preview) |
| heic-to (bundles libheif and libde265) | LGPL-3.0 | HEIC/HEIF decoding in browsers without a built-in decoder |
| vite, vite-plugin-pwa, Workbox | MIT | Build + offline support |

## heic-to / libheif (LGPL-3.0)

The HEIC tools use [heic-to](https://github.com/hoppergee/heic-to) 1.6.6 by Hopper Gee, which is a
WebAssembly build of [libheif](https://github.com/strukturag/libheif) 1.23.6 (Dirk Farin /
struktur AG; it includes the [libde265](https://github.com/strukturag/libde265) HEVC decoder).
All three are licensed under the GNU Lesser General Public License v3.0 (LGPL-3.0).

- We ship heic-to's published `dist/csp/heic-to.js` **unmodified**, as a separate file:
  `/vendor/heic-to/heic-to-csp-1.6.6.mjs`. It is not combined with PrivyForge's own code and is
  only downloaded when a browser without a built-in HEIC decoder opens a HEIC photo.
- The license texts ship next to it: `/vendor/heic-to/LICENSE.txt` (heic-to's LGPL-3.0 notice and
  text) and `/vendor/heic-to/COPYING-GPL-3.txt` (the GNU GPL v3, which the LGPL refers to).
- Source code: heic-to at <https://github.com/hoppergee/heic-to> (npm version 1.6.6), libheif at
  <https://github.com/strukturag/libheif> (tag v1.23.6), libde265 at
  <https://github.com/strukturag/libde265>.
- You may replace the library with your own modified or newer build: PrivyForge loads it by URL
  at runtime and uses only its public `heicTo()` function, so any compatible file placed at that
  path (or served in its place, e.g. by a browser extension or local override) will be used.
  Build instructions are in heic-to's repository.

Methodology and test vectors:
- Loan rounding conventions and validation examples follow the approach documented by
  [murraystokely/mortgagemath](https://github.com/murraystokely/mortgagemath) (MIT). Original
  sources of the test figures: CFPB (Reg Z H-25(B)), Texas Instruments BA II Plus guidebook,
  Mississippi State University Extension, Wikipedia, OpenStax. No code was copied.
