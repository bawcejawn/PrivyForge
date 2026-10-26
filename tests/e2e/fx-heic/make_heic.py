# Regenerates the committed HEIC fixtures in this folder (deterministic, synthetic images, no
# third-party content). Needs pillow-heif (`pip install pillow-heif`), which bundles libheif + x265.
# The e2e tests only read the .heic files, so pillow-heif isn't needed to run them.
import os, math
from PIL import Image, ImageDraw
import pillow_heif

pillow_heif.register_heif_opener()
HERE = os.path.dirname(os.path.abspath(__file__))

def scene(w, h, hue=0):
    """A photo-like test card: sky gradient, hills, sun, fine stripes (so JPEGs aren't tiny)."""
    im = Image.new('RGB', (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            t = y / h
            ridge = h * (0.62 + 0.08 * math.sin(x / w * 7 + hue) + 0.03 * math.sin(x / w * 31))
            if y > ridge:
                g = 90 + int(60 * math.sin(x * 0.05) * math.sin(y * 0.07))
                px[x, y] = (40 + (x * 7 + y * 3) % 40, max(0, min(255, g)), 50 + (hue * 40) % 60)
            else:
                px[x, y] = (int(90 + 120 * t), int(150 + 80 * t), 235 - (x // 3 % 9) * 2)
    d = ImageDraw.Draw(im)
    r = h // 8
    d.ellipse((w * 0.7 - r, h * 0.2 - r, w * 0.7 + r, h * 0.2 + r), fill=(255, 220, 90))
    d.rectangle((w * 0.1, h * 0.1, w * 0.1 + h * 0.12, h * 0.22), fill=(200, 30, 30))  # red square, top-left
    return im

# 1) photo.heic: 1200x800 landscape, a single image.
scene(1200, 800).save(os.path.join(HERE, 'photo.heic'), quality=60)

# 2) burst.heic: two images; the SECOND (640x480) is marked primary, the first is 320x240.
a, b = scene(320, 240, 2), scene(640, 480)
a.save(os.path.join(HERE, 'burst.heic'), quality=50, save_all=True, append_images=[b], primary_index=1)

# 3) rotated.heic: 600x400 pixels stored with EXIF orientation 6 (rotate 90° CW to display),
#    so a correct decoder shows a 400x600 portrait with the red square at the top-right.
im = scene(600, 400)
exif = Image.Exif(); exif[0x0112] = 6
im.save(os.path.join(HERE, 'rotated.heic'), quality=50, exif=exif.tobytes())

for f in ('photo.heic', 'burst.heic', 'rotated.heic'):
    p = os.path.join(HERE, f)
    hf = pillow_heif.open_heif(p)
    print(f, os.path.getsize(p), 'bytes', [(i.size, i.info.get('primary')) for i in hf], 'opens as', Image.open(p).size)
