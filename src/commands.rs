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
        ("watcher.pause", watcher_pause),
        ("watcher.resume", watcher_resume),
        ("workspace.settings.get-global", settings_global),
        ("workspace.settings.get-effective", settings_effective),
        ("workspace.settings.set-global", settings_set),
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
        }
        Err(e) => ipc::send_to_js(
            ctx.webview,
            "error",
            &json!({"message":format!("Failed to open file: {e}")}),
        ),
    }
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
            session::clear_root();
            session::set_root(ws.root().to_path_buf());
            start_watcher(ws.root().to_path_buf());
            let _ = workspace::open_and_scan(path);
        }
        Err(e) => error(format!("打开项目失败：{e}")),
    }
}
fn start_watcher(root: PathBuf) {
    let Ok(service) = WatchService::new(&root, &[]) else {
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
    let p = match e {
        MergedEvent::Created { path, ts_ms } => {
            json!({"path":path.to_string_lossy(),"kind":"created","ts":ts_ms})
        }
        MergedEvent::Modified { path, ts_ms } => {
            json!({"path":path.to_string_lossy(),"kind":"modified","ts":ts_ms})
        }
        MergedEvent::Removed { path, ts_ms } => {
            json!({"path":path.to_string_lossy(),"kind":"removed","ts":ts_ms})
        }
        MergedEvent::Renamed { from, to, ts_ms } => {
            json!({"path":to.to_string_lossy(),"from":from.to_string_lossy(),"kind":"renamed","ts":ts_ms})
        }
    };
    emit(workspace::events::Event::FileChanged { payload: p });
}

fn tree_list(_: &CommandContext, p: &CommandPayload) {
    let Some(r) = require_root() else { return };
    let rel = p.path.as_deref().unwrap_or("");
    match tree::list_dir(&r, rel, &TreeFilter::default()) {
        Ok(v) => emit(workspace::events::Event::TreeListed {
            rel_dir: rel.into(),
            entries: serde_json::to_value(v).unwrap_or_else(|_| json!([])),
        }),
        Err(e) => error(format!("读取目录失败：{e}")),
    }
}
fn search_start(_: &CommandContext, p: &CommandPayload) {
    let Some(r) = require_root() else { return };
    let o = value(p, &["options"]).unwrap_or_else(|| json!({}));
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
    s.max_file_bytes = o
        .get("maxFileBytes")
        .and_then(Value::as_u64)
        .unwrap_or(s.max_file_bytes);
    s.max_results = o
        .get("maxResults")
        .and_then(Value::as_u64)
        .unwrap_or(s.max_results as u64) as usize;
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
        if let Err(e) = platform::terminal_opener().open_in_terminal(&d) {
            ipc::send_to_js(c.webview, "error", &json!({"message":e.to_string()}));
        }
    }
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
    emit(workspace::events::Event::SettingsEffective {
        settings: serde_json::to_value(s).unwrap_or_default(),
        warnings: [g.warnings, w].concat(),
        overridden: Vec::new(),
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

/// `settings.set-global` 的纯逻辑：`data` 兼容两种形态——设置对象本身，或
/// JSON 编码字符串（前端信封按字符串传输，见 settings 契约 §5）；解码后
/// 迁移并落盘，成功返回 Ok，失败返回面向用户的中文错误。`base` 注入便于
/// 测试使用临时目录（不触碰真实用户配置）。
fn apply_settings_at(base: &Path, raw: Value) -> Result<(), String> {
    let v = match raw {
        Value::String(s) => {
            serde_json::from_str::<Value>(&s).map_err(|e| format!("设置格式错误：{e}"))?
        }
        other => other,
    };
    let settings: workspace::settings::Settings =
        serde_json::from_value(v).map_err(|e| format!("设置格式错误：{e}"))?;
    workspace::settings::save(base, &settings).map_err(|e| format!("保存设置失败：{e}"))?;
    emit(workspace::events::Event::SettingsChanged {
        scope: "global".into(),
    });
    Ok(())
}
fn settings_project(_: &CommandContext, _: &CommandPayload) {
    if let Some(r) = require_root() {
        if let Some(x) = workspace::settings::load_project_checked(&r) {
            emit(workspace::events::Event::SettingsProject {
                patch: serde_json::to_value(x.patch).unwrap_or_default(),
                warnings: x.warnings,
                path: Some(
                    workspace::settings::project_settings_path(&r)
                        .to_string_lossy()
                        .into(),
                ),
            });
        }
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

fn settings_open(_: &CommandContext, _: &CommandPayload) {
    let path = ensure_global_settings_file(&settings_base());
    if let Err(e) = platform::revealer().reveal(&path) {
        error(format!("无法打开设置文件：{e}"));
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
}
