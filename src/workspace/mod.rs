//! Workspace 子系统：可信项目根、后台扫描与事件桥。
//!
//! 阶段 0 范围（见 `docs/plans/2026-09-04-glancemd-ultra-workspace-implementation-plan.md`）：
//! - [`Workspace::open_root`]：项目根的存在性校验与规范化（canonicalize）；
//! - [`ensure_within_root`]：路径边界校验，后续所有文件操作强制经过；
//! - [`open_and_scan`]：打开根目录并后台递归扫描（std::fs，零新依赖），每收集
//!   [`SCAN_PROGRESS_BATCH`] 个文件经事件桥广播一次进度，扫描结果阶段 0 仅计数；
#![allow(dead_code)]
//! - 事件定义与 Rust → JS 广播见 [`events`]（契约唯一事实源 `docs/dev/interfaces.md`）。

pub mod events;
pub mod operations;
pub mod recovery;
pub mod search;
pub mod session;
pub mod settings;
pub mod tree;
pub mod watcher;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use events::Event;

/// 扫描进度广播批次：每收集这么多文件广播一次 `workspace:scan-progress`。
pub const SCAN_PROGRESS_BATCH: usize = 200;

/// 当前打开工作区的代际号：每次 [`open_and_scan`] 递增一次，
/// 用于抑制旧扫描线程在换根后继续发出的过期进度事件。
static SCAN_GENERATION: AtomicUsize = AtomicUsize::new(0);

/// CLI 传入的项目根在此暂存，待前端 `ready` 后（`__fromRust` 可用、事件桥就绪）
/// 再由 `ipc.rs` 触发打开，避免事件早于前端装载而丢失。
static PENDING_ROOT: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// 暂存 CLI 传入的项目根（仅暂存，不校验；校验在真正打开时进行）。
pub fn set_pending_root(path: String) {
    *PENDING_ROOT.lock().unwrap() = Some(path);
}

/// 取走暂存的项目根（若有）。
pub fn take_pending_root() -> Option<String> {
    PENDING_ROOT.lock().unwrap().take()
}

/// Workspace 相关错误。
#[derive(Debug)]
pub enum WorkspaceError {
    /// 路径不存在。
    NotFound(PathBuf),
    /// 路径存在但不是目录（项目根必须是目录）。
    NotADirectory(PathBuf),
    /// 目标路径位于项目根之外（路径边界校验失败）。
    /// 阶段 1 起随文件操作接入 `ensure_within_root` 进入生产路径，当前仅测试消费。
    #[allow(dead_code)]
    OutsideRoot { root: PathBuf, target: PathBuf },
    /// 底层 I/O 错误（权限不足、canonicalize 失败等）。
    Io(std::io::Error),
}

impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkspaceError::NotFound(p) => write!(f, "项目目录不存在：{}", p.display()),
            WorkspaceError::NotADirectory(p) => write!(f, "不是目录：{}", p.display()),
            WorkspaceError::OutsideRoot { root, target } => write!(
                f,
                "路径 {} 超出项目根 {} 的边界",
                target.display(),
                root.display()
            ),
            WorkspaceError::Io(e) => write!(f, "项目目录访问失败：{e}"),
        }
    }
}

impl std::error::Error for WorkspaceError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            WorkspaceError::Io(e) => Some(e),
            _ => None,
        }
    }
}

/// 已打开的工作区：持有规范化后的可信项目根。
#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    /// 打开项目根：校验存在性（且必须是目录）并 canonicalize 规范化。
    ///
    /// 相对路径按进程当前工作目录解析，`.`/`..` 等冗余组件随 canonicalize 消除。
    pub fn open_root(path: impl AsRef<Path>) -> Result<Workspace, WorkspaceError> {
        let path = path.as_ref();
        if !path.exists() {
            return Err(WorkspaceError::NotFound(path.to_path_buf()));
        }
        if !path.is_dir() {
            return Err(WorkspaceError::NotADirectory(path.to_path_buf()));
        }
        let canonical = path.canonicalize().map_err(WorkspaceError::Io)?;
        Ok(Workspace { root: canonical })
    }

    /// 规范化后的项目根（Windows 下为 `\\?\` 原生前缀路径，仅用于内部比较）。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 面向展示的根路径（剥离 Windows `\\?\` 前缀，用于事件负载与 UI 文案）。
    pub fn display_root(&self) -> String {
        display_path(&self.root)
    }
}

/// 剥离 Windows verbatim 前缀，得到常规可读路径文本；其他平台原样返回。
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

/// 规范化目标路径：存在则 canonicalize；不存在（如待创建的新文件）则规范化
/// 其父目录后拼接末段组件，保证后续边界比较在同一坐标系下进行。
// 与 ensure_within_root 一同在阶段 1 起进入生产路径，当前仅测试消费。
#[allow(dead_code)]
fn canonicalize_lenient(target: &Path) -> Result<PathBuf, WorkspaceError> {
    if let Ok(canonical) = target.canonicalize() {
        return Ok(canonical);
    }
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| WorkspaceError::NotFound(target.to_path_buf()))?;
    let mut resolved = parent.canonicalize().map_err(WorkspaceError::Io)?;
    if let Some(name) = target.file_name() {
        // 末段是不存在的组件（新文件/新目录名），直接拼接交由边界比较裁决
        resolved.push(name);
    }
    Ok(resolved)
}

/// 路径边界校验：确保 `target`（含尚不存在的新路径）落在可信项目根 `root` 之内，
/// 返回规范化后的目标路径。后续所有文件操作强制经过本函数。
///
/// 两端均先规范化（解析符号链接与 `..`），再做逐组件前缀比较，因此符号链接
/// 指向根外、`..` 穿越逃逸都会被拒绝。
// 阶段 0 交付的边界校验工具，阶段 1 起随文件操作进入生产路径，当前仅测试消费。
#[allow(dead_code)]
pub fn ensure_within_root(root: &Path, target: &Path) -> Result<PathBuf, WorkspaceError> {
    let root_canonical = root.canonicalize().map_err(WorkspaceError::Io)?;
    let target_canonical = canonicalize_lenient(target)?;
    if !target_canonical.starts_with(&root_canonical) {
        return Err(WorkspaceError::OutsideRoot {
            root: root_canonical,
            target: target_canonical,
        });
    }
    Ok(target_canonical)
}

/// 打开项目根并后台扫描（阶段 0 垂直切片入口）。
///
/// 1. 校验并规范化根目录，失败时广播 `workspace:error`；
/// 2. 立即广播 `workspace:opened`（file_count 为 0，计数由进度事件推进）；
/// 3. 后台线程递归扫描，每 [`SCAN_PROGRESS_BATCH`] 个文件广播一次
///    `workspace:scan-progress`，扫描结束时广播最终计数。
///
/// 重复打开时换代处理：旧扫描线程的进度事件会被代际检查丢弃。
pub fn open_and_scan(path: &str) -> Result<(), WorkspaceError> {
    let ws = match Workspace::open_root(path) {
        Ok(ws) => ws,
        Err(e) => {
            events::emit(Event::Error {
                message: e.to_string(),
            });
            return Err(e);
        }
    };
    let generation = SCAN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    events::emit(Event::Opened {
        root: ws.display_root(),
        file_count: 0,
    });
    let spawn = std::thread::Builder::new()
        .name("workspace-scan".to_string())
        .spawn(move || {
            let total = scan_counting(ws.root(), generation);
            if generation == SCAN_GENERATION.load(Ordering::SeqCst) {
                events::emit(Event::ScanProgress { scanned: total });
            }
        });
    if let Err(e) = spawn {
        events::emit(Event::Error {
            message: format!("扫描线程启动失败：{e}"),
        });
    }
    Ok(())
}

/// 广播一次进度事件（带代际检查，过期扫描静默丢弃）。
fn emit_progress_if_current(generation: usize, scanned: usize) {
    if generation == SCAN_GENERATION.load(Ordering::SeqCst) {
        events::emit(Event::ScanProgress { scanned });
    }
}

/// 迭代式递归扫描（显式栈，避免超深目录递归爆栈）：统计根下全部普通文件与
/// 文件符号链接数量；目录符号链接不递归；不可读目录跳过。
fn scan_counting(root: &Path, generation: usize) -> usize {
    let mut count = 0usize;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_symlink()
                && entry.metadata().is_ok_and(|metadata| metadata.is_dir())
            {
                // 目录符号链接不递归，也不计入文件总数。
                continue;
            } else {
                count += 1;
                if count % SCAN_PROGRESS_BATCH == 0 {
                    emit_progress_if_current(generation, count);
                }
            }
        }
    }
    count
}

/// 便捷封装：以中文消息广播 `workspace:error`。
pub fn emit_error(message: String) {
    events::emit(Event::Error { message });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// 测试临时目录计数器（进程内唯一，避免并行测试互相覆盖）。
    static TEMP_SEQ: AtomicUsize = AtomicUsize::new(0);

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "glancemd-ultra-stage0-{}-{}-{}",
            std::process::id(),
            tag,
            TEMP_SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn open_root_正常打开并规范化路径() {
        let dir = temp_root("open-ok");
        let sub = dir.join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        let ws = Workspace::open_root(&dir).unwrap();
        assert_eq!(ws.root(), dir.canonicalize().unwrap());
        // 展示路径不含 Windows verbatim 前缀
        assert!(!ws.display_root().contains(r"\\?\"));
        // 冗余组件（`sub/..`）在打开时被规范化消除
        let via_redundant = Workspace::open_root(dir.join("nested").join("..")).unwrap();
        assert_eq!(via_redundant.root(), ws.root());
        cleanup(&dir);
    }

    #[test]
    fn open_root_相对路径按工作目录解析为绝对路径() {
        // cargo test 的工作目录为包根（只读使用，不写任何文件）
        let ws = Workspace::open_root(".").unwrap();
        assert!(ws.root().is_absolute());
        assert_eq!(
            ws.root(),
            std::env::current_dir().unwrap().canonicalize().unwrap()
        );
    }

    #[test]
    fn open_root_不存在时拒绝() {
        let dir = temp_root("open-missing");
        let missing = dir.join("不存在的子目录");
        match Workspace::open_root(&missing) {
            Err(WorkspaceError::NotFound(p)) => assert_eq!(p, missing),
            other => panic!("期望 NotFound，实际 {other:?}"),
        }
        cleanup(&dir);
    }

    #[test]
    fn open_root_文件路径拒绝() {
        let dir = temp_root("open-file");
        let file = dir.join("note.md");
        std::fs::write(&file, "# hi").unwrap();
        match Workspace::open_root(&file) {
            Err(WorkspaceError::NotADirectory(p)) => assert_eq!(p, file),
            other => panic!("期望 NotADirectory，实际 {other:?}"),
        }
        cleanup(&dir);
    }

    #[test]
    fn ensure_within_root_接受根内已存在路径() {
        let dir = temp_root("within-exists");
        let file = dir.join("a").join("doc.md");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "x").unwrap();
        let resolved = ensure_within_root(&dir, &file).unwrap();
        assert_eq!(resolved, file.canonicalize().unwrap());
        // 根自身也应通过
        assert_eq!(
            ensure_within_root(&dir, &dir).unwrap(),
            dir.canonicalize().unwrap()
        );
        cleanup(&dir);
    }

    #[test]
    fn ensure_within_root_接受根内尚不存在的新路径() {
        let dir = temp_root("within-new");
        let new_file = dir.join("未创建.md");
        let resolved = ensure_within_root(&dir, &new_file).unwrap();
        assert_eq!(resolved, dir.canonicalize().unwrap().join("未创建.md"));
        cleanup(&dir);
    }

    #[test]
    fn ensure_within_root_拒绝根外绝对路径() {
        let dir = temp_root("within-outside");
        // 根外且不存在的路径：实现按"父目录规范化 + 末段拼接"规范化，
        // 期望值需用同一坐标系构造（temp_dir 自身存在，可直接 canonicalize）
        let outside = std::env::temp_dir().join(format!(
            "glancemd-ultra-outside-{}-{}.md",
            std::process::id(),
            TEMP_SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        let expected = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(outside.file_name().unwrap());
        match ensure_within_root(&dir, &outside) {
            Err(WorkspaceError::OutsideRoot { target, .. }) => assert_eq!(target, expected),
            other => panic!("期望 OutsideRoot，实际 {other:?}"),
        }
        cleanup(&dir);
    }

    #[test]
    fn ensure_within_root_拒绝穿越相对路径逃逸根边界() {
        let dir = temp_root("within-traversal");
        let escape = dir.join("a").join("..").join("..").join("escaped.md");
        std::fs::create_dir_all(dir.join("a")).unwrap();
        match ensure_within_root(&dir, &escape) {
            Err(WorkspaceError::OutsideRoot { .. }) => {}
            other => panic!("期望 OutsideRoot，实际 {other:?}"),
        }
        cleanup(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn ensure_within_root_拒绝符号链接逃逸() {
        use std::os::unix::fs::symlink;
        let dir = temp_root("within-symlink");
        let outside = temp_root("symlink-target");
        std::fs::write(outside.join("secret.md"), "x").unwrap();
        symlink(&outside, dir.join("link")).unwrap();
        match ensure_within_root(&dir, &dir.join("link").join("secret.md")) {
            Err(WorkspaceError::OutsideRoot { .. }) => {}
            other => panic!("期望 OutsideRoot，实际 {other:?}"),
        }
        cleanup(&dir);
        cleanup(&outside);
    }

    #[test]
    fn open_and_scan_不存在时广播错误并拒绝() {
        // 事件桥未安装发送器（单元测试环境），emit 静默忽略，不应 panic
        let missing = std::env::temp_dir().join("glancemd-ultra-不存在-此路径不应存在");
        assert!(open_and_scan(missing.to_string_lossy().as_ref()).is_err());
    }

    #[test]
    fn open_and_scan_正常打开并返回成功() {
        let dir = temp_root("scan-ok");
        let nested = dir.join("d1").join("d2");
        std::fs::create_dir_all(&nested).unwrap();
        for i in 0..3 {
            std::fs::write(dir.join(format!("f{i}.md")), "x").unwrap();
        }
        std::fs::write(nested.join("deep.txt"), "x").unwrap();
        // 空目录不应计入
        std::fs::create_dir_all(dir.join("empty-dir")).unwrap();
        assert!(open_and_scan(dir.to_string_lossy().as_ref()).is_ok());
        cleanup(&dir);
    }

    #[test]
    fn scan_counting_统计文件数量并跳过目录符号链接() {
        let dir = temp_root("scan-count");
        let nested = dir.join("sub");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(dir.join("a.md"), "x").unwrap();
        std::fs::write(nested.join("b.md"), "x").unwrap();
        std::fs::create_dir_all(dir.join("empty")).unwrap();
        // 普通目录递归计数
        assert_eq!(scan_counting(&dir, 1), 2);
        // 目录符号链接不递归、不计数；文件符号链接计入
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(&nested, dir.join("dir-link")).unwrap();
            symlink(dir.join("a.md"), dir.join("file-link.md")).unwrap();
            assert_eq!(scan_counting(&dir, 1), 3);
        }
        cleanup(&dir);
    }

    #[test]
    fn 暂存根路径_写入后取走即清空() {
        set_pending_root("G:/some/project".to_string());
        assert_eq!(take_pending_root(), Some("G:/some/project".to_string()));
        assert_eq!(take_pending_root(), None);
    }

    #[test]
    fn display_path_剥离_windows_verbatim_前缀() {
        assert_eq!(display_path(Path::new(r"\\?\G:\proj")), r"G:\proj");
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share")),
            r"\\server\share"
        );
        assert_eq!(
            display_path(Path::new("/home/user/proj")),
            "/home/user/proj"
        );
    }
}
