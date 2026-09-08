# 设置体系契约（schema v1 / 合并引擎 / 命令与事件）

- 事实源：本模块 `src/workspace/settings.rs`（schema、加载/保存、合并、迁移）+ 本文（命令、事件、路径约定、字段表）。
- 分类依据：产品架构方案 §7.1 的七类 + FEAT-001 新增的全局“窗口与命令行”类：外观与布局、文件类型/隐藏文件/排除规则、文件监听与自动保存、搜索、编辑器与大文件模式、窗口与命令行、快捷键、恢复与启动行为。
- 交付边界：本模块只交付纯逻辑核心；命令粘合层（CommandContext handler、`ipc.rs` wire 映射、事件广播）由主 Agent 集成时统一编写（见 §5/§6）。
- 可测性：模块自包含（仅 `std`/`serde`/`serde_json`，无 `crate::` 引用），探针测试 `tests/settings_probe.rs` 以 `#[path]` 引入，集成后继续有效。

## 1. 文件路径约定

| 作用域 | 路径 | 说明 |
|---|---|---|
| 全局 | `{base_dir}/settings.json` | 生产环境 `base_dir = dirs::config_dir()/glancemd-ultra`，由粘合层注入；模块不感知真实配置目录 |
| 项目 | `{root}/.glancemd/settings.json` | `{root}` 为当前工作区根；目录常量 `PROJECT_SETTINGS_DIR = ".glancemd"`，文件名常量 `SETTINGS_FILE_NAME = "settings.json"` |

- `save(base_dir, &Settings)` 会自动创建 `base_dir`；`save_project(root, &SettingsPatch)` 会自动创建 `.glancemd/`。
- 项目设置是否**自动创建**由全局 `recovery.createProjectSettings` 控制（默认不创建）——粘合层在 `load-project` 命令中按需调用 `save_project`。
- 原子性注记：当前保存为直接 `std::fs::write`（**非原子**）；阶段 6 `atomic_save` 落地后，粘合层应改走"临时文件写入 → 替换目标"，模块签名不变。

## 2. Schema v1 字段全表（八类）

顶层键：`version`（u32，当前恒为 `1`）+ 八个分类键。所有键为 camelCase；未知键**容忍**（解析时收集进 warnings 后忽略，绝不拒绝文档）。

### 2.1 appearance（外观与布局）

| JSON 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `theme` | `"light"` \| `"dark"` \| `"system"` | `"light"` | 主题。默认与基线一致（`setTheme(saved \|\| 'light')`）；`system` 随阶段 5 前端落地生效 |
| `sidebarFontSize` | u32 | `14` | 侧栏（资源管理器 / Outline）基准字号（px）。由前端生效层（`settings-apply.js`）写入 CSS 变量 `--panel-font-size`，各面板字号按 calc 比例换算（树行 ×0.93、面板标题 ×0.79、空态 ×0.86），默认 14px 时视觉 ≈ 基线 13px / 11px / 12px |

### 2.2 files（文件类型、隐藏文件和排除规则）

| JSON 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `visibleExts` | string[] | 文本/结构化扩展名 + `png/jpg/jpeg/gif/svg/webp/bmp/ico/avif` | 项目树可见扩展名（不带点、小写）；图片预览功能使常见图片默认可见，用户仍可自由增删 |
| `showHidden` | bool | `false` | 是否显示隐藏文件 |
| `exclude` | string[] | 同 `watcherExclude` 默认 | 项目树浏览排除规则（目录名/路径段）——阶段 1 |
| `watcherExclude` | string[] | `[".git","node_modules","target",".venv","dist","build",".cache"]` | 监听排除规则——**主计划阶段 2 点名的字面键 `files.watcherExclude`** |

### 2.3 watching（文件监听与自动保存）

| JSON 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `enableWatcher` | bool | `true` | 是否启用文件监听。关闭后：打开项目不启动监听服务；运行中修改该设置自动 pause/resume 当前服务（接线见 `commands.rs::apply_settings_at` / `workspace_open`）。**阶段边界**：启停判断只读全局设置，项目级覆盖不参与启停（项目设置是补丁语义，独立项目级启停留待后续阶段） |
| `autoSave` | `"off"` \| `"afterDelay"` \| `"onFocusLost"` | `"off"` | 自动保存模式（阶段 6 生效） |
| `autoSaveDelayMs` | u64 | `1000` | `afterDelay` 延时（毫秒） |

### 2.4 search（搜索）

| JSON 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `exclude` | string[] | `[".git","node_modules","target",".venv","dist","build",".cache"]` | 搜索排除 glob（阶段 4 `search.exclude` 生效；匹配规则由搜索模块实现，通常按路径段） |
| `maxFileSizeMB` | u64 | `5` | 跳过超过该大小（MB）的文件（阶段 4：">5 MB 或阈值可配置"） |
| `maxResults` | usize | `2000` | 结果数上限 |

### 2.5 editor（编辑器与大文件模式）

| JSON 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `fontSize` | u32 | `14` | 编辑区字号（px）。由前端生效层写入 CSS 变量 `--editor-font-size`（style.css 消费，随 `--zoom` 缩放） |
| `tabSize` | u32 | `4` | Tab 宽度。写入 CSS 变量 `--editor-tab-size`，editor.js 的 Tab 键插入空格数同步读取 |
| `wordWrap` | bool | `true` | 自动换行。切换 `#editor` 的 `wrap` 属性（soft/off，改属性前保存 value 再恢复）与 `.wrap-off` 类（white-space） |
| `lineNumbers` | bool | `true` | 行号显示。`#editor-gutter` 行号槽显隐（阶段 5 落地）：行数 = max(逻辑行数, 视口可容纳行数)，scrollTop 随编辑器同步。**软换行视觉偏差**：`wordWrap=true` 时行号按逻辑行编号，长行软换行折出的视觉行不单独编号，折行处行号出现视觉跳变（已知偏差，接受） |
| `largeFileMB` | u64 | `5` | 大文件模式阈值（阶段 6：禁用实时预览等高耗时功能） |

### 2.6 keybindings（快捷键）

| JSON 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `overrides` | map<命令 ID, 组合键> | `{}` | 用户自定义快捷键覆盖表（占位，阶段 5 快捷键流对接）；序列化用 BTreeMap，键序稳定 |

**组合键占位格式**（存储值，canonical）：修饰键按固定顺序 `Ctrl` → `Alt` → `Shift` → `Meta`，`+` 连接，后接主键（字母大写），如 `"Ctrl+Shift+P"`、`"Ctrl+Alt+S"`。存储始终使用 Windows/Linux 词表；macOS 显示映射（`Ctrl`→`⌘`、`Alt`→`⌥`、`Shift`→`⇧`、`Meta`→`⌃`）由 keybindings 前端流负责。本模块不做冲突检测/录制校验（属阶段 5 快捷键流），仅存取该 map。

### 2.7 recovery（恢复与启动行为）

| JSON 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `confirmCloseDirty` | bool | `true` | 退出/切换项目存在未保存修改时弹确认对话框（阶段 6 生效） |
| `crashRecovery` | bool | `true` | 崩溃恢复开关（阶段 6 生效） |
| `createProjectSettings` | bool | `false` | 打开工作区时是否自动创建 `.glancemd/settings.json`（方案 §7.1"由用户设置决定"） |

### 2.8 window（窗口与命令行，全局限定）

| JSON 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `reuseWindowForFolder` | bool | `false` | Windows 第二实例执行 `GlanceMD-Ultra <dir>` / `glance .` 时：`false`（默认）独立启动新窗口；`true` 将规范化绝对目录转发给主实例并执行 `workspace.open`。该字段**仅允许全局设置**：项目补丁中的 `window` 被忽略并产生 warning；macOS/Linux 当前始终多实例 |

## 3. 合并语义

- `effective(global, project) -> Settings`：**字段级覆盖**——项目补丁中 `Some` 的字段覆盖全局对应字段，`None`/缺省保留全局；**`Vec` 与 map 为整体替换，不做并集**（项目想"在全局基础上追加"必须写出完整列表）；结果 `version` 恒为当前版本。例外：`window` 为全局限定分类，effective 始终取 global。
- `is_overridden(project, key_path) -> bool`：`key_path` 用 JSON 键名，字段级 `"appearance.theme"` / `"files.watcherExclude"`，类级 `"files"`（该类任一字段被覆盖）；未知路径返回 `false`。设置 UI 据此显示"项目已覆盖"徽标。
- 项目文件解析为补丁（`SettingsPatch`）：文件里未出现的类别为 `None`；保存补丁时 `None` 字段不落盘。
- 项目文件版本守卫：`version > 1` 时**整体忽略**项目覆盖并告警（避免半新半旧混合）；缺 `version` 容忍（仅字段补丁，无需迁移）。

## 4. 版本与迁移

- `migrate(raw: &Value) -> Result<Settings, MigrateError>` / `migrate_checked`（附带 warnings）。
- 缺 `version`（或显式 `0`）视为 v0 → 执行 `MIGRATION_STEPS` 中 `(0, …)` 步骤：映射顶层散落 `theme` → `appearance.theme`（非法值忽略并告警）、补 `version=1`。
- `version == 1` 直通；`version > 1` 报 `MigrateError::UnsupportedVersion`（未来版本不降级）。
- 扩展方式：schema 升到 v2 时在 `MIGRATION_STEPS` 追加 `(1, migrate_v1_to_v2)`，加载路径零改动（框架可扩展性由探针测试的 v0 演练步证明）。
- 加载失败语义（损坏/版本过新/非对象）：**回退全默认 + warnings**，绝不阻断启动；项目侧对应"忽略覆盖"。

## 5. 命令表（粘合层由主 Agent 编写，注册到 `commands.rs`）

| 命令 ID | 参数（信封扩展字段） | 行为 | 下行回执 |
|---|---|---|---|
| `workspace.settings.get-global` | 无 | `load_global_checked(base_dir)` | `workspace:settings-global {settings, warnings}` |
| `workspace.settings.get-effective` | 无 | 取全局 + 当前项目补丁 → `effective()`；`overridden` 为被覆盖的 key_path 列表 | `workspace:settings-effective {settings, warnings, overridden: string[]}` |
| `workspace.settings.set-global` | `settings`（完整 Settings JSON，设置 UI 生成） | 反序列化校验 → `save(base_dir, …)` → 广播变更 | 成功广播 `workspace:settings-changed {scope:"global"}`；失败发 `error {message}` |
| `workspace.settings.save-global` | `content`（原始 JSON 文本，"打开设置 JSON"编辑器保存） | 解析 → `migrate_checked` 校验 → 落盘 → 广播；解析/版本错误不落盘 | 同 `set-global`；错误经 `error {message}` 透出 warnings |
| `workspace.settings.load-project` | `path`?（项目根，缺省当前工作区根） | `load_project_checked(root)`；无文件且 `recovery.createProjectSettings=true` 时先 `save_project(root, {"version":1})` | `workspace:settings-project {patch, warnings, path}` |
| `workspace.settings.open-settings-json` | `scope`: `"global"` \| `"project"`（默认 global） | 目标文件不存在则先创建（全局写默认值，项目写 `{"version":1}`），随后按普通文件在编辑器中打开 | `file_opened {content, path}`（复用既有事件） |

- `base_dir` 注入点：粘合层调用 `dirs::config_dir()/glancemd-ultra`（`dirs` crate 已在依赖中）。
- `get-effective` 在无打开工作区时等价于全局（`overridden: []`）。
- 命令回执事件名落地时同步登记进 `docs/dev/interfaces.md` §3（维护规则：先改契约再写代码）。

## 6. 事件

| 事件 | 负载 | 触发时机 |
|---|---|---|
| `workspace:settings-changed` | `{scope: "global" \| "project"}` | 全局/项目设置保存成功后广播；前端收到后重新请求 `get-effective` 并刷新 UI（主题、树过滤、搜索参数等） |

- 该事件在 `docs/dev/interfaces.md` §3.3 已预留（阶段 5），负载以本文为准。
- `warnings` 语义：均为面向用户的中文提示——"已回退默认设置"（全局损坏/版本过新）、"已忽略项目覆盖"（项目损坏/版本过新）、"未知设置键…已忽略"（容忍加载）、迁移提示（v0→v1）。前端以状态栏/设置页横幅短暂展示，非阻断。

## 7. Rust API 速查（集成者）

```text
常量        SCHEMA_VERSION=1, SETTINGS_FILE_NAME="settings.json", PROJECT_SETTINGS_DIR=".glancemd"
路径        global_settings_path(base_dir), project_settings_path(root)
类型        Settings / 各分类（Appearance, Files, Watching, Search, Editor, Keybindings, Recovery）
            SettingsPatch / 各分类补丁（全 Option 镜像）；LoadedSettings{settings,warnings}
            LoadedPatch{patch,warnings}；MigratedSettings{settings,warnings}；MigrateError
加载        load_global(base_dir)->Settings；load_global_checked(base_dir)
            load_project(root)->Option<SettingsPatch>；load_project_checked(root)->Option<LoadedPatch>
保存        save(base_dir,&Settings)；save_project(root,&SettingsPatch)（io::Result，自动建目录，非原子）
合并        effective(&Settings,&SettingsPatch)->Settings；is_overridden(&SettingsPatch,key_path)->bool
迁移        migrate(&Value)->Result<Settings,_>；migrate_checked(&Value)->Result<MigratedSettings,_>
```

- 集成接线：`workspace/mod.rs` 加 `pub mod settings;`；命令 handler 注册与 `ipc.rs` wire 映射由主 Agent 完成（本模块不含 `crate::` 引用，接线后探针测试与 src 内测试并存）。
- 既有散落持久化项（主题 localStorage `glancemd-ultra-theme`、窗口状态）迁入本体系属阶段 5 集成工作，迁移规则届时经 `MIGRATION_STEPS` 登记并补测试。

## 8. v2 视觉与交互设计契约（批准稿）

本节是设置页 v2 的设计契约；它约束实现与验收，不改变 schema v1 的数据契约。

### 8.1 原型与分类边界

- `docs/design/prototypes/settings-sidebar-v2.html` 是视觉与交互基线稿，不是运行时实现，也不是新的 API/schema 来源。实现出现取舍时，先保持本节的可验证规则，再由维护者更新契约。
- 设置分类为八类：外观与布局、文件类型/隐藏文件/排除规则、文件监听与自动保存、搜索、编辑器与大文件模式、窗口与命令行、快捷键、恢复与启动行为。不得任意合并、拆分或改名为 general/advanced 等未批准分类。
- 产品实际设置入口当前由 `#settings-panel` 提供；它是固定头尾、可滚动主体的浮动 modal。当前实现没有独立 `#settings-overlay` DOM 层，测试不得凭空依赖该选择器；若后续接入遮罩层，遮罩只负责阻止背景交互，不改变八类或设置命令接口。

### 8.2 明暗主题与 custom select

- 暗色：控件/菜单使用 `--bg-overlay` 表面、`--border` 边框、`--text` 文字；展开态和当前项使用 `--heading-soft`/`--mk-heading`，不得出现浏览器原生白色弹出层或白边。
- 浅色：同一结构必须使用主题 token 的浅色覆盖（`--bg-overlay`、`--border`、`--text`、`--heading-soft`），保持足够对比度；不得写死暗色背景或通过白色背景“修复”浅色。
- custom select 的视觉规则只适用于后续替换原生 `<select>` 的实现：触发器与菜单均使用 token，菜单 z-index 高于 modal 内容，展开时 `aria-expanded=true`；选中项显示紫色强调与勾选标记，点击选项仍派发原生 `change` 语义。当前产品设置实现仍使用原生 `<select>`，因此本轮测试只验证可迁移的 token/语义，不伪造 custom-select API。

### 8.3 密度公式与边界

侧栏字号 `S` 为整数 px，允许范围 `12 ≤ S ≤ 18`，默认 `S=14`。原型当前采用并须保持一致的派生公式（四舍五入）：

- `tree-font-size = S`
- `tree-icon-size = round(S × 1.14)`
- `tree-caret-size = round(S × 0.85)`
- `tree-row-height = round(S × 2.14)`
- `tree-gap = round(S × 0.57)`
- `tree-indent = round(S × 1.14)`

非法或缺失值回退 14；边界值不得被 clamp 到范围外。设置 schema 中对应持久化字段仍为 `appearance.sidebarFontSize`，不新增 `sidebarDensity` 键。

### 8.4 动态宽度与 420px 约束

- 项目树默认宽度 264px，允许 180–640px；Outline 默认 230px，允许 170–480px。宽度可拖拽并持久化，双击分隔条恢复默认。
- 最大宽度必须同时受可用工作区比例与编辑器最小可用宽度约束：保留编辑器至少 420px；多栏布局不能通过拖宽使编辑器小于 420px。窗口变窄时优先压缩/折叠侧栏，不能让设置 modal 或编辑器溢出视口。
- 设置 modal 宽度为动态值：`min(860px, calc(100vw - 32px))`；高度不得超过视口可用高度，窄窗口下仍须能关闭并滚动主体。420px 是编辑器/工作区可用宽度下限，不是设置 modal 的固定宽度。

### 8.5 本轮验证现状（2026-09-06）

- 已有 Node 单测覆盖：设置面板创建、八类分类、分类切换、中文/键名搜索与跨分类聚合、项目覆盖徽标、值类型控件、主题即时持久化、窗口复用策略、CLI shim 状态/操作、关闭/Escape、快捷键录制与冲突。
- 已扩充的 Playwright 专项覆盖：设置入口与 modal 可见性、八类真实分类、搜索真实分类结果、关闭/Escape、基础 light/dark 主题往返，以及设置打开前后的关键布局可用宽度检查。
- 当前实现/测试基线仍未提供独立 overlay 或 custom-select DOM；相关 v2 目标已在本契约声明，待主 Agent 接入时再增加对应行为断言。明暗视觉截图仍属于人工/浏览器专项，不由 Node 单测宣称完成。

## 9. 变更记录

- 2026-09-06：补充设置 v2 批准设计契约：原型作为视觉基线、七类不可变、custom select 明暗 token 规则、密度公式、动态宽度与编辑器 420px 下限，并记录当前测试与未接入项。


- 2026-09-04（阶段 5 / Wave 2a 设置流 R4）：初版。schema v1 七类字段表、加载/保存与告警通道、字段级合并与 is_overridden、迁移框架（v0→v1 演练步）、命令/事件/路径契约。
- 2026-09-04（编辑器设置接线 + 行号 + 监听开关 + 侧栏字号）：
  - schema 新增 `watching.enableWatcher`（默认 true）与 `appearance.sidebarFontSize`（默认 14），补丁镜像 / 合并 / is_overridden / 已知键表同步；
  - 监听开关接线：`workspace.settings.set-global` 落盘成功后对比保存前后 `enableWatcher`，关→`watcher_pause`、开→`watcher_resume`；`workspace.open` 启动监听前按全局 effective 开关决定是否启动（项目覆盖不参与，见 §2.3 阶段边界）；
  - 前端生效层 `settings-apply.js`（window.SettingsApply，装载于 recovery.js 之后）：订阅 `workspace:settings-effective`，把 editor.fontSize/tabSize/wordWrap/lineNumbers 与 appearance.sidebarFontSize 落到 CSS 变量 / textarea / `#editor-gutter` 行号槽；`get()` 供其他模块同步读取（editor.js Tab 空格数）；`get-effective` 命令在装载时自动发一次，开机即生效。
