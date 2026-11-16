"""Renders the Vela app icon: a bright four-point star over a night sky, in a squircle.

Every size is drawn on its own rather than shrunk from the big one, so the small
taskbar and tray icons keep a bold, clean star instead of a blur.
"""
from PIL import Image, ImageChops, ImageDraw, ImageFilter
import math
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(HERE, "..", "src-tauri", "icons")
UI = os.path.join(HERE, "..", "ui", "assets")


def squircle(size, margin, n=5.0):
    """A superellipse mask, softer at the corners than a rounded square."""
    big = size * 4
    m = margin * 4
    r = (big - 2 * m) / 2
    c = big / 2
    pts = []
    for i in range(720):
        t = 2 * math.pi * i / 720
        ct, st = math.cos(t), math.sin(t)
        x = c + r * math.copysign(abs(ct) ** (2 / n), ct)
        y = c + r * math.copysign(abs(st) ** (2 / n), st)
        pts.append((x, y))
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def sparkle(cx, cy, radius, power, stretch=1.16, steps=600):
    """A four-point star with curved sides: the arms taper to fine points."""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        x = math.copysign(abs(ct) ** power, ct)
        y = math.copysign(abs(st) ** power, st)
        pts.append((cx + radius * x, cy + radius * stretch * y))
    return pts


def gradient(size, stops, angle):
    """A linear gradient across the square at `angle` degrees."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    a = math.radians(angle)
    dx, dy = math.cos(a), math.sin(a)
    lo = min(0, dx * size) + min(0, dy * size)
    hi = max(0, dx * size) + max(0, dy * size)
    for y in range(size):
        for x in range(size):
            t = ((x * dx + y * dy) - lo) / (hi - lo)
            for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
                if t <= t1:
                    k = (t - t0) / (t1 - t0) if t1 > t0 else 0
                    px[x, y] = tuple(int(c0[j] + (c1[j] - c0[j]) * k) for j in range(3))
                    break
    return img


def radial(size, cx, cy, radius, color, strength):
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=color + (int(255 * strength),))
    return layer.filter(ImageFilter.GaussianBlur(radius * 0.55))


def render(size, detailed):
    s = size * 2  # drawn at twice the size, then reduced, for smooth edges
    margin = s * (0.035 if detailed else 0.02)
    mask = squircle(s, margin)
    sky = gradient(s, [(0, (34, 30, 92)), (0.55, (20, 52, 112)), (1, (8, 96, 128))], 55).convert("RGBA")

    # Light behind the star, warm violet above and cool teal below.
    sky = Image.alpha_composite(sky, radial(s, s * 0.5, s * 0.47, s * 0.34, (120, 150, 255), 0.55))
    sky = Image.alpha_composite(sky, radial(s, s * 0.3, s * 0.22, s * 0.22, (170, 120, 255), 0.35))
    sky = Image.alpha_composite(sky, radial(s, s * 0.72, s * 0.8, s * 0.26, (40, 220, 210), 0.3))

    if detailed:
        # A scatter of faint stars, the same every time.
        rng = random.Random(7)
        specks = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        d = ImageDraw.Draw(specks)
        for _ in range(46):
            x, y = rng.uniform(0.1, 0.9) * s, rng.uniform(0.1, 0.9) * s
            if math.hypot(x - s / 2, y - s / 2) < s * 0.27:
                continue
            r = rng.uniform(0.0016, 0.0042) * s
            d.ellipse((x - r, y - r, x + r, y + r), fill=(255, 255, 255, int(rng.uniform(70, 170))))
        sky = Image.alpha_composite(sky, specks)

    # A soft sheen across the top, and a fine bright rim, like glass.
    sheen = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(sheen).ellipse((-s * 0.3, -s * 0.75, s * 1.3, s * 0.42), fill=(255, 255, 255, 18))
    sky = Image.alpha_composite(sky, sheen.filter(ImageFilter.GaussianBlur(s * 0.03)))

    cx, cy = s * 0.5, s * 0.5
    main_r = s * (0.3 if detailed else 0.36)
    power = 3.3 if detailed else 2.5

    # The star's glow, then the star, lit from above.
    glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(glow).polygon(sparkle(cx, cy, main_r * 1.02, power), fill=(140, 225, 255, 255))
    glow = glow.filter(ImageFilter.GaussianBlur(s * 0.045))
    sky = Image.alpha_composite(sky, glow)

    star_mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(star_mask).polygon(sparkle(cx, cy, main_r, power), fill=255)
    if detailed:
        ImageDraw.Draw(star_mask).polygon(sparkle(s * 0.74, s * 0.26, s * 0.07, 3.0, 1.12), fill=255)
        ImageDraw.Draw(star_mask).polygon(sparkle(s * 0.27, s * 0.73, s * 0.032, 3.0, 1.12), fill=200)
    star_fill = gradient(s, [(0, (255, 255, 255)), (0.6, (236, 246, 255)), (1, (170, 225, 255))], 90).convert("RGBA")
    star = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    star.paste(star_fill, (0, 0), star_mask)
    sky = Image.alpha_composite(sky, star)

    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(sky, (0, 0), mask)
    if detailed:
        inner = squircle(s, margin + s * 0.006)
        rim = ImageChops.subtract(mask, inner)
        rim_layer = Image.new("RGBA", (s, s), (255, 255, 255, 0))
        rim_layer.putalpha(rim.point(lambda v: int(v * 0.2)))
        out = Image.alpha_composite(out, rim_layer)
    return out.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(ICONS, exist_ok=True)
    big = render(1024, True)
    big.save(os.path.join(ICONS, "icon.png"))
    big.resize((512, 512), Image.LANCZOS).save(os.path.join(UI, "icon.png"))
    render(128, True).save(os.path.join(ICONS, "128x128.png"))
    render(32, False).save(os.path.join(ICONS, "32x32.png"))
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = [render(n, n >= 48) for n in sizes]
    frames[-1].save(os.path.join(ICONS, "icon.ico"), format="ICO", sizes=[(n, n) for n in sizes], append_images=frames[:-1])
    print("ok")


if __name__ == "__main__":
    main()
