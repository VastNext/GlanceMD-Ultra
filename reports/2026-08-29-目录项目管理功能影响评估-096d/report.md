# GlanceMD 目录项目管理功能影响评估（初始范围）

> **状态说明：** 本报告记录最初“单目录 Markdown 导航”范围的评估。后续需求已扩展为完整项目工作区，正式产品名确定为 **GlanceMD Ultra**。当前有效的完整方案请阅读：
>
> - `product-decisions.md`：已确认产品决策
> - `GlanceMD-Ultra-product-architecture-proposal.md`：最新产品与架构方案

## 结论先行

要实现“打开一个目录、在侧栏浏览 Markdown 文件、点击后用 tab 打开、右键在系统文件管理器中显示”，对 GlanceMD 的影响属于**中等规模**，不是重写。

现有架构有一个很有利的分界：Rust 已负责原生文件能力，JS 已负责 tab 状态。因此最关键的文件打开链路可以直接复用：

```text
项目树点击文件
→ JS 发送 open_file(path)
→ Rust 读取文件
→ file_opened(path, content)
→ TabManager.createTab(path, content)
```

真正新增的是“目录项目树”子系统，而不是编辑器或 tab 子系统。

**工作量建议按两档理解：**

- 能用的紧凑 MVP：**3–5 个工程日**。
- 适合正式发布、能应对大目录和三平台差异的版本：**6–9 个工程日**。

如果范围继续加入文件监听、新建/重命名/删除、拖动移动、全文搜索、Git、多根工作区，就会扩张为 **3–6 周**的新产品子系统。

---

## 一、建议的第一版功能边界

建议第一版只做：

1. 工具栏“打开文件夹”。
2. 左侧显示单个项目根及 Markdown 目录树。
3. 文件夹按需展开，文件单击复用现有 tab 打开。
4. 文件右键菜单：
   - 打开
   - 在系统文件管理器中显示
5. 手动刷新项目树。
6. 项目树和 Outline 共用左侧面板，同一时间只显示一个。

第一版不要做：

- 文件监听和自动刷新。
- 新建、重命名、删除、拖动移动。
- 多根工作区。
- 全文搜索、Git 状态、`.gitignore` 语义。
- 保存展开状态以外的复杂项目会话。

这样能控制影响面，并且先验证“GlanceMD 是否真的需要从轻量查看器向项目型编辑器演进”。

---

## 二、对 Rust 后端的影响

### 1. 目录选择

`src/file_ops.rs` 已使用 `rfd::FileDialog`。增加 `pick_folder()` 即可，不需要新增目录选择依赖。

建议 IPC 增加：

```text
open_directory
list_directory
reveal_in_file_manager
```

### 2. 目录枚举

不要首次递归扫描整棵目录。推荐展开文件夹时才请求其子节点：

```json
{
  "name": "docs",
  "path": "D:/project/docs",
  "kind": "directory",
  "has_children": true
}
```

这种懒加载方案可以避免 `.git`、构建目录、网络盘或数万文件导致窗口卡顿，也减少 Rust → WebView 的 JSON 体积。

### 3. 安全边界

Rust 不能直接信任前端传来的路径。应对项目根和目标路径执行 canonicalize，并确认目标仍位于项目根内，避免 `..` 和符号链接逃逸。

建议默认跳过：

- `.git`
- 隐藏目录
- 符号链接目录或至少检测循环
- 非 `.md/.markdown` 文件

现有 `AppState` 可以保存当前项目根，形成可信边界。若坚持 JS 保存项目根，Rust 仍需逐次校验。

### 4. 在文件管理器中显示

| 平台 | 推荐实现 | 结果 |
|---|---|---|
| Windows | `explorer.exe /select, <file>` | 打开 Explorer 并选中文件 |
| macOS | `open -R <file>` | 在 Finder 中显示并选中文件 |
| Linux | `xdg-open <parent>` | 打开父目录，不保证选中文件 |

命令必须使用 Rust `std::process::Command::arg` 逐个传参，不能把路径拼进 `cmd.exe`、shell 或批处理字符串；Rust 官方文档明确提醒 Windows 下不可信输入与非标准参数解码的安全问题。

### 5. 是否需要后台线程

当前 IPC 在 Tao UI 事件循环中同步执行。MVP 如果每次只做单层 `read_dir`，通常可接受；若做递归扫描、文件监听或网络盘支持，就需要后台线程和 `EventLoopProxy`，这是复杂度上升的分界点。

---

## 三、对前端的影响

### 1. 新增项目侧栏

预计修改：

- `src/frontend/index.html`：项目面板、打开文件夹按钮、右键菜单。
- `src/frontend/style.css`：树层级、选中态、折叠图标、菜单、明暗主题、窄窗口布局。
- 新增 `src/frontend/project.js`：建议不要继续把状态塞进已经较大的 `app.js`。
- `src/main.rs::build_html()`：把新脚本加入内嵌脚本顺序。

`ProjectManager` 建议只管理：

```text
projectRoot
expandedDirectories
loadedChildren
activeTreePath
contextMenuTarget
```

文件内容仍只存在 TabManager 中，避免双份状态。

### 2. Tab 基本无需重写

现有 `TabManager.createTab()` 已按路径去重。项目树打开文件直接走当前 `open_file` 链路，就能获得：

- 重复点击不重复创建 tab。
- dirty 状态。
- 编辑/预览/split 状态。
- 保存与最近文件。

需要补充的只是：打开/切换 tab 后同步高亮项目树中的活动文件。

### 3. 项目树和 Outline 的关系

当前内容区已经可能同时存在 TOC、编辑器和预览；split 还支持拖动比例。如果再让项目树和 TOC 同时占左侧，会在小窗口形成四块区域。

推荐设计：**项目树和 Outline 是同一左侧面板的两个模式，同一时间只显示一个**。这能显著降低布局和 resize 复杂度。

### 4. 路径比较必须顺便修复

`tabs.js::findTabByPath()` 和最近文件逻辑目前无条件把路径转小写比较。这对 Windows 合理，但在 Linux 和大小写敏感 macOS 卷上会错误合并 `README.md` 与 `readme.md`。

项目树会让该问题从边缘情况变成常见问题。应增加平台感知的比较规则：Windows 忽略大小写，其他平台保留大小写。

---

## 四、影响文件和改动规模

| 文件 | 影响 | 规模 |
|---|---|---|
| `src/file_ops.rs` | 目录选择、枚举、reveal | 中 |
| `src/ipc.rs` | 新命令、结构化返回、错误处理 | 中 |
| `src/state.rs` | 可选：可信项目根 | 小 |
| `src/main.rs` | 新脚本、目录 CLI/拖放扩展（可选） | 小到中 |
| `src/frontend/index.html` | 项目侧栏和右键菜单 | 中 |
| `src/frontend/style.css` | 树、菜单、布局、双主题 | 中到大 |
| `src/frontend/project.js` | 新项目树状态与交互 | 大（新增） |
| `src/frontend/app.js` | IPC 事件、工具栏、活动文件同步 | 小到中 |
| `src/frontend/tabs.js` | 平台感知路径比较、活动文件事件 | 小 |

粗略代码量：

- Rust：约 **150–300 行**，加测试。
- 前端：约 **350–700 行** HTML/CSS/JS，取决于树组件和菜单完成度。
- 自动化测试与测试页：约 **150–300 行**。

---

## 五、工作量拆分

### 紧凑 MVP：3–5 日

| 工作项 | 估算 |
|---|---:|
| 目录选择、Markdown 枚举、IPC | 0.5–1 日 |
| 项目侧栏和可折叠树 | 1.5–2 日 |
| 点击文件复用 tab、活动高亮 | 0.5 日 |
| Explorer/Finder reveal、Linux 降级 | 0.5 日 |
| 行为、双主题、CI 回归 | 0.5–1 日 |

### 推荐可发布版本：6–9 日

额外包含：

- 懒加载与错误态。
- 路径边界和软链接处理。
- 侧栏宽度调节。
- 最近项目、展开状态持久化。
- 项目树/Outline 互斥活动面板。
- Rust 单元测试和前端浏览器测试。
- Windows/macOS/Linux 手工验证。

### 完整项目管理：3–6 周

只有在明确需要以下功能时才进入此范围：文件监听、创建/重命名/删除、拖动移动、多根工作区、全文搜索、Git 状态、忽略规则、项目会话恢复。

---

## 六、主要风险

1. **范围膨胀**：最容易从“文件浏览”滑向 VS Code Explorer；必须写清非目标。
2. **大目录卡顿**：递归扫描不能放 UI 事件循环。
3. **软链接和路径逃逸**：需要 Rust 侧可信根与 canonicalize 校验。
4. **Linux reveal 不统一**：第一版应接受打开父目录而非选中文件。
5. **路径大小写**：现有逻辑在 Linux/macOS 上有隐藏 bug。
6. **布局拥挤**：项目树与 TOC 推荐互斥，不要默认同时占宽。

---

## 最终建议

该功能值得做，且不会破坏 GlanceMD 的现有核心，但应把它定义为**“单目录 Markdown 导航”**，不要直接命名为完整“项目管理”。

推荐采用 6–9 日的可发布方案：Rust 按节点懒加载 + 路径边界验证，前端独立 ProjectManager，项目树与 Outline 互斥，三平台 reveal 有明确降级。这样能保持 GlanceMD 的轻量定位，同时为后续搜索、文件操作和项目会话留下清晰扩展点。

## 参考

- 当前仓库：`src/main.rs`、`src/ipc.rs`、`src/file_ops.rs`、`src/state.rs`、`src/frontend/app.js`、`src/frontend/tabs.js`、`src/frontend/index.html`。
- Rust `std::process::Command` 官方文档：https://doc.rust-lang.org/std/process/struct.Command.html
- rfd 已在当前项目中使用，目录选择可复用现有原生对话框依赖。
