//! 会话级粘合状态：当前项目根、文件监听服务、撤销栈、打开文件的编码元数据、
//! 搜索取消表与代际号。
//!
//! 这些状态跨越多条命令与后台线程（watcher 线程、搜索线程、保存链路），
//! 统一收敛在此，命令 handler（`fn` 指针，无捕获）经静态访问器使用。
//! 线程安全：各状态独立置于 `OnceLock<Mutex<_>>` / 原子量之后。
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use super::operations::UndoStack;
use super::watcher::{LoopSuppressor, WatchService};
use crate::file_codec::TextFile;

const SESSION_FILE_NAME: &str = "session.json";

/// 会话文件路径（注入 base 便于测试，生产调用方传入 data_dir::data_base()）。
pub fn session_path(base: &Path) -> PathBuf {
    base.join(SESSION_FILE_NAME)
}

/// 读取最近一次打开的工作区；文件缺失、损坏、字段缺失或目录已不存在时均视为无记录。
pub fn load_last_root(base: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(session_path(base)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let root = value.get("lastRoot")?.as_str()?;
    let path = PathBuf::from(root);
    path.is_dir().then_some(path)
}

/// 写入最近一次打开的工作区；调用方可静默忽略便携目录不可写等错误。
pub fn save_last_root(base: &Path, root: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(base)?;
    let text = serde_json::to_vec(&serde_json::json!({"lastRoot": root.to_string_lossy()}))
        .map_err(std::io::Error::other)?;
    std::fs::write(session_path(base), text)
}

/// 启动恢复纯函数：显式 CLI 参数优先，不抢占文件/目录参数的既有行为。
pub fn restore_pending_root(base: &Path, cli_path: Option<&Path>) -> Option<String> {
    if cli_path.is_some() {
        return None;
    }
    load_last_root(base).map(|path| path.to_string_lossy().into_owned())
}

fn root_slot() -> &'static Mutex<Option<PathBuf>> {
    static ROOT: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    ROOT.get_or_init(|| Mutex::new(None))
}

fn watcher_slot() -> &'static Mutex<Option<WatchService>> {
    static WATCHER: OnceLock<Mutex<Option<WatchService>>> = OnceLock::new();
    WATCHER.get_or_init(|| Mutex::new(None))
}

fn undo_slot() -> &'static Mutex<UndoStack> {
    static UNDO: OnceLock<Mutex<UndoStack>> = OnceLock::new();
    UNDO.get_or_init(|| Mutex::new(UndoStack::new()))
}

fn file_meta_slot() -> &'static Mutex<HashMap<String, TextFile>> {
    static FILE_META: OnceLock<Mutex<HashMap<String, TextFile>>> = OnceLock::new();
    FILE_META.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 当前工作区根（canonicalize 后；未打开返回 `None`）。
pub fn current_root() -> Option<PathBuf> {
    root_slot().lock().unwrap().clone()
}

/// 记录当前工作区根（打开成功后调用）。
pub fn set_root(root: PathBuf) {
    *root_slot().lock().unwrap() = Some(root);
}

/// 清除工作区根并丢弃监听服务（换根前/窗口关闭时调用）。
pub fn clear_root() {
    *root_slot().lock().unwrap() = None;
    *watcher_slot().lock().unwrap() = None;
}

/// 用新服务替换监听服务（旧服务 Drop 即反注册监听并停冲刷线程）。
pub fn replace_watcher(service: WatchService) {
    *watcher_slot().lock().unwrap() = Some(service);
}

/// 暂停监听（存在服务时生效）；返回是否存在服务。
pub fn watcher_pause() -> bool {
    match watcher_slot().lock().unwrap().as_ref() {
        Some(svc) => {
            svc.pause();
            true
        }
        None => false,
    }
}

/// 恢复监听；返回是否存在服务。
pub fn watcher_resume() -> bool {
    match watcher_slot().lock().unwrap().as_ref() {
        Some(svc) => {
            svc.resume();
            true
        }
        None => false,
    }
}

/// 回环抑制令牌：`begin_suppress` 时 mark，`complete()` 或 Drop 时 complete。
/// 抑制器实例取自当前 WatchService（与监听回调共用同一实例）；无服务时空操作。
pub struct SuppressToken {
    op_id: Option<u64>,
    suppressor: Option<LoopSuppressor>,
    done: bool,
}

impl SuppressToken {
    /// 显式完成抑制窗口（之后 Drop 不再重复 complete）。
    pub fn complete(&mut self) {
        if !self.done {
            self.done = true;
            if let (Some(op_id), Some(sup)) = (self.op_id.take(), self.suppressor.as_ref()) {
                sup.complete(op_id);
            }
        }
    }
}

impl Drop for SuppressToken {
    fn drop(&mut self) {
        self.complete();
    }
}

/// 在监听服务的抑制器上执行 `f`（无服务时不调用）。
pub fn with_watcher_suppressor(f: impl FnOnce(Option<&LoopSuppressor>)) {
    let guard = watcher_slot().lock().unwrap();
    f(guard.as_ref().map(|svc| svc.suppressor()));
}

static NEXT_OP_ID: AtomicU64 = AtomicU64::new(1);

/// 以当前监听服务的抑制器标记一批路径（自身保存 / 文件操作前后调用）。
/// 无监听服务时返回空令牌（不抑制）。
pub fn begin_suppress(paths: &[&Path]) -> SuppressToken {
    let owned: Vec<PathBuf> = paths.iter().map(|p| (*p).to_path_buf()).collect();
    let mut op_id = None;
    let mut suppressor = None;
    with_watcher_suppressor(|sup| {
        if let Some(sup) = sup {
            let id = NEXT_OP_ID.fetch_add(1, Ordering::Relaxed);
            sup.mark(id, &owned);
            op_id = Some(id);
            suppressor = Some(sup.clone());
        }
    });
    SuppressToken {
        op_id,
        suppressor,
        done: false,
    }
}

/// 撤销栈互斥访问（undo 互斥由该锁承载；undo 内部不做长阻塞操作）。
pub fn with_undo<R>(f: impl FnOnce(&mut UndoStack) -> R) -> R {
    let mut guard = undo_slot().lock().unwrap();
    f(&mut guard)
}

/// 记录打开文件的编码/换行元数据（key：路径字符串）。
pub fn store_file_meta(path: &str, meta: TextFile) {
    file_meta_slot()
        .lock()
        .unwrap()
        .insert(path.to_string(), meta);
}

/// 取走（并移除）打开文件的编码元数据；无记录返回 `None`（按 UTF-8/LF 处理）。
pub fn take_file_meta(path: &str) -> Option<TextFile> {
    file_meta_slot().lock().unwrap().remove(path)
}

// ---------- 搜索取消表与代际号 ----------

fn cancels() -> &'static Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>> {
    static CANCELS: OnceLock<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>> =
        OnceLock::new();
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

static SEARCH_GENERATION: AtomicU64 = AtomicU64::new(0);

/// 登记一个可取消的搜索（worker 线程启动前调用）。
pub fn register_search(search_id: &str) -> Arc<std::sync::atomic::AtomicBool> {
    let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    cancels()
        .lock()
        .unwrap()
        .insert(search_id.to_string(), Arc::clone(&flag));
    flag
}

/// 请求取消指定搜索；返回是否存在该搜索。
pub fn cancel_search(search_id: &str) -> bool {
    match cancels().lock().unwrap().get(search_id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

/// 搜索结束（完成/取消/出错）后注销。
pub fn remove_search(search_id: &str) {
    cancels().lock().unwrap().remove(search_id);
}

/// 递增搜索代际号并返回新值：新搜索开启即令旧搜索的过期事件失效。
pub fn bump_search_generation() -> u64 {
    SEARCH_GENERATION.fetch_add(1, Ordering::Relaxed) + 1
}

/// 当前搜索代际号。
pub fn search_generation() -> u64 {
    SEARCH_GENERATION.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEMP_SEQ: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "glancemd-ultra-session-{}-{}-{}",
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
    fn 最近工作区_写入读取_roundtrip() {
        let base = temp_dir("roundtrip");
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        save_last_root(&base, &root).unwrap();
        assert_eq!(load_last_root(&base), Some(root));
        cleanup(&base);
    }

    #[test]
    fn 最近工作区_损坏_json回退_none() {
        let base = temp_dir("corrupt");
        std::fs::write(session_path(&base), b"{ not json").unwrap();
        assert_eq!(load_last_root(&base), None);
        cleanup(&base);
    }

    #[test]
    fn 最近工作区_不存在目录回退_none() {
        let base = temp_dir("missing-root");
        save_last_root(&base, &base.join("gone")).unwrap();
        assert_eq!(load_last_root(&base), None);
        cleanup(&base);
    }

    #[test]
    fn 启动恢复_无_cli路径时返回记录_显式cli时不恢复() {
        let base = temp_dir("restore");
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        save_last_root(&base, &root).unwrap();
        assert_eq!(
            restore_pending_root(&base, None),
            Some(root.to_string_lossy().into_owned())
        );
        assert_eq!(restore_pending_root(&base, Some(&root)), None);
        cleanup(&base);
    }

    #[test]
    fn 撤销栈_空栈撤销报_mismatch() {
        let err = with_undo(|stack| stack.undo(999));
        assert!(matches!(
            err,
            Err(super::super::operations::OpError::UndoMismatch { top: None, .. })
        ));
    }

    #[test]
    fn 抑制令牌_无监听服务时为空操作() {
        // 无 WatchService 时 mark/complete 均为空操作，不 panic 即可。
        let mut token = begin_suppress(&[Path::new("C:/tmp/a.md")]);
        token.complete();
        drop(token);
    }

    #[test]
    fn 搜索代际号_单调递增() {
        let a = bump_search_generation();
        let b = bump_search_generation();
        assert!(b > a);
    }

    #[test]
    fn 搜索取消_登记后可取消_注销后失效() {
        let _flag = register_search("test-search-1");
        assert!(cancel_search("test-search-1"));
        remove_search("test-search-1");
        assert!(!cancel_search("test-search-1"));
    }

    #[test]
    fn 文件元数据_存取与取走语义() {
        let meta = TextFile {
            content: String::new(),
            original_eol: crate::file_codec::Eol::Crlf,
            had_bom: true,
        };
        store_file_meta("test-meta-path.md", meta);
        let taken = take_file_meta("test-meta-path.md");
        assert!(taken.is_some());
        assert!(taken.unwrap().had_bom);
        assert!(take_file_meta("test-meta-path.md").is_none());
    }
}
