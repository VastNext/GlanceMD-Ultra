# GlanceMD Ultra 接口契约（唯一事实源）

- 作用：前后端模块只通过本文档定义的契约交互；并行开发的 Rust 模块流与前端面板流一律以本文为准，禁止口头约定。
- 维护规则：**契约变更必须先改本文再写代码**；新命令 / 新事件 / 新 JS 命名空间落地时在同一提交内更新对应表格。
- 标注约定：无标注 = 阶段 0 已实现并有测试覆盖；**[计划中]** = 后续阶段将引入，名称已预留但负载字段未定稿，实现阶段在此表定稿，其他模块不得提前依赖其具体负载。
- 依据：主实施计划 §1（目标架构）与产品架构方案（`reports/2026-08-29-目录项目管理功能影响评估-096d/`）。

## 1. IPC 传输与信封

### 1.1 上行（JS → Rust）

- 通道：`window.ipc.postMessage(JSON.stringify(msg))`
- 解析入口：`src/ipc.rs::handle_ipc_message`（`IpcMessage` 反序列化）
- 信封字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `command` | string | 是 | wire 命令名（见 §2 命令表） |
| `content` | string | 否 | 文件内容（save_file / save_as 用） |
| `path` | string | 否 | 文件或目录路径（open_file / workspace.open / read_image / save_file 用） |
| `title` | string | 否 | 标题（set_title / stdin 场景用） |
| `dirty` | bool | 否 | 脏状态（set_dirty_state 用） |

- 上行便捷封装：前端各模块自行构造信封即可（`app.js::sendToRust` 与 `commands.js` 内部实现等价：`JSON.stringify(Object.assign({command}, data))`）。

### 1.2 下行（Rust → JS）

- 通道：`webview.evaluate_script` 调用 `window.__fromRust(event, data)`（实现见 `src/ipc.rs::send_to_js`，两参数均为 JSON 序列化值）。
- `__fromRust` 的装载顺序（阶段 0 起）：
  1. `app.js` 定义既有 handler（file_opened / file_saved / stdin_opened / error / navigation_blocked）；
  2. `workspace.js` **保存既有 handler 后重写** `__fromRust`：`workspace:*` 前缀事件走 `window.Workspace` 内部分发器，其余事件透传既有 handler；`__fromRust` 不存在时兜底自建。
  3. 后续新增下行事件优先走 `workspace:*` 命名空间（自动获得分发），非 workspace 语义的新事件需同时改 `app.js` 的 switch——应尽量避免。
- 线程边界：所有 `evaluate_script` 只允许在主线程事件循环内发生；后台线程通过 `workspace::events::emit` 把事件递交主线程（见 §5）。

## 2. 上行命令表（wire 命令 ↔ 注册表 ID）

- Rust 命令注册表：`src/commands.rs`，全局唯一实例；handler 签名 `fn(&CommandContext, &CommandPayload)`。
- 映射方式：`ipc.rs::registry_command_id` 把 wire 命令名翻译为注册表 ID 后经 `commands::dispatch` 分发；未登记映射的 wire 命令继续走 `ipc.rs` 的既有 match 分支（后续阶段逐步迁移，迁移一条登记一条）。

### 2.1 已迁移到注册表（阶段 0）

| wire 命令 | 注册表 ID | 参数 | 行为（Rust 侧） | 备注 |
|---|---|---|---|---|
| `open_file` | `file.open` | `path?` | 有 `path`：读文件，成功发 `file_opened` 并前置窗口，失败发 `error`；无 `path`：弹出系统打开文件对话框 | 自 `ipc.rs` 原分支逐行迁移，行为与迁移前一致 |
| `file.reload` | `file.reload` | `path` | 重读 clean tab 的最新文本内容，成功发 `file_reloaded`；文件已删除/瞬时不可读时静默忽略（由 watcher removed 事件处理） | BUG-001；仅文本文件 |
| `workspace.open` | `workspace.open` | `path?` | 有 path 时打开指定目录；无 path 时弹出原生目录选择器；`Workspace::open_root` 校验 + canonicalize，发 `workspace:opened`，后台线程扫描并周期发 `workspace:scan-progress`；校验失败发 `workspace:error` | 阶段 0/目录入口已实现 |
| `cli.install-shim` | `cli.install-shim` | 无 | 安装 `gmdu` 唯一官方入口（带所有权标记）：Windows 在 `current_exe` 所在目录的 `bin/` 创建**相对引用** exe 的 `gmdu.cmd`，并把该 `bin` 加入用户级 PATH 后广播环境变更（需新终端生效）；macOS/Linux 在 `~/.local/bin` 创建指向 exe 的 `gmdu` symlink（提示 `~/.local/bin` 需在 PATH）。拒绝覆盖非本程序文件，原子写入且失败回滚；成功后仅清理本程序旧版 `glance.cmd`/`glancemd.cmd` | FEAT-001 最终方案；设置页与 `--install-cli` 命令行共用同一实现，命令行跨平台、必须可用 |
| `cli.remove-shim` | `cli.remove-shim` | 无 | 仅移除带 GlanceMD Ultra 所有权标记的 `gmdu` 入口（Windows：`bin/gmdu.cmd` 及其用户级 PATH 条目；macOS/Linux：`~/.local/bin/gmdu`）；第三方同名文件绝不删除 | FEAT-001 |
| `cli.shim-status` | `cli.shim-status` | 无 | 查询 `gmdu` 入口所有权/安装状态并发 `workspace:cli-shim-status` | FEAT-001 |

### 2.2 未迁移（仍由 `ipc.rs` match 直连，阶段 0 现状）

`focus_window`、`save_file`、`save_as`、`set_title`、`set_dirty_state`、`window_minimize`、`window_maximize`、`window_close`、`read_image`、`drag_enter`、`drag_leave`、`ready`。

- `ready` 保留特殊性：前端装载完成信号，Rust 收到后才 flush 暂存消息（pending_files / stdin / 暂存的项目根）。
- 迁移计划：阶段 1 起按"改一条、测一条、登记一条"的节奏迁入注册表；迁移后行为必须与迁移前一致（以 Playwright 冒烟守护）。

### 2.3 注册表语义（错误约定）

- 未知命令 ID：`CommandError::Unknown(id)`；
- 同一 ID 重复注册：`CommandError::AlreadyRegistered(id)`；
- 内置命令经 `commands::register_builtin()` 幂等引导（重复调用安全）；
- 新命令接入三步：`commands.rs` 写 handler + 在 `register_builtin()` 注册 → `ipc.rs::registry_command_id` 加 wire 映射（若经 IPC 触发）→ 本文 §2 表登记。

### 2.4 CLI 命令行参数（最终方案，跨平台）

`gmdu` 是唯一官方短命令；除目录参数（`gmdu .`）外，还支持以下子命令。**命令行入口必须跨平台可用**（Windows / macOS / Linux），设置页只是便捷入口，非 Windows 是否在设置页显示安装入口取决于实现，但命令行语义一致：

| 参数 | 语义 | 备注 |
|---|---|---|
| `--install-cli` | 安装 `gmdu` 入口后退出 | 与 `cli.install-shim` 同一实现 |
| `--uninstall-cli` | 移除 `gmdu` 入口后退出（仅删除本程序所有权入口） | 与 `cli.remove-shim` 同一实现 |
| `--cli-status` | 打印 `gmdu` 入口安装状态后退出 | 与 `cli.shim-status` 同一实现 |
| `--version` | 打印版本号后退出 | Release workflow 用其跨平台验证产物 |

- 安装位置契约：Windows 在 `current_exe` 所在目录的 `bin/` 创建**相对引用** exe 的 `gmdu.cmd` 并把该 `bin` 加入用户级 PATH（广播环境变更，**必须开新终端**生效）；macOS/Linux 在 `~/.local/bin` 创建指向 exe 的 `gmdu` symlink（提示 `~/.local/bin` 需在 PATH）。
- Release 仍是**单个真实二进制**：`gmdu.cmd` / symlink 只是 shim/快捷入口，**不复制 exe**，体积无本质增加。

## 3. 下行事件名全集

### 3.1 既有单文件事件（阶段 0 前已有）

| 事件 | 负载 | 说明 |
|---|---|---|
| `file_opened` | `{content, path}` | 打开文件成功（tab 创建由前端完成） |
| `file_saved` | `{path}` | 保存成功 |
| `file_reloaded` | `{content, path}` | watcher 检测外部修改后，clean tab 静默热重载的最新文本内容 |
| `stdin_opened` | `{content, title}` | stdin 内容作为只读 tab 打开 |
| `error` | `{message}` | 通用错误提示（前端状态栏短暂显示） |
| `navigation_blocked` | `{url}` | 预览内导航被拦截（前端显示回退提示） |

另：`read_image` 走直接脚本调用 `window.__setImage(path, url)`（非事件，保留现状）。

### 3.2 Workspace 事件（阶段 0 已实现，`src/workspace/events.rs`）

| 事件 | 负载 | 触发时机 |
|---|---|---|
| `workspace:opened` | `{root, file_count}` | `workspace.open` 校验通过后立即广播；`root` 为剥离 `\\?\` 前缀的规范化绝对路径；`file_count` 打开瞬间为 0，最终数量以 `scan-progress` 为准 |
| `workspace:scan-progress` | `{scanned}` | 后台扫描每收集 200 个文件广播一次；扫描结束时广播最终总数 |
| `workspace:error` | `{message}` | 根目录不存在 / 不是目录 / 扫描线程启动失败等（message 为面向用户的中文） |

前端消费约定：`workspace.js` 内置上述三类处理（状态栏 `#status-workspace` 显示"项目：{root}（N 个文件）"，错误短暂标红）；其他模块经 `window.Workspace.on(event, handler)` 订阅，不得重写 `__fromRust`。

### 3.3 计划中的事件（名称预留，负载未定稿）

| 事件 | 计划阶段 | 说明 |
|---|---|---|
| `workspace:closed` | 阶段 1 | 关闭当前工作区 |
| `workspace:file-created` | 阶段 2（watcher） | 根内新文件出现 |
| `workspace:file-changed` | 阶段 2（watcher） | 根内文件内容变化（自动重载/冲突检测输入） |
| `workspace:file-renamed` | 阶段 2/3 | 文件重命名 |
| `workspace:file-moved` | 阶段 2/3 | 文件移动 |
| `workspace:file-deleted` | 阶段 2/3 | 文件删除（含外部删除） |
| `workspace:active-file-changed` | 阶段 1 | 活动文件切换（树定位当前文件用；可能由前端本地分发，落地时定稿） |
| `workspace:watcher-error` | 阶段 2 | 文件监听异常与 UI 提示 |
| `workspace:search-result` | 阶段 4 | 后台全文搜索增量结果 |
| `workspace:search-completed` | 阶段 4 | 搜索完成 |
| `workspace:search-cancelled` | 阶段 4 | 搜索取消确认 |
| `workspace:fs-op-done` | 阶段 3 | 文件操作（新建/重命名/删除/回收站）完成回执，含操作 ID 供撤销链对账 |
| `workspace:settings-changed` | 阶段 5 | 设置变更广播（全局与项目覆盖生效通知） |
| `workspace:cli-shim-status` | FEAT-001 | `{installed, dir, message}`；`gmdu` 入口安装/移除/状态查询回执，`installed` 仅在本程序所有权标记的入口就位时为 true；`dir` 为入口所在目录（Windows：`<current_exe 目录>/bin`；macOS/Linux：`~/.local/bin`） |

## 4. 前端 JS 模块命名空间规范

### 4.1 规则

1. 每个 `src/frontend/*.js` 是一个 IIFE，对外能力**只**挂载到一个 `window.<Namespace>` 上；不新增全局散变量。
2. 模块间通信只用两条路：`window` 命名空间（显式 API）与 DOM（事件/查询）；**禁止互相 require、不引入构建链与 npm 依赖**。
3. 下行事件订阅一律经 `window.Workspace.on`（或既有 `__fromRust` 透传语义），禁止私拆 `__fromRust`。
4. 触发动作优先引用命令 ID（`window.Commands.run(id)`），禁止绕过注册表直接内联 ipc 调用（§2）。
5. 测试：每个新模块配 `src/frontend/<module>.test.js`（node:test + vm，零依赖，照 `preview.test.js` 的 mock 风格）；注意 vm 沙箱对象与宿主 realm 原型不同，`deepStrictEqual` 需逐字段断言或展开转换。

### 4.2 命名空间登记表

| 命名空间 | 文件 | 状态 | 对外 API（阶段 0 已实现的列为实际签名） |
|---|---|---|---|
| `window.Commands` | `src/frontend/commands.js` | 已实现 | `register(id, {label, run})`（重复注册抛错）、`unregister(id)`、`has(id)`、`get(id)`、`ids()`、`run(id, arg?)`（未知命令抛错） |
| `window.Workspace` | `src/frontend/workspace.js` | 已实现 | `on(event, handler)`（返回退订函数）、`off(event, handler)`、`dispatch(event, data)`、`getState()` → `{root, fileCount, error}` |
| `window.ProjectTree` | `src/frontend/project-tree.js` | [计划中] 阶段 1 | 项目树渲染与选择 |
| `window.SearchPanel` | `src/frontend/search-panel.js` | [计划中] 阶段 4 | 搜索面板 UI |
| `window.QuickOpen` | `src/frontend/quick-open.js` | [计划中] 阶段 1/4 | Ctrl+P 快速打开 |
| `window.SettingsUI` | `src/frontend/settings.js` | [计划中] 阶段 5 | 设置页 |
| `window.Keybindings` | `src/frontend/keybindings.js` | [计划中] 阶段 5 | 快捷键录制与解析（命令 ID 触发经 `Commands.run`） |
| `window.CommandPalette` | `src/frontend/command-palette.js` | [计划中] 阶段 5 | Ctrl+Shift+P 命令面板（枚举 `Commands.ids()`） |
| `window.RecoveryUI` | `src/frontend/recovery.js` | [计划中] 阶段 6 | 崩溃恢复 / 冲突横幅 |

既有模块维持现状：`window.TabManager`（tabs.js，IIFE）；`app.js` / `editor.js` / `preview.js` 为既有全局脚本，仅在做既有功能改动时顺带迁移，不强制重写。

### 4.3 DOM 契约补充

- 状态栏：`#statusbar` 内既有 `#status-mode / #status-file / #status-counts / #status-info`；workspace 信息使用**运行时创建**的 `#status-workspace`（workspace.js 惰性创建），与 `#status-info`（Saved/Error 短暂占用并自动清空）互不覆盖。
- 打开入口：`#btn-open` 为 Open Folder，点击由 commands.js 以**克隆替换节点**方式接管并执行 `Commands.run('workspace.open')`；`#btn-open-file` 为 Open File，执行 `Commands.run('file.open')`。两者均不得在其他模块中重复绑定 click。
- Settings 入口：`#btn-settings` 执行 `Commands.run('settings.toggle')`；面板本身由 `window.SettingsUI` 惰性创建。
- Tab 可见性：`#tab-bar` 为横向滚动容器；每次活动 tab 切换或 tab 栏重绘后，必须把 `.tab.active` 保持在容器可视区内，不改变用户主动滚动时的其他 tab 顺序。
- 单文档规则：即使只有一个文件 tab，tab 栏仍显示；关闭最后一个文档后回到可编辑的 Untitled tab。
- Toggle Preview：`#btn-toggle.active` 仅表示纯 Preview 模式；其紫→粉背景复用 `--heading-glow`，是工具栏 active 状态，不是预览内容区背景；split 模式不把按钮标成纯预览 active。

## 5. 前端新文件接入 build_html

- 接入点：`src/main.rs` —— 顶部加 `const XXX_JS: &str = include_str!("frontend/xxx.js");`，`build_html()` 末尾的 scripts 追加段（commands.js、workspace.js 所在的 `format!` 链）继续向后拼接。
- 顺序约定（严格递增，新文件一律追加在**既有全部脚本之后**，即 workspace.js 之后）：

```text
highlight.min.js → marked.min.js → preview.js → tabs.js → editor.js → app.js → commands.js → workspace.js → <后续新模块按阶段追加>
```

- 约束：新模块排在 app.js 之后（保证既有 DOM/全局就绪、`__fromRust` 已定义）；workspace.js 必须先于任何可能触发 `workspace:*` 下行事件的时刻装载（Rust 侧已保证：CLI 目录打开推迟到前端 `ready` 之后才广播）。
- `</script>` 防截断由 `escape_for_script_tag` 统一处理，新拼接必须复用它。

## 6. Rust 模块接线方式

- 声明：新模块在 `src/main.rs` 加 `mod x;`（main.rs 对并行流仅允许此类附加式修改）。
- 命令：handler 写在本模块、签名为 `fn(&commands::CommandContext, &commands::CommandPayload)`，在模块 `pub fn init()`（或 `commands::register_builtin()`，阶段 0 两个内置命令位于 commands.rs）中 `commands::register(id, handler)?`；main() 启动时调用一次 init。经 IPC 触发的命令还需在 `ipc.rs::registry_command_id` 登记 wire 映射。
- 事件广播（跨线程安全）：
  1. 模块定义事件类型，实现 `name() -> &'static str` 与 `payload() -> serde_json::Value`（参照 `src/workspace/events.rs::Event`）；
  2. 后台线程调用 `workspace::events::emit(event)` —— 发送器由 main.rs 在启动时安装（`events::set_sender` → `EventLoopProxy`），事件经 `UserEvent::WorkspaceEvent` 回到主线程；
  3. 主线程分支 `workspace::events::broadcast_event(&webview, &event)` → `ipc::send_to_js` → 前端 `__fromRust`。
  4. 后续模块的事件建议复用该通道；若事件类型不属于 workspace 语义，可将发送器抽象上移（阶段 1+ 由主 Agent 裁决，不自行另建通道）。
- 可信项目根（阶段 1+ 文件操作强制约束）：一切文件读写前必须通过 `workspace::ensure_within_root(root, target)`（规范化后逐组件前缀比较，符号链接与 `..` 逃逸都会被拒绝）；打开项目根一律走 `Workspace::open_root`。

## 7. 变更记录

- 2026-09-04（阶段 0 / A2 流）：初版。上行命令表（file.open、workspace.open 迁入注册表）、下行事件全集（§3.1–3.3）、JS 命名空间（Commands、Workspace 已实现 + 后续预留）、build_html 接入与脚本顺序、Rust 模块接线与事件桥通道、可信项目根约束。
