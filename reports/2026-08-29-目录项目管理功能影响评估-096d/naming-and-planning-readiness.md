# GlanceMD Ultra 命名与开发计划准备记录

- 确认日期：2026-08-29
- 状态：已确认，供后续 OpenSpec、架构设计和开发计划直接引用

## 1. 正式命名

| 场景 | 名称 |
|---|---|
| 面向用户的正式产品名 | **GlanceMD Ultra** |
| 技术项目名 / 仓库候选名 | `GlanceMD-Ultra` |
| Rust package | `glancemd-ultra` |
| Windows 可执行文件 | `GlanceMD-Ultra.exe` |
| macOS 应用名 | `GlanceMD Ultra.app` |
| Linux 包名 | `glancemd-ultra` |
| 配置目录 | `glancemd-ultra` |
| localStorage 前缀 | `glancemd-ultra-` |
| Bundle ID 候选 | `com.vastnext.glancemd-ultra` |

文档正文统一使用不带连字符的 **GlanceMD Ultra**；文件名、仓库、包、可执行文件等机器标识使用 `GlanceMD-Ultra` 或 `glancemd-ultra`。

禁止再使用旧候选名 `GlanceUltraMD`。

## 2. 品牌层级

### GlanceMD

> 记事本般快速、Obsidian 般界面的轻量 Markdown 查看/编辑器。

核心场景：单文件快速打开、多 tab、轻量查看与编辑。

### GlanceMD Ultra

> 面向本地 Markdown 与结构化文本项目的轻量原生工作区编辑器。

核心场景：单项目目录、项目树、文件管理、监听、搜索、设置、快捷键、恢复与多窗口。

Ultra 是 GlanceMD 产品线的高级工作区产品，不是代码 IDE。

## 3. 当前推荐产品结构

- 首个稳定版本前采用**同仓共享核心、双产品入口**。
- GlanceMD 保持轻量单文件体验，不默认加载 Ultra 的 Workspace 子系统。
- GlanceMD Ultra 复用编辑器、Markdown 渲染、Tab、主题、保存和平台窗口能力。
- 暂不立即复制为两个独立仓库，避免共享编辑内核漂移。

## 4. 后续开发计划的输入文档

后续创建实施计划时必须按下列优先级读取：

1. `naming-and-planning-readiness.md`：命名与产品关系。
2. `product-decisions.md`：全部已确认产品决策。
3. `GlanceMD-Ultra-product-architecture-proposal.md`：完整产品与架构方案。
4. `product-decisions-questionnaire.md`：决策来源与备选方案。
5. `synthesis.md` 和 `sub_reports/*.md`：研究依据与风险。
6. `report.md`：最初小范围评估，仅作历史参考，不再代表当前范围。

## 5. 计划阶段不可重新打开的已决策事项

- 一个窗口一个项目；打开另一项目询问新窗口或替换。
- 项目树与 Outline 同时显示，默认并排，可设置 Outline 在右。
- 第一版支持 Ctrl/Shift 多选，多选时 reveal 禁用。
- 文件监听、自动重载、dirty 冲突保护为必需能力。
- 新建、重命名、回收站删除、永久删除、复制、移动、撤销为必需能力。
- 全文搜索、Ctrl+P、设置、快捷键和命令面板为必需能力。
- Delete 进入回收站，Shift+Delete 永久删除并确认。
- 第一阶段 UTF-8/BOM，保留换行；GBK 等编码后置。
- 允许体积增至 2–5 MB，但保持原生轻量，不采用 Electron/Monaco。

只有用户明确改变产品决策时，计划阶段才允许调整以上内容。

## 6. 下一份文档

下一步应创建：

```text
docs/plans/YYYY-MM-DD-glancemd-ultra-workspace-implementation-plan.md
```

计划至少拆分为：

1. 共享核心与双产品入口。
2. Workspace 命令、事件和可信项目根。
3. 项目树、多选、双布局、定位当前文件、Ctrl+P。
4. 文件监听、冲突和自动刷新。
5. 文件操作、回收站和撤销。
6. 全文搜索。
7. 设置、快捷键和命令面板。
8. 原子保存、编码元数据、崩溃恢复和大文件模式。
9. 三平台稳定性、性能和发布。

实施计划不能把上述九个单元压成一次性大提交；每一阶段都必须有独立验收标准、回归测试和可发布的垂直切片。
