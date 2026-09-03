# Visual Plan

## Context

- report: `report.md`
- purpose: 帮助维护者比较适配路线、理解推荐架构和安排 FPK 上架工作。
- status: applied

## Plan

| slot | purpose | type | content_source | must_have | output |
|---|---|---|---|---|---|
| 执行摘要后 | 精确比较直接 GUI、Native Web、Docker 三条路线 | Markdown 表格 | synthesis + d4 | 必须 | `report.md` 路线矩阵 |
| 推荐目标架构 | 说明浏览器、飞牛网关、后端 API 与文件系统关系 | Mermaid flowchart | d1 + d2 + d4 | 必须 | `report.md` 内 Mermaid |
| FPK 打包章节 | 展示包内目录与安装后映射 | 文本目录树 | d2 | 必须 | `report.md` 目录树 |
| 商店上架章节 | 展示侧载、真机、申请、审核的顺序 | Mermaid flowchart | d3 + d4 | 必须 | `report.md` 内 Mermaid |
| 风险章节 | 映射风险、影响、门禁和回退方案 | Markdown 表格 | synthesis + d4 | 必须 | `report.md` 风险矩阵 |

## Notes

- 未使用 AI 图片：本报告的核心任务是技术比较、系统架构和发布流程，表格、目录树和 Mermaid 更精确可核验。
- 不绘制工期图：没有团队速度和 fnOS 真机验证数据，避免虚假精度。
