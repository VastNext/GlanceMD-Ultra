#!/usr/bin/env python3
"""使用本地 OpenAI 兼容接口生成图标概念，密钥只从环境变量读取。"""

import base64
import json
import os
import sys
import urllib.request
from pathlib import Path


BASE_URL = os.environ.get("GLANCEMD_IMAGE_BASE_URL", "http://localhost:54978/v1").rstrip("/")
API_KEY = os.environ.get("OPENAI_API_KEY") or os.environ.get("GLANCEMD_IMAGE_API_KEY")
MODEL = "gpt-image-2"

PROMPTS = {
    "g-viewfinder": """A single square desktop application icon concept for GlanceMD Ultra. Abstract geometric G-shaped viewing window, a thick rounded G mark with a right-side opening, three tiny horizontal Markdown lines inside, purple-to-pink gradient from #a855f7 to #ec4899, deep charcoal rounded-square background, flat vector logo, crisp silhouette at 16px, no pencil, no words, no watermark, centered with generous padding.""",
    "workspace-tree": """A single square desktop application icon concept for GlanceMD Ultra. Minimal project workspace tree symbol: a clean vertical tree line with three connected rounded file nodes and one bright magenta text cursor stroke, purple-to-pink accent gradient, deep charcoal rounded-square background, flat vector logo, crisp at 16px, no pencil, no code brackets, no words, no watermark, centered with generous padding.""",
    "folded-page-u": """A single square desktop application icon concept for GlanceMD Ultra. Minimal folded Markdown document with a rounded page, folded top-right corner, subtle U-shaped negative space cut from the lower center, two or three bold document lines, restrained purple-to-pink gradient, deep charcoal rounded-square background, flat vector logo, crisp at 16px, no pencil, no words, no watermark, centered with generous padding.""",
}


def main() -> int:
    if not API_KEY:
        print("缺少 OPENAI_API_KEY 或 GLANCEMD_IMAGE_API_KEY", file=sys.stderr)
        return 2

    output_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/design/generated-icon-concepts")
    output_dir.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        f"{BASE_URL}/images/generations",
        data=json.dumps({"model": MODEL, "prompt": PROMPTS[sys.argv[2]] if len(sys.argv) > 2 else PROMPTS["g-viewfinder"], "n": 1, "size": "1024x1024"}).encode(),
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        payload = json.load(response)
    image = base64.b64decode(payload["data"][0]["b64_json"])
    name = sys.argv[2] if len(sys.argv) > 2 else "g-viewfinder"
    (output_dir / f"{name}.png").write_bytes(image)
    print(output_dir / f"{name}.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
