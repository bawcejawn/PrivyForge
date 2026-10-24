import asyncio, os, sys, zipfile, io, json
from playwright.async_api import async_playwright
import cv2
from pypdf import PdfReader

BASE = 'http://localhost:4173'
FX = os.path.join(os.path.dirname(__file__), 'fx')
OUT = os.path.join(os.path.dirname(__file__), 'out'); os.makedirs(OUT, exist_ok=True)
results = []
def check(name, ok, info=''):
    results.append((name, ok, info)); print(('PASS ' if ok else 'FAIL ') + name, info)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(accept_downloads=True)
        page = await ctx.new_page()
        external, posts, errors = [], [], []
        page.on('request', lambda r: (external.append(r.url) if not r.url.startswith(BASE) and not r.url.startswith(('blob:', 'data:')) else None, posts.append(r.url) if r.method != 'GET' else None))
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

        # ---- Image compressor
        for fmt in ['auto', 'webp', 'avif', 'jpeg', 'png']:
            await page.goto(f'{BASE}/compress-image/')
            await page.select_option('#format', fmt)
            await page.set_input_files('#drop input', [f'{FX}/photo.jpg', f'{FX}/photo.png', f'{FX}/logo.png'])
            await page.wait_for_function("document.querySelectorAll('.file .btn').length + document.querySelectorAll('.file .out span[style]').length >= 3", timeout=120000)
            metas = await page.locator('.file .meta').all_inner_texts()
            check(f'image {fmt}: 3 results', len(metas) == 3, ' | '.join(m.replace('\n', ' ') for m in metas))
            async with page.expect_download() as d:
                await page.click('#zip')
            dl = await d.value
            z = zipfile.ZipFile(await dl.path())
            names = z.namelist()
            check(f'image {fmt}: zip', len(names) == 3, ', '.join(f'{n}={z.getinfo(n).file_size}' for n in names))
            if fmt == 'webp':
                with open(f'{OUT}/photo-min.webp', 'wb') as f: f.write(z.read([n for n in names if n.startswith('photo-min')][0]))
        # resize check
        await page.goto(f'{BASE}/compress-image/?format=webp')
        await page.fill('#maxw', '800');
        await page.set_input_files('#drop input', [f'{FX}/photo.jpg'])
        await page.wait_for_selector('.file .btn', timeout=60000)
        meta = await page.locator('.file .meta').inner_text()
        check('image resize to 800w', '800×533' in meta, meta)
        await page.click('.file .thumb'); await page.wait_for_selector('.compare-box .after img')
        check('compare overlay opens', await page.is_visible('.compare-box'))
        await page.keyboard.press('Escape')

        # ---- Merge
        await page.goto(f'{BASE}/merge-pdf/')
        await page.set_input_files('#drop input', [f'{FX}/a.pdf', f'{FX}/b.pdf'])
        await page.wait_for_selector('#run:not([disabled])')
        async with page.expect_download() as d: await page.click('#run')
        r = PdfReader(await (await d.value).path())
        texts = [pg.extract_text().strip() for pg in r.pages]
        check('merge: 5 pages in order', len(r.pages) == 5 and texts[0].startswith('a.pdf page 1') and texts[2].startswith('b.pdf page 1'), str(texts))

        # ---- Split
        await page.goto(f'{BASE}/split-pdf/')
        await page.set_input_files('#drop input', [f'{FX}/b.pdf'])
        await page.wait_for_selector('#run:not([disabled])')
        await page.fill('#ranges', '1-2, 3')
        async with page.expect_download() as d: await page.click('#run')
        z = zipfile.ZipFile(await (await d.value).path())
        counts = {n: len(PdfReader(io.BytesIO(z.read(n))).pages) for n in z.namelist()}
        check('split ranges 1-2,3', sorted(counts.values()) == [1, 2], str(counts))
        await page.check('input[value=one]'); await page.fill('#ranges', '3,1')
        async with page.expect_download() as d: await page.click('#run')
        r = PdfReader(await (await d.value).path())
        check('extract 3,1 into one (ordered)', len(r.pages) == 2 and 'page 3' in r.pages[0].extract_text(), r.pages[0].extract_text()[:20])
        await page.fill('#ranges', '9')
        await page.click('#run')
        check('bad range shows error', 'between 1 and 3' in await page.inner_text('#status'))

        # ---- Compress PDF
        for level in ['balanced', 'strong', 'lossless']:
            await page.goto(f'{BASE}/compress-pdf/')
            await page.set_input_files('#drop input', [f'{FX}/a.pdf'])
            await page.wait_for_selector('#run:not([disabled])')
            await page.check(f'input[value={level}]')
            async with page.expect_download(timeout=120000) as d: await page.click('#run')
            path = await (await d.value).path()
            size = os.path.getsize(path); r = PdfReader(path)
            check(f'compress pdf {level}', len(r.pages) == 2 and size <= os.path.getsize(f'{FX}/a.pdf'), f'{os.path.getsize(f"{FX}/a.pdf")} -> {size}; {await page.inner_text("#status")}')

        # ---- QR
        await page.goto(f'{BASE}/qr-code-generator/')
        await page.fill('#qr-fields input[name=url]', 'https://privyforge.com/test?a=1')
        async with page.expect_download() as d: await page.click('#dl-png')
        img = cv2.imread(await (await d.value).path())
        val, *_ = cv2.QRCodeDetector().detectAndDecode(img)
        check('qr url decodes', val == 'https://privyforge.com/test?a=1', val)
        await page.click('[data-type=wifi]')
        await page.fill('input[name=ssid]', 'Home;Net'); await page.fill('input[name=pass]', 'p@ss')
        async with page.expect_download() as d: await page.click('#dl-png')
        val, *_ = cv2.QRCodeDetector().detectAndDecode(cv2.imread(await (await d.value).path()))
        check('qr wifi decodes w/ escaping', val == 'WIFI:T:WPA;S:Home\\;Net;P:p@ss;;', val)
        async with page.expect_download() as d: await page.click('#dl-svg')
        svg = open(await (await d.value).path()).read()
        check('qr svg', svg.startswith('<svg'), svg[:40])

        # ---- Mortgage
        await page.goto(f'{BASE}/mortgage-calculator/')
        kp = await page.inner_text('#kpis')
        check('mortgage P&I $2,022.62 for 320k@6.5/30', '$2,022.62' in kp, kp.replace('\n', ' | '))
        await page.fill('input[name=downPct]', '10'); await page.fill('input[name=extra]', '200')
        kp = await page.inner_text('#kpis')
        check('mortgage PMI + extra savings shown', 'PMI' in kp and 'Saved with' in kp, kp.replace('\n', ' | '))
        rows = await page.locator('#table tbody tr').count()
        check('yearly table rows', 20 < rows <= 30, str(rows))
        await page.click('[data-view=month]')
        check('monthly table rows', await page.locator('#table tbody tr').count() > 250)
        async with page.expect_download() as d: await page.click('#csv')
        csv = open(await (await d.value).path()).read().splitlines()
        check('csv export', csv[0].startswith('Month') and len(csv) > 250, f'{len(csv)} lines')
        check('url state', 'extra=200' in page.url, page.url)
        await page.screenshot(path=f'{OUT}/mortgage.png', full_page=False)
        await page.goto(f'{BASE}/loan-calculator/')
        kp = await page.inner_text('#kpis')
        check('loan 25k@7.9/5y = $505.71', '$505.71' in kp, kp.replace('\n', ' | '))

        # ---- Offline: tool works with network cut (after first load, SW cached)
        await page.goto(f'{BASE}/compress-image/'); await page.wait_for_timeout(1500)
        await page.goto(f'{BASE}/compress-image/')
        await ctx.set_offline(True)
        await page.select_option('#format', 'webp')
        await page.set_input_files('#drop input', [f'{FX}/photo.jpg'])
        try:
            await page.wait_for_selector('.file .btn', timeout=60000); ok = True
        except Exception: ok = False
        check('image compressor works OFFLINE', ok, await page.inner_text('.file .meta'))
        await ctx.set_offline(False)

        # screenshots
        for path, name in [('/', 'home'), ('/compress-image/', 'compress-image'), ('/merge-pdf/', 'merge'), ('/qr-code-generator/', 'qr')]:
            await page.goto(BASE + path); await page.screenshot(path=f'{OUT}/{name}.png')
        m = await b.new_page(viewport={'width': 390, 'height': 844})
        await m.goto(BASE + '/compress-image/'); await m.screenshot(path=f'{OUT}/mobile.png')
        sw = await m.evaluate('document.documentElement.scrollWidth')
        check('no horizontal scroll on mobile', sw <= 390, str(sw))

        check('ZERO external network requests', not external, str(external[:5]))
        check('ZERO non-GET requests (nothing uploaded)', not posts, str(posts[:5]))
        check('no JS errors', not errors, str(errors[:5]))
        await b.close()
    fails = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(fails)}/{len(results)} passed')

asyncio.run(main())
