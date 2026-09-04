//! 文件操作核心（`src/workspace/operations.rs`）的对外集成测试（主实施计划阶段 3）。
//!
//! 纯 bin crate：`operations.rs` 被主 Agent 集成进 `workspace/mod.rs`（`pub mod` 声明）
//! 之前，src 侧 `#[cfg(test)]` 不会被收集，因此这里用 `#[path]` 直接引入模块源码
//! 作为独立测试载体（与 `tests/platform_probe.rs` 同款探针模式）。文件长期保留，
//! 充当文件操作核心的行为契约。
//!
//! 【边界校验注入的取舍说明】任务优先方案是 `#[path = "../src/workspace/mod.rs"]`
//! 引入真实的 `ensure_within_root`，但 `workspace/mod.rs` 的 `pub mod events;` 会
//! 连带编译 `events.rs`，其中 `use crate::ipc;` 与 `use wry::WebView;` 在本探针
//! crate 中无法解析（纯 bin crate 的传导性编译失败风险），故按预案改用**自写
//! 校验闭包**：[`probe_ensure`] 逐行复刻 `ensure_within_root` 的语义（两端规范化 +
//! 逐组件前缀比较，尚不存在的新路径按"父目录规范化 + 末段拼接"），并另测一条
//! "拒绝一切"的注入以证明核心确实把边界校验委托给注入函数。集成后生产路径使用
//! 真实 `ensure_within_root`，其自身语义由 `workspace/mod.rs` 的单元测试守护。
//!
//! 测试纪律：临时目录造树、逐项断言、结束清理；除标注 `#[ignore]` 的真实回收站
//! 冒烟外，不触碰系统回收站。

#[path = "../src/workspace/operations.rs"]
mod operations;

#[path = "../src/platform/mod.rs"]
mod platform;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use operations::{FileOps, OpDesc, OpError, OpKind, UndoEntry, UndoStack};

// ---------- 测试基建 ----------

static SEQ: AtomicUsize = AtomicUsize::new(0);

/// 进程内唯一的临时根目录。
fn temp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "glancemd-ultra-ops-{}-{}-{}",
        std::process::id(),
        tag,
        SEQ.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn cleanup(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

/// 复刻 `workspace::ensure_within_root` 语义的边界校验（取舍说明见文件头）。
fn probe_ensure(root: &Path, target: &Path) -> Result<(), OpError> {
    let root_canonical = root.canonicalize().map_err(OpError::Io)?;
    let target_canonical = canonicalize_lenient(target)?;
    if !target_canonical.starts_with(&root_canonical) {
        return Err(OpError::OutsideRoot {
            root: root.to_path_buf(),
            target: target.to_path_buf(),
        });
    }
    Ok(())
}

fn canonicalize_lenient(target: &Path) -> Result<PathBuf, OpError> {
    if let Ok(canonical) = target.canonicalize() {
        return Ok(canonical);
    }
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| OpError::NotFound(target.to_path_buf()))?;
    let mut resolved = parent.canonicalize().map_err(OpError::Io)?;
    if let Some(name) = target.file_name() {
        resolved.push(name);
    }
    Ok(resolved)
}

/// 拒绝一切的边界校验（验证核心把校验委托给注入函数）。
fn rejecting_ensure(root: &Path, target: &Path) -> Result<(), OpError> {
    Err(OpError::OutsideRoot {
        root: root.to_path_buf(),
        target: target.to_path_buf(),
    })
}

fn ops() -> FileOps {
    FileOps::new(probe_ensure)
}

/// 记录型假回收站（不真删文件，只记录请求；撤销链路测试用）。
#[derive(Debug, Default)]
struct RecordingTrashSink {
    deleted: std::sync::Mutex<Vec<PathBuf>>,
}

impl operations::TrashSink for RecordingTrashSink {
    fn to_trash(&self, path: &Path) -> Result<(), OpError> {
        self.deleted.lock().unwrap().push(path.to_path_buf());
        Ok(())
    }
}

/// 桥接 `platform::trash_ops()` 的真回收站（#[ignore] 冒烟用；与集成时命令
/// 粘合层提供的 TrashSink 实现同构）。
struct PlatformTrashBridge;

impl operations::TrashSink for PlatformTrashBridge {
    fn to_trash(&self, path: &Path) -> Result<(), OpError> {
        platform::trash_ops()
            .to_trash(path)
            .map_err(|err| OpError::Io(std::io::Error::other(err.to_string())))
    }
}

// ---------- 新建文件 ----------

#[test]
fn 新建文件_无扩展名自动补_md() {
    let root = temp_root("create-md");
    let result = ops().create_file(&root, "笔记").unwrap();
    let target = root.join("笔记.md");
    assert!(target.exists(), "应创建 笔记.md");
    assert_eq!(
        std::fs::read(&target).unwrap(),
        Vec::<u8>::new(),
        "新文件应为空"
    );
    assert_eq!(result.applied.op(), "create-file");
    assert_eq!(result.applied.paths, vec![target.clone()]);
    assert!(result.undo.is_none(), "新建不可撤销");
    cleanup(&root);
}

#[test]
fn 新建文件_带扩展名保持原样_父目录须已存在() {
    let root = temp_root("create-ext");
    // 父目录必须已存在（与 ensure_within_root 的"仅末段允许不存在"语义一致，
    // 项目树的新建文件总是发生在已有目录内）
    std::fs::create_dir(root.join("notes")).unwrap();
    ops().create_file(&root, "notes/已存在扩展名.txt").unwrap();
    let target = root.join("notes").join("已存在扩展名.txt");
    assert!(target.exists(), "带扩展名不应再追加 .md");
    // 父目录不存在时拒绝（不隐式创建）
    match ops().create_file(&root, "不存在目录/新文件.md") {
        Err(OpError::Io(err)) => assert_eq!(err.kind(), std::io::ErrorKind::NotFound),
        other => panic!("期望 Io(NotFound)，实际 {other:?}"),
    }
    cleanup(&root);
}

#[test]
fn 新建文件_重名拒绝() {
    let root = temp_root("create-dup");
    ops().create_file(&root, "a.md").unwrap();
    match ops().create_file(&root, "a.md") {
        Err(OpError::AlreadyExists(p)) => {
            // 已存在路径经 resolve 统一为 canonical 坐标
            assert_eq!(p, root.join("a.md").canonicalize().unwrap());
        }
        other => panic!("期望 AlreadyExists，实际 {other:?}"),
    }
    // 与已有目录重名拒绝（目录名带扩展名，避开自动补名改变比较目标）
    std::fs::create_dir(root.join("已占用.md")).unwrap();
    assert!(matches!(
        ops().create_file(&root, "已占用.md"),
        Err(OpError::AlreadyExists(_))
    ));
    cleanup(&root);
}

// ---------- 新建文件夹 ----------

#[test]
fn 新建文件夹_支持多层与重名拒绝() {
    let root = temp_root("mkdir");
    let result = ops().create_dir(&root, "a/b/c").unwrap();
    assert!(root.join("a").join("b").join("c").is_dir());
    assert_eq!(result.applied.op(), "create-dir");
    assert!(result.undo.is_none());

    assert!(matches!(
        ops().create_dir(&root, "a/b/c"),
        Err(OpError::AlreadyExists(_))
    ));
    // 与已有文件重名拒绝
    ops().create_file(&root, "file.md").unwrap();
    assert!(matches!(
        ops().create_dir(&root, "file.md"),
        Err(OpError::AlreadyExists(_))
    ));
    cleanup(&root);
}

// ---------- 重命名 ----------

#[test]
fn 重命名_成功后撤销往返() {
    let root = temp_root("rename");
    std::fs::write(root.join("旧名.md"), "# 内容").unwrap();
    let result = ops().rename(&root, "旧名.md", "新名.md").unwrap();
    assert!(root.join("新名.md").exists());
    assert!(!root.join("旧名.md").exists());
    assert_eq!(result.applied.op(), "rename");

    // 撤销：文件应回到原名且内容不丢
    let mut stack = UndoStack::new();
    let id = stack.push(result.undo.unwrap());
    let desc = stack.undo(id).unwrap();
    assert_eq!(desc.op(), "undo-rename");
    assert!(root.join("旧名.md").exists(), "撤销后应恢复原名");
    assert!(!root.join("新名.md").exists(), "撤销后新名应消失");
    assert_eq!(
        std::fs::read_to_string(root.join("旧名.md")).unwrap(),
        "# 内容"
    );
    assert!(stack.is_empty(), "撤销条目应被消耗");
    cleanup(&root);
}

#[test]
fn 重命名_重名拒绝与非法名拒绝() {
    let root = temp_root("rename-dup");
    std::fs::write(root.join("a.md"), "a").unwrap();
    std::fs::write(root.join("b.md"), "b").unwrap();
    // 目标重名拒绝
    assert!(matches!(
        ops().rename(&root, "a.md", "b.md"),
        Err(OpError::AlreadyExists(_))
    ));
    // Windows 保留名（含带扩展名形式）
    assert!(matches!(
        ops().rename(&root, "a.md", "CON.md"),
        Err(OpError::InvalidName(_))
    ));
    // 非法字符 / 末尾点
    assert!(matches!(
        ops().rename(&root, "a.md", "bad<name.md"),
        Err(OpError::InvalidName(_))
    ));
    assert!(matches!(
        ops().rename(&root, "a.md", "末尾点."),
        Err(OpError::InvalidName(_))
    ));
    // 源不存在
    assert!(matches!(
        ops().rename(&root, "缺失.md", "x.md"),
        Err(OpError::NotFound(_))
    ));
    cleanup(&root);
}

// ---------- 移动 ----------

#[test]
fn 移动_目录递归后撤销往返() {
    let root = temp_root("move-dir");
    std::fs::create_dir_all(root.join("笔记").join("子")).unwrap();
    std::fs::write(root.join("笔记").join("a.md"), "A").unwrap();
    std::fs::write(root.join("笔记").join("子").join("b.md"), "B").unwrap();
    std::fs::create_dir(root.join("归档")).unwrap();

    let result = ops().move_entry(&root, "笔记", "归档").unwrap();
    let moved = root.join("归档").join("笔记");
    assert!(moved.join("a.md").exists(), "子文件应随目录递归移动");
    assert!(
        moved.join("子").join("b.md").exists(),
        "嵌套目录应随移动保留"
    );
    assert!(!root.join("笔记").exists(), "源目录应消失");
    assert_eq!(result.applied.op(), "move");

    // 撤销移动：整棵树回到原位
    let mut stack = UndoStack::new();
    let id = stack.push(result.undo.unwrap());
    let desc = stack.undo(id).unwrap();
    assert_eq!(desc.op(), "undo-move");
    assert!(root.join("笔记").join("a.md").exists());
    assert!(root.join("笔记").join("子").join("b.md").exists());
    assert!(!moved.exists());
    cleanup(&root);
}

#[test]
fn 移动_目标重名拒绝_目标目录不存在拒绝_移入自身拒绝() {
    let root = temp_root("move-guard");
    std::fs::write(root.join("a.md"), "a").unwrap();
    std::fs::create_dir(root.join("dst")).unwrap();
    std::fs::write(root.join("dst").join("a.md"), "占位").unwrap();
    // 目标重名拒绝（不覆盖）
    assert!(matches!(
        ops().move_entry(&root, "a.md", "dst"),
        Err(OpError::AlreadyExists(_))
    ));
    // 目标目录不存在
    assert!(matches!(
        ops().move_entry(&root, "a.md", "不存在的目录"),
        Err(OpError::NotFound(_))
    ));
    // 目标路径是文件而非目录
    assert!(matches!(
        ops().move_entry(&root, "a.md", "a.md"),
        Err(OpError::IllegalTarget(_))
    ));
    // 把目录移入其自身内部
    std::fs::create_dir(root.join("outer")).unwrap();
    assert!(matches!(
        ops().move_entry(&root, "outer", "outer"),
        Err(OpError::IllegalTarget(_))
    ));
    cleanup(&root);
}

// ---------- 复制 ----------

#[test]
fn 复制_文件与目录递归_目标重名拒绝() {
    let root = temp_root("copy");
    std::fs::create_dir_all(root.join("src").join("sub")).unwrap();
    std::fs::write(root.join("src").join("a.md"), "A").unwrap();
    std::fs::write(root.join("src").join("sub").join("b.md"), "B").unwrap();
    std::fs::create_dir(root.join("dst")).unwrap();

    // 文件复制
    let result = ops().copy_entry(&root, "src/a.md", "dst").unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("dst").join("a.md")).unwrap(),
        "A"
    );
    assert_eq!(result.applied.op(), "copy");
    assert!(result.undo.is_none(), "复制不产生撤销条目");

    // 目录递归复制（源保持原位）
    ops().copy_entry(&root, "src", "dst").unwrap();
    let copied = root.join("dst").join("src");
    assert!(copied.join("a.md").exists());
    assert!(copied.join("sub").join("b.md").exists());
    assert!(root.join("src").join("a.md").exists(), "源应保持原位");

    // 目标重名拒绝
    assert!(matches!(
        ops().copy_entry(&root, "src", "dst"),
        Err(OpError::AlreadyExists(_))
    ));
    // 目标目录不存在拒绝
    assert!(matches!(
        ops().copy_entry(&root, "src", "无此目录"),
        Err(OpError::NotFound(_))
    ));
    cleanup(&root);
}

#[cfg(target_os = "windows")]
#[test]
fn 复制_中途失败回滚_已复制项被清理() {
    // 注入失败点：源目录第二个文件以独占句柄打开（share_mode=0），
    // fs::copy 读取源失败 → 复制中止 → 已复制项必须全部清理。
    use std::os::windows::fs::OpenOptionsExt;
    let root = temp_root("copy-rollback");
    std::fs::create_dir(root.join("src")).unwrap();
    std::fs::write(root.join("src").join("a.txt"), "A").unwrap();
    std::fs::write(root.join("src").join("locked.txt"), "LOCKED").unwrap();
    std::fs::create_dir(root.join("dst")).unwrap();

    let _guard = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(root.join("src").join("locked.txt"))
        .unwrap();

    let result = ops().copy_entry(&root, "src", "dst");
    assert!(
        matches!(result, Err(OpError::Io(_))),
        "应因独占句柄失败：{result:?}"
    );
    assert!(
        !root.join("dst").join("src").exists(),
        "已复制项应被回滚清理"
    );
    assert!(root.join("src").join("a.txt").exists(), "源不应受影响");
    assert!(root.join("src").join("locked.txt").exists(), "源不应受影响");
    drop(_guard);
    cleanup(&root);
}

#[cfg(unix)]
#[test]
fn 复制_中途失败回滚_已复制项被清理_unix() {
    // 注入失败点：源文件去读权限（0o000），fs::copy 读取失败 → 回滚。
    use std::os::unix::fs::PermissionsExt;
    let root = temp_root("copy-rollback");
    std::fs::create_dir(root.join("src")).unwrap();
    std::fs::write(root.join("src").join("a.txt"), "A").unwrap();
    let locked = root.join("src").join("locked.txt");
    std::fs::write(&locked, "LOCKED").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    std::fs::create_dir(root.join("dst")).unwrap();

    let result = ops().copy_entry(&root, "src", "dst");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(result.is_err(), "应因无读权限失败：{result:?}");
    assert!(
        !root.join("dst").join("src").exists(),
        "已复制项应被回滚清理"
    );
    cleanup(&root);
}

#[cfg(target_os = "windows")]
/// 给文件加显式 deny DELETE 的 ACE（icacls 特定权限写法 `DE`=Delete，
/// SID 直接写法避免本地化组名差异；只拒删除、不影响读写，供降级路径注入）。
fn deny_delete_ace(path: &Path) {
    let status = std::process::Command::new("icacls")
        .arg(path)
        .args(["/deny", "*S-1-1-0:(DE)"])
        .status()
        .expect("icacls 启动失败");
    assert!(status.success(), "icacls 拒绝 DELETE 权限失败");
}

#[cfg(target_os = "windows")]
/// 移除文件的 deny ACE（尽力而为；幂等）。
fn remove_deny_ace(path: &Path) {
    let _ = std::process::Command::new("icacls")
        .arg(path)
        .args(["/remove:d", "*S-1-1-0"])
        .status();
}

#[cfg(target_os = "windows")]
#[test]
fn 移动_降级复制后删源失败_回滚目标副本() {
    // 跨盘移动 = 复制后删除 + 失败回滚。注入方式：icacls 给源文件加显式
    // deny DELETE ACE（现代 Windows 上 rename 对普通打开句柄仍可能成功，
    // 打开句柄注入不可靠）→ 同卷 rename（需要 DELETE 访问权）失败 →
    // 降级复制（只需读权限）成功 → 删除源失败 → 目标副本必须被回滚、
    // 报错、源原样保留。
    let root = temp_root("move-rollback");
    std::fs::create_dir(root.join("dst")).unwrap();
    let source = root.join("报表.md");
    std::fs::write(&source, "# 报表内容").unwrap();
    deny_delete_ace(&source);

    let result = ops().move_entry(&root, "报表.md", "dst");
    assert!(
        matches!(result, Err(OpError::Io(_))),
        "应在删源一步失败：{result:?}"
    );
    assert!(source.exists(), "源应原样保留");
    assert_eq!(
        std::fs::read_to_string(&source).unwrap(),
        "# 报表内容",
        "源内容不应受影响"
    );
    assert!(
        !root.join("dst").join("报表.md").exists(),
        "目标副本应被回滚"
    );

    // 解除拒绝后同一移动应成功（失败可重试语义）
    remove_deny_ace(&source);
    ops().move_entry(&root, "报表.md", "dst").unwrap();
    assert!(root.join("dst").join("报表.md").exists());
    assert!(!source.exists());
    cleanup(&root);
}

// ---------- 永久删除 ----------

#[test]
fn 永久删除_文件与目录树_不可撤销() {
    let root = temp_root("delete");
    std::fs::write(root.join("note.md"), "x").unwrap();
    std::fs::create_dir_all(root.join("tree").join("deep")).unwrap();
    std::fs::write(root.join("tree").join("deep").join("d.md"), "x").unwrap();

    let result = ops().delete_permanently(&root, "note.md").unwrap();
    assert!(!root.join("note.md").exists());
    assert_eq!(result.applied.op(), "permanent-delete");
    assert!(result.undo.is_none(), "永久删除不可撤销");

    ops().delete_permanently(&root, "tree").unwrap();
    assert!(!root.join("tree").exists(), "目录应递归删除");

    // 重复删除报 NotFound
    assert!(matches!(
        ops().delete_permanently(&root, "note.md"),
        Err(OpError::NotFound(_))
    ));
    cleanup(&root);
}

// ---------- 路径边界 ----------

#[test]
fn 越界相对路径拒绝() {
    let root = temp_root("boundary");
    // `..` 穿越在核心层分量检查即被拒绝（纵深防御第一层）
    assert!(matches!(
        ops().create_file(&root, "../逃逸.md"),
        Err(OpError::OutsideRoot { .. })
    ));
    assert!(matches!(
        ops().create_file(&root, "a/../../逃逸.md"),
        Err(OpError::OutsideRoot { .. })
    ));
    assert!(matches!(
        ops().move_entry(&root, "../外部.md", "."),
        Err(OpError::OutsideRoot { .. })
    ));
    // 逃逸路径没有实际写入
    let parent = root.parent().unwrap();
    assert!(!parent.join("逃逸.md").exists(), "不得在根外产生文件");
    cleanup(&root);
}

#[test]
fn 边界校验经注入委托_拒绝型注入阻断一切操作() {
    // 核心不得内联实现最终裁决：换上"拒绝一切"的注入后，合法路径同样被拒。
    let root = temp_root("ensure-delegate");
    std::fs::write(root.join("a.md"), "a").unwrap();
    let strict = FileOps::new(rejecting_ensure);
    assert!(matches!(
        strict.rename(&root, "a.md", "b.md"),
        Err(OpError::OutsideRoot { .. })
    ));
    assert!(matches!(
        strict.delete_permanently(&root, "a.md"),
        Err(OpError::OutsideRoot { .. })
    ));
    cleanup(&root);
}

// ---------- 项目根自身保护 ----------

#[test]
fn 项目根自身不可创建删除移动() {
    let root = temp_root("root-guard");
    // 空相对路径解析为根自身
    assert!(matches!(
        ops().create_file(&root, ""),
        Err(OpError::IllegalTarget(_))
    ));
    assert!(matches!(
        ops().delete_permanently(&root, ""),
        Err(OpError::IllegalTarget(_))
    ));
    assert!(matches!(
        ops().delete_permanently(&root, "."),
        Err(OpError::IllegalTarget(_))
    ));
    assert!(root.exists(), "根不得被误删");
    cleanup(&root);
}

// ---------- 回收站删除与撤销 ----------

#[test]
fn 回收站删除_撤销返回需手动还原() {
    let root = temp_root("trash-undo");
    std::fs::write(root.join("note.md"), "x").unwrap();
    let sink = RecordingTrashSink::default();

    let result = ops().to_trash(&root, "note.md", &sink).unwrap();
    assert_eq!(result.applied.op(), "trash-delete");
    assert_eq!(sink.deleted.lock().unwrap().len(), 1, "回收站请求应被转发");
    match &result.undo {
        Some(UndoEntry::RestoreFromTrash { original_path }) => {
            assert_eq!(
                original_path.canonicalize().unwrap(),
                root.join("note.md").canonicalize().unwrap()
            );
        }
        other => panic!("期望 RestoreFromTrash，实际 {other:?}"),
    }

    // 撤销：trash crate 无还原 API → 返回 NeedsManualRestore，条目消耗
    let mut stack = UndoStack::new();
    let id = stack.push(result.undo.unwrap());
    match stack.undo(id) {
        Err(OpError::NeedsManualRestore { original_path }) => {
            assert!(original_path.ends_with("note.md"));
        }
        other => panic!("期望 NeedsManualRestore，实际 {other:?}"),
    }
    assert!(stack.is_empty(), "手动还原条目应被消耗（不阻塞后续撤销）");
    cleanup(&root);
}

#[test]
fn op_error_回收站提示文案面向用户() {
    let err = OpError::NeedsManualRestore {
        original_path: PathBuf::from("G:/proj/笔记.md"),
    };
    let text = err.to_string();
    assert!(text.contains("回收站"), "文案应指引用户去回收站：{text}");
    assert!(text.contains("笔记.md"), "文案应包含原路径：{text}");
}

#[test]
#[ignore = "真实写入系统回收站：cargo test -- --ignored 手动运行；验证后请清理回收站"]
fn 真实回收站冒烟_临时文件移入回收站() {
    let root = temp_root("real-trash");
    std::fs::write(root.join("待删除.md"), "# 真实回收站冒烟").unwrap();

    let result = ops().to_trash(&root, "待删除.md", &PlatformTrashBridge);
    assert!(result.is_ok(), "移入回收站失败：{result:?}");
    assert!(!root.join("待删除.md").exists(), "原位置应已消失");
    assert_eq!(result.unwrap().applied.op(), "trash-delete");
    cleanup(&root);

    // 手动验证方式（阶段 3 验收标准：回收站语义可在系统文件管理器中"还原"）：
    // 1. 打开系统回收站（Windows 资源管理器回收站 / macOS 废纸篓 /
    //    Linux 文件管理器回收站）；
    // 2. 确认出现"待删除.md"且系统提供"还原"操作；
    // 3. （可选）还原后确认文件回到上方打印的原位置。
    eprintln!(
        "真实回收站冒烟：请到系统回收站确认 '待删除.md' 可还原（原位置 {}）",
        root.display()
    );
}

// ---------- 撤销栈 ----------

#[test]
fn 撤销栈_严格后进先出_顺序不符报错() {
    let root = temp_root("undo-lifo");
    std::fs::write(root.join("a.md"), "a").unwrap();
    std::fs::write(root.join("b.md"), "b").unwrap();

    let r1 = ops().rename(&root, "a.md", "a2.md").unwrap();
    let r2 = ops().rename(&root, "b.md", "b2.md").unwrap();
    let mut stack = UndoStack::new();
    let id1 = stack.push(r1.undo.unwrap());
    let id2 = stack.push(r2.undo.unwrap());
    assert_ne!(id1, id2, "undo_id 应单调递增");
    assert_eq!(stack.peek_top_id(), Some(id2));
    assert_eq!(stack.len(), 2);

    // 跳过栈顶撤销 → 拒绝且栈不变（可排除障碍后重试）
    match stack.undo(id1) {
        Err(OpError::UndoMismatch { top, requested }) => {
            assert_eq!(top, Some(id2));
            assert_eq!(requested, id1);
        }
        other => panic!("期望 UndoMismatch，实际 {other:?}"),
    }
    assert_eq!(stack.len(), 2, "失败的撤销不应消耗条目");

    // 按 LIFO 顺序撤销成功
    assert_eq!(stack.undo(id2).unwrap().op(), "undo-rename");
    assert_eq!(stack.undo(id1).unwrap().op(), "undo-rename");
    assert!(stack.is_empty());
    assert!(root.join("a.md").exists() && root.join("b.md").exists());

    // 空栈撤销报错
    match stack.undo(999) {
        Err(OpError::UndoMismatch {
            top: None,
            requested: 999,
        }) => {}
        other => panic!("期望空栈 UndoMismatch，实际 {other:?}"),
    }
    cleanup(&root);
}

#[test]
fn 撤销栈_pop_不移除文件_仅取条目() {
    let entry = UndoEntry::Rename {
        from: PathBuf::from("/p/a.md"),
        to: PathBuf::from("/p/b.md"),
    };
    let mut stack = UndoStack::new();
    let id = stack.push(entry);
    let (popped_id, popped) = stack.pop().unwrap();
    assert_eq!(popped_id, id);
    assert_eq!(
        popped,
        UndoEntry::Rename {
            from: PathBuf::from("/p/a.md"),
            to: PathBuf::from("/p/b.md"),
        }
    );
    assert!(stack.pop().is_none());
}

// ---------- 事件负载契约 ----------

#[test]
fn 事件负载形状_与_workspace_fs_op_done_契约一致() {
    let desc = OpDesc {
        kind: OpKind::Rename,
        paths: vec![PathBuf::from("G:/proj/a.md"), PathBuf::from("G:/proj/b.md")],
    };
    assert_eq!(desc.op(), "rename");
    let payload = desc.event_payload(Some(3));
    assert_eq!(
        payload,
        serde_json::json!({
            "op": "rename",
            "paths": ["G:/proj/a.md", "G:/proj/b.md"],
            "undo_id": 3,
        })
    );
    // 不可撤销操作：undo_id 为 null
    let create = OpDesc {
        kind: OpKind::CreateFile,
        paths: vec![PathBuf::from("G:/proj/笔记.md")],
    };
    assert_eq!(
        create.event_payload(None)["undo_id"],
        serde_json::Value::Null
    );
}

#[test]
fn 操作类型与事件_op_字段映射() {
    assert_eq!(OpKind::CreateFile.as_str(), "create-file");
    assert_eq!(OpKind::CreateDir.as_str(), "create-dir");
    assert_eq!(OpKind::Rename.as_str(), "rename");
    assert_eq!(OpKind::Move.as_str(), "move");
    assert_eq!(OpKind::Copy.as_str(), "copy");
    assert_eq!(OpKind::TrashDelete.as_str(), "trash-delete");
    assert_eq!(OpKind::PermanentDelete.as_str(), "permanent-delete");
    assert_eq!(OpKind::UndoRename.as_str(), "undo-rename");
    assert_eq!(OpKind::UndoMove.as_str(), "undo-move");
}
