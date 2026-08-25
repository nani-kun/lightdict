#!/usr/bin/env python3
"""生成扩展图标：紫蓝渐变圆角方块 + 白色字母 D。
用法：python3 tools/make_icons.py   （输出到 icons/）
"""
from PIL import Image, ImageDraw, ImageFont
import os

SIZES = [16, 32, 48, 128]
SS = 8  # 超采样倍数
OUT = os.path.join(os.path.dirname(__file__), "..", "icons")

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/SFNSRounded.ttf",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/Library/Fonts/Arial.ttf",
]

def load_font(px):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, px, index=0)
            except Exception:
                try:
                    return ImageFont.truetype(path, px)
                except Exception:
                    continue
    return ImageFont.load_default()

def gradient(size, c1, c2):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(c1, c2))
    return img

def make(size):
    s = size * SS
    base = gradient(s, (99, 102, 241), (168, 85, 247))  # indigo -> violet

    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.235), fill=255)

    icon = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    icon.paste(base, (0, 0), mask)

    font = load_font(int(s * 0.68))
    draw = ImageDraw.Draw(icon)
    box = draw.textbbox((0, 0), "D", font=font)
    draw.text(
        ((s - (box[2] - box[0])) / 2 - box[0], (s - (box[3] - box[1])) / 2 - box[1]),
        "D",
        font=font,
        fill=(255, 255, 255, 255),
    )
    return icon.resize((size, size), Image.LANCZOS)

os.makedirs(OUT, exist_ok=True)
for size in SIZES:
    path = os.path.join(OUT, f"icon{size}.png")
    make(size).save(path, "PNG")
    print("wrote", os.path.relpath(path))
