# 意外导航保护实施计划

> **执行要求：** 按测试优先顺序逐项实施。

**目标：** 阻止主 WebView 离开 GlanceMD 应用壳，并为被拦截导航提供返回、重试和关闭操作。

**架构：** Wry 的 `with_navigation_handler` 作为宿主最后防线，仅允许应用根 URL；被拒绝的 URL 经事件循环转成现有 Rust → JavaScript 事件。前端以非破坏性横幅展示错误，不替换当前预览和标签状态。

**技术栈：** Rust、Wry 0.49、原生 JavaScript/CSS、Node test runner。

---

## 任务 1：宿主导航保护

- 修改 `src/main.rs`：提取可单测的导航判定函数，为根页面、片段导航和意外路径添加测试。
- 修改 WebView 构建链：使用 `with_navigation_handler` 拒绝意外主导航，并通过事件代理发送 `navigation_blocked` IPC 消息。
- 修改 `src/ipc.rs`：将目标 URL转发为前端事件。

## 任务 2：错误提示与回退交互

- 修改 `src/frontend/index.html`：增加语义化错误提示区域和返回、重试、关闭按钮。
- 修改 `src/frontend/preview.js`：复用本地链接解析逻辑，实现错误提示显示、关闭及本地目标重试。
- 修改 `src/frontend/app.js`：接收 `navigation_blocked` 事件。
- 修改 `src/frontend/style.css`：沿用现有主题变量设计横幅、按钮和焦点状态。
- 修改 `src/frontend/preview.test.js`：先覆盖提示不清空预览、返回/关闭、重试目标转换。

## 任务 3：验证与发布

- 运行 Node 行为测试和 JS 语法检查。
- 运行 Rust 测试及 Windows Release 构建。
- 用真实 WebView 验证正常本地链接和被拦截导航两个路径。
- 代码审查通过后更新补丁版本，提交并发布。
