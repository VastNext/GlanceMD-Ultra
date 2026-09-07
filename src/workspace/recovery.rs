//! 崩溃恢复区（主实施计划阶段 6 交付项 4）。
//!
//! 每个 tab 的未保存内容按 [`RecoveryEntry`] 周期性快照到
//! `{base_dir}/recovery/{tab_id}.json`；应用异常退出后，下次启动列出待
//! 恢复条目（`workspace:recovery-available` 事件），由用户逐个选择恢复
//! 或丢弃。
//!
//! 设计要点：
//!
//! - `base_dir` 由调用方注入（生产为便携数据目录 `data_dir::data_base()`，
//!   即优先 exe 旁 `data/`、不可写时回退用户配置目录；探针测试用临时目录）。
//!   恢复区位于数据目录、即任何项目根之外——快照
//!   写入天然不会触发阶段 2 的文件监听，与回环抑制解耦；
//! - 每 tab 一个 JSON 文件；同 tab 重复快照**原子覆盖**（同目录临时文件 +
//!   rename）。原子写在本模块内自含实现（[`write_atomic`]），不引用
//!   `crate::` 路径，保证能被 `tests/recovery_probe.rs` 以 `#[path]`
//!   方式独立编译测试；集成后如需统一实现可换用 `crate::atomic_save`；
//! - 单个条目损坏（非法 JSON / 读取失败）只影响自身：[`RecoveryStore::list_pending`]
//!   跳过并在报告中收集 warning，[`RecoveryStore::prune_before`] 顺手清除；
//! - `tab_id` 由前端生成，用作文件名前做字符白名单清洗（含 Windows 保留
//!   设备名防御），条目 JSON 内的 `tab_id` 字段保持原值——存取使用同一
//!   清洗映射，含非法字符的 id 也能对称找回。
//!
//! IPC 契约（命令 `workspace.recovery.snapshot/list/restore/discard`、事件
//! `workspace:recovery-available` / `workspace:recovery-restored`）见
//! `docs/dev/contracts/data-protection.md`。集成时由集成方在
//! `src/workspace/mod.rs` 追加 `pub mod recovery;`，此前允许 dead_code。

#![allow(dead_code)]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// 单个 tab 的崩溃恢复条目（JSON 文件内容，字段名即序列化键名）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryEntry {
    /// 前端生成的 tab 唯一 ID（文件名由它清洗而来，字段保持原值）。
    pub tab_id: String,
    /// 关联的磁盘文件路径；未关联磁盘文件的新建 tab 为 `None`。
    pub path: Option<String>,
    /// 快照时刻的编辑器内容。
    pub content: String,
    /// 快照时刻（Unix 毫秒），过期清理（prune）的依据。
    pub saved_at_ms: u64,
}

/// 恢复区写入错误。
#[derive(Debug)]
pub enum RecoveryError {
    /// 目录创建 / 临时文件写入 / 替换失败。
    Io(std::io::Error),
    /// 条目序列化失败（String 字段实际不会失败，防御性保留）。
    Json(serde_json::Error),
}

impl std::fmt::Display for RecoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RecoveryError::Io(e) => write!(f, "恢复区写入失败：{e}"),
            RecoveryError::Json(e) => write!(f, "恢复条目序列化失败：{e}"),
        }
    }
}

impl std::error::Error for RecoveryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            RecoveryError::Io(e) => Some(e),
            RecoveryError::Json(e) => Some(e),
        }
    }
}

/// 待恢复条目列表 + 被跳过的损坏条目警告。
#[derive(Debug, Default, Clone)]
pub struct PendingReport {
    /// 可正常解析的待恢复条目（按 `saved_at_ms` 升序，稳定可预期）。
    pub entries: Vec<RecoveryEntry>,
    /// 损坏条目的警告（"跳过损坏的恢复条目 <文件名>: <原因>"）。
    pub warnings: Vec<String>,
}

/// 崩溃恢复区：`{base_dir}/recovery/` 下每 tab 一个 JSON 文件。
#[derive(Debug, Clone)]
pub struct RecoveryStore {
    dir: PathBuf,
}

impl RecoveryStore {
    /// 以注入的 `base_dir` 打开恢复区（实际目录为 `{base_dir}/recovery/`，
    /// 惰性创建：首次 [`RecoveryStore::snapshot`] 时才建目录）。
    pub fn open(base_dir: &Path) -> Self {
        Self {
            dir: base_dir.join("recovery"),
        }
    }

    /// 恢复目录路径（诊断/测试用）。
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 写入 / 覆盖一个 tab 的快照（同 tab 重复快照原子覆盖，目录惰性创建）。
    pub fn snapshot(&self, entry: &RecoveryEntry) -> Result<(), RecoveryError> {
        std::fs::create_dir_all(&self.dir).map_err(RecoveryError::Io)?;
        let json = serde_json::to_vec_pretty(entry).map_err(RecoveryError::Json)?;
        let target = self.entry_path(&entry.tab_id);
        write_atomic(&self.dir, &target, &json)
    }

    /// 列出全部待恢复条目（损坏条目跳过）。
    pub fn list_pending(&self) -> Vec<RecoveryEntry> {
        self.list_pending_report().entries
    }

    /// 同 [`RecoveryStore::list_pending`]，额外收集被跳过条目的警告，
    /// 供粘合层决定是否在状态栏/日志提示。
    pub fn list_pending_report(&self) -> PendingReport {
        let mut report = PendingReport::default();
        let Ok(read) = std::fs::read_dir(&self.dir) else {
            return report; // 恢复区目录不存在＝没有待恢复条目
        };
        let mut files: Vec<PathBuf> = read
            .flatten()
            .map(|e| e.path())
            // 只认 .json 条目；`.tmp-` 半成品与其他杂物一律忽略
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
            .collect();
        files.sort();
        for path in files {
            let parsed = std::fs::read(&path)
                .map_err(|e| e.to_string())
                .and_then(|bytes| {
                    serde_json::from_slice::<RecoveryEntry>(&bytes).map_err(|e| e.to_string())
                });
            match parsed {
                Ok(entry) => report.entries.push(entry),
                Err(reason) => {
                    let name = file_name_of(&path);
                    report
                        .warnings
                        .push(format!("跳过损坏的恢复条目 {name}: {reason}"));
                }
            }
        }
        report.entries.sort_by(|a, b| {
            (a.saved_at_ms, a.tab_id.as_str()).cmp(&(b.saved_at_ms, b.tab_id.as_str()))
        });
        report
    }

    /// 取走一个条目（读出即删文件）；条目不存在或损坏返回 `None`。
    /// 损坏条目原地保留，由 [`RecoveryStore::list_pending_report`] 暴露、
    /// [`RecoveryStore::prune_before`] 清除，不在这里悄悄销毁数据。
    pub fn take(&self, tab_id: &str) -> Option<RecoveryEntry> {
        let file = self.entry_path(tab_id);
        let bytes = std::fs::read(&file).ok()?;
        match serde_json::from_slice::<RecoveryEntry>(&bytes) {
            Ok(entry) => {
                let _ = std::fs::remove_file(&file); // 取走即删
                Some(entry)
            }
            Err(_) => None,
        }
    }

    /// 丢弃一个条目（尽力删除；不存在或删除失败静默——丢弃本就是放弃）。
    pub fn discard(&self, tab_id: &str) {
        let _ = std::fs::remove_file(self.entry_path(tab_id));
    }

    /// 清理 `saved_at_ms` 早于 `now_ms - max_age_ms` 的条目，返回清理数量。
    ///
    /// "默认保留 7 天"由调用方换算成毫秒传入（`7 * 24 * 3600 * 1000`）；
    /// `now_ms` 注入以便测试。顺带清除快照中断残留的 `.tmp-` 文件与无法
    /// 解析的损坏条目（恢复区是可再生的草稿区，损坏即无价值）。
    pub fn prune_before(&self, max_age_ms: u64, now_ms: u64) -> usize {
        let cutoff = now_ms.saturating_sub(max_age_ms);
        let Ok(read) = std::fs::read_dir(&self.dir) else {
            return 0;
        };
        let mut pruned = 0;
        for entry in read.flatten() {
            let path = entry.path();
            let name = file_name_of(&path);
            let is_entry = path.extension().and_then(|e| e.to_str()) == Some("json");
            let is_tmp_leftover = name.starts_with(".tmp-");
            if !is_entry && !is_tmp_leftover {
                continue;
            }
            if is_entry {
                match std::fs::read(&path)
                    .ok()
                    .and_then(|b| serde_json::from_slice::<RecoveryEntry>(&b).ok())
                {
                    Some(e) if e.saved_at_ms >= cutoff => continue, // 仍在保留期内
                    Some(_) | None => {}                            // 过期或损坏 → 删除
                }
            }
            if std::fs::remove_file(&path).is_ok() {
                pruned += 1;
            }
        }
        pruned
    }

    /// tab_id → 条目文件路径（与 [`sanitize_tab_id`] 同一映射，对称可逆）。
    fn entry_path(&self, tab_id: &str) -> PathBuf {
        self.dir.join(format!("{}.json", sanitize_tab_id(tab_id)))
    }
}

/// tab_id → 文件名安全片段：仅保留字母数字（含中文等多字节字母）与
/// `-_.`，其余（路径分隔符、Windows 非法字符、控制符等）替换为 `_`；
/// 空串、纯点（`.`/`..` 穿越形态）、Windows 保留设备名、超长（>100 字节）
/// 一并防御。
fn sanitize_tab_id(tab_id: &str) -> String {
    let mapped: String = tab_id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut out = if mapped.is_empty() {
        "_"
    } else {
        mapped.as_str()
    }
    .to_string();
    if out == "." || out == ".." {
        out = "_".to_string();
    }
    // Windows 保留设备名（CON.json 这类历史形态同样命中），前缀下划线规避
    let stem = out.split('.').next().unwrap_or_default();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r)) {
        out = format!("_{out}");
    }
    // 按字符边界截断，避免极端超长 id 撑爆路径长度或切断多字节字符
    if out.len() > 100 {
        let mut cut = 100;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
    }
    out
}

/// 自含的原子覆盖写（与 `atomic_save` 同策略：同目录临时文件 + rename；
/// 自含实现以避免 `crate::` 路径依赖，见模块文档）。
fn write_atomic(dir: &Path, target: &Path, bytes: &[u8]) -> Result<(), RecoveryError> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let tmp = dir.join(format!(
        ".tmp-{}-{}-{}",
        std::process::id(),
        nanos,
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let write_result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create_new(&tmp)?;
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(RecoveryError::Io(e));
    }
    match std::fs::rename(&tmp, target) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(RecoveryError::Io(e))
        }
    }
}

/// 文件名（丢失时回退完整路径文本），用于警告消息。
fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_tab_id_白名单清洗与防御() {
        // 非法字符替换为下划线
        assert_eq!(sanitize_tab_id(r"a/b:c*d?e<f>g|h"), "a_b_c_d_e_f_g_h");
        // 中文等多字节字母保留
        assert_eq!(sanitize_tab_id("tab-中文-1"), "tab-中文-1");
        // 空串与纯点
        assert_eq!(sanitize_tab_id(""), "_");
        assert_eq!(sanitize_tab_id(".."), "_");
        // Windows 保留设备名
        assert_eq!(sanitize_tab_id("CON"), "_CON");
        assert_eq!(sanitize_tab_id("com1"), "_com1");
        assert_eq!(sanitize_tab_id("aux.md"), "_aux.md");
        // 超长按字符边界截断（"字" 3 字节/字符，99 字节处是最近边界）
        let long = "字".repeat(80); // 240 字节
        let sanitized = sanitize_tab_id(&long);
        assert!(sanitized.len() <= 100 && sanitized.is_char_boundary(sanitized.len()));
        assert_eq!(sanitized.len(), 99);
    }
}
