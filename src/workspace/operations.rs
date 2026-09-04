//! 文件操作核心（主实施计划阶段 3，Rust 侧）。
//!
//! 职责边界：
//! - 本模块是**纯逻辑核心**：不引用 `crate::` 下任何模块（可被探针测试
//!   `tests/operations_probe.rs` 以 `#[path]` 独立引入编译），路径边界校验经
//!   [`FileOps::ensure`] 注入（集成时由命令粘合层传入 `workspace::ensure_within_root`
//!   的适配函数），回收站能力经 [`TrashSink`] 注入（桥接 `platform::TrashOps`）；
//! - IPC 命令接线（`workspace.fs.*` 命令 ID、`workspace:fs-op-done` 事件）由主 Agent
//!   统一编写的命令粘合层完成，契约见 `docs/dev/contracts/operations.md`；
//! - 所有操作以"项目根 + 相对路径"表达，相对路径逐分量做名称校验并强制经过
//!   注入的边界校验（纵深防御：核心层拒绝 `..`/绝对路径，符号链接逃逸由注入的
//!   canonicalize 校验拦截）。
//!
//! 事务语义概要（详见契约）：
//! - 创建/重命名/移动/复制：目标重名一律拒绝（不覆盖、不自动改名）；
//! - 移动优先 `rename`（同卷原子），失败降级"复制 + 删除源"：复制中途失败回滚
//!   清理已复制项；复制全部成功但删源失败则回滚目标副本并报错；
//! - 撤销栈支持重命名/移动的逆操作；回收站删除因 trash crate 无还原 API，
//!   撤销时返回 [`OpError::NeedsManualRestore`]（提示用户从系统回收站手动还原）。

// 纯逻辑核心在粘合层接线（主 Agent 集成）前没有生产调用方，与 platform/mod.rs
// 同理允许 dead_code。
#![allow(dead_code)]

use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::json;

// ---------- 错误 ----------

/// 文件操作失败原因（`Display` 均为面向用户的中文描述）。
#[derive(Debug)]
pub enum OpError {
    /// 源路径不存在。
    NotFound(PathBuf),
    /// 目标路径已存在（重名拒绝：不覆盖、不自动改名）。
    AlreadyExists(PathBuf),
    /// 路径越出项目根（核心层分量检查或注入的边界校验拒绝）。
    OutsideRoot {
        /// 项目根。
        root: PathBuf,
        /// 被拒绝的目标路径。
        target: PathBuf,
    },
    /// 名称非法（空、路径分隔符、Windows 保留名、非法字符、末尾点/空格、超长）。
    InvalidName(String),
    /// 该路径不允许执行此操作（如移动/删除/复制项目根自身、移入自身内部）。
    IllegalTarget(PathBuf),
    /// 底层 I/O 错误。
    Io(std::io::Error),
    /// 回收站删除无法自动还原：trash crate 不提供"从回收站还原"API，
    /// 需要用户从系统回收站手动还原到原位置（对应撤销条目已被消耗）。
    NeedsManualRestore {
        /// 删除前的原始路径（提示文案中展示）。
        original_path: PathBuf,
    },
    /// 撤销请求与栈顶不符（撤销必须按后进先出顺序执行）。
    UndoMismatch {
        /// 当前栈顶条目 ID（空栈为 `None`）。
        top: Option<u64>,
        /// 请求撤销的条目 ID。
        requested: u64,
    },
}

impl fmt::Display for OpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpError::NotFound(p) => write!(f, "路径不存在：{}", p.display()),
            OpError::AlreadyExists(p) => write!(f, "同名项目已存在：{}", p.display()),
            OpError::OutsideRoot { root, target } => write!(
                f,
                "路径 {} 超出项目根 {} 的边界，已拒绝操作",
                target.display(),
                root.display()
            ),
            OpError::InvalidName(name) => write!(f, "名称非法：{name}"),
            OpError::IllegalTarget(p) => write!(f, "不允许对 {} 执行该操作", p.display()),
            OpError::Io(err) => write!(f, "文件操作失败：{err}"),
            OpError::NeedsManualRestore { original_path } => write!(
                f,
                "回收站删除无法自动还原（原路径 {}）：请从系统回收站手动还原",
                original_path.display()
            ),
            OpError::UndoMismatch { top, requested } => match top {
                Some(top) => write!(
                    f,
                    "撤销顺序冲突：仅可撤销最近一次操作（当前可撤销 ID {top}，请求 {requested}）"
                ),
                None => write!(f, "撤销栈为空，无可撤销操作（请求 ID {requested}）"),
            },
        }
    }
}

impl std::error::Error for OpError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            OpError::Io(err) => Some(err),
            _ => None,
        }
    }
}

// ---------- 注入点 ----------

/// 路径边界校验函数签名：`(项目根, 目标绝对路径) -> 校验结果`。
///
/// 集成时由命令粘合层传入 `workspace::ensure_within_root` 的适配函数（把
/// `WorkspaceError::OutsideRoot` 映射为 [`OpError::OutsideRoot`]）；测试可注入
/// 恒通过校验或真实实现。使用 `fn` 指针保持核心零捕获、可静态构造。
pub type EnsureFn = fn(&Path, &Path) -> Result<(), OpError>;

/// 回收站能力注入抽象（保持本模块不引用 `crate::` 路径，可独立编译测试）。
///
/// 与 `platform::TrashOps::to_trash` 语义对齐：命令粘合层提供桥接实现（内部转调
/// `platform::trash_ops()` 并把 `PlatformError` 映射为 [`OpError::Io`]）。
pub trait TrashSink {
    /// 把给定绝对路径移入系统回收站/废纸篓。
    fn to_trash(&self, path: &Path) -> Result<(), OpError>;
}

// ---------- 操作描述与回执 ----------

/// 操作类型（`workspace:fs-op-done` 事件 `op` 字段的取值，见契约）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpKind {
    /// 新建文件。
    CreateFile,
    /// 新建文件夹。
    CreateDir,
    /// 重命名。
    Rename,
    /// 移动。
    Move,
    /// 复制。
    Copy,
    /// 移入回收站。
    TrashDelete,
    /// 永久删除。
    PermanentDelete,
    /// 撤销重命名（逆操作）。
    UndoRename,
    /// 撤销移动（逆操作）。
    UndoMove,
}

impl OpKind {
    /// 事件 `op` 字段值（kebab-case）。
    pub fn as_str(&self) -> &'static str {
        match self {
            OpKind::CreateFile => "create-file",
            OpKind::CreateDir => "create-dir",
            OpKind::Rename => "rename",
            OpKind::Move => "move",
            OpKind::Copy => "copy",
            OpKind::TrashDelete => "trash-delete",
            OpKind::PermanentDelete => "permanent-delete",
            OpKind::UndoRename => "undo-rename",
            OpKind::UndoMove => "undo-move",
        }
    }
}

/// 一次操作（正向或撤销）的结果描述，用于事件负载与 UI 回执。
#[derive(Debug, Clone, PartialEq)]
pub struct OpDesc {
    /// 操作类型。
    pub kind: OpKind,
    /// 受影响路径（语义随操作不同，见契约 `docs/dev/contracts/operations.md` §3）。
    pub paths: Vec<PathBuf>,
}

impl OpDesc {
    /// 事件 `op` 字段值。
    pub fn op(&self) -> &'static str {
        self.kind.as_str()
    }

    /// 构造 `workspace:fs-op-done` 事件负载 `{op, paths, undo_id}`。
    ///
    /// `undo_id`：本操作对应的撤销条目 ID，无撤销能力时为 `null`；路径已剥离
    /// Windows verbatim 前缀。
    pub fn event_payload(&self, undo_id: Option<u64>) -> serde_json::Value {
        json!({
            "op": self.op(),
            "paths": self.paths.iter().map(|p| display_path(p)).collect::<Vec<_>>(),
            "undo_id": undo_id,
        })
    }
}

/// 一次成功操作的回执。
#[derive(Debug, Clone, PartialEq)]
pub struct OpResult {
    /// 本次应用的操作描述（粘合层据此发 `workspace:fs-op-done` 事件）。
    pub applied: OpDesc,
    /// 撤销信息；`None` 表示操作不可撤销（新建、复制、永久删除）。
    pub undo: Option<UndoEntry>,
}

/// 可撤销操作的逆操作信息（压入 [`UndoStack`]）。
#[derive(Debug, Clone, PartialEq)]
pub enum UndoEntry {
    /// 重命名：撤销 = 把 `to` 改回 `from`。
    Rename {
        /// 原路径（撤销后的恢复目标）。
        from: PathBuf,
        /// 重命名后的路径。
        to: PathBuf,
    },
    /// 移动：撤销 = 把 `to` 移回 `from`。
    Move {
        /// 原路径（撤销后的恢复目标）。
        from: PathBuf,
        /// 移动后的路径。
        to: PathBuf,
    },
    /// 回收站删除：trash crate 无还原 API，撤销时返回
    /// [`OpError::NeedsManualRestore`]（用户从系统回收站手动还原）。
    RestoreFromTrash {
        /// 删除前的原始路径。
        original_path: PathBuf,
    },
}

// ---------- 操作核心 ----------

/// 文件操作核心入口。
///
/// 用法：`FileOps::new(ensure)` 构造，随后以 `(root, rel_path)` 调用各操作；
/// `root` 为已打开工作区的可信项目根（粘合层取自 `Workspace::root()`），
/// `rel_path` 以 `/` 分隔、相对项目根。
#[derive(Debug, Clone, Copy)]
pub struct FileOps {
    /// 注入的路径边界校验（`(root, target)`），每个操作的每条路径都会经过。
    pub ensure: EnsureFn,
}

impl FileOps {
    /// 以注入的边界校验函数构造操作入口。
    pub fn new(ensure: EnsureFn) -> Self {
        Self { ensure }
    }

    /// 解析相对路径为绝对路径：逐分量名称校验（拒绝 `..`/绝对路径/盘符前缀），
    /// 再强制经过注入的边界校验，最后把已存在的路径统一为 canonical 坐标
    /// （消除大小写与冗余差异，供后续前缀/重名比较使用）。
    ///
    /// 空相对路径解析为项目根自身（各操作自行拒绝对根执行）。
    fn resolve(&self, root: &Path, rel_path: &str) -> Result<PathBuf, OpError> {
        let normalized = normalize_rel(root, rel_path)?;
        if normalized.as_os_str().is_empty() {
            return Ok(root.to_path_buf());
        }
        let target = root.join(&normalized);
        (self.ensure)(root, &target)?;
        // 已存在路径统一 canonical 坐标；不存在（新建目标）保持拼接结果
        if let Ok(canonical) = target.canonicalize() {
            return Ok(canonical);
        }
        Ok(target)
    }

    /// 新建文件：无扩展名自动补 `.md`（点开头的隐藏文件视作无扩展名，同样补齐）；
    /// 重名（文件/目录）拒绝。父目录必须已存在（与 `ensure_within_root` 的
    /// "仅末段允许不存在"语义一致；项目树的新建文件总是发生在已有目录内）。
    pub fn create_file(&self, root: &Path, rel_path: &str) -> Result<OpResult, OpError> {
        let base = self.resolve(root, rel_path)?;
        if base == root {
            return Err(OpError::IllegalTarget(root.to_path_buf()));
        }
        let name = base
            .file_name()
            .ok_or_else(|| OpError::InvalidName(rel_path.to_string()))?
            .to_string_lossy()
            .into_owned();
        // 补扩展名后重名校验用最终名
        let target = if Path::new(&name).extension().is_none() {
            base.with_extension("md")
        } else {
            base
        };
        if entry_exists(&target) {
            return Err(OpError::AlreadyExists(target));
        }
        fs::write(&target, b"").map_err(OpError::Io)?;
        Ok(OpResult {
            applied: OpDesc {
                kind: OpKind::CreateFile,
                paths: vec![target],
            },
            undo: None,
        })
    }

    /// 新建文件夹：重名（目录/文件）拒绝；支持一次创建多层——逐层经过注入的
    /// 边界校验后再创建，任一层重名（或被同名文件阻挡）即拒绝。
    pub fn create_dir(&self, root: &Path, rel_path: &str) -> Result<OpResult, OpError> {
        let normalized = normalize_rel(root, rel_path)?;
        if normalized.as_os_str().is_empty() {
            return Err(OpError::IllegalTarget(root.to_path_buf()));
        }
        let total = normalized.iter().count();
        let mut current = root.to_path_buf();
        for (idx, name) in normalized.iter().enumerate() {
            current.push(name);
            // 逐层校验：中间层此时已存在（或刚由上一层创建），ensure 的
            // canonicalize 语义完整生效；仅末段是待创建的新路径
            (self.ensure)(root, &current)?;
            let last = idx + 1 == total;
            if entry_exists(&current) {
                if last || !is_dir_entry(&current) {
                    return Err(OpError::AlreadyExists(current));
                }
                continue;
            }
            fs::create_dir(&current).map_err(OpError::Io)?;
        }
        Ok(OpResult {
            applied: OpDesc {
                kind: OpKind::CreateDir,
                paths: vec![current],
            },
            undo: None,
        })
    }

    /// 重命名（仅改末段名称，不改变父目录）：目标重名拒绝、非法名拒绝；
    /// 仅大小写变化的重命名允许（大小写不敏感文件系统上 canonical 判等后放行）。
    pub fn rename(&self, root: &Path, rel_path: &str, new_name: &str) -> Result<OpResult, OpError> {
        let source = self.resolve(root, rel_path)?;
        if source == root {
            return Err(OpError::IllegalTarget(root.to_path_buf()));
        }
        if !entry_exists(&source) {
            return Err(OpError::NotFound(source));
        }
        validate_name(new_name)?;
        let parent = source
            .parent()
            .ok_or_else(|| OpError::IllegalTarget(source.clone()))?;
        let target = parent.join(new_name);
        (self.ensure)(root, &target)?;
        if entry_exists(&target) && !same_entry(&source, &target) {
            return Err(OpError::AlreadyExists(target));
        }
        fs::rename(&source, &target).map_err(OpError::Io)?;
        Ok(OpResult {
            applied: OpDesc {
                kind: OpKind::Rename,
                paths: vec![source.clone(), target.clone()],
            },
            undo: Some(UndoEntry::Rename {
                from: source,
                to: target,
            }),
        })
    }

    /// 移动（剪切粘贴 / 拖放移动）：把 `rel_path` 移入**已存在**的目标目录
    /// `dest_rel_dir` 下（保持原名）。
    ///
    /// 同卷走原子 `rename`；跨卷（或 rename 失败）自动降级"复制 + 删除源"：
    /// 复制任一步失败 → 清理已复制项（回滚）；复制全部成功但删源失败 →
    /// 回滚目标副本并报错（尽力而为，数据不丢失也不重复）。目标重名拒绝；
    /// 禁止把目录移入其自身内部；项目根自身不可移动。
    pub fn move_entry(
        &self,
        root: &Path,
        rel_path: &str,
        dest_rel_dir: &str,
    ) -> Result<OpResult, OpError> {
        let source = self.resolve(root, rel_path)?;
        let dest_dir = self.resolve(root, dest_rel_dir)?;
        require_deletable_entry(&source, root)?;
        require_dest_dir(&dest_dir)?;
        let name = source
            .file_name()
            .ok_or_else(|| OpError::IllegalTarget(source.clone()))?;
        let target = dest_dir.join(name);
        (self.ensure)(root, &target)?;
        reject_colliding_target(&source, &target)?;
        move_path(&source, &target)?;
        Ok(OpResult {
            applied: OpDesc {
                kind: OpKind::Move,
                paths: vec![source.clone(), target.clone()],
            },
            undo: Some(UndoEntry::Move {
                from: source,
                to: target,
            }),
        })
    }

    /// 复制（Ctrl+拖放 / 复制粘贴）：把 `rel_path` 复制到**已存在**目标目录
    /// `dest_rel_dir` 下（保持原名）。
    ///
    /// 目标重名拒绝（不覆盖、不自动改名——避免静默覆盖用户数据，契约约定）；
    /// 目录递归复制（目录符号链接不递归，按文件复制其目标内容）；复制中途失败
    /// 清理已复制项。复制不产生撤销条目。
    pub fn copy_entry(
        &self,
        root: &Path,
        rel_path: &str,
        dest_rel_dir: &str,
    ) -> Result<OpResult, OpError> {
        let source = self.resolve(root, rel_path)?;
        let dest_dir = self.resolve(root, dest_rel_dir)?;
        require_deletable_entry(&source, root)?;
        require_dest_dir(&dest_dir)?;
        let name = source
            .file_name()
            .ok_or_else(|| OpError::IllegalTarget(source.clone()))?;
        let target = dest_dir.join(name);
        (self.ensure)(root, &target)?;
        reject_colliding_target(&source, &target)?;
        copy_tree_rollback_on_error(&source, &target)?;
        Ok(OpResult {
            applied: OpDesc {
                kind: OpKind::Copy,
                paths: vec![source, target],
            },
            undo: None,
        })
    }

    /// 永久删除（Shift+Delete，前端须先二次确认）：文件用 `remove_file`、
    /// 目录递归 `remove_dir_all`（只读文件清除只读位后重试）。不可撤销。
    pub fn delete_permanently(&self, root: &Path, rel_path: &str) -> Result<OpResult, OpError> {
        let target = self.resolve(root, rel_path)?;
        require_deletable_entry(&target, root)?;
        remove_path(&target).map_err(OpError::Io)?;
        Ok(OpResult {
            applied: OpDesc {
                kind: OpKind::PermanentDelete,
                paths: vec![target],
            },
            undo: None,
        })
    }

    /// 移入系统回收站（可还原语义由系统保证；Windows 走 Shell IFileOperation，
    /// 资源管理器中可"还原"）。
    ///
    /// 撤销限制：trash crate 不提供"从回收站还原"API，本操作的撤销条目在撤销时
    /// 返回 [`OpError::NeedsManualRestore`]，由前端提示用户从系统回收站手动还原。
    pub fn to_trash(
        &self,
        root: &Path,
        rel_path: &str,
        trash: &dyn TrashSink,
    ) -> Result<OpResult, OpError> {
        let target = self.resolve(root, rel_path)?;
        require_deletable_entry(&target, root)?;
        trash.to_trash(&target)?;
        Ok(OpResult {
            applied: OpDesc {
                kind: OpKind::TrashDelete,
                paths: vec![target.clone()],
            },
            undo: Some(UndoEntry::RestoreFromTrash {
                original_path: target,
            }),
        })
    }
}

// ---------- 撤销栈 ----------

/// 撤销栈（严格后进先出；`undo_id` 从 1 起单调递增，供
/// `workspace:fs-op-done` 事件与前端对账）。
#[derive(Debug, Default)]
pub struct UndoStack {
    entries: Vec<(u64, UndoEntry)>,
    next_id: u64,
}

impl UndoStack {
    /// 空栈。
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            next_id: 1,
        }
    }

    /// 压入撤销条目并分配 `undo_id`。
    pub fn push(&mut self, entry: UndoEntry) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.entries.push((id, entry));
        id
    }

    /// 弹出栈顶撤销条目（不执行逆操作）。
    pub fn pop(&mut self) -> Option<(u64, UndoEntry)> {
        self.entries.pop()
    }

    /// 栈顶条目 ID（前端 Ctrl+Z 场景取 `undo_id` 用）。
    pub fn peek_top_id(&self) -> Option<u64> {
        self.entries.last().map(|(id, _)| *id)
    }

    /// 栈内条目数。
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 栈是否为空。
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 撤销指定条目：必须是当前栈顶（严格 LIFO），否则返回
    /// [`OpError::UndoMismatch`]（栈不变）。
    ///
    /// 语义：
    /// - [`UndoEntry::Rename`] / [`UndoEntry::Move`]：执行逆操作，成功后条目消耗，
    ///   返回 [`OpDesc`]（kind 为 [`OpKind::UndoRename`] / [`OpKind::UndoMove`]）；
    ///   逆操作失败（如恢复目标已被占用）时条目**保留栈顶**，允许排除障碍后重试；
    /// - [`UndoEntry::RestoreFromTrash`]：不执行任何文件操作，返回
    ///   [`OpError::NeedsManualRestore`]，条目消耗（还原由用户在系统回收站完成）。
    pub fn undo(&mut self, requested_id: u64) -> Result<OpDesc, OpError> {
        let Some((id, entry)) = self.entries.pop() else {
            return Err(OpError::UndoMismatch {
                top: None,
                requested: requested_id,
            });
        };
        if id != requested_id {
            self.entries.push((id, entry));
            return Err(OpError::UndoMismatch {
                top: Some(id),
                requested: requested_id,
            });
        }
        match Self::apply_undo(entry.clone()) {
            Ok(desc) => Ok(desc),
            Err(err @ OpError::NeedsManualRestore { .. }) => Err(err),
            // 执行失败：条目放回栈顶，可重试
            Err(err) => {
                self.entries.push((id, entry));
                Err(err)
            }
        }
    }

    /// 执行单条逆操作。
    fn apply_undo(entry: UndoEntry) -> Result<OpDesc, OpError> {
        match entry {
            UndoEntry::Rename { from, to } => {
                restore_path(&to, &from)?;
                move_path(&to, &from)?;
                Ok(OpDesc {
                    kind: OpKind::UndoRename,
                    paths: vec![from, to],
                })
            }
            UndoEntry::Move { from, to } => {
                restore_path(&to, &from)?;
                move_path(&to, &from)?;
                Ok(OpDesc {
                    kind: OpKind::UndoMove,
                    paths: vec![from, to],
                })
            }
            UndoEntry::RestoreFromTrash { original_path } => {
                Err(OpError::NeedsManualRestore { original_path })
            }
        }
    }
}

// ---------- 内部工具 ----------

/// 相对路径的逐分量校验与规范化：拒绝 `..`/绝对路径/盘符前缀（纵深防御第一层，
/// 符号链接逃逸由注入的 canonicalize 校验拦截）；`.` 冗余分量跳过。
/// 空相对路径返回空 `PathBuf`（各操作自行决定对根自身的处理）。
fn normalize_rel(root: &Path, rel_path: &str) -> Result<PathBuf, OpError> {
    let rel = Path::new(rel_path);
    let mut normalized = PathBuf::new();
    for component in rel.components() {
        match component {
            Component::Normal(name) => {
                validate_name(&name.to_string_lossy())?;
                normalized.push(name);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(OpError::OutsideRoot {
                    root: root.to_path_buf(),
                    target: rel.to_path_buf(),
                });
            }
        }
    }
    Ok(normalized)
}

/// 撤销前置检查：恢复目标 `to`（当前所在位置）必须存在、恢复终点 `from`
/// 必须未被占用（不覆盖）。
fn restore_path(to: &Path, from: &Path) -> Result<(), OpError> {
    if entry_exists(from) {
        return Err(OpError::AlreadyExists(from.to_path_buf()));
    }
    if !entry_exists(to) {
        return Err(OpError::NotFound(to.to_path_buf()));
    }
    Ok(())
}

/// 源/删除目标通用检查：不能是项目根自身，且必须存在。
fn require_deletable_entry(target: &Path, root: &Path) -> Result<(), OpError> {
    if target == root {
        return Err(OpError::IllegalTarget(root.to_path_buf()));
    }
    if !entry_exists(target) {
        return Err(OpError::NotFound(target.to_path_buf()));
    }
    Ok(())
}

/// 移动/复制的目标目录检查：必须存在且是目录。
fn require_dest_dir(dest_dir: &Path) -> Result<(), OpError> {
    if dest_dir.is_dir() {
        return Ok(());
    }
    if entry_exists(dest_dir) {
        return Err(OpError::IllegalTarget(dest_dir.to_path_buf()));
    }
    Err(OpError::NotFound(dest_dir.to_path_buf()))
}

/// 移动/复制的落点检查：目标已存在则重名拒绝（大小写不敏感文件系统上，
/// 与源 canonical 判等的同一实体除外——该场景仅出现在大小写变更，由
/// [`FileOps::rename`] 单独处理，move/copy 保持原名必然重名）；禁止把目录
/// 落进其自身内部（递归死循环）。
fn reject_colliding_target(source: &Path, target: &Path) -> Result<(), OpError> {
    if entry_exists(target) {
        return Err(OpError::AlreadyExists(target.to_path_buf()));
    }
    if is_dir_entry(source) && target.starts_with(source) {
        return Err(OpError::IllegalTarget(target.to_path_buf()));
    }
    Ok(())
}

/// 移动路径：优先同卷原子 `rename`，失败降级"复制 + 删除源"（复制失败自动回滚）。
fn move_path(from: &Path, to: &Path) -> Result<(), OpError> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_tree_rollback_on_error(from, to)?;
    // 复制全部成功后删除源；删除失败则回滚目标副本（尽力而为），保证失败时
    // "数据要么在源、要么在目标"，不丢失也不重复。
    if let Err(delete_err) = remove_path(from) {
        let _ = remove_path(to);
        return Err(OpError::Io(delete_err));
    }
    Ok(())
}

/// 复制一棵树（文件或目录）到 `to`；复制中途任一步失败时，按后进先出清理
/// 全部已复制项（回滚到操作前状态），返回首个复制错误。
///
/// 回滚清理尽力而为：个别项清理失败时不掩盖复制错误（目标可能残留部分副本）。
fn copy_tree_rollback_on_error(from: &Path, to: &Path) -> Result<(), OpError> {
    let mut copied: Vec<PathBuf> = Vec::new();
    match copy_tree(from, to, &mut copied) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = remove_copied(&copied);
            Err(err)
        }
    }
}

/// 递归复制（显式记录每个新建项供回滚）：目录符号链接不递归、按文件复制其
/// 目标内容；递归深度受文件系统目录深度约束，普通项目树安全。
fn copy_tree(from: &Path, to: &Path, copied: &mut Vec<PathBuf>) -> Result<(), OpError> {
    let meta = fs::symlink_metadata(from).map_err(OpError::Io)?;
    if meta.is_dir() {
        fs::create_dir(to).map_err(OpError::Io)?;
        copied.push(to.to_path_buf());
        for entry in fs::read_dir(from).map_err(OpError::Io)? {
            let entry = entry.map_err(OpError::Io)?;
            copy_tree(&entry.path(), &to.join(entry.file_name()), copied)?;
        }
        Ok(())
    } else {
        fs::copy(from, to).map_err(OpError::Io)?;
        copied.push(to.to_path_buf());
        Ok(())
    }
}

/// 倒序清理已复制项；单项失败继续清理其余项，返回首个清理错误。
fn remove_copied(copied: &[PathBuf]) -> Option<std::io::Error> {
    let mut first_err = None;
    for path in copied.iter().rev() {
        if let Err(err) = remove_path(path) {
            if first_err.is_none() {
                first_err = Some(err);
            }
        }
    }
    first_err
}

/// 删除文件或目录树：目录用 `remove_dir_all`；文件删除失败且带只读位时
/// （Windows 常见）清只读位后重试一次。
fn remove_path(path: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() {
        return fs::remove_dir_all(path);
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let mut perms = meta.permissions();
            if perms.readonly() {
                perms.set_readonly(false);
                if fs::set_permissions(path, perms).is_ok() {
                    return fs::remove_file(path);
                }
            }
            Err(err)
        }
    }
}

/// 路径存在性（不跟随符号链接：指向已删除目标的悬空链接也算"占用"）。
fn entry_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// 是否为真实目录（目录符号链接按文件处理，不递归）。
fn is_dir_entry(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.is_dir())
        .unwrap_or(false)
}

/// 两路径是否指向同一实体（大小写不敏感文件系统上大小写变更场景的判等）。
fn same_entry(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => false,
    }
}

/// 校验单个名称分量（以 Windows 规则为下限、全平台统一应用）：
/// 非空、不含路径分隔符与非法字符、非 Windows 保留名（含带扩展名形式）、
/// 不以点/空格结尾、长度 ≤ 255。
fn validate_name(name: &str) -> Result<(), OpError> {
    const ILLEGAL_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    const RESERVED_STEMS: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if name.is_empty() || name == "." || name == ".." {
        return Err(OpError::InvalidName(name.to_string()));
    }
    if name
        .chars()
        .any(|c| c.is_control() || ILLEGAL_CHARS.contains(&c))
    {
        return Err(OpError::InvalidName(name.to_string()));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(OpError::InvalidName(name.to_string()));
    }
    // 保留名判定取第一个点之前的主名（如 CON.md 同样非法）
    let stem = name.split('.').next().unwrap_or("");
    if RESERVED_STEMS.contains(&stem.to_ascii_uppercase().as_str()) {
        return Err(OpError::InvalidName(name.to_string()));
    }
    if name.chars().count() > 255 {
        return Err(OpError::InvalidName(name.to_string()));
    }
    Ok(())
}

/// 剥离 Windows verbatim 前缀（`\\?\` / `\\?\UNC\`），得到常规可读路径文本
/// （事件负载用；与 `workspace::display_path` 语义一致，独立实现以保持零
/// `crate::` 依赖）。
fn display_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.to_string()
    }
}
