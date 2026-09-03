# Visual Plan

## Context

- report: `report.md`
- purpose: 帮助维护者快速比较三平台差异、理解平台化改造顺序并据此排期。
- status: applied

## Plan

| slot | purpose | type | content_source | must_have | output |
|---|---|---|---|---|---|
| 执行摘要后 | 横向比较后端、包格式、依赖与正式发布要求 | Markdown 表格 | synthesis + d2 + d3 | 必须 | `report.md` 平台矩阵 |
| 共用架构调整 | 展示从 Windows 耦合代码到三平台实现的依赖关系 | Mermaid flowchart | d1 + d2 | 必须 | `report.md` 内 Mermaid |
| 实施路线 | 表达四阶段先后与每阶段交付门槛 | Mermaid flowchart | d4 | 必须 | `report.md` 内 Mermaid |
| CI/CD 与测试 | 精确对照 runner、target、任务、产物 | Markdown 表格 | d3 + d4 | 必须 | `report.md` CI 矩阵 |
| 风险章节 | 对风险、影响和回退方案做可执行映射 | Markdown 表格 | synthesis + d4 | 必须 | `report.md` 风险表 |

## Notes

- 未使用 AI 概念图：本报告是工程决策材料，核心认知任务是精确比较、依赖排序和风险映射，表格与 Mermaid 比概念图更可核验。
- 不绘制工期数值图：没有团队速度和实机构建数据，避免制造虚假精度。
