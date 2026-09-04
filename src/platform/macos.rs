//! macOS 平台实现：Finder 显示、Terminal 打开、废纸篓占位。

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
    fn to_trash(&self, _path: &Path) -> Result<(), PlatformError> {
        // TODO(阶段 3)：接入 trash crate（主计划 §1 候选依赖），走 Finder 语义的
        // 废纸篓（支持"放回原处"）。不在此处用 osascript 临时实现，避免阶段 0
        // 引入未经三平台矩阵实测的行为。
        Err(PlatformError::Unsupported)
    }

    fn delete_permanently(&self, _path: &Path) -> Result<(), PlatformError> {
        // TODO(阶段 3)：std::fs::remove_file / remove_dir_all；调用前必须先经过
        // workspace 的项目根路径边界校验（主计划阶段 3"禁止越出项目根"）。
        Err(PlatformError::Unsupported)
    }
}
