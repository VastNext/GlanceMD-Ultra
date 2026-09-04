//! 平台能力抽象（主实施计划阶段 0 交付项 5）。
//!
//! 把依赖操作系统的能力隔离在 trait 之后，上层调用方（阶段 3 的 `workspace::operations`
//! 与 IPC 处理器）只面向 trait 编程，不直接接触 `std::process::Command`：
//!
//! - [`Revealer`]：在系统文件管理器中显示某个路径（Explorer / Finder / xdg-open）
//! - [`TrashOps`]：移入回收站/废纸篓、永久删除
//! - [`TerminalOpener`]：在系统终端中打开某个目录
//!
//! 结构约定：
//!
//! - "拼装命令行参数"的逻辑是各平台子模块里的纯函数（如 `windows::reveal_args`），
//!   可脱离真实进程独立测试；
//! - 真正的进程启动只发生在 [`spawn_detached`] / [`spawn_first_ok`] 两个薄封装里；
//! - [`revealer`] / [`trash_ops`] / [`terminal_opener`] 三个工厂按 `cfg!(target_os)`
//!   把请求分发到 `windows` / `macos` / `linux` 子模块的实现。
//!
//! 接线说明：本模块是纯新增模块，`main.rs` 的 `mod platform;` 声明由集成方在合并时
//! 添加；阶段 3 才接入 trash crate 与前端 IPC，在那之前没有生产调用方，因此整个
//! 模块暂时允许 dead_code（含尚未构造的 [`PlatformError::CommandFailed`] 变体）。

#![allow(dead_code)]

use std::fmt;
use std::path::Path;
use std::process::ExitStatus;

pub mod linux;
pub mod macos;
pub mod windows;

/// 平台能力调用失败的原因。
#[derive(Debug)]
pub enum PlatformError {
    /// 当前平台不支持该能力（如阶段 3 接入 trash crate 之前的回收站操作）。
    Unsupported,
    /// 外部命令已启动但以非零状态退出（阶段 3 引入退出码校验后启用）。
    CommandFailed {
        /// 被调用的程序名。
        program: String,
        /// 进程退出状态。
        status: ExitStatus,
    },
    /// 与操作系统交互时的 I/O 错误（含命令未找到等进程启动失败）。
    Io(std::io::Error),
}

impl fmt::Display for PlatformError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PlatformError::Unsupported => write!(f, "当前平台不支持该操作"),
            PlatformError::CommandFailed { program, status } => {
                write!(f, "命令 {program} 执行失败：{status}")
            }
            PlatformError::Io(err) => write!(f, "平台命令调用失败：{err}"),
        }
    }
}

impl std::error::Error for PlatformError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            PlatformError::Io(err) => Some(err),
            _ => None,
        }
    }
}

impl From<std::io::Error> for PlatformError {
    fn from(err: std::io::Error) -> Self {
        PlatformError::Io(err)
    }
}

/// 在系统文件管理器中显示给定路径（文件或目录均可，具体语义见各平台实现）。
pub trait Revealer: fmt::Debug {
    fn reveal(&self, path: &Path) -> Result<(), PlatformError>;
}

/// 回收站/废纸篓操作。
pub trait TrashOps: fmt::Debug {
    /// 移入系统回收站（可还原）。
    fn to_trash(&self, path: &Path) -> Result<(), PlatformError>;
    /// 永久删除（不可还原）。
    fn delete_permanently(&self, path: &Path) -> Result<(), PlatformError>;
}

/// 在系统终端中打开给定目录。
pub trait TerminalOpener: fmt::Debug {
    fn open_in_terminal(&self, dir: &Path) -> Result<(), PlatformError>;
}

/// 返回当前平台的 [`Revealer`] 实现。
pub fn revealer() -> Box<dyn Revealer> {
    if cfg!(target_os = "windows") {
        Box::new(windows::Windows)
    } else if cfg!(target_os = "macos") {
        Box::new(macos::MacOs)
    } else {
        Box::new(linux::Linux)
    }
}

/// 返回当前平台的 [`TrashOps`] 实现。
pub fn trash_ops() -> Box<dyn TrashOps> {
    if cfg!(target_os = "windows") {
        Box::new(windows::Windows)
    } else if cfg!(target_os = "macos") {
        Box::new(macos::MacOs)
    } else {
        Box::new(linux::Linux)
    }
}

/// 返回当前平台的 [`TerminalOpener`] 实现。
pub fn terminal_opener() -> Box<dyn TerminalOpener> {
    if cfg!(target_os = "windows") {
        Box::new(windows::Windows)
    } else if cfg!(target_os = "macos") {
        Box::new(macos::MacOs)
    } else {
        Box::new(linux::Linux)
    }
}

/// 薄封装：启动外部进程后立即返回，不等待其退出（fire-and-forget）。
///
/// 不等待的原因：reveal / 终端打开的目标进程（资源管理器、终端模拟器）生命周期由
/// 系统接管，等待会阻塞调用方甚至误报失败（如 Explorer 委派给已有实例时退出码
/// 非零）；退出码校验与 [`PlatformError::CommandFailed`] 的启用留待阶段 3 按平台
/// 三矩阵实测后补齐。
///
/// `current_dir`：个别平台候选命令（Linux 的 `x-terminal-emulator`）没有统一的工作
/// 目录参数，通过设置子进程工作目录补足；无此需求传 `None`。
pub(crate) fn spawn_detached(
    program: &str,
    args: &[String],
    current_dir: Option<&Path>,
) -> Result<(), PlatformError> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    if let Some(dir) = current_dir {
        cmd.current_dir(dir);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：对 cmd.exe 这类控制台中转程序避免闪现黑窗；对 GUI 程序
        // （explorer.exe / wt.exe）无副作用。阶段 3 行为接线时逐项实测确认。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map(|_| ()).map_err(PlatformError::Io)
}

/// 依序尝试候选命令，第一个启动成功的生效；全部失败时返回最后一个错误。
///
/// 候选序列由各平台子模块的 `terminal_candidates` 纯函数拼装。
pub(crate) fn spawn_first_ok(
    candidates: Vec<(String, Vec<String>)>,
    current_dir: Option<&Path>,
) -> Result<(), PlatformError> {
    let mut last_err: Option<PlatformError> = None;
    for (program, args) in &candidates {
        match spawn_detached(program, args, current_dir) {
            Ok(()) => return Ok(()),
            Err(err) => last_err = Some(err),
        }
    }
    match last_err {
        Some(err) => Err(err),
        None => Err(PlatformError::Unsupported),
    }
}
