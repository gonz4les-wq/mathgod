"""Generate app icons for the Mathgod PWA.

Produces a small set of PNGs (and a maskable variant) plus a favicon SVG.
Run once locally; outputs are committed to the repo. The script is kept here
so the icons can be regenerated if the brand mark ever changes.
"""

from PIL import Image, ImageDraw, ImageFilter, ImageFont
import os

OUT = os.path.dirname(os.path.abspath(__file__))

# Brand: a calm indigo->violet gradient with a soft white multiplication mark.
TOP = (99, 102, 241)      # indigo-500
BOTTOM = (139, 92, 246)   # violet-500


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def gradient(size):
    img = Image.new("RGB", (size, size), TOP)
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
        g = int(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
        b = int(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
        for x in range(size):
            px[x, y] = (r, g, b)
    return img


def draw_mark(img, scale=1.0, color=(255, 255, 255, 240)):
    """Draw a soft, thick multiplication cross centered on img."""
    size = img.size[0]
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    arm = size * 0.30 * scale
    thick = size * 0.085 * scale
    cx = cy = size / 2
    # Two rotated rectangles approximated as polygons.
    import math
    for angle in (45, -45):
        a = math.radians(angle)
        cos, sin = math.cos(a), math.sin(a)
        pts = [(-arm, -thick), (arm, -thick), (arm, thick), (-arm, thick)]
        rotated = [(cx + x * cos - y * sin, cy + x * sin + y * cos) for x, y in pts]
        d.polygon(rotated, fill=color)
    # Slight blur for softness.
    layer = layer.filter(ImageFilter.GaussianBlur(radius=size * 0.004))
    img.alpha_composite(layer)


def make_icon(size, maskable=False, rounded=True):
    base = gradient(size).convert("RGBA")
    if maskable:
        # Maskable: full bleed background, mark scaled to safe zone (~80%).
        draw_mark(base, scale=0.80)
        return base
    if rounded:
        mask = rounded_mask(size, int(size * 0.22))
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out.paste(base, (0, 0), mask)
        draw_mark(out, scale=1.0)
        return out
    draw_mark(base, scale=1.0)
    return base


def main():
    sizes = [(180, "apple-touch-icon.png", False, True),
             (192, "icon-192.png", False, True),
             (512, "icon-512.png", False, True),
             (512, "icon-maskable-512.png", True, False),
             (32,  "favicon-32.png", False, True)]
    for size, name, maskable, rounded in sizes:
        img = make_icon(size, maskable=maskable, rounded=rounded)
        img.save(os.path.join(OUT, name), "PNG", optimize=True)
        print("wrote", name)

    # SVG favicon — crisp at any size.
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgb{TOP}"/>
      <stop offset="1" stop-color="rgb{BOTTOM}"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#g)"/>
  <g stroke="white" stroke-width="6" stroke-linecap="round" opacity="0.95">
    <line x1="20" y1="20" x2="44" y2="44"/>
    <line x1="44" y1="20" x2="20" y2="44"/>
  </g>
</svg>
'''
    with open(os.path.join(OUT, "icon.svg"), "w") as f:
        f.write(svg)
    print("wrote icon.svg")


if __name__ == "__main__":
    main()
