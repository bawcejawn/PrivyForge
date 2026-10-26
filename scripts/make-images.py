"""Generate social-share images and app icons (committed to public/; not run on deploy).

    pip install playwright && python -m playwright install chromium
    python scripts/make-images.py

Outputs:
  public/og.png                 1200x630 default share image
  public/og/<slug>.png          1200x630 per tool (tools.json) and per guide (content/guides/*.md)
  public/icon-192.png, icon-512.png, apple-touch-icon.png (180)

Re-run after adding a tool or guide. Pages without their own image fall back to og.png.
"""
import asyncio, html, json, os, re, sys
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, 'public')
EMBER, INK, CREAM, MUTED = '#d9480f', '#14110f', '#faf8f5', '#b3a99e'
LOGO = f'''<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="8" fill="{EMBER}"/><path d="M9 22V10h7.2c3 0 4.8 1.7 4.8 4.2S19.2 18.4 16.2 18.4H12.6V22z M12.6 15.6h3.3c1.2 0 1.8-.6 1.8-1.4s-.6-1.4-1.8-1.4h-3.3z" fill="#fff"/><circle cx="24" cy="22" r="2" fill="#fff"/></svg>'''


def card(title, subtitle, kicker):
    e = html.escape
    size = 76 if len(title) <= 28 else 64 if len(title) <= 44 else 54
    return f'''<!doctype html><html><head><meta charset="utf-8"><style>
    *{{margin:0;box-sizing:border-box}}
    body{{width:1200px;height:630px;background:{INK};color:{CREAM};font-family:Inter,system-ui,sans-serif;
      padding:64px 72px;display:flex;flex-direction:column;position:relative;overflow:hidden}}
    .bar{{position:absolute;left:0;right:0;bottom:0;height:14px;background:{EMBER}}}
    .brand{{display:flex;align-items:center;gap:16px;font-size:34px;font-weight:800;letter-spacing:-.02em}}
    .brand svg{{width:56px;height:56px}}
    .kicker{{margin-top:auto;font-size:24px;font-weight:700;color:{EMBER};text-transform:uppercase;letter-spacing:.08em}}
    h1{{font-size:{size}px;line-height:1.05;letter-spacing:-.035em;font-weight:800;margin-top:14px;max-width:1000px}}
    p{{font-size:30px;color:{MUTED};margin:20px 0 18px;max-width:1040px;line-height:1.3}}
    .pill{{position:absolute;right:72px;top:72px;font-size:22px;font-weight:600;color:#69db7c;
      border:2px solid #69db7c55;border-radius:999px;padding:8px 20px}}
    </style></head><body><div class="bar"></div>
    <div class="brand">{LOGO}PrivyForge</div>
    <div class="kicker">{e(kicker)}</div><h1>{e(title)}</h1>{f"<p>{e(subtitle)}</p>" if subtitle else ""}
    <div class="pill">🔒 Runs in your browser · nothing uploaded</div></body></html>'''


def icon(size):
    return f'''<!doctype html><html><head><style>*{{margin:0}}body{{width:{size}px;height:{size}px;background:{EMBER}}}
    svg{{width:{size}px;height:{size}px;display:block}}</style></head><body>{LOGO.replace('rx="8"', 'rx="0"')}</body></html>'''


def front_matter(text):
    m = re.match(r'^---\r?\n([\s\S]*?)\r?\n---', text)
    meta = {}
    for line in (m.group(1).splitlines() if m else []):
        if ':' in line:
            k, v = line.split(':', 1); meta[k.strip()] = v.strip().strip('"\'')
    return meta


def jobs():
    out = [('og.png', card('Free tools that never see your files.', 'Compress images & PDFs, find forgotten subscriptions, plan debt payoff — free, unlimited, private.', 'Image · PDF · Money tools'), (1200, 630))]
    tools = json.load(open(os.path.join(ROOT, 'src/data/tools.json')))
    for t in tools:
        if t.get('enabled') is False or '?' in t['href']:
            continue
        out.append((f"og/{t['slug']}.png", card(t['title'], t.get('blurb', ''), t.get('category', 'Tool')), (1200, 630)))
    gdir = os.path.join(ROOT, 'content/guides')
    for f in sorted(os.listdir(gdir)) if os.path.isdir(gdir) else []:
        if f.endswith('.md'):
            meta = front_matter(open(os.path.join(gdir, f), encoding='utf-8').read())
            if meta.get('title') and meta.get('draft') != 'true':
                out.append((f"og/{f[:-3]}.png", card(meta['title'], '', 'Guide'), (1200, 630)))
    for name, s in [('icon-192.png', 192), ('icon-512.png', 512), ('apple-touch-icon.png', 180)]:
        out.append((name, icon(s), (s, s)))
    return out


async def main():
    os.makedirs(os.path.join(PUB, 'og'), exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for rel, doc, (w, h) in jobs():
            pg = await b.new_page(viewport={'width': w, 'height': h})
            await pg.set_content(doc); await pg.evaluate('document.fonts.ready')
            await pg.screenshot(path=os.path.join(PUB, rel), clip={'x': 0, 'y': 0, 'width': w, 'height': h})
            await pg.close(); print('wrote', rel)
        await b.close()

if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
