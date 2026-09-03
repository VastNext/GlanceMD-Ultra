# 跨平台打包实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标：** 在不破坏 Windows 现有行为的前提下，让 GlanceMD 能由 GitHub Actions 构建并打包 Windows、macOS 和 Linux 发行产物。

**架构：** 保留共享的 Wry/Tao/IPC/前端业务层，通过 Cargo target-specific dependencies 和少量 `cfg` 平台函数隔离 WebView 创建、窗口 resize、stdin 与单实例差异。打包使用 Cargo Packager；每个平台在原生 GitHub runner 上编译，macOS/Linux 以 CI 编译和打包成功为首期验收，不承诺未经实机验证的交互细节。

**技术栈：** Rust 2021、Wry 0.49、Tao 0.33、Rfd 0.15、Cargo Packager、GitHub Actions。

---

### 任务 1：解除 Cargo 与构建脚本的 Windows 耦合

**文件：**

- 修改：`Cargo.toml`
- 修改：`build.rs`

**步骤：**

1. 将 `webview2-com`、`windows` 移入 Windows target dependencies。
2. 将 `winresource` 移入 Windows target build-dependencies。
3. 让 `build.rs` 只在 `CARGO_CFG_TARGET_OS=windows` 时编译 `.ico`。
4. 运行 Windows `cargo check`，预期成功。
5. 提交：`build: isolate Windows-only dependencies`。

### 任务 2：建立平台化运行边界

**文件：**

- 创建：`src/platform.rs`
- 修改：`src/main.rs`
- 修改：`src/single_instance.rs` 或拆分平台子模块
- 修改：`src/state.rs`

**步骤：**

1. 用条件编译隔离 Windows subsystem、Win32 imports、WebView2 resize 与 stdin pipe 检测。
2. Windows 保留现有 WebView2 resize 修复和 named pipe 单实例。
3. macOS/Linux 首期以不启用应用级单实例为降级策略；macOS 由系统 app 生命周期处理 Finder 打开事件。
4. Linux 使用 Tao GTK container 与 Wry Unix extension 构建 WebView；macOS 使用普通 `build`。
5. 自定义协议初始 URL 按 Windows 与 Unix 分流。
6. macOS 接收 `Event::Opened`，在前端未 ready 时缓存路径。
7. 运行格式化与 Windows `cargo check/test`。
8. 提交：`feat: add cross-platform runtime boundaries`。

### 任务 3：适配跨平台快捷键和窗口外观

**文件：**

- 修改：`src/frontend/app.js`
- 修改：`src/frontend/index.html`
- 修改：`src/frontend/style.css`
- 修改：`src/main.rs`

**步骤：**

1. 主快捷键同时接受 Ctrl 与 Meta。
2. 由 Rust 注入平台 class/变量，macOS 使用 Command 提示。
3. Windows 保持无边框自绘窗口；macOS/Linux 使用系统 decorations，并隐藏网页窗口控制按钮。
4. 保持 Windows 现有按钮、拖动区和行为不变。
5. 用静态脚本检查快捷键分支和 DOM 元素。
6. 提交：`feat: adapt shortcuts and window chrome by platform`。

### 任务 4：配置三平台软件包

**文件：**

- 修改：`Cargo.toml` 的 `[package.metadata.packager]`
- 创建：`assets/icon.icns`（由现有 PNG 生成，若 CI 生成则提交源配置）
- 创建或补充：Linux desktop/icon 资源（由 packager 配置生成）
- 修改：`README.md`
- 修改：`README.en.md`

**步骤：**

1. 配置 product name、identifier、category、icons 和 `.md/.markdown/.txt` 文件关联。
2. macOS 输出 `.app/.dmg`，Linux 输出 `.deb/.AppImage`。
3. README 明确平台产物和 Linux WebKitGTK 运行时现实。
4. 校验 TOML 可解析、路径存在。
5. 提交：`build: configure macOS and Linux packages`。

### 任务 5：建立 GitHub Actions 多平台发布

**文件：**

- 创建：`.github/workflows/build.yml`
- 创建或修改：`.github/workflows/release.yml`

**步骤：**

1. PR/push 矩阵在 Windows、macOS arm64/Intel、Ubuntu x64 运行 check/build。
2. Linux runner 安装 `libgtk-3-dev` 与 `libwebkit2gtk-4.1-dev`。
3. tag 发布分别生成 EXE、macOS 架构包/Universal 2 DMG、deb/AppImage。
4. 未配置 Apple 证书时输出未签名 preview；配置 secrets 后启用签名与公证，不让缺少凭据阻塞普通 CI。
5. 上传平台产物并保留明确架构名。
6. 用 YAML 解析和 action 配置审查验证。
7. 提交：`ci: build and package all desktop platforms`。

### 任务 6：验证、审查与发布分支

**文件：**

- 检查全部本次变更

**步骤：**

1. 运行 `cargo fmt --check`、`cargo test`、`cargo build --release`（Windows）。
2. 运行配置文件解析、资源路径和 Git diff 检查。
3. 推送功能分支，观察 GitHub Actions；修复 CI 暴露的 macOS/Linux 编译和打包错误，直至所有预期 jobs 通过。
4. 运行代码审查，修复高置信正确性、可维护性和测试问题。
5. 再次运行 Windows 验证和 GitHub Actions。
6. 提交最终修复并推送 `feat/cross-platform-packaging`。
