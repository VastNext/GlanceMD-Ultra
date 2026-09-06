#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use std::borrow::Cow;
use std::io::Read;
use std::sync::{Arc, Mutex};
use tao::{
    dpi::{LogicalPosition, LogicalSize},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    window::WindowBuilder,
};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HWND, RECT};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    SetWindowPos, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOZORDER,
};
use wry::WebViewBuilder;

mod atomic_save;
mod commands;
mod data_dir;
mod file_codec;
mod file_ops;
mod ipc;
mod platform;
#[cfg(target_os = "windows")]
mod single_instance;
mod state;
mod window_state;
mod workspace;

const INDEX_HTML: &str = include_str!("frontend/index.html");
const STYLE_CSS: &str = include_str!("frontend/style.css");
// i18n.js 必须是第一个产品脚本：tabs/project-tree/recovery 等模块执行时即用 I18n.t
const I18N_JS: &str = include_str!("frontend/i18n.js");
const APP_JS: &str = include_str!("frontend/app.js");
const EDITOR_JS: &str = include_str!("frontend/editor.js");
const PREVIEW_JS: &str = include_str!("frontend/preview.js");
const TABS_JS: &str = include_str!("frontend/tabs.js");
const MARKED_JS: &str = include_str!("frontend/marked.min.js");
const HLJS: &str = include_str!("frontend/highlight.min.js");
// 阶段 0 新增前端模块：排在既有脚本（app.js）之后加载
const COMMANDS_JS: &str = include_str!("frontend/commands.js");
const WORKSPACE_JS: &str = include_str!("frontend/workspace.js");
// 阶段 1 前端骨架：三栏布局的面板折叠/拖宽/持久化，追加在 workspace.js 之后
const LAYOUT_JS: &str = include_str!("frontend/layout.js");
// 阶段 1–6 前端面板（Wave 2b）：一律追加在 layout.js 之后；同名 css 拼在 style.css 之后
const OUTLINE_JS: &str = include_str!("frontend/outline.js");
const PROJECT_TREE_JS: &str = include_str!("frontend/project-tree.js");
const SEARCH_PANEL_JS: &str = include_str!("frontend/search-panel.js");
const QUICK_OPEN_JS: &str = include_str!("frontend/quick-open.js");
const SETTINGS_JS: &str = include_str!("frontend/settings.js");
const KEYBINDINGS_JS: &str = include_str!("frontend/keybindings.js");
const COMMAND_PALETTE_JS: &str = include_str!("frontend/command-palette.js");
const RECOVERY_JS: &str = include_str!("frontend/recovery.js");
const SETTINGS_APPLY_JS: &str = include_str!("frontend/settings-apply.js");
const ICON_PNG: &[u8] = include_bytes!("../assets/icon.png");

pub(crate) const fn platform_base_url() -> &'static str {
    if cfg!(target_os = "windows") {
        "http://glancemd-ultra.localhost/"
    } else {
        "glancemd-ultra://localhost/"
    }
}

const fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

#[cfg(target_os = "windows")]
fn stdin_is_piped() -> bool {
    extern "system" {
        fn GetStdHandle(nStdHandle: u32) -> isize;
        fn GetFileType(hFile: isize) -> u32;
    }

    const STD_INPUT_HANDLE: u32 = 0xFFFF_FFF6;
    const FILE_TYPE_DISK: u32 = 0x0001;
    const FILE_TYPE_PIPE: u32 = 0x0003;

    unsafe {
        let handle = GetStdHandle(STD_INPUT_HANDLE);
        let file_type = GetFileType(handle);
        file_type == FILE_TYPE_PIPE || file_type == FILE_TYPE_DISK
    }
}

fn should_close_window(has_dirty_tabs: bool, confirm_discard: impl FnOnce() -> bool) -> bool {
    !has_dirty_tabs || confirm_discard()
}

fn save_window_state(window: &tao::window::Window) {
    let inner_size = window.inner_size();
    let outer_pos = window.outer_position().unwrap_or_default();
    window_state::save_window_state(
        (outer_pos.x, outer_pos.y),
        (inner_size.width, inner_size.height),
    );
}

#[cfg(not(target_os = "windows"))]
fn stdin_is_piped() -> bool {
    use std::io::IsTerminal;
    !std::io::stdin().is_terminal()
}

/// 解码内嵌 PNG 为窗口图标（Alt+Tab / 任务栏 / 标题栏用）
fn load_window_icon() -> Option<tao::window::Icon> {
    let decoder = png::Decoder::new(std::io::Cursor::new(ICON_PNG));
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    tao::window::Icon::from_rgba(buf, info.width, info.height).ok()
}

#[derive(Debug)]
enum UserEvent {
    IpcMessage(String),
    NavigationBlocked(String),
    /// Workspace 事件桥：后台线程产生的事件经此送达主线程后广播给前端
    WorkspaceEvent(workspace::events::Event),
}

fn is_app_navigation(url: &str) -> bool {
    let without_fragment = url.split('#').next().unwrap_or(url);
    matches!(
        without_fragment,
        "http://glancemd-ultra.localhost/"
            | "http://glancemd-ultra.localhost/index.html"
            | "glancemd-ultra://localhost/"
            | "glancemd-ultra://localhost/index.html"
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DropAction {
    OpenWorkspace,
    OpenFile,
    Ignore,
}

fn classify_drop_path(path: &std::path::Path) -> DropAction {
    if path.is_dir() {
        return DropAction::OpenWorkspace;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if matches!(ext.as_str(), "md" | "markdown" | "txt") {
        DropAction::OpenFile
    } else {
        DropAction::Ignore
    }
}

fn main() {
    let app_state = Arc::new(Mutex::new(state::AppState::new()));

    // 阶段 0：引导内置命令注册表（幂等，可安全重复调用）
    commands::register_builtin();

    // Parse CLI args
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut cli_file: Option<String> = None;
    let mut stdin_flag = false;
    let mut title_arg: Option<String> = None;
    {
        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "--stdin" => stdin_flag = true,
                "--title" => {
                    if i + 1 < args.len() {
                        i += 1;
                        title_arg = Some(args[i].clone());
                    }
                }
                _ => {
                    if cli_file.is_none() {
                        cli_file = Some(args[i].clone());
                    }
                }
            }
            i += 1;
        }
    }

    // Windows 保持原有单实例行为；macOS/Linux 首版允许多实例。
    #[cfg(target_os = "windows")]
    let _primary = single_instance::try_acquire_primary();
    #[cfg(target_os = "windows")]
    if _primary.is_none() {
        let forward: Vec<String> = cli_file.clone().into_iter().collect();
        if single_instance::send_open_request(&forward) {
            return;
        }
        // 转发失败（主实例管道未就绪等）：回退为独立窗口启动
    }

    // Read stdin if --stdin flag and stdin is a pipe/file (not a console)
    if stdin_flag && stdin_is_piped() {
        let mut buf = String::new();
        if std::io::stdin().read_to_string(&mut buf).is_ok() && !buf.is_empty() {
            let mut st = app_state.lock().unwrap();
            st.pending_content = Some(buf);
            st.pending_title = title_arg;
        }
    }

    // 便携数据目录：在事件桥/窗口/WebView 创建之前解析并固定。此后全局设置、
    // 恢复区、窗口状态、WebView2 用户数据全部经 data_dir::data_base() 取路径。
    // WEBVIEW2_USER_DATA_FOLDER：wry 在 Windows 未显式指定 UDF（传空）时，
    // WebView2 加载器会读取该环境变量；指到 data_base()/webview2，避免默认
    // 落在 exe 旁可能不可写的位置（该变量在 macOS/Linux 上无作用，无害）。
    // unsafe 理由：std::env::set_var 自 Rust 2024 edition 起为 unsafe（进程级
    // 环境表无同步机制）；本 crate 仍为 edition 2021（调用现为安全，allow 抑制
    // unused_unsafe），且此处仅在 main 启动早期、单线程、事件循环与任何后台
    // 线程启动之前调用一次，不存在并发读写环境变量的竞态。
    let data_base = data_dir::data_base();
    // 无 CLI 路径时恢复上次打开的工作区；显式路径（目录或文件）保持既有行为。
    if cli_file.is_none() {
        if let Some(last_root) = workspace::session::restore_pending_root(data_base, None) {
            workspace::set_pending_root(last_root);
        }
    }
    #[allow(unused_unsafe)]
    unsafe {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", data_base.join("webview2"));
    }

    let (pos, size) = window_state::load_window_state();

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy: EventLoopProxy<UserEvent> = event_loop.create_proxy();

    // Workspace 事件桥：后台线程/命令处理产生的事件经事件循环广播到前端
    // （workspace::events::emit → EventLoopProxy → 下方 WorkspaceEvent 分支 → send_to_js）
    let proxy_workspace = proxy.clone();
    workspace::events::set_sender(Box::new(move |event| {
        let _ = proxy_workspace.send_event(UserEvent::WorkspaceEvent(event));
    }));

    // Windows 主实例：后台线程监听管道，把第二实例转发的文件参数变成 open_file IPC。
    #[cfg(target_os = "windows")]
    if _primary.is_some() {
        let proxy_pipe = proxy.clone();
        std::thread::spawn(move || {
            single_instance::serve_open_requests(move |paths| {
                if paths.is_empty() {
                    let _ = proxy_pipe.send_event(UserEvent::IpcMessage(
                        r#"{"command":"focus_window"}"#.to_string(),
                    ));
                } else {
                    for p in paths {
                        let msg =
                            serde_json::json!({"command": "open_file", "path": p}).to_string();
                        let _ = proxy_pipe.send_event(UserEvent::IpcMessage(msg));
                    }
                }
            });
        });
    }

    let window = WindowBuilder::new()
        .with_title("GlanceMD Ultra - Untitled")
        .with_decorations(!cfg!(target_os = "windows"))
        .with_window_icon(load_window_icon())
        .with_inner_size(LogicalSize::new(size.0 as f64, size.1 as f64))
        .with_position(LogicalPosition::new(pos.0 as f64, pos.1 as f64))
        .build(&event_loop)
        .unwrap();

    let full_html = build_html();
    {
        app_state.lock().unwrap().html = full_html;
    }

    let proxy_ipc = proxy.clone();
    let proxy_drop = proxy.clone();
    let proxy_navigation = proxy.clone();
    let proxy_new_window = proxy.clone();

    let state_proto = Arc::clone(&app_state);
    let webview_builder = WebViewBuilder::new()
        .with_custom_protocol("glancemd-ultra".to_string(), move |_id, request| {
            let uri = request.uri().path();
            if uri == "/" || uri == "/index.html" {
                let st = state_proto.lock().unwrap();
                wry::http::Response::builder()
                    .header("Content-Type", "text/html")
                    .body(Cow::Owned(st.html.as_bytes().to_vec()))
                    .unwrap()
            } else if uri.starts_with("/local-image") {
                let query = request.uri().query().unwrap_or("");
                let file_path = percent_encoding::percent_decode_str(query)
                    .decode_utf8_lossy()
                    .to_string();
                match std::fs::read(&file_path) {
                    Ok(data) => {
                        let ext = std::path::Path::new(&file_path)
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("")
                            .to_lowercase();
                        let mime = match ext.as_str() {
                            "png" => "image/png",
                            "jpg" | "jpeg" => "image/jpeg",
                            "gif" => "image/gif",
                            "svg" => "image/svg+xml",
                            "webp" => "image/webp",
                            "bmp" => "image/bmp",
                            "ico" => "image/x-icon",
                            "tiff" | "tif" => "image/tiff",
                            _ => "application/octet-stream",
                        };
                        wry::http::Response::builder()
                            .header("Content-Type", mime)
                            .body(Cow::Owned(data))
                            .unwrap()
                    }
                    Err(_) => wry::http::Response::builder()
                        .status(404)
                        .body(Cow::Borrowed(b"Image not found" as &[u8]))
                        .unwrap(),
                }
            } else {
                wry::http::Response::builder()
                    .status(404)
                    .body(Cow::Borrowed(b"Not found" as &[u8]))
                    .unwrap()
            }
        })
        .with_navigation_handler(move |url| {
            if is_app_navigation(&url) {
                true
            } else {
                let _ = proxy_navigation.send_event(UserEvent::NavigationBlocked(url));
                false
            }
        })
        .with_url(platform_base_url())
        .with_ipc_handler(move |request| {
            let body = request.body().to_string();
            let _ = proxy_ipc.send_event(UserEvent::IpcMessage(body));
        })
        .with_new_window_req_handler(move |url| {
            let _ = proxy_new_window.send_event(UserEvent::NavigationBlocked(url));
            false
        })
        .with_drag_drop_handler(move |event| {
            match event {
                wry::DragDropEvent::Enter { .. } => {
                    let msg = serde_json::json!({"command": "drag_enter"}).to_string();
                    let _ = proxy_drop.send_event(UserEvent::IpcMessage(msg));
                }
                wry::DragDropEvent::Drop { paths, .. } => {
                    let leave = serde_json::json!({"command": "drag_leave"}).to_string();
                    let _ = proxy_drop.send_event(UserEvent::IpcMessage(leave));
                    for path in &paths {
                        let command = match classify_drop_path(path) {
                            DropAction::OpenWorkspace => "workspace.open",
                            DropAction::OpenFile => "open_file",
                            DropAction::Ignore => continue,
                        };
                        let msg = serde_json::json!({
                            "command": command,
                            "path": path.to_string_lossy()
                        })
                        .to_string();
                        let _ = proxy_drop.send_event(UserEvent::IpcMessage(msg));
                    }
                }
                wry::DragDropEvent::Leave => {
                    let msg = serde_json::json!({"command": "drag_leave"}).to_string();
                    let _ = proxy_drop.send_event(UserEvent::IpcMessage(msg));
                }
                _ => {}
            }
            true
        })
        .with_devtools(cfg!(debug_assertions));

    #[cfg(target_os = "windows")]
    let webview_builder = {
        use wry::WebViewBuilderExtWindows;
        webview_builder.with_browser_accelerator_keys(false)
    };

    #[cfg(target_os = "linux")]
    let _webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let container = window
            .default_vbox()
            .expect("Tao GTK container is unavailable");
        webview_builder
            .build_gtk(container)
            .expect("Failed to build WebView")
    };

    #[cfg(not(target_os = "linux"))]
    let _webview = webview_builder
        .build(&window)
        .expect("Failed to build WebView");

    // Store CLI file path to open once JS is ready
    if let Some(file_path) = cli_file {
        if std::path::Path::new(&file_path).is_dir() {
            // 阶段 0 垂直切片：CLI 传入已存在的目录 → 打开 Workspace。
            // 暂存待前端 ready 后再打开，确保 workspace:* 事件不早于前端装载。
            workspace::set_pending_root(file_path);
        } else {
            // 既有单文件行为保持不变（含路径不存在时走错误提示的老路径）
            app_state.lock().unwrap().pending_files.push(file_path);
        }
    }

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::UserEvent(UserEvent::IpcMessage(msg)) => {
                ipc::handle_ipc_message(&msg, &_webview, &window, &app_state);
            }
            Event::UserEvent(UserEvent::WorkspaceEvent(event)) => {
                workspace::events::broadcast_event(&_webview, &event);
            }
            Event::UserEvent(UserEvent::NavigationBlocked(url)) => {
                ipc::send_to_js(
                    &_webview,
                    "navigation_blocked",
                    &serde_json::json!({ "url": url }),
                );
            }
            Event::WindowEvent {
                event: WindowEvent::Resized(_new_size),
                ..
            } => {
                #[cfg(target_os = "windows")]
                {
                    use wry::WebViewExtWindows;
                    let w = _new_size.width as i32;
                    let h = _new_size.height as i32;
                    unsafe {
                        let controller = _webview.controller();
                        let _ = controller.SetBounds(RECT {
                            left: 0,
                            top: 0,
                            right: w,
                            bottom: h,
                        });
                        let mut host = HWND::default();
                        if controller.ParentWindow(&mut host).is_ok() {
                            let _ = SetWindowPos(
                                host,
                                None,
                                0,
                                0,
                                w,
                                h,
                                SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOZORDER,
                            );
                        }
                    }
                }
            }
            #[cfg(target_os = "macos")]
            Event::Opened { urls } => {
                let paths = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect::<Vec<_>>();
                if !paths.is_empty() {
                    let frontend_ready = app_state.lock().unwrap().frontend_ready;
                    if frontend_ready {
                        for path in paths {
                            let msg = serde_json::json!({
                                "command": "open_file",
                                "path": path
                            })
                            .to_string();
                            ipc::handle_ipc_message(&msg, &_webview, &window, &app_state);
                        }
                    } else {
                        app_state.lock().unwrap().pending_files.extend(paths);
                    }
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                let has_dirty_tabs = app_state.lock().unwrap().has_dirty_tabs;
                let close = should_close_window(has_dirty_tabs, || {
                    use rfd::{MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};

                    MessageDialog::new()
                        .set_level(MessageLevel::Warning)
                        .set_title("GlanceMD Ultra")
                        .set_description("存在未保存的修改，确定要关闭吗？")
                        .set_buttons(MessageButtons::YesNo)
                        .show()
                        == MessageDialogResult::Yes
                });

                if close {
                    save_window_state(&window);
                    *control_flow = ControlFlow::Exit;
                }
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{classify_drop_path, is_app_navigation, should_close_window, DropAction};
    use std::cell::Cell;
    use std::fs;

    #[test]
    fn clean_window_closes_without_prompting() {
        let prompted = Cell::new(false);
        let close = should_close_window(false, || {
            prompted.set(true);
            false
        });

        assert!(close);
        assert!(!prompted.get());
    }

    #[test]
    fn dirty_window_stays_open_when_discard_is_rejected() {
        assert!(!should_close_window(true, || false));
    }

    #[test]
    fn dirty_window_closes_when_discard_is_confirmed() {
        assert!(should_close_window(true, || true));
    }

    #[test]
    fn 拖放目录打开工作区_文本文件打开文件_其他文件忽略() {
        let root = std::env::temp_dir().join(format!("glancemd-ultra-drop-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let markdown = root.join("note.md");
        let other = root.join("image.png");
        fs::write(&markdown, "# note").unwrap();
        fs::write(&other, b"png").unwrap();

        assert_eq!(classify_drop_path(&root), DropAction::OpenWorkspace);
        assert_eq!(classify_drop_path(&markdown), DropAction::OpenFile);
        assert_eq!(classify_drop_path(&other), DropAction::Ignore);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn 仅允许应用根页面和页内导航() {
        assert!(is_app_navigation("http://glancemd-ultra.localhost/"));
        assert!(is_app_navigation("http://glancemd-ultra.localhost/#usage"));
        assert!(is_app_navigation(
            "http://glancemd-ultra.localhost/index.html"
        ));
        assert!(is_app_navigation("glancemd-ultra://localhost/"));
        assert!(is_app_navigation("glancemd-ultra://localhost/index.html"));
        assert!(is_app_navigation("glancemd-ultra://localhost/#usage"));
        assert!(!is_app_navigation("about:blank"));
        assert!(!is_app_navigation(
            "http://glancemd-ultra.localhost/README_CN.md"
        ));
        assert!(!is_app_navigation(
            "glancemd-ultra://localhost/README_CN.md"
        ));
        assert!(!is_app_navigation("https://example.com"));
    }
}

fn escape_for_script_tag(js: &str) -> String {
    // Prevent "</script" in JS from prematurely closing the <script> tag
    js.replace("</script", "<\\/script")
}

fn build_html() -> String {
    // i18n.js 必须最前：后续模块（tabs/project-tree/recovery…）执行时即用 I18n.t
    let scripts = format!(
        "<script>{}</script>\n<script>{}</script>\n<script>{}</script>\n<script>{}</script>\n<script>{}</script>\n<script>{}</script>\n<script>{}</script>",
        escape_for_script_tag(I18N_JS),
        escape_for_script_tag(HLJS),
        escape_for_script_tag(MARKED_JS),
        escape_for_script_tag(PREVIEW_JS),
        escape_for_script_tag(TABS_JS),
        escape_for_script_tag(EDITOR_JS),
        escape_for_script_tag(APP_JS),
    );

    // 阶段 0 追加：commands.js、workspace.js 排在 app.js 之后（保持既有脚本顺序不变）
    let scripts = format!(
        "{}\n<script>{}</script>\n<script>{}</script>",
        scripts,
        escape_for_script_tag(COMMANDS_JS),
        escape_for_script_tag(WORKSPACE_JS),
    );

    // 阶段 1 追加：layout.js 排在 workspace.js 之后（新模块一律追加在末尾）
    let scripts = format!(
        "{}\n<script>{}</script>",
        scripts,
        escape_for_script_tag(LAYOUT_JS),
    );

    // 阶段 1–6 前端面板：顺序 outline → project-tree → search-panel → quick-open
    // → settings → keybindings → command-palette → recovery（keybindings 晚于 settings，
    // palette 晚于 keybindings；面板均只依赖 commands/workspace/layout 的公开命名空间）
    let scripts = format!(
        "{}\n<script>{}</script>\n<script>{}</script>\n<script>{}</script>\n<script>{}</script>\n<script>{}</script>\n<script>{}</script>\n<script>{}</script>\n<script>{}</script>",
        scripts,
        escape_for_script_tag(OUTLINE_JS),
        escape_for_script_tag(PROJECT_TREE_JS),
        escape_for_script_tag(SEARCH_PANEL_JS),
        escape_for_script_tag(QUICK_OPEN_JS),
        escape_for_script_tag(SETTINGS_JS),
        escape_for_script_tag(KEYBINDINGS_JS),
        escape_for_script_tag(COMMAND_PALETTE_JS),
        escape_for_script_tag(RECOVERY_JS),
    );

    // 阶段 5 追加：settings-apply.js 排在 recovery.js 之后（设置生效层：把
    // workspace:settings-effective 落到 CSS 变量与编辑器 DOM，开机即拉取一次；
    // 只依赖 workspace.js 的事件分发器与 ipc，晚于全部面板脚本无装载顺序问题）
    let scripts = format!(
        "{}\n<script>{}</script>",
        scripts,
        escape_for_script_tag(SETTINGS_APPLY_JS),
    );

    // 面板样式拼在 style.css 之后（同特异性下后写的规则生效；各面板 css 内
    // 使用 style.css 的既有 token，明暗两套均已在 shell 或面板文件内定义）
    const PANEL_CSS: &str = concat!(
        "\n/* ── outline.css ── */\n",
        include_str!("frontend/outline.css"),
        "\n/* ── project-tree.css ── */\n",
        include_str!("frontend/project-tree.css"),
        "\n/* ── search-panel.css ── */\n",
        include_str!("frontend/search-panel.css"),
        "\n/* ── quick-open.css ── */\n",
        include_str!("frontend/quick-open.css"),
        "\n/* ── settings.css ── */\n",
        include_str!("frontend/settings.css"),
        "\n/* ── command-palette.css ── */\n",
        include_str!("frontend/command-palette.css"),
        "\n/* ── recovery.css ── */\n",
        include_str!("frontend/recovery.css"),
    );
    let full_css = format!("{STYLE_CSS}{PANEL_CSS}");

    INDEX_HTML
        .replace("/* __CSS__ */", &full_css)
        .replace(
            "<body>",
            &format!("<body data-platform=\"{}\">", platform_name()),
        )
        .replace("<!-- __SCRIPTS__ -->", &scripts)
}
