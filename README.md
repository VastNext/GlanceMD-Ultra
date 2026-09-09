# 🚀 GlanceMD Ultra

<p align="center">
  <b>简体中文</b> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/VastNext/GlanceMD-Ultra/releases/latest"><img src="https://img.shields.io/github/v/release/VastNext/GlanceMD-Ultra?style=flat-square&logo=github&color=a855f7" alt="release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-ec4899?style=flat-square" alt="license"></a>
  <a href="https://github.com/VastNext/GlanceMD-Ultra/stargazers"><img src="https://img.shields.io/github/stars/VastNext/GlanceMD-Ultra?style=flat-square&color=f59e0b" alt="stars"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D6?style=flat-square" alt="platform">
  <img src="https://img.shields.io/badge/built%20with-Rust-DEA584?style=flat-square&logo=rust" alt="rust">
  <img src="https://img.shields.io/github/last-commit/VastNext/GlanceMD-Ultra?style=flat-square&color=8b5cf6" alt="last commit">
</p>

一款面向本地 Markdown 与结构化文本项目的**轻量原生工作区编辑器**：项目树、文件监听与冲突保护、全文搜索、设置与快捷键体系。基于 [GlanceMD](https://github.com/VastNext/GlanceMD) v1.6.3 快照独立演进，保持原生轻量——二进制 2–8 MB，无 Electron/Monaco、无外部运行时依赖。

使用 Rust + 系统 WebView 构建，不含 Electron。Windows 使用 WebView2，macOS 使用系统 WebKit，Linux 使用 WebKitGTK。启动速度媲美记事本，渲染效果媲美 Obsidian。

本项目的历史血脉：**[Peekdown](https://github.com/Mockitup/Peekdown)**（by Mockitup）→ **GlanceMD** → **GlanceMD Ultra**，并采用 **[Marco](https://github.com/Ranrar/Marco)** 阅读器的排版主题。详见[致谢](#-致谢)。

<p align="center">
  <img src="screenshot-preview.png" alt="GlanceMD Ultra 预览（浅色主题）" width="820">
</p>

<p align="center">
  <img src="screenshot-preview_dark.png" alt="GlanceMD Ultra 预览（深色主题）" width="820">
</p>

## 🧭 v0.1.0 当前工作区能力

v0.1.0 已包含工作区、侧栏和设置的首批可用能力，但这不是主实施计划的完成声明，后续阶段仍在实施中。

- **工作区** 🌲 — 可打开本地项目目录，扫描并懒加载项目树；支持项目内文件打开、树内新建/重命名/移动/复制/删除、撤销、在系统文件管理器中显示及在终端中打开。
- **侧栏** 🧭 — 项目树与 Outline 可同时显示；支持折叠、拖动调整宽度、持久化布局，以及将 Outline 放在左侧或右侧；支持定位当前文件和项目级搜索面板。
- **文件与恢复** 🛡️ — 已接入文件监听、外部变更提示/冲突处理、恢复相关工作区事件与基础恢复 UI；完整跨平台与异常退出门禁仍未完成。
- **设置** ⚙️ — 设置 v1 提供外观、文件、监听、搜索、编辑器、快捷键、恢复七类设置；支持全局设置、`.glancemd/settings.json` 项目覆盖、设置搜索、语言（简体中文/English）、主题、侧栏字号、Outline 位置、终端和设置 JSON 入口。
- **快捷键** ⌨️ — 当前是**基础快捷键/有限自定义**：支持已提供命令的单段快捷键录制、冲突提示、清除、恢复默认和持久化。v0.1.0 **不包含** chord、多上下文绑定（context）、多键位方案（multi-scheme）、Key Assist 或 Vim 模式。

以上能力以当前 v0.1.0 工作树为准；尚未实施的完整工作区事务、全键盘可达性、跨平台矩阵和强快捷键系统仍属于计划内容。

## 🧭 后续工作区计划

- **文件监听与冲突保护** 🛡️ — 完整外部修改矩阵、原子保存与崩溃恢复
- **全文搜索** 🔍 — 完整项目级搜索与性能门禁
- **设置与快捷键** ⚙️ — 完整命令注册、上下文、chord、键位方案与键盘辅助

## ✅ 功能特性（单文件编辑器基线）

- **极速启动** ⚡ — 原生窗口，无框架开销
- **实时预览** 👀 — 完整 GFM 支持（表格、任务列表、脚注）
- **Marco 排版** 🎨 — 标题居左对齐，带紫→粉渐变配色（`#a855f7 → #ec4899`），内容与表格铺满全宽
- **分屏模式** ↔️ — 编辑器与预览并排，实时同步（Ctrl+\）
- **语法高亮** 🌈 — 30+ 种语言（highlight.js）
- **多标签页** 📑 — 打开多个文件，单文件时自动隐藏标签栏
- **深色/浅色主题** 🌙/☀️ — 一键切换
- **文档内查找** 🔍 — Ctrl+F，高亮匹配并支持导航
- **目录侧栏** 🧭 — 自动生成大纲（Ctrl+Shift+O）
- **缩放** 🔎 — Ctrl+/- 或 Ctrl+滚轮，带缩放指示
- **拖放打开** 📥 — 拖入 `.md` 文件即打开，可多选
- **可调预览宽度** 📐 — 拖动边缘调整
- **最近文件** 🕘 — 空标签页快速打开面板
- **跨模式选区保持** 🔄 — 切换编辑/预览时选中文本不丢失
- **文件关联** 📄 — 通过"打开方式"设为默认 `.md` 查看器
- **单文件可执行** 💾 — 所有资源内嵌，无需安装

## ⌨️ 基础键盘快捷键（v0.1.0）

以下是当前已提供的基础快捷键。快捷键自定义目前是有限的单段录制能力；v0.1.0 不含 chord、context、多键位方案、Key Assist 或 Vim。

| 快捷键 | 功能 |
|---|---|
| Ctrl+O | 打开文件 |
| Ctrl+S | 保存 |
| Ctrl+Shift+S | 另存为 |
| Ctrl+N | 新建标签页 |
| Ctrl+W | 关闭标签页 |
| Ctrl+Tab | 下一个标签页 |
| Ctrl+Shift+Tab | 上一个标签页 |
| Ctrl+E | 切换编辑/预览 |
| Ctrl+\ | 切换分屏视图 |
| Ctrl+F | 文档内查找 |
| Ctrl+Shift+O | 切换大纲侧栏 |
| Ctrl+= / Ctrl+- | 放大 / 缩小 |
| Ctrl+0 | 重置缩放 |

## 🛠️ 构建

需要 Rust，以及目标系统对应的 WebView 开发环境。Windows 10/11 已预装 WebView2；Linux 构建还需要 GTK3 与 WebKitGTK 4.1 开发包。

```bash
cargo build --release
```

Windows 输出：`target/release/GlanceMD-Ultra.exe`。macOS 与 Linux 正式产物由 GitHub Actions 在对应系统的原生 Runner 上构建。

### 🚦 GitHub Actions 发布

推送 `v*` 标签即自动构建并发布 Release：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

发布产物：

- Windows x64：`GlanceMD-Ultra-windows-x64.exe`
- macOS：Apple Silicon 与 Intel 的未签名 `.dmg`
- Linux x64：`.deb` 与 `.AppImage`

> macOS 包尚未接入 Developer ID 签名与 Apple 公证，首次运行可能需要在“系统设置 → 隐私与安全性”中手动允许。

## ⌨️ 命令行打开工作区（gmdu）

在终端中用 `gmdu .` 以当前目录打开工作区（类似 `code .`）。`gmdu` 是唯一的官方短命令，安装方式二选一：

- **设置页**：打开 设置 → 窗口与命令行，点击【安装 gmdu 命令】。
- **命令行**：直接执行程序并带 `--install-cli` 参数，例如 `GlanceMD-Ultra --install-cli`。

安装后**必须开新终端**再执行：

```bash
gmdu .
```

其他参数：`--uninstall-cli`（移除 `gmdu` 入口）、`--cli-status`（查询安装状态）、`--version`（打印版本）。

> 平台说明：Windows 在程序同目录的 `bin/` 生成 `gmdu.cmd` 并把该目录加入用户级 PATH；macOS / Linux 在 `~/.local/bin` 生成 `gmdu` 软链接（需 `~/.local/bin` 已在 PATH）。这些只是入口 shim，不复制程序本体，体积不变。

## ⚙️ 技术栈

- **Rust** — 窗口管理、文件读写、进程通信（[tao](https://github.com/niceshell/niceshell) + [wry](https://github.com/niceshell/niceshell)）
- **系统 WebView** — Windows 使用 WebView2，macOS 使用 WebKit，Linux 使用 WebKitGTK
- **marked.js** — Markdown 转 HTML
- **highlight.js** — 代码语法高亮
- **不含 Electron、不含 Node、不含打包器** — 全部前端资源通过 `include_str!` 在编译期嵌入

## 🙏 致谢

本项目基于以下开源项目构建，并从中汲取了大量养分：

- **[Peekdown](https://github.com/Mockitup/Peekdown)**（by Mockitup）— 历史血脉的起点。窗口管理、文件 I/O、多标签架构与整体产品形态均源自它
- **[GlanceMD](https://github.com/VastNext/GlanceMD)**（单文件轻量版）— 本项目基于其 v1.6.3 快照独立演进；两仓库保持独立发展，共同拥有的编辑内核缺陷修复双向同步
- **[Marco](https://github.com/Ranrar/Marco)** / [marco-core](https://github.com/Ranrar/marco-core)（by Kim Skov Rasmussen，MIT）— 预览排版主题来自 Marco 的 Astro/Space 主题：渐变标题、铺满全屏、表格斑马纹等

感谢各位作者的开源精神！🚀

## 📄 许可证

MIT（见 [LICENSE](LICENSE)）
