#!/usr/bin/env python3
"""Linux DEB 包安全修补工具：为生成的 DEB 包添加 /usr/bin/gmdu 相对软链接。

流程说明：
1. 查找 dist/*.deb。
2. 使用 `dpkg-deb -R` 解包到临时目录（原包保持不动直到构建成功）。
3. 检查 `usr/bin/GlanceMD-Ultra` 存在且 `usr/bin/gmdu` 尚不存在。
4. 在 `usr/bin/` 目录下创建指向 `GlanceMD-Ultra` 的相对软链接 `gmdu`（不复制任何二进制）。
5. 使用 `dpkg-deb --build --root-owner-group` 构建替代新包。
6. 原子替换原 .deb 包。
"""

from __future__ import annotations

import argparse
import glob
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def patch_deb(deb_path: Path) -> Path:
    print(f"==> 开始修补 DEB 软链接：{deb_path}")
    if not deb_path.exists():
        raise FileNotFoundError(f"DEB 文件不存在：{deb_path}")

    with tempfile.TemporaryDirectory(prefix="deb_patch_", dir=deb_path.parent) as temp_dir:
        temp_path = Path(temp_dir)
        extract_dir = temp_path / "extracted"
        extract_dir.mkdir(parents=True, exist_ok=True)

        # 1. 解包 DEB
        print(f"  [1/4] 解包 {deb_path.name} 到临时目录 ...")
        proc = subprocess.run(
            ["dpkg-deb", "-R", str(deb_path), str(extract_dir)],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"dpkg-deb -R 失败 ({proc.returncode}):\n{proc.stdout + proc.stderr}")

        # 2. 验证目标可执行文件
        usr_bin = extract_dir / "usr" / "bin"
        if not usr_bin.exists():
            raise FileNotFoundError(f"DEB 解包结构中未找到 usr/bin 目录：{usr_bin}")

        target_binary = usr_bin / "GlanceMD-Ultra"
        if not target_binary.is_file() or target_binary.is_symlink():
            raise FileNotFoundError("DEB 中缺少预期的 usr/bin/GlanceMD-Ultra 二进制")

        gmdu_link = usr_bin / "gmdu"
        if gmdu_link.exists() or gmdu_link.is_symlink():
            raise FileExistsError(f"usr/bin/gmdu 已存在，无需重复创建：{gmdu_link}")

        # 3. 创建相对软链接 gmdu -> GlanceMD-Ultra
        print(f"  [2/4] 创建相对软链接 usr/bin/gmdu -> {target_binary.name} ...")
        target_name = target_binary.name
        os.symlink(target_name, gmdu_link)

        # 4. 重新构建 DEB
        print(f"  [3/4] 构建新 DEB 包并保留 root 所有权 ...")
        temp_out_deb = temp_path / deb_path.name
        proc_build = subprocess.run(
            ["dpkg-deb", "--build", "--root-owner-group", str(extract_dir), str(temp_out_deb)],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )
        if proc_build.returncode != 0:
            raise RuntimeError(
                f"dpkg-deb --build 失败 ({proc_build.returncode}):\n{proc_build.stdout + proc_build.stderr}"
            )

        # 5. 原子替换原文件
        print(f"  [4/4] 原子替换原 DEB 文件：{deb_path} ...")
        os.replace(temp_out_deb, deb_path)

    print(f"==> DEB 软链接修补完成：{deb_path}\n")
    return deb_path


def main() -> int:
    parser = argparse.ArgumentParser(description="为 DEB 增加 /usr/bin/gmdu 相对软链接")
    parser.add_argument("deb_pattern", nargs="?", default="dist/*.deb", help="DEB 文件路径或 glob 模式")

    args = parser.parse_args()
    matches = glob.glob(args.deb_pattern)
    if not matches:
        # 如果当前在仓库根目录，尝试搜索 dist/*.deb
        dist_matches = glob.glob(str(REPO_ROOT / "dist" / "*.deb"))
        if dist_matches:
            matches = dist_matches
        else:
            print(f"[error] 未找到匹配的 DEB 包：{args.deb_pattern}", file=sys.stderr)
            return 1

    for match in matches:
        patch_deb(Path(match).resolve())

    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
