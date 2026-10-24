"""Regenerate the circular launcher icon from assets/adaptive-icon.png.

Writes assets/launcher-icon.png (green disc on transparent, the adaptive
foreground) and the committed Android mipmaps derived from it.
"""
from PIL import Image, ImageDraw
import os

ROOT = os.path.join(os.path.dirname(__file__), '..')
RES = os.path.join(ROOT, 'android/app/src/main/res')
DISC = 0.68    # disc diameter / canvas: the 72dp adaptive visible area of 108dp
GLYPH = 0.9    # glyph scale inside the disc, leaves a margin
SS = 4         # supersampling for the disc edge

src = Image.open(os.path.join(ROOT, 'assets/adaptive-icon.png')).convert('RGBA')
n = src.width
green = src.getpixel((2, 2))

canvas = Image.new('RGBA', (n, n), green)
g = int(n * GLYPH)
canvas.paste(src.resize((g, g), Image.LANCZOS), ((n - g) // 2, (n - g) // 2))

mask = Image.new('L', (n * SS, n * SS), 0)
d = n * SS
off = d * (1 - DISC) / 2
ImageDraw.Draw(mask).ellipse([off, off, d - off, d - off], fill=255)
mask = mask.resize((n, n), Image.LANCZOS)
canvas.putalpha(mask)
canvas.save(os.path.join(ROOT, 'assets/launcher-icon.png'))

for dens, mult in [('mdpi', 1), ('hdpi', 1.5), ('xhdpi', 2), ('xxhdpi', 3), ('xxxhdpi', 4)]:
    out = os.path.join(RES, f'mipmap-{dens}')
    canvas.resize((int(108 * mult),) * 2, Image.LANCZOS).save(os.path.join(out, 'ic_launcher_foreground.png'))
    # Legacy (API < 26) raster: the disc fills the 48dp icon.
    box = int(n * (1 - DISC) / 2)
    legacy = canvas.crop((box, box, n - box, n - box)).resize((int(48 * mult),) * 2, Image.LANCZOS)
    legacy.save(os.path.join(out, 'ic_launcher.png'))
    legacy.save(os.path.join(out, 'ic_launcher_round.png'))
