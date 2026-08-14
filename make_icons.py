# -*- coding: utf-8 -*-
"""Генерация PNG-иконок для PWA (дизайн повторяет icon.svg)."""
from PIL import Image, ImageDraw
import os

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "icons")
os.makedirs(OUT, exist_ok=True)

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

INDIGO = (99, 102, 241)
PURPLE = (168, 85, 247)
WHITE = (255, 255, 255)
HEADER = (224, 231, 255)
RING = (199, 210, 254)
GREEN = (34, 197, 94)

def gradient(size, c1, c2):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        c = lerp(c1, c2, t)
        for x in range(size):
            px[x, y] = c
    return img

def draw_icon(size, full_bleed=False):
    S = size / 48.0
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    g = gradient(size, INDIGO, PURPLE)

    if full_bleed:
        base = g.copy()
    else:
        base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        mask = Image.new("L", (size, size), 0)
        d = ImageDraw.Draw(mask)
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(11 * S), fill=255)
        base.paste(g, (0, 0), mask)
    d = ImageDraw.Draw(base)

    # белый лист календаря
    sheet = [int(8 * S), int(12 * S), int(40 * S), int(40 * S)]
    d.rounded_rectangle(sheet, radius=int(6 * S), fill=WHITE)
    # шапка листа
    d.rounded_rectangle([sheet[0], sheet[1], sheet[2], int(19.5 * S)], radius=int(3.75 * S), fill=HEADER)
    # кольца
    for cx in (int(15.3 * S), int(32.7 * S)):
        d.rounded_rectangle([cx - int(1.8 * S), int(2.5 * S), cx + int(1.8 * S), int(10.5 * S)], radius=int(1.8 * S), fill=RING)
    # галочка
    pts = [(14.5 * S, 28.5 * S), (20 * S, 34 * S), (33.5 * S, 21 * S)]
    d.line(pts, fill=GREEN, width=max(2, int(4.2 * S)), joint="curve")
    return base

for sz in (192, 512):
    draw_icon(sz).save(os.path.join(OUT, f"icon-{sz}.png"))
    print(f"icon-{sz}.png ok")

draw_icon(180, full_bleed=True).save(os.path.join(OUT, "apple-touch-icon.png"))
print("apple-touch-icon.png ok")
