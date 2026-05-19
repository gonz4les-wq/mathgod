"""Generate Mathgod app icons — "Dark + neon" design.

Pure deep-black square, bold off-axis multiplication mark in a vivid
magenta -> violet gradient, with a soft outer glow. Designed to stand
out on an iOS home screen alongside other premium dark icons.

Run from the repo root:
    python3 icons/_generate.py
"""

from PIL import Image, ImageDraw, ImageFilter
import math
import os

OUT = os.path.dirname(os.path.abspath(__file__))

# Background: very dark with a hint of cool indigo, so the gradient mark
# reads as the focal point. Not pure black so the icon doesn't disappear
# in dark mode home screens.
BG_TOP    = (15, 14, 23)
BG_BOTTOM = (8, 8, 14)

# The × is a two-stop gradient. Top is magenta-pink, bottom is electric violet.
MARK_TOP    = (244, 114, 182)   # rose-400
MARK_BOTTOM = (139, 92, 246)    # violet-500


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def vertical_gradient(size, top, bottom):
    img = Image.new("RGB", (size, size), top)
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        for x in range(size):
            px[x, y] = (r, g, b)
    return img


def radial_highlight(size, color=(255, 255, 255, 16), center=(0.25, 0.20), radius=0.85):
    """Soft diagonal highlight in the upper-left — gives premium dark icons depth."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cx, cy = int(size * center[0]), int(size * center[1])
    r = int(size * radius)
    px = layer.load()
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - cx, y - cy) / r
            if d >= 1:
                continue
            a = int(color[3] * (1 - d) ** 2)
            if a > 0:
                px[x, y] = (color[0], color[1], color[2], a)
    return layer


def make_mark_layer(size, scale=1.0):
    """Build the × mark on a transparent canvas. Drawn at 2x then downsampled
    for clean edges, with a gradient fill applied via mask compositing."""
    SS = 2  # super-sampling factor
    s = size * SS
    arm   = s * 0.34 * scale
    thick = s * 0.115 * scale
    cx = cy = s / 2

    # 1. Build a binary alpha mask for the two crossed bars.
    mask = Image.new("L", (s, s), 0)
    md = ImageDraw.Draw(mask)
    for angle in (45, -45):
        a = math.radians(angle)
        cos, sin = math.cos(a), math.sin(a)
        pts = [(-arm, -thick), (arm, -thick), (arm, thick), (-arm, thick)]
        rot = [(cx + x * cos - y * sin, cy + x * sin + y * cos) for x, y in pts]
        md.polygon(rot, fill=255)

    # 2. Build a vertical gradient bar to fill the mask.
    grad = vertical_gradient(s, MARK_TOP, MARK_BOTTOM).convert("RGBA")

    # 3. Composite using the mask as alpha.
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)

    # 4. Add a faint top-inner highlight so the mark feels lit.
    highlight = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    hd = ImageDraw.Draw(highlight)
    inner_mask = Image.new("L", (s, s), 0)
    imd = ImageDraw.Draw(inner_mask)
    for angle in (45, -45):
        a = math.radians(angle)
        cos, sin = math.cos(a), math.sin(a)
        # Slightly inset rect, biased to the top half.
        pts = [(-arm * 0.9, -thick * 0.7), (arm * 0.9, -thick * 0.7),
               (arm * 0.9, thick * 0.05), (-arm * 0.9, thick * 0.05)]
        rot = [(cx + x * cos - y * sin, cy + x * sin + y * cos) for x, y in pts]
        imd.polygon(rot, fill=70)
    inner_mask = inner_mask.filter(ImageFilter.GaussianBlur(radius=s * 0.012))
    highlight.paste((255, 255, 255, 255), (0, 0), inner_mask)
    out.alpha_composite(highlight)

    return out.resize((size, size), Image.LANCZOS)


def make_glow(mark_layer, size, strength=0.025, intensity=180):
    """Soft outer glow behind the mark in its own tint."""
    # Take the alpha of the mark, blur it, and colour it with the mark's mid tone.
    alpha = mark_layer.split()[-1]
    glow_alpha = alpha.filter(ImageFilter.GaussianBlur(radius=size * strength))
    # Mid colour between MARK_TOP and MARK_BOTTOM.
    mid = tuple((MARK_TOP[i] + MARK_BOTTOM[i]) // 2 for i in range(3))
    glow = Image.new("RGBA", (size, size), (*mid, 0))
    # Scale by intensity.
    a = glow_alpha.point(lambda v: min(255, int(v * intensity / 255)))
    glow.putalpha(a)
    return glow


def make_icon(size, maskable=False, rounded=True):
    # Background.
    bg = vertical_gradient(size, BG_TOP, BG_BOTTOM).convert("RGBA")
    bg.alpha_composite(radial_highlight(size))

    # Mark + glow.
    scale = 0.78 if maskable else 1.0
    mark = make_mark_layer(size, scale=scale)
    glow = make_glow(mark, size, strength=0.055, intensity=200)

    composite = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    composite.alpha_composite(bg)
    composite.alpha_composite(glow)
    composite.alpha_composite(mark)

    # A 1px inner stroke gives the icon definition on light backgrounds.
    if not maskable:
        stroke = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        sd = ImageDraw.Draw(stroke)
        sd.rounded_rectangle(
            (0.5, 0.5, size - 1.5, size - 1.5),
            radius=int(size * 0.22) - 1,
            outline=(255, 255, 255, 18),
            width=1,
        )
        composite.alpha_composite(stroke)

    if maskable or not rounded:
        return composite

    mask = rounded_mask(size, int(size * 0.22))
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(composite, (0, 0), mask)
    return out


def main():
    sizes = [(180, "apple-touch-icon.png", False, True),
             (192, "icon-192.png",         False, True),
             (512, "icon-512.png",         False, True),
             (512, "icon-maskable-512.png", True, False),
             (32,  "favicon-32.png",       False, True)]
    for size, name, maskable, rounded in sizes:
        img = make_icon(size, maskable=maskable, rounded=rounded)
        img.save(os.path.join(OUT, name), "PNG", optimize=True)
        print("wrote", name)

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgb{BG_TOP}"/>
      <stop offset="1" stop-color="rgb{BG_BOTTOM}"/>
    </linearGradient>
    <linearGradient id="mk" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgb{MARK_TOP}"/>
      <stop offset="1" stop-color="rgb{MARK_BOTTOM}"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="1.8"/>
    </filter>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#bg)"/>
  <g transform="rotate(45 32 32)" filter="url(#glow)" opacity="0.55">
    <rect x="12" y="29" width="40" height="6" rx="3" fill="url(#mk)"/>
    <rect x="29" y="12" width="6" height="40" rx="3" fill="url(#mk)"/>
  </g>
  <g transform="rotate(45 32 32)">
    <rect x="12" y="29" width="40" height="6" rx="3" fill="url(#mk)"/>
    <rect x="29" y="12" width="6" height="40" rx="3" fill="url(#mk)"/>
  </g>
</svg>
'''
    with open(os.path.join(OUT, "icon.svg"), "w") as f:
        f.write(svg)
    print("wrote icon.svg")


if __name__ == "__main__":
    main()
