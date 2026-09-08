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
// ---------- CLI 安装核心（FEAT-001 重构） ----------
//
// 跨平台核心，GUI 设置页（cli.install-shim / cli.remove-shim / cli.shim-status）
// 与主程序 CLI 旗标（--install-cli / --uninstall-cli / --cli-status）共用：
// - Windows：在 current_exe 同级 bin/ 写 gmdu.cmd（以 %~dp0 相对引用 exe，
//   不硬编码文件名——release 产物名可变），并把该 bin 目录精确加入用户级
//   注册表 HKCU\Environment\Path（raw FFI 读写，保留原 REG_SZ/REG_EXPAND_SZ
//   类型，不用 setx），随后广播 WM_SETTINGCHANGE。已打开的终端不会自动更新，
//   由消息提示"新开终端生效"。
// - macOS/Linux：在 ~/.local/bin/gmdu 建 symlink 指向 current_exe；不修改
//   shell 配置，仅在 bin 目录不在 PATH 时提示。
// 所有权安全：Windows shim 只覆盖/删除带本程序标记的文件，第三方同名命令
// 绝不触碰；Unix symlink 只在指向 current_exe（或可识别为本程序，含失效
// 链接按目标文件名识别）时重建/删除。

/// 统一短命令名。
pub const CLI_NAME: &str = "gmdu";
/// shim 所有权标记（v2：exe 旁 bin/ + 自管理用户 PATH 方案）。
const SHIM_MARKER: &str = "rem GlanceMD-Ultra CLI shim v2";
/// 旧版 WindowsApps 方案的标记，迁移清理时识别。
const SHIM_MARKER_V1: &str = "rem GlanceMD-Ultra CLI shim v1";
/// 旧版 WindowsApps shim 文件名（仅清理带本程序标记的文件）。
const LEGACY_WINDOWSAPPS_NAMES: &[&str] = &["gmdu.cmd", "glance.cmd", "glancemd.cmd"];
/// Windows shim 文件名。
#[cfg(target_os = "windows")]
const CLI_SHIM_FILE: &str = "gmdu.cmd";

/// CLI 安装动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliAction {
    Install,
    Uninstall,
}

/// 安装状态报告（GUI 事件与 `--cli-status` 共用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliStatusReport {
    pub installed: bool,
    /// CLI 安装目录（Windows: exe 旁 bin/；Unix: ~/.local/bin）。
    pub dir: String,
    /// 异常说明（正常状态为空串）。
    pub message: String,
}

/// 所有权标记识别：v2 现行方案，v1 仅用于迁移清理。
fn shim_owned_text(text: &str) -> bool {
    text.lines()
        .any(|line| line.trim() == SHIM_MARKER || line.trim() == SHIM_MARKER_V1)
}

fn shim_owned(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|text| shim_owned_text(&text))
        .unwrap_or(false)
}

/// Windows shim 脚本内容：`%~dp0` 指向 bin 目录，`..` 回到 exe 所在目录，
/// 相对引用当前 exe 文件名（release 产物名可变，不硬编码）；转发全部参数。
/// `%` 在 cmd 中即使位于双引号内也会参与展开，文件名含 `%` 时需写成 `%%`。
fn shim_script(exe: &std::path::Path) -> String {
    let name = exe
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
        .replace('%', "%%");
    format!("@echo off\r\n{SHIM_MARKER}\r\n\"%~dp0..\\{name}\" %*\r\n")
}

/// PATH 条目比较键：统一分隔符并去尾分隔；Windows 路径大小写不敏感。
fn normalize_path_entry(entry: &str) -> String {
    let mut s = entry.trim().replace('\\', "/");
    while s.ends_with('/') {
        s.pop();
    }
    if cfg!(target_os = "windows") {
        s.to_ascii_lowercase()
    } else {
        s
    }
}

fn user_path_contains(value: &str, entry: &str) -> bool {
    let norm = normalize_path_entry(entry);
    value
        .split(';')
        .any(|item| normalize_path_entry(item) == norm)
}

/// 向用户 PATH 字符串精确加入条目（已存在则原样返回）。返回 (新值, 是否有变化)。
fn user_path_add(value: &str, entry: &str) -> (String, bool) {
    if user_path_contains(value, entry) {
        return (value.to_string(), false);
    }
    let mut v = value.to_string();
    if !v.is_empty() && !v.ends_with(';') {
        v.push(';');
    }
    v.push_str(entry);
    (v, true)
}

/// 从用户 PATH 字符串精确移除条目：仅删除匹配项，其余条目（含空项与
/// 尾分号等无关结构）原样保留。返回 (新值, 是否有变化)。
fn user_path_remove(value: &str, entry: &str) -> (String, bool) {
    let norm = normalize_path_entry(entry);
    let kept: Vec<&str> = value
        .split(';')
        .filter(|item| normalize_path_entry(item) != norm)
        .collect();
    if kept.len() == value.split(';').count() {
        return (value.to_string(), false);
    }
    (kept.join(";"), true)
}

/// Windows 注册表/环境广播的最小 raw FFI 层：不引入 windows crate 的
/// Registry feature，仅依赖 advapi32/user32 稳定 API；HKEY 以指针宽度的
/// isize 表示。禁止 setx（会展开 REG_EXPAND_SZ 并截断超长 PATH）。
#[cfg(target_os = "windows")]
mod win_registry {
    // 预定义 HKEY 值高位为符号位：必须经 i32 符号扩展到指针宽度，
    // 64 位下才是 0xFFFF_FFFF_8000_0001（u32 直接 as isize 会零扩展成错误句柄）
    pub const HKEY_CURRENT_USER: isize = 0x8000_0001u32 as i32 as isize;
    pub const KEY_QUERY_VALUE: u32 = 0x0001;
    pub const KEY_SET_VALUE: u32 = 0x0002;
    pub const REG_SZ: u32 = 1;
    pub const REG_EXPAND_SZ: u32 = 2;
    const ERROR_SUCCESS: i32 = 0;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_MORE_DATA: i32 = 234;

    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(
            hkey: isize,
            lpsubkey: *const u16,
            uloptions: u32,
            samdesired: u32,
            phkresult: *mut isize,
        ) -> i32;
        fn RegQueryValueExW(
            hkey: isize,
            lpvaluename: *const u16,
            lpreserved: *mut u32,
            lptype: *mut u32,
            lpdata: *mut u8,
            lpcbdata: *mut u32,
        ) -> i32;
        fn RegSetValueExW(
            hkey: isize,
            lpvaluename: *const u16,
            reserved: u32,
            dwtype: u32,
            lpdata: *const u8,
            cbdata: u32,
        ) -> i32;
        fn RegCloseKey(hkey: isize) -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn SendMessageTimeoutW(
            hwnd: isize,
            msg: u32,
            wparam: usize,
            lparam: isize,
            fuflags: u32,
            utimeout: u32,
            lpdwresult: *mut usize,
        ) -> usize;
    }

    /// UTF-16 编码并补 NUL 终止符。
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 读取 HKCU\Environment 的 Path 值：Ok(None)=键或值不存在；
    /// Err=读取失败或类型不受支持（REG_SZ/REG_EXPAND_SZ 之外拒绝修改，
    /// 避免损坏多字符串等其他形态）。返回 (字符串, 原注册表类型)，
    /// 调用方写回时保留原类型。
    pub fn read_user_path() -> Result<Option<(String, u32)>, String> {
        unsafe {
            let subkey = wide("Environment");
            let mut hkey: isize = 0;
            let rc = RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                KEY_QUERY_VALUE,
                &mut hkey,
            );
            if rc == ERROR_FILE_NOT_FOUND {
                return Ok(None);
            }
            if rc != ERROR_SUCCESS {
                return Err(format!("打开注册表 Environment 失败（错误码 {rc}）"));
            }
            let name = wide("Path");
            let mut ty: u32 = 0;
            let mut len: u32 = 0;
            let rc = RegQueryValueExW(
                hkey,
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut ty,
                std::ptr::null_mut(),
                &mut len,
            );
            if rc == ERROR_FILE_NOT_FOUND {
                let _ = RegCloseKey(hkey);
                return Ok(None);
            }
            if rc != ERROR_SUCCESS && rc != ERROR_MORE_DATA {
                let _ = RegCloseKey(hkey);
                return Err(format!("查询用户 PATH 失败（错误码 {rc}）"));
            }
            if ty != REG_SZ && ty != REG_EXPAND_SZ {
                let _ = RegCloseKey(hkey);
                return Err(format!(
                    "用户 PATH 类型不受支持（类型码 {ty}），为避免损坏未修改"
                ));
            }
            let mut buf = vec![0u8; len as usize];
            let rc = RegQueryValueExW(
                hkey,
                name.as_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                buf.as_mut_ptr(),
                &mut len,
            );
            let _ = RegCloseKey(hkey);
            if rc != ERROR_SUCCESS {
                return Err(format!("读取用户 PATH 失败（错误码 {rc}）"));
            }
            let units: Vec<u16> = buf
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            let value = String::from_utf16_lossy(&units);
            Ok(Some((value.trim_end_matches('\0').to_string(), ty)))
        }
    }

    /// 写回 HKCU\Environment\Path，保留原注册表类型（新建时由调用方传
    /// REG_EXPAND_SZ）。值以 NUL 终止的 UTF-16 写入。
    pub fn write_user_path(value: &str, reg_type: u32) -> Result<(), String> {
        unsafe {
            let subkey = wide("Environment");
            let mut hkey: isize = 0;
            let rc = RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                KEY_SET_VALUE,
                &mut hkey,
            );
            if rc != ERROR_SUCCESS {
                return Err(format!("打开注册表 Environment 失败（错误码 {rc}）"));
            }
            let name = wide("Path");
            let mut units: Vec<u16> = value.encode_utf16().collect();
            units.push(0);
            let rc = RegSetValueExW(
                hkey,
                name.as_ptr(),
                0,
                reg_type,
                units.as_ptr() as *const u8,
                (units.len() * 2) as u32,
            );
            let _ = RegCloseKey(hkey);
            if rc != ERROR_SUCCESS {
                return Err(format!("写入用户 PATH 失败（错误码 {rc}）"));
            }
            Ok(())
        }
    }

    /// 广播 WM_SETTINGCHANGE，让资源管理器与新启动的进程感知用户 PATH
    /// 变化（尽力而为，失败不影响结果）。已打开的终端不会更新。
    pub fn broadcast_environment_change() {
        const HWND_BROADCAST: isize = 0xFFFF;
        const WM_SETTINGCHANGE: u32 = 0x001A;
        const SMTO_ABORTIFHUNG: u32 = 0x0002;
        let env = wide("Environment");
        unsafe {
            let _ = SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                env.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                2000,
                std::ptr::null_mut(),
            );
        }
    }
}

/// CLI 安装目录：Windows 取 current_exe 同级 bin/（随安装位置移动），
/// Unix 取 ~/.local/bin。
#[cfg(target_os = "windows")]
fn cli_bin_dir(exe: &Path) -> Option<PathBuf> {
    exe.parent().map(|p| p.join("bin"))
}

#[cfg(not(target_os = "windows"))]
fn cli_bin_dir(_exe: &Path) -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".local").join("bin"))
}

/// 定位 CLI 目标：(current_exe, 安装目录)。
fn cli_target() -> Result<(PathBuf, PathBuf), String> {
    let exe = std::env::current_exe().map_err(|_| "无法定位当前程序路径".to_string())?;
    let bin = cli_bin_dir(&exe).ok_or_else(|| "无法确定 CLI 安装目录".to_string())?;
    Ok((exe, bin))
}

/// 写入 Windows shim（bin 目录须已存在）。已存在且非本程序所有时拒绝，
/// 绝不覆盖第三方文件；本程序所有时原子覆盖（重装修复）。
#[cfg(target_os = "windows")]
fn write_windows_shim(bin_dir: &Path, exe: &Path) -> Result<(), String> {
    let shim = bin_dir.join(CLI_SHIM_FILE);
    if shim.exists() && !shim_owned(&shim) {
        return Err(format!(
            "{CLI_SHIM_FILE} 已被其他程序占用（{}），未覆盖任何文件",
            bin_dir.display()
        ));
    }
    atomic_save::atomic_write(&shim, shim_script(exe).as_bytes())
        .map_err(|e| format!("写入 {CLI_SHIM_FILE} 失败：{e}"))
}

/// 删除 bin 目录下的 Windows shim（仅限本程序所有）。不存在时幂等返回 Ok(false)。
#[cfg(target_os = "windows")]
fn remove_owned_shim_file(bin_dir: &Path) -> Result<bool, String> {
    let shim = bin_dir.join(CLI_SHIM_FILE);
    if !shim.exists() {
        return Ok(false);
    }
    if !shim_owned(&shim) {
        return Err(format!("{CLI_SHIM_FILE} 不属于 GlanceMD Ultra，未删除"));
    }
    std::fs::remove_file(&shim).map_err(|e| format!("删除 {CLI_SHIM_FILE} 失败：{e}"))?;
    Ok(true)
}

/// 清理旧版 WindowsApps 方案残留：只删除带本程序所有权标记（v1/v2）的文件，
/// 第三方同名命令绝不触碰。
#[cfg(target_os = "windows")]
fn remove_legacy_windowsapps_shims(errors: &mut Vec<String>) {
    let Some(dir) = dirs::data_local_dir().map(|d| d.join("Microsoft").join("WindowsApps")) else {
        return;
    };
    for name in LEGACY_WINDOWSAPPS_NAMES {
        let path = dir.join(name);
        if path.exists() && shim_owned(&path) {
            if let Err(e) = std::fs::remove_file(&path) {
                errors.push(format!("清理旧命令 {name} 失败：{e}"));
            }
        }
    }
}

/// AppImage 可信目标判定（纯函数，跨平台可测）：仅当官方运行时同时设置了
/// `APPIMAGE`（原始文件绝对路径）与 `APPDIR`（本次运行挂载点）、APPIMAGE
/// 指向存在的常规文件、且 current_exe 确实位于 APPDIR 之内时，返回
/// APPIMAGE 路径作为 symlink 目标。挂载点随运行结束消失，绝不能链接
/// current_exe；同时避免仅有伪造的 APPIMAGE 变量时把入口链接到第三方文件。
fn trusted_appimage_target(
    exe: &Path,
    appimage: Option<&std::ffi::OsStr>,
    appdir: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    let appimage = PathBuf::from(appimage?);
    let appdir = PathBuf::from(appdir?);
    if !appimage.is_absolute() || !appimage.is_file() {
        return None;
    }
    if !appdir.is_absolute() || !exe.starts_with(&appdir) {
        return None;
    }
    Some(appimage)
}

/// Unix 下 symlink 的期望目标：可信 AppImage 场景返回 APPIMAGE 原文件路径
/// （持久、用户可见），否则返回 current_exe（deb/裸二进制的安装路径持久）。
fn cli_link_target(exe: &Path) -> PathBuf {
    trusted_appimage_target(
        exe,
        std::env::var_os("APPIMAGE").as_deref(),
        std::env::var_os("APPDIR").as_deref(),
    )
    .unwrap_or_else(|| exe.to_path_buf())
}

/// CLI 安装所有权记录（安装成功后落盘，独立于 shim/symlink 本身）：
/// - Unix：仅当失效链接的路径与记录中的 entry 一致时才认定己有（目标移动后
///   的迁移修复）；仅凭目标文件名相同不足以认定第三方链接为己有。
/// - Windows：`path_added` 记录用户 PATH 的 bin 条目是否为本次安装新增——
///   非新增（用户预先存在）的条目卸载时保留，绝不误删。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct CliOwnership {
    /// 本程序创建的入口路径（Unix symlink / Windows shim）
    entry: String,
    /// 创建时的链接目标（Unix；Windows 为空）
    target: String,
    /// 用户 PATH 的 bin 条目是否为本次安装新增（Windows）
    path_added: bool,
}

/// 所有权记录存放路径（用户数据目录，跨安装位置持久）。
fn ownership_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("glancemd-ultra").join("cli-ownership.json"))
}

/// 读取所有权记录：不存在或损坏时返回 None（后续操作按保守语义处理）。
fn load_ownership(path: &Path) -> Option<CliOwnership> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

/// 原子写入所有权记录（尽力而为；失败时卸载退化为保守语义）。
fn save_ownership(path: &Path, record: &CliOwnership) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_vec(record) {
        Ok(bytes) => {
            let _ = atomic_save::atomic_write(path, &bytes);
        }
        Err(_) => {}
    }
}

/// 路径一致比较（归一分隔符；Windows 大小写不敏感）。
fn same_path(a: &str, b: &Path) -> bool {
    normalize_path_entry(a) == normalize_path_entry(&b.to_string_lossy())
}

/// Unix symlink 所有权判定（`record` 为安装时落盘的所有权记录）：
/// - 链接可解析：仅当 canonicalize 后与当前期望安装目标**完全相等**才视为
///   己有（指向旧目标或其他程序一律非己有，拒绝覆盖删除）；
/// - 链接失效（目标已移动/删除）：仅当所有权记录证明该链接路径由本程序
///   创建时才认定己有（迁移修复）；
/// - 非 symlink 或无记录佐证：一律非本程序所有。
#[cfg(not(target_os = "windows"))]
fn unix_shim_owned(link: &Path, target: &Path, record: Option<&CliOwnership>) -> bool {
    if std::fs::read_link(link).is_err() {
        return false;
    }
    if let Ok(resolved) = std::fs::canonicalize(link) {
        return std::fs::canonicalize(target)
            .map(|t| resolved == t)
            .unwrap_or(false);
    }
    record.map(|r| same_path(&r.entry, link)).unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn install_impl(exe: &Path, bin: &Path) -> Result<String, String> {
    install_impl_at(exe, bin, ownership_path().as_deref())
}

#[cfg(target_os = "windows")]
fn install_impl_at(exe: &Path, bin: &Path, record_path: Option<&Path>) -> Result<String, String> {
    std::fs::create_dir_all(bin).map_err(|e| format!("创建 {} 失败：{e}", bin.display()))?;
    write_windows_shim(bin, exe)?;
    // 迁移：清理旧版 WindowsApps 方案残留（仅带本程序标记的文件）
    let mut cleanup_errors = Vec::new();
    remove_legacy_windowsapps_shims(&mut cleanup_errors);
    // 用户级 PATH：精确加入 bin 目录（去重、保留原注册表类型）；
    // 是否为本次新增记入所有权记录，卸载时仅移除新增条目
    let mut path_added = false;
    match win_registry::read_user_path() {
        Ok(Some((value, ty))) => {
            let (new_value, changed) = user_path_add(&value, &bin.to_string_lossy());
            if changed {
                win_registry::write_user_path(&new_value, ty)
                    .map_err(|e| format!("更新用户 PATH 失败：{e}"))?;
                win_registry::broadcast_environment_change();
                path_added = true;
            }
        }
        Ok(None) => {
            // Path 值不存在（罕见）：以 REG_EXPAND_SZ 新建
            let (new_value, changed) = user_path_add("", &bin.to_string_lossy());
            if changed {
                win_registry::write_user_path(&new_value, win_registry::REG_EXPAND_SZ)
                    .map_err(|e| format!("创建用户 PATH 失败：{e}"))?;
                win_registry::broadcast_environment_change();
                path_added = true;
            }
        }
        Err(e) => return Err(e),
    }
    if let Some(rp) = record_path {
        save_ownership(
            rp,
            &CliOwnership {
                entry: bin.join(CLI_SHIM_FILE).to_string_lossy().into_owned(),
                target: String::new(),
                path_added,
            },
        );
    }
    if !cleanup_errors.is_empty() {
        return Err(cleanup_errors.join("；"));
    }
    Ok(format!(
        "已安装 {CLI_NAME} 命令（{}）。请在新开的终端中使用；已打开的终端不会自动识别新命令。",
        bin.display()
    ))
}

#[cfg(target_os = "windows")]
fn uninstall_impl(exe: &Path, bin: &Path) -> Result<String, String> {
    uninstall_impl_at(exe, bin, ownership_path().as_deref())
}

#[cfg(target_os = "windows")]
fn uninstall_impl_at(exe: &Path, bin: &Path, record_path: Option<&Path>) -> Result<String, String> {
    let _ = exe;
    let mut errors = Vec::new();
    if let Err(e) = remove_owned_shim_file(bin) {
        errors.push(e);
    }
    remove_legacy_windowsapps_shims(&mut errors);
    // PATH 精确移除的门控：仅当所有权记录证明 bin 条目是本次安装新增时才移除；
    // 用户预先存在或记录缺失（无法证明归属）时保守保留，绝不误删用户 PATH 条目
    let path_added = record_path
        .and_then(load_ownership)
        .map(|record| record.path_added)
        .unwrap_or(false);
    let mut kept_path_entry = false;
    if path_added {
        match win_registry::read_user_path() {
            Ok(Some((value, ty))) => {
                let (new_value, changed) = user_path_remove(&value, &bin.to_string_lossy());
                if changed {
                    if let Err(e) = win_registry::write_user_path(&new_value, ty) {
                        errors.push(format!("更新用户 PATH 失败：{e}"));
                    } else {
                        win_registry::broadcast_environment_change();
                    }
                }
            }
            Ok(None) => {}
            Err(e) => errors.push(e),
        }
    } else {
        // 记录缺失/非新增：检查是否仍有该条目，有则提示保留
        kept_path_entry = win_registry::read_user_path()
            .ok()
            .flatten()
            .map(|(value, _)| user_path_contains(&value, &bin.to_string_lossy()))
            .unwrap_or(false);
    }
    if errors.is_empty() {
        // 卸载完成：清理所有权记录
        if let Some(rp) = record_path {
            let _ = std::fs::remove_file(rp);
        }
        if kept_path_entry {
            Ok(format!(
                "已移除 {CLI_NAME} 命令（用户 PATH 中的 bin 条目并非本次安装新增，已保留）"
            ))
        } else {
            Ok(format!("已移除 {CLI_NAME} 命令"))
        }
    } else {
        Err(errors.join("；"))
    }
}

#[cfg(target_os = "windows")]
fn status_impl(exe: &Path, bin: &Path) -> CliStatusReport {
    let _ = exe;
    let shim = bin.join(CLI_SHIM_FILE);
    let shim_ok = shim.exists() && shim_owned(&shim);
    let path_ok = win_registry::read_user_path()
        .ok()
        .flatten()
        .map(|(value, _)| user_path_contains(&value, &bin.to_string_lossy()))
        .unwrap_or(false);
    let installed = shim_ok && path_ok;
    let message = if installed {
        String::new()
    } else if shim_ok && !path_ok {
        format!("{CLI_SHIM_FILE} 存在，但 bin 目录不在用户 PATH 中")
    } else if !shim_ok && path_ok {
        format!("用户 PATH 已包含 bin 目录，但 {CLI_SHIM_FILE} 缺失")
    } else {
        String::new()
    };
    CliStatusReport {
        installed,
        dir: bin.to_string_lossy().into_owned(),
        message,
    }
}

#[cfg(not(target_os = "windows"))]
fn install_impl(exe: &Path, bin: &Path) -> Result<String, String> {
    install_impl_at(exe, bin, ownership_path().as_deref())
}

#[cfg(not(target_os = "windows"))]
fn install_impl_at(exe: &Path, bin: &Path, record_path: Option<&Path>) -> Result<String, String> {
    use std::os::unix::fs::symlink;
    std::fs::create_dir_all(bin).map_err(|e| format!("创建 {} 失败：{e}", bin.display()))?;
    // AppImage 运行时内执行时链接原始 .AppImage 文件（持久），否则链接 current_exe
    let target = cli_link_target(exe);
    let link = bin.join(CLI_NAME);
    let record = record_path.and_then(load_ownership);
    if link.symlink_metadata().is_ok() {
        if !unix_shim_owned(&link, &target, record.as_ref()) {
            return Err(format!(
                "命令 {CLI_NAME} 已被其他程序占用（{}），未覆盖",
                bin.display()
            ));
        }
        // 本程序所有：删除后重建（修复目标移动/改名导致的失效链接）
        std::fs::remove_file(&link).map_err(|e| format!("重建 {CLI_NAME} 失败：{e}"))?;
    }
    symlink(&target, &link).map_err(|e| format!("创建 {CLI_NAME} 失败：{e}"))?;
    // 落盘所有权记录：卸载/重装时证明该链接由本程序创建（目标可变，路径是锚点）
    if let Some(rp) = record_path {
        save_ownership(
            rp,
            &CliOwnership {
                entry: link.to_string_lossy().into_owned(),
                target: target.to_string_lossy().into_owned(),
                path_added: false,
            },
        );
    }
    // Unix 不修改 shell 配置；仅在 bin 目录不在进程 PATH 时提示
    let on_path = std::env::var_os("PATH")
        .map(|v| {
            std::env::split_paths(&v).any(|p| {
                normalize_path_entry(&p.to_string_lossy())
                    == normalize_path_entry(&bin.to_string_lossy())
            })
        })
        .unwrap_or(false);
    let hint = if on_path {
        "可能需要重新打开终端后生效。".to_string()
    } else {
        format!(
            "注意：{} 当前不在 PATH 中，请将其加入 PATH（或重新登录）后使用。",
            bin.display()
        )
    };
    Ok(format!(
        "已安装 {CLI_NAME} 命令（{} → {}）。{hint}",
        link.display(),
        target.display()
    ))
}

#[cfg(not(target_os = "windows"))]
fn uninstall_impl(exe: &Path, bin: &Path) -> Result<String, String> {
    uninstall_impl_at(exe, bin, ownership_path().as_deref())
}

#[cfg(not(target_os = "windows"))]
fn uninstall_impl_at(exe: &Path, bin: &Path, record_path: Option<&Path>) -> Result<String, String> {
    let target = cli_link_target(exe);
    let link = bin.join(CLI_NAME);
    if link.symlink_metadata().is_err() {
        return Ok(format!("未安装 {CLI_NAME} 命令"));
    }
    let record = record_path.and_then(load_ownership);
    if !unix_shim_owned(&link, &target, record.as_ref()) {
        return Err(format!("{CLI_NAME} 不属于 GlanceMD Ultra，未删除"));
    }
    std::fs::remove_file(&link).map_err(|e| format!("删除 {CLI_NAME} 失败：{e}"))?;
    // 卸载完成：清理所有权记录
    if let Some(rp) = record_path {
        let _ = std::fs::remove_file(rp);
    }
    Ok(format!("已移除 {CLI_NAME} 命令"))
}

#[cfg(not(target_os = "windows"))]
fn status_impl(exe: &Path, bin: &Path) -> CliStatusReport {
    let target = cli_link_target(exe);
    let link = bin.join(CLI_NAME);
    let exists = link.symlink_metadata().is_ok();
    let record = load_cli_ownership();
    let installed = exists && unix_shim_owned(&link, &target, record.as_ref());
    let message = if installed || !exists {
        String::new()
    } else {
        format!("{CLI_NAME} 已存在但不属于 GlanceMD Ultra")
    };
    CliStatusReport {
        installed,
        dir: bin.to_string_lossy().into_owned(),
        message,
    }
}

/// 执行 CLI 安装/卸载核心（GUI 设置页与主程序 CLI 旗标共用）。
/// Ok = 面向用户的成功消息，Err = 面向用户的失败原因。
pub fn run_cli_action(action: CliAction) -> Result<String, String> {
    let (exe, bin) = cli_target()?;
    match action {
        CliAction::Install => install_impl(&exe, &bin),
        CliAction::Uninstall => uninstall_impl(&exe, &bin),
    }
}

/// 查询 CLI 安装状态（GUI 设置页与 --cli-status 共用）。
pub fn cli_status_report() -> CliStatusReport {
    match cli_target() {
        Ok((exe, bin)) => status_impl(&exe, &bin),
        Err(message) => CliStatusReport {
            installed: false,
            dir: String::new(),
            message,
        },
    }
}

fn cli_shim_emit_status(message: String) {
    let report = cli_status_report();
    emit(workspace::events::Event::CliShimStatus {
        installed: report.installed,
        dir: report.dir,
        message,
    });
}

fn cli_install_shim(_ctx: &CommandContext, _: &CommandPayload) {
    let message = match run_cli_action(CliAction::Install) {
        Ok(m) | Err(m) => m,
    };
    cli_shim_emit_status(message);
}

fn cli_remove_shim(_ctx: &CommandContext, _: &CommandPayload) {
    let message = match run_cli_action(CliAction::Uninstall) {
        Ok(m) | Err(m) => m,
    };
    cli_shim_emit_status(message);
}

fn cli_shim_status(_ctx: &CommandContext, _: &CommandPayload) {
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
    fn cli_shim脚本相对路径转义百分号且不硬编码文件名() {
        let script = shim_script(Path::new(r"D:\Apps\GlanceMD-Ultra.exe"));
        assert!(script.starts_with("@echo off\r\n"));
        assert!(script.contains(SHIM_MARKER));
        assert!(script.contains(r#""%~dp0..\GlanceMD-Ultra.exe" %*"#));
        assert!(script.ends_with("\r\n"));

        // release 产物名可变（如 GlanceMD-Ultra-windows-x64.exe）：跟随当前 exe 文件名
        let renamed = shim_script(Path::new(r"D:\Apps\GlanceMD-Ultra-windows-x64.exe"));
        assert!(renamed.contains(r#""%~dp0..\GlanceMD-Ultra-windows-x64.exe" %*"#));

        // % 在 cmd 双引号内仍参与展开，必须转义为 %%
        let percent = shim_script(Path::new(r"D:\Apps\100%.exe"));
        assert!(percent.contains(r#""%~dp0..\100%%.exe" %*"#));

        assert_eq!(CLI_NAME, "gmdu");
    }

    #[test]
    fn shim所有权标记识别新旧版本并拒绝第三方() {
        assert!(shim_owned_text(&format!("@echo off\r\n{SHIM_MARKER}\r\n")));
        // v1 仅用于迁移清理时识别
        assert!(shim_owned_text(&format!(
            "@echo off\r\n{SHIM_MARKER_V1}\r\n"
        )));
        assert!(!shim_owned_text("@echo off\r\necho foreign\r\n"));
        assert!(!shim_owned_text(""));
    }

    #[test]
    fn user_path_加入精确去重且移除不伤其他条目() {
        // 平台无关语义：同一写法的去重与精确移除
        let (v, changed) = user_path_add("", "/apps/bin");
        assert!(changed);
        assert_eq!(v, "/apps/bin");

        let (v2, changed2) = user_path_add(&v, "/apps/bin");
        assert!(!changed2);
        assert_eq!(v2, "/apps/bin");

        let (v3, changed3) = user_path_add(&v, "/other");
        assert!(changed3);
        assert_eq!(v3, "/apps/bin;/other");

        // 移除中间条目：其余原样保留
        let (v4, changed4) = user_path_remove(&v3, "/apps/bin");
        assert!(changed4);
        assert_eq!(v4, "/other");

        // 移除尾条目：无关的尾分号原样保留，不重构用户 PATH
        let (v5, changed5) = user_path_remove("/apps/bin;/other;", "/other");
        assert!(changed5);
        assert_eq!(v5, "/apps/bin;");

        // 不存在条目：原样返回
        let (v6, changed6) = user_path_remove("/a;/b", "/nope");
        assert!(!changed6);
        assert_eq!(v6, "/a;/b");

        // 非目标空段（;;）保留不动
        let (v7, changed7) = user_path_remove("a;;b", "x");
        assert!(!changed7);
        assert_eq!(v7, "a;;b");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn user_path_windows大小写与分隔符归一() {
        let (v, changed) = user_path_add(r"D:\Apps\bin", "d:/apps/bin/");
        assert!(!changed);
        assert_eq!(v, r"D:\Apps\bin");

        let (v2, changed2) = user_path_remove("C:\\x;D:\\APPS\\BIN;C:\\y", r"d:\apps\bin");
        assert!(changed2);
        assert_eq!(v2, r"C:\x;C:\y");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_shim写入覆盖与安全移除() {
        let dir =
            std::env::temp_dir().join(format!("glancemd-ultra-shim-v2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = Path::new(r"D:\Apps\GlanceMD-Ultra-windows-x64.exe");

        // 全新写入
        write_windows_shim(&dir, exe).unwrap();
        let shim = dir.join("gmdu.cmd");
        assert!(shim_owned(&shim));

        // 重装（own → 原子覆盖修复）
        write_windows_shim(&dir, exe).unwrap();

        // 第三方文件：写入与删除均拒绝
        std::fs::write(&shim, "@echo off\r\necho foreign\r\n").unwrap();
        assert!(write_windows_shim(&dir, exe).is_err());
        assert!(remove_owned_shim_file(&dir).is_err());
        assert!(shim.exists());

        // own → 删除；不存在 → 幂等 false
        std::fs::write(&shim, shim_script(exe)).unwrap();
        assert_eq!(remove_owned_shim_file(&dir).unwrap(), true);
        assert!(!shim.exists());
        assert_eq!(remove_owned_shim_file(&dir).unwrap(), false);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn appimage_目标仅可信来源生效() {
        let dir =
            std::env::temp_dir().join(format!("glancemd-ultra-appimage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("GlanceMD-Ultra.AppImage");
        std::fs::write(&real, b"appimage").unwrap();
        let mount = dir.join("tmp-mount");
        let exe_in_mount = mount.join("usr/bin/glancemd-ultra");
        let exe_outside = dir.join("glancemd-ultra");

        // 完整可信：APPIMAGE 指向存在的文件 + current_exe 位于 APPDIR 内
        assert_eq!(
            trusted_appimage_target(
                &exe_in_mount,
                Some(real.as_os_str()),
                Some(mount.as_os_str())
            ),
            Some(real.clone())
        );
        // 仅设 APPIMAGE 不设 APPDIR：不信任（防伪造变量）
        assert_eq!(
            trusted_appimage_target(&exe_in_mount, Some(real.as_os_str()), None),
            None
        );
        // current_exe 不在 APPDIR 内：不信任（防第三方入口归属混淆）
        assert_eq!(
            trusted_appimage_target(
                &exe_outside,
                Some(real.as_os_str()),
                Some(mount.as_os_str())
            ),
            None
        );
        // APPIMAGE 为相对路径或指向不存在的文件：不信任
        assert_eq!(
            trusted_appimage_target(
                &exe_in_mount,
                Some(Path::new("rel.AppImage").as_os_str()),
                Some(mount.as_os_str())
            ),
            None
        );
        assert_eq!(
            trusted_appimage_target(
                &exe_in_mount,
                Some(dir.join("missing.AppImage").as_os_str()),
                Some(mount.as_os_str())
            ),
            None
        );
        // 无运行时变量（deb/裸二进制）：None → cli_link_target 回退 current_exe
        assert_eq!(trusted_appimage_target(&exe_outside, None, None), None);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unix_symlink安装重建与安全移除() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(format!("glancemd-ultra-cli-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 记录路径注入临时目录，绝不触碰真实用户数据目录
        let record_path = dir.join("ownership.json");
        let app_dir = dir.join("app");
        std::fs::create_dir_all(&app_dir).unwrap();
        let exe = app_dir.join("GlanceMD-Ultra");
        std::fs::write(&exe, b"exe").unwrap();
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let link = bin.join("gmdu");

        // 全新安装（写入所有权记录）
        assert!(install_impl_at(&exe, &bin, Some(&record_path)).is_ok());
        assert!(unix_shim_owned(&link, &exe, None));

        // exe 移动后失效链接：无记录时不可认定己有（安全边界）
        let new_app = dir.join("app2");
        std::fs::create_dir_all(&new_app).unwrap();
        let exe2 = new_app.join("GlanceMD-Ultra");
        std::fs::write(&exe2, b"exe").unwrap();
        std::fs::remove_file(&exe).unwrap();
        assert!(std::fs::canonicalize(&link).is_err());
        assert!(!unix_shim_owned(&link, &exe2, None));
        assert!(uninstall_impl_at(&exe2, &bin, None).is_err());
        // 记录匹配该链接路径 → 认定己有，迁移修复
        assert!(unix_shim_owned(
            &link,
            &exe2,
            load_ownership(&record_path).as_ref()
        ));
        assert!(install_impl_at(&exe2, &bin, Some(&record_path)).is_ok());
        assert!(unix_shim_owned(&link, &exe2, None));
        assert!(uninstall_impl_at(&exe2, &bin, Some(&record_path)).is_ok());

        // 第三方链接（有效、目标不是当前安装目标）：拒绝覆盖与删除，
        // 即使存在指向同一路径的旧记录（有效分支不采信记录）
        let foreign = dir.join("foreign-exe");
        std::fs::write(&foreign, b"x").unwrap();
        save_ownership(
            &record_path,
            &CliOwnership {
                entry: link.to_string_lossy().into_owned(),
                target: foreign.to_string_lossy().into_owned(),
                path_added: false,
            },
        );
        symlink(&foreign, &link).unwrap();
        assert!(!unix_shim_owned(
            &link,
            &exe2,
            load_ownership(&record_path).as_ref()
        ));
        assert!(install_impl_at(&exe2, &bin, Some(&record_path)).is_err());
        assert!(uninstall_impl_at(&exe2, &bin, Some(&record_path)).is_err());
        assert!(link.symlink_metadata().is_ok());

        // 本程序所有 → 卸载（记录随之清理）；再卸载 → 幂等成功
        std::fs::remove_file(&link).unwrap();
        symlink(&exe2, &link).unwrap();
        assert!(install_impl_at(&exe2, &bin, Some(&record_path)).is_ok());
        assert!(uninstall_impl_at(&exe2, &bin, Some(&record_path)).is_ok());
        assert!(!link.symlink_metadata().is_ok());
        assert!(!record_path.exists());
        assert!(uninstall_impl_at(&exe2, &bin, Some(&record_path)).is_ok());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 所有权记录损坏时返回_none_且卸载保守拒绝() {
        let dir =
            std::env::temp_dir().join(format!("glancemd-ultra-ownership-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let record_path = dir.join("ownership.json");

        // roundtrip
        save_ownership(
            &record_path,
            &CliOwnership {
                entry: "/home/u/.local/bin/gmdu".into(),
                target: "/home/u/app/GlanceMD-Ultra".into(),
                path_added: true,
            },
        );
        let record = load_ownership(&record_path).expect("记录应可读回");
        assert_eq!(record.entry, "/home/u/.local/bin/gmdu");
        assert!(record.path_added);

        // 损坏 → None（后续按保守语义：Unix 失效链接拒绝修复，Windows PATH 保留）
        std::fs::write(&record_path, b"not-json").unwrap();
        assert!(load_ownership(&record_path).is_none());

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
