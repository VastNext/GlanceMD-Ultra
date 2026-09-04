//! Windows 平台实现：Explorer 显示、终端打开（Windows Terminal 优先）、回收站占位。

use std::path::Path;

use super::{spawn_detached, spawn_first_ok, PlatformError, Revealer, TerminalOpener, TrashOps};

/// Windows 平台能力实现。
#[derive(Debug)]
pub struct Windows;

impl Windows {
    /// 拼装"在资源管理器中显示"命令：`explorer.exe /select,<path>`。
    ///
    /// 注意 `/select,` 与路径之间以逗号直接相连、没有空格；写成 `/select, <path>`
    /// 会让 Explorer 忽略定位目标、退回打开默认视图。含空格的路径由 `Command`
    /// 的参数机制整体传递，无需手工加引号。
    pub fn reveal_args(path: &Path) -> (String, Vec<String>) {
        (
            "explorer.exe".to_string(),
            vec![format!("/select,{}", path.as_os_str().to_string_lossy())],
        )
    }

    /// 拼装"在终端中打开"的候选命令序列（按优先级，运行时逐个尝试直到启动成功）：
    ///
    /// 1. Windows Terminal：`wt -d <dir>`（未安装时进程启动失败，自动降级到下一候选）
    /// 2. cmd 兜底：`cmd /c start "" /D <dir>`（`start` 后的空字符串是窗口标题占位符）
    pub fn terminal_candidates(dir: &Path) -> Vec<(String, Vec<String>)> {
        let dir = dir.as_os_str().to_string_lossy().into_owned();
        vec![
            ("wt".to_string(), vec!["-d".to_string(), dir.clone()]),
            (
                "cmd".to_string(),
                vec![
                    "/c".to_string(),
                    "start".to_string(),
                    String::new(),
                    "/D".to_string(),
                    dir,
                ],
            ),
        ]
    }
}

impl Revealer for Windows {
    fn reveal(&self, path: &Path) -> Result<(), PlatformError> {
        let (program, args) = Self::reveal_args(path);
        spawn_detached(&program, &args, None)
    }
}

impl TerminalOpener for Windows {
    fn open_in_terminal(&self, dir: &Path) -> Result<(), PlatformError> {
        spawn_first_ok(Self::terminal_candidates(dir), None)
    }
}

impl TrashOps for Windows {
    fn to_trash(&self, _path: &Path) -> Result<(), PlatformError> {
        // TODO(阶段 3)：接入 trash crate（主计划 §1 候选依赖，随 Wave 2 由主 Agent
        // 加入 Cargo.toml）。Windows 走 Shell IFileOperation，保证在资源管理器中
        // 可"还原"（阶段 3 验收标准）。
        Err(PlatformError::Unsupported)
    }

    fn delete_permanently(&self, _path: &Path) -> Result<(), PlatformError> {
        // TODO(阶段 3)：std::fs::remove_file / remove_dir_all；调用前必须先经过
        // workspace 的项目根路径边界校验（主计划阶段 3"禁止越出项目根"）。
        Err(PlatformError::Unsupported)
    }
}
