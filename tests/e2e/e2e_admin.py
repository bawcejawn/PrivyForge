# Admin + customer dashboard tests. GitHub's API is simulated with Playwright routing,
# so no real token or network is needed. Run after `npm run build && npm run preview`.
import asyncio, os, json, base64, re
from playwright.async_api import async_playwright

BASE = os.environ.get('BASE', 'http://localhost:4173')
ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
results = []
def check(n, ok, info=''): results.append(ok); print(('PASS ' if ok else 'FAIL ') + n, str(info)[:200])

TOKEN = 'github_pat_TESTTOKEN_123'
def b64(s): return base64.b64encode(s.encode()).decode()
repo = {  # simulated repo contents
    'src/data/site.json': open(os.path.join(ROOT, 'src/data/site.json')).read(),
    'src/data/tools.json': open(os.path.join(ROOT, 'src/data/tools.json')).read(),
    'content/guides/compress-pdf-without-uploading.md': open(os.path.join(ROOT, 'content/guides/compress-pdf-without-uploading.md')).read(),
}
shas = {p: f'sha{i}' for i, p in enumerate(repo)}
commits, bad_auth = [], []

async def gh(route, req):
    url = req.url; m = req.method
    if req.headers.get('authorization') != f'Bearer {TOKEN}':
        bad_auth.append(url); return await route.fulfill(status=401, json={'message': 'Bad credentials'})
    path = re.sub(r'^https://api\.github\.com', '', url).split('?')[0]
    if path == '/repos/bawcejawn/PrivyForge': return await route.fulfill(json={'full_name': 'bawcejawn/PrivyForge', 'permissions': {'push': True}})
    if path.endswith('/actions/runs'): return await route.fulfill(json={'workflow_runs': [{'status': 'completed', 'conclusion': 'success', 'display_title': 'test', 'created_at': '2026-10-23T00:00:00Z', 'html_url': 'https://github.com/x'}]})
    mm = re.match(r'^/repos/bawcejawn/PrivyForge/contents/(.+)$', path)
    if not mm: return await route.fulfill(status=404, json={'message': 'Not Found'})
    p = mm.group(1)
    if m == 'GET':
        if p == 'content/guides':
            return await route.fulfill(json=[{'type': 'file', 'name': k.split('/')[-1], 'path': k, 'sha': shas[k]} for k in repo if k.startswith('content/guides/')])
        if p not in repo: return await route.fulfill(status=404, json={'message': 'Not Found'})
        return await route.fulfill(json={'content': b64(repo[p]), 'sha': shas[p]})
    body = json.loads(req.post_data or '{}')
    if m == 'PUT':
        if p in repo and body.get('sha') != shas[p]: return await route.fulfill(status=409, json={'message': 'sha mismatch'})
        repo[p] = base64.b64decode(body['content']).decode(); shas[p] = f'sha{len(commits) + 100}'
        commits.append((m, p, body['message'])); return await route.fulfill(json={'content': {'sha': shas[p]}})
    if m == 'DELETE':
        repo.pop(p, None); commits.append((m, p, body['message'])); return await route.fulfill(status=200, json={})
    await route.fulfill(status=405, json={})

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(); ctx = await b.new_context(accept_downloads=True)
        await ctx.route('https://api.github.com/**', gh)
        pg = await ctx.new_page(); errs, other_hosts = [], []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('request', lambda r: other_hosts.append(r.url) if not r.url.startswith((BASE, 'https://api.github.com', 'blob:', 'data:')) else None)
        pg.on('dialog', lambda d: asyncio.ensure_future(d.accept('My test plan') if d.type == 'prompt' else d.accept()))

        # ---------- Admin
        await pg.goto(f'{BASE}/admin/')
        check('admin: noindex', 'noindex' in (await pg.get_attribute('meta[name=robots]', 'content') or ''))
        check('admin: repo prefilled', await pg.input_value('#connect-form [name=repo]') == 'bawcejawn/PrivyForge')
        await pg.fill('#connect-form [name=token]', 'wrong'); await pg.click('#connect-btn'); await pg.wait_for_timeout(400)
        check('admin: bad token rejected with hint', 'invalid or expired' in await pg.inner_text('#toast'))
        await pg.fill('#connect-form [name=token]', TOKEN); await pg.click('#connect-btn')
        await pg.wait_for_selector('#app:not([hidden])', timeout=5000)
        check('admin: connected + deploy status', 'live' in await pg.inner_text('#deploys'))
        stored = await pg.evaluate("[sessionStorage.getItem('pf-admin:conn'), localStorage.getItem('pf-admin:conn')]")
        check('admin: token in sessionStorage only (not remembered)', TOKEN in (stored[0] or '') and stored[1] is None)

        # Settings: invalid then valid
        await pg.fill('[name=adsenseClient]', 'pub-123')
        await pg.fill('#aff-table tbody tr[data-key=ESIGN] [data-f=url]', 'javascript:alert(1)')
        await pg.click('#save-settings')
        st = await pg.inner_text('#settings-status')
        check('settings: validation blocks bad AdSense ID + non-https link', 'ca-pub' in st and 'https://' in st and not commits, st)
        await pg.fill('[name=adsenseClient]', 'ca-pub-1234567890123456')
        await pg.fill('#aff-table tbody tr[data-key=ESIGN] [data-f=url]', 'https://partner.example/esign?ref=pf')
        await pg.fill('[name=announcement]', 'New: Subscription Finder!')
        await pg.fill('[name=crypto]', 'Bitcoin | bc1qexampleexampleexampleexample0')
        await pg.click('#save-settings'); await pg.wait_for_timeout(400)
        saved = json.loads(repo['src/data/site.json'])
        check('settings: committed valid JSON with new values', saved['ads']['adsenseClient'] == 'ca-pub-1234567890123456' and saved['affiliates']['ESIGN']['url'].startswith('https://') and saved['support']['crypto'][0]['chain'] == 'Bitcoin', commits[-1])

        # Tools: hide one, move one
        await pg.click('[data-tab=tools]')
        await pg.locator('#tools-table tbody tr').nth(1).locator('[data-move="-1"]').click()
        await pg.locator('#tools-table tbody tr').nth(13).locator('[data-f=enabled]').uncheck()
        await pg.click('#save-tools'); await pg.wait_for_timeout(400)
        t = json.loads(repo['src/data/tools.json'])
        check('tools: reorder + hide committed', t[0]['slug'] == 'convert-image' and t[13]['enabled'] is False, [x['slug'] for x in t[:2]])

        # Guides: create, preview sanitization, publish, rename, delete
        await pg.click('[data-tab=guides]'); await pg.click('#new-guide')
        await pg.fill('#guide-form [name=title]', 'Is Refinancing Worth It in 2026?')
        await pg.fill('#guide-form [name=description]', 'A plain-English way to find your break-even month before you refinance.')
        await pg.select_option('#guide-form [name=tool]', '/refinance-calculator/')
        await pg.fill('#guide-form [name=body]', '## Start here\n\nText <img src=x onerror="window.__xss=1"> more.\n\n## Second\n\nMore.')
        await pg.wait_for_timeout(200)
        check('guides: preview strips event handlers', await pg.evaluate('window.__xss') is None and await pg.locator('#preview img[onerror]').count() == 0)
        check('guides: slug auto-generated', await pg.input_value('#guide-form [name=slug]') == 'is-refinancing-worth-it-in-2026')
        await pg.click('#save-guide'); await pg.wait_for_timeout(400)
        p = 'content/guides/is-refinancing-worth-it-in-2026.md'
        check('guides: new guide committed with front matter', p in repo and repo[p].startswith('---\ntitle: Is Refinancing Worth It in 2026?') and 'tool: /refinance-calculator/' in repo[p])
        await pg.fill('#guide-form [name=slug]', 'refinance-worth-it'); await pg.click('#save-guide'); await pg.wait_for_timeout(600)
        check('guides: rename moves the file', 'content/guides/refinance-worth-it.md' in repo and p not in repo)
        await pg.click('#delete-guide'); await pg.wait_for_timeout(400)
        check('guides: delete removes file', 'content/guides/refinance-worth-it.md' not in repo)

        # Traffic: revenue log (local only) + GSC import
        await pg.click('[data-tab=traffic]')
        for mo, pv, ads, aff in [('2026-09', '20000', '90', '40'), ('2026-10', '30000', '150', '90')]:
            await pg.fill('#rev-form [name=month]', mo); await pg.fill('#rev-form [name=pageviews]', pv)
            await pg.fill('#rev-form [name=ads]', ads); await pg.fill('#rev-form [name=aff]', aff); await pg.click('#rev-add')
        k = await pg.inner_text('#rev-kpis')
        check('revenue: totals, RPM $8.00, growth +85%', '$240' in k and '$8.00' in k and '+85%' in k, k.replace('\n', ' | '))
        check('revenue: never committed to the public repo', not any('revenue' in c[1] for c in commits))
        gsc = os.path.join(os.path.dirname(__file__), 'out', 'Queries.csv')
        open(gsc, 'w').write('Top queries,Clicks,Impressions,CTR,Position\nmerge pdf no upload,12,900,1.3%,7.4\nrandom,0,10,0%,40\nsubscription finder,3,300,1%,11.2\n')
        await pg.set_input_files('#gsc-drop input', [gsc]); await pg.wait_for_timeout(300)
        out = await pg.inner_text('#gsc-out')
        check('search console: opportunities listed, noise filtered', 'merge pdf no upload' in out and 'subscription finder' in out and 'random' not in out)

        # Pro tab reflects settings
        await pg.click('[data-tab=pro]')
        check('pro: status panel', 'not set' in await pg.inner_text('#pro-status'))

        # ---------- Customer dashboard
        await pg.goto(f'{BASE}/mortgage-calculator/?price=500000&down=100000&rate=6&term=30')
        await pg.click('text=☆ Add to favorites')
        check('my: favorite toggles', 'Saved to My PrivyForge' in await pg.inner_text('.fav-btn'))
        await pg.click('text=💾 Save this scenario'); await pg.wait_for_timeout(200)
        await pg.goto(f'{BASE}/debt-payoff-calculator/')
        await pg.goto(f'{BASE}/my/')
        check('my: favorites listed', 'Mortgage Calculator' in await pg.inner_text('#favs'))
        check('my: recent tools listed', 'Debt Payoff Planner' in await pg.inner_text('#recent'))
        href = await pg.get_attribute('#scenarios a', 'href')
        check('my: saved scenario keeps inputs', href and 'price=500000' in href, href)
        await pg.locator('[data-step=subs]').check()
        check('my: checkup progress', '1/5' in await pg.inner_text('#ck-h'))
        async with pg.expect_download() as d: await pg.click('#export')
        backup = json.load(open(await (await d.value).path()))
        check('my: backup export', backup['app'] == 'PrivyForge' and len(backup['data']['scenarios']) == 1)
        evil = os.path.join(os.path.dirname(__file__), 'out', 'evil.json')
        json.dump({'app': 'PrivyForge', 'data': {'scenarios': [{'id': 'x', 'name': '<img src=x onerror=window.__xss2=1>', 'tool': 'loan-calculator', 'url': 'javascript:alert(1)', 'savedAt': 0}]}}, open(evil, 'w'))
        await pg.set_input_files('#import', [evil]); await pg.wait_for_timeout(300)
        check('my: hostile backup rendered safely (no XSS, no javascript: link)', await pg.evaluate('window.__xss2') is None and await pg.locator('#scenarios a[href^="javascript"]').count() == 0 and '<img' in await pg.inner_text('#scenarios'))
        json.dump({'app': 'Other'}, open(evil, 'w'))
        await pg.set_input_files('#import', [evil]); await pg.wait_for_timeout(200)
        check('my: wrong file rejected', 'Not a PrivyForge backup' in await pg.inner_text('#bk-status'))

        check('token only ever sent to api.github.com', not other_hosts, other_hosts[:3])
        check('no JS errors', not errs, errs[:3])
        await b.close()
    print(f'\n{sum(results)}/{len(results)} passed')
asyncio.run(main())
