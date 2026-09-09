# GlanceMD Ultra — 需求与 Bug 记录清单 (Backlog)

本文档用于追踪记录日常收集到的用户反馈、Bug 缺陷以及功能改进需求。每个条目均包含状态和详细说明，并在沟通过程中持续补充和演进。

---

## 状态说明

- 📋 **待确认** (`pending_review`)：初步收集，细节或方案尚需讨论。
- ⏳ **待排期 / 待规划** (`backlog`)：已明确需求与方案，等待排期开发。
- 🚧 **进行中** (`in_progress`)：正在开发或修复。
- ✅ **已完成 / 已修复** (`resolved`)：已合并并验证通过。
- 🚫 **已搁置 / 不处理** (`wontfix`)：经讨论暂不实现或不予处理。

---

## 🐛 Bug 缺陷列表

| ID | 录入日期 | 模块 / 领域 | 简要描述 | 严重级别 | 状态 |
|---|---|---|---|---|---|
| BUG-001 | 2026-09-07 | 文件监听 / 编辑器 | 外部修改 Markdown 文件后，未被编辑的 Clean Tab 未自动热重载，需手动关闭再打开才能看到最新内容 | 高 (P1) | ✅ 已修复 |

### Bug 详细记录

#### BUG-001: 外部修改文件后 Clean Tab 未自动热重载
- **发现环境**：Windows / macOS / Linux
- **复现步骤**：
  1. 在 GlanceMD Ultra 中打开一个 `.md` 文件（处于未修改 Clean 状态）。
  2. 在外部编辑器（如 VS Code、Git 切换分支、或第三方脚本）中修改该 `.md` 文件内容并保存。
  3. 切回 GlanceMD Ultra。
- **预期行为**：
  - **Clean Tab（无本地未保存修改）**：监听到文件变更后，自动静默重新加载并刷新编辑器与预览区域为最新内容。
  - **Dirty Tab（有本地未保存修改）**：弹出冲突保护黄色横幅（`recovery.bannerModifiedTitle`），提示用户选择“重新加载”或“保留编辑”。
- **实际行为**：
  - 界面没有自动更新最新内容，必须把该 Tab 关闭后重新打开才能看到新内容。
- **根因分析 / 初步定位**：
  1. `recovery.js` 接收到 `workspace:file-changed` (modified) 事件时，对于 `isDirtyByDom(path) === false` 的 clean tab，仅做了移除旧横幅操作（注释写着`// clean tab：自动重载由 app.js 层负责`），但前端 `app.js` / `tabs.js` 中实际缺少对 clean tab 触发自动重载并更新 DOM 的调用。
  2. 需同时确认无工作区（单文件独立打开模式）下，是否也已正确挂载了对应单文件的 Watcher。
- **处理状态**：✅ 已修复 (`resolved`) 2026-09-08
- **修复方案**：
  1. **Clean Tab 热重载**：`app.js` 订阅 `workspace:file-changed`（modified），发现对应 tab 存在且为 clean 时发起 `file.reload` 命令；Rust 侧 `commands::file_reload` 读回最新内容（含编码/换行识别）并回发 `file_reloaded`；`TabManager.reloadTabContent` 静默更新缓冲区——活动编辑态保留光标/滚动并刷新编辑器，预览/分栏态即时重渲染预览，后台标签只更新缓冲区（切换时由 `restoreTabState` 重渲染）。
  2. **顺带修复**：`tabs.js` 的 `saveTabState` 原先无条件用编辑器 DOM 回写 `tab.content`，预览模式下会以旧 DOM 镜像覆盖刚热重载的内容；现仅在编辑器可见时同步。
  3. **单文件模式 Watcher**：`open_file` 后若未打开工作区，按全局 `watching.enableWatcher` 开关挂载定向监听（仅监听文件所在目录并过滤出该文件的事件，复用去抖/回环抑制/事件桥），打开工作区或下一个文件时自动替换。
  4. **IPC 分发断点（真实环境失效真因）**：`ipc.rs` 的 `registry_command_id` 通配前缀清单缺 `file.`，前端发出的 `file.reload` 被 legacy 分支当作未知命令丢弃，重载从未执行（浏览器 mock 绕过了真实 IPC 分发，故此前未暴露）。已补 `file.` 前缀并锁定单测。

---

## ✨ 需求与改进列表 (Feature Requests & Improvements)

| ID | 录入日期 | 分类 / 模块 | 需求简述 | 优先级 | 状态 |
|---|---|---|---|---|---|
| FEAT-001 | 2026-09-07 | CLI / 工作区 | 命令行支持打开目录为工作区（如 `gmdu .`，类似 `code .`） | 高 (P1) | ✅ 已完成 |
| FEAT-002 | 2026-09-07 | 软件更新 / 发布 | 软件内支持“检查并一键更新”，自动获取 GitHub Latest Release 匹配当前平台的包并覆盖更新 | 中 (P2) | ⏳ 待排期 |
| FEAT-003 | 2026-09-07 | 网络 / 系统设置 | 设置页支持配置 HTTP/HTTPS/SOCKS5 网络代理，支持系统代理跟随与自定义覆盖（FEAT-002 前置） | 中 (P2) | ✅ 已完成 |
| FEAT-004 | 2026-09-09 | 体积 / 发布 | 二进制减重：内嵌前端资产 gzip 预压缩 + `opt-level="z"`，使 Windows 产物回到 5 MB 以内（预算放宽后的偿还计划） | 中 (P2) | ⏳ 待排期 |
| FEAT-005 | 2026-09-09 | 翻译 / 编辑器 | 集成翻译功能：选中文本划词翻译，复用 VastTranslator 引擎层（Google/Bing/自定义 AI），Rust IPC 代理网络请求 | 中 (P2) | ⏳ 待排期 |

### 需求详细记录

#### FEAT-001: 命令行支持打开目录/工作区（类似 code .）
- **需求背景**：用户习惯在终端中通过 `gmdu .` 快速以当前目录/指定目录打开 GlanceMD Ultra 工作区（类似于 VS Code 的 `code .` 命令）。
- **期望行为 / 交互细节**：
  1. **冷启动场景**：执行 `gmdu .` 或 `GlanceMD-Ultra <dir>` 时，解析相对路径为绝对路径，启动程序并直接打开该目录作为工作区（左侧展开项目树）。
  2. **已运行实例时的多开 / 切换策略**（用户确认）：
     - **默认行为（方案 B）**：每次执行命令均独立打开一个**新窗口**多开项目。
     - **可配置项（方案 A）**：在设置页提供 `window.reuseWindowForFolder` 开关，默认关闭；开启后允许在当前已有窗口中直接切换工作区（已有标签保留，未保存草稿不被覆盖）。
  3. **命令别名与体验**：
     - 官方短命令统一为 `gmdu .`（生成安全、可逆的命令 shim）。
     - 不使用冲突较高的 `glance`（OpenStack 等占用）或 `gmd`（多个 Git/Markdown CLI 占用）。
  4. **相对路径解析**：对 `.`、`..`、`./subdir` 等相对路径，在客户端进程启动时就基于调用方的 `std::env::current_dir()` 解析为规范绝对路径，避免跨进程转发后工作目录不一致的问题。
- **涉及模块 / 影响范围**：
  - `src/main.rs`（CLI 参数相对路径转绝对路径、单实例转发前规范化、多开与单实例策略适配）
  - `src/single_instance.rs`（管道消息区分打开文件 vs 打开目录工作区，传递窗口复用设置）
  - `src/workspace/settings.rs` & `src/frontend/settings.js`（增加工作区打开新窗口策略的设置项）
  - **处理状态**：✅ 已完成 (`resolved`) 2026-09-08
  - **实现内容**：
    1. 冷启动支持 `GlanceMD-Ultra <dir>`、`.`、`..`、`./subdir`，在调用方进程先解析绝对路径并打开工作区。
    2. Windows 已运行实例默认独立启动新窗口；开启 `window.reuseWindowForFolder` 后，通过单实例管道将目录路由为 `workspace.open`，在已有窗口切换工作区。
    3. **最终方案**：`gmdu` 为唯一官方短命令；除目录参数外支持 `--install-cli` / `--uninstall-cli` / `--cli-status` / `--version`，命令行入口**跨平台必可用**。
    4. **安装位置契约（最终方案）**：Windows 在 `current_exe` 所在目录的 `bin/` 创建相对引用 exe 的 `gmdu.cmd`，并把该 `bin` 加入用户级 PATH，广播环境变更——**必须开新终端**生效；macOS/Linux 在 `~/.local/bin` 创建指向 exe 的 `gmdu` symlink（提示 `~/.local/bin` 需在 PATH）。仅删除本程序所有权入口，第三方同名文件绝不触碰；设置页提供安装/移除入口（非 Windows 是否显示取决于实现，命令行语义一致）。
    5. Release 仍为**单个真实二进制**：shim / symlink 不复制 exe，体积无本质增加。
  - **验证**：239 项 Rust 测试、前端全套 Node 测试、15 项 Playwright e2e 通过；GitHub Ultra 分支 CI 与 main CI 均通过。Release workflow 将跨平台测试 `gmdu --version`（tag 计划 `v0.2.0`）。

#### FEAT-002: 软件内一键检查更新与覆盖安装 (In-place Auto-update)
- **需求背景**：用户希望在软件内直接点击“检查更新”或自动提示，自动从 GitHub Latest Release 下载匹配当前平台/架构的最新安装包/单文件并原地覆盖安装，省去手动去网页下载解压的繁琐流程。
- **前置依赖**：`FEAT-003`（网络代理配置，确保国内网络环境下可顺利访问 GitHub Release 与下载资源）。
- **期望行为 / 交互细节**：
  1. **检查更新入口**：在“关于/设置页面”或主菜单/命令面板中提供【检查更新】功能。
  2. **版本与 Asset 匹配**：
     - 请求 GitHub API（`https://api.github.com/repos/VastNext/GlanceMD-Ultra/releases/latest`）。
     - 比较当前版本与最新 Release Tag。
     - 自动匹配当前操作系统与架构的 Asset：
       - Windows: `GlanceMD-Ultra-windows-x64.zip` 或直接覆盖单 `GlanceMD-Ultra.exe`。
       - macOS: `GlanceMD-Ultra-macos-arm64.dmg` / `GlanceMD-Ultra-macos-x64.dmg`。
       - Linux: `GlanceMD-Ultra-linux-x64.AppImage` / `.deb`。
  3. **Windows 原地无感热替换机制**：
     - Windows 不允许直接覆盖正在运行中的 `.exe`，标准轻量解法：
       1. 下载新版本到临时路径（`%TEMP%`）。
       2. 将当前运行的 `GlanceMD-Ultra.exe` 重命名为 `GlanceMD-Ultra.exe.old`（Windows 允许重命名运行中的文件）。
       3. 将新下载的文件移动到原位置。
       4. 提示用户“更新成功，是否立即重启？”，确认后启动新 exe 并退出当前进程。
  4. **网络容错与降级**：
     - 如下载超时或受网络限制失败，提供一键“在浏览器中打开 Release 页面”作为可靠兜底。
- **涉及模块 / 影响范围**：
  - Rust 后端新增更新模块（网络请求、版本比对、Asset 匹配与文件替换逻辑）
  - 前端设置/关于面板（更新状态显示、下载进度条、Release Notes 弹窗与重启按钮）
- **处理状态**：⏳ 待排期 (`backlog`)

#### FEAT-003: 设置页支持自定义网络代理 (Proxy Configuration)
- **需求背景**：国内用户直接访问 GitHub（更新检查、资源下载、在线渲染外部图片等）经常受到网络波动或阻断影响，需在设置中支持配置网络代理以确保网络功能稳定可用。
- **期望行为 / 交互细节**：
  1. **设置项结构**：
     - `http.proxySupport`: 代理工作模式（选项：`system` 自动读取系统/环境变量、`override` 显式覆盖、`off` 直连禁用）。
     - `http.proxy`: 代理服务器地址（支持 `http://127.0.0.1:7890`、`socks5://127.0.0.1:7890` 等）。
     - `http.proxyStrictSSL`: 是否严格验证 SSL 证书（布尔值，默认 `true`）。
  2. **应用范围**：
     - Rust 后端发起的网络请求（包括 FEAT-002 的版本检测与 Release Asset 下载）。
     - 前端图片加载与外部资源请求时（必要时通过后端代理通道加载）。
  3. **测试连接按钮**：
     - 设置页代理输入框旁提供【测试连接】按钮，一键探测代理有效性与延迟，提升配置体验。
- **涉及模块 / 影响范围**：
  - `src/workspace/settings.rs`（新增 `Http` 结构、`ProxySupport` 枚举、`effective` 合并与已知键表登记）
  - `src/net.rs`（新增网络层：纯函数 `parse_proxy_url`、`ProxySpec` 标准化、`build_agent`、`test_proxy`，引入 `ureq` + `rustls` + `socks-proxy`）
  - `src/main.rs`（启动早期加载全局代理设置，经 wry `with_proxy_config` 注入 WebView2 / WKWebView / WebKitGTK 全局代理）
  - `src/commands.rs` & `src/ipc.rs`（新增 `net.testProxy` 命令处理前端测试请求，登记 `net.` IPC 通配前缀）
  - `src/frontend/settings.js`、`settings.css`、`i18n.js`（设置面板新增“网络 / Network”分节、代理模式联动禁用、测试连接按钮与回执展示）
- **处理状态**：✅ 已完成 (`resolved`) 2026-09-09
- **实现内容**：
  1. **Schema & 合并**：`settings.rs` 新增 `http` 分类（`proxySupport`、`proxy`、`proxyStrictSSL`），保持全局限定（打开工作区文件不静默改变网络出口）；serde default 保证向后兼容。
  2. **轻量网络层**：`net.rs` 基于 `ureq` 3.x（零 async 运行时）实现纯解析与测试客户端，支持 HTTP/HTTPS/SOCKS5 及认证；严格校验开关支持自签证书场景；纯逻辑覆盖 9 项探针单测。
  3. **WebView 代理注入**：`main.rs` 启动时若为 `override` 模式，将规范化后的 `ProxyConfig` 经 wry `with_proxy_config` 注入各平台原生引擎，外部图片自然走代理。
  4. **前端设置交互**：九大分类新增“网络”；代理模式非 override 时输入框与测试按钮联动禁用；测试连接支持未保存地址即时探测；中英双语与明暗主题自适应。
  5. **验证全绿**：Rust 全量单测（含 9 项 net_probe、30 项 settings_probe）、457 项前端 Node 测试、94 项 Playwright 端到端冒烟全绿；明暗双主题截图通过。

#### FEAT-004: 二进制减重——内嵌资产预压缩与体积优化（2026-09-09 放宽预算后的偿还计划）
- **背景 / 决策来源**：v0.3.0 集成双键位方案、Key Assist 与 Vim 后，Windows 正式 MSVC 产物实测 5,695,488 字节（5.695 MB / 5.432 MiB），超出原 2–5 MB 预算。维护者决策（2026-09-09）：预算放宽为 2–8 MB 以维持发布节奏，减重作为独立事项偿还，`strip = "none"` 与零外部运行时约束不变。
- **实测基线（v0.3.0 候选 d2f9ea9，MSVC release）**：
  - Windows x64：5,695,488 字节（5.695 MB / 5.432 MiB）
  - macOS Intel：6,413,760 字节；macOS Apple Silicon：6,361,552 字节；Linux x64：10,406,872 字节（含 AppImage 运行时）
- **体积构成（架构评估）**：三大 vendored 库（mermaid ~1.05 MB、highlight ~380 KB、marked ~55 KB，零压缩内嵌 `.rdata`）占 ~28%；产品代码新增 ~430–500 KB。
- **方案（按 ROI 排序，均为评估结论，实施前需重新验证）**：
  1. **方案 A（主项）**：build.rs 用 `flate2`/`miniz_oxide`（纯 Rust、零 C 依赖）将 JS/CSS 预压缩为 `.gz` blob 经 `include_bytes!` 嵌入，`build_html()` 解压拼装。文本 gzip 典型 3:1，预计净减 ~0.9–1.1 MB；启动解压 ~1.5 MB 文本约 3–8 ms。需锁定版本并验证三平台编译。
  2. **方案 B（辅项）**：`opt-level` 由 `"s"` 改 `"z"`（原生码约省 5–15%，~150–400 KB），编辑器场景对轻微 CPU 损耗不敏感；需回归验证。
  3. 备选：Mermaid 降级 10.x（~400 KB）或懒注入（产品决策，暂不动）；产品 JS 构建时 minify（ROI 低，不推荐）。
  - **不可行项**：strip 符号（崩溃诊断硬约束）、外置资产文件（违反一切内嵌约束）、UPX 壳（误报/签名/启动开销）。
- **验收目标**：Windows 产物回到 ≤ 5 MB（十进制），且启动耗时无可感知退化、全部既有测试与四平台 CI 保持全绿。
- **处理状态**：⏳ 待排期 (`backlog`)

#### FEAT-005: 集成翻译功能——选中文本划词翻译（复用 VastTranslator 引擎层）
- **立项提案**：详见 `docs/proposals/2026-09-09-翻译功能集成提案.md`（含可行性调研、MVP 范围、体积评估与验收标准）
- **需求背景**：用户在编辑/阅读双语文档时需要对选中文本快速翻译。VastTranslator（LexiLayer）Chrome 插件已沉淀成熟的三引擎翻译层（Google 免 key / Bing / 自定义 OpenAI 兼容 API），其核心约 1000 行纯 TS 不依赖 Chrome API，可移植。
- **方案要点**：
  1. Rust 端新增 `ureq` 依赖，IPC 新增 `translate_request` 做 HTTP 代理（解决 WebView 自定义协议下前端直连外网的 CORS 限制，且 API key 不出前端进程）。
  2. 前端新增 `translate.js` / `translate.css`（IIFE 模式），移植三引擎请求构造与分段 id 对齐协议；UI 按紫→粉渐变设计语言重写为划词浮动气泡（译文 + 替换/插入/复制）。
  3. settings.js 新增「翻译」分节：引擎选择、自定义 AI 端点、目标语言，存 localStorage（`glancemd-ultra-` 前缀）。
  4. MVP 不含：全文对照翻译、专家提示词、翻译缓存、SSE 流式（后续另行立项）。
- **协同关系**：依赖 FEAT-003（网络代理配置）保障国内网络下 Google 接口可达；体积增量预计 ≤ 1 MB，处于 FEAT-004 放宽后的 2–8 MB 预算内。
- **处理状态**：⏳ 待排期 (`backlog`)

---

## 📝 历史归档 / 变更日志

*记录已解决或归档的重要里程碑*
