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

---

## ✨ 需求与改进列表 (Feature Requests & Improvements)

| ID | 录入日期 | 分类 / 模块 | 需求简述 | 优先级 | 状态 |
|---|---|---|---|---|---|
| FEAT-001 | 2026-09-07 | CLI / 工作区 | 命令行支持打开目录为工作区（如 `glance .` / `GlanceMD .` 类似 `code .`） | 高 (P1) | ⏳ 待排期 |
| FEAT-002 | 2026-09-07 | 软件更新 / 发布 | 软件内支持“检查并一键更新”，自动获取 GitHub Latest Release 匹配当前平台的包并覆盖更新 | 中 (P2) | ⏳ 待排期 |
| FEAT-003 | 2026-09-07 | 网络 / 系统设置 | 设置页支持配置 HTTP/HTTPS/SOCKS5 网络代理，支持系统代理跟随与自定义覆盖（FEAT-002 前置） | 中 (P2) | ⏳ 待排期 |

### 需求详细记录

#### FEAT-001: 命令行支持打开目录/工作区（类似 code .）
- **需求背景**：用户习惯在终端中通过 `glance .` 或 `GlanceMD .` 快速以当前目录/指定目录打开 GlanceMD Ultra 工作区（类似于 VS Code 的 `code .` 命令）。
- **期望行为 / 交互细节**：
  1. **冷启动场景**：执行 `glance .` 或 `GlanceMD <dir>` 时，解析相对路径为绝对路径，启动程序并直接打开该目录作为工作区（左侧展开项目树）。
  2. **已运行实例时的多开 / 切换策略**（用户确认）：
     - **默认行为（方案 B）**：每次执行命令均独立打开一个**新窗口**多开项目。
     - **可配置项（方案 A）**：在设置页提供开关选项（如 `window.openFolderInNewWindow: false`），开启后允许在当前已有窗口中直接切换工作区（有未保存草稿时走冲突/保存保护）。
  3. **命令别名与体验**：
     - 支持短命令 `glance .`（生成快捷 shim / 软链接或注册命令别名）。
     - 支持标准的 `GlanceMD .` / `glancemd .`。
  4. **相对路径解析**：对 `.`、`..`、`./subdir` 等相对路径，在客户端进程启动时就基于调用方的 `std::env::current_dir()` 解析为规范绝对路径，避免跨进程转发后工作目录不一致的问题。
- **涉及模块 / 影响范围**：
  - `src/main.rs`（CLI 参数相对路径转绝对路径、单实例转发前规范化、多开与单实例策略适配）
  - `src/single_instance.rs`（管道消息区分打开文件 vs 打开目录工作区，传递窗口复用设置）
  - `src/workspace/settings.rs` & `src/frontend/settings.js`（增加工作区打开新窗口策略的设置项）
- **处理状态**：⏳ 待排期 (`backlog`)

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
  - `src/workspace/settings.rs`（新增 `HttpSettings` 结构及 schema）
  - `src/frontend/settings.js` & `settings.css`（设置面板新增“网络 / Network”分节及测试按钮）
  - Rust HTTP client 初始化层（如 `reqwest` / `ureq` 加载全局 proxy 设置）
- **处理状态**：⏳ 待排期 (`backlog`)

---

## 📝 历史归档 / 变更日志

*记录已解决或归档的重要里程碑*
