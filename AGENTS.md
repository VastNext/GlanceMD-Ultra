# AGENTS.md — GlanceMD 开发指南

本文件面向所有在本仓库工作的 AI 编码代理与人类开发者，说明项目背景、开发流程、验证要求，以及**何时可以合并 main、何时可以打 tag、如何发版**。

## 项目背景

GlanceMD 是一款轻量原生 Markdown 查看/编辑器：Rust (wry + tao) 后端 + 嵌入式 HTML/CSS/JS 前端 + WebView2 渲染，目标"记事本般的启动速度、Obsidian 般的界面"，单一约 800 KB 可执行文件。

**关于上游**：本项目基于开源项目 Peekdown（`Mockitup/Peekdown`）二次开发而来。经过长期独立演进，与上游的共同点已经很少，**实际上是独立项目**：

- `origin`（`VastNext/GlanceMD`）是唯一的开发与发布仓库，所有工作都在这里进行
- `upstream`（`Mockitup/Peekdown`）仅保留作历史溯源，**不要**向它推送、不要从它拉取合并、不要给它提 PR
- 不需要向上游同步任何改动

## 技术栈与架构速览

- Rust 后端：窗口管理、文件 I/O、拖放（`src/main.rs`、`src/ipc.rs`、`src/file_ops.rs`、`src/window_state.rs`）
- 前端全部内嵌于二进制（`include_str!` + 占位符替换拼接为单 HTML）：`src/frontend/` 下的 `index.html`、`style.css`、`app.js`、`tabs.js`、`editor.js`、`preview.js` 及第三方库
- IPC：JS → Rust 走 `window.ipc.postMessage(JSON)`；Rust → JS 走 `webview.evaluate_script()`
- JS 拥有全部 tab 状态（IIFE 模块化，如 TabManager）；Rust 是无状态文件 I/O 服务
- 脚本加载顺序：highlight.js → marked.js → preview.js → tabs.js → editor.js → app.js
- 主题：CSS 自定义属性 + `[data-theme="light"]` 覆盖，持久化到 localStorage（键名前缀 `glancemd-`）

更多细节参见 `CLAUDE.md`。

## 构建与本地验证

```bash
cargo build --release        # 产物 target/release/GlanceMD.exe
cargo test                   # 运行测试
cargo fmt --check            # CI 会检查格式（Windows target 上执行）
```

**本地构建注意事项**：

- Windows 本机若未安装 MSVC 资源编译器（rc.exe），`build.rs` 的 `winresource` 图标嵌入会失败（`program not found`）。这只影响本机，**GitHub Actions 的 windows-latest 有完整工具链**。此时不必死磕本地构建，直接推送后以 CI Build 结果为准
- 前端（`src/frontend/`）改动不影响 Rust 编译正确性；验证前端行为的方式是**组装测试页在浏览器中实测**：以与 `main.rs::build_html` 相同的占位符替换方式拼接 `index.html + style.css + 各 js`，注入 `window.ipc` 等 mock（参考历史做法），用 Playwright/浏览器工具验证交互逻辑并截图确认视觉效果
- 涉及 UI 的改动必须提供明暗两个主题下的截图验证

## 开发工作流

1. **分支**：从最新 `main` 切出特性分支，命名遵循 `feat/<主题>`、`fix/<主题>`、`chore/<主题>`
2. **提交**：遵循 Conventional Commits（`feat:`、`fix:`、`chore:` 等），提交信息用简体中文描述用户可感知的变化
3. **验证**：每个功能改动在提交前完成对应验证（见上节），并在提交信息中体现行为细节
4. **推送**：推送到 `origin` 的同名分支；UI 改动建议附截图说明

### 代码约定（继承自 CLAUDE.md）

- 控制体积：`opt-level = "s"`、`lto = "fat"`、`panic = "abort"`、`strip = "none"`（**永不 strip 符号**——崩溃诊断需要）
- 无外部运行时依赖，一切内嵌进 .exe
- JS 使用 IIFE 模式做模块化
- 修改遵循最小化原则：只动必须动的，匹配既有风格

## 何时可以合并 main

满足**全部**以下条件才允许把分支合入 `main`：

1. 功能完整，无半成品逻辑（不留 TODO 死路）
2. 本地验证通过：`cargo test`、`cargo fmt --check` 通过；前端改动已在浏览器中完成行为验证与双主题视觉验证
3. **CI Build workflow（四平台：Windows x64 / macOS arm64 / macOS x64 / Linux x64）全绿**——它包含格式检查、测试、构建、打包验证
4. 不引入新的运行时依赖，不破坏既有功能（改动前先做回归验证）

合并方式：

- 优先快进合并：`git push origin HEAD:main`（分支从 main 最新提交切出时）
- 若 main 已前进，先 rebase 或合并 main 解决冲突后再推送
- 合并后确认 main 上的 Build workflow 通过

## 何时可以打 tag / 发版

**打 tag 即发布**：push `v*` 格式的 tag 会触发 `release.yml`，自动完成三平台构建并创建 GitHub Release 上传产物。因此：

### 时机

- 一批功能/修复已完成、已合并（或随 tag 同批合并）到 `main`，且质量验证齐全时，打 tag 发布一个正式版本
- 不要为未合并到 main 的孤立提交打 tag；不要用 tag 修复发错的代码（发版前先在分支上验证充分）
- 纯文档改动（如本文件）**不需要**打 tag 发版

### 版本号（语义化版本）

- 修复、微小调整 → patch：`v1.6.2 → v1.6.3`
- 新功能、显著交互改进 → minor：`v1.6.2 → v1.7.0`
- 破坏性变更 → major
- tag 必须严格为 `v{X.Y.Z}`（可带 `-预发布后缀`），**且与 `Cargo.toml` 的 `package.version` 完全一致**——`release.yml` 的 prepare job 会校验，不一致直接失败

### 发版流程（完整清单）

1. 更新 `Cargo.toml` 的 `package.version` 到目标版本号，提交（`chore(release): 准备 v{X.Y.Z}`）
2. 将包含该提交的分支合并到 `main`（快进推送或合并），确认 main 的 Build workflow 绿色
3. 打 tag 并推送：
   ```bash
   git tag v{X.Y.Z}
   git push origin v{X.Y.Z}
   ```
4. 等待 Release workflow 完成（prepare → windows / macos×2 / linux → publish），确认 GitHub Release 创建成功、五个产物齐全：
   - `GlanceMD-windows-x64.exe`
   - `GlanceMD-macos-arm64-unsigned.dmg` / `GlanceMD-macos-x64-unsigned.dmg`
   - `GlanceMD_{X.Y.Z}_amd64.deb` / `GlanceMD_{X.Y.Z}_x86_64.AppImage`
5. **撰写详细的 Release Notes**（用 `gh release edit <tag> --notes-file` 更新）：
   - 中文撰写，按类型（新功能 / 改进 / 修复）分节，写清用户可感知的行为变化与设计动机
   - 跨多个版本的合并发布需汇总自上个版本的累计改动
   - 保留下载对照表与 macOS 未签名提示

### CI 一览

| Workflow | 触发 | 作用 |
|---|---|---|
| `build.yml` | 所有分支 push / PR / 手动 | 四平台格式检查 + 测试 + 构建 + 打包验证，上传 artifact |
| `release.yml` | push `v*` tag / 手动 dispatch | 三平台构建打包，创建 GitHub Release 并上传产物（`contents: write`） |

## 其他注意事项

- macOS 产物当前未签名，Release Notes 中需保留首次运行需手动放行的提示
- `release.yml` 校验 tag 与 Cargo 版本一致；workflow_dispatch 手动触发时同样校验
- localStorage 键名一律加 `glancemd-` 前缀
- 主题设计语言：紫→粉渐变（`--mk-heading` → `--mk-heading-end`，即 `#a855f7` → `#ec4899`）为核心高亮色系，相关衍生 token 见 `style.css`（`--heading-gradient`、`--heading-glow`、`--heading-soft`、`--selection-bg`、`--tab-active-text`）
