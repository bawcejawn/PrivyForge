# Browser tests for Image to Text and PDF to Text (OCR with self-hosted tesseract.js).
# Run after `npm run build && npx vite preview --port 4173` (or set BASE).
# Key privacy check: OCR must not make a single cross-origin or non-GET request; the engine,
# worker and English data must come from this site's own /ocr/ path.
import asyncio, os, re
from playwright.async_api import async_playwright
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader

BASE = os.environ.get('BASE', 'http://localhost:4173')
OUT = os.path.join(os.path.dirname(__file__), 'out'); os.makedirs(OUT, exist_ok=True)
results = []
def check(name, ok, info=''):
    results.append(ok); print(('PASS ' if ok else 'FAIL ') + name, str(info)[:220])

S1 = 'The quick brown fox jumps over the lazy dog'
S2 = 'Private documents never leave your computer'
S3 = 'Scanned invoices can be read offline'
PDF_TEXT = 'This first page has a real text layer for extraction'

FONT = next((f for f in ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
                         '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'] if os.path.exists(f)), None)

def text_image(sentence, path, size=56):
    font = ImageFont.truetype(FONT, size) if FONT else ImageFont.load_default()
    w = int(font.getlength(sentence)) + 120 if FONT else 900
    im = Image.new('RGB', (w, size * 3), 'white')
    ImageDraw.Draw(im).text((60, size), sentence, fill='black', font=font)
    im.save(path); return path

def norm(s): return re.sub(r'\s+', ' ', s).strip().lower()

def make_pdf(path):
    img = text_image(S2, os.path.join(OUT, 'ocr-pdf-p2.png'), size=64)
    c = rl_canvas.Canvas(path, pagesize=letter)
    c.setFont('Helvetica', 14); c.drawString(72, 700, PDF_TEXT); c.drawString(72, 680, 'Second line of real text.')
    c.showPage()
    w, h = Image.open(img).size
    dw = 468; c.drawImage(ImageReader(img), 72, 600, width=dw, height=dw * h / w)  # page 2: image only
    c.showPage(); c.save(); return path

async def main():
    img1 = text_image(S1, os.path.join(OUT, 'ocr-1.png'))
    img2 = text_image(S3, os.path.join(OUT, 'ocr-2.jpg'))
    pdf = make_pdf(os.path.join(OUT, 'ocr-2page.pdf'))
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(accept_downloads=True)
        external, posts, errors, ocr_files = [], [], [], {}
        def on_req(r):
            if not r.url.startswith(BASE) and not r.url.startswith(('blob:', 'data:')): external.append(r.url)
            if r.method != 'GET': posts.append(f'{r.method} {r.url}')
        async def on_resp(r):
            if '/ocr/' in r.url:
                # bytes on the wire: Content-Length (the preview server gzip-encodes .gz files,
                # so the decoded body would overstate the download)
                n = int(r.headers.get('content-length') or 0)
                if not n:
                    try: n = len(await r.body())
                    except Exception: pass
                ocr_files[r.url.split('/ocr/')[1]] = max(n, ocr_files.get(r.url.split('/ocr/')[1], 0))
        ctx.on('request', on_req)  # context-level: also sees worker and service-worker requests
        ctx.on('response', lambda r: asyncio.ensure_future(on_resp(r)))
        page = await ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))

        # ---- Image to Text
        await page.goto(f'{BASE}/image-to-text/')
        notice = await page.inner_text('#ocr-notice')
        check('img: first-use notice shows measured size', await page.is_visible('#ocr-notice') and bool(re.search(r'about \d+(\.\d)? MB', notice)), notice[:90])
        await page.set_input_files('#drop input', [img1])
        await page.wait_for_selector('.ocr-card textarea:not([hidden])', timeout=180000)
        t = await page.input_value('.ocr-card textarea')
        check('img: OCR output contains the sentence', norm(S1) in norm(t), t)
        meta = await page.inner_text('.ocr-card .meta')
        check('img: shows word count + confidence', 'confidence' in meta, meta)
        async with page.expect_download() as d: await page.click('.ocr-card [data-dl]')
        dl = await d.value
        check('img: download .txt', dl.suggested_filename == 'ocr-1.txt' and norm(S1) in norm(open(await dl.path()).read()), dl.suggested_filename)
        await page.fill('.ocr-card textarea', 'edited text')
        async with page.expect_download() as d: await page.click('.ocr-card [data-dl]')
        check('img: download uses the edited text', open(await (await d.value).path()).read().strip() == 'edited text')
        check('img: notice hidden after first OCR', not await page.is_visible('#ocr-notice'))

        # batch of two (second is a JPG) -> per-image results + combined download
        await page.click('#clear')
        await page.set_input_files('#drop input', [img1, img2])
        await page.wait_for_function("document.querySelectorAll('.ocr-card textarea:not([hidden])').length === 2", timeout=180000)
        texts = [await page.locator('.ocr-card textarea').nth(i).input_value() for i in range(2)]
        check('img: batch gives per-image results', norm(S1) in norm(texts[0]) and norm(S3) in norm(texts[1]), texts)
        async with page.expect_download() as d: await page.click('#download-all')
        allt = open(await (await d.value).path()).read()
        check('img: download all has both, with headings', '--- ocr-1.png ---' in allt and '--- ocr-2.jpg ---' in allt and norm(S3) in norm(allt))
        await page.screenshot(path=f'{OUT}/image-to-text.png', full_page=True)

        # unsupported file type for this browser (HEIC-named garbage) -> friendly error
        bad = os.path.join(OUT, 'not-really.heic'); open(bad, 'wb').write(b'\x00' * 200)
        await page.click('#clear')
        await page.set_input_files('#drop input', [bad])
        await page.wait_for_selector('.ocr-card .meta.err', timeout=30000)
        check('img: undecodable image -> friendly error', 'HEIC to JPG' in await page.inner_text('.ocr-card .meta.err'))

        # ---- PDF to Text
        await page.goto(f'{BASE}/pdf-to-text/')
        check('pdf: notice hidden once OCR data is cached', not await page.is_visible('#ocr-notice'))
        await page.set_input_files('#drop input', [pdf])
        await page.wait_for_selector('#run:not([disabled])')
        await page.click('#run')
        await page.wait_for_selector('#out-box:not([hidden])', timeout=180000)
        out = await page.input_value('#out')
        p1, _, p2 = out.partition('--- Page 2 (OCR) ---')
        check('pdf: page 1 from text layer (exact)', p1.startswith('--- Page 1 ---') and PDF_TEXT in p1 and '(OCR)' not in p1, p1[:120])
        check('pdf: page 2 OCRd and labelled', bool(p2) and norm(S2) in norm(p2), p2[:120])
        kinds = await page.inner_text('#page-kinds')
        check('pdf: page kinds shown', 'p1: text' in kinds and 'p2: OCR' in kinds, kinds)
        async with page.expect_download() as d: await page.click('#download')
        dl = await d.value
        check('pdf: download .txt', dl.suggested_filename == 'ocr-2page.txt' and PDF_TEXT in open(await dl.path()).read())
        await page.fill('#ranges', '1')
        await page.click('#run'); await page.wait_for_function("document.querySelector('#out').value.includes('Page 1') && !document.querySelector('#out').value.includes('Page 2')", timeout=60000)
        check('pdf: page range limits output', True)
        await page.fill('#ranges', '1'); await page.check('#ocr-all')
        await page.click('#run'); await page.wait_for_function("document.querySelector('#out').value.includes('Page 1 (OCR)')", timeout=180000)
        o2 = await page.input_value('#out')
        check('pdf: "OCR all pages" OCRs a text page', 'first page has a real text layer' in norm(o2), o2[:120])
        await page.fill('#ranges', '9')
        await page.click('#run'); await page.wait_for_timeout(200)
        check('pdf: bad range -> message', "Couldn't read that page range" in await page.inner_text('#status'))
        await page.fill('#ranges', ''); await page.uncheck('#ocr-all')
        await page.screenshot(path=f'{OUT}/pdf-to-text.png', full_page=True)

        # ---- self-hosting + privacy
        names = sorted(ocr_files)
        check('privacy: worker, core and English data came from this site', any(n.endswith('worker.min.js') for n in names) and any('tesseract-core-' in n for n in names) and any(n.endswith('eng.traineddata.gz') for n in names), names)
        total = sum(v for k, v in ocr_files.items() if k.endswith(('worker.min.js', '-lstm.wasm.js', '.gz')))
        print(f'INFO first-use OCR download: {total} bytes ({total / 1048576:.2f} MiB) — {ocr_files}')

        # ---- offline: the service worker cached /ocr/ on first use, so OCR works without network
        await page.goto(f'{BASE}/image-to-text/')
        await page.evaluate('navigator.serviceWorker.ready')
        cached = await page.evaluate("caches.open('ocr').then(c => c.keys()).then(k => k.map(r => r.url))")
        check('offline: /ocr/ files are in the runtime cache', any('eng.traineddata.gz' in u for u in cached) and any('wasm.js' in u for u in cached), cached)
        await ctx.set_offline(True)
        await page.reload()
        await page.set_input_files('#drop input', [img1])
        await page.wait_for_selector('.ocr-card textarea:not([hidden]), .ocr-card .meta.err', timeout=180000)
        t = await page.input_value('.ocr-card textarea')
        check('offline: OCR still works', norm(S1) in norm(t), (await page.inner_text('.ocr-card .meta'))[:120])
        await ctx.set_offline(False)

        # mobile layout: no horizontal scroll
        m = await b.new_page(viewport={'width': 390, 'height': 844})
        for path in ['/image-to-text/', '/pdf-to-text/']:
            await m.goto(f'{BASE}{path}')
            sw = await m.evaluate('document.documentElement.scrollWidth')
            check(f'mobile {path}: no horizontal scroll', sw <= 390, sw)
            await m.screenshot(path=f'{OUT}/mobile{path.strip("/")}.png', full_page=True)

        check('privacy: zero cross-origin requests', not external, external[:5])
        check('privacy: zero non-GET requests', not posts, posts[:5])
        check('no JS errors', not errors, errors[:3])
        await b.close()
    print(f'\n{sum(results)}/{len(results)} passed')
    raise SystemExit(0 if all(results) else 1)

asyncio.run(main())
