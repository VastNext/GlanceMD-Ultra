use serde::Deserialize;
use std::sync::{Arc, Mutex};
use tao::window::Window;
use wry::WebView;

use crate::file_ops;
use crate::state::AppState;
use crate::{commands, workspace};

#[derive(Deserialize)]
struct IpcMessage {
    command: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    dirty: Option<bool>,
    /// 各阶段命令的扩展参数（searchId/options/tab_id/new_name/dest_dir/undo_id…），
    /// 原样透传给命令 handler；字段名以各契约 `docs/dev/contracts/*.md` 为准。
    #[serde(flatten)]
    extra: serde_json::Value,
}

/// 上行 wire 命令名 → 命令注册表 ID 的映射（契约见 `docs/dev/interfaces.md`）。
/// 命中即离开既有 match，经 `commands::dispatch` 分发；未命中走原有分支。
/// 除个别历史命令外，`workspace.*` / `watcher.*` 前缀的 wire 命令与注册表 ID 一致，直接透传。
fn registry_command_id(wire_command: &str) -> Option<String> {
    match wire_command {
        "open_file" => Some("file.open".to_string()),
        "workspace.open" => Some("workspace.open".to_string()),
        _ if wire_command.starts_with("workspace.")
            || wire_command.starts_with("file.")
            || wire_command.starts_with("cli.")
            || wire_command.starts_with("watcher.")
            || wire_command.starts_with("recovery.")
            || wire_command.starts_with("project.")
            || wire_command.starts_with("search.")
            || wire_command.starts_with("quickopen.")
            || wire_command.starts_with("palette.")
            || wire_command.starts_with("settings.") =>
        {
            Some(wire_command.to_string())
        }
        _ => None,
    }
}

pub fn handle_ipc_message(
    msg: &str,
    webview: &WebView,
    window: &Window,
    state: &Arc<Mutex<AppState>>,
) {
    let parsed: IpcMessage = match serde_json::from_str(msg) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("IPC parse error: {e}");
            return;
        }
    };

    // 阶段 0 迁移：open_file / workspace.open 改经命令注册表分发。
    // "open_file" 分支逐行迁移至 commands::open_file，行为保持完全一致。
    if let Some(id) = registry_command_id(&parsed.command) {
        let payload = commands::CommandPayload {
            content: parsed.content,
            path: parsed.path,
            title: parsed.title,
            dirty: parsed.dirty,
            extra: parsed.extra,
        };
        let ctx = commands::CommandContext {
            webview,
            window,
            state,
        };
        if let Err(e) = commands::dispatch(&id, &payload, &ctx) {
            eprintln!("命令分发失败: {e}");
        }
        return;
    }

    match parsed.command.as_str() {
        "focus_window" => {
            // 第二实例无参数启动时仅聚焦已有窗口
            window.set_minimized(false);
            window.set_focus();
        }
        "save_file" => {
            if let Some(ref content) = parsed.content {
                if let Some(ref path) = parsed.path {
                    match file_ops::write_file(path, content) {
                        Ok(_) => {
                            send_to_js(
                                webview,
                                "file_saved",
                                &serde_json::json!({
                                    "path": path
                                }),
                            );
                        }
                        Err(e) => send_to_js(
                            webview,
                            "error",
                            &serde_json::json!({
                                "message": format!("Failed to save: {e}")
                            }),
                        ),
                    }
                } else {
                    handle_save_as(webview, parsed.content);
                }
            }
        }
        "save_as" => {
            handle_save_as(webview, parsed.content);
        }
        "set_title" => {
            if let Some(title) = parsed.title {
                window.set_title(&title);
            }
        }
        "set_dirty_state" => {
            state.lock().unwrap().has_dirty_tabs = parsed.dirty.unwrap_or(false);
        }
        "window_minimize" => {
            window.set_minimized(true);
        }
        "window_maximize" => {
            window.set_maximized(!window.is_maximized());
        }
        "window_close" => {
            let inner_size = window.inner_size();
            let outer_pos = window.outer_position().unwrap_or_default();
            crate::window_state::save_window_state(
                (outer_pos.x, outer_pos.y),
                (inner_size.width, inner_size.height),
            );
            std::process::exit(0);
        }
        "read_image" => {
            if let Some(ref path) = parsed.path {
                use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
                let encoded = utf8_percent_encode(path, NON_ALPHANUMERIC).to_string();
                let url = format!("{}local-image?{}", crate::platform_base_url(), encoded);
                let script = format!(
                    "window.__setImage({}, {})",
                    serde_json::to_string(path).unwrap(),
                    serde_json::to_string(&url).unwrap(),
                );
                let _ = webview.evaluate_script(&script);
            }
        }
        "drag_enter" => {
            let _ = webview.evaluate_script(
                "document.getElementById('drop-overlay').classList.add('visible')",
            );
        }
        "drag_leave" => {
            let _ = webview.evaluate_script(
                "document.getElementById('drop-overlay').classList.remove('visible')",
            );
        }
        "ready" => {
            let (pending_files, pending_content, pending_title) = {
                let mut st = state.lock().unwrap();
                st.frontend_ready = true;
                (
                    std::mem::take(&mut st.pending_files),
                    st.pending_content.take(),
                    st.pending_title.take(),
                )
            };
            if !pending_files.is_empty() {
                for p in pending_files {
                    match file_ops::read_file(&p) {
                        Ok(contents) => {
                            let p = std::path::absolute(&p)
                                .map(|p| p.to_string_lossy().into_owned())
                                .unwrap_or(p);
                            let is_img = file_ops::is_image_path(&p);
                            send_to_js(
                                webview,
                                "file_opened",
                                &serde_json::json!({
                                    "content": contents,
                                    "path": p,
                                    "is_image": is_img
                                }),
                            );
                        }
                        Err(e) => send_to_js(
                            webview,
                            "error",
                            &serde_json::json!({
                                "message": format!("Failed to open file: {e}")
                            }),
                        ),
                    }
                }
            } else if let Some(content) = pending_content {
                let title = pending_title.unwrap_or_else(|| "stdin".to_string());
                send_to_js(
                    webview,
                    "stdin_opened",
                    &serde_json::json!({
                        "content": content,
                        "title": title
                    }),
                );
            }

            // 阶段 0 垂直切片：前端就绪后再打开 CLI 传入的项目目录，
            // 保证 workspace:* 事件在 __fromRust（已被 workspace.js 包装）可用后广播。
            if let Some(dir) = workspace::take_pending_root() {
                let payload = commands::CommandPayload {
                    path: Some(dir),
                    ..Default::default()
                };
                let ctx = commands::CommandContext {
                    webview,
                    window,
                    state,
                };
                if let Err(e) = commands::dispatch("workspace.open", &payload, &ctx) {
                    eprintln!("命令分发失败: {e}");
                }
            }
        }
        _ => eprintln!("Unknown IPC command: {}", parsed.command),
    }
}

fn handle_save_as(webview: &WebView, content: Option<String>) {
    if let Some(content) = content {
        if let Some(path) = file_ops::pick_save_file() {
            match file_ops::write_file(&path, &content) {
                Ok(_) => {
                    send_to_js(
                        webview,
                        "file_saved",
                        &serde_json::json!({
                            "path": path
                        }),
                    );
                }
                Err(e) => send_to_js(
                    webview,
                    "error",
                    &serde_json::json!({
                        "message": format!("Failed to save: {e}")
                    }),
                ),
            }
        }
    }
}

pub(crate) fn send_to_js(webview: &WebView, event: &str, data: &serde_json::Value) {
    let script = format!(
        "window.__fromRust({}, {})",
        serde_json::to_string(event).unwrap(),
        serde_json::to_string(data).unwrap(),
    );
    let _ = webview.evaluate_script(&script);
}

#[cfg(test)]
mod tests {
    use super::registry_command_id;

    #[test]
    fn 注册表通配前缀覆盖_file_系列() {
        // BUG-001 教训：file.reload 曾因通配清单缺 `file.` 前缀被 legacy 分支
        // 当作未知命令丢弃，热重载链路在真实 IPC 分发处断裂
        assert_eq!(
            registry_command_id("file.reload"),
            Some("file.reload".to_string())
        );
        assert_eq!(
            registry_command_id("cli.install-shim"),
            Some("cli.install-shim".to_string())
        );
        assert_eq!(
            registry_command_id("workspace.tree.list"),
            Some("workspace.tree.list".to_string())
        );
        assert_eq!(
            registry_command_id("open_file"),
            Some("file.open".to_string())
        );
        assert_eq!(registry_command_id("totally_unknown"), None);
    }
}
