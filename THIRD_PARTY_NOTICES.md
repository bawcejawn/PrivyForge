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
| vite, vite-plugin-pwa, Workbox | MIT | Build + offline support |
| tesseract.js | Apache-2.0 | OCR (Image to Text, PDF to Text): browser API + Web Worker |
| tesseract.js-core (WebAssembly build of the Tesseract OCR engine) | Apache-2.0 | OCR engine; Tesseract itself is Apache-2.0 |
| @tesseract.js-data/eng (English `4.0.0_best_int` model from tessdata) | MIT (package); tessdata models are Apache-2.0 | English OCR language data |

The OCR engine, worker and English data are self-hosted under `/ocr/` (copied from
`node_modules` at build time); they are not loaded from any CDN.

Methodology and test vectors:
- Loan rounding conventions and validation examples follow the approach documented by
  [murraystokely/mortgagemath](https://github.com/murraystokely/mortgagemath) (MIT). Original
  sources of the test figures: CFPB (Reg Z H-25(B)), Texas Instruments BA II Plus guidebook,
  Mississippi State University Extension, Wikipedia, OpenStax. No code was copied.
