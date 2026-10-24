# Browser end-to-end tests

Runs every tool in headless Chromium and asserts real outputs **plus zero uploads**.

```bash
pip install playwright pypdf opencv-python pillow reportlab && python -m playwright install chromium
python tests/e2e/make_fixtures.py          # creates tests/e2e/fx/
npm run build && npm run preview &          # serves on :4173
python tests/e2e/e2e.py
```
