# Browser tests for HEIC/HEIF support on Chromium (no native HEIC decoder, so the lazily
# loaded heic-to/libheif decoder is used). Run after `npm run build && npx vite preview`.
# Fixtures: tests/e2e/fx-heic/*.heic (committed; regenerate with fx-heic/make_heic.py) and
# tests/e2e/fx/ (python tests/e2e/make_fixtures.py).
import asyncio, os, shutil
from playwright.async_api import async_playwright
from PIL import Image

BASE = os.environ.get('BASE', 'http://localhost:4173')
HERE = os.path.dirname(__file__)
FXH = os.path.join(HERE, 'fx-heic')
FX = os.path.join(HERE, 'fx')
OUT = os.path.join(HERE, 'out'); os.makedirs(OUT, exist_ok=True)
DECODER = '/vendor/heic-to/'
results = []
def check(name, ok, info=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name, str(info)[:220])

def is_jpeg(b): return b[:3] == b'\xff\xd8\xff'
def is_webp(b): return b[:4] == b'RIFF' and b[8:12] == b'WEBP'
def reddish(px): return px[0] > 150 and px[1] < 90 and px[2] < 90

async def add_and_wait(page, files, total):
    await page.set_input_files('#drop input', files)
    await page.wait_for_function(f"document.querySelectorAll('.file .btn').length + document.querySelectorAll('.file .file-err').length >= {total}", timeout=180000)

async def download(page, i=0):
    async with page.expect_download() as d: await page.locator('.file .btn').nth(i).click()
    dl = await d.value
    path = await dl.path()
    return dl.suggested_filename, open(path, 'rb').read(), path

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        external, posts, errors, decoder_hits = [], [], [], []
        def watch(ctx):
            # Context-level: also sees requests made by workers.
            ctx.on('request', lambda r: (
                external.append(r.url) if not r.url.startswith(BASE) and not r.url.startswith(('blob:', 'data:')) else None,
                posts.append(f'{r.method} {r.url}') if r.method != 'GET' else None,
                decoder_hits.append(r.url) if DECODER in r.url else None))
        def watch_page(page):
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            return page

        # ---- 1. Pages and files that aren't HEIC never load the decoder (fresh context each time)
        ctx = await b.new_context(accept_downloads=True, service_workers='block'); watch(ctx)
        page = watch_page(await ctx.new_page())
        for path in ['/', '/compress-image/', '/jpg-to-webp/', '/png-to-jpg/', '/resize-image/', '/compress-image-to-50kb/', '/heic-to-jpg/']:
            await page.goto(BASE + path); await page.wait_for_load_state('networkidle')
        check('decoder not requested on page load (7 image pages incl. HEIC page)', not decoder_hits, decoder_hits)
        await page.goto(f'{BASE}/compress-image/')
        await add_and_wait(page, [f'{FX}/photo.jpg', f'{FX}/logo.png'], 2)
        await page.goto(f'{BASE}/compress-image-to-50kb/')
        await add_and_wait(page, [f'{FX}/photo.jpg'], 1)
        await page.wait_for_load_state('networkidle')
        check('decoder not requested for JPG/PNG files', not decoder_hits, decoder_hits)

        # ---- 2. HEIC page on Chromium: no native decoder -> notice + libheif
        await page.goto(f'{BASE}/heic-to-jpg/')
        await page.wait_for_function('document.documentElement.dataset.heic', timeout=10000)
        check('heic page: Chromium uses the wasm decoder', await page.evaluate('document.documentElement.dataset.heic') == 'wasm')
        note = await page.inner_text('#heic-decoder') if await page.is_visible('#heic-decoder') else ''
        check('heic page: decoder notice visible, honest about size + no upload', '0.8 MB' in note and 'aren’t uploaded' in note, note)
        check('heic page: no Safari-only messaging left', 'Open this page in Safari' not in await page.content() and not await page.locator('#heic-unsupported').count())

        await add_and_wait(page, [f'{FXH}/photo.heic'], 1)
        check('heic: decoder loaded exactly once, same origin', len(decoder_hits) == 1 and decoder_hits[0].startswith(BASE), decoder_hits)
        meta = await page.locator('.file .meta').nth(0).inner_text()
        name, data, path = await download(page, 0)
        im = Image.open(path); im.load()
        check('heic->jpg: valid JPEG named photo.jpg', is_jpeg(data) and im.format == 'JPEG' and name == 'photo.jpg', f'{name} {im.format}')
        check('heic->jpg: right dimensions (1200x800)', im.size == (1200, 800) and '1200×800' in meta, f'{im.size} {meta}')
        rgb = im.convert('RGB')
        check('heic->jpg: real pixels (red square top-left, sky blue above hills)',
              reddish(rgb.getpixel((150, 130))) and rgb.getpixel((600, 40))[2] > 180, [rgb.getpixel((150, 130)), rgb.getpixel((600, 40))])
        check('heic->jpg: no EXIF/GPS in output', not im.info.get('exif'), list(im.info))
        thumb = await page.locator('.file .thumb img').count()
        check('heic: row shows a thumbnail of the converted photo', thumb >= 1, thumb)

        # rotation (irot) applied: stored 600x400 + rotate 90° CW -> 400x600, square top-right
        await add_and_wait(page, [f'{FXH}/rotated.heic'], 2)
        _, data, path = await download(page, 1)
        im = Image.open(path).convert('RGB')
        check('heic: rotation applied (400x600 portrait, red square top-right)', im.size == (400, 600) and reddish(im.getpixel((335, 84))) and not reddish(im.getpixel((84, 84))), [im.size, im.getpixel((335, 84))])

        # multi-image file: the primary image (2nd item, 640x480) is decoded, not the first (320x240)
        await add_and_wait(page, [f'{FXH}/burst.heic'], 3)
        _, data, path = await download(page, 2)
        check('heic: multi-image file -> primary image (640x480)', Image.open(path).size == (640, 480), Image.open(path).size)

        # damaged files: friendly per-file message, and the decoder keeps working afterwards
        bad = os.path.join(OUT, 'damaged.heic'); open(bad, 'wb').write(open(f'{FXH}/photo.heic', 'rb').read()[:6000])
        junk = os.path.join(OUT, 'junk.heic'); open(junk, 'wb').write(b'definitely not a photo' * 10)
        await add_and_wait(page, [bad, junk], 5)
        errs = await page.locator('.file .file-err').all_inner_texts()
        check('heic: damaged/junk files show a friendly HEIC message', len(errs) == 2 and all('Couldn’t read this HEIC photo' in e for e in errs), errs)
        await add_and_wait(page, [f'{FXH}/photo.heic'], 6)
        check('heic: decoder still works after a damaged file', await page.locator('.file .btn').count() == 4)

        # settings still apply: max width re-runs every photo
        await page.fill('#maxw', '600'); await page.dispatch_event('#maxw', 'change')
        await page.wait_for_function("[...document.querySelectorAll('.file .meta')].some(m => m.innerText.includes('600×400') && m.querySelector('.save'))", timeout=120000)
        _, data, path = await download(page, 0)
        check('heic: max width 600 -> 600x400 JPEG', Image.open(path).size == (600, 400) and is_jpeg(data), Image.open(path).size)
        check('heic: decoder still loaded only once', len(decoder_hits) == 1, len(decoder_hits))
        await page.screenshot(path=f'{OUT}/heic-converted.png', full_page=True)

        # ---- 3. HEIC on the other image tools
        await page.goto(f'{BASE}/compress-image-to-50kb/')
        await add_and_wait(page, [f'{FXH}/photo.heic'], 1)
        meta = await page.locator('.file .meta').inner_text()
        name, data, path = await download(page)
        im = Image.open(path); im.load()
        check('compress-image-to-50kb: HEIC -> JPEG under 50 KB', is_jpeg(data) and len(data) <= 50000 and 'under 50 KB' in meta, f'{len(data)} bytes {name} {meta}')
        check('compress-image-to-50kb: named photo-under-50kb.jpg, dims match row', name == 'photo-under-50kb.jpg' and f'{im.size[0]}×{im.size[1]}' in meta, f'{name} {im.size}')

        await page.goto(f'{BASE}/compress-image/?format=webp')
        await add_and_wait(page, [f'{FXH}/photo.heic'], 1)
        name, data, path = await download(page)
        check('compress-image: HEIC -> WebP', is_webp(data) and name == 'photo-min.webp' and Image.open(path).size == (1200, 800), f'{name} {len(data)}')
        await page.goto(f'{BASE}/compress-image/')
        await add_and_wait(page, [f'{FXH}/photo.heic'], 1)
        name, data, _ = await download(page)
        check('compress-image: HEIC with "Keep original" -> JPEG', is_jpeg(data) and name == 'photo-min.jpg', name)
        # HEIC with a misleading .jpg name is recognised by its content
        fake = os.path.join(OUT, 'iphone-export.jpg'); shutil.copy(f'{FXH}/photo.heic', fake)
        await add_and_wait(page, [fake], 2)
        name, data, path = await download(page, 1)
        check('compress-image: HEIC named .jpg is sniffed and converted', is_jpeg(data) and Image.open(path).size == (1200, 800), name)

        await page.goto(f'{BASE}/resize-image/')
        await page.fill('#maxw', '300')
        await add_and_wait(page, [f'{FXH}/photo.heic'], 1)
        name, data, path = await download(page)
        check('resize-image: HEIC -> 300x200 JPEG', Image.open(path).size == (300, 200) and is_jpeg(data) and name == 'photo-300x200.jpg', f'{name} {Image.open(path).size}')
        await ctx.close()

        # ---- 4. Offline after first use (service worker caches the decoder)
        ctx = await b.new_context(accept_downloads=True); watch(ctx)
        page = watch_page(await ctx.new_page())
        await page.goto(f'{BASE}/heic-to-jpg/')
        await page.evaluate('navigator.serviceWorker.ready.then(() => true)')
        await page.reload(); await page.wait_for_function('navigator.serviceWorker.controller', timeout=15000)
        await add_and_wait(page, [f'{FXH}/photo.heic'], 1)
        await ctx.set_offline(True)
        await page.reload()
        await add_and_wait(page, [f'{FXH}/burst.heic'], 1)
        ok = await page.locator('.file .btn').count() == 1
        check('heic: works offline after first use (decoder cached by the service worker)', ok, await page.locator('.file .meta').all_inner_texts())
        await ctx.set_offline(False)

        # ---- 5. Layout
        for w, tag in ((1280, 'desktop'), (390, 'mobile')):
            await page.set_viewport_size({'width': w, 'height': 900})
            await page.goto(f'{BASE}/heic-to-jpg/')
            await page.wait_for_function('document.documentElement.dataset.heic')
            await page.screenshot(path=f'{OUT}/heic-{tag}.png', full_page=True)
            sw = await page.evaluate('document.documentElement.scrollWidth')
            check(f'heic page: no horizontal scroll at {w}px', sw <= w, sw)
        d = await page.get_attribute('meta[name=description]', 'content')
        words = len((await page.text_content('article')).split())
        check('heic page: meta description <= 155 chars, 600-1000 words', len(d) <= 155 and 600 <= words <= 1000, f'{len(d)} chars, {words} words')
        faq = await page.locator('script[type="application/ld+json"]').all_inner_texts()
        check('heic page: FAQ schema matches new FAQ (no Safari-only question)', any('Does this work in Chrome, Edge and Firefox?' in x for x in faq) and not any('Why doesn’t this work in Chrome' in x for x in faq))
        await ctx.close()

        check('ZERO cross-origin requests', not external, external[:4])
        check('ZERO non-GET requests (nothing uploaded)', not posts, posts[:4])
        check('no JS errors', not errors, errors[:4])
        await b.close()
    print(f'\n{sum(results)}/{len(results)} passed')
    if not all(results): raise SystemExit(1)

asyncio.run(main())
