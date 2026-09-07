//! 便携数据目录：优先 exe 同级的 `data/`，不可写时自动回退用户配置目录。
//!
//! 设计目标：
//! - 默认"尽量不写用户目录"：全局设置、崩溃恢复区、窗口状态、WebView2 用户
//!   数据统一收敛到 exe 同级的 `data/`，整个程序目录搬走即"便携"；
//! - exe 所在位置不可写时（macOS 的 .app 包内部、Windows Program Files、只读
//!   挂载等）自动回退 `dirs::config_dir()/glancemd-ultra`（与历史版本位置一致，
//!   旧数据天然兼容，无需迁移）；`config_dir` 不可用时退 `./glancemd-ultra-data`。
//! - 探测结果以 OnceLock 进程内缓存，整个进程生命周期只探测一次，后续调用
//!   零开销且结果稳定。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 探针文件名：在候选目录内"创建 → 写入 → 删除"各一次以验证真实可写性
const PROBE_FILE: &str = ".write-test";

/// 数据目录解析结果（进程内缓存，只解析一次）
pub fn data_base() -> &'static Path {
    static BASE: OnceLock<PathBuf> = OnceLock::new();
    BASE.get_or_init(|| {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(PathBuf::from));
        let fallback = user_config_base();
        resolve_data_base(exe_dir.as_deref(), fallback.as_deref(), probe_writable)
    })
    .as_path()
}

/// 回退一：用户配置目录下的 glancemd-ultra（历史版本的数据位置）
fn user_config_base() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("glancemd-ultra"))
}

/// 纯函数核心：按 `exe_dir/data` → `fallback` → `./glancemd-ultra-data` 的顺序
/// 选定数据目录。`probe` 注入可写性探测（生产为 [`probe_writable`]，单测注入
/// 恒真/恒假以覆盖各分支）。
///
/// 注意：`fallback`（用户配置目录）视为平台保证可写的位置，选定时不再探测；
/// `fallback` 为 None 即"回退失败"，落入第三兜底。第三兜底是最后的尽力而为，
/// 其后无路可退，故无条件返回（不再探测）。
pub fn resolve_data_base(
    exe_dir: Option<&Path>,
    fallback: Option<&Path>,
    probe: impl Fn(&Path) -> bool,
) -> PathBuf {
    // 候选：exe 同级 data/
    if let Some(exe_dir) = exe_dir {
        let candidate = exe_dir.join("data");
        if probe(&candidate) {
            return candidate;
        }
    }
    // 回退：用户配置目录（config_dir 为 None 视为回退失败）
    if let Some(fallback) = fallback {
        return fallback.to_path_buf();
    }
    PathBuf::from("./glancemd-ultra-data")
}

/// 真实可写性探测：建目录 → 写探针 → 删探针，任何一步失败即视为不可写。
/// 全部成功后候选目录已存在且不留探针残留。
fn probe_writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(PROBE_FILE);
    if std::fs::write(&probe, b"glancemd-ultra write probe").is_err() {
        return false;
    }
    std::fs::remove_file(&probe).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    /// 以组件序列比较路径，避免平台分隔符（/ 与 \）差异导致断言脆弱
    fn components(p: &Path) -> Vec<OsString> {
        p.components()
            .map(|c| c.as_os_str().to_os_string())
            .collect()
    }

    #[test]
    fn probe_通过时采用_exe_旁的_data_候选() {
        let exe_dir = Path::new("/opt/app");
        let fallback = Path::new("/home/u/.config/glancemd-ultra");
        let got = resolve_data_base(Some(exe_dir), Some(fallback), |_| true);
        assert_eq!(components(got.as_path()), components(&exe_dir.join("data")));
    }

    #[test]
    fn probe_失败时回退用户配置目录() {
        let exe_dir = Path::new("/opt/app");
        let fallback = Path::new("/home/u/.config/glancemd-ultra");
        let got = resolve_data_base(Some(exe_dir), Some(fallback), |_| false);
        assert_eq!(components(got.as_path()), components(fallback));
    }

    #[test]
    fn exe_dir_缺失时直接采用回退() {
        // current_exe 失败（exe_dir 为 None）但有回退 → 采用回退
        let fallback = Path::new("/home/u/.config/glancemd-ultra");
        let got = resolve_data_base(None, Some(fallback), |_| true);
        assert_eq!(components(got.as_path()), components(fallback));
    }

    #[test]
    fn 回退也为_none_时使用第三兜底() {
        let got = resolve_data_base(None, None, |_| true);
        assert_eq!(got, PathBuf::from("./glancemd-ultra-data"));
    }

    #[test]
    fn probe_失败且回退为_none_时同样落入第三兜底() {
        let got = resolve_data_base(Some(Path::new("/readonly/app")), None, |_| false);
        assert_eq!(got, PathBuf::from("./glancemd-ultra-data"));
    }

    #[test]
    fn 真实探针_临时目录可写_返回_true_且不留残留() {
        let dir =
            std::env::temp_dir().join(format!("glancemd-ultra-probe-ok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(probe_writable(&dir));
        assert!(dir.is_dir());
        assert!(!dir.join(PROBE_FILE).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 真实探针_路径被同名文件占用_返回_false() {
        // 用一个已存在的普通文件冒充目录：create_dir_all 必失败
        let dir =
            std::env::temp_dir().join(format!("glancemd-ultra-probe-bad-{}", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        std::fs::write(&dir, b"x").unwrap();
        assert!(!probe_writable(&dir));
        std::fs::remove_file(&dir).unwrap();
    }
}
