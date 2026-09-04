//! Linux 平台实现：xdg-open 显示父目录、桌面环境终端探测、回收站占位。

use std::path::Path;

use super::{spawn_detached, spawn_first_ok, PlatformError, Revealer, TerminalOpener, TrashOps};

/// Linux 平台能力实现。
#[derive(Debug)]
pub struct Linux;

impl Linux {
    /// 拼装"在文件管理器中显示"命令：`xdg-open <父目录>`。
    ///
    /// Linux 没有跨文件管理器的"定位选中"协议，按主计划阶段 3 的约定降级为
    /// 打开父目录（文件管理器由 xdg-open 依据桌面环境选择）。边界处理：
    ///
    /// - 裸文件名（parent 为空串）→ 打开当前目录 `.`；
    /// - 根路径（无 parent，如 `/`）→ 就地打开自身。
    pub fn reveal_args(path: &Path) -> (String, Vec<String>) {
        let target: &Path = match path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            Some(_) => Path::new("."),
            None => path,
        };
        (
            "xdg-open".to_string(),
            vec![target.as_os_str().to_string_lossy().into_owned()],
        )
    }

    /// 拼装"在终端中打开"的候选命令序列（按桌面环境常见度排序，运行时逐个尝试
    /// 直到启动成功）：
    ///
    /// 1. GNOME：`gnome-terminal --working-directory=<dir>`
    /// 2. KDE：`konsole --workdir <dir>`
    /// 3. Debian 替代系统兜底：`x-terminal-emulator`（无统一的工作目录参数，
    ///    由 [`super::spawn_first_ok`] 以子进程工作目录补足）
    pub fn terminal_candidates(dir: &Path) -> Vec<(String, Vec<String>)> {
        let dir = dir.as_os_str().to_string_lossy().into_owned();
        vec![
            (
                "gnome-terminal".to_string(),
                vec![format!("--working-directory={dir}")],
            ),
            (
                "konsole".to_string(),
                vec!["--workdir".to_string(), dir.clone()],
            ),
            ("x-terminal-emulator".to_string(), Vec::new()),
        ]
    }
}

impl Revealer for Linux {
    fn reveal(&self, path: &Path) -> Result<(), PlatformError> {
        let (program, args) = Self::reveal_args(path);
        spawn_detached(&program, &args, None)
    }
}

impl TerminalOpener for Linux {
    fn open_in_terminal(&self, dir: &Path) -> Result<(), PlatformError> {
        // current_dir 对前两个候选无副作用（它们自带工作目录参数），对
        // x-terminal-emulator 则是唯一的工作目录手段。
        spawn_first_ok(Self::terminal_candidates(dir), Some(dir))
    }
}

impl TrashOps for Linux {
    fn to_trash(&self, _path: &Path) -> Result<(), PlatformError> {
        // TODO(阶段 3)：接入 trash crate（主计划 §1 候选依赖），走 FreeDesktop
        // 回收站规范（~/.local/share/Trash，可"从回收站还原"）。
        Err(PlatformError::Unsupported)
    }

    fn delete_permanently(&self, _path: &Path) -> Result<(), PlatformError> {
        // TODO(阶段 3)：std::fs::remove_file / remove_dir_all；调用前必须先经过
        // workspace 的项目根路径边界校验（主计划阶段 3"禁止越出项目根"）。
        Err(PlatformError::Unsupported)
    }
}
