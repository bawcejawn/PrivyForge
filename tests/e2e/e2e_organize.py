# Browser tests for Organize PDF (rotate, reorder, delete pages).
# Run after `npm run build && npx vite preview --port 4173` (or set BASE).
# Needs: playwright pypdf reportlab pypdfium2.
import asyncio, os, re
from playwright.async_api import async_playwright
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter

BASE = os.environ.get('BASE', 'http://localhost:4173')
OUT = os.path.join(os.path.dirname(__file__), 'out'); os.makedirs(OUT, exist_ok=True)
results = []
def check(name, ok, info=''):
    results.append(ok); print(('PASS ' if ok else 'FAIL ') + name, str(info)[:260])

# ------------------------------------------------------------------ fixtures
def make_pdf(name, labels, rotate=None):
    """One page per label, each with large distinguishable text. rotate={index: degrees} via pypdf."""
    raw = os.path.join(OUT, name.replace('.pdf', '-raw.pdf'))
    c = canvas.Canvas(raw, pagesize=letter)
    for t in labels:
        c.setFont('Helvetica-Bold', 40); c.drawString(72, 640, t)
        c.setFont('Helvetica', 14); c.drawString(72, 600, 'Top of the page')
        c.showPage()
    c.save()
    w = PdfWriter(clone_from=raw)
    for i, deg in (rotate or {}).items(): w.pages[i].rotate(deg)
    path = os.path.join(OUT, name); w.write(path)
    return path

def encrypted_pdf():
    w = PdfWriter(clone_from=make_pdf('org-plain.pdf', ['Secret page']))
    w.encrypt(user_password='pw', owner_password='pw', algorithm='RC4-128')
    path = os.path.join(OUT, 'org-locked.pdf'); w.write(path); return path

def labels(path):
    out = []
    for p in PdfReader(path).pages:
        m = re.search(r'(Doc\w? page \d+)', p.extract_text() or '')
        out.append(m.group(1) if m else None)
    return out

def rotations(path): return [int(p.get('/Rotate') or 0) % 360 for p in PdfReader(path).pages]

def top_is_up(path, idx):
    """Render page as displayed with pdfium; the heading should sit in the upper half."""
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(path); img = doc[idx].render(scale=0.5).to_pil().convert('L'); doc.close()
    w, h = img.size; px = img.load()
    dark = [(x, y) for y in range(0, h, 2) for x in range(0, w, 2) if px[x, y] < 100]
    ys = [y for _, y in dark]; xs = [x for x, _ in dark]
    return (sum(ys) / len(ys) < h / 2) and (sum(xs) / len(xs) < w / 2), (w, h)

# ------------------------------------------------------------------ helpers
async def order(page):
    return await page.eval_on_selector_all('#grid .org-card .org-no', 'els => els.map(e => e.textContent)')

async def save(page, name):
    async with page.expect_download(timeout=60000) as d: await page.click('#save')
    dl = await d.value; path = os.path.join(OUT, name); await dl.save_as(path)
    return dl, path

async def open_pdf(page, path, n):
    await page.set_input_files('#drop input', [path])
    await page.wait_for_function(f"document.querySelectorAll('#grid .org-card').length === {n}")

# ------------------------------------------------------------------ tests
async def main_flow(page):
    doc = make_pdf('organize.pdf', [f'Doc page {i}' for i in range(1, 6)], rotate={4: 270})
    check('fixture: 5 pages, page 5 stored with /Rotate 270', rotations(doc) == [0, 0, 0, 0, 270] and labels(doc) == [f'Doc page {i}' for i in range(1, 6)], (rotations(doc), labels(doc)))

    await page.goto(f'{BASE}/organize-pdf/')
    await open_pdf(page, doc, 5)
    await page.wait_for_function("document.querySelectorAll('#grid .org-card[data-rendered]').length === 5")
    check('cards numbered 1-5', await order(page) == ['1', '2', '3', '4', '5'], await order(page))
    sizes = await page.eval_on_selector_all('#grid canvas', 'cs => cs.map(c => [c.width, c.height])')
    check('thumbnails rendered and capped (≤ 240 px)', all(0 < max(w, h) <= 240 for w, h in sizes), sizes)
    check('thumbnail for page 5 already landscape (existing /Rotate honoured)', sizes[4][0] > sizes[4][1] and sizes[0][0] < sizes[0][1], sizes)
    check('buttons have aria-labels', await page.locator('[aria-label="Rotate page 2 right"]').count() == 1 and await page.locator('[aria-label="Move page 4 earlier"]').count() == 1)

    # rotate p2 right
    await page.click('[aria-label="Rotate page 2 right"]')
    check('rotate shows 90° on card 2', (await order(page))[1] == '2 · 90°', await order(page))
    # delete p3 with undo, then delete again
    await page.click('[aria-label="Delete page 3"]')
    check('delete marks card 3', await page.locator('.org-card.deleted').count() == 1)
    await page.click('[aria-label="Restore page 3"]')
    check('undo restores card 3', await page.locator('.org-card.deleted').count() == 0)
    await page.click('[aria-label="Delete page 3"]')
    # move p4 to the front with Alt+Left (keyboard)
    card4 = page.locator('.org-card', has=page.locator('[aria-label="Rotate page 4 left"]'))
    await card4.focus()
    for _ in range(3): await page.keyboard.press('Alt+ArrowLeft')
    check('Alt+Left moves page 4 to the front', await order(page) == ['4', '1', '2 · 90°', '3', '5'], await order(page))
    check('focus stays on the moved card', await page.evaluate("document.activeElement.querySelector('.org-no')?.textContent") == '4')
    await page.keyboard.press('Alt+ArrowLeft')  # already first: no-op
    check('Alt+Left at the start is a no-op', (await order(page))[0] == '4')
    # page 5 (stored 270) rotate right -> 0
    await page.click('[aria-label="Rotate page 5 right"]')
    info = await page.inner_text('#info')
    check('summary line', '4 of 5 pages kept' in info and '1 deleted' in info and '2 rotated' in info and 'reordered' in info, info)
    await page.screenshot(path=f'{OUT}/organize-desktop.png', full_page=True)

    dl, out = await save(page, 'organize-out.pdf')
    check('filename', dl.suggested_filename == 'organize-organized.pdf', dl.suggested_filename)
    check('output: 4 pages', len(PdfReader(out).pages) == 4)
    check('output: order 4,1,2,5 (extracted text)', labels(out) == ['Doc page 4', 'Doc page 1', 'Doc page 2', 'Doc page 5'], labels(out))
    check('output: /Rotate 0,0,90,0 (p5: 270 + 90 = 0)', rotations(out) == [0, 0, 90, 0], rotations(out))
    r = PdfReader(out)
    check('output: not rasterized (no images, letter size kept)', all(not (p.get('/Resources') or {}).get('/XObject') for p in r.pages) and all(round(float(p.mediabox.height)) == 792 for p in r.pages))
    up = [top_is_up(out, i) for i in (0, 3)]
    check('output: p4 and p5 display upright', all(u for u, _ in up), up)
    _, (w, h) = top_is_up(out, 2)
    check('output: p2 displays landscape (rotated)', w > h, (w, h))
    check('status says nothing uploaded', 'Nothing was uploaded' in await page.inner_text('#status'))

    # Rotate all + reset
    await page.click('#rot-right')
    check('rotate all turns every card', all('°' in o for o in await order(page)), await order(page))
    await page.click('#reset')
    check('reset restores order, rotation and deletions', await order(page) == ['1', '2', '3', '4', '5'] and await page.locator('.org-card.deleted').count() == 0)

    # Delete by range
    await page.fill('#del-range', '9'); await page.press('#del-range', 'Enter')
    st = await page.inner_text('#status')
    check('invalid range rejected with a clear message', "Couldn't read those pages" in st and await page.locator('.org-card.deleted').count() == 0, st)
    await page.fill('#del-range', '2-3, 5'); await page.click('#del-form button')
    check('range "2-3, 5" deletes three pages', await page.locator('.org-card.deleted').count() == 3)
    _, out2 = await save(page, 'organize-range.pdf')
    check('range output: pages 1 and 4', labels(out2) == ['Doc page 1', 'Doc page 4'], labels(out2))

    # Drag to reorder (mouse)
    await page.click('#reset')
    src = page.locator('.org-card').nth(2); dst = page.locator('.org-card').nth(0)
    await src.drag_to(dst, target_position={'x': 5, 'y': 40})
    check('drag moves page 3 to the front', (await order(page))[:2] == ['3', '1'], await order(page))
    # Move buttons
    await page.click('[aria-label="Move page 3 later"]')
    check('move-later button', (await order(page))[:2] == ['1', '3'], await order(page))
    check('first card has "earlier" disabled', await page.locator('.org-card').nth(0).locator('[data-act=earlier]').is_disabled())

    # Delete everything -> save is disabled with a message
    await page.click('#reset')
    await page.fill('#del-range', '1-5'); await page.press('#del-range', 'Enter')
    check('all pages deleted -> Save disabled', await page.is_disabled('#save'))

    # Add another PDF: pages appended and numbered after
    await page.click('#reset')
    second = make_pdf('organize-b.pdf', ['DocB page 1', 'DocB page 2'])
    await page.set_input_files('#add-input', [second])
    await page.wait_for_function("document.querySelectorAll('#grid .org-card').length === 7")
    check('appended pages numbered 6-7', await order(page) == ['1', '2', '3', '4', '5', '6', '7'], await order(page))
    card7 = page.locator('.org-card', has=page.locator('[aria-label="Rotate page 7 left"]'))
    await card7.focus()
    for _ in range(6): await page.keyboard.press('Alt+ArrowLeft')
    await page.click('[aria-label="Delete page 2"]')
    _, out3 = await save(page, 'organize-two.pdf')
    want = ['DocB page 2', 'Doc page 1', 'Doc page 3', 'Doc page 4', 'Doc page 5', 'DocB page 1']
    check('two-file output order', labels(out3) == want, labels(out3))
    check('two-file output keeps existing /Rotate of p5', rotations(out3) == [0, 0, 0, 0, 270, 0], rotations(out3))

async def encrypted(page):
    await page.goto(f'{BASE}/organize-pdf/')
    await page.set_input_files('#drop input', [encrypted_pdf()])
    await page.wait_for_function("document.querySelector('#status').classList.contains('err')")
    st = await page.inner_text('#status')
    check('encrypted PDF: shared password-protected message', 'password-protected' in st and await page.is_hidden('#editor'), st)

async def big(page):
    path = make_pdf('organize-200.pdf', [f'Doc page {i}' for i in range(1, 201)])
    await page.goto(f'{BASE}/organize-pdf/')
    await open_pdf(page, path, 200)
    await page.wait_for_function("document.querySelectorAll('#grid .org-card[data-rendered]').length >= 4")
    await page.wait_for_timeout(1200)
    n = await page.locator('.org-card[data-rendered]').count()
    check('200 pages: only cards near the viewport render', 0 < n < 80, n)
    await page.locator('.org-card').nth(199).scroll_into_view_if_needed()
    await page.wait_for_function("document.querySelectorAll('#grid .org-card')[199].dataset.rendered", timeout=20000)
    n2 = await page.locator('.org-card[data-rendered]').count()
    check('200 pages: last card renders after scrolling, without rendering everything', n2 < 200, n2)
    await page.click('[aria-label="Delete page 1"]')
    _, out = await save(page, 'organize-200-out.pdf')
    check('200 pages: saves 199', len(PdfReader(out).pages) == 199)

async def mobile(browser, watch):
    mctx = await browser.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True)
    m = await mctx.new_page(); watch(m)
    await m.goto(f'{BASE}/organize-pdf/')
    await m.set_input_files('#drop input', [os.path.join(OUT, 'organize.pdf')])
    await m.wait_for_function("document.querySelectorAll('#grid .org-card[data-rendered]').length >= 2")
    sw = await m.evaluate('document.documentElement.scrollWidth')
    check('mobile: no horizontal scroll', sw <= 390, sw)
    await m.tap('[aria-label="Rotate page 1 right"]')
    check('mobile: tap rotates', (await order(m))[0] == '1 · 90°')
    await m.screenshot(path=f'{OUT}/organize-mobile.png', full_page=False)
    await mctx.close()

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(accept_downloads=True, viewport={'width': 1280, 'height': 900})
        page = await ctx.new_page()
        external, posts, errors = [], [], []
        def watch(pg):
            pg.on('request', lambda r: (external.append(r.url) if not r.url.startswith(BASE) and not r.url.startswith(('blob:', 'data:')) else None, posts.append(r.url) if r.method != 'GET' else None))
            pg.on('pageerror', lambda e: errors.append(str(e)))
            pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            pg.on('dialog', lambda dg: asyncio.ensure_future(dg.accept()))
        ctx.on('page', watch); watch(page)
        await main_flow(page)
        await encrypted(page)
        await big(page)
        await mobile(b, watch)
        check('ZERO external requests', not external, external[:4])
        check('ZERO non-GET requests (nothing uploaded)', not posts, posts[:4])
        check('no JS errors', not errors, errors[:4])
        await b.close()
    print(f'\n{sum(results)}/{len(results)} passed')
    if not all(results): raise SystemExit(1)

asyncio.run(main())
