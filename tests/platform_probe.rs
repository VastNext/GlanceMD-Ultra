//! platform 模块的对外集成测试（主实施计划阶段 0 交付项 5）。
//!
//! 本项目是纯 bin crate：在 `main.rs` 声明 `mod platform;` 之前，src 内的
//! `#[cfg(test)]` 测试不会被收集，因此这里用 `#[path]` 直接引入模块源码，
//! 作为该分支上可独立运行的测试载体。文件长期保留，充当 platform 能力的
//! 对外行为契约；集成方在 main.rs 加上 `mod platform;` 后，src 侧可再补充
//! 单元测试，两者并存不冲突。
//!
//! 测试纪律：只调用"命令参数拼装"纯函数，以及不会真正 spawn 外部进程的
//! 路径（Unsupported 语义、空候选列表、工厂分发）。任何测试都不得真的
//! 启动 explorer / 终端 / xdg-open。

#[path = "../src/platform/mod.rs"]
mod platform;

use std::path::Path;

use platform::{linux, macos, windows, PlatformError, TrashOps};

// ---------- Windows：reveal 参数拼装 ----------

#[test]
fn windows_reveal_args_uses_select_comma_without_space() {
    let (program, args) = windows::Windows::reveal_args(Path::new(r"C:\Users\demo\notes\理想.md"));
    assert_eq!(program, "explorer.exe");
    // /select, 与路径以逗号直接相连、无空格，路径整体作为单个参数传递
    assert_eq!(args, vec![r"/select,C:\Users\demo\notes\理想.md"]);
}

#[test]
fn windows_reveal_args_keeps_spaced_path_in_single_arg() {
    let (_, args) = windows::Windows::reveal_args(Path::new(r"G:\My Notes\New Doc.md"));
    assert_eq!(args.len(), 1);
    assert_eq!(args[0], r"/select,G:\My Notes\New Doc.md");
    // 写成 "/select, <path>" 会让 Explorer 忽略定位目标，必须防回归
    assert!(!args[0].starts_with("/select, "));
}

// ---------- Windows：终端候选序列 ----------

#[test]
fn windows_terminal_candidates_prefer_wt_then_fallback_to_cmd() {
    let candidates = windows::Windows::terminal_candidates(Path::new(r"D:\Work Dev\My Project"));
    assert_eq!(candidates.len(), 2);

    assert_eq!(candidates[0].0, "wt");
    assert_eq!(candidates[0].1, vec![r"-d", r"D:\Work Dev\My Project"]);

    // cmd 兜底：start 后的空字符串是窗口标题占位符，/D 指定工作目录
    assert_eq!(candidates[1].0, "cmd");
    assert_eq!(
        candidates[1].1,
        vec![r"/c", "start", "", r"/D", r"D:\Work Dev\My Project"]
    );
}

// ---------- Windows：回收站占位（阶段 3 接入 trash crate 前为 Unsupported） ----------

#[test]
fn windows_trash_ops_report_unsupported_until_stage3() {
    let path = Path::new(r"C:\tmp\whatever.md");
    assert!(matches!(
        windows::Windows.to_trash(path),
        Err(PlatformError::Unsupported)
    ));
    assert!(matches!(
        windows::Windows.delete_permanently(path),
        Err(PlatformError::Unsupported)
    ));
}

// ---------- macOS：参数拼装（纯函数，任意宿主平台可测） ----------

#[test]
fn macos_reveal_args_use_open_upper_r() {
    let (program, args) = macos::MacOs::reveal_args(Path::new("/Users/demo/My Notes/note.md"));
    assert_eq!(program, "open");
    assert_eq!(args, vec!["-R", "/Users/demo/My Notes/note.md"]);
}

#[test]
fn macos_terminal_candidates_open_terminal_app() {
    let candidates = macos::MacOs::terminal_candidates(Path::new("/Users/demo/My Project"));
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].0, "open");
    assert_eq!(
        candidates[0].1,
        vec!["-a", "Terminal", "/Users/demo/My Project"]
    );
}

// ---------- Linux：参数拼装（纯函数，任意宿主平台可测） ----------

#[test]
fn linux_reveal_args_open_parent_directory() {
    let (program, args) = linux::Linux::reveal_args(Path::new("/home/demo/Notes/note.md"));
    assert_eq!(program, "xdg-open");
    // 无"定位选中"协议，降级为打开父目录（主计划阶段 3 约定）
    assert_eq!(args, vec!["/home/demo/Notes"]);
}

#[test]
fn linux_reveal_args_handle_bare_filename_and_root() {
    // 裸文件名：parent 为空串 → 回退当前目录
    let (_, args) = linux::Linux::reveal_args(Path::new("note.md"));
    assert_eq!(args, vec!["."]);
    // 根路径：无 parent → 就地打开自身
    let (_, root_args) = linux::Linux::reveal_args(Path::new("/"));
    assert_eq!(root_args, vec!["/"]);
}

#[test]
fn linux_terminal_candidates_order_gnome_konsole_then_fallback() {
    let candidates = linux::Linux::terminal_candidates(Path::new("/home/demo/My Project"));
    assert_eq!(candidates.len(), 3);

    assert_eq!(candidates[0].0, "gnome-terminal");
    assert_eq!(
        candidates[0].1,
        vec!["--working-directory=/home/demo/My Project"]
    );

    assert_eq!(candidates[1].0, "konsole");
    assert_eq!(candidates[1].1, vec!["--workdir", "/home/demo/My Project"]);

    // x-terminal-emulator 无统一工作目录参数，参数留空、由子进程工作目录补足
    assert_eq!(candidates[2].0, "x-terminal-emulator");
    assert!(candidates[2].1.is_empty());
}

// ---------- 跨平台通用语义 ----------

#[test]
fn trash_ops_are_unsupported_on_all_platforms_until_stage3() {
    // 结构体级覆盖三平台（macos/linux 的实现在 Windows 宿主上同样参与编译）；
    // trait 对象级覆盖当前平台的工厂分发结果。
    let path = Path::new("does-not-matter.md");
    assert!(matches!(
        macos::MacOs.to_trash(path),
        Err(PlatformError::Unsupported)
    ));
    assert!(matches!(
        linux::Linux.to_trash(path),
        Err(PlatformError::Unsupported)
    ));
    let trash = platform::trash_ops();
    assert!(matches!(
        trash.to_trash(path),
        Err(PlatformError::Unsupported)
    ));
    assert!(matches!(
        trash.delete_permanently(path),
        Err(PlatformError::Unsupported)
    ));
}

#[test]
fn factories_dispatch_to_current_platform_impl() {
    // Debug 派生输出即实现体名称，用于验证工厂按 target_os 分发
    let revealer = format!("{:?}", platform::revealer());
    let trash = format!("{:?}", platform::trash_ops());
    let terminal = format!("{:?}", platform::terminal_opener());
    if cfg!(target_os = "windows") {
        assert_eq!(revealer, "Windows");
        assert_eq!(trash, "Windows");
        assert_eq!(terminal, "Windows");
    } else if cfg!(target_os = "macos") {
        assert_eq!(revealer, "MacOs");
        assert_eq!(trash, "MacOs");
        assert_eq!(terminal, "MacOs");
    } else {
        assert_eq!(revealer, "Linux");
        assert_eq!(trash, "Linux");
        assert_eq!(terminal, "Linux");
    }
}

#[test]
fn spawn_first_ok_without_candidates_reports_unsupported() {
    // 不传入任何候选即不会启动任何进程
    let result = platform::spawn_first_ok(Vec::new(), None);
    assert!(matches!(result, Err(PlatformError::Unsupported)));
}

#[test]
fn platform_error_display_is_informative() {
    assert_eq!(
        PlatformError::Unsupported.to_string(),
        "当前平台不支持该操作"
    );

    let io_err = PlatformError::Io(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "wt.exe 未找到",
    ));
    let rendered = io_err.to_string();
    assert!(rendered.contains("平台命令调用失败"));
    assert!(rendered.contains("wt.exe 未找到"));
}

#[cfg(target_os = "windows")]
#[test]
fn platform_error_command_failed_display_includes_program_and_status() {
    use std::os::windows::process::ExitStatusExt;
    // 直接从原始退出码构造状态，不经真实进程
    let err = PlatformError::CommandFailed {
        program: "wt".to_string(),
        status: std::process::ExitStatus::from_raw(1),
    };
    let rendered = err.to_string();
    assert!(rendered.contains("wt"));
    assert!(rendered.contains("1"));
}
