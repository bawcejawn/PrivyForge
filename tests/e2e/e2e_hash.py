# Browser tests: file hash checker + support page.
import asyncio, os, hashlib, json
from playwright.async_api import async_playwright
BASE = os.environ.get('BASE', 'http://localhost:4173')
OUT = os.path.join(os.path.dirname(__file__), 'out'); os.makedirs(OUT, exist_ok=True)
results = []
def check(n, ok, info=''): results.append(ok); print(('PASS ' if ok else 'FAIL ') + n, str(info)[:200])

async def main():
    f = os.path.join(OUT, 'download.bin'); data = os.urandom(3_000_000); open(f, 'wb').write(data)
    sha = hashlib.sha256(data).hexdigest(); sha512 = hashlib.sha512(data).hexdigest()
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(accept_downloads=True); pg = await ctx.new_page()
        ext, posts, errs = [], [], []
        pg.on('request', lambda r: (ext.append(r.url) if not r.url.startswith(BASE) and not r.url.startswith(('blob:', 'data:')) else None, posts.append(r.url) if r.method != 'GET' else None))
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(f'{BASE}/file-hash-checker/')
        await pg.set_input_files('#drop input', [f])
        await pg.wait_for_function(f"document.querySelector('#files').innerText.includes('{sha}')", timeout=30000)
        check('hash: SHA-256 matches Python hashlib', True, sha[:16])
        await pg.fill('#expected', f'{sha.upper()}  download.bin')
        check('hash: expected match shown', 'Match' in await pg.inner_text('#files'))
        await pg.fill('#expected', '0' * 64)
        check('hash: mismatch shown', 'No match' in await pg.inner_text('#files'))
        await pg.fill('#expected', sha512)
        await pg.wait_for_function("document.querySelector('#files').innerText.includes('Match')", timeout=30000)
        check('hash: pasting a SHA-512 switches algorithm and matches', await pg.input_value('#algo') == 'SHA-512')
        async with pg.expect_download() as d: await pg.click('[data-proof]')
        rec = json.load(open(await (await d.value).path()))
        check('hash: proof receipt has correct sha256', rec['sha256'] == sha and rec['bytes'] == len(data), rec['sha256'][:16])
        # support page: default config -> fallback text, no crypto section
        await pg.goto(f'{BASE}/support/')
        check('support: empty config shows fallback', 'coming soon' in await pg.inner_text('#links') and not await pg.is_visible('#crypto-wrap'))
        check('ZERO external requests', not ext, ext[:3]); check('ZERO non-GET requests', not posts, posts[:3]); check('no JS errors', not errs, errs[:3])
        await b.close()
    print(f'\n{sum(results)}/{len(results)} passed')
asyncio.run(main())
