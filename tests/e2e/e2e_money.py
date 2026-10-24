# Browser tests for the money-saving tools. Run after `npm run build && npm run preview`.
import asyncio, os
from playwright.async_api import async_playwright

BASE = os.environ.get('BASE', 'http://localhost:4173')
OUT = os.path.join(os.path.dirname(__file__), 'out'); os.makedirs(OUT, exist_ok=True)
results = []
def check(name, ok, info=''):
    results.append(ok); print(('PASS ' if ok else 'FAIL ') + name, str(info)[:220])

CSV = """Posted Date,Payee,Debit,Credit
01/03/2026,NETFLIX.COM 866-579-7172 CA,15.49,
02/03/2026,NETFLIX.COM 866-579-7172 CA,15.49,
03/03/2026,NETFLIX.COM 866-579-7172 CA,17.99,
01/12/2026,SPOTIFY USA #1001,11.99,
02/12/2026,SPOTIFY USA #1002,11.99,
03/12/2026,SPOTIFY USA #1003,11.99,
01/15/2026,PAYROLL,,2500.00
02/09/2026,WHOLE FOODS,83.12,
03/21/2026,WHOLE FOODS,41.07,
01/20/2026,"<img src=x onerror=alert(1)> GYM",24.99,
02/20/2026,"<img src=x onerror=alert(1)> GYM",24.99,
03/20/2026,"<img src=x onerror=alert(1)> GYM",24.99,
"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(accept_downloads=True)
        page = await ctx.new_page()
        external, posts, errors, dialogs = [], [], [], []
        page.on('request', lambda r: (external.append(r.url) if not r.url.startswith(BASE) and not r.url.startswith(('blob:', 'data:')) else None, posts.append(r.url) if r.method != 'GET' else None))
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('dialog', lambda d: (dialogs.append(d.message), asyncio.ensure_future(d.dismiss())))

        # Subscription finder
        csv_path = os.path.join(OUT, 'statement.csv'); open(csv_path, 'w').write(CSV)
        await page.goto(f'{BASE}/subscription-finder/')
        await page.set_input_files('#drop input', [csv_path])
        await page.wait_for_selector('#subs tbody tr')
        rows = await page.locator('#subs tbody tr').all_inner_texts()
        check('subs: finds 3 recurring (incl. debit/credit format)', len(rows) == 3, ' || '.join(r.replace('\n', ' ')[:60] for r in rows))
        check('subs: price increase flagged', 'price changed' in ' '.join(rows))
        check('subs: groceries/payroll excluded', not any('WHOLE' in r or 'PAYROLL' in r for r in rows))
        check('subs: malicious merchant name rendered as text (no XSS)', not dialogs and await page.locator('#subs img').count() == 0, dialogs)
        await page.locator('#subs tbody tr').first.locator('input[type=checkbox]').check()
        k = await page.inner_text('#kpis')
        check('subs: savings update on cancel tick', "You'd save per year" in k and '$0' not in k.split("You'd save per year")[1][:8], k.replace('\n', ' | '))
        await page.click('#sample'); await page.wait_for_timeout(300)
        n = await page.locator('#subs tbody tr').count()
        check('subs: sample data demo works', n >= 5, n)
        async with page.expect_download() as d: await page.click('#export')
        check('subs: export CSV', open(await (await d.value).path()).read().startswith('Merchant'))
        await page.screenshot(path=f'{OUT}/subscriptions.png', full_page=True)

        # Debt payoff
        await page.goto(f'{BASE}/debt-payoff-calculator/')
        k = await page.inner_text('#results')
        check('debt: default plan renders', 'Debt-free' in k and 'Avalanche' in k, k[:160].replace('\n', ' | '))
        await page.fill('#budget', '100')
        check('debt: budget below minimums warns', 'must cover the minimum' in await page.inner_text('#results'))
        await page.fill('#budget', '1200')
        av = await page.inner_text('#results')
        check('debt: avalanche <= snowball interest', 'more than avalanche' in av)
        await page.goto(f'{BASE}/debt-payoff-calculator/?d=%3Cimg%20src%3Dx%20onerror%3Dalert(2)%3E~1000~20~50&b=200')
        await page.wait_for_timeout(300)
        check('debt: names from shared link are escaped (no XSS)', not dialogs and await page.locator('#results img').count() == 0, dialogs)
        await page.goto(f'{BASE}/debt-payoff-calculator/'); await page.screenshot(path=f'{OUT}/debt.png', full_page=True)

        # Refinance
        await page.goto(f'{BASE}/refinance-calculator/')
        v = await page.inner_text('#verdict'); k = await page.inner_text('#kpis')
        check('refi: verdict + break-even', 'break even' in v.lower() or 'breaks even' in v.lower(), v)
        await page.fill('input[name=newRate]', '7.25')
        v2 = await page.inner_text('#verdict')
        check('refi: same rate -> never pays off', 'never' in v2.lower(), v2)
        check('refi: URL keeps scenario', 'newRate=7.25' in page.url, page.url)
        await page.fill('input[name=newRate]', '6.0'); await page.screenshot(path=f'{OUT}/refi.png', full_page=True)

        # Rent vs buy
        await page.goto(f'{BASE}/rent-vs-buy-calculator/')
        v = await page.inner_text('#verdict')
        check('rent-vs-buy: verdict', 'Buying' in v or 'Renting' in v, v)
        await page.fill('input[name=rent]', '1200')
        v2 = await page.inner_text('#verdict')
        check('rent-vs-buy: cheap rent shifts toward renting', v2 != v, v2)
        await page.screenshot(path=f'{OUT}/rentbuy.png', full_page=True)

        check('ZERO external requests', not external, external[:4])
        check('ZERO non-GET requests', not posts, posts[:4])
        check('no JS errors', not errors, errors[:4])
        await b.close()
    print(f'\n{sum(results)}/{len(results)} passed')

asyncio.run(main())
