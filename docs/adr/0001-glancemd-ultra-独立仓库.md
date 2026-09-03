# ADR 0001：GlanceMD Ultra 采用独立仓库

- 日期：2026-09-04
- 状态：已接受
- 决策人：产品维护者

## 背景

`GlanceMD-Ultra-product-architecture-proposal.md`（§2）建议在首个 Ultra 稳定版本前采用"同仓共享核心、双产品入口"，以避免两份编辑内核漂移。该建议列出的拆仓条件包括"维护者希望两个产品拥有独立 issue、roadmap 和品牌治理"。

## 决策

2026-09-04 维护者决定提前触发拆仓条件：创建独立仓库 `VastNext/GlanceMD-Ultra`（初始为私有），以 GlanceMD v1.6.3（main @ db1b734）快照为初始代码基线，清除原 GitHub 历史，从全新提交历史开始独立演进。

- `VastNext/GlanceMD` 继续保持单文件轻量产品的独立演进。
- `VastNext/GlanceMD-Ultra` 是工作区编辑器产品线的唯一开发仓库。
- 本仓库 `origin` 指向 `VastNext/GlanceMD-Ultra`；不与 `VastNext/GlanceMD` 建立任何 git 远程跟踪关系。

## 影响

1. **共享内核不再自动同步**。两个仓库共同拥有的编辑内核（tabs/editor/preview/theme/保存/平台窗口）缺陷修复需要手动双向 cherry-pick。修复时应在提交信息中标注 `[sync]` 前缀，便于跨仓库检索。
2. **轻量约束重新表述**。原"GlanceMD 的单文件体验不能因 Ultra 退化"约束对本仓库不再适用；Ultra 自身的轻量目标为：二进制 2–5 MB 以内、无 Electron/Monaco、保持无外部运行时依赖（安装包自包含）。
3. **双产品入口不再需要**。本仓库内不做产品开关或 feature gate 区分两个产品；所有 Workspace 能力均为 Ultra 产品本体。
4. 若未来两仓库重复修复增多（经验阈值：同一文件双修 ≥3 次/月），再评估将共享内核提取为独立 crate 的可行性（另行 ADR）。

## 备选方案（未采纳）

- 同仓双产品入口（调研原推荐）：保住共享内核零漂移，但 issue/roadmap/CI/发布节奏与原产品耦合，与维护者希望的独立品牌治理冲突。
- GitHub Fork：保留完整旧历史，与"全新项目历史"的诉求冲突。
