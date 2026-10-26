# Revenue wiring: consent-gated ads, result-matched offers, related tools, hubs.
# Builds a throwaway copy with test IDs (src/data/site.json is restored afterwards),
# serves it on :4175, and blocks Google's servers so nothing real is contacted.
import asyncio, json, os, shutil, subprocess, signal, time
from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SITE = os.path.join(ROOT, 'src/data/site.json')
OUT = os.path.join(ROOT, 'dist-test')
BASE = 'http://localhost:4175'
results = []
def check(n, ok, info=''): results.append(ok); print(('PASS ' if ok else 'FAIL ') + n, str(info)[:200])

def build_test_site():
    original = open(SITE).read()
    d = json.loads(original)
    d['ads'].update({'adsenseClient': 'ca-pub-1234567890123456', 'slots': {'tool-below': '1111111111', 'content-mid': '2222222222'}, 'consent': 'banner'})
    for k in ['REFI', 'BALANCE_TRANSFER', 'DEBT_CONSOLIDATION', 'BILL_NEGOTIATION', 'HIGH_YIELD_SAVINGS', 'MORTGAGE_RATES']:
        d['affiliates'][k]['url'] = f'https://partner.example/{k.lower()}'
    try:
        open(SITE, 'w').write(json.dumps(d, indent=2))
        subprocess.run(['npx', 'vite', 'build', '--outDir', OUT, '--emptyOutDir'], cwd=ROOT, check=True, capture_output=True)
    finally:
        open(SITE, 'w').write(original)

async def main():
    build_test_site()
    srv = subprocess.Popen(['npx', 'vite', 'preview', '--outDir', OUT, '--port', '4175', '--strictPort'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    time.sleep(3)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(); ctx = await b.new_context()
            google = []
            async def block(route): google.append(route.request.url); await route.abort()
            await ctx.route('**/*googlesyndication.com/**', block); await ctx.route('**/*fundingchoicesmessages.google.com/**', block)
            pg = await ctx.new_page(); errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))

            # --- consent banner gates the ad script
            await pg.goto(f'{BASE}/merge-pdf/'); await pg.wait_for_timeout(500)
            check('ads: banner shown, NO ad request before consent', await pg.is_visible('#pf-consent') and not google, google[:1])
            check('ads: slots hidden before consent', await pg.locator('.ad-slot:not([hidden])').count() == 0)
            await pg.click('#pf-consent [data-c=denied]'); await pg.reload(); await pg.wait_for_timeout(500)
            check('ads: "No thanks" remembered, still no ad request', not await pg.is_visible('#pf-consent') and not google)
            check('ads: footer "Cookie choices" link present', await pg.locator('[data-pf-consent-link]').count() == 1)
            await pg.click('[data-pf-consent-link]'); await pg.wait_for_load_state(); await pg.wait_for_timeout(300)
            await pg.evaluate('scrollTo(0, 0)')  # the footer link click left us at the bottom
            await pg.click('#pf-consent [data-c=granted]'); await pg.wait_for_timeout(800)
            check('ads: after Accept, AdSense requested with our publisher ID', any('ca-pub-1234567890123456' in u for u in google), google[:1])
            check('ads: slot near viewport filled with its ad unit', await pg.locator('ins.adsbygoogle[data-ad-slot="1111111111"]').count() == 1)
            await pg.locator('.ad-slot[data-slot=content-mid]').scroll_into_view_if_needed(); await pg.wait_for_timeout(600)
            check('ads: lower slot filled lazily on scroll', await pg.locator('ins.adsbygoogle[data-ad-slot="2222222222"]').count() == 1)

            # --- result-matched offers (fresh context: consent irrelevant here)
            pg2 = await (await b.new_context()).new_page(); pg2.on('pageerror', lambda e: errs.append(str(e)))
            await pg2.goto(f'{BASE}/refinance-calculator/')
            check('offer: refinance offer shows when break-even is within stay', await pg2.is_visible('#offer') and 'refi' in (await pg2.get_attribute('#offer a', 'href') or ''))
            await pg2.fill('input[name=newRate]', '7.25'); await pg2.wait_for_timeout(200)
            check('offer: hidden when refinancing never pays off', not await pg2.is_visible('#offer'))
            await pg2.goto(f'{BASE}/debt-payoff-calculator/')
            check('offer: balance transfer for 29.99% card debt', 'balance_transfer' in (await pg2.get_attribute('#offer a', 'href') or ''))
            await pg2.fill('#budget', '100'); await pg2.wait_for_timeout(200)
            check('offer: hidden when plan is impossible', not await pg2.is_visible('#offer'))
            await pg2.goto(f'{BASE}/subscription-finder/')
            check('offer: none before any file is analysed', not await pg2.is_visible('#offer'))
            await pg2.click('#sample'); await pg2.wait_for_timeout(300)
            check('offer: bill-cutting after charges found', 'bill_negotiation' in (await pg2.get_attribute('#offer a', 'href') or ''))
            await pg2.locator('#subs tbody input[type=checkbox]').first.check(); await pg2.wait_for_timeout(200)
            t = await pg2.inner_text('#offer')
            check('offer: high-yield savings once charges are marked to cancel', 'high_yield' in (await pg2.get_attribute('#offer a', 'href') or '') and '$' in t, t[:60])
            check('offer: link is sponsored + noopener', (await pg2.get_attribute('#offer a', 'rel')) == 'sponsored nofollow noopener')

            # --- static affiliate boxes and hubs
            await pg2.goto(f'{BASE}/debt-payoff-calculator/')
            check('affiliate-debt box rendered with configured link', await pg2.locator('aside.affiliate a[href*="debt_consolidation"]').count() == 1)
            await pg2.goto(f'{BASE}/subscription-finder/')
            check('affiliate-savings box rendered', await pg2.locator('aside.affiliate a[href*="high_yield"]').count() == 1)
            await pg2.goto(f'{BASE}/money-tools/')
            check('hub: money tools lists both categories', await pg2.locator('.tool-grid .tool-card').count() >= 6)
            check('related tools block on tool pages', await pg2.goto(f'{BASE}/split-pdf/') and await pg2.locator('.related .tool-card').count() == 4)
            check('no JS errors', not errs, errs[:3])
            await b.close()
    finally:
        os.killpg(srv.pid, signal.SIGTERM); shutil.rmtree(OUT, ignore_errors=True)
        assert 'ca-pub-1234567890123456' not in open(SITE).read(), 'site.json was not restored!'
    print(f'\n{sum(results)}/{len(results)} passed')

asyncio.run(main())
