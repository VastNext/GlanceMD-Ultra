# 并行开发编排方案（主 Agent + subagent 分布式 worktree）

- 日期：2026-09-04
- 编排者：主 Agent（负责任务分解、派发、合并、集成验收）
- 执行者：subagent，各自在 `G:\worktrees\zcode\<流名>` 的独立 worktree + 特性分支上开发
- 依据：`docs/plans/2026-09-04-glancemd-ultra-workspace-implementation-plan.md`（下称"主计划"）

## 1. 并行性分析

### 1.1 依赖关系

```text
阶段0 基线(main@7f2ba4c)
├── A1 身份重命名        ── 独立（字符串/配置/CI/README，与代码结构无耦合）
├── A2 workspace 基础    ── 独立（新模块 + IPC 扩展；main.rs 仅附加式修改）
├── A3 platform traits   ── 独立（纯新模块，mod 声明由主 Agent 集成时补一行）
├── A4 测试基建          ── 独立（tools/ + tests/，不碰产品源码）
└── A5 UI 设计基线       ── 独立（docs/design/ 纯静态稿）
        ↓ Wave 1 全部合并后
阶段1–6（Wave 2a Rust 模块并行 / Wave 2b 前端面板并行）
├── 依赖 A2 的：commands 注册表、workspace/mod、IPC 事件桥、interfaces.md 契约
├── Rust 模块（tree+search / watcher / operations / settings / codec+atomic+recovery）
│   仅通过 interfaces.md 契约交互 → 可并行，文件所有权互斥
└── 前端（骨架 shell 先行；面板模块按契约对接 → 与 Rust 模块并行）
```

### 1.2 冲突控制

- **文件所有权矩阵**（并行 agent 仅允许写自己名下文件，越界需求写入报告由主 Agent 集成）：
  | 文件 | A1 identity | A2 workspace | A3 platform | A4 tooling | A5 design |
  |---|---|---|---|---|---|
  | Cargo.toml | ✔ 改名/版本 | ✖（不加依赖） | ✖ | ✖ | ✖ |
  | main.rs | ✔ 仅字符串 | ✔ 仅附加式 | ✖（报告 mod 声明） | ✖ | ✖ |
  | single_instance.rs / window_state.rs | ✔ | ✖ | ✖ | ✖ | ✖ |
  | ipc.rs / src/workspace/ / src/commands.rs | ✖ | ✔ | ✖ | ✖ | ✖ |
  | src/platform/ | ✖ | ✖ | ✔ | ✖ | ✖ |
  | src/frontend/app.js | ✔ 仅前缀替换 | ✖ | ✖ | ✖ | ✖ |
  | src/frontend/{commands,workspace}.js | ✖ | ✔（新建） | ✖ | ✖ | ✖ |
  | src/frontend/*.test.js | ✖ | ✔ 新建 | ✖ | ✔ 新建 | ✖ |
  | tools/ tests/ | ✖ | ✖ | ✖ | ✔ | ✖ |
  | docs/design/ | ✖ | ✖ | ✖ | ✖ | ✔ |
  | .github/workflows/ README* | ✔ | ✖ | ✖ | ✖ | ✖ |
- **集成点收敛**：main.rs 的 `mod` 声明、Cargo.toml 新依赖（Wave 2 的 notify/trash/ignore）、build_html 列表冲突由主 Agent 在合并时解决。
- **契约先行**：A2 产出 `docs/dev/interfaces.md`（IPC 消息格式、命令表、事件全集、JS 模块命名空间、build_html 接入方式），Wave 2 全体以此为准，消除跨 agent 口头约定。

### 1.3 并行波次

| 波次 | 内容 | 并行度 |
|---|---|---|
| Wave 0（已完成） | 规划文档基线提交、工具链修复（w64devkit + self-contained 链接配置）、测试基线全绿 | 主 Agent 串行 |
| Wave 1 | 阶段 0：A1–A5 五流并行，各自 worktree | 5 subagent |
| Wave 2a | 阶段 1–6 Rust 模块（tree+search / watcher / operations / settings / codec+atomic+recovery）+ 前端骨架 shell + 测试用例流 | 6–7 subagent |
| Wave 2b | 前端面板（project-tree / search+quick-open / settings+keybindings+palette / recovery）按契约对接 | 2–4 subagent |
| 集成验收 | 主 Agent 合并全部 → cargo test / fmt / release 构建 / 冒烟 → 修缺陷 → 汇总报告 | 主 Agent |

## 2. 验收门禁（对每条流与最终集成统一适用）

1. `cargo test` 全绿 + `cargo fmt --check` 通过（本机 windows-gnu 工具链；CI 用 MSVC，配置已隔离到 `.cargo/config.toml` 的 GNU 段）
2. JS 测试 `node --test src/frontend/*.test.js tests/` 全绿（零依赖 node:test 约定）
3. 最终集成追加：`cargo build --release` 成功、产物 `GlanceMD-Ultra.exe` ≤ 8 MB（2026-09-09 由 5 MB 放宽，见 backlog FEAT-004）；Playwright 冒烟（若环境就绪）
4. 提交规范：Conventional Commits + 简体中文；**不 push、不打 tag**（tag=发布，由维护者执行）

## 3. 环境事实（所有 subagent 必读）

- worktree：`G:\worktrees\zcode\<流名>`，分支 `feat/stage0-*`，基于 main@7f2ba4c
- 工具链：rustc 1.98（x86_64-pc-windows-gnu）+ w64devkit binutils；PATH 已在 profile 配置 `/d/Software/w64devkit/w64devkit/bin`（验证：`which dlltool`）
- 代理（如需网络）：`http://127.0.0.1:7890`（curl `-x`；npm/Playwright 走 `HTTPS_PROXY` 环境变量）
- JS 测试正确姿势：`node --test src/frontend/*.test.js`（**不要**传目录形式，Node 22 Windows 下会误当模块路径）
- 每个 worktree 首次 `cargo test` 约 5–8 分钟（独立 target 目录），耐心等待，输出用 `2>&1 | tail` 截取

## 4. 风险与回退

| 风险 | 缓解 |
|---|---|
| 并行分支合并冲突（main.rs / Cargo.toml） | 所有权矩阵 + 附加式修改纪律；冲突由主 Agent 逐项裁决 |
| subagent 交付质量不齐 | 每流强制验证命令 + 主 Agent 合并前复审 diff |
| Playwright 浏览器下载失败 | 降级为零依赖 node:test 冒烟（既有约定），Playwright spec 文件保留待 CI |
| 模块间契约理解偏差 | interfaces.md 为唯一事实源；偏差在集成验收暴露后由主 Agent 统一修正 |
