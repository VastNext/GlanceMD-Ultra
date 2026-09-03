# -*- coding: utf-8 -*-
# GlanceMD 图标生成：蓝→紫对角渐变圆角底 + 一支笔在写文件（白纸 + 文字线 + 斜笔）
from PIL import Image, ImageDraw, ImageFilter

S = 512  # 画布尺寸
# 底色：亮紫 → 粉（Marco 主题渐变，v1 版配色）
C1 = (186, 113, 255)   # #ba71ff 亮紫
C2 = (236, 72, 153)    # #ec4899 Marco 粉

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# ── 对角渐变（左上→右下逐行插值）──
grad = Image.new("RGBA", (S, S))
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / (S - 1)
    r = int(C1[0] + (C2[0] - C1[0]) * t)
    g = int(C1[1] + (C2[1] - C1[1]) * t)
    b = int(C1[2] + (C2[2] - C1[2]) * t)
    gd.line([(0, y), (S, y)], fill=(r, g, b, 255))

# ── 圆角蒙版 ──
RADIUS = 118
mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, S - 1, S - 1], radius=RADIUS, fill=255)
icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
icon.paste(grad, (0, 0), mask)

# ── 顶部高光：柔光增加明亮质感 ──
hl = Image.new("L", (S, S), 0)
hd = ImageDraw.Draw(hl)
hd.ellipse([S * 0.05, -S * 0.25, S * 0.95, S * 0.45], fill=60)
hl = hl.filter(ImageFilter.GaussianBlur(60))
white = Image.new("RGBA", (S, S), (255, 255, 255, 255))
icon.paste(Image.composite(white, icon, hl), (0, 0), mask)

# ── 纸张（白色圆角矩形 + 投影）──
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
sd.rounded_rectangle([128, 124, 386, 404], radius=22, fill=(40, 10, 70, 110))
shadow = shadow.filter(ImageFilter.GaussianBlur(14))
icon = Image.alpha_composite(icon, shadow)

paper = Image.new("RGBA", (S, S), (0, 0, 0, 0))
pd = ImageDraw.Draw(paper)
pd.rounded_rectangle([128, 120, 386, 400], radius=22, fill=(255, 255, 255, 255))

# 纸上文字线（Markdown 段落意象：标题线 + 三行正文线）
LINE = (139, 92, 246, 165)  # 主题紫半透明
pd.rounded_rectangle([162, 158, 306, 174], radius=8, fill=(139, 92, 246, 220))  # 标题：短粗
pd.rounded_rectangle([162, 208, 352, 220], radius=6, fill=LINE)
pd.rounded_rectangle([162, 248, 352, 260], radius=6, fill=LINE)
pd.rounded_rectangle([162, 288, 300, 300], radius=6, fill=LINE)

# ── 笔：竖直绘制后旋转 45°，笔尖朝左下、笔杆伸向右上 ──
PW = 260  # 笔画布
pen = Image.new("RGBA", (PW, PW), (0, 0, 0, 0))
pend = ImageDraw.Draw(pen)
cx = PW // 2
# 笔杆（白）
pend.rounded_rectangle([cx - 24, 8, cx + 24, 168], radius=10,
                       fill=(255, 255, 255, 255), outline=(90, 50, 130, 90), width=2)
# 笔夹（深紫细条）
pend.rounded_rectangle([cx + 6, 20, cx + 14, 80], radius=4, fill=(90, 50, 130, 140))
# 笔握（浅灰）
pend.rounded_rectangle([cx - 22, 168, cx + 22, 196], radius=6,
                       fill=(232, 230, 240, 255), outline=(90, 50, 130, 90), width=2)
# 笔尖锥（香槟金）
pend.polygon([(cx - 22, 196), (cx + 22, 196), (cx + 4, 238), (cx - 4, 238)],
             fill=(245, 200, 110, 255))
# 笔头（深色）
pend.polygon([(cx - 4, 238), (cx + 4, 238), (cx, 256)], fill=(70, 40, 100, 255))
# 笔尖触点（在纸面留下的一点）
icon = Image.alpha_composite(icon, paper)
pen = pen.rotate(45, resample=Image.BICUBIC, expand=True)
# 贴放位置：笔尖落在纸面文字区右下方，笔杆越出纸右上角
icon.alpha_composite(pen, (168, 128))

icon.save("assets/icon.png")

# ── 多分辨率 ICO ──
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
icon.save("assets/icon.ico", format="ICO", sizes=sizes)
print("icon.png + icon.ico generated")
