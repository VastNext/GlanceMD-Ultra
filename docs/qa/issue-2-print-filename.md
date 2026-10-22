# Issue #2：打印文件名调查与验证

## 发现与范围

- 基线：`1640585`（v0.11.2），从最新 `origin/main` 创建 `fix/issue-2-print-filename`。
- 仓库不存在 `openspec/AGENTS.md`；遵循主实施计划与 `AGENTS.md` 门禁。
- Windows 应用内入口：`export.js::printPreviewPdf` → `app.printToPdf` → `commands.rs::app_print_to_pdf` → `file_ops.rs::pick_export_file` → rfd 原生另存为 → WebView2 `PrintToPdf`。
- 原实现已经把活动文档的建议文件名传入 `set_file_name`。普通中文文档名为空的原生现象尚未复现，不能认定缺少文件名传递是根因。
- 已确认缺陷：建议文件名未经非法字符清理；空建议值不调用 `set_file_name`，没有回退值。本次只修正这两个确定问题，不改打印方式、不改版本、不发版。
- 原生对话框前统一替换路径分隔符、控制字符与 Windows 非法字符，处理设备保留名、尾随点与空格、空基名，并补齐目标扩展名。保留普通中文名和多点基名。

## 验证证据

- 测试先行：3 个 Rust 文件名测试在保持旧有 trim 行为时均失败，覆盖空值、非法字符和扩展名规范化；实现后通过。
- `cargo test --quiet -j 2` 全量通过；有原有 `pandoc.rs` 非 snake case 警告及已有忽略测试。
- `cargo fmt --check` 通过。
- `node --test --test-reporter=dot src/frontend/*.test.js tests/smoke.test.js` 通过。
- 原有 Playwright 冒烟 119 项通过；新增 `print-filename.spec.js` 的明暗两项通过，实际点击打印样式导出，确认中文名称、取消后切换文档及新请求名称。
- 新增 IPC 反序列化测试确认 `suggestName` 和 `requestId` 保留在命令扩展参数中。
- 双主题截图位于隔离工作区 `tests/e2e/test-results/print-filename-*/print-menu-*.png`，已查看，菜单显示正常。这些是浏览器截图，不是原生保存对话框截图。
- 实现提交 `09ffb14258c7ec1680c2c94ca84baaba476840d2` 的四平台 [Build 39816096364](https://github.com/VastNext/GlanceMD-Ultra/actions/runs/39816096364) 全部成功：Windows x64、macOS arm64、macOS x64、Linux x64。文档更新后的候选提交和合入后的 main 仍须分别显式运行 Build 并确认全绿。

## 审查与限制

- 自审覆盖：IPC 字段传递、跨格式扩展名、Unicode 保留、取消后重试、不改最终用户选择的路径、无新增依赖。
- 初次独立审查工具受阻后，主代理补充的 correctness-reviewer 已审查全部四个变更文件，无阻塞 findings；审查明确原 Issue 尚未验证解决，统一跨平台文件名清理属于已知范围变化。
- 主代理补充调查发现 HTML 无 `title`、无 `document.title` 更新，系统 `app.print` 直接调用 `webview.print` 而不设置标题。但 Windows 正常菜单走 `app.printToPdf`，且 Ctrl+P 不是打印命令，因此该线索不能认定为原问题根因，本次不据此修改系统打印路径。
- 没有 Windows 原生 UI 自动化验证，不宣称系统保存对话框已验证或 Issue 已完全解决。
- 需报告者确认具体入口（应用导出菜单还是系统打印栈）、原生对话框截图与实际文件名，才能继续定位普通文件名为空的问题。Issue 保持打开。
- 主工作区原有 QA 图片、`.zcode*` 和分支均未改动；冒烟生成的图片仅留在隔离工作区，不纳入提交。
