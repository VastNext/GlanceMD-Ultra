# 快捷键逐项集成验证报告

> 最终全量浏览器门禁：50 passed / 0 failed / 0 skipped。注意：测试用例全绿不等于65个快捷键全部覆盖；下表仅充分行为证据行记PASS，缺失/歧义断言保留NOT TESTED。
> 旧版合并行/注册即可PASS判定已废弃。Windows Chromium+IPC mock不证明原生对话框、系统剪贴板或其他平台。
> E2E文件基目录：`D:/WorkDev/MyShare/GlanceMD-Ultra/tests/e2e/specs/`；单测基目录：`D:/WorkDev/MyShare/GlanceMD-Ultra/src/frontend/`。

## ultra.eclipse（52条）

| 编号 | 快捷键 | Command | 按键测试证据（已核实输出） | 单元证据（已核实输出） | 状态 | 限制 |
|---|---|---|---|---|---|---|
| 1 | Ctrl+O | outline.toggle | eclipse-editor-shortcuts.spec.js — Eclipse Outline Ctrl+O 是 toggle 并恢复编辑器焦点 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 2 | Ctrl+Shift+S | file.saveAll | 无充分独立按键行为证据 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | NOT TESTED | 仅默认绑定声明，无实际按键保存全部行为 |
| 3 | Alt+Shift+S | file.saveAs | 无充分独立按键行为证据 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | NOT TESTED | 按键存在，但累计IPC未清空，前一步保存已有save_as；不能独立证明本键 |
| 4 | Alt+Shift+F O | file.open | app.spec.js — Alt+Shift+F O：完整脚本加载后触发一次 open_file IPC | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 5 | Alt+Shift+F P | workspace.open | 无充分独立按键行为证据 | commands.test.js — run(workspace.open) 有路径时直接打开，无路径时请求原生目录选择器 | NOT TESTED | 缺真实按键+预期效果断言 |
| 6 | Alt+Shift+P | settings.toggle | eclipse-workbench-shortcuts.spec.js — Alt+Shift+P toggle 设置，后续 K 进入快捷键分类 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 7 | Alt+Shift+P K | settings.keybindings | eclipse-workbench-shortcuts.spec.js — Alt+Shift+P toggle 设置，后续 K 进入快捷键分类 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 8 | Alt+Shift+E V | editor.vim.toggle | keyboard-schemes-vim.spec.js — Vim Mode：Alt+Shift+E V 开启、i 插入、Esc 回 Normal、:w 保存与关闭恢复 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 9 | Ctrl+3 | palette.toggle | keyboard-schemes-vim.spec.js — Eclipse Scheme：Ctrl+3 打开命令面板、Ctrl+H 打开搜索、Ctrl+Shift+L 打开 Key Assist | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 10 | Ctrl+Shift+L | keyassist.toggle | keyboard-schemes-vim.spec.js — Eclipse Scheme：Ctrl+3 打开命令面板、Ctrl+H 打开搜索、Ctrl+Shift+L 打开 Key Assist | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 11 | Ctrl+H | search.toggle | keyboard-schemes-vim.spec.js — Eclipse Scheme：Ctrl+3 打开命令面板、Ctrl+H 打开搜索、Ctrl+Shift+L 打开 Key Assist | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 12 | Ctrl+E | tabs.quickSwitch | eclipse-workbench-shortcuts.spec.js — Ctrl+E、Ctrl+F6、Ctrl+Shift+F6 切换已打开标签页 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 13 | Ctrl+Shift+R | resource.open | eclipse-workbench-shortcuts.spec.js — Ctrl+Shift+R 打开资源 Quick Open，F12 聚焦编辑器 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 14 | Ctrl+F6 | tabs.next | eclipse-workbench-shortcuts.spec.js — Ctrl+E、Ctrl+F6、Ctrl+Shift+F6 切换已打开标签页 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 15 | Ctrl+Shift+F6 | tabs.previous | eclipse-workbench-shortcuts.spec.js — Ctrl+E、Ctrl+F6、Ctrl+Shift+F6 切换已打开标签页 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 16 | Ctrl+F7 | focus.next | eclipse-workbench-shortcuts.spec.js — Ctrl+F7 与 Ctrl+Shift+F7 正反向切换工作区焦点 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 17 | Ctrl+Shift+F7 | focus.previous | eclipse-workbench-shortcuts.spec.js — Ctrl+F7 与 Ctrl+Shift+F7 正反向切换工作区焦点 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 18 | F12 | editor.focus | eclipse-workbench-shortcuts.spec.js — Ctrl+Shift+R 打开资源 Quick Open，F12 聚焦编辑器 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 19 | Ctrl+S | file.save | eclipse-workbench-shortcuts.spec.js — 文件与保存类 Eclipse 快捷键均分派到真实行为 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 20 | Ctrl+N | file.new | eclipse-workbench-shortcuts.spec.js — 文件与保存类 Eclipse 快捷键均分派到真实行为 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 21 | Ctrl+W | file.close | eclipse-workbench-shortcuts.spec.js — 文件与保存类 Eclipse 快捷键均分派到真实行为 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 22 | Ctrl+Z | editor.undo | eclipse-editor-shortcuts.spec.js — Eclipse 行删除、撤销、重做 | editor-commands.test.js — delete line and undo redo roundtrip | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 23 | Ctrl+Y | editor.redo | eclipse-editor-shortcuts.spec.js — Eclipse 行删除、撤销、重做 | editor-commands.test.js — delete line and undo redo roundtrip | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 24 | Ctrl+X | editor.cut | 无充分独立按键行为证据 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | NOT TESTED | 无系统剪贴板行为断言 |
| 25 | Ctrl+C | editor.copy | 无充分独立按键行为证据 | wave1-keybinding.test.js — BindingService passthrough binding executes without preventDefault（自造copy绑定，非系统剪贴板） | NOT TESTED | 无系统剪贴板行为断言 |
| 26 | Ctrl+V | editor.paste | 无充分独立按键行为证据 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | NOT TESTED | 无系统剪贴板行为断言 |
| 27 | Ctrl+A | editor.selectAll | 无充分独立按键行为证据 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | NOT TESTED | 缺真实按键+预期效果断言 |
| 28 | Ctrl+D | editor.deleteLines | eclipse-editor-shortcuts.spec.js — Eclipse 行删除、撤销、重做 | editor-commands.test.js — delete line and undo redo roundtrip | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 29 | Ctrl+Shift+Delete | editor.deleteToLineEnd | 无充分独立按键行为证据 | editor-commands.test.js — delete to line end, insert above/below and outdent | NOT TESTED | 缺真实按键+预期效果断言 |
| 30 | Alt+ArrowUp | editor.moveLinesUp | eclipse-editor-shortcuts.spec.js — Eclipse 行移动与复制 | editor-commands.test.js — move and copy selected lines | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 31 | Alt+ArrowDown | editor.moveLinesDown | 无充分独立按键行为证据 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | NOT TESTED | 缺真实按键+预期效果断言 |
| 32 | Ctrl+Alt+ArrowUp | editor.copyLinesUp | 无充分独立按键行为证据 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | NOT TESTED | 缺真实按键+预期效果断言 |
| 33 | Ctrl+Alt+ArrowDown | editor.copyLinesDown | eclipse-editor-shortcuts.spec.js — Eclipse 行移动与复制 | editor-commands.test.js — move and copy selected lines | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 34 | Shift+Enter | editor.insertLineBelow | 无充分独立按键行为证据 | editor-commands.test.js — delete to line end, insert above/below and outdent | NOT TESTED | 缺真实按键+预期效果断言 |
| 35 | Ctrl+Shift+Enter | editor.insertLineAbove | 无充分独立按键行为证据 | editor-commands.test.js — delete to line end, insert above/below and outdent | NOT TESTED | 缺真实按键+预期效果断言 |
| 36 | Shift+Tab | editor.outdent | eclipse-editor-shortcuts.spec.js — Eclipse 大小写、HTML注释与反缩进 | editor-commands.test.js — delete to line end, insert above/below and outdent | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 37 | Ctrl+ArrowUp | editor.scrollLineUp | 无充分独立按键行为证据 | editor-commands.test.js — scroll line keeps selection unchanged | NOT TESTED | 按键存在，仅断言光标未动，未断言向上滚动 |
| 38 | Ctrl+ArrowDown | editor.scrollLineDown | eclipse-editor-shortcuts.spec.js — Eclipse Ctrl+Up/Down 仅滚动视口且光标不动 | editor-commands.test.js — scroll line keeps selection unchanged | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 39 | Ctrl+Shift+ArrowUp | editor.previousHeading | eclipse-editor-shortcuts.spec.js — Eclipse Ctrl+Shift+Up/Down 在 Markdown 标题间导航 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 40 | Ctrl+Shift+ArrowDown | editor.nextHeading | eclipse-editor-shortcuts.spec.js — Eclipse Ctrl+Shift+Up/Down 在 Markdown 标题间导航 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 41 | Ctrl+L | editor.goToLine | editor-navigation-regressions.spec.js — Ctrl+L 31 repeated three times selects a visible logical line after long Chinese soft wraps | editor-commands.test.js — go to line and toggle wrap | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 42 | Ctrl+F | actions.find | editor-navigation-regressions.spec.js — Ctrl+F searches selected text in the editor and keeps find inline | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 43 | Ctrl+K | actions.find.next | editor-navigation-regressions.spec.js — Ctrl+K and Ctrl+Shift+K from find input scroll to visible next and previous matches | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | find-input焦点实际按键；editorTextFocus独立路径未单独验证 |
| 44 | Ctrl+Shift+K | actions.find.previous | editor-navigation-regressions.spec.js — Ctrl+K and Ctrl+Shift+K from find input scroll to visible next and previous matches | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | find-input焦点实际按键；editorTextFocus独立路径未单独验证 |
| 45 | Ctrl+J | actions.find.incrementalNext | 无充分独立按键行为证据 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | NOT TESTED | 缺真实按键+预期效果断言 |
| 46 | Ctrl+Shift+J | actions.find.incrementalPrevious | 无充分独立按键行为证据 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | NOT TESTED | 缺真实按键+预期效果断言 |
| 47 | Ctrl+Shift+X | editor.uppercase | eclipse-editor-shortcuts.spec.js — Eclipse 大小写、HTML注释与反缩进 | editor-commands.test.js — uppercase lowercase and comments preserve selections | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 48 | Ctrl+Shift+Y | editor.lowercase | eclipse-editor-shortcuts.spec.js — Eclipse 大小写、HTML注释与反缩进 | editor-commands.test.js — uppercase lowercase and comments preserve selections | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 49 | Ctrl+/ | editor.toggleComment | eclipse-editor-shortcuts.spec.js — Eclipse 大小写、HTML注释与反缩进 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 50 | Ctrl+Shift+/ | editor.addBlockComment | 无充分独立按键行为证据 | editor-commands.test.js — uppercase lowercase and comments preserve selections | NOT TESTED | 缺真实按键+预期效果断言 |
| 51 | Ctrl+Shift+\ | editor.removeBlockComment | 无充分独立按键行为证据 | editor-commands.test.js — uppercase lowercase and comments preserve selections | NOT TESTED | 缺真实按键+预期效果断言 |
| 52 | Alt+Shift+Y | editor.toggleWrap | 无充分独立按键行为证据 | editor-commands.test.js — go to line and toggle wrap | NOT TESTED | 缺真实按键+预期效果断言 |

## ultra.vscode（13条）

| 编号 | 快捷键 | Command | 按键测试证据（已核实输出） | 单元证据（已核实输出） | 状态 | 限制 |
|---|---|---|---|---|---|---|
| 1 | Ctrl+O | file.open | vscode-scheme-shortcuts.spec.js — VS Code Ctrl+O、Ctrl+S、Ctrl+Shift+S、Ctrl+W 真实分派 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 2 | Ctrl+N | file.new | vscode-scheme-shortcuts.spec.js — VS Code 文件、设置、Tab 与 F12 键生效 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 3 | Ctrl+S | file.save | 无充分独立按键行为证据 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | NOT TESTED | 两个按键后共同OR断言，无法分别证明保存/另存为 |
| 4 | Ctrl+Shift+S | file.saveAs | 无充分独立按键行为证据 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | NOT TESTED | 两个按键后共同OR断言，无法分别证明保存/另存为 |
| 5 | Ctrl+W | file.close | vscode-scheme-shortcuts.spec.js — VS Code Ctrl+O、Ctrl+S、Ctrl+Shift+S、Ctrl+W 真实分派 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 6 | Ctrl+P | quickopen.toggle | vscode-scheme-shortcuts.spec.js — VS Code 方案面板与导航键生效 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 7 | Ctrl+Shift+F | search.toggle | vscode-scheme-shortcuts.spec.js — VS Code 方案面板与导航键生效 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 8 | Ctrl+Shift+P | palette.toggle | vscode-scheme-shortcuts.spec.js — VS Code 方案面板与导航键生效 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 9 | Ctrl+Shift+O | outline.toggle | vscode-scheme-shortcuts.spec.js — VS Code 方案面板与导航键生效 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 10 | Ctrl+K Ctrl+S | settings.keybindings | vscode-scheme-shortcuts.spec.js — VS Code Ctrl+K Ctrl+S 打开快捷键设置 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 11 | Ctrl+, | settings.toggle | vscode-scheme-shortcuts.spec.js — VS Code 文件、设置、Tab 与 F12 键生效 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 12 | Ctrl+Tab | tabs.quickSwitch | vscode-scheme-shortcuts.spec.js — VS Code 文件、设置、Tab 与 F12 键生效 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |
| 13 | F12 | editor.focus | vscode-scheme-shortcuts.spec.js — VS Code 文件、设置、Tab 与 F12 键生效 | 无专项行为单测映射；注册/绑定声明不作为行为证据 | PASS | 仅该测试已断言的Windows Chromium行为；非原生系统验收 |

## 七项反馈与最终门禁

统计：{"ultra.eclipse":{"PASS":34,"NOT TESTED":18},"ultra.vscode":{"PASS":11,"NOT TESTED":2}}。Node 425/425；Rust 232通过、0失败、4 ignored；cargo fmt --check退出0。证据目录：`D:/WorkDev/MyShare/GlanceMD-Ultra/docs/qa/integration-2026-09-07`。最终release构建统计见 verified-summary.json 与 verified-size.json。

### 七项反馈核验

| 反馈 | 实际证据 | 结果/边界 |
|---|---|---|
| Light浮层高亮 | popup-regressions前三测试：Ctrl+E、Ctrl+Shift+R、Ctrl+3、Ctrl+Shift+L真实按键，选中项存在且文字/徽章颜色断言 | PASS；Read明暗截图确认可读 |
| 搜索比例/居中/拖动 | popup-regressions Ctrl+H：60vw/80vh、按钮尺寸、60条IPC结果实际scrollTop、mouse拖动和resize、无drag IPC | PASS；窄视口仅几何函数，未真实320px窗口 |
| Vim保持位置/常驻栏 | editor-navigation: 精确保留edit光标；预览中段切入可见编辑器/光标/状态提示；document无纵向溢出 | PASS；预览对应位置仅非开头阈值，不证明任意复杂Markdown逐字精准映射 |
| Ctrl+L逻辑行 | 长中文混合软换行，连续三次31行，选中文字与逻辑行精确，镜像位置在视口 | PASS；可见性测量借助产品mirror API，不是独立像素OCR |
| Ctrl+F选中内联查找 | selected text输入值、absolute定位；Read find明暗截图确认高亮/顶端留白 | PASS |
| K上下查找滚动 | find-input焦点Ctrl+K/Shift+K，远距离两匹配，offset与scrollTop及可见性断言 | PASS；修复冒泡重复派发回绕 |
| F7/F12高亮 | no-preference animation-name；reduce时none动画+solid/2px边框；Read focus-reduced双主题 | PASS；F7指Ctrl+F7，不是裸F7；未测所有面板组合 |

### 失败轨迹与修复

- targeted-initial.log：集成测试追加字符串转义错误，未运行用例，不算产品失败。
- targeted-red.log：8项中6过2失败（find输入CtrlK重复冒泡回绕、预览Vim编辑器隐藏）；修复后targeted-green.log 12/12。
- playwright.json：后来追加精确光标断言时再次字符串转义错误，零测试，已修复。
- playwright-final.json：49/50，reduce-motion的class选择器被#editor outline:none压过；增加ID specificity和fallback色。
- Read vim-light/dark旧截图发现隐藏镜像撑高页面至981px；镜像height限定editor.clientHeight。旧截图保留为失败证据，最终使用vim-fixed-light/dark（800px）。
- playwright-verified.json：最终50/50。初次失败日志均保留，未覆盖成假绿。

### 截图Read核验

基目录 `D:/WorkDev/MyShare/GlanceMD-Ultra/docs/qa/integration-2026-09-07/`，每项light/dark各一张，已逐图Read：
- quick-open-{light,dark}.png：选中项可读，无白底白字。
- command-palette-{light,dark}.png：标题与选中列表可读。
- key-assist-{light,dark}.png：选中标题及快捷键徽章可读。
- search-{light,dark}.png：居中大面板、按钮独立、结果列表可见。
- find-{light,dark}.png：右上内联查找，不覆盖首行，匹配选区可见。
- vim-fixed-{light,dark}.png：常驻NORMAL/:q提示及方块光标可见，底部不再溢出。
- focus-reduced-{light,dark}.png：静态紫色2px焦点边框可见。

### 仍未验收

- 65行中NOT TESTED不等于功能坏，但不能宣称全部快捷键通过；原有另存为累计IPC假阳性、系统剪贴板、未按过的编辑键等保留缺口。
- 原生WebView2运行、真实剪贴板/文件对话框、macOS/Linux真机、四平台CI本轮未执行。
- Rust 4项ignored仍未执行；见rust-verified.log。
- 未启动/终止用户exe，未提交、推送、合并或发布。


## 最终构建与统计

- Node：425 passed，0 failed/skipped；总墙钟11.698秒。
- cargo fmt --check：退出0，3.450秒。
- cargo test：232 passed，0 failed，4 ignored（真实回收站、10k搜索、10k树、真实notify）；总墙钟28.995秒。
- Playwright：50 passed，0 failed/skipped/flaky；59.125秒；2 workers，0 retries。
- cargo build --release：退出0，77.018秒（增量重构建，非clean构建）；Cargo显示1m16s。
- 产物：`D:/WorkDev/MyShare/GlanceMD-Ultra/target/release/GlanceMD-Ultra.exe`，4878830 bytes，4.879 MB / 4.653 MiB；满足5MB限制。GNU开发构建另需同目录WebView2Loader.dll，未运行用户exe。
- 全仓git diff --check尚有4个worker CSS文件EOF多空行；交给主代理收尾，不影响上述测试统计。


## 独立复审补修：内联查找随视图迁移（最新）

- 问题已复现：真实toggle按钮从编辑进入预览后find-bar留在隐藏editor-container；find-toggle-reproduced.log明暗2项均失败。find-toggle-red.log是新测试字符串转义错误，不计产品证据。
- 修复：syncFindContainer将同一个节点迁移到当前可见editor/preview容器；预览使用容器内sticky与流内margin占位，编辑保留padding占位；关闭清理两容器占位及匹配高亮。不是全局浮层。
- 新增实际按钮双主题E2E：编辑CtrlF→预览栏可见、同节点、上下项可用→编辑仍可见→再次预览关闭清高亮→编辑恢复无残留。
- 受影响E2E（app/outline-navigation/vim-visible-ui/editor-navigation-regressions）29 passed，0 failed/skipped/flaky，21.641秒；证据find-toggle-verified.json。
- 相关Node单测52 passed，0 failed/skipped，墙钟1.469秒；find-review-unit.log。
- cargo fmt --check退出0（2.062秒）；git diff --check退出0（0.166秒）；4个CSS EOF空行已去除，撤销上文未收尾提示。
- 最新release增量构建退出0，74.071秒；4879342 bytes（4.879 MB），产物`D:/WorkDev/MyShare/GlanceMD-Ultra/target/release/GlanceMD-Ultra.exe`，mtime 2026-09-07T04:05:57.101Z。find-review-summary.json/find-review-size.json为最新构建证据。
- 已Read find-preview-light.png与find-preview-dark.png：预览中右上查找控件/上下项/关闭可见，正文首行与匹配高亮未被遮挡。
- 按委托本次仅重跑受影响范围，不把先前全量50/425/232统计说成本次全量结果；65键45 PASS/20 NOT TESTED覆盖结论不变。
