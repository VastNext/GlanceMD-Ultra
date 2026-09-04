//! 工作区事件定义与 Rust → JS 广播通道。
//!
//! 广播路径：后台线程 / 命令处理 → [`emit`]（经 `main.rs` 安装的发送器进入
//! `EventLoopProxy`）→ 主线程事件循环 → [`broadcast_event`] → `ipc::send_to_js`
//! → 前端 `window.__fromRust(event, data)`（由 `workspace.js` 分发）。

use std::sync::OnceLock;

use serde_json::json;
use wry::WebView;

use crate::ipc;

/// 工作区事件全集（事件名与负载契约见 `docs/dev/interfaces.md` §3；
/// 字段级事实源为各模块契约 `docs/dev/contracts/*.md`）。
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// 工作区已打开：`root` 为规范化后的项目根；`file_count` 为已知文件数
    /// （打开瞬间为 0，随扫描推进由 `workspace:scan-progress` 更新）。
    Opened { root: String, file_count: usize },
    /// 扫描进度：`scanned` 为已统计的文件数（每 200 个与扫描结束时各广播一次）。
    ScanProgress { scanned: usize },
    /// 工作区错误：`message` 为面向用户的中文描述。
    Error { message: String },
    /// 目录树单层列出结果（`workspace.tree.list` 回执；entries 为 TreeEntry 序列化）。
    TreeListed {
        rel_dir: String,
        entries: serde_json::Value,
    },
    /// 搜索增量结果（worker 攒批下发）。
    SearchResult {
        search_id: String,
        hits: serde_json::Value,
    },
    /// 搜索结束（含取消与截断状态，summary 为 SearchSummary 序列化）。
    SearchCompleted {
        search_id: String,
        summary: serde_json::Value,
    },
    /// 文件操作完成（payload 见 operations 契约 §3：{op, paths, undo_id, undoId}）。
    FsOpDone { payload: serde_json::Value },
    /// 外部文件变更（watcher 去抖合并后；kind: created/modified/removed/renamed，
    /// renamed 时额外携带 `from`）。
    FileChanged { payload: serde_json::Value },
    /// 监听后端错误。
    WatcherError { message: String },
    /// 设置已变更（`scope`: global/project）。
    SettingsChanged { scope: String },
    /// 设置回执：全局设置。
    SettingsGlobal {
        settings: serde_json::Value,
        warnings: Vec<String>,
    },
    /// 设置回执：当前生效值 + 被项目覆盖的 key_path 列表。
    SettingsEffective {
        settings: serde_json::Value,
        warnings: Vec<String>,
        overridden: Vec<String>,
    },
    /// 设置回执：项目补丁。
    SettingsProject {
        patch: serde_json::Value,
        warnings: Vec<String>,
        path: Option<String>,
    },
    /// 崩溃恢复：待恢复条目（仅元数据，不含 content）。
    RecoveryAvailable {
        entries: serde_json::Value,
        warnings: Vec<String>,
    },
    /// 崩溃恢复：单条恢复内容（前端据此建 dirty tab）。
    RecoveryRestored {
        tab_id: String,
        path: Option<String>,
        content: String,
    },
    /// 崩溃恢复：`recovery.open-as-tab` 回执（内容进可编辑 tab）。
    RecoveryOpened {
        tab_id: String,
        path: Option<String>,
        content: String,
    },
}

impl Event {
    /// 下行事件名（`window.__fromRust` 的第一个参数）。
    pub fn name(&self) -> &'static str {
        match self {
            Event::Opened { .. } => "workspace:opened",
            Event::ScanProgress { .. } => "workspace:scan-progress",
            Event::Error { .. } => "workspace:error",
            Event::TreeListed { .. } => "workspace:tree-listed",
            Event::SearchResult { .. } => "workspace:search-result",
            Event::SearchCompleted { .. } => "workspace:search-completed",
            Event::FsOpDone { .. } => "workspace:fs-op-done",
            Event::FileChanged { .. } => "workspace:file-changed",
            Event::WatcherError { .. } => "workspace:watcher-error",
            Event::SettingsChanged { .. } => "workspace:settings-changed",
            Event::SettingsGlobal { .. } => "workspace:settings-global",
            Event::SettingsEffective { .. } => "workspace:settings-effective",
            Event::SettingsProject { .. } => "workspace:settings-project",
            Event::RecoveryAvailable { .. } => "workspace:recovery-available",
            Event::RecoveryRestored { .. } => "workspace:recovery-restored",
            Event::RecoveryOpened { .. } => "workspace:recovery-opened",
        }
    }

    /// 下行事件负载（`window.__fromRust` 的第二个参数）。
    pub fn payload(&self) -> serde_json::Value {
        match self {
            Event::Opened { root, file_count } => {
                json!({ "root": root, "file_count": file_count })
            }
            Event::ScanProgress { scanned } => json!({ "scanned": scanned }),
            Event::Error { message } => json!({ "message": message }),
            Event::TreeListed { rel_dir, entries } => {
                json!({ "relDir": rel_dir, "rel_dir": rel_dir, "entries": entries })
            }
            Event::SearchResult { search_id, hits } => {
                json!({ "searchId": search_id, "hits": hits })
            }
            Event::SearchCompleted { search_id, summary } => {
                json!({ "searchId": search_id, "summary": summary })
            }
            Event::FsOpDone { payload } => payload.clone(),
            Event::FileChanged { payload } => payload.clone(),
            Event::WatcherError { message } => json!({ "message": message }),
            Event::SettingsChanged { scope } => json!({ "scope": scope }),
            Event::SettingsGlobal { settings, warnings } => {
                json!({ "settings": settings, "warnings": warnings })
            }
            Event::SettingsEffective {
                settings,
                warnings,
                overridden,
            } => {
                json!({ "settings": settings, "warnings": warnings, "overridden": overridden })
            }
            Event::SettingsProject {
                patch,
                warnings,
                path,
            } => {
                json!({ "patch": patch, "warnings": warnings, "path": path })
            }
            Event::RecoveryAvailable { entries, warnings } => {
                json!({ "entries": entries, "warnings": warnings })
            }
            Event::RecoveryRestored {
                tab_id,
                path,
                content,
            }
            | Event::RecoveryOpened {
                tab_id,
                path,
                content,
            } => {
                json!({ "tab_id": tab_id, "tabId": tab_id, "path": path, "content": content })
            }
        }
    }
}

type EventSender = Box<dyn Fn(Event) + Send + Sync>;

static EVENT_SENDER: OnceLock<EventSender> = OnceLock::new();

/// 安装事件发送器（把事件递交给主线程事件循环）。仅首次调用生效。
pub fn set_sender(sender: EventSender) {
    if EVENT_SENDER.set(sender).is_err() {
        eprintln!("workspace::events 事件发送器已安装，忽略重复设置");
    }
}

/// 广播事件。发送器未安装（纯逻辑单测场景）时静默忽略。
pub fn emit(event: Event) {
    if let Some(sender) = EVENT_SENDER.get() {
        sender(event);
    }
}

/// 主线程侧：把事件直接推送到 WebView（由 `main.rs` 的事件循环分支调用）。
pub fn broadcast_event(webview: &WebView, event: &Event) {
    ipc::send_to_js(webview, event.name(), &event.payload());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 事件名与负载映射正确() {
        let opened = Event::Opened {
            root: "G:/proj".to_string(),
            file_count: 0,
        };
        assert_eq!(opened.name(), "workspace:opened");
        assert_eq!(
            opened.payload(),
            serde_json::json!({ "root": "G:/proj", "file_count": 0 })
        );

        let progress = Event::ScanProgress { scanned: 42 };
        assert_eq!(progress.name(), "workspace:scan-progress");
        assert_eq!(progress.payload(), serde_json::json!({ "scanned": 42 }));

        let error = Event::Error {
            message: "测试".to_string(),
        };
        assert_eq!(error.name(), "workspace:error");
        assert_eq!(error.payload(), serde_json::json!({ "message": "测试" }));
    }

    #[test]
    fn 未安装发送器时_事件静默忽略() {
        // 进程内从未安装发送器（main.rs 才会安装），emit 不应 panic。
        emit(Event::ScanProgress { scanned: 1 });
    }
}
