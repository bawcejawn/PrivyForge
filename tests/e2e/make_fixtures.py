# Generates test images + PDFs into tests/e2e/fx/
import os, random
from PIL import Image, ImageDraw, ImageFilter
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
fx = os.path.join(os.path.dirname(__file__), 'fx'); os.makedirs(fx, exist_ok=True); os.chdir(fx)
random.seed(1); w, h = 2400, 1600
img = Image.new('RGB', (w, h)); px = img.load()
for y in range(h):
    for x in range(w): px[x, y] = (int(120 + 100 * x / w), int(80 + 120 * y / h), int(150 + 60 * ((x * y) % 97) / 97))
d = ImageDraw.Draw(img)
for _ in range(300):
    x, y, r = random.randint(0, w), random.randint(0, h), random.randint(10, 120)
    d.ellipse([x, y, x + r, y + r], fill=tuple(random.randint(0, 255) for _ in range(3)))
img = img.filter(ImageFilter.GaussianBlur(2)); img.save('photo.jpg', quality=95); img.save('photo.png')
g = Image.new('RGBA', (800, 600), (0, 0, 0, 0)); dd = ImageDraw.Draw(g)
for i in range(20): dd.rectangle([i * 40, i * 25, i * 40 + 200, i * 25 + 120], fill=(i * 12, 200 - i * 8, 90, 200))
g.save('logo.png')
for name, n in [('a.pdf', 2), ('b.pdf', 3)]:
    c = canvas.Canvas(name, pagesize=letter)
    for p in range(n):
        c.setFont('Helvetica', 24); c.drawString(72, 700, f'{name} page {p + 1}')
        c.drawImage('photo.jpg', 72, 200, width=450, height=300); c.showPage()
    c.save()
print('fixtures ready in', fx)
