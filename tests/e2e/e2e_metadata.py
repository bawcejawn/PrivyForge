# Browser tests for /remove-photo-metadata/. Run after `npm run build && npx vite preview`.
# Fixtures are generated here with Pillow (JPEG with GPS EXIF + orientation 6 + ICC profile,
# PNG with tEXt chunks); the HEIC one comes from tests/e2e/fx-heic/.
import asyncio, io, os, struct, zipfile
from playwright.async_api import async_playwright
from PIL import Image, ImageCms, TiffImagePlugin
from PIL.PngImagePlugin import PngInfo

BASE = os.environ.get('BASE', 'http://localhost:4173')
HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, 'out', 'metadata'); os.makedirs(OUT, exist_ok=True)
FXH = os.path.join(HERE, 'fx-heic')
results = []
def check(name, ok, info=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name, str(info)[:220])

R = TiffImagePlugin.IFDRational

def make_jpeg(path):
    # 120x80 stored landscape, orientation 6 => should display as 80x120 portrait.
    im = Image.new('RGB', (120, 80), (30, 120, 200))
    for x in range(20):
        for y in range(20): im.putpixel((x, y), (220, 30, 30))
    ex = Image.Exif()
    ex[0x0112] = 6
    ex[0x010f] = 'TestCam'
    ex[0x0110] = 'TestCam Model 7'
    ex[0x0131] = 'FirmWare 1.2'
    sub = ex.get_ifd(0x8769)
    sub[0x9003] = '2024:05:12 14:03:22'
    sub[0xa431] = 'BODY-SN-424242'
    gps = ex.get_ifd(0x8825)
    gps[1] = 'N'; gps[2] = (R(37), R(46), R(2964, 100))
    gps[3] = 'W'; gps[4] = (R(122), R(25), R(984, 100))
    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
    im.save(path, 'JPEG', quality=90, exif=ex.tobytes(), icc_profile=icc)
    return icc

def make_png(path):
    im = Image.new('RGB', (64, 40), (10, 200, 90))
    info = PngInfo(); info.add_text('Author', 'Jane Doe'); info.add_text('Comment', 'kitchen table')
    im.save(path, 'PNG', pnginfo=info)

def jpeg_scan(b):
    """Bytes from the first SOS marker to the end of EOI (entropy data included)."""
    o = 2
    while o < len(b):
        assert b[o] == 0xff, f'bad marker at {o}'
        m = b[o + 1]
        if m == 0xda: return b[o:b.rindex(b'\xff\xd9') + 2]
        o += 2 + struct.unpack('>H', b[o + 2:o + 4])[0]
    raise ValueError('no SOS')

def jpeg_markers(b):
    out, o = [], 2
    while o < len(b) and b[o + 1] != 0xda:
        n = struct.unpack('>H', b[o + 2:o + 4])[0]
        out.append((b[o + 1], b[o + 4:o + 2 + n])); o += 2 + n
    return out

def png_chunks(b):
    out, o = [], 8
    while o < len(b):
        n = struct.unpack('>I', b[o:o + 4])[0]
        out.append((b[o + 4:o + 8].decode('latin1'), b[o + 8:o + 8 + n])); o += 12 + n
    return out

async def card_text(page, name):
    return await page.locator('.mcard', has=page.locator('.name', has_text=name)).inner_text()

async def download(page, name):
    card = page.locator('.mcard', has=page.locator('.name', has_text=name))
    async with page.expect_download() as d: await card.locator('.act .btn').click()
    dl = await d.value
    return dl.suggested_filename, open(await dl.path(), 'rb').read()

async def main():
    jpg = os.path.join(OUT, 'gps-photo.jpg'); icc = make_jpeg(jpg)
    png = os.path.join(OUT, 'notes.png'); make_png(png)
    bad = os.path.join(OUT, 'document.txt'); open(bad, 'w').write('just text, not a photo')
    src_jpg = open(jpg, 'rb').read(); src_png = open(png, 'rb').read()
    check('fixture: JPEG really has GPS + orientation 6', Image.open(jpg).getexif().get_ifd(0x8825) and Image.open(jpg).getexif()[0x0112] == 6)

    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(accept_downloads=True, service_workers='block')
        external, posts, errors = [], [], []
        ctx.on('request', lambda r: (
            external.append(r.url) if not r.url.startswith(BASE) and not r.url.startswith(('blob:', 'data:')) else None,
            posts.append(f'{r.method} {r.url}') if r.method != 'GET' else None))
        page = await ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

        await page.goto(f'{BASE}/remove-photo-metadata/')
        check('page: h1', 'Remove location and metadata' in await page.inner_text('h1'))
        check('page: no map links/tiles', await page.locator('a[href*="maps"], a[href*="openstreetmap"], iframe').count() == 0)
        await page.set_input_files('#drop input', [jpg, png, bad])
        await page.wait_for_function("document.querySelectorAll('.mcard .act .btn').length + document.querySelectorAll('.mcard-err').length >= 3", timeout=30000)

        # ---- JPEG: what the UI shows
        t = await card_text(page, 'gps-photo.jpg')
        loc = page.locator('.mcard', has=page.locator('.name', has_text='gps-photo.jpg')).locator('.mf-location')
        check('jpg: location shown in warning style', await loc.count() == 1 and '37.7749, -122.4194' in await loc.inner_text(), t.replace('\n', ' | '))
        check('jpg: explains why location matters', 'anyone with this file can see where it was taken' in t)
        check('jpg: date, camera, serial, software shown',
              all(s in t for s in ['2024-05-12 14:03:22', 'TestCam Model 7', 'BODY-SN-424242', 'FirmWare 1.2']), t.replace('\n', ' | '))
        check('jpg: says orientation + colour profile kept', 'rotated 90°' in t and 'Colour profile' in t)
        check('jpg: before/after sizes shown', '→' in t and 'KB' in t)
        check('no map links in results', await page.locator('.mcard a').count() == 0)

        # ---- JPEG: the downloaded file
        name, out = await download(page, 'gps-photo.jpg')
        open(os.path.join(OUT, 'clean.jpg'), 'wb').write(out)
        im = Image.open(io.BytesIO(out)); im.load()
        ex = im.getexif()
        check('jpg out: named -clean.jpg, valid JPEG', name == 'gps-photo-clean.jpg' and im.format == 'JPEG', name)
        check('jpg out: EXIF holds ONLY orientation 6', dict(ex) == {0x0112: 6}, dict(ex))
        check('jpg out: no GPS / Exif sub-IFDs', not ex.get_ifd(0x8825) and not ex.get_ifd(0x8769))
        check('jpg out: no identifying strings left', not any(s in out for s in [b'TestCam', b'BODY-SN', b'FirmWare', b'2024:05:12']))
        check('jpg out: scan data byte-identical', jpeg_scan(out) == jpeg_scan(src_jpg), (len(jpeg_scan(out)), len(jpeg_scan(src_jpg))))
        check('jpg out: ICC profile kept', im.info.get('icc_profile') == icc)
        check('jpg out: pixels identical after decode', im.tobytes() == Image.open(jpg).convert('RGB').tobytes())
        check('jpg out: smaller than original', len(out) < len(src_jpg), (len(out), len(src_jpg)))
        markers = [m for m, _ in jpeg_markers(out)]
        check('jpg out: only APP0/APP1(orientation)/APP2(ICC) + tables', all(m in (0xe0, 0xe1, 0xe2, 0xdb, 0xc0, 0xc2, 0xc4, 0xdd) for m in markers), [hex(m) for m in markers])
        # The browser must display it portrait (EXIF orientation honoured).
        dims = await page.evaluate("""() => new Promise((res) => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.src = document.querySelector('.mcard .mthumb img').src; })""")
        check('jpg out: browser displays it rotated upright (80x120)', dims == [80, 120], dims)

        # ---- PNG with tEXt
        t = await card_text(page, 'notes.png')
        check('png: text keys shown', 'Author' in t and 'Comment' in t, t.replace('\n', ' | '))
        check('png: no location warning', 'Location' not in t)
        name, out = await download(page, 'notes.png')
        ch = png_chunks(out)
        types = [c for c, _ in ch]
        check('png out: no tEXt/iTXt/zTXt/tIME/eXIf', not set(types) & {'tEXt', 'iTXt', 'zTXt', 'tIME', 'eXIf'}, types)
        src_ch = png_chunks(src_png)
        check('png out: IHDR + IDAT byte-identical', [c for c in ch if c[0] in ('IHDR', 'IDAT')] == [c for c in src_ch if c[0] in ('IHDR', 'IDAT')])
        check('png out: no "Jane Doe"', b'Jane' not in out and name == 'notes-clean.png')
        Image.open(io.BytesIO(out)).load()

        # ---- Unsupported file
        t = await card_text(page, 'document.txt')
        check('txt: clear error, no download', 'isn’t a JPG, PNG, WebP or HEIC' in t and await page.locator('.mcard', has=page.locator('.name', has_text='document.txt')).locator('.act .btn').count() == 0, t)

        # ---- ZIP of the two clean files
        check('zip button visible with 2 results', await page.is_visible('#zip'))
        async with page.expect_download() as d: await page.click('#zip')
        z = zipfile.ZipFile(await (await d.value).path())
        check('zip: both clean files', sorted(z.namelist()) == ['gps-photo-clean.jpg', 'notes-clean.png'], z.namelist())
        s = await page.inner_text('#summary')
        check('summary: counts + location removed', '2 photos cleaned' in s and 'Location removed from 1' in s, s)
        await page.set_viewport_size({'width': 1280, 'height': 900})
        await page.screenshot(path=os.path.join(OUT, 'desktop.png'), full_page=True)
        await page.set_viewport_size({'width': 390, 'height': 844})
        await page.screenshot(path=os.path.join(OUT, 'mobile.png'), full_page=True)
        await page.set_viewport_size({'width': 1280, 'height': 900})

        # ---- HEIC -> clean JPG (Chromium: lazily loaded same-origin decoder)
        heic = os.path.join(FXH, 'rotated.heic')
        if os.path.exists(heic):
            await page.click('#clear')
            await page.set_input_files('#drop input', [heic])
            await page.wait_for_function("document.querySelectorAll('.mcard .act .btn').length + document.querySelectorAll('.mcard-err').length >= 1", timeout=180000)
            t = await card_text(page, 'rotated.heic')
            check('heic: explains conversion to JPG (no false "already clean")', 'converted to JPG' in t and 'already clean' not in t, t.replace('\n', ' | '))
            name, out = await download(page, 'rotated.heic')
            im = Image.open(io.BytesIO(out)); im.load()
            check('heic out: clean JPEG, no EXIF', im.format == 'JPEG' and not im.info.get('exif') and name == 'rotated-clean.jpg', (name, list(im.info)))

        # ---- WebP with EXIF (GPS + orientation) and XMP
        webp = os.path.join(OUT, 'travel.webp')
        ex = Image.open(jpg).getexif()
        Image.new('RGB', (60, 30), (200, 180, 20)).save(webp, 'WEBP', lossless=True, exif=ex.tobytes(), xmp=b'<x:xmpmeta xmlns:x="adobe:ns:meta/">secret-xmp</x:xmpmeta>')
        src_webp = open(webp, 'rb').read()
        await page.click('#clear')
        await page.set_input_files('#drop input', [webp])
        await page.wait_for_function("document.querySelectorAll('.mcard .act .btn').length + document.querySelectorAll('.mcard-err').length >= 1", timeout=30000)
        t = await card_text(page, 'travel.webp')
        check('webp: location + XMP shown', '37.7749, -122.4194' in t and 'XMP' in t, t.replace('\n', ' | '))
        name, out = await download(page, 'travel.webp')
        im = Image.open(io.BytesIO(out)); im.load()
        check('webp out: only orientation EXIF, no XMP', dict(im.getexif()) == {0x0112: 6} and b'secret-xmp' not in out and b'TestCam' not in out, dict(im.getexif()))
        check('webp out: RIFF size correct, pixels identical', struct.unpack('<I', out[4:8])[0] == len(out) - 8 and im.convert('RGB').tobytes() == Image.open(webp).convert('RGB').tobytes())

        check('ZERO cross-origin requests', not external, external[:4])
        check('ZERO non-GET requests', not posts, posts[:4])
        check('no JS errors', not errors, errors[:4])
        await b.close()
    print(f'\n{sum(results)}/{len(results)} passed')
    if not all(results): raise SystemExit(1)

asyncio.run(main())
