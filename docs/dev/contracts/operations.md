# 文件操作契约（阶段 3，Rust 侧核心 + 命令接线）

- 作用：定义文件操作核心（`src/workspace/operations.rs`）、命令粘合层（主 Agent 统一编写）与前端（项目树 `project-tree.js`）之间的命令、负载、事件与事务语义。
- 上游契约：`docs/dev/interfaces.md`（IPC 信封、命令注册表、事件桥、`ensure_within_root` 约束）；本文是其 §2/§3 中 `workspace.fs.*` / `workspace:fs-op-done` 的定稿与展开，冲突时以 interfaces.md 为准并回改本文。
- 核心定位：`operations.rs` 是**纯逻辑核心**，不引用 `crate::` 路径，路径边界校验与回收站能力均经注入；行为测试载体为 `tests/operations_probe.rs`（探针模式）。

## 1. 核心类型速览（粘合层对接用）

```rust
// src/workspace/operations.rs（探针测试同源编译）
pub struct FileOps { pub ensure: fn(&Path, &Path) -> Result<(), OpError> }
impl FileOps {
    pub fn new(ensure: EnsureFn) -> Self;
    pub fn create_file(&self, root: &Path, rel_path: &str) -> Result<OpResult, OpError>;
    pub fn create_dir(&self, root: &Path, rel_path: &str) -> Result<OpResult, OpError>;
    pub fn rename(&self, root: &Path, rel_path: &str, new_name: &str) -> Result<OpResult, OpError>;
    pub fn move_entry(&self, root: &Path, rel_path: &str, dest_rel_dir: &str) -> Result<OpResult, OpError>;
    pub fn copy_entry(&self, root: &Path, rel_path: &str, dest_rel_dir: &str) -> Result<OpResult, OpError>;
    pub fn delete_permanently(&self, root: &Path, rel_path: &str) -> Result<OpResult, OpError>;
    pub fn to_trash(&self, root: &Path, rel_path: &str, trash: &dyn TrashSink) -> Result<OpResult, OpError>;
}

pub struct OpResult { pub applied: OpDesc, pub undo: Option<UndoEntry> }
pub struct OpDesc { pub kind: OpKind, pub paths: Vec<PathBuf> }   // event_payload(undo_id) 生成事件负载
pub enum UndoEntry { Rename { from, to }, Move { from, to }, RestoreFromTrash { original_path } }
pub struct UndoStack { /* push -> u64 / pop / peek_top_id / undo(id) -> Result<OpDesc, OpError> */ }
pub enum OpError { NotFound, AlreadyExists, OutsideRoot, InvalidName, IllegalTarget, Io, NeedsManualRestore, UndoMismatch }
pub trait TrashSink { fn to_trash(&self, path: &Path) -> Result<(), OpError>; }
```

- `root`：**已打开工作区**的规范化项目根（粘合层取 `Workspace::root()`）；`rel_path` 以 `/` 分隔、相对项目根，核心逐分量做名称校验并强制经过注入的 `ensure`。
- **粘合层构造**：`FileOps::new(|root, target| workspace::ensure_within_root(root, target).map(|_| ()).map_err(map_to_op_error))`——把 `WorkspaceError::OutsideRoot` 映射为 `OpError::OutsideRoot`，其余映射为 `OpError::Io`（闭包无捕获时可静态化）。
- **TrashSink 桥接**（粘合层提供唯一实现）：

```rust
struct PlatformTrash;
impl operations::TrashSink for PlatformTrash {
    fn to_trash(&self, path: &Path) -> Result<(), OpError> {
        platform::trash_ops().to_trash(path)
            .map_err(|e| OpError::Io(std::io::Error::other(e.to_string())))
    }
}
```

- `platform::TrashOps`（阶段 3 起）：`to_trash` 三平台统一 `trash::delete`（Windows 走 Shell IFileOperation，资源管理器可"还原"；macOS 走废纸篓；Linux 走 FreeDesktop 回收站）；`delete_permanently` 为 std::fs 薄封装（文件 `remove_file`、目录树 `remove_dir_all`）；`PlatformError` 经 `From<trash::Error>` 折叠为 `Io`。

## 2. 上行命令表（注册表 ID ↔ 负载）

- 命令 handler 由主 Agent 的粘合层实现并经 `commands::register` 注册；wire 命令名与注册表 ID **取同一字符串**（`ipc.rs::registry_command_id` 一并登记）。
- 所有命令要求已打开工作区（`Workspace` 持有根）；未打开时发 `workspace:error`（"请先打开一个项目文件夹"）。
- 路径参数一律为**相对项目根的 `/` 分隔路径**；前端不得传绝对路径。

| 命令 ID | 负载 | 行为 | 成功回执 |
|---|---|---|---|
| `workspace.fs.create-file` | `{ path: rel }` | 新建空文件；**无扩展名自动补 `.md`**（含点开头的隐藏名）；**父目录必须已存在**；重名拒绝 | `fs-op-done {op:"create-file"}` |
| `workspace.fs.create-dir` | `{ path: rel }` | 新建文件夹；支持一次多层（**逐层**过边界校验并创建，任一层重名/被同名文件阻挡即拒绝） | `fs-op-done {op:"create-dir"}` |
| `workspace.fs.rename` | `{ path: rel, new_name: string }` | 仅改末段名称；重名/非法名拒绝（Windows 保留名、非法字符、末尾点/空格等，全平台统一应用） | `fs-op-done {op:"rename", undo_id}` |
| `workspace.fs.move` | `{ paths: rel[], dest_dir: rel }` | 逐项移入**已存在**的目标目录（保持原名）；见 §4 事务语义 | 每项一条 `fs-op-done {op:"move", undo_id}` |
| `workspace.fs.copy` | `{ paths: rel[], dest_dir: rel }` | 逐项复制到已存在目标目录（保持原名）；**目标重名拒绝，不覆盖、不自动改名** | 每项一条 `fs-op-done {op:"copy", undo_id:null}` |
| `workspace.fs.delete` | `{ paths: rel[], permanent: bool }` | `permanent:false` → 移入系统回收站；`permanent:true` → 永久删除（**前端必须先二次确认**） | 每项一条 `fs-op-done {op:"trash-delete"/"permanent-delete"}` |
| `workspace.fs.undo` | `{}` | 撤销最近一次可撤销操作（严格 LIFO），无负载 | 成功：`fs-op-done {op:"undo-rename"/"undo-move"}`；失败：`workspace:error` |

- 任一命令失败：发 `workspace:error {message}`（`OpError` 的中文 Display 已面向用户），**不**发 `fs-op-done`。
- 撤销的 `undo_id` 传参：前端撤销前可通过上一次 `fs-op-done` 的 `undo_id` 对账；`workspace.fs.undo` 无参数形式由 Rust 栈顶决定（核心 `UndoStack::undo(top_id)` 会拒绝非栈顶请求，粘合层直接传 `peek_top_id()`）。

## 3. 下行事件：`workspace:fs-op-done`

| 字段 | 类型 | 说明 |
|---|---|---|
| `op` | string | `create-file` / `create-dir` / `rename` / `move` / `copy` / `trash-delete` / `permanent-delete` / `undo-rename` / `undo-move`（`OpKind::as_str()`） |
| `paths` | string[] | 受影响路径，语义随 op：create → 新建目标；rename/move（含 undo-*） → `[原路径, 新路径]`；copy → `[源, 目标]`；两类 delete → 被删路径。已剥离 Windows `\\?\` 前缀 |
| `undo_id` | number \| null | 本次操作的撤销条目 ID；不可撤销操作（create/copy/permanent-delete）为 `null`。前端以其对账撤销链 |

- 由核心 `OpDesc::event_payload(undo_id)` 生成，粘合层经 `workspace::events` 通道广播（复用 `EventLoopProxy` 桥）。
- 前端消费：项目树按 `paths` 增量刷新对应节点；tab 事务（路径/标题/保存目标迁移）按 interfaces.md"Workspace 事务"要求同步处理。

## 4. 事务语义

- **重名策略**：一切目标重名（文件/目录互斥）一律 `AlreadyExists` 拒绝，不覆盖、不自动改名——避免静默覆盖用户数据。
- **创建**：`create_file` 写空文件（无扩展名补 `.md` 后再查重名），父目录必须已存在（与 `ensure_within_root` 的"仅末段允许不存在"语义一致，项目树新建文件总是发生在已有目录内）；`create_dir` 支持多层，逐层校验边界并创建；均无撤销条目。
- **重命名**：仅允许改末段；同目录下落点重名拒绝；大小写不敏感文件系统上仅大小写变化的重命名放行。撤销 = 把新名改回旧名。
- **移动**：优先同卷原子 `fs::rename`；失败（典型为跨卷）自动降级"复制 + 删除源"：
  - 复制任一步失败 → 按后进先出**清理全部已复制项**（源保持原样）；
  - 复制全部成功但删源失败 → **回滚目标副本**并报错（保证数据要么在源、要么在目标，不丢失不重复；排除占用后重试即可）。
  - 撤销 = 把目标整棵树移回原位。
- **复制**：目录递归复制，中途失败同样清理已复制项；目录符号链接不递归；不产生撤销条目。
- **回收站删除**：`trash::delete` 后原位置立即消失；撤销条目记 `RestoreFromTrash { original_path }`。
- **永久删除**：`remove_file` / `remove_dir_all`（只读文件自动清位重试一次）；不可撤销；前端必须二次确认；已打开且有未保存内容的文件由**前端**先阻止（核心不感知 tab 状态）。
- **多选批量**：粘合层对 `paths` **逐项**调用核心，逐项发 `fs-op-done`；建议遇首个失败即中止剩余项（已完成项不回滚、不报批量错误），并把首个错误发 `workspace:error`。撤销按 LIFO 逐项执行（批量 N 项 = 连续 N 次 undo）。

## 5. 撤销栈语义

- 严格后进先出；`undo_id` 从 1 起单调递增，仅用于对账（`undo` 拒绝非栈顶 ID，返回 `UndoMismatch`，栈不变）。
- 可撤销：重命名、移动、回收站删除。不可撤销：新建、复制、永久删除（undo_id 为 null）。
- 回收站删除撤销：返回 `NeedsManualRestore { original_path }` 并消耗条目（不阻塞后续撤销）；**限制与理由**：trash crate 不提供"从回收站还原"的跨平台 API（还原碰撞/孪生等接口仅部分平台可用），跨三个系统的还原语义无法统一保证，故由前端提示用户从系统回收站手动还原到 `original_path`。
- 撤销执行失败（如恢复落点已被占用）：条目**保留栈顶**，允许排除障碍后重试；`NeedsManualRestore` 例外（消耗）。
- 栈为**内存态**，不持久化；工作区关闭即清空。上限策略由粘合层决定（建议保留最近 100 条，`pop` 丢弃最旧）。

## 6. 限制与已知边界

1. `rel_path` 逐分量名称校验按 Windows 规则为下限、全平台统一：拒绝空名、`.`/`..`、路径分隔符、`< > : " / \ | ? *`、控制字符、Windows 保留名（含带扩展名形式）、末尾点/空格、超长（>255）。
2. 纵深防御两层：核心层分量检查（拒绝 `..`/绝对路径）+ 注入的 `ensure_within_root`（canonicalize 后前缀比较，拦截符号链接逃逸）。**集成方必须注入真实 `ensure_within_root`**，探针测试中的复刻实现仅用于独立验证。
3. 移动/复制的目标目录必须是根内**已存在**目录（不隐式创建目标目录）；移动目录入其自身内部被拒绝。
4. 回收站操作不可在无窗口会话中假设成功（Windows 需 Shell 可用）；Linux 无桌面环境时 trash crate 的 FreeDesktop 实现仍可落盘到 `~/.local/share/Trash`。
5. 空相对路径解析为项目根自身；对根的创建/删除/移动一律 `IllegalTarget` 拒绝。
6. 符号链接：删除/移动按"链接本体"处理（悬空链接也算占用）；复制时目录符号链接不递归。
7. 跨盘移动的删源失败注入在测试中用 NTFS deny DELETE ACE（现代 Windows 的 `fs::rename` 对普通打开句柄仍可能成功，打开句柄注入不可靠）；生产语义不受影响。

## 7. 变更记录

- 2026-09-04（阶段 3 / Wave 2a operations 流）：初版。命令表定稿、`workspace:fs-op-done` 负载定稿、事务/撤销/批量语义、回收站限制说明。
