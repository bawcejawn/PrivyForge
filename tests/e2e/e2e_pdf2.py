# Browser tests for compress-to-1MB, image-to-PDF and PDF-to-JPG.
# Run after `npm run build && npx vite preview --port 4173` (or set BASE).
import asyncio, io, os, zipfile
from playwright.async_api import async_playwright
from pypdf import PdfReader
from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader

BASE = os.environ.get('BASE', 'http://localhost:4173')
FX = os.path.join(os.path.dirname(__file__), 'fx')
OUT = os.path.join(os.path.dirname(__file__), 'out'); os.makedirs(OUT, exist_ok=True)
MB = 1024 * 1024
results = []
def check(name, ok, info=''):
    results.append(ok); print(('PASS ' if ok else 'FAIL ') + name, str(info)[:240])

def noise_pdf(path, pages, full_page=False):
    """A PDF that's genuinely large: random-noise images don't compress."""
    c = canvas.Canvas(path, pagesize=letter)
    for p in range(pages):
        side = 1100 if full_page else 900
        img = Image.frombytes('RGB', (side, side), os.urandom(side * side * 3))
        c.setFont('Helvetica', 24); c.drawString(72, 740, f'noise page {p + 1}')
        if full_page: c.drawImage(ImageReader(img), 0, 0, width=612, height=720)
        else: c.drawImage(ImageReader(img), 81, 200, width=450, height=450)
        c.showPage()
    c.save()

def make_fixtures():
    big = os.path.join(OUT, 'big-noise.pdf'); noise_pdf(big, 4)
    # 16 full pages of noise: even the lowest setting (~55-60 KB/page) stays far above 500 KB,
    # so the 'unreachable target' case is deterministic (8 pages hovered right at the limit).
    huge = os.path.join(OUT, 'huge-noise.pdf'); noise_pdf(huge, 16, full_page=True)
    webp = os.path.join(OUT, 'tall.webp')
    Image.new('RGB', (500, 700), (40, 160, 90)).save(webp, 'WEBP', quality=90)
    # Raw 600×400 JPEG: red top-left block, blue elsewhere, tagged EXIF orientation 6 (display: rotate 90° CW).
    raw = Image.new('RGB', (600, 400), (0, 0, 255)); ImageDraw.Draw(raw).rectangle([0, 0, 199, 133], fill=(255, 0, 0))
    exif = Image.Exif(); exif[0x0112] = 6
    rot = os.path.join(OUT, 'rotated.jpg'); raw.save(rot, quality=95, exif=exif.tobytes())
    return big, huge, webp, rot

def raw_image(pg):
    xo = pg['/Resources']['/XObject']; o = xo[list(xo.keys())[0]].get_object()
    return o._data  # undecoded stream bytes (DCTDecode = the JPEG file itself)

def is_jpeg(b): return b[:3] == b'\xff\xd8\xff' and b[-2:] == b'\xff\xd9'

async def main():
    big, huge, webp, rot = make_fixtures()
    check('fixture: noise PDF is > 1 MB', os.path.getsize(big) > MB, os.path.getsize(big))
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(accept_downloads=True)
        page = await ctx.new_page()
        external, posts, errors = [], [], []
        page.on('request', lambda r: (external.append(r.url) if not r.url.startswith(BASE) and not r.url.startswith(('blob:', 'data:')) else None, posts.append(r.url) if r.method != 'GET' else None))
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

        # ---- Compress PDF to 1 MB
        await page.goto(f'{BASE}/compress-pdf-to-1mb/')
        await page.set_input_files('#drop input', [big])
        await page.wait_for_selector('#run:not([disabled])')
        async with page.expect_download(timeout=180000) as d: await page.click('#run')
        path = await (await d.value).path(); size = os.path.getsize(path)
        res = await page.inner_text('#result')
        check('compress-to-1mb: output <= 1,048,576 bytes', size <= MB, f'{os.path.getsize(big)} -> {size}')
        check('compress-to-1mb: 4 pages kept', len(PdfReader(path).pages) == 4)
        check('compress-to-1mb: result shows setting used + exact bytes', 'Setting used:' in res and 'DPI' in res and f'{size:,} bytes' in res, res.replace('\n', ' | '))
        check('compress-to-1mb: warns pages are images', 'no longer be selected' in res)
        check('compress-to-1mb: lists attempts incl. a too-big one', 'too big' in res and 'fits' in res)
        await page.screenshot(path=f'{OUT}/compress-1mb.png', full_page=True)

        # Already-small PDF: stays lossless, text still selectable
        await page.set_input_files('#drop input', [f'{FX}/a.pdf'])
        await page.wait_for_selector('#run:not([disabled])')
        async with page.expect_download(timeout=60000) as d: await page.click('#run')
        path = await (await d.value).path(); r = PdfReader(path)
        check('compress-to-1mb: small PDF keeps selectable text', 'a.pdf page 1' in r.pages[0].extract_text() and os.path.getsize(path) <= os.path.getsize(f'{FX}/a.pdf'), await page.inner_text('#result .how'))

        # Unreachable target: smallest result + clear warning
        await page.set_input_files('#drop input', [huge])
        await page.select_option('#target', '512000')
        await page.wait_for_selector('#run:not([disabled])')
        async with page.expect_download(timeout=240000) as d: await page.click('#run')
        path = await (await d.value).path(); size = os.path.getsize(path)
        res = await page.inner_text('#result')
        check('compress-to-1mb: unreachable target says so + returns smallest', "Couldn't reach" in res and 'smallest' in res and size < os.path.getsize(huge), f'{os.path.getsize(huge)} -> {size}; {res[:120]}')
        check('compress-to-1mb: status flagged as error', await page.locator('#status.err').count() == 1)

        # ---- Image to PDF
        await page.goto(f'{BASE}/image-to-pdf/')
        await page.set_input_files('#drop input', [f'{FX}/photo.jpg', f'{FX}/logo.png', webp])
        await page.wait_for_function("document.querySelectorAll('#files .file').length === 3")
        # Move the WebP (last) to the top with the keyboard reorder.
        last = page.locator('#files .file').nth(2)
        await last.focus(); await page.keyboard.press('Alt+ArrowUp'); await page.keyboard.press('Alt+ArrowUp')
        names = await page.locator('#files .file .name').all_inner_texts()
        check('image-to-pdf: reorder via Alt+Up', names == ['tall.webp', 'photo.jpg', 'logo.png'], names)
        async with page.expect_download(timeout=60000) as d: await page.click('#run')
        r = PdfReader(await (await d.value).path())
        sizes = [(round(float(pg.mediabox.width)), round(float(pg.mediabox.height))) for pg in r.pages]
        check('image-to-pdf: 3 pages, fit-to-image sizes in chosen order', sizes == [(375, 525), (1800, 1200), (600, 450)], sizes)
        imgs = [pg.images[0].image.size for pg in r.pages]
        check('image-to-pdf: JPEG/PNG embedded at full resolution', imgs[1] == (2400, 1600) and imgs[2] == (800, 600) and imgs[0] == (500, 700), imgs)
        check('image-to-pdf: JPEG embedded without re-encoding', raw_image(r.pages[1]) == open(f'{FX}/photo.jpg', 'rb').read())

        await page.select_option('#pagesize', 'a4'); await page.select_option('#margin', 'medium')
        async with page.expect_download(timeout=60000) as d: await page.click('#run')
        r = PdfReader(await (await d.value).path())
        sizes = [(round(float(pg.mediabox.width)), round(float(pg.mediabox.height))) for pg in r.pages]
        check('image-to-pdf: A4 with auto orientation', sizes == [(595, 842), (842, 595), (842, 595)], sizes)
        await page.screenshot(path=f'{OUT}/image-to-pdf.png', full_page=True)

        # EXIF orientation 6: page is portrait, original JPEG kept, and it renders upright.
        await page.goto(f'{BASE}/image-to-pdf/')
        await page.set_input_files('#drop input', [rot])
        await page.wait_for_selector('#run:not([disabled])')
        meta = await page.inner_text('#files .file .meta')
        async with page.expect_download(timeout=60000) as d: await page.click('#run')
        rot_pdf = os.path.join(OUT, 'rotated-out.pdf'); await (await d.value).save_as(rot_pdf)
        r = PdfReader(rot_pdf); pg = r.pages[0]
        check('image-to-pdf: EXIF-rotated photo gets a portrait page', (round(float(pg.mediabox.width)), round(float(pg.mediabox.height))) == (300, 450) and '400 × 600' in meta, f'{pg.mediabox} {meta}')
        emb, orig = raw_image(pg), open(rot, 'rb').read()
        diff = sum(x != y for x, y in zip(emb, orig)) if len(emb) == len(orig) else -1
        check('image-to-pdf: rotated JPEG embedded without re-encoding (only EXIF tag reset)', 0 < diff <= 2, diff)

        # ---- PDF to JPG (also renders the rotated PDF to check it's upright)
        await page.goto(f'{BASE}/pdf-to-jpg/')
        await page.set_input_files('#drop input', [rot_pdf])
        await page.wait_for_selector('#run:not([disabled])')
        await page.select_option('#dpi', '72')
        async with page.expect_download(timeout=60000) as d: await page.click('#run')
        im = Image.open(await (await d.value).path()).convert('RGB')
        w, h = im.size
        tr, tl = im.getpixel((w - 10, 10)), im.getpixel((10, 10))
        check('image-to-pdf: rotated photo renders upright (red block top-right)', (w, h) == (300, 450) and tr[0] > 200 and tr[2] < 80 and tl[2] > 200, f'{(w, h)} tr={tr} tl={tl}')

        await page.set_input_files('#drop input', [f'{FX}/b.pdf'])
        await page.wait_for_selector('#run:not([disabled])')
        await page.select_option('#dpi', '150')
        async with page.expect_download(timeout=120000) as d: await page.click('#run')
        dl = await d.value
        z = zipfile.ZipFile(await dl.path()); names = sorted(z.namelist())
        dims = [Image.open(io.BytesIO(z.read(n))).size for n in names]
        check('pdf-to-jpg: ZIP with 3 JPEGs', dl.suggested_filename.endswith('.zip') and names == ['b-page-1.jpg', 'b-page-2.jpg', 'b-page-3.jpg'], names)
        check('pdf-to-jpg: valid JPEG headers', all(is_jpeg(z.read(n)) for n in names))
        check('pdf-to-jpg: 150 DPI Letter = 1275 × 1650', all(dm == (1275, 1650) for dm in dims), dims)
        check('pdf-to-jpg: preview grid shows 3 pages', await page.locator('#pages li').count() == 3)
        await page.screenshot(path=f'{OUT}/pdf-to-jpg.png', full_page=True)

        await page.select_option('#dpi', '300'); await page.fill('#ranges', '2')
        async with page.expect_download(timeout=120000) as d: await page.click('#run')
        dl = await d.value; data = open(await dl.path(), 'rb').read()
        check('pdf-to-jpg: single page -> one 300 DPI JPG', dl.suggested_filename == 'b-page-2.jpg' and is_jpeg(data) and Image.open(io.BytesIO(data)).size == (2550, 3300), dl.suggested_filename)
        await page.fill('#ranges', '7')
        await page.click('#run')
        check('pdf-to-jpg: bad range shows error', 'between 1 and 3' in await page.inner_text('#status'))

        # ---- Mobile layout
        m = await b.new_page(viewport={'width': 390, 'height': 844})
        for slug in ['compress-pdf-to-1mb', 'image-to-pdf', 'pdf-to-jpg']:
            await m.goto(f'{BASE}/{slug}/'); await m.screenshot(path=f'{OUT}/{slug}-mobile.png', full_page=True)
            sw = await m.evaluate('document.documentElement.scrollWidth')
            check(f'{slug}: no horizontal scroll on mobile', sw <= 390, sw)
            await page.goto(f'{BASE}/{slug}/'); await page.set_viewport_size({'width': 1280, 'height': 900})
            await page.screenshot(path=f'{OUT}/{slug}-desktop.png')

        check('ZERO external requests', not external, external[:4])
        check('ZERO non-GET requests (nothing uploaded)', not posts, posts[:4])
        check('no JS errors', not errors, errors[:4])
        await b.close()
    print(f'\n{sum(results)}/{len(results)} passed')
    if not all(results): raise SystemExit(1)

asyncio.run(main())
