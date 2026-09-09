# 保存代码拆分提交方案至 docs 目录计划

### 1. 目标
将上一步讨论确定的《代码拆分提交方案 (Conventional Commits)》整理保存为项目文档，归档到 `docs/plans/2026-09-09-uncommitted-changes-split-commit-plan.md`，方便团队回溯与逐步执行提交。

### 2. 方案内容纲要
文档将详细包含：
- **当前工作区状态总览**：49 个修改文件（+6027 / -493）、27 条未跟踪路径（共 98 个未跟踪文件）的范围和现状；
- **7 个拆分阶段的详细提交设计**：
  1. `feat(editor): 引入自定义光标渲染与编辑器命令扩展`
  2. `feat(ui): 增加浮层辅助模块与快速大纲 (Quick Outline) 导航`
  3. `feat(vim): 完善 Vim 模态编辑引擎、状态栏与可视 UI 反馈`
  4. `feat(keybindings): 扩充 Eclipse 与 VS Code 键盘方案、按键辅助与设置面板`
  5. `feat(core): 主应用接入、设置联动与 Rust IPC 适配`
  6. `test(e2e): 补充 Eclipse/Vim 方案矩阵与回归自动化套件`
  7. `docs(qa): 记录 Eclipse 测试矩阵与待办规划`
- **每个提交对应的具体文件清单**、提交动机、代码职责边界及安全提交流程建议。

### 3. 产物路径
- `docs/plans/2026-09-09-uncommitted-changes-split-commit-plan.md`
