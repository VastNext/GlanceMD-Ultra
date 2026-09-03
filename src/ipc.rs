use serde::Deserialize;
use std::sync::{Arc, Mutex};
use tao::window::Window;
use wry::WebView;

use crate::file_ops;
use crate::state::AppState;

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

    match parsed.command.as_str() {
        "open_file" => {
            let path = parsed.path.or_else(file_ops::pick_open_file);
            if let Some(p) = path {
                match file_ops::read_file(&p) {
                    Ok(contents) => {
                        send_to_js(
                            webview,
                            "file_opened",
                            &serde_json::json!({
                                "content": contents,
                                "path": p
                            }),
                        );
                        // 单实例转发/拖放打开时确保窗口前置
                        window.set_minimized(false);
                        window.set_focus();
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
        }
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
                            send_to_js(
                                webview,
                                "file_opened",
                                &serde_json::json!({
                                    "content": contents,
                                    "path": p
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
