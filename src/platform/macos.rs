//! macOS 平台实现：Finder 显示、Terminal 打开、废纸篓（trash crate）。

use std::path::Path;

use super::{spawn_detached, spawn_first_ok, PlatformError, Revealer, TerminalOpener, TrashOps};

/// macOS 平台能力实现。
#[derive(Debug)]
pub struct MacOs;

impl MacOs {
    /// 拼装"在 Finder 中显示"命令：`open -R <path>`。
    ///
    /// `-R`（--reveal）在 Finder 中定位并选中该路径，文件/目录均可。
    pub fn reveal_args(path: &Path) -> (String, Vec<String>) {
        (
            "open".to_string(),
            vec![
                "-R".to_string(),
                path.as_os_str().to_string_lossy().into_owned(),
            ],
        )
    }

    /// 拼装"在终端中打开"的候选命令序列（阶段 0 仅 Terminal.app 一个候选，
    /// 保留与 Windows/Linux 一致的候选列表形状，便于阶段 3 扩展 iTerm2 等）：
    /// `open -a Terminal <dir>`。
    pub fn terminal_candidates(dir: &Path) -> Vec<(String, Vec<String>)> {
        vec![(
            "open".to_string(),
            vec![
                "-a".to_string(),
                "Terminal".to_string(),
                dir.as_os_str().to_string_lossy().into_owned(),
            ],
        )]
    }
}

impl Revealer for MacOs {
    fn reveal(&self, path: &Path) -> Result<(), PlatformError> {
        let (program, args) = Self::reveal_args(path);
        spawn_detached(&program, &args, None)
    }
}

impl TerminalOpener for MacOs {
    fn open_in_terminal(&self, dir: &Path) -> Result<(), PlatformError> {
        spawn_first_ok(Self::terminal_candidates(dir), None)
    }
}

impl TrashOps for MacOs {
    fn to_trash(&self, path: &Path) -> Result<(), PlatformError> {
        // trash crate（macOS 后端走 Finder 语义的废纸篓，支持"放回原处"）。
        trash::delete(path).map_err(PlatformError::from)
    }

    fn delete_permanently(&self, path: &Path) -> Result<(), PlatformError> {
        super::delete_permanently_std(path)
    }
}
