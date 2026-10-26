# Browser tests for the credit card payoff, car loan and compound interest calculators.
# Run after `npm run build && npm run preview` (BASE defaults to :4173).
# Expected numbers match tests/calculators.test.js (hand-worked / closed-form / reference).
import asyncio, json, os
from playwright.async_api import async_playwright

BASE = os.environ.get('BASE', 'http://localhost:4173')
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(os.path.dirname(__file__), 'out'); os.makedirs(OUT, exist_ok=True)
results = []
def check(name, ok, info=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name, str(info)[:220].replace('\n', ' | '))

SITE = json.load(open(os.path.join(ROOT, 'src/data/site.json')))
AFF_EMPTY = all(not (SITE['affiliates'].get(k, {}).get('url') or '') for k in ['BALANCE_TRANSFER', 'DEBT_CONSOLIDATION', 'HIGH_YIELD_SAVINGS'])

async def offer_hidden(page):
    return await page.locator('#offer').count() == 1 and not await page.is_visible('#offer')

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(accept_downloads=True)
        page = await ctx.new_page()
        external, posts, errors, dialogs = [], [], [], []
        page.on('request', lambda r: (external.append(r.url) if not r.url.startswith(BASE) and not r.url.startswith(('blob:', 'data:')) else None, posts.append(r.url) if r.method != 'GET' else None))
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('dialog', lambda d: (dialogs.append(d.message), asyncio.ensure_future(d.dismiss())))
        settle = lambda: page.wait_for_timeout(150)

        # ---------------- Credit card payoff
        await page.goto(f'{BASE}/credit-card-payoff-calculator/')
        k = await page.inner_text('#kpis'); c = await page.inner_text('#compare')
        check('card: $5,000 @ 22.99%, $200/mo -> 35 months, $1,871.10 interest', '2 yr 11 mo' in k and '$1,871.10' in k and '$95.79' in k, k)
        check('card: minimum-only comparison (1% + interest, $25 floor)', '19 yr 4 mo' in c and '$8,488.89' in c and '$145.79' in c, c)
        check('card: verdict states saving vs minimum', '$6,618 less than paying only the minimum' in await page.inner_text('#verdict'))
        check('card: offer card hidden (affiliate URLs empty in this build)', AFF_EMPTY and await offer_hidden(page), f'aff_empty={AFF_EMPTY}')
        check('card: balance-transfer legend hidden until enabled', not await page.is_visible('#lg-bt'))
        await page.fill('input[name=payment]', '95'); await settle()
        v = await page.inner_text('#verdict'); k = await page.inner_text('#kpis')
        check('card: payment below interest is flagged clearly', "doesn't cover the $95.79" in v and 'Pay at least $95.80' in v and 'Never' in k, v)
        check('card: offer still hidden with no payoff plan', await offer_hidden(page))
        await page.fill('input[name=payment]', '200')
        await page.select_option('select[name=mode]', 'months'); await page.fill('input[name=months]', '24'); await settle()
        k = await page.inner_text('#kpis')
        check('card: pay-off-in-24-months mode -> $261.85/mo', '$261.85' in k and '2 yr' in k and await page.is_hidden('input[name=payment]'), k)
        await page.select_option('select[name=mode]', 'payment')
        await page.check('input[name=bt]'); await settle()
        c = await page.inner_text('#compare')
        check('card: balance transfer (3%, 0% for 18 mo, then 22.99%) -> 27 mo, $294.39 total cost', 'Balance transfer' in c and '2 yr 3 mo' in c and '$294.39' in c and '$1,550' in c, c)
        check('card: URL keeps scenario', all(s in page.url for s in ['balance=5000', 'apr=22.99', 'bt=1', 'btFee=3', 'mode=payment']), page.url)
        await page.goto(f'{BASE}/credit-card-payoff-calculator/?balance=5000&apr=22.99&mode=months&months=24&minPct=1&minFloor=25&bt=0')
        check('card: shared link restores pay-off-in-N mode', '$261.85' in await page.inner_text('#kpis'))
        await page.goto(f'{BASE}/credit-card-payoff-calculator/?balance=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&apr=20&payment=50')
        await settle()
        check('card: hostile URL values are not injected', not dialogs and await page.locator('main img').count() == 0, dialogs)
        await page.goto(f'{BASE}/credit-card-payoff-calculator/'); await page.check('input[name=bt]'); await settle()
        await page.screenshot(path=f'{OUT}/credit-card.png', full_page=True)

        # ---------------- Car loan
        await page.goto(f'{BASE}/car-loan-calculator/')
        k = await page.inner_text('#kpis'); t = await page.inner_text('#terms')
        check('car: default deal financed $25,820, 60 mo @ 6.5% = $505.20', '$505.20' in k and '$25,820' in k and '$4,491.90' in k and '$36,311.90' in k, k)
        check('car: breakdown shows tax after trade-in credit', 'Sales tax $1,320.00 on $22,000' in await page.inner_text('#breakdown'))
        rows = await page.locator('#terms tbody tr').count()
        check('car: term comparison lists 36-84 months', rows == 5 and all(s in t for s in ['$791.36', '$612.32', '$505.20', '$434.03', '$383.41']), t)
        check('car: selected term highlighted', (await page.inner_text('#terms tr.sel')).startswith('60 mo'))
        check('car: comparison note quantifies the longer term', 'adds $3,718 of interest' in await page.inner_text('#terms-note'))
        await page.click('#terms tr[data-term="72"]'); await settle()
        check('car: clicking a term row switches the loan', await page.input_value('select[name=term]') == '72' and '$434.03' in await page.inner_text('#kpis') and 'term=72' in page.url, page.url)
        await page.select_option('select[name=term]', '60')
        await page.uncheck('input[name=taxAfterTrade]'); await settle()
        k = await page.inner_text('#kpis')
        check('car: tax on full price -> $26,300 financed, $514.59/mo', '$26,300' in k and '$514.59' in k and 'taxAfterTrade=0' in page.url, k)
        await page.check('input[name=taxAfterTrade]')
        await page.fill('input[name=tradeIn]', '5000'); await page.fill('input[name=owed]', '8000'); await settle()
        check('car: negative equity rolled into the loan', '$32,000' in await page.inner_text('#kpis') and 'negative equity' in await page.inner_text('#breakdown'))
        await page.goto(f'{BASE}/car-loan-calculator/?price=30000&down=3000&tradeIn=8000&owed=5000&tax=6&fees=500&taxAfterTrade=1&apr=6.5&term=48')
        check('car: shared link restores term', '$612.32' in await page.inner_text('#kpis'))
        check('car: yearly schedule has 4 rows for 48 mo', await page.locator('#table tbody tr').count() == 4)
        await page.click('[data-view=month]')
        check('car: monthly schedule has 48 rows', await page.locator('#table tbody tr').count() == 48)
        async with page.expect_download() as d: await page.click('#csv')
        csv = open(await (await d.value).path()).read().splitlines()
        check('car: CSV export', csv[0].startswith('Month') and len(csv) == 49 and csv[-1].endswith(',0.00'), csv[-1])
        await page.goto(f'{BASE}/car-loan-calculator/?term=999')
        check('car: invalid term in link falls back to 60', '$505.20' in await page.inner_text('#kpis'))
        await page.goto(f'{BASE}/car-loan-calculator/'); await page.screenshot(path=f'{OUT}/car-loan.png', full_page=True)

        # ---------------- Compound interest
        await page.goto(f'{BASE}/compound-interest-calculator/')
        k = await page.inner_text('#kpis')
        check('savings: $10k + $200/mo @ 4.5% APY, 10 yrs = $45,624.83', '$45,624.83' in k and '$34,000.00' in k and '$11,624.83' in k, k)
        check('savings: year-by-year table has 10 rows', await page.locator('#table tbody tr').count() == 10)
        check('savings: offer card hidden (affiliate URLs empty in this build)', AFF_EMPTY and await offer_hidden(page))
        await page.fill('input[name=monthly]', '0'); await page.fill('input[name=rate]', '5'); await settle()
        check('savings: $10,000 at 5% APY for 10 yrs = $16,288.95', '$16,288.95' in await page.inner_text('#kpis'))
        await page.select_option('select[name=rateType]', 'apr'); await page.select_option('select[name=freq]', 'daily'); await settle()
        check('savings: 5% APR compounded daily = 5.127% APY -> $16,486.65', '5.127% APY' in await page.inner_text('#apy-note') and '$16,486.65' in await page.inner_text('#kpis'), await page.inner_text('#apy-note'))
        await page.select_option('select[name=rateType]', 'apy'); await page.fill('input[name=rate]', '4.5')
        await page.fill('input[name=initial]', '5000')
        await page.select_option('select[name=mode]', 'contribution'); await page.fill('input[name=target]', '50000'); await settle()
        k = await page.inner_text('#kpis')
        check('savings goal: $5k -> $50k in 10 yrs @ 4.5% APY needs $280.68/mo', '$280.68' in k and await page.is_hidden('input[name=monthly]'), k)
        await page.select_option('select[name=mode]', 'time'); await page.fill('input[name=monthly]', '300'); await settle()
        k = await page.inner_text('#kpis')
        check('savings goal: $5k + $300/mo reaches $50k in 9 yr 7 mo', '9 yr 7 mo' in k and await page.is_hidden('input[name=years]'), k)
        check('savings: URL keeps goal mode', 'mode=time' in page.url and 'target=50000' in page.url, page.url)
        await page.reload()
        check('savings: reload restores goal mode', '9 yr 7 mo' in await page.inner_text('#kpis'))
        await page.fill('input[name=monthly]', '0'); await page.fill('input[name=rate]', '0'); await settle()
        check('savings goal: unreachable goal explained', "doesn't reach" in await page.inner_text('#verdict') and await offer_hidden(page))
        await page.goto(f'{BASE}/compound-interest-calculator/?increase=3')
        check('savings: 3% yearly contribution increase -> $49,662.57', '$49,662.57' in await page.inner_text('#kpis'))
        await page.goto(f'{BASE}/compound-interest-calculator/'); await page.screenshot(path=f'{OUT}/compound.png', full_page=True)

        # ---------------- page basics + layout
        for slug in ['credit-card-payoff-calculator', 'car-loan-calculator', 'compound-interest-calculator']:
            await page.goto(f'{BASE}/{slug}/')
            html = await page.content()
            check(f'{slug}: meta, canonical, JSON-LD, not-advice line', all(s in html for s in ['rel="canonical"', 'BreadcrumbList', 'WebApplication', 'Not financial advice.', 'Is this financial advice?']))
        mob = await b.new_page(viewport={'width': 390, 'height': 844})
        mob.on('pageerror', lambda e: errors.append(str(e)))
        for slug in ['credit-card-payoff-calculator', 'car-loan-calculator', 'compound-interest-calculator']:
            await mob.goto(f'{BASE}/{slug}/'); await mob.wait_for_timeout(200)
            w = await mob.evaluate("Math.max(...[...document.querySelectorAll('main > *')].map(e => e.scrollWidth))")
            check(f'{slug}: no horizontal overflow at 390px', w <= 390, w)

        check('ZERO external requests', not external, external[:4])
        check('ZERO non-GET requests', not posts, posts[:4])
        check('no JS errors', not errors, errors[:4])
        await b.close()
    print(f'\n{sum(results)}/{len(results)} passed')
    if not all(results): raise SystemExit(1)

asyncio.run(main())
