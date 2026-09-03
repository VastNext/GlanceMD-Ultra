# 前端项目树与现有 Tab 架构

## 可复用能力

- Rust 返回 `file_opened` 后，`app.js` 已调用 `TabManager.createTab(path, content)`。
- `TabManager.createTab()` 会按路径去重；目录树点击文件可以完全复用现有打开链路。
- 编辑、预览、split、dirty、保存、最近文件均由现有 tab 状态承担，不需要重写编辑器。

## 必要 UI 变化

- 在 `index.html` 的 `#content` 中增加项目侧栏，位置应位于 TOC 与编辑器之间，或将 TOC/项目树统一为左侧活动面板。
- 新增“打开文件夹”入口及项目名、关闭项目/刷新按钮。
- 新增可折叠目录树：文件夹展开/收起、Markdown 文件单击打开、活动文件高亮。
- 新增右键菜单：至少“打开”“在系统文件管理器中显示”。菜单需要处理视口边缘、点击外部关闭、Escape 关闭。
- 建议新增 `project.js` IIFE，而不是继续扩张已很大的 `app.js`；需在 `main.rs::build_html()` 中把它加入脚本顺序（位于 tabs.js 之后、app.js 之前或 app.js 之前完成初始化）。

## 布局影响

- 当前 `#content` 已承载 TOC、编辑器、预览，split 又支持拖动比例。项目侧栏加入后，要明确项目树与 TOC 是否可同时打开。
- 推荐第一版采用“左侧面板同一时间显示项目树或 TOC”的活动面板模式，避免三列（项目树 + TOC + 编辑器 + 预览实际为四块）在小窗口下不可用。
- 如果项目树和 TOC 允许同时显示，需要新增宽度约束与多条 resize handle，交互复杂度显著增加。

## 路径问题

- `tabs.js::findTabByPath()` 和 `app.js::addRecentFile()` 当前都无条件 `toLowerCase()` 比较路径。
- 这在 Windows 合理，但 Linux 和大小写敏感的 macOS 卷上会把 `README.md` 与 `readme.md` 错误视为同一文件。
- 文件树功能会把该隐患变成常见问题，实施时应增加平台感知的路径比较策略。

## 状态模型

前端建议新增：

```text
projectRoot, projectName,
expandedDirectories(Set),
loadedChildren(Map),
activeTreePath,
contextMenuTarget
```

项目树不应复制文件内容；tab 仍是文件内容唯一状态源。
