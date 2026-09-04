# AGENTS.md — GlanceMD Ultra 开发指南

本文件面向所有在本仓库工作的 AI 编码代理与人类开发者，说明项目背景、规划文档、开发流程、验证要求，以及**何时可以合并 main、何时可以打 tag、如何发版**。本文件是本仓库唯一的代理工作区指令来源（`CLAUDE.md` 已废弃删除）。

## 项目背景

**GlanceMD Ultra** 是面向本地 Markdown 与结构化文本项目的轻量原生工作区编辑器：项目树、文件监听与冲突保护、全文搜索、设置与快捷键体系，同时保持"记事本般的启动速度"与原生轻量——二进制 2–5 MB 以内，不采用 Electron/Monaco，无外部运行时依赖。

- 代码基线取自 `VastNext/GlanceMD` v1.6.3 快照，清除旧提交历史后在本仓库独立演进（决策见 `docs/adr/0001-glancemd-ultra-独立仓库.md`）
- `origin`（`VastNext/GlanceMD-Ultra`）是本产品唯一的开发与发布仓库
- `VastNext/GlanceMD`（单文件轻量版）是**兄弟仓库**，继续保持独立演进：**不要**向它推送、不要从它拉取合并、不要给它提 PR
- 两仓库共同拥有的编辑内核（tabs/editor/preview/theme/保存/平台窗口）缺陷修复需手动双向 cherry-pick，提交信息加 `[sync]` 前缀便于跨仓库检索；同一文件双修 ≥3 次/月时，启动共享内核提取为独立 crate 的评估（另行 ADR）
- 历史血脉：Peekdown（`Mockitup/Peekdown`）→ GlanceMD → GlanceMD Ultra，仅作溯源，无任何上游同步关系

## 规划文档（开发前必读）

| 文档 | 作用 |
|---|---|
| `docs/plans/2026-09-04-glancemd-ultra-workspace-implementation-plan.md` | **主实施计划**：阶段 0–7 交付内容、验收门禁、回归策略、里程碑与风险表 |
| `docs/adr/0001-glancemd-ultra-独立仓库.md` | 独立仓库决策及其影响 |
| `reports/2026-08-29-目录项目管理功能影响评估-096d/` | 产品调研与决策依据（含不可重开决策清单、产品架构方案） |
| `docs/archive/` | 历史计划档案（如前身时期的 PLAN.md，已失效） |

实施计划 §0.2 固化的产品决策**不可重新打开**（仅当维护者明确改变产品决策时才可重开）；阶段推进、验收标准与回归要求一律以主实施计划为准。

## 技术栈与架构速览（v1.6.3 基线现状）

- Rust 后端：窗口管理、文件 I/O、拖放（`src/main.rs`、`src/ipc.rs`、`src/file_ops.rs`、`src/window_state.rs`）
- 前端全部内嵌于二进制（`include_str!` + 占位符替换拼接为单 HTML）：`src/frontend/` 下的 `index.html`、`style.css`、`app.js`、`tabs.js`、`editor.js`、`preview.js` 及第三方库
- IPC：JS → Rust 走 `window.ipc.postMessage(JSON)`；Rust → JS 走 `webview.evaluate_script()`
- JS 拥有全部 tab 状态（IIFE 模块化，如 TabManager）；Rust 是无状态文件 I/O 服务
- 脚本加载顺序：highlight.js → marked.js → preview.js → tabs.js → editor.js → app.js
- 渲染引擎：Windows 用 WebView2，macOS 用 WKWebView，Linux 用 WebKitGTK（`wry` 自动适配）
- 主题：CSS 自定义属性 + `[data-theme="light"]` 覆盖，持久化到 localStorage

以上是基线现状。Workspace 子系统（`src/workspace/`、`src/platform/` 与前端新模块）的目标架构、事件模型与候选依赖见主实施计划 §1，随阶段 0–6 逐步落地；落地过程中本节会同步更新。

## 构建与本地验证

```bash
cargo build --release        # 产物 target/release/GlanceMD.exe（阶段 0 身份重命名后为 GlanceMD-Ultra.exe）
cargo test                   # 运行测试
cargo fmt --check            # CI 会检查格式（Windows target 上执行）
```

**本地构建注意事项**：

- Windows 本机默认使用 GNU Rust 工具链时，需让 PATH 包含 mingw-w64 的 `dlltool`/`windres`（当前开发机使用 `D:/Software/w64devkit/w64devkit/bin`）。`webview2-com-sys` 在 GNU 目标下动态加载 `WebView2Loader.dll`，`build.rs` 会自动把 `assets/windows/WebView2Loader.dll` 复制到 `target/<profile>/`；本地运行/分发 GNU 产物时必须让该 DLL 与 exe 同目录。GitHub Actions 的 Windows 发布构建使用 MSVC，loader 静态链接，正式 Release 仍为单 exe
- 前端（`src/frontend/`）改动不影响 Rust 编译正确性；验证前端行为的方式是**组装测试页在浏览器中实测**：以与 `main.rs::build_html` 相同的占位符替换方式拼接 `index.html + style.css + 各 js`，注入 `window.ipc` 等 mock，用 Playwright/浏览器工具验证交互逻辑并截图确认视觉效果
- **回归以 Playwright 冒烟套件为准**（阶段 0 建立，策略见主实施计划 §2"回归自动化策略"）：套件随阶段累积，每次改动先跑套件；人工验证仅保留系统交互与视觉项
- 涉及 UI 的改动必须提供明暗两个主题下的截图验证

## 开发工作流

1. **分支**：从最新 `main` 切出特性分支，命名遵循 `feat/<主题>`、`fix/<主题>`、`chore/<主题>`
2. **提交**：遵循 Conventional Commits（`feat:`、`fix:`、`chore:` 等），提交信息用简体中文描述用户可感知的变化；两仓库共有内核的修复加 `[sync]` 前缀
3. **验证**：每个功能改动在提交前完成对应验证（见上节），并在提交信息中体现行为细节
4. **推送**：推送到 `origin` 的同名分支；UI 改动附明暗双主题截图

### 代码约定

- 控制体积：`opt-level = "s"`、`lto = "fat"`、`panic = "abort"`、`strip = "none"`（**永不 strip 符号**——崩溃诊断需要）
- 无外部运行时依赖，一切内嵌进 .exe；不引入前端构建链与 npm 依赖（测试基建同样保持零依赖原则）
- JS 使用 IIFE 模式做模块化
- 修改遵循最小化原则：只动必须动的，匹配既有风格

## 何时可以合并 main

满足**全部**以下条件才允许把分支合入 `main`：

1. 功能完整，无半成品逻辑（不留 TODO 死路）
2. 本地验证通过：`cargo test`、`cargo fmt --check` 通过；Playwright 冒烟套件全绿（自阶段 0 建立后）；前端改动已在浏览器中完成行为验证与双主题视觉验证
3. **CI Build workflow（四平台：Windows x64 / macOS arm64 / macOS x64 / Linux x64）全绿**——它包含格式检查、测试、构建、打包验证
4. 不引入新的运行时依赖，不破坏既有功能（改动前先跑回归冒烟套件）

合并方式：

- 优先快进合并：`git push origin HEAD:main`（分支从 main 最新提交切出时）
- 若 main 已前进，先 rebase 或合并 main 解决冲突后再推送
- 合并后确认 main 上的 Build workflow 通过

## 何时可以打 tag / 发版

**打 tag 即发布**：push `v*` 格式的 tag 会触发 `release.yml`，自动完成三平台构建并创建 GitHub Release 上传产物。因此：

### 版本序列

Ultra 采用独立 semver 序列：主实施计划阶段 0–6 期间为 `0.x.0` 内部版本（tag 触发 Release 供内部验证），首个对外稳定版为 `v1.0.0`（阶段 7）。

### 时机

- 一批功能/修复已完成、已合并（或随 tag 同批合并）到 `main`，且质量验证齐全时，打 tag 发布
- 不要为未合并到 main 的孤立提交打 tag；不要用 tag 修复发错的代码（发版前先在分支上验证充分）
- 纯文档改动（如本文件）**不需要**打 tag 发版

### 版本号（语义化版本）

- 修复、微小调整 → patch；新功能、显著交互改进 → minor；破坏性变更 → major
- tag 必须严格为 `v{X.Y.Z}`（可带 `-预发布后缀`），**且与 `Cargo.toml` 的 `package.version` 完全一致**——`release.yml` 的 prepare job 会校验，不一致直接失败；workflow_dispatch 手动触发时同样校验

### 发版流程（完整清单）

1. 更新 `Cargo.toml` 的 `package.version` 到目标版本号，提交（`chore(release): 准备 v{X.Y.Z}`）
2. 将包含该提交的分支合并到 `main`（快进推送或合并），确认 main 的 Build workflow 绿色
3. 打 tag 并推送：
   ```bash
   git tag v{X.Y.Z}
   git push origin v{X.Y.Z}
   ```
4. 等待 Release workflow 完成（prepare → windows / macos×2 / linux → publish），确认 GitHub Release 创建成功、五个产物齐全（Windows exe / macOS dmg×2 / Linux deb + AppImage；产物命名随阶段 0 身份重命名更新，以 `release.yml` 为准）
5. **撰写详细的 Release Notes**（用 `gh release edit <tag> --notes-file` 更新）：
   - 中文撰写，按类型（新功能 / 改进 / 修复）分节，写清用户可感知的行为变化与设计动机
   - 跨多个版本的合并发布需汇总自上个版本的累计改动
   - 保留下载对照表与 macOS 未签名提示

### CI 一览

| Workflow | 触发 | 作用 |
|---|---|---|
| `build.yml` | 所有分支 push / PR / 手动 | 四平台格式检查 + 测试 + 构建 + 打包验证，上传 artifact（阶段 1 起并入 Playwright 冒烟套件） |
| `release.yml` | push `v*` tag / 手动 dispatch | 三平台构建打包，创建 GitHub Release 并上传产物（`contents: write`） |

## 其他注意事项

- **平台验证节奏**：开发与日常验证以 Windows 为主平台；macOS/Linux 的完整功能矩阵按主实施计划在阶段 3 与阶段 7 执行，`v1.0.0` 发布前三平台矩阵必须全绿
- macOS 产物当前未签名，Release Notes 中需保留首次运行需手动放行的提示
- localStorage 键名统一加前缀：当前为 `glancemd-`，阶段 0 身份重命名后为 `glancemd-ultra-`（见主实施计划阶段 0）
- 主题设计语言：紫→粉渐变（`--mk-heading` → `--mk-heading-end`，即 `#a855f7` → `#ec4899`）为核心高亮色系，相关衍生 token 见 `style.css`（`--heading-gradient`、`--heading-glow`、`--heading-soft`、`--selection-bg`、`--tab-active-text`）；Ultra 新增界面（项目树、欢迎页、冲突横幅、搜索面板等）延续同一设计语言，静态设计基线稿存于 `docs/design/`（阶段 0 建立）
