# GlanceMD Ultra 语言与快捷键调研

日期：2026-09-06

> 本文用于产品决策，不代表已实施。调研以当前工作树和 VS Code、Eclipse、Sublime Text、JetBrains 官方资料为依据。

## 1. 当前实现审计

### 1.1 语言设置

`appearance.language` 已存在于 Rust schema、全局/项目设置合并、设置页枚举和运行时应用层。当前支持：

| 保存值 | 显示名 |
|---|---|
| `zh-CN` | 简体中文 |
| `en` | English |

当前源码应在“设置 → 外观”显示“界面语言”。如果真实程序没有显示，优先核对是否运行了旧构建；前端通过 `include_str!` 嵌入 exe，不会运行时读取磁盘 JS。

但当前国际化只完成了部分界面：设置页分类、设置项标签/说明、快捷键页按钮和大量命令名称仍为硬编码中文。因此切换 English 后会出现中英混合，这需要作为完整语言模块修复，而不是只增加一个下拉框。

关键位置：

- `src/workspace/settings.rs`：`Appearance.language`
- `src/frontend/settings.js`：`appearance.language` META/ENUMS
- `src/frontend/settings-apply.js`：应用 effective language
- `src/frontend/i18n.js`：`zh-CN`/`en` 字典与语言切换

### 1.2 快捷键系统

当前存在三类不一致：

1. `Keybindings.defaults` 只有 5 项，其中 `quickopen.toggle`、`search.toggle`、`palette.toggle` 尚未注册到 `window.Commands`，所以可显示/录制但统一 dispatcher 无法执行。
2. `workspace.open` 和其他已注册命令没有默认键，设置页把它们渲染为只读“未设快捷键”，没有“修改”按钮。
3. 保存、新建、关闭、分屏、Outline 等仍有部分硬编码在 `app.js`，尚未完全迁移到统一命令/快捷键系统。

“打开项目文件夹不能设置快捷键”的直接根因是设置页仅允许编辑 `Keybindings.defaults` 中的命令；已注册但无默认键的命令只显示徽标。底层 overrides 和 dispatch 实际可以支持任意命令 ID。

快捷键覆盖目前保存在 localStorage，而 Rust schema 中的 `keybindings.overrides` 尚未成为事实源，需要一并统一。

## 2. v0.1.0 快捷键边界与后续方向

v0.1.0 当前仅提供**基础快捷键/有限自定义**：现有单段快捷键可录制、冲突提示、清除、恢复默认和持久化。它不包含 chord、context、多键位方案（multi-scheme）、Key Assist 或 Vim。当前实现仍有部分动作由旧的硬编码路径处理，不能把设置页存在快捷键编辑器等同于完整快捷键系统已完成。

以下是用户最终确认的后续强快捷键方向，**全部尚未实施**：

- 首装默认启用 Eclipse scheme，并提供完整 VS Code scheme。
- 所有公开命令都必须有默认键。
- Eclipse 键位：`Ctrl+O` Quick Outline、`Ctrl+Shift+S` Save All、`Ctrl+E` Quick Switch、`Ctrl+H` Search、`Ctrl+3` Find Actions。
- Ultra 扩展：`Alt+Shift+F O` 打开文件、`Alt+Shift+F P` 打开项目、`Alt+Shift+S` 另存为、`Alt+Shift+P` 打开设置；在设置内用 `Alt+Shift+P K` 进入快捷键页；用 `Alt+Shift+E V` 切换 Vim。
- Vim 属于编辑器层，首版目标为常用完整集。
- 完整测试门禁预计 **398–588 项**。

本节方向是评估与规格冻结结果，不是交付状态；chord、context、scheme、Key Assist、Vim 及 398–588 项测试门禁目前均未实施。

### 2.1 当前基础键位（仅作现状记录）

### 2.2 历史候选键位（已被最终方向取代）

以下候选表保留作为调研依据，但不再代表最终默认键位；实施时以本节“用户最终确认的后续强快捷键方向”为准。

#### 原候选：立即采用或保留

| 功能 | 建议 Windows/Linux 默认键 | 当前状态 | 依据与说明 |
|---|---|---|---|
| 打开文件 | `Ctrl+O` | 已有 | VS Code 与桌面应用惯例 |
| 快速打开 | `Ctrl+P` | 已声明但命令未注册 | VS Code、Sublime Text |
| 全文搜索 | `Ctrl+Shift+F` | 已声明但命令未注册 | VS Code、Sublime、JetBrains |
| 命令面板 | `Ctrl+Shift+P`，兼容 `F1` | 已声明但命令未注册 | VS Code、Sublime Text |
| 设置 | `Ctrl+,` | 当前 `Ctrl+\`` | VS Code 惯例；释放 `Ctrl+\`` 给未来终端能力 |
| 保存 | `Ctrl+S` | 已硬编码 | 通用惯例，应迁入 Commands |
| 另存为 | `Ctrl+Shift+S` | 已硬编码 | VS Code/通用惯例，应迁入 Commands |
| 新建文档 | `Ctrl+N` | 已硬编码 | VS Code、Eclipse、Windows 惯例 |
| 关闭标签 | `Ctrl+W`；Windows 可兼容 `Ctrl+F4` | 已硬编码 `Ctrl+W` | Eclipse 同时支持两者；VS Code 平台有差异 |
| 标签切换 | `Ctrl+Tab` / `Ctrl+Shift+Tab` | 已硬编码 | 浏览器与编辑器通用惯例 |
| 分屏 | `Ctrl+\` | 已硬编码 | VS Code 惯例 |
| 显示/聚焦资源管理器 | `Ctrl+Shift+E` | 无命令/默认键 | VS Code 惯例、冲突低 |

### 2.3 建议在支持 chord 后采用

| 功能 | 建议默认键 | 来源 | 说明 |
|---|---|---|---|
| 打开项目文件夹/工作区 | `Ctrl+K Ctrl+O` | VS Code | 推荐方案；当前引擎不支持双段 chord |
| 在系统文件管理器显示 | `Ctrl+K R` | VS Code | 与“定位当前文件到应用内树”明确区分 |
| 打开侧边预览 | `Ctrl+K V` | VS Code Markdown | 若以后区分切换预览与侧边预览 |
| 切换项目侧栏 | `Ctrl+K Ctrl+B` | Sublime Text | 避免 `Ctrl+B` 与 Markdown 加粗冲突 |

### 2.4 建议保持“无默认键、允许用户绑定”

| 功能 | 候选键 | 建议 |
|---|---|---|
| Outline 显示/隐藏 | `Ctrl+Shift+O` | 可保留现状，也可默认不绑定。VS Code 中该键实际是“转到符号”，浏览器有书签冲突 |
| 定位当前文件到项目树 | `Alt+F1`（JetBrains） | 跨 Linux 有系统冲突，建议默认不绑定 |
| 在外部终端打开目录 | `Alt+F12`（JetBrains 倾向） | 当前是外部终端而非集成终端，建议默认不绑定 |
| 折叠项目树全部节点 | `Ctrl+Shift+NumPad /`（Eclipse） | 笔记本可达性差，建议命令面板或自定义 |
| 项目树新建/移动/复制/删除 | 多数沿用 `Insert`、`F2`、`Delete` 等上下文键 | 必须限制项目树焦点，不设无条件全局键 |
| 撤销文件操作 | 项目树聚焦时 `Ctrl+Z` | 采用 Eclipse/VS Code 上下文 Undo 模型，不设全局独占键 |
| 恢复/冲突处理命令 | 无 | 属于临时 UI 上下文动作，只需允许自定义，不建议默认占键 |

## 3. Eclipse 可借鉴的部分

Eclipse 最值得借鉴的不是具体按键，而是“上下文绑定”模型：

- 编辑器聚焦时 `Ctrl+Z` 撤销文本；
- 资源视图聚焦时 `Ctrl+Z` 可撤销工作区文件操作；
- 命令根据当前视图、编辑器和 context 决定是否启用；
- `Ctrl+Shift+L` 可查看当前上下文可用快捷键；
- `Ctrl+3` 是 Find Actions，类似命令面板；
- `Ctrl+Shift+R` 是快速打开 Workspace Resource；
- `Ctrl+O` 是 Quick Outline，因此不适合 GlanceMD Ultra 同时拿来打开文件。

因此建议 GlanceMD Ultra 后续至少支持：

- `editorTextFocus`
- `inputFocus`
- `projectTreeFocus`
- `markdownEditorActive`
- `workspaceOpen`
- `panelVisible`

否则 `Ctrl+Z`、`Ctrl+B`、`Ctrl+Shift+V` 和项目树文件操作很容易误触。

## 4. 推荐实施顺序

1. 完整修复语言设置：确保下拉可见，并把设置页、命令名称、快捷键页文案全部接入 i18n；首期只支持简体中文和 English。
2. 修复命令注册表：注册 quick open、全文搜索、命令面板，以及 app.js 中保存、新建、关闭、预览、分屏、Outline 等现有动作。
3. 让所有已注册命令都能录制快捷键；“未设快捷键”不再是只读状态。
4. 统一快捷键持久化到 `settings.keybindings.overrides`，localStorage 只做一次迁移。
5. 增加 `when`/context 条件，先解决输入框和项目树/编辑器焦点差异。
6. 支持双段 chord，再启用 `Ctrl+K Ctrl+O`、`Ctrl+K R` 等默认键。
7. 最后应用经确认的默认键位，并提供冲突诊断与恢复默认。

## 5. 官方来源

### VS Code

- 默认快捷键：https://code.visualstudio.com/docs/reference/default-keybindings
- 快捷键、chord 和 when 条件：https://code.visualstudio.com/docs/configure/keybindings
- 用户界面、Explorer 与分屏：https://code.visualstudio.com/docs/editing/userinterface
- Markdown Preview：https://code.visualstudio.com/docs/languages/markdown/
- Terminal：https://code.visualstudio.com/docs/terminal/basics
- Open Folder 源码默认 binding：https://github.com/microsoft/vscode/blob/df4e4d95/src/vs/workbench/browser/actions/workspaceActions.ts
- Explorer 文件动作：https://github.com/microsoft/vscode/blob/e8db8ed8/src/vs/workbench/contrib/files/browser/fileActions.contribution.ts

### Eclipse

- 常用默认键位：https://help.eclipse.org/latest/topic/org.eclipse.platform.doc.user/reference/ref-keybindings.htm
- key scheme/context：https://help.eclipse.org/latest/topic/org.eclipse.platform.doc.user/concepts/concepts-keys.htm
- 键盘导航与 Find Actions：https://help.eclipse.org/latest/topic/org.eclipse.platform.doc.user/concepts/accessibility/navigation.htm
- Open Resource 等技巧：https://help.eclipse.org/latest/topic/org.eclipse.platform.doc.user/tips/platform_tips.html
- 工作区 Undo 模型：https://help.eclipse.org/latest/topic/org.eclipse.platform.doc.isv/guide/wrkAdv_undo_ide.htm
- Eclipse Platform bindings 源码：https://github.com/eclipse-platform/eclipse.platform.ui/blob/master/bundles/org.eclipse.ui/plugin.xml

### 其他官方参考

- Sublime Text Windows/Linux 快捷键：https://docs.sublimetext.io/reference/keyboard_shortcuts_win.html
- JetBrains Windows 默认 keymap：https://www.jetbrains.com/help/idea/reference-keymap-win-default.html
- Microsoft Edge 快捷键：https://support.microsoft.com/en-us/edge/keyboard-shortcuts-in-microsoft-edge
- Chrome 快捷键：https://support.google.com/chrome/answer/157179
