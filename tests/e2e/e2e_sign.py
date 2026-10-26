# Browser tests for Sign PDF and Fill PDF Form.
# Run after `npm run build && npx vite preview --port 4173` (or set BASE).
# Needs: playwright pypdf reportlab pillow, plus pypdfium2 (or poppler's pdftoppm) to render output.
import asyncio, io, os, re, shutil, subprocess, tempfile
from playwright.async_api import async_playwright
from pypdf import PdfReader, PdfWriter
from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter, A4
from reportlab.lib.colors import black

BASE = os.environ.get('BASE', 'http://localhost:4173')
OUT = os.path.join(os.path.dirname(__file__), 'out'); os.makedirs(OUT, exist_ok=True)
results = []
def check(name, ok, info=''):
    results.append(ok); print(('PASS ' if ok else 'FAIL ') + name, str(info)[:260])

# ------------------------------------------------------------------ fixtures
def lease_pdf():
    """Page 1: Letter. Page 2: A4 with /Rotate 90 (set with pypdf)."""
    raw = os.path.join(OUT, 'lease-raw.pdf')
    c = canvas.Canvas(raw, pagesize=letter)
    c.setFont('Helvetica', 18); c.drawString(72, 720, 'Lease agreement page one')
    c.line(300, 150, 540, 150); c.showPage()
    c.setPageSize(A4)
    c.setFont('Helvetica', 18); c.drawString(72, 780, 'Annex on A4 page two')
    c.showPage(); c.save()
    w = PdfWriter(clone_from=raw)
    w.pages[1].rotate(90)
    path = os.path.join(OUT, 'lease.pdf'); w.write(path)
    return path

def form_pdf():
    path = os.path.join(OUT, 'form.pdf')
    c = canvas.Canvas(path, pagesize=letter)
    c.setFont('Helvetica', 14); c.drawString(72, 740, 'Membership application')
    f = c.acroForm
    c.setFont('Helvetica', 11)
    c.drawString(72, 700, 'Name'); f.textfield(name='applicant_name', tooltip='Full name', x=140, y=692, width=250, height=20, borderColor=black, forceBorder=True)
    c.drawString(72, 660, 'Agree'); f.checkbox(name='agree', tooltip='I agree to the terms', x=140, y=655, size=16, buttonStyle='check', checked=False)
    c.drawString(72, 620, 'Plan')
    f.radio(name='plan', value='basic', selected=False, x=140, y=615, size=16, buttonStyle='circle')
    f.radio(name='plan', value='premium', selected=False, x=220, y=615, size=16, buttonStyle='circle')
    c.drawString(72, 580, 'State'); f.choice(name='state', tooltip='State', value='CA', options=['CA', 'NY', 'TX'], x=140, y=572, width=120, height=20)
    c.showPage(); c.save()
    return path

def flat_pdf():
    path = os.path.join(OUT, 'flat.pdf')
    c = canvas.Canvas(path, pagesize=letter); c.drawString(72, 720, 'No fields here'); c.showPage(); c.save()
    return path

def xfa_pdfs():
    """Pure XFA (no AcroForm fields) and hybrid (fields + XFA) fixtures."""
    from pypdf.generic import NameObject, ArrayObject, DictionaryObject, DecodedStreamObject
    def add_xfa(src, dst, drop_fields):
        w = PdfWriter(clone_from=src)
        xfa = DecodedStreamObject(); xfa.set_data(b'<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"></xdp:xdp>')
        if '/AcroForm' not in w._root_object:
            w._root_object[NameObject('/AcroForm')] = DictionaryObject({NameObject('/Fields'): ArrayObject()})
        af = w._root_object['/AcroForm']
        if drop_fields: af[NameObject('/Fields')] = ArrayObject()
        af[NameObject('/XFA')] = w._add_object(xfa)
        w.write(dst); return dst
    return add_xfa(flat_pdf(), os.path.join(OUT, 'xfa-pure.pdf'), True), add_xfa(form_pdf(), os.path.join(OUT, 'xfa-hybrid.pdf'), False)

def scribble_png():
    path = os.path.join(OUT, 'scribble.png')
    im = Image.new('RGB', (400, 160), (250, 250, 248)); d = ImageDraw.Draw(im)
    d.line([(30, 120), (90, 40), (150, 120), (210, 40), (270, 120), (360, 60)], fill=(10, 10, 10), width=8)
    im.save(path); return path

def render(pdf_path, index, scale=1.0):
    """Render one page *as displayed* (honouring /Rotate) to a PIL image."""
    try:
        import pypdfium2 as pdfium
        doc = pdfium.PdfDocument(pdf_path); doc.init_forms()  # draw widget appearance streams
        img = doc[index].render(scale=scale).to_pil().convert('RGB'); doc.close(); return img
    except ImportError:
        exe = shutil.which('pdftoppm')
        if not exe: raise SystemExit('install pypdfium2 or poppler-utils (pdftoppm) to run this test')
        d = tempfile.mkdtemp()
        subprocess.run([exe, '-r', str(int(72 * scale)), '-f', str(index + 1), '-l', str(index + 1), '-png', pdf_path, f'{d}/p'], check=True)
        return Image.open(os.path.join(d, os.listdir(d)[0])).convert('RGB')

def blue_box(img):
    """Normalized bbox of 'blue ink' pixels (the drawn signature)."""
    w, h = img.size; px = img.load(); xs, ys = [], []
    for y in range(0, h):
        for x in range(0, w):
            r, g, b = px[x, y]
            if b > 70 and b > r + 35 and b > g + 25: xs.append(x); ys.append(y)
    if not xs: return None
    return (min(xs) / w, min(ys) / h, (max(xs) + 1) / w, (max(ys) + 1) / h)

def image_xobjects(page):
    res = page.get('/Resources') or {}
    xo = res.get('/XObject') or {}
    return [k for k, v in xo.items() if v.get_object().get('/Subtype') == '/Image']

async def item_box(page, sel):
    """Item rect as fractions of its page element: (x0, y0, x1, y1)."""
    return await page.evaluate("""(sel) => {
      const el = document.querySelector(sel), p = el.closest('.sign-page').getBoundingClientRect(), r = el.getBoundingClientRect();
      return [(r.left - p.left) / p.width, (r.top - p.top) / p.height, (r.right - p.left) / p.width, (r.bottom - p.top) / p.height];
    }""", sel)

async def click_page(page, idx, fx, fy):
    layer = page.locator('.sign-page .sign-layer').nth(idx)
    bb = await layer.bounding_box()
    await layer.click(position={'x': bb['width'] * fx, 'y': bb['height'] * fy})

# ------------------------------------------------------------------ tests
async def sign_tests(page):
    lease = lease_pdf()
    r0 = PdfReader(lease)
    check('fixture: page 2 is A4 rotated 90', r0.pages[1].get('/Rotate') == 90 and round(float(r0.pages[1].mediabox.width)) == 595)

    await page.goto(f'{BASE}/sign-pdf/')
    check('sign: honest e-signature wording on page', 'not a certificate-based digital signature' in (await page.inner_text('.sign-note')).replace('\n', ' '))
    # The affiliate block only renders when site.json has URLs; check the page asks for it.
    src = open(os.path.join(os.path.dirname(__file__), '..', '..', 'sign-pdf', 'index.html')).read()
    check('sign: page includes the PDF affiliate block (e-signature link)', '@include affiliate-pdf' in src)
    await page.set_input_files('#drop input', [lease])
    await page.wait_for_function("document.querySelectorAll('.sign-page').length === 2")
    ar = await page.evaluate("[...document.querySelectorAll('.sign-page')].map(e => e.clientWidth / e.clientHeight)")
    check('sign: page 2 displayed landscape (rotation honoured)', ar[0] < 1 and ar[1] > 1 and abs(ar[1] - 841.89 / 595.28) < 0.01, ar)
    await page.wait_for_function("document.querySelector('.sign-page').dataset.rendered")

    # Draw a signature with mouse moves.
    await page.click('[data-add=signature]')
    await page.wait_for_selector('#sigdlg[open]')
    check('sign: remember checkbox is off by default', not await page.is_checked('#remember'))
    pad = await page.locator('#pad').bounding_box()
    px = lambda fx, fy: (pad['x'] + pad['width'] * fx, pad['y'] + pad['height'] * fy)
    await page.mouse.move(*px(0.1, 0.7)); await page.mouse.down()
    for i in range(1, 41):
        t = i / 40
        await page.mouse.move(*px(0.1 + 0.8 * t, 0.7 - 0.45 * abs(((t * 4) % 2) - 1)))
    await page.mouse.up()
    await page.mouse.move(*px(0.3, 0.85)); await page.mouse.down(); await page.mouse.move(*px(0.75, 0.85), steps=10); await page.mouse.up()
    await page.click('#pad-undo')  # remove the underline stroke, keep the zigzag
    await page.click('#sig-use')
    await page.wait_for_function("!document.querySelector('#sigdlg').open")
    stored = await page.evaluate("localStorage.getItem('privyforge.signature.v1')")
    check('sign: signature NOT stored when remember is off', stored is None, stored)

    # Page 1: signature, date, text
    await click_page(page, 0, 0.62, 0.8)
    await page.wait_for_selector('.sign-item.k-signature')
    sig1 = await item_box(page, '.sign-page[data-page="0"] .k-signature')
    await page.click('[data-add=date]'); await click_page(page, 0, 0.3, 0.82)
    date_text = await page.inner_text('.sign-page[data-page="0"] .k-date .sign-text')
    check('sign: date defaults to today (MM/DD/YYYY)', re.fullmatch(r'\d\d/\d\d/\d{4}', date_text) is not None, date_text)
    await page.fill('#p-date', '2026-03-07'); await page.dispatch_event('#p-date', 'change')
    await page.select_option('#p-fmt', 'MMMM D, YYYY')
    date_text = await page.inner_text('.sign-page[data-page="0"] .k-date .sign-text')
    check('sign: date editable + formatted', date_text == 'March 7, 2026', date_text)
    await page.click('[data-add=text]'); await click_page(page, 0, 0.35, 0.3)
    await page.fill('#p-text', 'Tenant: Jane Doe')

    # Keyboard: nudge, then add + delete a checkmark
    t = '.sign-page[data-page="0"] .k-text'
    before = await item_box(page, t)
    await page.focus(t); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('ArrowDown')
    after = await item_box(page, t)
    check('sign: arrow keys nudge (10pt right, 1pt down)', abs((after[0] - before[0]) * 612 - 10) < 0.6 and abs((after[1] - before[1]) * 792 - 1) < 0.6, (before, after))
    await page.click('[data-add=check]'); await click_page(page, 0, 0.5, 0.5)
    n = await page.locator('.sign-item').count()
    await page.keyboard.press('Delete')
    check('sign: Delete removes the selected item', await page.locator('.sign-item').count() == n - 1)

    # Resize the signature via its corner handle
    await page.click('.sign-page[data-page="0"] .k-signature')
    h = await page.locator('.sign-page[data-page="0"] .k-signature .sign-handle').bounding_box()
    await page.mouse.move(h['x'] + h['width'] / 2, h['y'] + h['height'] / 2); await page.mouse.down()
    await page.mouse.move(h['x'] + h['width'] / 2 + 40, h['y'] + h['height'] / 2 + 5, steps=5); await page.mouse.up()
    sig1b = await item_box(page, '.sign-page[data-page="0"] .k-signature')
    w0, w1 = sig1[2] - sig1[0], sig1b[2] - sig1b[0]
    a0, a1 = w0 / (sig1[3] - sig1[1]), w1 / (sig1b[3] - sig1b[1])
    check('sign: corner handle resizes, keeping aspect', w1 > w0 * 1.15 and abs(a0 - a1) / a0 < 0.03, (w0, w1, a0, a1))
    sig1 = sig1b
    # Drag to move
    s = await page.locator('.sign-page[data-page="0"] .k-signature').bounding_box()
    await page.mouse.move(s['x'] + s['width'] / 2, s['y'] + s['height'] / 2); await page.mouse.down()
    await page.mouse.move(s['x'] + s['width'] / 2 - 30, s['y'] + s['height'] / 2 - 20, steps=5); await page.mouse.up()
    sig1b = await item_box(page, '.sign-page[data-page="0"] .k-signature')
    check('sign: drag moves the item', sig1b[0] < sig1[0] - 0.02 and sig1b[1] < sig1[1] - 0.01, (sig1, sig1b))
    sig1 = sig1b

    # Initials via the Type tab
    await page.click('[data-add=initials]'); await page.wait_for_selector('#sigdlg[open]')
    await page.click('[role=tab][data-tab=type]'); await page.fill('#type-text', 'JD')
    await page.click('[data-ink=black]')  # black ink, so only the signature is blue in the render check
    await page.click('.type-opt >> nth=2'); await page.click('#sig-use')
    await click_page(page, 0, 0.12, 0.92)
    check('sign: typed initials placed as image', await page.locator('.k-initials img').count() == 1)

    # Page 2 (rotated): signature, date, text
    await page.click('[data-add=signature]'); await click_page(page, 1, 0.3, 0.45)
    sig2 = await item_box(page, '.sign-page[data-page="1"] .k-signature')
    await page.click('[data-add=date]'); await click_page(page, 1, 0.7, 0.6)
    await page.click('[data-add=text]'); await click_page(page, 1, 0.6, 0.25)
    await page.fill('#p-text', 'Unit 4B')
    await page.screenshot(path=f'{OUT}/sign-desktop.png', full_page=True)

    async with page.expect_download(timeout=60000) as d: await page.click('#save')
    dl = await d.value
    out = os.path.join(OUT, 'lease-signed.pdf'); await dl.save_as(out)
    check('sign: filename', dl.suggested_filename == 'lease-signed.pdf', dl.suggested_filename)
    r = PdfReader(out)
    t1, t2 = r.pages[0].extract_text(), r.pages[1].extract_text()
    check('sign: same page count', len(r.pages) == 2)
    check('sign: original text still extractable (not rasterized)', 'Lease agreement page one' in t1 and 'Annex on A4 page two' in t2, (t1[:80], t2[:80]))
    check('sign: new text on the right pages', 'Tenant: Jane Doe' in t1 and 'March 7, 2026' in t1 and 'Unit 4B' in t2 and 'Unit 4B' not in t1 and 'Tenant' not in t2, (t1, t2))
    check('sign: page sizes + rotation preserved', r.pages[1].get('/Rotate') == 90 and round(float(r.pages[0].mediabox.height)) == 792 and round(float(r.pages[1].mediabox.height)) == 842)
    imgs = [len(image_xobjects(p)) for p in r.pages]
    check('sign: image XObjects added (sig + initials on p1, sig on p2)', imgs == [2, 1], imgs)
    check('sign: original had no images', [len(image_xobjects(p)) for p in r0.pages] == [0, 0])

    for idx, want in [(0, sig1), (1, sig2)]:
        img = render(out, idx, scale=1.5)
        got = blue_box(img)
        err = max(abs(a - b) for a, b in zip(got, want)) if got else 1
        check(f'sign: signature lands within 5% of placement on page {idx + 1}{" (rotated 90)" if idx else ""}', err < 0.05, f'want={[round(v, 3) for v in want]} got={[round(v, 3) for v in got] if got else None} err={err:.3f}')
        img.save(f'{OUT}/sign-out-p{idx + 1}.png')

    # Remember signature: opt in, reload, it's offered again; opt out deletes it.
    await page.click('.sign-page[data-page="0"] .k-signature'); await page.click('#p-redo')
    await page.wait_for_selector('#sigdlg[open]')
    await page.click('[role=tab][data-tab=type]'); await page.fill('#type-text', 'Jane Doe')
    await page.check('#remember'); await page.click('#sig-use')
    stored = await page.evaluate("localStorage.getItem('privyforge.signature.v1')")
    check('sign: remember stores signature locally', stored is not None and 'data:image/png;base64,' in stored)
    await page.reload(); await page.set_input_files('#drop input', [lease])
    await page.wait_for_function("document.querySelectorAll('.sign-page').length === 2")
    await page.click('[data-add=signature]')
    check('sign: remembered signature reused (no dialog)', not await page.locator('#sigdlg[open]').count() and await page.get_attribute('[data-add=signature]', 'aria-pressed') == 'true')
    await click_page(page, 0, 0.5, 0.5)
    await page.click('#p-redo'); await page.uncheck('#remember'); await page.click('#sig-cancel')
    check('sign: unticking remember deletes it', await page.evaluate("localStorage.getItem('privyforge.signature.v1')") is None)

    # Upload with white-background removal
    await page.click('#p-redo'); await page.click('[role=tab][data-tab=upload]')
    await page.set_input_files('#up-drop input', [scribble_png()])
    await page.wait_for_selector('#up-preview img')
    alpha = await page.evaluate("""async () => {
      const img = document.querySelector('#up-preview img'); await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data; let clear = 0, ink = 0;
      for (let i = 3; i < d.length; i += 4) { if (d[i] === 0) clear++; else if (d[i] > 200) ink++; }
      return { clear, ink, w: c.width, h: c.height };
    }""")
    check('sign: upload removes white background, crops to ink', alpha['clear'] > alpha['ink'] > 500 and alpha['w'] < 400, alpha)
    await page.click('#sig-use')
    check('sign: uploaded signature replaces placed one', 'data:image/png' in (await page.get_attribute('.k-signature img', 'src')))

    # Mobile layout + touch-sized page
    m = await page.context.browser.new_page(viewport={'width': 390, 'height': 844}, has_touch=True)
    await m.goto(f'{BASE}/sign-pdf/')
    await m.set_input_files('#drop input', [lease])
    await m.wait_for_function("document.querySelectorAll('.sign-page').length === 2")
    await m.wait_for_function("document.querySelector('.sign-page').dataset.rendered")
    sw = await m.evaluate('document.documentElement.scrollWidth')
    check('sign: no horizontal scroll on mobile', sw <= 390, sw)
    await m.screenshot(path=f'{OUT}/sign-mobile.png', full_page=False)
    await m.click('[data-add=date]')
    pg = await m.locator('.sign-page').nth(0).bounding_box()
    await m.touchscreen.tap(pg['x'] + pg['width'] * 0.5, pg['y'] + pg['height'] * 0.3)
    check('sign: tap places an item on mobile', await m.locator('.k-date').count() == 1)
    await m.screenshot(path=f'{OUT}/sign-mobile-item.png', full_page=False)
    await m.close()


async def form_tests(page):
    form = form_pdf()
    await page.goto(f'{BASE}/fill-pdf-form/')
    await page.set_input_files('#drop input', [form])
    await page.wait_for_selector('#fields .ff')
    labels = await page.locator('#fields .ff .flabel').all_inner_texts()
    check('form: fields listed in page order with tooltip labels', labels == ['Full name', 'I agree to the terms', 'plan', 'State'], labels)
    check('form: page preview rendered with field boxes', await page.locator('#preview .sign-page').count() == 1 and await page.locator('#preview .fbox').count() == 5)
    await page.fill('[data-field="applicant_name"]', 'Jane Q. Public')
    await page.check('[data-field="agree"]')
    await page.check('[data-field="plan"][value="premium"]')
    await page.select_option('[data-field="state"]', 'NY')
    await page.focus('[data-field="applicant_name"]')
    check('form: focusing a field highlights it on the preview', await page.locator('.fbox.active').count() == 1)
    check('form: flatten is off by default', not await page.is_checked('#flatten'))
    async with page.expect_download(timeout=60000) as d: await page.click('#save')
    out = os.path.join(OUT, 'form-filled.pdf'); await (await d.value).save_as(out)
    r = PdfReader(out); f = r.get_fields() or {}
    vals = {k: (v.get('/V')) for k, v in f.items()}
    check('form: text value saved', vals.get('applicant_name') == 'Jane Q. Public', vals)
    check('form: checkbox checked', str(vals.get('agree')) not in ('/Off', 'None'), vals.get('agree'))
    check('form: radio saved', vals.get('plan') == '/premium', vals.get('plan'))
    check('form: dropdown saved', vals.get('state') == 'NY', vals.get('state'))
    check('form: fields still editable (not flattened)', len(f) == 4)
    ap = r.pages[0]['/Annots'][0].get_object()
    check('form: appearance stream generated for text field', '/AP' in ap)
    def dark(path):
        im = render(path, 0, 1.0)
        return sum(1 for x in range(143, 387) for y in range(792 - 709, 792 - 695) if sum(im.getpixel((x, y))) < 300)
    d0, d1 = dark(form), dark(out)
    check('form: filled value renders (pdfium draws the appearance)', d1 > d0 + 60, (d0, d1))

    await page.check('#flatten')
    async with page.expect_download(timeout=60000) as d: await page.click('#save')
    out2 = os.path.join(OUT, 'form-flat.pdf'); await (await d.value).save_as(out2)
    r2 = PdfReader(out2)
    check('form: flatten removes fields', not (r2.get_fields() or {}), list((r2.get_fields() or {}).keys()))
    check('form: flattened value is page content', 'Jane Q. Public' in r2.pages[0].extract_text(), r2.pages[0].extract_text()[:120])
    await page.screenshot(path=f'{OUT}/form-desktop.png', full_page=True)

    await page.goto(f'{BASE}/fill-pdf-form/')
    await page.set_input_files('#drop input', [flat_pdf()])
    await page.wait_for_selector('#msg:not([hidden])')
    msg = await page.inner_text('#msg')
    check('form: flat PDF explained + link to sign-pdf', 'no fillable' in msg.lower() and await page.locator('#msg a[href$="/sign-pdf/"]').count() == 1, msg)

    pure, hybrid = xfa_pdfs()
    await page.goto(f'{BASE}/fill-pdf-form/')
    await page.set_input_files('#drop input', [pure])
    await page.wait_for_selector('#msg:not([hidden])')
    msg = await page.inner_text('#msg')
    check('form: pure XFA form explained as unsupported', 'XFA' in msg and "isn't supported" in msg, msg[:120])
    await page.set_input_files('#drop input', [hybrid])
    await page.wait_for_selector('#fields .ff')
    check('form: hybrid XFA shows a note and still lists fields', await page.is_visible('#xfa-note') and await page.locator('#fields .ff').count() == 4)
    await page.fill('[data-field="applicant_name"]', 'Hybrid Person')
    async with page.expect_download(timeout=60000) as d: await page.click('#save')
    r3 = PdfReader(await (await d.value).path())
    check('form: hybrid output filled, XFA removed', r3.get_fields()['applicant_name'].get('/V') == 'Hybrid Person' and '/XFA' not in r3.trailer['/Root']['/AcroForm'])

    m = await page.context.browser.new_page(viewport={'width': 390, 'height': 844})
    await m.goto(f'{BASE}/fill-pdf-form/')
    await m.set_input_files('#drop input', [form]); await m.wait_for_selector('#fields .ff')
    sw = await m.evaluate('document.documentElement.scrollWidth')
    check('form: no horizontal scroll on mobile', sw <= 390, sw)
    await m.screenshot(path=f'{OUT}/form-mobile.png', full_page=True)
    await m.close()


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(accept_downloads=True, viewport={'width': 1280, 'height': 900})
        page = await ctx.new_page()
        external, posts, errors = [], [], []
        page.on('request', lambda r: (external.append(r.url) if not r.url.startswith(BASE) and not r.url.startswith(('blob:', 'data:')) else None, posts.append(r.url) if r.method != 'GET' else None))
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.on('dialog', lambda dg: asyncio.ensure_future(dg.accept()))
        await sign_tests(page)
        await form_tests(page)
        check('ZERO external requests', not external, external[:4])
        check('ZERO non-GET requests (nothing uploaded)', not posts, posts[:4])
        check('no JS errors', not errors, errors[:4])
        await b.close()
    print(f'\n{sum(results)}/{len(results)} passed')
    if not all(results): raise SystemExit(1)

asyncio.run(main())
