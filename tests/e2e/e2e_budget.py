# Browser tests for the budget (50/30/20) and emergency fund calculators.
# Run after `npm run build && npm run preview` (BASE defaults to :4173).
# Expected numbers match tests/budget.test.js (computed by src/js/lib/budget.js and emergency.js).
import asyncio, os
from playwright.async_api import async_playwright

BASE = os.environ.get('BASE', 'http://localhost:4173')
OUT = os.path.join(os.path.dirname(__file__), 'out'); os.makedirs(OUT, exist_ok=True)
results = []
def check(name, ok, info=''):
    results.append(ok); print(('PASS ' if ok else 'FAIL ') + name, str(info)[:220])

async def line(page, name):
    i = await page.eval_on_selector_all('.bline .bname', 'els => els.map(e => e.value)')
    return page.locator('.bline').nth(i.index(name))

async def notes(page):
    return [n.strip() for n in await page.locator('#notes li').all_inner_texts()]

async def row(page, group):
    return (await page.inner_text(f'#table tr[data-group="{group}"]')).split('\t')

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await b.new_page(viewport={'width': 1280, 'height': 900})
        external, posts, errors, dialogs = [], [], [], []
        def watch(pg):
            pg.on('request', lambda r: (external.append(r.url) if not r.url.startswith(BASE) and not r.url.startswith(('blob:', 'data:')) else None, posts.append(r.url) if r.method != 'GET' else None))
            pg.on('pageerror', lambda e: errors.append(str(e)))
            pg.on('dialog', lambda d: (dialogs.append(d.message), asyncio.ensure_future(d.dismiss())))
        watch(page)

        # ---------------- Budget calculator ----------------
        await page.goto(f'{BASE}/budget-calculator/')
        check('budget: sample is labelled', await page.locator('#sample-note').is_visible())
        v = await page.inner_text('#verdict')
        check('budget: default verdict ($815 left)', v == '$815 a month is left after everything listed.', v)
        n = await notes(page)
        check('budget: plain-language notes', n[:3] == [
            "Needs are 59% of take-home; the guideline is 50%. That's $450 a month over.",
            "Wants are 12.7% of take-home; the guideline is 30%. That's $865 a month under.",
            "Savings & debt are 12% of take-home; the guideline is 20%. That's $400 a month under."], n)
        check('budget: unassigned note', n[3].startswith("$815 a month isn't assigned") and '28.3%' in n[3], n[3])
        r = await row(page, 'needs')
        check('budget: table row needs', r[1:] == ['$2,950', '59%', '$2,500 (50%)', '$450 over'], r)
        w = await page.evaluate("document.querySelector('.bbar.needs .bbar-track i').style.width")
        check('budget: needs bar width 59%', w == '59%', w)
        check('budget: Wants links to subscription finder', await page.locator('.bgroup[data-group=wants] a[href="/subscription-finder/"]').count() == 1)
        check('budget: no offer without a configured partner', await page.locator('#offer').is_hidden())

        # Edit: income 4000, rent 2000 -> needs 3350, total 4585, overspent 585
        await page.fill('#income', '4000')
        await (await line(page, 'Rent')).locator('.bamt').fill('2000')
        v = await page.inner_text('#verdict')
        check('budget: overspending verdict', v == "You're spending $585 a month more than you take home.", v)
        n = await notes(page)
        check('budget: needs 83.8% note', n[0] == "Needs are 83.8% of take-home; the guideline is 50%. That's $1,350 a month over.", n[0])
        check('budget: sample label hides once edited', await page.locator('#sample-note').is_hidden())
        k = await page.inner_text('#kpis')
        check('budget: KPI overspent $585', 'Overspent each month' in k and '$585' in k, k.replace('\n', ' | '))
        w = await page.evaluate("document.querySelector('.bbar.needs .bbar-track i').style.width")
        check('budget: needs bar width 83.75%', w == '83.75%', w)

        # Custom ratios via preset 70/20/10 -> needs target 2800, $550 over
        await page.select_option('#preset', '70/20/10')
        vals = [await page.input_value(f'#r-{g}') for g in ('needs', 'wants', 'savings')]
        check('budget: preset fills ratios', vals == ['70', '20', '10'], vals)
        n = await notes(page)
        check('budget: 70/20/10 guideline note', n[0] == "Needs are 83.8% of take-home; the guideline is 70%. That's $550 a month over.", n[0])
        await page.fill('#r-savings', '12.5')
        check('budget: typing a ratio switches to Custom', await page.input_value('#preset') == 'custom')
        n = await notes(page)
        check('budget: ratios not adding to 100 warned', n[-1] == 'Your guideline percentages add up to 102.5%, not 100%.', n[-1])
        await page.fill('#r-savings', '10')
        check('budget: back to a preset when it matches', await page.input_value('#preset') == '70/20/10')

        # Remove Shopping (250), add a hostile-named want with a 3-decimal amount (rounds to cents)
        await (await line(page, 'Shopping')).locator('.icon-btn').click()
        await page.click('.bgroup[data-group=wants] .add')
        new = page.locator('.bgroup[data-group=wants] .bline').last
        await new.locator('.bname').fill('<img src=x onerror=alert(1)> ~|% gym')
        await new.locator('.bamt').fill('12.345')
        r = await row(page, 'wants')
        check('budget: remove + add line, cents rounding (385 + 12.35)', r[1] == '$397.35', r)
        check('budget: names stay text (no XSS)', not dialogs and await page.locator('main img').count() == 0, dialogs)
        v = await page.inner_text('#verdict')
        check('budget: total updates', v == "You're spending $347.35 a month more than you take home.", v)

        # URL round-trip: reload restores every input
        before = {
            'income': await page.input_value('#income'),
            'ratios': [await page.input_value(f'#r-{g}') for g in ('needs', 'wants', 'savings')],
            'names': await page.eval_on_selector_all('.bname', 'els => els.map(e => e.value)'),
            'amts': await page.eval_on_selector_all('.bamt', 'els => els.map(e => e.value)'),
            'verdict': v,
        }
        await page.goto(page.url)
        after = {
            'income': await page.input_value('#income'),
            'ratios': [await page.input_value(f'#r-{g}') for g in ('needs', 'wants', 'savings')],
            'names': await page.eval_on_selector_all('.bname', 'els => els.map(e => e.value)'),
            'amts': await page.eval_on_selector_all('.bamt', 'els => els.map(e => e.value)'),
            'verdict': await page.inner_text('#verdict'),
        }
        check('budget: reload restores inputs and result', before == after, after)
        check('budget: preset restored', await page.input_value('#preset') == '70/20/10')
        check('budget: hostile name restored as text', '<img src=x onerror=alert(1)> ~|% gym' in after['names'] and not dialogs, after['names'][-1])

        # Emergency-fund link carries the Needs total
        href = await page.get_attribute('#ef-link a', 'href')
        check('budget: emergency fund link carries needs', href.startswith('/emergency-fund-calculator/?expenses=3350'), href)

        # Zero income and cleared amounts
        await page.fill('#income', '')
        v = await page.inner_text('#verdict')
        check('budget: zero income prompts', v == 'Enter your monthly take-home pay to see your split.', v)
        check('budget: zero income shows no NaN', 'NaN' not in await page.inner_text('main') and 'Infinity' not in await page.inner_text('main'))
        await page.goto(f'{BASE}/budget-calculator/')
        await page.click('#clear')
        k = await page.inner_text('#kpis')
        check('budget: clear all amounts', 'Total listed\n$0' in k and '$5,000' in k, k.replace('\n', ' | '))
        await page.goto(f'{BASE}/budget-calculator/')
        await page.screenshot(path=f'{OUT}/budget.png', full_page=True)

        # Follow the link into the emergency fund calculator
        await page.goto(f'{BASE}/budget-calculator/?income=5000&r=50-30-20&l=n~Rent~1600|n~Food~400.50')
        await page.click('#ef-link a')
        await page.wait_for_load_state()
        e = await page.input_value('input[name=expenses]')
        check('budget -> emergency: expenses prefilled', e == '2000.50', e)

        # ---------------- Emergency fund calculator ----------------
        await page.goto(f'{BASE}/emergency-fund-calculator/')
        k = await page.inner_text('#kpis')
        check('ef: default target $18,000', 'Target (6 months)\n$18,000' in k, k.replace('\n', ' | '))
        check('ef: months covered 1.3, gap $14,000, 2 yr 11 mo', 'Months covered now\n1.3' in k and 'Still to save\n$14,000' in k and 'Time to goal\n2 yr 11 mo' in k, k.replace('\n', ' | '))
        rows = await page.locator('#table tbody tr').count()
        last = (await page.locator('#table tbody tr').last.inner_text()).split('\t')
        check('ef: 35 monthly rows, ends at $18,000 = 6 months', rows == 35 and last[0] == '35' and last[-2:] == ['$18,000', '6'], (rows, last))
        check('ef: no offer without a configured partner', await page.locator('#offer').is_hidden())

        await page.fill('input[name=apy]', '4')
        k = await page.inner_text('#kpis')
        check('ef: 4% APY -> 2 yr 9 mo, $1,170.95 interest', 'Time to goal\n2 yr 9 mo' in k and 'Interest earned on the way\n$1,170.95' in k, k.replace('\n', ' | '))
        first = (await page.locator('#table tbody tr').first.inner_text()).split('\t')
        last = (await page.locator('#table tbody tr').last.inner_text()).split('\t')
        check('ef: month 1 interest $13.09; month 33 balance $18,370.95', first[3] == '$13.09' and last[0] == '33' and last[4] == '$18,370.95', (first, last))

        await page.fill('input[name=apy]', '')
        await page.select_option('select[name=target]', '3')
        k = await page.inner_text('#kpis')
        check('ef: 3 months -> $9,000, $5,000 gap, 1 yr 1 mo', 'Target (3 months)\n$9,000' in k and 'Still to save\n$5,000' in k and 'Time to goal\n1 yr 1 mo' in k, k.replace('\n', ' | '))
        await page.select_option('select[name=target]', 'custom')
        check('ef: custom months field appears', await page.locator('#f-custom').is_visible())
        await page.fill('input[name=custom]', '4.5')
        k = await page.inner_text('#kpis')
        check('ef: custom 4.5 months -> $13,500', 'Target (4.5 months)\n$13,500' in k, k.replace('\n', ' | '))

        await page.check('input[name=itemize]')
        await page.fill('input[name=housing]', '1600.25')
        e = await page.input_value('input[name=expenses]')
        check('ef: breakdown adds up (3,100.25)', e == '3100.25' and await page.locator('input[name=expenses]').evaluate('e => e.readOnly'), e)

        # URL round-trip
        url = page.url
        state = await page.eval_on_selector_all('#calc [name]', 'els => els.map(e => e.type === "checkbox" ? e.checked : e.value)')
        kp = await page.inner_text('#kpis')
        await page.goto(url)
        state2 = await page.eval_on_selector_all('#calc [name]', 'els => els.map(e => e.type === "checkbox" ? e.checked : e.value)')
        check('ef: reload restores inputs and result', state == state2 and kp == await page.inner_text('#kpis'), (state2, url))
        check('ef: breakdown visible after reload', await page.locator('#breakdown').is_visible())

        await page.goto(f'{BASE}/emergency-fund-calculator/?expenses=2000&saved=15000&monthly=0&target=6')
        v = await page.inner_text('#verdict')
        check('ef: already funded', v.startswith("You're there: $15,000 covers 7.5 months"), v)
        await page.goto(f'{BASE}/emergency-fund-calculator/?expenses=3000&saved=1000&monthly=0&target=3')
        k = await page.inner_text('#kpis')
        check('ef: nothing saved monthly -> not reachable', 'Not reachable' in k, k.replace('\n', ' | '))
        await page.goto(f'{BASE}/emergency-fund-calculator/?expenses=&saved=1000')
        v = await page.inner_text('#verdict')
        check('ef: zero expenses prompts', v == 'Enter your essential monthly expenses to size your emergency fund.', v)
        await page.goto(f'{BASE}/emergency-fund-calculator/?expenses=%3Cimg%20src%3Dx%20onerror%3Dalert(3)%3E')
        check('ef: hostile URL value is harmless', not dialogs and await page.locator('main img').count() == 0, dialogs)
        await page.goto(f'{BASE}/emergency-fund-calculator/')
        await page.screenshot(path=f'{OUT}/emergency.png', full_page=True)

        # Copy essentials on both pages
        for slug in ('budget-calculator', 'emergency-fund-calculator'):
            await page.goto(f'{BASE}/{slug}/')
            html = await page.content()
            check(f'{slug}: not-financial-advice line + FAQ', 'Not financial advice.' in html and 'Is this financial advice?' in html)
            links = await page.eval_on_selector_all('article a', 'els => els.map(e => e.getAttribute("href"))')
            others = {'/budget-calculator/', '/emergency-fund-calculator/', '/compound-interest-calculator/'} - {f'/{slug}/'}
            check(f'{slug}: cross-links', others <= set(links), links)

        # 390px mobile: no horizontal scroll
        mob = await b.new_page(viewport={'width': 390, 'height': 844})
        watch(mob)
        for slug in ('budget-calculator', 'emergency-fund-calculator'):
            await mob.goto(f'{BASE}/{slug}/'); await mob.wait_for_timeout(200)
            sw = await mob.evaluate('document.documentElement.scrollWidth')
            check(f'{slug}: no horizontal scroll at 390px', sw <= 390, sw)
            fit = await mob.evaluate("(() => { const t = document.querySelector('#table'); return [t.scrollWidth, t.parentElement.clientWidth]; })()")
            check(f'{slug}: results table fits without sideways scrolling at 390px', fit[0] <= fit[1], fit)
            await mob.screenshot(path=f'{OUT}/{slug}-390.png', full_page=True)

        check('ZERO external requests', not external, external[:4])
        check('ZERO non-GET requests', not posts, posts[:4])
        check('no JS errors', not errors, errors[:4])
        await b.close()
    print(f'\n{sum(results)}/{len(results)} passed')
    if not all(results): raise SystemExit(1)

asyncio.run(main())
