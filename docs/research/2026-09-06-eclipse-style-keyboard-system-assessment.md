# GlanceMD Ultra：Eclipse 式强快捷键系统评估

日期：2026-09-06

## 结论

v0.1.0 当前只有**基础快捷键/有限自定义**：支持现有单段快捷键的录制、冲突提示、清除、恢复默认和持久化。v0.1.0 **不含 chord、context、多键位方案（multi-scheme）、Key Assist 或 Vim**。本评估描述的是后续强快捷键系统，**全部尚未实施**，不代表计划已完成。

用户最终确认的后续方向是：

- 采用 Eclipse 式 Command、Handler、Context、Scheme、Chord、Key Assist、动态 enablement 架构；首装默认启用 Eclipse scheme，并提供完整 VS Code scheme；
- 所有公开命令都必须有默认键；
- Eclipse 键位：`Ctrl+O` Quick Outline、`Ctrl+Shift+S` Save All、`Ctrl+E` Quick Switch、`Ctrl+H` Search、`Ctrl+3` Find Actions；
- Ultra 扩展：`Alt+Shift+F O` 打开文件、`Alt+Shift+F P` 打开项目、`Alt+Shift+S` 另存为、`Alt+Shift+P` 打开设置；设置内 `Alt+Shift+P K` 进入快捷键页；`Alt+Shift+E V` 切换 Vim；
- Vim 属于编辑器层，首版提供常用完整集；
- 完整测试门禁预计 **398–588 项**。

这是一项独立子系统重构，不适合继续在当前 `keybindings.js` 上叠补丁。上述强快捷键系统、两个 scheme、所有默认绑定、chord/context、Key Assist、Vim 及 398–588 项测试门禁目前全部未实现。

## 改造规模

| 项目 | 完整实现估算 |
|---|---:|
| 最终公开命令 | 45–60 个（所有公开命令均需默认键） |
| 新增公开命令 | 25–38 个 |
| 新增前端核心模块 | 7–10 个 |
| 修改生产模块 | 15–22 个 |
| 新增/修改测试文件 | 14–22 个 |
| 总触达文件 | 30–45 个 |
| 生产代码新增/重写 | 3,800–6,000 LOC |
| 测试、CSS、i18n、文档 | 3,000–4,500 LOC |
| 新增回归用例 | 76–117 个 |
| 熟悉仓库的单开发者工期 | 24–36 工作日，基准约 29 日 |

可分批交付的 MVP（命令化、单键、基础 context、持久化、设置编辑、平台映射，不含完整 chord assist）约 13–19 工作日，但“完全键盘操作”仍需要后续焦点、ARIA、chord 和 Key Assist 阶段。

## Eclipse 架构映射

当前模型：

```text
commandId → 单个快捷键字符串 → Commands.run()
```

目标模型：

```text
Key Sequence
  → Active Scheme
  → Platform / Locale
  → Active Context hierarchy
  → Command
  → Active Handler
  → Handler Enablement
  → Execute
```

需要的核心服务：

1. Command registry：本地化名称、分类、描述、参数、可发现性。
2. Handler service：同一命令允许不同区域提供不同实现，并区分 active/enabled。
3. Context service：编辑器、项目树、Outline、搜索、设置、恢复、dialog 等父子上下文。
4. Binding service：单键、多段 chord、多绑定、平台映射、用户覆盖、unbind、冲突解析。
5. Scheme service：`Ultra Eclipse`、未来 `VS Code`/`Emacs` 等键位方案。
6. Key Assist：`Ctrl+Shift+L` 显示当前上下文真正有效的命令。
7. Focus/overlay service：统一 Escape、焦点保存/恢复、modal 隔离、part 循环。

推荐 context 主干：

```text
window
├── editorArea
│   └── textEditor
│       └── markdownEditor
├── projectTree
├── outline
├── preview
├── search
├── quickOpen
├── commandPalette
├── settings
│   └── keybindingRecorder
└── recovery

dialog
├── confirmDialog
├── nativeFileDialogProxy
└── conflictDialog
```

## 历史架构参考键表（已被用户最终方向取代）

以下详细键表保留用于说明 Eclipse 架构映射，但其中的逐键建议不再是最终规格；实施时必须以本文“结论”中的用户最终确认键位、Eclipse scheme 和完整 VS Code scheme 为准。

### 全局、焦点和发现（历史草案）

| 功能 | 推荐键 | Eclipse 依据/说明 |
|---|---:|---|
| 命令面板 / Find Actions | `Ctrl+3` | Eclipse Quick Access；`Ctrl+Shift+P` 可作为兼容副键 |
| Key Assist / 当前可用快捷键 | `Ctrl+Shift+L` | Eclipse 原键；再次执行进入快捷键设置 |
| 设置 | `Ctrl+,` | Eclipse 无稳定跨平台默认；采用现代编辑器低冲突键 |
| 聚焦编辑器 | `F12` | Eclipse Activate Editor |
| 下一个/上一个编辑器 | `Ctrl+F6` / `Ctrl+Shift+F6` | Eclipse Editor cycling，建议 MRU |
| 下一个/上一个 View | `Ctrl+F7` / `Ctrl+Shift+F7` | Eclipse View cycling，覆盖树、Outline、搜索、恢复 |
| 快速切换已打开标签 | `Ctrl+E` | Eclipse Quick Switch Editor |
| 最大化/恢复当前区域 | `Ctrl+M` | Eclipse Maximize Active Part |
| 上下文菜单 | `Shift+F10` | 标准键盘菜单 |
| 当前 View 菜单 | `Ctrl+F10` | Eclipse View Menu |
| 关闭最上层临时界面 | `Escape` | 严格按 overlay 栈只关闭一层 |

### 文件、Workspace、标签

| 功能 | 推荐键 | Context/说明 |
|---|---:|---|
| 新建无标题文档 | `Ctrl+N` | window；树聚焦时复用为项目内新建文件 |
| 打开文件 | `Ctrl+O` | 保留桌面编辑器惯例；不逐字照抄 Eclipse Quick Outline |
| 打开项目文件夹 | `Ctrl+K Ctrl+O` | Ultra 专用 chord；避免 AltGr 风险 |
| 保存 | `Ctrl+S` | editor，dirty 时 enabled |
| 另存为 | `Ctrl+Shift+S` | 保留 Ultra/通用语义；不强行改成 Eclipse Save All |
| 保存全部 | `Ctrl+K S` | 存在 dirty tabs 时 enabled |
| 关闭当前标签 | `Ctrl+W`、`Ctrl+F4` | Eclipse 两种惯例；同一命令多绑定 |
| 关闭全部标签 | `Ctrl+Shift+W` | editor area |
| 恢复关闭标签 | `Ctrl+Shift+T` | 与浏览器/现代编辑器语义一致 |
| 下一个/上一个相邻标签 | `Ctrl+PageDown` / `Ctrl+PageUp` | 与 MRU 的 F6 循环区分 |
| 关闭项目 | `Ctrl+K F4` | workspace open；需 dirty 确认 |

### 项目树

| 功能 | 推荐键 | Context/说明 |
|---|---:|---|
| 聚焦项目树 | `Ctrl+Shift+E` | 快速直达；也可用 `Ctrl+F7` 循环 |
| 上下选择 | `Up` / `Down` | tree focus |
| 首项/末项 | `Home` / `End` | tree focus |
| 翻页 | `PageUp` / `PageDown` | tree focus |
| 展开/进入子级 | `Right` | tree focus |
| 折叠/返回父级 | `Left` | tree focus |
| 打开文件/切换目录 | `Enter` | 根据选择类型由 handler 决定 |
| 新建文件 | `Ctrl+N` | tree focus；覆盖 window 的新建文档 |
| 新建文件夹 | `Ctrl+Shift+N` | tree focus |
| 重命名 | `F2` | 单选且非根目录 |
| 剪切/复制/粘贴 | `Ctrl+X/C/V` | tree focus，按上下文复用 |
| 删除到回收站 | `Delete` | tree selection |
| 永久删除 | `Shift+Delete` | 二次确认 |
| 撤销文件操作 | `Ctrl+Z` | tree focus；编辑器中同键仍是文本撤销 |
| 刷新项目树 | `F5` | tree focus |
| 定位当前文件 | `Alt+Shift+W` | 借鉴 Eclipse Show In |
| 在系统文件管理器显示 | `Ctrl+K R` | tree selection |
| 在所选目录打开终端 | `Ctrl+\`` | tree selection；设置已迁到 `Ctrl+,` |
| 折叠全部目录 | `Ctrl+Shift+Left` | 比 Eclipse 数字键盘 `/` 更适合笔记本 |
| 上下文菜单 | `Shift+F10` / Menu 键 | tree selection |

### 编辑器

| 功能 | 推荐键 | Context/说明 |
|---|---:|---|
| 撤销/重做 | `Ctrl+Z` / `Ctrl+Y` | text editor |
| 剪切/复制/粘贴/全选 | `Ctrl+X/C/V/A` | text editor |
| 当前文件查找 | `Ctrl+F` | editor/preview |
| 下一个/上一个匹配 | `F3` / `Shift+F3` | 避免占用 chord leader `Ctrl+K` |
| 跳转行 | `Ctrl+L` | text editor |
| 删除当前行 | `Ctrl+D` | Eclipse 借鉴 |
| 复制当前行/选区 | `Ctrl+Shift+D` | 编辑器常见 |
| 上移/下移行 | `Alt+Up` / `Alt+Down` | Linux 需平台验证 |
| 缩进/减少缩进 | `Tab` / `Shift+Tab` | editor focus；Tab 不用于离开编辑器 |
| 加粗/斜体 | `Ctrl+B` / `Ctrl+I` | Markdown command |
| 插入链接 | `Ctrl+K L` | chord，避免裸 `Ctrl+K` |
| 行内代码 | `Ctrl+Shift+C` | Markdown command |
| 标题升级/降级 | `Ctrl+Shift+]` / `Ctrl+Shift+[` | Markdown command |
| 切换自动换行 | `Ctrl+K Z` | editor focus |

### Preview 与 Outline

| 功能 | 推荐键 | Context/说明 |
|---|---:|---|
| 切换编辑/预览 | `Ctrl+Shift+V` | 释放 `Ctrl+E` 给 Eclipse 标签切换器 |
| 编辑/预览分屏 | `Ctrl+\` | 保留当前键 |
| 聚焦预览 | `Ctrl+K V` | preview visible |
| Outline 显示/隐藏 | `Ctrl+Shift+O` | 保留 Ultra 现有行为 |
| 聚焦 Outline | `Ctrl+K O` | outline visible |
| Outline 上下选择 | `Up` / `Down` | outline focus |
| 首项/末项 | `Home` / `End` | outline focus |
| 跳到标题并返回编辑器 | `Enter` | 同步定位编辑器与 Preview |
| 跳转但保留 Outline 焦点 | `Ctrl+Enter` | outline focus |
| 刷新 Outline | `F5` | outline focus |
| 返回编辑器 | `F12` | Eclipse Activate Editor |

说明：若要 **逐字采用 Eclipse 默认键**，`Ctrl+O` 应成为 Quick Outline，打开文件改为命令面板或其他键。但这会破坏几乎所有桌面编辑器用户对 `Ctrl+O` 的预期。推荐采用 Eclipse 架构和导航体系，同时保留 `Ctrl+O` 打开文件、`Ctrl+Shift+O` 控制 Outline。

### 搜索、Quick Open、命令面板

| 功能 | 推荐键 | Context/说明 |
|---|---:|---|
| 工作区全文搜索 | `Ctrl+H` | Eclipse Search；兼容键可保留 `Ctrl+Shift+F` |
| Quick Open 项目文件 | `Ctrl+Shift+R` | Eclipse Open Resource；`Ctrl+P` 可作为兼容 scheme |
| 命令面板 | `Ctrl+3` | Eclipse Find Actions；兼容 `Ctrl+Shift+P` |
| 结果上下选择 | `Up` / `Down` | corresponding overlay/list focus |
| 打开结果 | `Enter` | result selected |
| 打开并保留列表焦点 | `Ctrl+Enter` | optional |
| 取消运行中搜索 | `Escape` | 第一次取消，第二次关闭面板 |
| 大小写/整词/正则 | `Alt+C/W/R` | search panel context only |

### 设置与快捷键编辑器

| 功能 | 推荐键 | Context/说明 |
|---|---:|---|
| 打开设置 | `Ctrl+,` | window |
| 打开快捷键设置 | `Ctrl+Shift+L` | 第一次 Key Assist，再次进入设置亦可 |
| 直接打开快捷键设置 | `Ctrl+K Ctrl+S` | window chord |
| 设置搜索 | `Ctrl+F` | settings context |
| 分类上下选择 | `Up` / `Down` | category list focus |
| 打开分类 | `Enter` | category selected |
| 添加/修改绑定 | `Enter` / `F2` | keybinding row focus |
| 清除绑定 | `Delete` | 与恢复默认不同，生成 unbind |
| 恢复命令默认 | `Backspace` | user override exists |
| 取消录制 | `Escape` | recorder context，必须吞掉事件 |
| Key Assist 执行命令 | `Enter` | enabled command selected |

### Recovery 与冲突

仅在对应横幅或恢复面板获得焦点时激活：

| 功能 | 推荐键 |
|---|---:|
| 冲突：重新加载磁盘版本 | `Alt+R` |
| 冲突：保留编辑版本 | `Alt+K` |
| 冲突：另存为 | `Alt+A` |
| 冲突：关闭标签 | `Alt+C` |
| 暂时关闭横幅 | `Escape` |
| 恢复面板上下选择 | `Up` / `Down` |
| 恢复选中条目 | `Enter` |
| 丢弃选中条目 | `Delete` |
| 复制恢复内容 | `Ctrl+C` |
| 以 dirty tab 打开恢复内容 | `Ctrl+Enter` |
| 暂不处理 | `Escape` |

### Dialog 通用键盘契约

| 键 | 行为 |
|---|---|
| `Tab` / `Shift+Tab` | 对话框内正向/反向循环 |
| `Enter` | 激活默认按钮，多行文本框除外 |
| `Escape` | 取消/关闭，不能穿透到底层界面 |
| `Space` | 激活当前按钮、checkbox、link |
| `Arrow` | tabs、radio、menu、list 内移动 |
| `Home` / `End` | 列表首尾 |
| `Shift+F10` | 当前项上下文菜单 |

## 完全键盘验收场景

验收不能只测试 `keydown`，必须从冷启动开始全程不碰鼠标：

1. 打开项目文件夹。
2. 聚焦项目树、展开目录、打开文件。
3. 新建、重命名、删除、撤销文件操作。
4. 编辑 Markdown、查找、保存、另存为。
5. 打开 Preview、Outline，选择标题并返回编辑器。
6. Quick Open 文件、全文搜索并打开结果。
7. 切换标签、关闭 dirty 标签并处理确认。
8. 打开设置、切换语言、进入快捷键页、录制 chord、解除绑定和恢复默认。
9. 通过 Key Assist 查看当前上下文可用命令。
10. 处理外部修改冲突和崩溃恢复。
11. 从树、Outline、搜索、恢复区用 `Ctrl+F7` 循环，从任何 View 用 `F12` 回编辑器。
12. 任意 dialog/overlay 关闭后焦点返回原区域。
13. IME composition 期间不触发命令。
14. Windows、macOS、Linux 分别验证平台截获和显示格式。

## 推荐实施阶段

1. 规格冻结和基线测试。
2. 完整命令化现有用户动作。
3. Context/Handler/enablement。
4. Binding service、chord、平台映射和单一 dispatcher。
5. Rust schema v2、localStorage 迁移和原子保存。
6. 快捷键设置编辑器：多绑定、unbind、冲突、scheme、when。
7. Key Assist、焦点、ARIA、键盘化列表/tab/Outline/欢迎页。
8. 全程无鼠标 E2E 和三平台验证。

## 官方资料

- Eclipse Workbench Key Bindings: https://help.eclipse.org/latest/topic/org.eclipse.platform.doc.isv/guide/wrkAdv_keyBindings.htm
- Commands: https://help.eclipse.org/latest/topic/org.eclipse.platform.doc.isv/guide/workbench_cmd_commands.htm
- Handlers: https://help.eclipse.org/latest/topic/org.eclipse.platform.doc.isv/guide/workbench_cmd_handlers.htm
- Contexts: https://help.eclipse.org/latest/topic/org.eclipse.platform.doc.isv/guide/workbench_advext_contexts.htm
- Contexts and Key Bindings: https://help.eclipse.org/latest/topic/org.eclipse.platform.doc.isv/guide/wrkAdv_keyBindings_contexts.htm
- Schemes: https://help.eclipse.org/latest/topic/org.eclipse.platform.doc.isv/guide/wrkAdv_keyBindings_accelConfig.htm
- Keys and Conflict Resolution: https://help.eclipse.org/latest/topic/org.eclipse.platform.doc.user/concepts/concepts-keys.htm
- Keys Preferences: https://help.eclipse.org/latest/topic/org.eclipse.platform.doc.user/concepts/accessibility/keyboardshortcuts.htm
- Keyboard Navigation: https://help.eclipse.org/latest/topic/org.eclipse.platform.doc.user/concepts/accessibility/navigation.htm
- IBindingService: https://help.eclipse.org/latest/topic/org.eclipse.platform.doc.isv/reference/api/org/eclipse/ui/keys/IBindingService.html
- Eclipse Platform UI: https://github.com/eclipse-platform/eclipse.platform.ui
