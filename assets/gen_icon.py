# -*- coding: utf-8 -*-
"""从正式 PNG 图标生成 Windows 多尺寸 ICO。"""

from pathlib import Path

from PIL import Image


SOURCE = Path(__file__).with_name("icon.png")
OUTPUT = Path(__file__).with_name("icon.ico")
SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


with Image.open(SOURCE) as source:
    source.convert("RGBA").save(OUTPUT, format="ICO", sizes=SIZES)

print(f"已从 {SOURCE.name} 生成 {OUTPUT.name}")
