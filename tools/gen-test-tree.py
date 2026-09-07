#!/usr/bin/env python3
"""生成确定性的 N 文件测试目录树（阶段 0 测试基建 / 阶段 1 十千文件门禁用）。

用途
----
为项目树枚举、全文搜索等功能的性能与正确性测试提供可复现的大目录：

- 文件总数由 ``--count`` 精确控制（默认 10000，指**默认可见**的普通文件数）
- 目录深度确定性混合 2–6 层（强制构造 d=2..6 的链，保证极值深度一定出现）
- 扩展名覆盖默认可见集合：.md .markdown .txt .json .yaml .yml .toml .ini .csv
- 额外"夹带"默认排除目录 node_modules/target/.venv/dist/build/.cache
  （各 50–100 个文件，另在深层目录再撒少量嵌套实例，供阶段 1 过滤逻辑测试）
- 夹带若干隐藏文件（点前缀名，如 .env / .hidden-note.md）
- 每个 .md 文件包含标题 + 段落 + 代码块，并带唯一搜索锚点
  ``needle-NNNNN``（供全文搜索测试断言命中与不误报）

固定随机种子（20260904），同参数重复运行产出完全一致的树；已存在的同名文件
会被覆盖（不清理额外残留，需要干净目录请自行先删除 --root）。

用法
----
    python tools/gen-test-tree.py                          # 10000 文件 -> G:/worktrees/zcode/test-tree-10k
    python tools/gen-test-tree.py --count 300 --root tmp-tree
    python tools/gen-test-tree.py --count 10000 --root G:/worktrees/zcode/test-tree-10k

输出
----
结束时打印统计：目录数、可见文件数（按扩展名）、排除目录文件数、隐藏文件数、
实际目录深度范围与总字节数。可见文件数恒等于 --count。
"""

from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

SEED = 20260904

# 与产品"默认排除目录"约定同步维护（阶段 1 过滤逻辑的测试夹具）
EXCLUDED_DIR_NAMES = ("node_modules", "target", ".venv", "dist", "build", ".cache")
# 每个排除目录夹带的文件数下限/上限（按任务规格 50–100，种子内随机取值）
EXCLUDED_DIR_MIN, EXCLUDED_DIR_MAX = 50, 100
# 嵌套排除目录实例（放在深层可见目录里）各夹带的文件数
NESTED_EXCLUDED_FILES = 5
NESTED_EXCLUDED_PARENT_DEPTH = 4  # 挂在深度 >= 4 的目录下

VISIBLE_EXTS = (".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini", ".csv")
# 扩展名分布权重：.md 占大头（全文搜索测试主体），其余均摊
EXT_WEIGHTS = (34, 5, 12, 10, 7, 6, 6, 5, 15)

HIDDEN_FILE_NAMES = (
    ".gitignore",
    ".env",
    ".editorconfig",
    ".npmrc",
    ".DS_Store",
    ".keep",
    ".hidden-note.md",
    ".secret-config.yaml",
)

MAX_DEPTH = 6
MIN_DEPTH = 2

WORDS = (
    "glance", "workspace", "notebook", "outline", "preview", "editor", "search",
    "index", "render", "theme", "branch", "harbor", "signal", "lantern", "quartz",
    "meadow", "copper", "beacon", "willow", "cobalt", "ember", "fjord", "grove",
    "summit", "ripple", "vector", "zenith", "aurora", "basalt", "cirrus",
)

CODE_LANGS = ("python", "javascript", "rust")


def build_directory_plan(rng: random.Random, file_count: int) -> list[Path]:
    """返回相对 root 的目录计划（Path 列表，含 root 级空串目录本身不列入）。"""
    plan: list[Path] = []

    # 1) 强制链：保证深度 2..6 一定出现（branch-2 .. branch-6）
    for depth in range(MIN_DEPTH, MAX_DEPTH + 1):
        parts = [f"branch-{depth}"] + [f"level-{i}" for i in range(2, depth + 1)]
        for i in range(len(parts)):
            plan.append(Path(*parts[: i + 1]))

    # 2) 随机增补目录（受最大深度约束），数量随文件规模伸缩
    extra_target = max(0, min(file_count // 25, 40))
    guard = 0
    added = 0
    while added < extra_target and guard < extra_target * 50:
        guard += 1
        parent = rng.choice(plan)
        if len(parent.parts) >= MAX_DEPTH:
            continue
        word = rng.choice(WORDS)
        name = f"{word}-{len(plan):03d}"
        candidate = parent / name
        if candidate in plan:
            continue
        plan.append(candidate)
        added += 1

    # 去重保序（强制链 + 随机名不会重复，稳妥起见仍去重）
    seen: set[Path] = set()
    unique: list[Path] = []
    for d in plan:
        if d not in seen:
            seen.add(d)
            unique.append(d)
    return unique


def md_content(stem: str, index: int, rng: random.Random) -> str:
    """生成含标题、段落、代码块与唯一搜索锚点的 Markdown。"""
    para_a = " ".join(rng.choice(WORDS) for _ in range(18))
    para_b = " ".join(rng.choice(WORDS) for _ in range(14))
    lang = rng.choice(CODE_LANGS)
    if lang == "python":
        code = f"def sample_{index}():\n    return {index} * 2  # needle marker\n"
    elif lang == "javascript":
        code = f"function sample{index}() {{\n  return {index} * 2; // needle marker\n}}\n"
    else:
        code = f"fn sample_{index}() -> i32 {{\n    {index} * 2 // needle marker\n}}\n"
    return (
        f"# {stem}\n\n"
        f"由 tools/gen-test-tree.py 生成的测试文档（编号 {index}，seed={SEED}）。\n\n"
        f"搜索锚点：`needle-{index:05d}`（全文搜索测试断言用，全文唯一）。\n\n"
        f"{para_a}。\n\n"
        f"## 小节 {index % 7 + 1}\n\n"
        f"{para_b}。\n\n"
        f"```{lang}\n{code}```\n"
    )


def plain_content(stem: str, index: int, rng: random.Random) -> str:
    """非 .md 文件的占位内容（json/yaml 等只求可读，不追求语法严格）。"""
    words = " ".join(rng.choice(WORDS) for _ in range(10))
    return f"{stem} — generated fixture #{index}\n{words}\nneedle-{index:05d}\n" * 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="生成确定性 N 文件测试目录树")
    parser.add_argument("--count", type=int, default=10000,
                        help="默认可见的普通文件总数（默认 10000）")
    parser.add_argument("--root", type=Path, default=Path("G:/worktrees/zcode/test-tree-10k"),
                        help="输出目录（默认 G:/worktrees/zcode/test-tree-10k）")
    parser.add_argument("--seed", type=int, default=SEED, help="随机种子（默认固定，保证确定性）")
    args = parser.parse_args(argv)

    if args.count < MIN_DEPTH * 5:
        parser.error(f"--count 至少需要 {MIN_DEPTH * 5}（强制链目录数下限）")
    if args.root.exists() and any(args.root.iterdir()):
        print(f"[warn] 目标目录非空，将覆盖同名文件：{args.root}", file=sys.stderr)

    rng = random.Random(args.seed)
    root: Path = args.root
    root.mkdir(parents=True, exist_ok=True)

    dirs = build_directory_plan(rng, args.count)
    abs_dirs = [root / d for d in dirs]
    for d in abs_dirs:
        d.mkdir(parents=True, exist_ok=True)

    # ── 可见文件：精确 args.count 个 ──
    ext_counts = {ext: 0 for ext in VISIBLE_EXTS}
    md_count = 0
    total_bytes = 0
    for i in range(1, args.count + 1):
        ext = rng.choices(VISIBLE_EXTS, weights=EXT_WEIGHTS, k=1)[0]
        ext_counts[ext] += 1
        target = rng.choice(abs_dirs)
        stem = f"{rng.choice(WORDS)}-{i:05d}"
        file_path = target / f"{stem}{ext}"
        if ext in (".md", ".markdown"):
            content = md_content(stem, i, rng)
            md_count += 1
        else:
            content = plain_content(stem, i, rng)
        data = content.encode("utf-8")
        file_path.write_bytes(data)
        total_bytes += len(data)

    # ── 排除目录夹具：根级各一份（50–100 文件）+ 深层嵌套实例 ──
    excluded_file_total = 0
    junk_exts = (".js", ".json", ".map", ".lock", ".py", ".meta")
    for name in EXCLUDED_DIR_NAMES:
        count_in_dir = rng.randint(EXCLUDED_DIR_MIN, EXCLUDED_DIR_MAX)
        ex_dir = root / name
        ex_dir.mkdir(exist_ok=True)
        for j in range(count_in_dir):
            f = ex_dir / f"artifact-{j:03d}{rng.choice(junk_exts)}"
            data = f"# excluded fixture {name}/{j}\n".encode("utf-8")
            f.write_bytes(data)
            total_bytes += len(data)
            excluded_file_total += 1

    deep_dirs = [d for d in abs_dirs if len(d.relative_to(root).parts) >= NESTED_EXCLUDED_PARENT_DEPTH]
    nested_total = 0
    for name in EXCLUDED_DIR_NAMES:
        if not deep_dirs:
            break
        host = rng.choice(deep_dirs)
        ex_dir = host / name
        ex_dir.mkdir(exist_ok=True)
        for j in range(NESTED_EXCLUDED_FILES):
            f = ex_dir / f"nested-{j:02d}{rng.choice(junk_exts)}"
            data = f"# nested excluded fixture {name}/{j}\n".encode("utf-8")
            f.write_bytes(data)
            total_bytes += len(data)
            nested_total += 1
        excluded_file_total += NESTED_EXCLUDED_FILES

    # ── 隐藏文件：撒在随机目录 ──
    hidden_total = 0
    for name in HIDDEN_FILE_NAMES:
        target = rng.choice(abs_dirs)
        f = target / name
        f.write_text(f"# hidden fixture: {name}\n", encoding="utf-8")
        total_bytes += len(name) + 32
        hidden_total += 1

    depths = sorted({len(d.parts) for d in dirs})
    print("gen-test-tree 统计")
    print(f"  root           : {root}")
    print(f"  seed           : {args.seed}")
    print(f"  目录数         : {len(dirs)}")
    print(f"  目录深度分布   : {depths} 层（要求 2..{MAX_DEPTH} 全覆盖；1 层为 branch 根）")
    print(f"  可见文件       : {sum(ext_counts.values())}（应等于 --count {args.count}）")
    for ext, n in ext_counts.items():
        print(f"    {ext:<10}: {n}")
    print(f"  其中 .md/.markdown（含标题+段落+代码块+needle 锚点）: {md_count}")
    print(f"  排除目录文件   : {excluded_file_total}（根级 6 目录各 50–100 + 深层嵌套 {nested_total}）")
    print(f"  隐藏文件       : {hidden_total}")
    print(f"  总字节         : {total_bytes}")

    if sum(ext_counts.values()) != args.count:
        print("[error] 可见文件数与 --count 不一致", file=sys.stderr)
        return 1
    missing = [d for d in range(MIN_DEPTH, MAX_DEPTH + 1) if d not in depths]
    if missing:
        print(f"[error] 目录深度未覆盖 2..6，缺失：{missing}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
