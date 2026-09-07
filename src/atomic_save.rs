//! 原子保存（主实施计划阶段 6 交付项 1）。
//!
//! 语义：把字节安全地覆盖到目标路径——先写**同目录**唯一临时文件，
//! `write_all → flush → sync_all` 落盘后用 [`std::fs::rename`] 原子替换
//! 目标。任何一步失败都不触碰目标文件的旧内容；进程在任意时刻被杀，
//! 最坏结果只是残留一个半成品临时文件（`.tmp-` 前缀），目标完好。
//!
//! Windows 覆盖依据：std 文档明确 `fs::rename` 在 Windows 上对应
//! `MoveFileExW` 且带 `MOVEFILE_REPLACE_EXISTING` 标志，可覆盖已存在的
//! 文件；本仓库 `tests/atomic_save_probe.rs` 在 Windows 主平台实测覆盖
//! 成立。注意边界：若目标被其他进程以不共享删除的方式占用，rename 返回
//! Access Denied——此时旧文件完好，属可接受的失败（优于半成品目标）。
//!
//! 临时文件命名：目标同目录 `.tmp-<pid>-<纳秒>-<计数>`。放在同目录是
//! 为了 rename 不跨卷（跨卷 rename 退化为复制+删除，失去原子性）；崩溃
//! 残留的清扫属启动期策略，见 `docs/dev/contracts/data-protection.md`。
//!
//! 接线说明：本模块为纯新增，`main.rs` 的 `mod atomic_save;` 声明由集成
//! 方添加；集成前没有生产调用方（`ipc.rs` 的 save_file 仍走
//! `file_ops::write_file`），因此暂时允许 dead_code。模块自含（仅依赖
//! std），可被 `tests/atomic_save_probe.rs` 以 `#[path]` 方式独立测试。

#![allow(dead_code)]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// 临时文件名的碰撞重试上限（名字含纳秒 + 进程内计数，实际几乎不可能碰撞）。
const CREATE_ATTEMPTS: usize = 4;

/// 原子保存错误。
#[derive(Debug)]
pub enum SaveError {
    /// 目标路径的父目录不存在或不是目录（不代建目录，显式失败）。
    MissingParent(PathBuf),
    /// 底层 I/O 失败（建临时文件/写入/刷盘/替换）。此时目标旧内容保证完好。
    Io(std::io::Error),
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SaveError::MissingParent(p) => {
                write!(f, "目标父目录不存在或不是目录：{}", p.display())
            }
            SaveError::Io(e) => write!(f, "原子保存失败：{e}"),
        }
    }
}

impl std::error::Error for SaveError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SaveError::Io(e) => Some(e),
            _ => None,
        }
    }
}

/// 原子地把 `bytes` 覆盖写入 `path`。
///
/// 流程：同目录建唯一临时文件（`create_new` 保证不覆盖任何已有文件）→
/// 写入 → flush → `sync_all`（落盘后再替换，掉电不留半成品目标）→ 关闭
/// 句柄 → `rename` 原子覆盖目标。失败时清理临时文件并返回错误。
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), SaveError> {
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        // 无父目录成分的裸路径（如 "note.md"）同样按缺父目录拒绝
        _ => return Err(SaveError::MissingParent(path.to_path_buf())),
    };
    if !parent.is_dir() {
        return Err(SaveError::MissingParent(parent.to_path_buf()));
    }
    let (tmp_path, mut file) = create_temp(parent)?;
    let write_result = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_all()?;
        Ok(())
    })();
    // 先关闭句柄再替换：Windows 上避免句柄占用干扰 rename
    drop(file);
    match write_result {
        Ok(()) => match std::fs::rename(&tmp_path, path) {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = std::fs::remove_file(&tmp_path);
                Err(SaveError::Io(e))
            }
        },
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path);
            Err(SaveError::Io(e))
        }
    }
}

/// 在 `dir` 下创建唯一临时文件，返回（路径，句柄）。
fn create_temp(dir: &Path) -> Result<(PathBuf, std::fs::File), SaveError> {
    let mut last_err = None;
    for _ in 0..CREATE_ATTEMPTS {
        let candidate = temp_path(dir);
        match std::fs::File::create_new(&candidate) {
            Ok(file) => return Ok((candidate, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                last_err = Some(e); // 换名重试
            }
            Err(e) => return Err(SaveError::Io(e)),
        }
    }
    Err(SaveError::Io(last_err.expect("循环至少执行一次")))
}

/// 生成进程内唯一的临时文件路径：`.tmp-<pid>-<纳秒>-<计数>`。
fn temp_path(dir: &Path) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(".tmp-{}-{}-{}", std::process::id(), nanos, seq))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_path_同目录进程内唯一() {
        let dir = std::env::temp_dir();
        let a = temp_path(&dir);
        let b = temp_path(&dir);
        assert_ne!(a, b);
        assert!(a
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".tmp-"));
    }
}
