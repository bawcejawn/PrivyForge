# Browser tests for the image landing pages (convert, resize, target size, HEIC).
# Run after `npm run build && npx vite preview --port 4173` (or set BASE).
import asyncio, os, base64
from playwright.async_api import async_playwright
from PIL import Image

BASE = os.environ.get('BASE', 'http://localhost:4173')
FX = os.path.join(os.path.dirname(__file__), 'fx')
OUT = os.path.join(os.path.dirname(__file__), 'out'); os.makedirs(OUT, exist_ok=True)
results = []
def check(name, ok, info=''):
    results.append(ok); print(('PASS ' if ok else 'FAIL ') + name, str(info)[:220])

# A real 320x240 HEIC (made with libheif). Chromium has no native HEIC decoder.
HEIC = ('AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAVZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABegABAAAAAAAAAJ8AAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAA5waXRtAAAAAAABAAAA1mlwcnAAAAC3aXBjbwAAAHhodmNDAQNwAAAAkAAAAAAAPPAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAPLoCQGEAAQArQgEBA3AAAAMAkAAAAwAAAwA8oAoIDxZbqSSmubgIaDAgAAADAyAAAAMAIWIAAQAHRAHBcrBiQAAAABNjb2xybmNseAABAA0ABoAAAAAUaXNwZQAAAAAAAAFAAAAA8AAAABBwaXhpAAAAAAMICAgAAAAXaXBtYQAAAAAAAAABAAEEgQIDBAAAAKdtZGF0AAAAmygBrwnIamSO0tG9QJKOxqL8JUn4Vf2bk2sBlsCcuyUKy0Lyag483NHjsCk8RbwBrgKuovJzZZN0kAMDsOJg2sWE8y/8iFvMNyULoy88bNITXgAEZA+Bw5jsfhSVQBH+R/xCL/RD9gBcrH07efCc/YqH6GbGOIAdswefcJPsdhKTJ23Lr/NRuyrKrJnCz/TwAAADAAADAAADAAFL')

PAGES = ['/jpg-to-webp/', '/png-to-jpg/', '/heic-to-jpg/', '/resize-image/',
         '/compress-image-to-100kb/', '/compress-image-to-50kb/', '/compress-image-to-20kb/']

def is_jpeg(b): return b[:3] == b'\xff\xd8\xff'
def is_webp(b): return b[:4] == b'RIFF' and b[8:12] == b'WEBP'

async def add_and_wait(page, files, n=None):
    await page.set_input_files('#drop input', files)
    n = n or len(files)
    await page.wait_for_function(f"document.querySelectorAll('.file .btn').length + document.querySelectorAll('.file .file-err').length >= {n}", timeout=180000)

async def download(page, i=0):
    async with page.expect_download() as d: await page.locator('.file .btn').nth(i).click()
    dl = await d.value
    path = await dl.path()
    return dl.suggested_filename, open(path, 'rb').read(), path

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(accept_downloads=True)
        page = await ctx.new_page()
        external, posts, errors = [], [], []
        page.on('request', lambda r: (external.append(r.url) if not r.url.startswith(BASE) and not r.url.startswith(('blob:', 'data:')) else None, posts.append(r.url) if r.method != 'GET' else None))
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

        # ---- Target size: photo.jpg (2400x1600, ~368 KB) under 100 / 50 / 20 KB, as valid JPEGs
        for kb in (100, 50, 20):
            await page.goto(f'{BASE}/compress-image-to-{kb}kb/')
            await add_and_wait(page, [f'{FX}/photo.jpg'])
            meta = await page.locator('.file .meta').inner_text()
            name, data, path = await download(page)
            im = Image.open(path); im.load()
            check(f'target {kb} KB: file <= {kb * 1000} bytes', len(data) <= kb * 1000, f'{len(data)} bytes, {name}')
            check(f'target {kb} KB: valid JPEG', is_jpeg(data) and im.format == 'JPEG' and name.endswith('.jpg'), f'{im.format} {im.size}')
            check(f'target {kb} KB: not wastefully small (>= 80% of target)', len(data) >= kb * 800, len(data))
            check(f'target {kb} KB: shows size, quality and dimensions', f'under {kb} KB' in meta and 'quality ' in meta and f'{im.size[0]}×{im.size[1]}' in meta, meta)
        # custom target + WebP option on the same page
        await page.fill('#target', '30'); await page.select_option('#format', 'webp')
        await page.wait_for_function("document.querySelector('.file .meta').innerText.includes('under 30 KB') && document.querySelector('.file .btn')", timeout=120000)
        name, data, _ = await download(page)
        check('target: custom 30 KB + WebP output', len(data) <= 30000 and is_webp(data) and name.endswith('.webp'), f'{len(data)} {name}')
        # PNG with transparency through a target page -> JPEG flattened to white
        await page.goto(f'{BASE}/compress-image-to-100kb/')
        await add_and_wait(page, [f'{FX}/logo.png'])
        name, data, _ = await download(page)
        check('target: PNG input -> JPEG under target', is_jpeg(data) and len(data) <= 100000, f'{len(data)} {name}')
        await page.screenshot(path=f'{OUT}/img-target.png', full_page=True)

        # ---- JPG -> WebP
        await page.goto(f'{BASE}/jpg-to-webp/')
        await add_and_wait(page, [f'{FX}/photo.jpg'])
        name, data, path = await download(page)
        im = Image.open(path)
        check('jpg->webp: output is WebP', is_webp(data) and im.format == 'WEBP' and name == 'photo.webp', f'{name} {im.format} {len(data)}')
        check('jpg->webp: same dimensions, smaller', im.size == (2400, 1600) and len(data) < os.path.getsize(f'{FX}/photo.jpg'), f'{im.size} {len(data)}')

        # ---- PNG -> JPG (transparency becomes white)
        await page.goto(f'{BASE}/png-to-jpg/')
        check('png->jpg: page says transparency becomes white', 'transparent areas are filled with white' in (await page.inner_text('.tool')))
        await add_and_wait(page, [f'{FX}/logo.png'])
        meta = await page.locator('.file .meta').inner_text()
        name, data, path = await download(page)
        src = Image.open(f'{FX}/logo.png').convert('RGBA'); out = Image.open(path).convert('RGB')
        clear = [(x, y) for x in range(0, src.width, 7) for y in range(0, src.height, 7) if src.getpixel((x, y))[3] == 0]
        whites = sum(1 for xy in clear if min(out.getpixel(xy)) >= 245)
        check('png->jpg: output is JPEG named logo.jpg', is_jpeg(data) and Image.open(path).format == 'JPEG' and name == 'logo.jpg', name)
        check('png->jpg: transparent pixels became white', clear and whites / len(clear) > 0.98, f'{whites}/{len(clear)} white')
        check('png->jpg: row notes transparency -> white', 'transparency → white' in meta, meta)

        # ---- Resize
        await page.goto(f'{BASE}/resize-image/')
        await page.fill('#maxw', '800')
        await add_and_wait(page, [f'{FX}/photo.jpg'])
        name, data, path = await download(page)
        check('resize: 800px width keeps aspect (800x533)', Image.open(path).size == (800, 533) and name == 'photo-800x533.jpg', f'{Image.open(path).size} {name}')
        await page.uncheck('#keep'); await page.fill('#maxw', '300'); await page.fill('#maxh', '300'); await page.dispatch_event('#maxh', 'change')
        await page.wait_for_function("document.querySelector('.file .meta').innerText.includes('300×300') && document.querySelector('.file .btn')", timeout=60000)
        name, data, path = await download(page)
        check('resize: aspect off stretches to exactly 300x300', Image.open(path).size == (300, 300), Image.open(path).size)
        await page.check('#keep'); await page.fill('#maxh', ''); await page.click('[data-preset-w="400"]')
        await page.wait_for_function("document.querySelector('.file .meta').innerText.includes('400×267') && document.querySelector('.file .btn')", timeout=60000)
        check('resize: quick width preset (400 -> 400x267)', True)
        await page.fill('#maxw', '4800'); await page.check('#upscale')
        await page.wait_for_function("document.querySelector('.file .meta').innerText.includes('4800×3200') && document.querySelector('.file .btn')", timeout=120000)
        check('resize: allow enlarging (4800x3200)', True)

        # ---- HEIC on Chromium: no native decoder, so the lazily loaded libheif decoder converts it
        # (full coverage in e2e_heic.py)
        await page.goto(f'{BASE}/heic-to-jpg/')
        await page.wait_for_function("document.documentElement.dataset.heic", timeout=10000)
        state = await page.evaluate("document.documentElement.dataset.heic")
        check('heic: Chromium uses the built-in (wasm) decoder', state == 'wasm', state)
        check('heic: decoder notice visible, no Safari-only message', await page.is_visible('#heic-decoder') and not await page.locator('#heic-unsupported').count())
        heic = os.path.join(OUT, 'sample.heic'); open(heic, 'wb').write(base64.b64decode(HEIC))
        await add_and_wait(page, [heic])
        name, data, path = await download(page)
        check('heic: 320x240 HEIC converts to a 320x240 JPEG', is_jpeg(data) and Image.open(path).size == (320, 240) and name == 'sample.jpg', f'{name} {Image.open(path).size}')
        await page.screenshot(path=f'{OUT}/img-heic.png', full_page=True)

        # ---- /compress-image/ deep links still work
        await page.goto(f'{BASE}/compress-image/?format=webp')
        check('compress-image ?format=webp still selects WebP', await page.eval_on_selector('#format', 'e => e.value') == 'webp')
        await page.goto(f'{BASE}/compress-image/?resize=1')
        check('compress-image ?resize=1 still focuses max width', await page.evaluate("document.activeElement && document.activeElement.id") == 'maxw')
        await page.goto(f'{BASE}/compress-image/?format=bogus')
        check('compress-image ignores unknown ?format', await page.eval_on_selector('#format', 'e => e.value') == 'auto')

        # ---- Every page: SEO basics, screenshots, no horizontal scroll on mobile
        titles = set()
        m = await b.new_page(viewport={'width': 390, 'height': 844})
        m.on('pageerror', lambda e: errors.append(str(e)))
        for path in PAGES:
            await page.goto(BASE + path)
            t = await page.title(); titles.add(t)
            d = await page.get_attribute('meta[name=description]', 'content')
            canon = await page.get_attribute('link[rel=canonical]', 'href')
            ld = await page.locator('script[type="application/ld+json"]').all_inner_texts()
            words = len((await page.text_content('article')).split())  # includes FAQ answers inside <details>
            check(f'{path}: meta + canonical + JSON-LD + copy', len(d) <= 155 and canon.endswith(path) and any('WebApplication' in x and 'BreadcrumbList' in x for x in ld) and 600 <= words, f'{len(t)}ch title, {len(d)}ch desc, {words} words')
            slug = path.strip('/')
            await page.screenshot(path=f'{OUT}/img-{slug}.png')
            await m.goto(BASE + path); await m.screenshot(path=f'{OUT}/img-{slug}-mobile.png', full_page=True)
            sw = await m.evaluate('document.documentElement.scrollWidth')
            check(f'{path}: no horizontal scroll at 390px', sw <= 390, sw)
        check('unique titles', len(titles) == len(PAGES))

        check('ZERO external requests', not external, external[:4])
        check('ZERO non-GET requests (nothing uploaded)', not posts, posts[:4])
        check('no JS errors', not errors, errors[:4])
        await b.close()
    print(f'\n{sum(results)}/{len(results)} passed')
    if not all(results): raise SystemExit(1)

asyncio.run(main())
