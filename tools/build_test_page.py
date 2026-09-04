#!/usr/bin/env python3
"""组装前端测试页：复刻 main.rs::build_html 的占位符拼接逻辑。

与 Rust 侧的差异仅两点：
1. 平台标记可通过 --platform 指定（真实二进制按编译目标写入）；
2. 在产品脚本之前注入 tests/mock-bootstrap.js 的 IPC mock 引导脚本，
   并额外输出 tests/.tmp/mock-ipc.js 供 Playwright addInitScript 使用。

拼接规则（与 main.rs::build_html 保持一致，勿单方面改动）：
- index.html 中 ``/* __CSS__ */`` 替换为 style.css 全文；
- ``<body>`` 替换为 ``<body data-platform="{platform}">``；
- ``<!-- __SCRIPTS__ -->`` 替换为按序 6 个内联 <script>：
  highlight.min.js -> marked.min.js -> preview.js -> tabs.js -> editor.js -> app.js；
- 每个 JS 经 ``</script`` -> ``<\\/script`` 转义后内联，防止提前闭合标签。

用法
----
    python tools/build_test_page.py                    # 输出 tests/.tmp/index.html
    python tools/build_test_page.py --platform macos   # 改平台标记

输出
----
    tests/.tmp/index.html   组装测试页（浏览器/Playwright 用 file:// 加载）
    tests/.tmp/mock-ipc.js  独立 IPC mock（Playwright addInitScript 用）
"""

from __future__ import annotations

import argparse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIR = REPO_ROOT / "src" / "frontend"
DEFAULT_MOCK = REPO_ROOT / "tests" / "mock-bootstrap.js"
DEFAULT_OUT = REPO_ROOT / "tests" / ".tmp" / "index.html"

# 与 main.rs::build_html 的脚本顺序严格一致
SCRIPT_ORDER = (
    "highlight.min.js",
    "marked.min.js",
    "preview.js",
    "tabs.js",
    "editor.js",
    "app.js",
)


def escape_for_script_tag(js: str) -> str:
    """等价于 main.rs::escape_for_script_tag。"""
    return js.replace("</script", "<\\/script")


def build_html(platform: str, mock_bootstrap: str) -> str:
    index_html = (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")
    style_css = (FRONTEND_DIR / "style.css").read_text(encoding="utf-8")

    if "/* __CSS__ */" not in index_html:
        raise SystemExit("[error] index.html 缺少 /* __CSS__ */ 占位符，与 main.rs::build_html 假设不符")
    if "<!-- __SCRIPTS__ -->" not in index_html:
        raise SystemExit("[error] index.html 缺少 <!-- __SCRIPTS__ --> 占位符，与 main.rs::build_html 假设不符")
    if "<body>" not in index_html:
        raise SystemExit("[error] index.html 缺少 <body> 标签，与 main.rs::build_html 假设不符")

    scripts = f"<script>{escape_for_script_tag(mock_bootstrap)}</script>\n" + "\n".join(
        f"<script>{escape_for_script_tag((FRONTEND_DIR / name).read_text(encoding='utf-8'))}</script>"
        for name in SCRIPT_ORDER
    )

    html = index_html.replace("/* __CSS__ */", style_css)
    html = html.replace("<body>", f'<body data-platform="{platform}">')
    html = html.replace("<!-- __SCRIPTS__ -->", scripts)
    return html


def main() -> int:
    parser = argparse.ArgumentParser(description="组装前端测试页（复刻 build_html 拼接）")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="输出路径（默认 tests/.tmp/index.html）")
    parser.add_argument("--platform", default="windows", choices=("windows", "macos", "linux"),
                        help="data-platform 标记（默认 windows）")
    parser.add_argument("--mock", type=Path, default=DEFAULT_MOCK,
                        help="IPC mock 引导脚本（默认 tests/mock-bootstrap.js）")
    args = parser.parse_args()

    if not args.mock.exists():
        raise SystemExit(f"[error] mock 引导脚本不存在：{args.mock}")
    if not all((FRONTEND_DIR / name).exists() for name in SCRIPT_ORDER):
        missing = [name for name in SCRIPT_ORDER if not (FRONTEND_DIR / name).exists()]
        raise SystemExit(f"[error] 前端脚本缺失：{missing}")

    mock_bootstrap = args.mock.read_text(encoding="utf-8")
    html = build_html(args.platform, mock_bootstrap)

    # newline="\n"：真实 build_html 产物不转换换行（保持 LF），
    # 若按平台默认写出 CRLF，下游字符串断言与 file:// 页面行为都会漂移
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(html, encoding="utf-8", newline="\n")
    mock_copy = args.out.parent / "mock-ipc.js"
    mock_copy.write_text(mock_bootstrap, encoding="utf-8", newline="\n")

    script_tags = html.count("<script>")
    print(f"组装页   : {args.out}（{len(html.encode('utf-8'))} 字节，{script_tags} 个 <script>）")
    print(f"IPC mock : {mock_copy}")
    print(f"平台标记 : data-platform=\"{args.platform}\"")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
