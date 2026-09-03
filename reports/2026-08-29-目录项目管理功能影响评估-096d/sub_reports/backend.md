# Rust 文件系统、IPC 与平台能力

## 当前基础

- `src/file_ops.rs` 只有选文件、另存为、读文件、写文件四个同步函数；`rfd` 已可直接增加 `pick_folder()`，无需新增目录选择依赖。
- `src/ipc.rs::IpcMessage` 已有 `command/path/content`，统一由 `handle_ipc_message()` 分派；可以增加 `open_directory`、`list_directory`、`reveal_in_file_manager` 命令。
- `src/main.rs` 的 IPC 在 Tao UI 事件循环中同步执行。单文件 I/O 足够快，但递归扫描大型目录会卡住窗口。

## 推荐后端接口

### MVP

1. `pick_project_directory() -> Option<String>`
2. `list_directory(path, root) -> Result<Vec<ProjectEntry>>`
3. `reveal_in_file_manager(path) -> Result<()>`

`ProjectEntry` 建议至少包含：

```text
name, path, kind(file|directory), has_children
```

不要在首次打开时递归返回整棵树。按展开节点调用 `list_directory`，避免 UI 线程长时间阻塞，也避免向 WebView 传输巨型 JSON。

## 路径与安全

- Rust 侧保存或校验当前项目根；不能信任 JS 发回的任意 `path`。
- 对根目录和目标路径做 `canonicalize` 后验证目标仍位于根内，防止 `..` 和软链接逃逸。
- 默认跳过隐藏目录、构建目录、`.git`、符号链接循环；具体过滤规则应明确为产品决定。
- 目录读取错误应按节点返回，不应使整个项目树失效。

## 在系统文件管理器中显示

- Windows：启动 `explorer.exe`，使用 `/select,` 参数选中文件；必须通过 `Command::arg` 传参，不拼接 shell 字符串。
- macOS：`open -R <path>` 可在 Finder 中显示并选中。
- Linux：桌面文件管理器没有统一“选中目标文件”协议；可靠基线是 `xdg-open <parent>` 打开父目录。不同文件管理器的 DBus/CLI 选中能力不应进入第一版。

Rust 官方 `std::process::Command` 文档强调：参数应通过 `arg` 单独传递；Windows 下不可信输入尤其不能经 `cmd.exe` 或批处理字符串拼接。

## 架构风险

- 当前 `AppState` 虽不再是完全空结构，但仍主要处理启动/窗口状态。把项目根放 Rust 侧会增强安全边界，但改变“JS 拥有全部业务状态”的约定。
- 最小方案可以让 JS 持有项目根，Rust 每次 canonicalize 校验；生产级方案建议 Rust 持有项目根。
- 如果以后要文件监听、增量刷新、全文搜索，应新增独立 `project_ops.rs`，并将目录操作移到后台线程，通过 `EventLoopProxy` 回送事件。
