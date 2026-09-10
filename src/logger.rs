//! 轻量本地文件日志系统：将关键操作、错误与诊断信息写入 `{data_base}/glancemd.log`。
//!
//! 特性：
//! - 纯标准库实现，零额外外部运行时依赖；
//! - 线程安全（`Mutex<Option<File>>`），支持多线程并发日志记录；
//! - 包含时间戳、日志级别、所在文件及行号；
//! - 同步支持标准错误输出与文件双向写入。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static LOG_FILE: Mutex<Option<File>> = Mutex::new(None);
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// 初始化日志文件系统，指定基准目录（通常为 `data_dir::data_base()`）。
pub fn init(base_dir: &Path) {
    let path = base_dir.join("glancemd.log");
    let _ = LOG_PATH.set(path.clone());

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(file) => {
            if let Ok(mut guard) = LOG_FILE.lock() {
                *guard = Some(file);
            }
            log_line(
                "INFO",
                "logger",
                format!("=== 日志系统初始化完成，日志文件：{} ===", path.display()),
            );
        }
        Err(e) => {
            eprintln!("无法创建日志文件 {}: {e}", path.display());
        }
    }
}

/// 格式化并写入一条日志。
pub fn log_line(level: &str, target: &str, message: impl AsRef<str>) {
    let now = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => {
            let secs = d.as_secs();
            let millis = d.subsec_millis();
            format!("{secs}.{millis:03}")
        }
        Err(_) => "0.000".to_string(),
    };

    let line = format!("[{now}] [{level}] [{target}] {}\n", message.as_ref());

    // 1. 尝试写入文件
    if let Ok(mut guard) = LOG_FILE.lock() {
        if let Some(ref mut file) = *guard {
            let _ = file.write_all(line.as_bytes());
            let _ = file.flush();
        }
    }

    // 2. 同时打印到 stderr
    eprint!("{line}");
}

#[macro_export]
macro_rules! log_info {
    ($target:expr, $($arg:tt)+) => {
        $crate::logger::log_line("INFO", $target, format!($($arg)+))
    };
}

#[macro_export]
macro_rules! log_warn {
    ($target:expr, $($arg:tt)+) => {
        $crate::logger::log_line("WARN", $target, format!($($arg)+))
    };
}

#[macro_export]
macro_rules! log_error {
    ($target:expr, $($arg:tt)+) => {
        $crate::logger::log_line("ERROR", $target, format!($($arg)+))
    };
}
