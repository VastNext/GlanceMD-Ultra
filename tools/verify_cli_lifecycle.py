#!/usr/bin/env python3
"""跨平台 CLI 生命周期与 gmdu 验收工具（用于 CI 门禁，零假通过）。

严格验证规则：
1. 版本号与 Cargo.toml 不一致直接抛出异常 FAIL，无宽松 WARN。
2. gmdu 解析必须通过 PATH 命中，严禁使用候选目录绝对路径硬编码兜底。
3. Windows 平台：
   - 复制待测试 exe 到包含空格的临时目录；
   - 真实执行 --install-cli；
   - 使用 winreg 读取真实 HKCU\\Environment\\Path 校验新增项；
   - 构造子进程 PATH 使用真实的 HKLM + HKCU 注册表展开值验证 gmdu --version；
   - finally 块中真实执行 --uninstall-cli 并精准还原原注册表 Path 原始值与类型（REG_EXPAND_SZ/REG_SZ）。
4. Unix 平台（macOS / Linux）：
   - 隔离临时 HOME，验证 --install-cli 安装到 ~/.local/bin；
   - PATH 注入 ~/.local/bin，which 确认命中，版本号严格比对；
   - 测试重复安装幂等性；
   - finally 块卸载并确认文件彻底移除。
5. macOS DMG：挂载真实 DMG，动态发现 .app，复制到临时目录验收，finally 强制 detach。
6. Linux AppImage：设置 APPIMAGE_EXTRACT_AND_RUN=1，完整走安装->gmdu->卸载流程。
"""

from __future__ import annotations

import argparse
import glob
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def require_version(output: str, expected: str) -> None:
    """只接受产品标识和完整版本行，不把其他版本的子串当作通过。"""
    if not re.search(rf"(?m)^GlanceMD-Ultra\s+v?{re.escape(expected)}\s*$", output):
        raise RuntimeError(f"版本不匹配：期望 GlanceMD-Ultra {expected}，得到 {output!r}")


def get_cargo_version() -> str:
    """从 Cargo.toml 读取 package.version，读取失败直接抛错。"""
    cargo_toml = REPO_ROOT / "Cargo.toml"
    with open(cargo_toml, "rb") as f:
        data = tomllib.load(f)
    version = data.get("package", {}).get("version")
    if not version:
        raise ValueError(f"无法在 {cargo_toml} 中解析 package.version")
    return str(version).strip()


def run_command(
    cmd: list[str],
    env: dict[str, str],
    cwd: Path | None = None,
    timeout: int = 30,
) -> subprocess.CompletedProcess[str]:
    """运行子进程并捕获输出（强制 utf-8 与 errors='replace' 避免 Windows 默认 cp1252 解码中文奔溃）。"""
    return subprocess.run(
        cmd,
        env=env,
        cwd=cwd or REPO_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def resolve_binary_path(raw_path: str) -> Path:
    """解析普通二进制或 macOS .app 内的主可执行文件。"""
    matches = glob.glob(raw_path)
    if not matches:
        raise FileNotFoundError(f"未找到指定的二进制：{raw_path}")
    path = Path(matches[0]).resolve()
    if path.suffix == ".app" or (path.is_dir() and (path / "Contents" / "MacOS").is_dir()):
        macos_dir = path / "Contents" / "MacOS"
        preferred = macos_dir / "GlanceMD-Ultra"
        if preferred.is_file():
            return preferred
        candidates = [p for p in macos_dir.iterdir() if p.is_file() and not p.name.startswith(".")]
        if len(candidates) != 1:
            raise RuntimeError(f"无法唯一确定 {path} 内的主可执行文件：{candidates}")
        return candidates[0]
    if not path.is_file():
        raise FileNotFoundError(f"目标不是可执行文件：{path}")
    return path


def test_windows_lifecycle(binary: Path, expected_version: str) -> None:
    """Windows 平台 CLI 验收：包含空格路径、注册表检查与精确还原。"""
    import winreg

    print(f"==> [Windows] 开始验证 CLI 生命周期：{binary}")

    def get_user_path_reg() -> tuple[str | None, int]:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Environment", 0, winreg.KEY_READ) as key:
                val, val_type = winreg.QueryValueEx(key, "Path")
                return val, val_type
        except FileNotFoundError:
            return None, winreg.REG_EXPAND_SZ

    def set_user_path_reg(val: str | None, val_type: int) -> None:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Environment", 0, winreg.KEY_SET_VALUE) as key:
            if val is None:
                try:
                    winreg.DeleteValue(key, "Path")
                except FileNotFoundError:
                    pass
            else:
                winreg.SetValueEx(key, "Path", 0, val_type, val)

    def get_system_path_reg() -> str:
        try:
            with winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
                0,
                winreg.KEY_READ,
            ) as key:
                val, _ = winreg.QueryValueEx(key, "Path")
                return val or ""
        except Exception:
            return ""

    def build_real_windows_env() -> dict[str, str]:
        env = dict(os.environ)
        user_path, _ = get_user_path_reg()
        sys_path = get_system_path_reg()
        parts = []
        if sys_path:
            parts.append(sys_path)
        if user_path:
            parts.append(user_path)
        combined = ";".join(parts)
        env["PATH"] = os.path.expandvars(combined)
        return env

    orig_user_path, orig_user_path_type = get_user_path_reg()
    temp_space_dir = tempfile.mkdtemp(prefix="GlanceMD Test Space ")

    try:
        # 复制到包含空格的临时目录
        test_exe = Path(temp_space_dir) / binary.name
        shutil.copy2(binary, test_exe)

        # 1. 验证 --version
        print("  [1/6] 检查 --version ...")
        proc = run_command([str(test_exe), "--version"], env=os.environ.copy())
        output = (proc.stdout + proc.stderr).strip()
        if proc.returncode != 0:
            raise RuntimeError(f"--version 退出码非 0 ({proc.returncode}):\n{output}")
        require_version(output, expected_version)
        print(f"  [OK] --version: {output}")

        # 2. 验证 --cli-status
        print("  [2/6] 检查初始 --cli-status ...")
        proc = run_command([str(test_exe), "--cli-status"], env=os.environ.copy())
        if proc.returncode != 0:
            raise RuntimeError(f"初始 --cli-status 退出码非 0 ({proc.returncode}):\n{proc.stdout + proc.stderr}")
        print(f"  [OK] --cli-status: {(proc.stdout + proc.stderr).strip()}")

        # 3. 验证 --install-cli
        print("  [3/6] 执行 --install-cli ...")
        proc = run_command([str(test_exe), "--install-cli"], env=os.environ.copy())
        if proc.returncode != 0:
            raise RuntimeError(f"--install-cli 失败 ({proc.returncode}):\n{proc.stdout + proc.stderr}")

        # 4. 验证真实 PATH 中解析 gmdu 并执行 gmdu --version
        print("  [4/6] 构造真实系统+用户注册表 PATH 校验 gmdu --version ...")
        real_env = build_real_windows_env()
        gmdu_cmd = shutil.which("gmdu", path=real_env.get("PATH", ""))
        if not gmdu_cmd:
            raise RuntimeError(
                f"未能从注册表合并的真实 PATH 中解析出 gmdu 命令！当前 PATH: {real_env.get('PATH')}"
            )
        print(f"    PATH 命中: {gmdu_cmd}")
        expected_cmd = test_exe.parent / "bin" / "gmdu.cmd"
        if Path(gmdu_cmd).resolve() != expected_cmd.resolve():
            raise RuntimeError(f"PATH 命中了其他安装：{gmdu_cmd}")

        # .cmd 必须通过真实命令解释器验收（与用户运行 `gmdu --version` 一致）；
        # Python shell=False 直接执行 .cmd 的标准流行为不稳定，可能得到空输出。
        # gmdu.cmd 内部的 PowerShell 桥接会同步捕获 GUI EXE 标准流；这里按用户
        # 实际方式直接从 PATH 运行，避免额外的 /u + 文件重定向改变桥接行为。
        proc_gmdu = run_command(
            ["cmd.exe", "/d", "/c", "gmdu", "--version"],
            env=real_env,
        )
        gmdu_out = (proc_gmdu.stdout + proc_gmdu.stderr).strip()
        if proc_gmdu.returncode != 0:
            raise RuntimeError(f"gmdu --version 失败 ({proc_gmdu.returncode}):\n{gmdu_out}")
        require_version(gmdu_out, expected_version)
        print(f"  [OK] gmdu --version: {gmdu_out}")

        # 5. 验证 --cli-status（安装后）
        print("  [5/6] 检查安装后 --cli-status ...")
        proc = run_command([str(test_exe), "--cli-status"], env=os.environ.copy())
        if proc.returncode != 0:
            raise RuntimeError(f"安装后 --cli-status 失败 ({proc.returncode}):\n{proc.stdout + proc.stderr}")
        print(f"  [OK] --cli-status: {(proc.stdout + proc.stderr).strip()}")

        # 6. 验证 --uninstall-cli 并确认文件清除
        print("  [6/6] 执行 --uninstall-cli ...")
        proc = run_command([str(test_exe), "--uninstall-cli"], env=os.environ.copy())
        if proc.returncode != 0:
            raise RuntimeError(f"--uninstall-cli 失败 ({proc.returncode}):\n{proc.stdout + proc.stderr}")

        if Path(gmdu_cmd).exists():
            raise RuntimeError(f"卸载后 gmdu 命令文件仍存在：{gmdu_cmd}")
        if get_user_path_reg() != (orig_user_path, orig_user_path_type):
            raise RuntimeError("卸载未还原用户 PATH 的原始值与类型")
        print("  [OK] --uninstall-cli 清理成功")

    finally:
        # 恢复 HKCU Environment Path
        set_user_path_reg(orig_user_path, orig_user_path_type)
        shutil.rmtree(temp_space_dir, ignore_errors=True)
        print("  [Clean] 恢复 Windows 用户注册表 Path 并清理临时目录完成")


def test_unix_lifecycle(
    binary: Path, expected_version: str, extra_env: dict[str, str] | None = None
) -> None:
    """Unix 平台（macOS / Linux / AppImage）CLI 验收。"""
    print(f"==> [Unix] 开始验证 CLI 生命周期：{binary}")
    if not os.access(binary, os.X_OK):
        try:
            binary.chmod(binary.stat().st_mode | 0o755)
        except Exception:
            pass

    temp_home = tempfile.mkdtemp(prefix="glancemd_home_")
    try:
        env = dict(os.environ)
        if extra_env:
            env.update(extra_env)
        env["HOME"] = temp_home
        local_bin = str(Path(temp_home) / ".local" / "bin")
        env["PATH"] = f"{local_bin}:{env.get('PATH', '')}"

        # 1. 验证 --version
        print("  [1/6] 检查 --version ...")
        proc = run_command([str(binary), "--version"], env=env)
        output = (proc.stdout + proc.stderr).strip()
        if proc.returncode != 0:
            raise RuntimeError(f"--version 退出码非 0 ({proc.returncode}):\n{output}")
        require_version(output, expected_version)
        print(f"  [OK] --version: {output}")

        # 2. 验证 --cli-status
        print("  [2/6] 检查初始 --cli-status ...")
        proc = run_command([str(binary), "--cli-status"], env=env)
        if proc.returncode != 0:
            raise RuntimeError(f"初始 --cli-status 退出码非 0 ({proc.returncode}):\n{proc.stdout + proc.stderr}")
        print(f"  [OK] --cli-status: {(proc.stdout + proc.stderr).strip()}")

        # 3. 验证 --install-cli 与幂等性
        print("  [3/6] 执行 --install-cli（含幂等性检查）...")
        proc = run_command([str(binary), "--install-cli"], env=env)
        if proc.returncode != 0:
            raise RuntimeError(f"--install-cli 失败 ({proc.returncode}):\n{proc.stdout + proc.stderr}")

        proc_idempotent = run_command([str(binary), "--install-cli"], env=env)
        if proc_idempotent.returncode != 0:
            raise RuntimeError(
                f"重复执行 --install-cli 失败 ({proc_idempotent.returncode}):\n{proc_idempotent.stdout + proc_idempotent.stderr}"
            )
        print("  [OK] --install-cli 完成")

        # 4. 验证 PATH 命中 gmdu 并执行 gmdu --version
        print("  [4/6] 验证 gmdu --version (PATH 命中) ...")
        gmdu_bin = shutil.which("gmdu", path=env["PATH"])
        if not gmdu_bin:
            raise RuntimeError(f"未在 PATH ({env['PATH']}) 中查找到 gmdu 命令！")
        print(f"    PATH 命中: {gmdu_bin}")
        expected_link = Path(local_bin) / "gmdu"
        if Path(gmdu_bin).absolute() != expected_link.absolute() or not expected_link.is_symlink():
            raise RuntimeError(f"PATH 未命中本次安装的符号链接：{gmdu_bin}")

        proc_gmdu = run_command([gmdu_bin, "--version"], env=env)
        gmdu_out = (proc_gmdu.stdout + proc_gmdu.stderr).strip()
        if proc_gmdu.returncode != 0:
            raise RuntimeError(f"gmdu --version 失败 ({proc_gmdu.returncode}):\n{gmdu_out}")
        require_version(gmdu_out, expected_version)
        print(f"  [OK] gmdu --version: {gmdu_out}")

        # 5. 验证 --cli-status
        print("  [5/6] 检查安装后 --cli-status ...")
        proc = run_command([str(binary), "--cli-status"], env=env)
        if proc.returncode != 0:
            raise RuntimeError(f"安装后 --cli-status 失败 ({proc.returncode}):\n{proc.stdout + proc.stderr}")
        print(f"  [OK] --cli-status: {(proc.stdout + proc.stderr).strip()}")

        # 6. 验证 --uninstall-cli
        print("  [6/6] 执行 --uninstall-cli 并验证清理 ...")
        proc = run_command([str(binary), "--uninstall-cli"], env=env)
        if proc.returncode != 0:
            raise RuntimeError(f"--uninstall-cli 失败 ({proc.returncode}):\n{proc.stdout + proc.stderr}")

        if os.path.lexists(gmdu_bin):
            raise RuntimeError(f"卸载后 gmdu 文件仍存在：{gmdu_bin}")
        print("  [OK] --uninstall-cli 清理成功")

    finally:
        shutil.rmtree(temp_home, ignore_errors=True)
        print("  [Clean] 清理临时 HOME 完成")


def test_macos_dmg(dmg_pattern: str, expected_version: str) -> None:
    """macOS 挂载 DMG、发现 .app、拷贝到临时目录并验证 CLI 生命周期。"""
    dmg_matches = glob.glob(dmg_pattern)
    if not dmg_matches:
        raise FileNotFoundError(f"未找到匹配的 DMG 文件：{dmg_pattern}")
    dmg_path = Path(dmg_matches[0]).resolve()
    print(f"==> [macOS] 开始挂载并验证 DMG: {dmg_path}")

    mount_point: str | None = None
    app_copy_dir = tempfile.mkdtemp(prefix="glancemd_app_copy_")

    try:
        # 让 hdiutil 选择合法挂载点并用 plist 读取真实路径；固定空目录
        # mountpoint 在 GitHub macOS runner 上偶发 exit 1。
        attach = None
        for attempt in range(3):
            attach = subprocess.run(
                ["hdiutil", "attach", str(dmg_path), "-nobrowse", "-readonly", "-plist"],
                capture_output=True,
            )
            if attach.returncode == 0:
                break
            time.sleep(attempt + 1)
        if not attach or attach.returncode != 0:
            stderr = (attach.stderr or b"").decode("utf-8", errors="replace") if attach else ""
            raise RuntimeError(f"hdiutil attach 失败：{stderr}")
        plist = plistlib.loads(attach.stdout)
        mount_points = [
            entity.get("mount-point")
            for entity in plist.get("system-entities", [])
            if entity.get("mount-point")
        ]
        if not mount_points:
            raise RuntimeError("hdiutil attach 未返回 mount-point")
        mount_point = mount_points[-1]

        # 动态发现 .app
        app_candidates = list(Path(mount_point).glob("*.app"))
        if not app_candidates:
            raise FileNotFoundError(f"挂载卷 {mount_point} 中未发现任何 .app 应用包")
        source_app = app_candidates[0]
        print(f"  挂载卷中发现应用包：{source_app.name}")

        dest_app = Path(app_copy_dir) / source_app.name
        shutil.copytree(source_app, dest_app, symlinks=True)

        macos_dir = dest_app / "Contents" / "MacOS"
        binaries = [p for p in macos_dir.iterdir() if p.is_file() and not p.name.startswith(".")]
        if not binaries:
            raise FileNotFoundError(f"应用包 {dest_app} 的 Contents/MacOS 下未找到可执行文件")
        app_binary = binaries[0]
        print(f"  提取到待验证二进制：{app_binary}")

        # 在独立环境中验证应用包内可执行文件的 CLI 生命周期
        test_unix_lifecycle(app_binary, expected_version)

    finally:
        if mount_point:
            for _ in range(3):
                proc = subprocess.run(
                    ["hdiutil", "detach", mount_point, "-force"],
                    capture_output=True,
                    text=True,
                )
                if proc.returncode == 0:
                    break
                time.sleep(1)
        shutil.rmtree(app_copy_dir, ignore_errors=True)
        print("  [Clean] macOS 挂载卷已卸载并清理临时目录")


def test_deb_installed(expected_version: str) -> None:
    """Linux 系统 DEB 安装后验收：验证 /usr/bin/gmdu 原生即用且版本严格一致。"""
    print("==> [Linux DEB] 开始验证已安装 DEB 的 gmdu 与可执行文件 ...")

    # 1. 验证系统 PATH 中直接解析 gmdu
    gmdu_bin = shutil.which("gmdu")
    if not gmdu_bin:
        raise RuntimeError("安装 DEB 包后未能从系统 PATH 中解析到 gmdu 命令！")
    print(f"  系统 PATH 命中 gmdu：{gmdu_bin}")

    # 2. 验证 gmdu --version
    proc_ver = run_command([gmdu_bin, "--version"], env=os.environ.copy())
    ver_out = (proc_ver.stdout + proc_ver.stderr).strip()
    if proc_ver.returncode != 0:
        raise RuntimeError(f"已安装 DEB 的 gmdu --version 失败 ({proc_ver.returncode}):\n{ver_out}")
    require_version(ver_out, expected_version)
    print(f"  [OK] gmdu --version: {ver_out}")

    # 3. 验证主程序路径并测试用户临时隔离下的生命周期
    main_bin = shutil.which("GlanceMD-Ultra") or gmdu_bin
    print(f"  主程序定位：{main_bin}")
    test_unix_lifecycle(Path(main_bin), expected_version)
    print("==> 已安装 DEB 包全局软链接与 CLI 生命周期验证通过！\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="严格跨平台 CLI 与 gmdu 验收工具（零假通过）")
    parser.add_argument("--binary", type=str, default="", help="二进制路径（支持 .exe 或 Unix 路径）")
    parser.add_argument("--dmg", type=str, default="", help="macOS DMG 路径或 glob 模式")
    parser.add_argument("--appimage", type=str, default="", help="Linux AppImage 路径或 glob 模式")
    parser.add_argument("--deb-installed", action="store_true", help="验证已通过 dpkg 安装的 DEB 包与 /usr/bin/gmdu")

    args = parser.parse_args()

    expected_version = get_cargo_version()
    print(f"基准 Cargo 版本：{expected_version}")

    if args.deb_installed:
        test_deb_installed(expected_version)
    elif args.dmg:
        test_macos_dmg(args.dmg, expected_version)
    elif args.appimage:
        appimage_matches = glob.glob(args.appimage)
        if not appimage_matches:
            raise FileNotFoundError(f"未找到匹配的 AppImage 文件：{args.appimage}")
        appimage_path = Path(appimage_matches[0]).resolve()
        # AppImage 全流程生命周期测试，开启 APPIMAGE_EXTRACT_AND_RUN=1
        test_unix_lifecycle(
            appimage_path,
            expected_version,
            extra_env={"APPIMAGE_EXTRACT_AND_RUN": "1"},
        )
    elif args.binary:
        binary_path = resolve_binary_path(args.binary)

        if sys.platform == "win32" or binary_path.suffix.lower() == ".exe":
            test_windows_lifecycle(binary_path, expected_version)
        else:
            test_unix_lifecycle(binary_path, expected_version)
    else:
        parser.error("必须指定 --binary、--dmg、--appimage 或 --deb-installed 其中之一")

    print("\n===> 所有 CLI 验收项严格通过！")
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
