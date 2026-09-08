//! 命令注册表与 Workspace 子系统粘合层。
#![allow(dead_code, unused_imports)]
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use serde_json::{json, Value};
use tao::window::Window;
use wry::WebView;

use crate::atomic_save;
use crate::data_dir;
use crate::file_codec::{self, Eol, TextFile};
use crate::file_ops;
use crate::ipc;
use crate::platform;
use crate::state::AppState;
use crate::workspace;
use crate::workspace::operations::{self, OpError, TrashSink};
use crate::workspace::recovery::{RecoveryEntry, RecoveryStore};
use crate::workspace::search::{self, SearchOptions};
use crate::workspace::session;
use crate::workspace::tree::{self, TreeFilter};
use crate::workspace::watcher::{MergedEvent, WatchOutcome, WatchService};

pub type CommandHandler = fn(&CommandContext, &CommandPayload);

pub struct CommandContext<'a> {
    pub webview: &'a WebView,
    pub window: &'a Window,
    pub state: &'a Arc<Mutex<AppState>>,
}

#[derive(Debug, Default, Clone)]
pub struct CommandPayload {
    pub content: Option<String>,
    pub path: Option<String>,
    pub title: Option<String>,
    pub dirty: Option<bool>,
    pub extra: Value,
}

#[derive(Debug)]
pub enum CommandError {
    Unknown(String),
    AlreadyRegistered(String),
}
impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unknown(id) => write!(f, "未知命令: {id}"),
            Self::AlreadyRegistered(id) => write!(f, "命令重复注册: {id}"),
        }
    }
}

pub struct CommandRegistry {
    handlers: HashMap<String, CommandHandler>,
}
impl CommandRegistry {
    pub fn new() -> Self {
        Self {
            handlers: HashMap::new(),
        }
    }
    pub fn register(&mut self, id: &str, handler: CommandHandler) -> Result<(), CommandError> {
        if self.handlers.contains_key(id) {
            return Err(CommandError::AlreadyRegistered(id.into()));
        }
        self.handlers.insert(id.into(), handler);
        Ok(())
    }
    pub fn lookup(&self, id: &str) -> Result<CommandHandler, CommandError> {
        self.handlers
            .get(id)
            .copied()
            .ok_or_else(|| CommandError::Unknown(id.into()))
    }
    pub fn contains(&self, id: &str) -> bool {
        self.handlers.contains_key(id)
    }
    pub fn ids(&self) -> Vec<&str> {
        let mut v: Vec<_> = self.handlers.keys().map(String::as_str).collect();
        v.sort_unstable();
        v
    }
}
impl Default for CommandRegistry {
    fn default() -> Self {
        Self::new()
    }
}
fn global() -> &'static Mutex<CommandRegistry> {
    static R: OnceLock<Mutex<CommandRegistry>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(CommandRegistry::new()))
}
pub fn register(id: &str, handler: CommandHandler) -> Result<(), CommandError> {
    global().lock().unwrap().register(id, handler)
}
pub fn dispatch(
    id: &str,
    payload: &CommandPayload,
    ctx: &CommandContext,
) -> Result<(), CommandError> {
    let h = global().lock().unwrap().lookup(id)?;
    h(ctx, payload);
    Ok(())
}

fn value(p: &CommandPayload, names: &[&str]) -> Option<Value> {
    names.iter().find_map(|n| p.extra.get(*n).cloned())
}
fn string(p: &CommandPayload, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|n| p.extra.get(*n).and_then(Value::as_str).map(str::to_owned))
}
fn number(p: &CommandPayload, names: &[&str]) -> Option<u64> {
    names
        .iter()
        .find_map(|n| p.extra.get(*n).and_then(Value::as_u64))
}
fn emit(e: workspace::events::Event) {
    workspace::events::emit(e);
}
fn error(message: impl Into<String>) {
    emit(workspace::events::Event::Error {
        message: message.into(),
    });
}
fn root() -> Option<PathBuf> {
    session::current_root()
}
fn require_root() -> Option<PathBuf> {
    let r = root();
    if r.is_none() {
        error("尚未打开项目");
    }
    r
}

pub fn register_builtin() {
    let handlers: &[(&str, CommandHandler)] = &[
        ("file.open", open_file),
        ("file.reload", file_reload),
        ("cli.install-shim", cli_install_shim),
        ("cli.remove-shim", cli_remove_shim),
        ("cli.shim-status", cli_shim_status),
        ("workspace.open", workspace_open),
        ("workspace.tree.list", tree_list),
        ("workspace.search.start", search_start),
        ("workspace.search.cancel", search_cancel),
        ("workspace.fs.create-file", fs_create_file),
        ("workspace.fs.create-dir", fs_create_dir),
        ("workspace.fs.rename", fs_rename),
        ("workspace.fs.move", fs_move),
        ("workspace.fs.copy", fs_copy),
        ("workspace.fs.delete", fs_delete),
        ("workspace.fs.undo", fs_undo),
        ("workspace.fs.reveal", fs_reveal),
        ("workspace.fs.terminal", fs_terminal),
        ("workspace.terminal.scan", terminal_scan),
        ("watcher.pause", watcher_pause),
        ("watcher.resume", watcher_resume),
        ("workspace.settings.get-global", settings_global),
        ("workspace.settings.get-effective", settings_effective),
        ("workspace.settings.set-global", settings_set),
        ("workspace.settings.set-theme", settings_set_theme),
        ("workspace.settings.load-project", settings_project),
        ("workspace.settings.save-global", settings_set),
        ("workspace.settings.open-settings-json", settings_open),
        ("workspace.recovery.snapshot", recovery_snapshot),
        ("workspace.recovery.list", recovery_list),
        ("workspace.recovery.restore", recovery_restore),
        ("workspace.recovery.discard", recovery_discard),
        ("recovery.open-as-tab", recovery_restore),
    ];
    for (id, h) in handlers {
        let _ = register(id, *h);
    }
}

fn open_file(ctx: &CommandContext, p: &CommandPayload) {
    let Some(path) = p.path.clone().or_else(file_ops::pick_open_file) else {
        return;
    };
    // 图片与 CLI 相对路径支持：统一转绝对路径；图片走空内容 + is_image 标记。
    let path = std::path::absolute(&path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(path);
    if file_ops::is_image_path(&path) {
        if let Err(e) = std::fs::metadata(&path) {
            ipc::send_to_js(
                ctx.webview,
                "error",
                &json!({"message": format!("Failed to open file: {e}")}),
            );
            return;
        }
        ipc::send_to_js(
            ctx.webview,
            "file_opened",
            &json!({"content": "", "path": path, "is_image": true}),
        );
        ctx.window.set_minimized(false);
        ctx.window.set_focus();
        return;
    }
    match std::fs::read(&path)
        .and_then(|b| file_codec::read_text(&b).map_err(|e| std::io::Error::other(e.to_string())))
    {
        Ok(text) => {
            session::store_file_meta(&path, text.clone());
            ipc::send_to_js(
                ctx.webview,
                "file_opened",
                &json!({"content":text.content,"path":path}),
            );
            ctx.window.set_minimized(false);
            ctx.window.set_focus();
            // 单文件模式（未打开工作区）挂载仅针对该文件的监听，
            // 使外部修改的 clean tab 热重载与冲突横幅在无工作区时同样生效（BUG-001）。
            start_single_file_watcher(&path);
        }
        Err(e) => ipc::send_to_js(
            ctx.webview,
            "error",
            &json!({"message":format!("Failed to open file: {e}")}),
        ),
    }
}

/// 读取文件最新内容并回发 `file_reloaded`，供前端对 clean tab 做静默热重载（BUG-001）。
/// 文件已被删除或瞬时不可读时静默忽略——删除场景由 `removed` 事件的红色横幅负责。
fn file_reload(ctx: &CommandContext, p: &CommandPayload) {
    let Some(path) = p.path.clone() else {
        return;
    };
    let path = std::path::absolute(&path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(path);
    // 图片标签经 local-image 协议按需加载，无文本缓冲区，不参与热重载
    if file_ops::is_image_path(&path) {
        return;
    }
    match std::fs::read(&path)
        .and_then(|b| file_codec::read_text(&b).map_err(|e| std::io::Error::other(e.to_string())))
    {
        Ok(text) => {
            // 同步刷新编码/换行元数据基线，保证后续保存与冲突检测基于最新内容
            session::store_file_meta(&path, text.clone());
            ipc::send_to_js(
                ctx.webview,
                "file_reloaded",
                &json!({"content": text.content, "path": path}),
            );
        }
        Err(_) => {}
    }
}

/// 单文件模式的定向监听：监听文件所在目录，但只放行目标文件自身的事件。
/// 与 `start_watcher`（工作区根递归监听）共用去抖/回环抑制与事件桥；
/// 监听器经 `session::replace_watcher` 托管，打开工作区或下一个文件时自动替换。
fn start_single_file_watcher(file: &str) {
    // 已打开工作区时由工作区根监听覆盖，不重复挂载
    if session::current_root().is_some() {
        return;
    }
    let base = settings_base();
    let global = workspace::settings::load_global(&base);
    if !global.watching.enable_watcher {
        return;
    }
    let Some(dir) = std::path::Path::new(file).parent() else {
        return;
    };
    let Ok(service) = WatchService::new(dir, &global.files.watcher_exclude) else {
        return;
    };
    let Some(rx) = service.take_receiver() else {
        return;
    };
    let target = file.to_string();
    thread::spawn(move || {
        while let Ok(outcome) = rx.recv() {
            match outcome {
                WatchOutcome::ExternalChange(e) => {
                    if single_file_event_matches(&e, &target) {
                        watch_event(e);
                    }
                }
                WatchOutcome::Error(m) => {
                    emit(workspace::events::Event::WatcherError { message: m })
                }
                WatchOutcome::SelfSuppressed => {}
            }
        }
    });
    session::replace_watcher(service);
}

/// 判断单文件监听事件是否命中目标文件（剥离 verbatim 前缀 + 分隔符归一 +
/// Windows 大小写不敏感）。
fn single_file_event_matches(e: &MergedEvent, target: &str) -> bool {
    let path = match e {
        MergedEvent::Created { path, .. }
        | MergedEvent::Modified { path, .. }
        | MergedEvent::Removed { path, .. } => path,
        // 重命名事件成对出现，交给前端 remapPath 处理
        MergedEvent::Renamed { .. } => return true,
    };
    // 事件路径携带 `\\?\` verbatim 前缀（根 canonicalize 所致），必须先剥离
    let s = watch_display_path(path).replace('\\', "/");
    let t = target.replace('\\', "/");
    s.eq_ignore_ascii_case(&t)
}

fn workspace_open(_: &CommandContext, p: &CommandPayload) {
    let picked;
    let path = match p.path.as_deref() {
        Some(path) => path,
        None => {
            picked = file_ops::pick_workspace_folder();
            let Some(path) = picked.as_deref() else {
                return;
            };
            path
        }
    };
    match workspace::Workspace::open_root(path) {
        Ok(ws) => {
            // 监听开关接线：effective 的 watching.enableWatcher=false 则不启动监听。
            // 这里只读全局设置（base=settings_base()）——项目覆盖可忽略：项目设置
            // 仅是补丁语义，监听启停以全局开关为阶段边界（项目级独立启停留待后续
            // 阶段，见 docs/dev/contracts/settings.md §2.3）。
            let base = settings_base();
            let global = workspace::settings::load_global(&base);
            let project = workspace::settings::load_project_checked(ws.root())
                .map(|loaded| loaded.patch)
                .unwrap_or_default();
            let effective = workspace::settings::effective(&global, &project);
            if effective.recovery.create_project_settings
                && !workspace::settings::project_settings_path(ws.root()).exists()
            {
                let _ = workspace::settings::save_project(
                    ws.root(),
                    &workspace::settings::SettingsPatch {
                        version: Some(workspace::settings::SCHEMA_VERSION),
                        ..Default::default()
                    },
                );
            }
            session::clear_root();
            session::set_root(ws.root().to_path_buf());
            // 打开成功后记录最近工作区；便携目录不可写时静默忽略，避免影响打开流程。
            let _ = session::save_last_root(data_dir::data_base(), ws.root());
            if effective.watching.enable_watcher {
                start_watcher(ws.root().to_path_buf(), &effective.files.watcher_exclude);
            }
            let _ = workspace::open_and_scan(path);
        }
        Err(e) => error(format!("打开项目失败：{e}")),
    }
}
fn start_watcher(root: PathBuf, excludes: &[String]) {
    let Ok(service) = WatchService::new(&root, excludes) else {
        return;
    };
    let Some(rx) = service.take_receiver() else {
        return;
    };
    thread::spawn(move || {
        while let Ok(outcome) = rx.recv() {
            match outcome {
                WatchOutcome::ExternalChange(e) => watch_event(e),
                WatchOutcome::Error(m) => {
                    emit(workspace::events::Event::WatcherError { message: m })
                }
                WatchOutcome::SelfSuppressed => {}
            }
        }
    });
    session::replace_watcher(service);
}
fn watch_event(e: MergedEvent) {
    let p = watch_event_payload(e);
    emit(workspace::events::Event::FileChanged { payload: p });
}

/// 构建 `workspace:file-changed` 载荷（纯函数，便于单测）。
fn watch_event_payload(e: MergedEvent) -> serde_json::Value {
    match e {
        MergedEvent::Created { path, ts_ms } => {
            json!({"path":watch_display_path(&path),"kind":"created","ts":ts_ms})
        }
        MergedEvent::Modified { path, ts_ms } => {
            json!({"path":watch_display_path(&path),"kind":"modified","ts":ts_ms})
        }
        MergedEvent::Removed { path, ts_ms } => {
            json!({"path":watch_display_path(&path),"kind":"removed","ts":ts_ms})
        }
        MergedEvent::Renamed { from, to, ts_ms } => {
            json!({
                "path": watch_display_path(&to),
                "from": watch_display_path(&from),
                "kind": "renamed",
                "ts": ts_ms
            })
        }
    }
}

/// 事件路径统一下行坐标系：剥离 Windows verbatim 前缀。
/// 监听根经 canonicalize（`\\?\D:\...`），notify 事件路径继承该前缀；
/// 若原样下发，前端 `findTabByPath`/`toRel` 与打开文件时的常规路径
/// （`D:\...`）永远无法匹配——clean tab 热重载与目录树外部刷新全部失效。
fn watch_display_path(p: &Path) -> String {
    workspace::display_path(p)
}

fn tree_list(_: &CommandContext, p: &CommandPayload) {
    let Some(r) = require_root() else { return };
    let rel = p.path.as_deref().unwrap_or("");
    let effective = effective_settings(&r);
    let filter = TreeFilter {
        visible_exts: effective.files.visible_exts,
        excluded_dirs: effective.files.exclude,
        show_hidden: effective.files.show_hidden,
    };
    match tree::list_dir(&r, rel, &filter) {
        Ok(v) => emit(workspace::events::Event::TreeListed {
            rel_dir: rel.into(),
            entries: serde_json::to_value(v).unwrap_or_else(|_| json!([])),
        }),
        Err(e) => error(format!("读取目录失败：{e}")),
    }
}
fn effective_settings(root: &Path) -> workspace::settings::Settings {
    let global = workspace::settings::load_global(&settings_base());
    let project = workspace::settings::load_project(root).unwrap_or_default();
    workspace::settings::effective(&global, &project)
}

fn search_start(_: &CommandContext, p: &CommandPayload) {
    let Some(r) = require_root() else { return };
    let o = value(p, &["options"]).unwrap_or_else(|| json!({}));
    let effective = effective_settings(&r);
    let id = o
        .get("searchId")
        .or_else(|| o.get("search_id"))
        .and_then(Value::as_str)
        .unwrap_or("search-1")
        .to_string();
    let mut s = SearchOptions::default();
    s.query = o.get("query").and_then(Value::as_str).unwrap_or("").into();
    s.case_sensitive = o
        .get("caseSensitive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    s.whole_word = o.get("wholeWord").and_then(Value::as_bool).unwrap_or(false);
    s.use_regex = o.get("regex").and_then(Value::as_bool).unwrap_or(false);
    s.exclude_globs = effective.search.exclude.clone();
    s.max_file_bytes = effective
        .search
        .max_file_size_mb
        .saturating_mul(1024 * 1024);
    s.max_results = effective.search.max_results;
    // Request options intentionally override effective settings for this interaction.
    s.max_file_bytes = o
        .get("maxFileBytes")
        .and_then(Value::as_u64)
        .or_else(|| o.get("max_file_size_mb").and_then(Value::as_u64))
        .unwrap_or(s.max_file_bytes);
    s.max_results = o
        .get("maxResults")
        .or_else(|| o.get("max_results"))
        .and_then(Value::as_u64)
        .unwrap_or(s.max_results as u64) as usize;
    if let Some(exclude) = o.get("exclude").and_then(Value::as_array) {
        s.exclude_globs = exclude
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
    }
    let cancel = session::register_search(&id);
    let generation = session::bump_search_generation();
    thread::spawn(move || {
        let mut hits = Vec::new();
        let result = search::search(&r, &s, &cancel, &mut |h| {
            hits.push(h);
            if hits.len() >= 100 && generation == session::search_generation() {
                emit(workspace::events::Event::SearchResult {
                    search_id: id.clone(),
                    hits: json!(std::mem::take(&mut hits)),
                });
            }
        });
        if !hits.is_empty() && generation == session::search_generation() {
            emit(workspace::events::Event::SearchResult {
                search_id: id.clone(),
                hits: json!(hits),
            });
        }
        let summary = match result {
            Ok(v) => serde_json::to_value(v).unwrap_or_default(),
            Err(e) => {
                json!({"error":e.to_string(),"filesScanned":0,"hits":0,"truncated":false,"cancelled":false})
            }
        };
        if generation == session::search_generation() {
            emit(workspace::events::Event::SearchCompleted {
                search_id: id.clone(),
                summary,
            });
        }
        session::remove_search(&id);
    });
}
fn search_cancel(_: &CommandContext, p: &CommandPayload) {
    if let Some(id) = string(p, &["searchId", "search_id"]) {
        session::cancel_search(&id);
    }
}

fn ensure_op(root: &Path, target: &Path) -> Result<(), OpError> {
    workspace::ensure_within_root(root, target)
        .map(|_| ())
        .map_err(|_| OpError::OutsideRoot {
            root: root.into(),
            target: target.into(),
        })
}
struct PlatformTrash;
impl TrashSink for PlatformTrash {
    fn to_trash(&self, path: &Path) -> Result<(), OpError> {
        platform::trash_ops()
            .to_trash(path)
            .map_err(|e| OpError::Io(std::io::Error::other(e.to_string())))
    }
}
fn done(ctx: &CommandContext, r: Result<operations::OpResult, OpError>) {
    match r {
        Ok(v) => {
            let id = v
                .undo
                .as_ref()
                .map(|u| session::with_undo(|s| s.push(u.clone())));
            emit(workspace::events::Event::FsOpDone {
                payload: v.applied.event_payload(id),
            });
        }
        Err(e) => ipc::send_to_js(ctx.webview, "error", &json!({"message":e.to_string()})),
    }
}
fn fs_create_file(c: &CommandContext, p: &CommandPayload) {
    if let (Some(r), Some(x)) = (require_root(), p.path.as_deref()) {
        done(c, operations::FileOps::new(ensure_op).create_file(&r, x));
    }
}
fn fs_create_dir(c: &CommandContext, p: &CommandPayload) {
    if let (Some(r), Some(x)) = (require_root(), p.path.as_deref()) {
        done(c, operations::FileOps::new(ensure_op).create_dir(&r, x));
    }
}
fn fs_rename(c: &CommandContext, p: &CommandPayload) {
    if let (Some(r), Some(x), Some(n)) = (
        require_root(),
        p.path.as_deref(),
        string(p, &["new_name", "newName"]),
    ) {
        done(c, operations::FileOps::new(ensure_op).rename(&r, x, &n));
    }
}
fn fs_move(c: &CommandContext, p: &CommandPayload) {
    if let (Some(r), Some(x), Some(d)) = (
        require_root(),
        p.path.as_deref(),
        string(p, &["dest_dir", "destDir"]),
    ) {
        done(c, operations::FileOps::new(ensure_op).move_entry(&r, x, &d));
    }
}
fn fs_copy(c: &CommandContext, p: &CommandPayload) {
    if let (Some(r), Some(x), Some(d)) = (
        require_root(),
        p.path.as_deref(),
        string(p, &["dest_dir", "destDir"]),
    ) {
        done(c, operations::FileOps::new(ensure_op).copy_entry(&r, x, &d));
    }
}
fn fs_delete(c: &CommandContext, p: &CommandPayload) {
    if let (Some(r), Some(x)) = (require_root(), p.path.as_deref()) {
        done(
            c,
            operations::FileOps::new(ensure_op).to_trash(&r, x, &PlatformTrash),
        );
    }
}
fn fs_undo(c: &CommandContext, p: &CommandPayload) {
    let id = number(p, &["undo_id", "undoId"]).unwrap_or(0);
    match session::with_undo(|s| s.undo(id)) {
        Ok(d) => emit(workspace::events::Event::FsOpDone {
            payload: d.event_payload(None),
        }),
        Err(e) => ipc::send_to_js(c.webview, "error", &json!({"message":e.to_string()})),
    }
}
fn fs_reveal(c: &CommandContext, p: &CommandPayload) {
    if let Some(r) = require_root() {
        let x = r.join(p.path.as_deref().unwrap_or(""));
        if let Err(e) = platform::revealer().reveal(&x) {
            ipc::send_to_js(c.webview, "error", &json!({"message":e.to_string()}));
        }
    }
}
fn fs_terminal(c: &CommandContext, p: &CommandPayload) {
    if let Some(r) = require_root() {
        let x = r.join(p.path.as_deref().unwrap_or(""));
        let d = if x.is_dir() {
            x
        } else {
            x.parent().unwrap_or(&r).to_path_buf()
        };
        let settings = workspace::settings::load_global(&settings_base());
        let result = if settings.files.terminal_path.is_empty() {
            platform::terminal_opener().open_in_terminal(&d)
        } else {
            platform::terminal::spawn_custom(
                &settings.files.terminal_path,
                &settings.files.terminal_args,
                &d,
            )
        };
        if let Err(e) = result {
            ipc::send_to_js(c.webview, "error", &json!({"message":e.to_string()}));
        }
    }
}
fn terminal_scan(_: &CommandContext, _: &CommandPayload) {
    let terminals = platform::terminal::scan_terminals();
    emit(workspace::events::Event::TerminalList {
        terminals: serde_json::to_value(terminals).unwrap_or_else(|_| json!([])),
    });
}
// ---------- CLI 命令别名 shim（FEAT-001） ----------

const SHIM_MARKER: &str = "rem GlanceMD-Ultra CLI shim v1";
const SHIM_NAMES: &[&str] = &["gmdu.cmd"];
const LEGACY_SHIM_NAMES: &[&str] = &["glance.cmd", "glancemd.cmd"];

/// shim 安装目录：`%LOCALAPPDATA%\Microsoft\WindowsApps` 通常在 Windows 用户 PATH 上。
#[cfg(target_os = "windows")]
fn shim_dir() -> Option<std::path::PathBuf> {
    dirs::data_local_dir().map(|d| d.join("Microsoft").join("WindowsApps"))
}

#[cfg(not(target_os = "windows"))]
fn shim_dir() -> Option<std::path::PathBuf> {
    None
}

/// shim 脚本内容：转发全部参数给当前 exe（含 `.`、`..` 等相对路径，
/// 由目标进程按调用方 CWD 解析）。
fn shim_script(exe: &std::path::Path) -> String {
    // `%` 在 cmd 中即使位于双引号内也会参与环境变量展开，需写成 `%%`。
    let exe = exe.to_string_lossy().replace('%', "%%");
    format!("@echo off\r\n{SHIM_MARKER}\r\n\"{}\" %*\r\n", exe)
}

fn shim_owned(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|text| text.lines().any(|line| line.trim() == SHIM_MARKER))
        .unwrap_or(false)
}

/// 清理旧版命令别名；只删除带本程序所有权标记的文件，第三方同名命令不碰。
fn remove_owned_legacy_shims(dir: &Path, errors: &mut Vec<String>) {
    for name in LEGACY_SHIM_NAMES {
        let path = dir.join(name);
        if path.exists() && shim_owned(&path) {
            if let Err(e) = std::fs::remove_file(&path) {
                errors.push(format!("清理旧命令 {name} 失败：{e}"));
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn shim_dir_on_path(dir: &Path) -> bool {
    let target = dir
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    std::env::var_os("PATH")
        .map(|value| {
            std::env::split_paths(&value).any(|entry| {
                entry
                    .to_string_lossy()
                    .replace('\\', "/")
                    .trim_end_matches('/')
                    .eq_ignore_ascii_case(target.trim_end_matches('/'))
            })
        })
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn shim_dir_on_path(_: &Path) -> bool {
    false
}

fn cli_shim_emit_status(message: String) {
    let dir = shim_dir()
        .map(|d| d.to_string_lossy().into_owned())
        .unwrap_or_default();
    let installed = shim_dir()
        .map(|d| SHIM_NAMES.iter().all(|name| shim_owned(&d.join(name))))
        .unwrap_or(false);
    emit(workspace::events::Event::CliShimStatus {
        installed,
        dir,
        message,
    });
}

fn cli_install_shim(ctx: &CommandContext, _: &CommandPayload) {
    let Some(dir) = shim_dir() else {
        cli_shim_emit_status("当前平台暂不支持自动安装 .cmd 命令别名".into());
        return;
    };
    if !shim_dir_on_path(&dir) {
        cli_shim_emit_status(format!(
            "{} 不在当前 PATH 中，未安装命令别名",
            dir.display()
        ));
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        cli_shim_emit_status("无法定位当前程序路径".into());
        return;
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        cli_shim_emit_status(format!("创建 shim 目录失败：{e}"));
        return;
    }

    // 预检所有目标：只允许新建；已存在且不属于本程序时拒绝整个操作，绝不覆盖。
    for name in SHIM_NAMES {
        let path = dir.join(name);
        if path.exists() && !shim_owned(&path) {
            cli_shim_emit_status(format!("命令 {name} 已被其他程序占用，未覆盖任何文件"));
            return;
        }
    }

    let script = shim_script(&exe);
    let mut created = Vec::new();
    for name in SHIM_NAMES {
        let path = dir.join(name);
        if path.exists() {
            continue; // 已有且通过所有权预检，不覆盖
        }
        if let Err(e) = atomic_save::atomic_write(&path, script.as_bytes()) {
            for created_path in &created {
                let _ = std::fs::remove_file(created_path);
            }
            cli_shim_emit_status(format!("写入 {name} 失败，已回滚：{e}"));
            return;
        }
        created.push(path);
    }
    let mut cleanup_errors = Vec::new();
    remove_owned_legacy_shims(&dir, &mut cleanup_errors);
    if !cleanup_errors.is_empty() {
        cli_shim_emit_status(cleanup_errors.join("；"));
        return;
    }
    let _ = ctx;
    cli_shim_emit_status(format!("已安装 gmdu 命令（{}）", dir.display()));
}

fn cli_remove_shim(ctx: &CommandContext, _: &CommandPayload) {
    let Some(dir) = shim_dir() else {
        cli_shim_emit_status("当前平台暂不支持自动移除 .cmd 命令别名".into());
        return;
    };
    let mut errors = Vec::new();
    for name in SHIM_NAMES {
        let path = dir.join(name);
        if !path.exists() {
            continue;
        }
        if !shim_owned(&path) {
            errors.push(format!("{name} 不属于 GlanceMD Ultra，未删除"));
            continue;
        }
        if let Err(e) = std::fs::remove_file(&path) {
            errors.push(format!("删除 {name} 失败：{e}"));
        }
    }
    remove_owned_legacy_shims(&dir, &mut errors);
    let _ = ctx;
    if errors.is_empty() {
        cli_shim_emit_status("已移除 gmdu 命令".into());
    } else {
        cli_shim_emit_status(errors.join("；"));
    }
}

fn cli_shim_status(ctx: &CommandContext, _: &CommandPayload) {
    let _ = ctx;
    cli_shim_emit_status(String::new());
}

fn watcher_pause(_: &CommandContext, _: &CommandPayload) {
    session::watcher_pause();
}
fn watcher_resume(_: &CommandContext, _: &CommandPayload) {
    session::watcher_resume();
}

/// 全局设置/恢复区的基目录：跟随便携数据目录（优先 exe 旁 data/，自动回退）。
/// `global_settings_path(base)` 等下游契约不变，仍以 `base` 注入。
fn settings_base() -> PathBuf {
    data_dir::data_base().to_path_buf()
}
fn settings_global(_: &CommandContext, _: &CommandPayload) {
    let x = workspace::settings::load_global_checked(&settings_base());
    emit(workspace::events::Event::SettingsGlobal {
        settings: serde_json::to_value(x.settings).unwrap_or_default(),
        warnings: x.warnings,
    });
}
fn settings_effective(_: &CommandContext, _: &CommandPayload) {
    let b = settings_base();
    let g = workspace::settings::load_global_checked(&b);
    let p = root().and_then(|r| workspace::settings::load_project_checked(&r));
    let (patch, w) = p.map(|x| (x.patch, x.warnings)).unwrap_or_default();
    let s = workspace::settings::effective(&g.settings, &patch);
    let overridden = workspace::settings::overridden_keys(&patch);
    emit(workspace::events::Event::SettingsEffective {
        settings: serde_json::to_value(s).unwrap_or_default(),
        warnings: [g.warnings, w].concat(),
        overridden,
    });
}
fn settings_set(_: &CommandContext, p: &CommandPayload) {
    let Some(raw) = value(p, &["data", "settings"]) else {
        return;
    };
    if let Err(e) = apply_settings_at(&settings_base(), raw) {
        error(e);
    }
}

fn settings_set_theme(_: &CommandContext, p: &CommandPayload) {
    let Some(theme) = string(p, &["theme"]) else {
        return;
    };
    let mut settings = workspace::settings::load_global(&settings_base());
    settings.appearance.theme = match theme.as_str() {
        "dark" => workspace::settings::Theme::Dark,
        "light" => workspace::settings::Theme::Light,
        "system" => workspace::settings::Theme::System,
        _ => {
            error("未知主题设置");
            return;
        }
    };
    let raw = serde_json::to_value(settings).unwrap_or_default();
    if let Err(e) = apply_settings_at(&settings_base(), raw) {
        error(e);
    }
}

/// `settings.set-global` 的纯逻辑：`data` 兼容两种形态——设置对象本身，或
/// JSON 编码字符串（前端信封按字符串传输，见 settings 契约 §5）；解码后
/// 迁移并落盘，成功返回 Ok，失败返回面向用户的中文错误。`base` 注入便于
/// 测试使用临时目录（不触碰真实用户配置）。
///
/// 监听开关接线：落盘成功后对比保存前后的 `watching.enableWatcher`
/// （保存前 `load_global` 读旧值，保存后再读一次得生效值）——关→`watcher_pause`，
/// 开→`watcher_resume`；未打开项目（无监听服务）时两者均为空操作。
fn apply_settings_at(base: &Path, raw: Value) -> Result<(), String> {
    let v = match raw {
        Value::String(s) => {
            serde_json::from_str::<Value>(&s).map_err(|e| format!("设置格式错误：{e}"))?
        }
        other => other,
    };
    let settings: workspace::settings::Settings =
        serde_json::from_value(v).map_err(|e| format!("设置格式错误：{e}"))?;
    let settings_before = workspace::settings::load_global(base);
    let watcher_before = settings_before.watching.enable_watcher;
    workspace::settings::save(base, &settings).map_err(|e| format!("保存设置失败：{e}"))?;
    let settings_after = workspace::settings::load_global(base);
    let watcher_after = settings_after.watching.enable_watcher;
    if watcher_before && !watcher_after {
        session::watcher_pause();
    } else if !watcher_before && watcher_after {
        session::watcher_resume();
    }
    if let Some(r) = root() {
        if settings_before.files.watcher_exclude != settings_after.files.watcher_exclude {
            start_watcher(r, &settings_after.files.watcher_exclude);
        }
    }
    emit(workspace::events::Event::SettingsChanged {
        scope: "global".into(),
    });
    Ok(())
}
fn settings_project(_: &CommandContext, _: &CommandPayload) {
    if let Some(r) = require_root() {
        let path = workspace::settings::project_settings_path(&r);
        let mut warnings = Vec::new();
        let loaded = workspace::settings::load_project_checked(&r);
        let patch = match loaded {
            Some(x) => {
                warnings = x.warnings;
                x.patch
            }
            None => {
                let create = effective_settings(&r).recovery.create_project_settings;
                if create {
                    let patch = workspace::settings::SettingsPatch {
                        version: Some(workspace::settings::SCHEMA_VERSION),
                        ..Default::default()
                    };
                    if let Err(e) = workspace::settings::save_project(&r, &patch) {
                        warnings.push(format!("创建项目设置失败：{e}"));
                    }
                }
                workspace::settings::load_project(&r).unwrap_or_default()
            }
        };
        emit(workspace::events::Event::SettingsProject {
            patch: serde_json::to_value(patch).unwrap_or_default(),
            warnings,
            path: Some(path.to_string_lossy().into()),
        });
    }
}
/// 确保全局 settings.json 存在（不存在则写入默认设置），返回其路径。
///
/// `explorer /select,<path>` 对不存在的路径只会打开资源管理器窗口而不选中
/// 任何东西（用户感知为"打开了我的电脑"），因此 reveal 前必须先落盘。
fn ensure_global_settings_file(base: &Path) -> std::path::PathBuf {
    let path = workspace::settings::global_settings_path(base);
    if !path.exists() {
        let default_settings = workspace::settings::load_global(base);
        if let Err(e) = workspace::settings::save(base, &default_settings) {
            error(format!("创建设置文件失败：{e}"));
            return path;
        }
    }
    path
}

fn settings_open(ctx: &CommandContext, p: &CommandPayload) {
    let scope = string(p, &["scope"]).unwrap_or_else(|| "global".into());
    let path = if scope == "project" {
        let Some(root) = require_root() else { return };
        let path = workspace::settings::project_settings_path(&root);
        if !path.exists() {
            let patch = workspace::settings::SettingsPatch {
                version: Some(workspace::settings::SCHEMA_VERSION),
                ..Default::default()
            };
            if let Err(e) = workspace::settings::save_project(&root, &patch) {
                error(format!("创建项目设置文件失败：{e}"));
                return;
            }
        }
        path
    } else {
        ensure_global_settings_file(&settings_base())
    };
    match std::fs::read(&path)
        .and_then(|b| file_codec::read_text(&b).map_err(|e| std::io::Error::other(e.to_string())))
    {
        Ok(text) => {
            session::store_file_meta(&path.to_string_lossy(), text.clone());
            ipc::send_to_js(
                ctx.webview,
                "file_opened",
                &json!({
                    "content": text.content,
                    "path": path.to_string_lossy()
                }),
            );
        }
        Err(e) => error(format!("无法打开设置文件：{e}")),
    }
}
fn recovery_store() -> RecoveryStore {
    RecoveryStore::open(&settings_base())
}
fn recovery_snapshot(_: &CommandContext, p: &CommandPayload) {
    if let Some(v) = value(p, &["data", "entry"]) {
        if let Ok(e) = serde_json::from_value::<RecoveryEntry>(v) {
            let _ = recovery_store().snapshot(&e);
        }
    }
}
fn recovery_list(_: &CommandContext, _: &CommandPayload) {
    let x = recovery_store().list_pending_report();
    let e = x
        .entries
        .iter()
        .map(|v| json!({"tab_id":v.tab_id,"path":v.path,"saved_at_ms":v.saved_at_ms}))
        .collect::<Vec<_>>();
    emit(workspace::events::Event::RecoveryAvailable {
        entries: json!(e),
        warnings: x.warnings,
    });
}
fn recovery_restore(_: &CommandContext, p: &CommandPayload) {
    if let Some(id) = string(p, &["tab_id", "tabId"]) {
        if let Some(e) = recovery_store().take(&id) {
            emit(workspace::events::Event::RecoveryRestored {
                tab_id: e.tab_id,
                path: e.path,
                content: e.content,
            });
        }
    }
}
fn recovery_discard(_: &CommandContext, p: &CommandPayload) {
    if let Some(id) = string(p, &["tab_id", "tabId"]) {
        recovery_store().discard(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn noop(_: &CommandContext, _: &CommandPayload) {}
    #[test]
    fn registry_rejects_duplicate() {
        let mut r = CommandRegistry::new();
        assert!(r.register("x", noop).is_ok());
        assert!(r.register("x", noop).is_err());
        assert!(r.lookup("missing").is_err());
    }
    #[test]
    fn payload_defaults() {
        assert!(CommandPayload::default().extra.is_null());
    }

    #[test]
    fn cli_shim脚本正确转发全部参数() {
        let script = shim_script(Path::new(r"D:\Apps\GlanceMD-Ultra.exe"));
        assert!(script.starts_with("@echo off\r\n"));
        assert!(script.contains(SHIM_MARKER));
        assert!(script.contains(r#""D:\Apps\GlanceMD-Ultra.exe" %*"#));
        assert!(script.ends_with("\r\n"));
        assert_eq!(SHIM_NAMES, ["gmdu.cmd"]);
        assert_eq!(LEGACY_SHIM_NAMES, ["glance.cmd", "glancemd.cmd"]);

        let percent = shim_script(Path::new(r"D:\100%\GlanceMD-Ultra.exe"));
        assert!(percent.contains(r#""D:\100%%\GlanceMD-Ultra.exe" %*"#));
    }

    #[test]
    fn cli_shim所有权标记防止覆盖与误删第三方文件() {
        let dir =
            std::env::temp_dir().join(format!("glancemd-ultra-shim-owned-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let owned = dir.join("owned.cmd");
        let foreign = dir.join("foreign.cmd");
        std::fs::write(
            &owned,
            shim_script(Path::new(r"D:\Apps\GlanceMD-Ultra.exe")),
        )
        .unwrap();
        std::fs::write(&foreign, "@echo off\r\necho foreign\r\n").unwrap();
        assert!(shim_owned(&owned));
        assert!(!shim_owned(&foreign));
        assert!(!shim_owned(&dir.join("missing.cmd")));

        let legacy = dir.join("glance.cmd");
        std::fs::write(
            &legacy,
            shim_script(Path::new(r"D:\Apps\GlanceMD-Ultra.exe")),
        )
        .unwrap();
        let mut errors = Vec::new();
        remove_owned_legacy_shims(&dir, &mut errors);
        assert!(errors.is_empty());
        assert!(!legacy.exists());
        // 第三方同名文件绝不删除
        std::fs::write(&legacy, "@echo off\r\necho foreign\r\n").unwrap();
        remove_owned_legacy_shims(&dir, &mut errors);
        assert!(legacy.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 单文件监听事件仅命中目标文件() {
        let target = "D:/docs/note.md";
        // 真实事件路径：根 canonicalize 后 notify 事件继承 `\\?\` verbatim 前缀
        let modified = MergedEvent::Modified {
            path: PathBuf::from(r"\\?\D:\docs\note.md"),
            ts_ms: 1,
        };
        let removed = MergedEvent::Removed {
            path: PathBuf::from(r"\\?\D:\docs\other.md"),
            ts_ms: 2,
        };
        let renamed = MergedEvent::Renamed {
            from: PathBuf::from(r"\\?\D:\docs\a.md"),
            to: PathBuf::from(r"\\?\D:\docs\note.md"),
            ts_ms: 3,
        };
        // 剥离前缀 + 分隔符归一 + Windows 大小写不敏感命中
        assert!(single_file_event_matches(&modified, target));
        // 兄弟文件事件被过滤，避免无关 reload 请求
        assert!(!single_file_event_matches(&removed, target));
        // 重命名成对事件直接放行，由前端 remapPath 处理
        assert!(single_file_event_matches(&renamed, target));
    }

    #[test]
    fn 监听事件载荷剥离_verbatim_前缀() {
        let e = MergedEvent::Modified {
            path: PathBuf::from(r"\\?\D:\proj\raw\articles\a.md"),
            ts_ms: 42,
        };
        let payload = watch_event_payload(e);
        assert_eq!(payload["path"], r"D:\proj\raw\articles\a.md");
        assert_eq!(payload["kind"], "modified");

        let renamed = MergedEvent::Renamed {
            from: PathBuf::from(r"\\?\D:\proj\old.md"),
            to: PathBuf::from(r"\\?\D:\proj\new.md"),
            ts_ms: 7,
        };
        let payload = watch_event_payload(renamed);
        assert_eq!(payload["path"], r"D:\proj\new.md");
        assert_eq!(payload["from"], r"D:\proj\old.md");
        assert_eq!(payload["kind"], "renamed");
    }

    #[test]
    fn apply_settings_接受字符串与对象两种_data_形态() {
        let base = std::env::temp_dir().join(format!(
            "glancemd-ultra-settings-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);

        // data = JSON 编码字符串（前端信封形态）：data 值本身就是字符串
        let raw = Value::String(r#"{"version":1,"appearance":{"theme":"dark"}}"#.into());
        apply_settings_at(&base, raw).unwrap();
        let saved = workspace::settings::load_global(&base);
        assert_eq!(saved.appearance.theme, workspace::settings::Theme::Dark);

        // data = 对象形态
        let raw = json!({ "version": 1, "appearance": { "theme": "light" } });
        apply_settings_at(&base, raw).unwrap();
        let saved = workspace::settings::load_global(&base);
        assert_eq!(saved.appearance.theme, workspace::settings::Theme::Light);

        // data = 非法字符串：报错且不落盘（文件内容保持上一次成功值）
        let raw = Value::String("not-json".into());
        assert!(apply_settings_at(&base, raw).is_err());
        let saved = workspace::settings::load_global(&base);
        assert_eq!(saved.appearance.theme, workspace::settings::Theme::Light);

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn ensure_global_settings_file_缺失时写入默认() {
        let base = std::env::temp_dir().join(format!(
            "glancemd-ultra-opensettings-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);

        let path = ensure_global_settings_file(&base);
        assert!(
            path.exists(),
            "调用后 settings.json 应已落盘：{}",
            path.display()
        );
        let saved = workspace::settings::load_global(&base);
        assert_eq!(saved.version, workspace::settings::SCHEMA_VERSION);

        // 已存在时不覆盖用户内容
        workspace::settings::save(
            &base,
            &workspace::settings::Settings {
                appearance: workspace::settings::Appearance {
                    theme: workspace::settings::Theme::Dark,
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .unwrap();
        let path2 = ensure_global_settings_file(&base);
        assert_eq!(path, path2);
        let saved = workspace::settings::load_global(&base);
        assert_eq!(saved.appearance.theme, workspace::settings::Theme::Dark);

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn apply_settings_监听开关落盘并可回切() {
        let base = std::env::temp_dir().join(format!(
            "glancemd-ultra-settings-watcher-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);

        // 关闭监听：保存后读回 false（pause/resume 在无监听服务时空操作，不 panic）
        let raw = json!({ "version": 1, "watching": { "enableWatcher": false } });
        apply_settings_at(&base, raw).unwrap();
        let saved = workspace::settings::load_global(&base);
        assert!(!saved.watching.enable_watcher);
        assert_eq!(saved.watching.auto_save, workspace::settings::AutoSave::Off);

        // 重新开启：走 resume 分支，同样落盘生效
        let raw = json!({ "version": 1, "watching": { "enableWatcher": true } });
        apply_settings_at(&base, raw).unwrap();
        assert!(
            workspace::settings::load_global(&base)
                .watching
                .enable_watcher
        );

        std::fs::remove_dir_all(&base).unwrap();
    }
}
