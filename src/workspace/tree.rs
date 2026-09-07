//! 懒加载目录树核心（主实施计划阶段 1）。
//!
//! 职责：按层列出单个目录的可见条目。懒加载语义——调用方（命令粘合层 + 前端
//! 项目树）逐层展开，本模块**不做递归遍历**，单次调用只返回一层内容。
//!
//! 过滤策略（主计划阶段 1 默认值，见 [`TreeFilter::default`]）：
//! - 默认可见扩展名：`.md .markdown .txt .json .yaml .yml .toml .ini .csv`；
//! - 默认排除目录：`.git node_modules target .venv dist build .cache`；
//! - 默认隐藏 `.` 开头的隐藏文件与隐藏目录；
//! - 文件符号链接显示并标注 [`EntryKind::SymLinkFile`]（受隐藏与扩展名过滤约束）；
//! - 目录符号链接**不显示**（不可展开：防越出可信项目根、防符号链接环路；
//!   若产品后续需要展示，可扩展 `symlink-dir` 类型，由集成方裁决）。
//!
//! 路径约定：[`TreeEntry::rel_path`] 与 `list_dir` 的 `rel_dir` 参数统一使用
//! `/` 分隔符（跨平台一致的 wire 格式）；`rel_dir` 允许为空串（表示根目录），
//! 不允许绝对路径、`..`、盘符前缀（越界语义一律拒绝）。
//!
//! 可测性约定：本模块自包含，仅依赖 std 与 serde（derive），不引用 `crate::`
//! 任何路径；分支内测试载体为 `tests/tree_probe.rs`（`#[path]` 引入本文件）。
//! 集成时由主 Agent 在 `src/workspace/mod.rs` 声明 `pub mod tree;`。
//!
//! 契约唯一事实源：`docs/dev/contracts/tree-search.md`。

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// 默认可见扩展名（主计划阶段 1；全部小写、含前导点）。
pub const DEFAULT_VISIBLE_EXTS: &[&str] = &[
    ".md",
    ".markdown",
    ".txt",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".csv",
];

/// 默认排除目录名（主计划阶段 1；匹配不区分大小写）。
pub const DEFAULT_EXCLUDED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".venv",
    "dist",
    "build",
    ".cache",
];

/// 目录树过滤配置。
#[derive(Debug, Clone)]
pub struct TreeFilter {
    /// 可见扩展名集合（不区分大小写；条目可省略前导点，内部统一补点）。
    pub visible_exts: Vec<String>,
    /// 排除目录名集合（不区分大小写，按目录名精确匹配单个路径段）。
    pub excluded_dirs: Vec<String>,
    /// 是否显示隐藏文件/目录（`.` 开头的名称）。
    pub show_hidden: bool,
}

impl Default for TreeFilter {
    fn default() -> Self {
        TreeFilter {
            visible_exts: DEFAULT_VISIBLE_EXTS
                .iter()
                .map(|s| (*s).to_string())
                .collect(),
            excluded_dirs: DEFAULT_EXCLUDED_DIRS
                .iter()
                .map(|s| (*s).to_string())
                .collect(),
            show_hidden: false,
        }
    }
}

/// 条目种类。wire 序列化值：`"dir"` / `"file"` / `"symlink-file"`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum EntryKind {
    /// 目录（可展开；目录符号链接不会以此类型出现）。
    #[serde(rename = "dir")]
    Dir,
    /// 普通文件。
    #[serde(rename = "file")]
    File,
    /// 文件符号链接（断链的符号链接也归入此类）。
    #[serde(rename = "symlink-file")]
    SymLinkFile,
}

/// 目录树单层条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TreeEntry {
    /// 名称（最后一段；非 UTF-8 名称按有损转换展示）。
    pub name: String,
    /// 相对项目根的路径，`/` 分隔（如 `docs/notes/a.md`；根层条目即 `name`）。
    pub rel_path: String,
    /// 条目种类。
    pub kind: EntryKind,
}

/// 目录树错误。
#[derive(Debug)]
pub enum TreeError {
    /// 目标目录不存在。
    NotFound(PathBuf),
    /// 目标存在但不是目录。
    NotADirectory(PathBuf),
    /// 相对目录非法（绝对路径、`..`、盘符前缀、NUL 等越界语义）。
    InvalidRelDir(String),
    /// 底层 I/O 错误。
    Io(std::io::Error),
}

impl std::fmt::Display for TreeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TreeError::NotFound(p) => write!(f, "目录不存在：{}", p.display()),
            TreeError::NotADirectory(p) => write!(f, "不是目录：{}", p.display()),
            TreeError::InvalidRelDir(r) => write!(
                f,
                "非法的相对目录「{r}」（不允许绝对路径、`..` 或盘符前缀）"
            ),
            TreeError::Io(e) => write!(f, "目录读取失败：{e}"),
        }
    }
}

impl std::error::Error for TreeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            TreeError::Io(e) => Some(e),
            _ => None,
        }
    }
}

/// 列出 `root` 下 `rel_dir` 目录的单层可见条目（懒加载，一层）。
///
/// 排序：目录在前，组内按名称排序（不区分大小写；同名时按原始字节序稳定排序）。
/// 单个条目的元数据读取失败时跳过该条目（不整体失败）；`rel_dir` 目录本身
/// 不可读时报 [`TreeError::Io`]。
pub fn list_dir(
    root: &Path,
    rel_dir: &str,
    filter: &TreeFilter,
) -> Result<Vec<TreeEntry>, TreeError> {
    let rel = validate_rel_dir(rel_dir)?;
    let is_root = rel.as_os_str().is_empty();
    // rel_path 统一使用 `/` 分隔（PathBuf 在 Windows 上的展示分隔符是 `\`）
    let rel_prefix = rel.to_string_lossy().replace('\\', "/");
    let full = if is_root {
        root.to_path_buf()
    } else {
        root.join(&rel)
    };

    let meta = match fs::metadata(&full) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(TreeError::NotFound(full));
        }
        Err(e) => return Err(TreeError::Io(e)),
    };
    if !meta.is_dir() {
        return Err(TreeError::NotADirectory(full));
    }

    let exts = normalized_ext_set(filter);
    let excluded = normalized_dir_set(filter);

    let mut entries: Vec<TreeEntry> = Vec::new();
    let read = fs::read_dir(&full).map_err(TreeError::Io)?;
    for entry in read {
        let Ok(entry) = entry else { continue };
        let Ok(ft) = entry.file_type() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();

        let kind = if ft.is_symlink() {
            // 符号链接：目录符号链接一律不显示（防越界与环路）；文件符号链接
            // 与断链符号链接按普通文件的过滤规则显示，并标注 SymLinkFile。
            match fs::metadata(entry.path()) {
                Ok(m) if m.is_dir() => continue,
                _ => {
                    if !filter.show_hidden && is_hidden_name(&name) {
                        continue;
                    }
                    if !is_visible_file(&name, &exts) {
                        continue;
                    }
                    EntryKind::SymLinkFile
                }
            }
        } else if ft.is_dir() {
            if !filter.show_hidden && is_hidden_name(&name) {
                continue;
            }
            if is_excluded_dir(&name, &excluded) {
                continue;
            }
            EntryKind::Dir
        } else {
            if !filter.show_hidden && is_hidden_name(&name) {
                continue;
            }
            if !is_visible_file(&name, &exts) {
                continue;
            }
            EntryKind::File
        };

        let rel_path = if is_root {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };
        entries.push(TreeEntry {
            name,
            rel_path,
            kind,
        });
    }

    entries.sort_by(|a, b| {
        kind_rank(a.kind)
            .cmp(&kind_rank(b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

/// 排序键：目录（rank 0）恒在文件与文件符号链接（rank 1）之前。
fn kind_rank(kind: EntryKind) -> u8 {
    match kind {
        EntryKind::Dir => 0,
        EntryKind::File | EntryKind::SymLinkFile => 1,
    }
}

/// 名称是否为隐藏（`.` 开头）。
fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

/// 取文件名的扩展名（含前导点，取最后一个点之后的部分）；无扩展名返回 `None`。
///
/// 以单个点开头且无后续点的名称（如 `.env`、`.gitignore`）视为无扩展名——
/// 即不受扩展名白名单约束，仅受隐藏开关约束（编辑器惯例）。
fn ext_of(name: &str) -> Option<&str> {
    let dot = name.rfind('.')?;
    if dot == 0 {
        return None;
    }
    Some(&name[dot..])
}

/// 文件名是否通过扩展名白名单（不区分大小写）。
///
/// 无扩展名的普通名（如 `LICENSE`）不可见；纯点前缀名（`.env` 等）视为无
/// 扩展名且放行——能走到这里的点前缀名必然已通过 show_hidden 检查。
fn is_visible_file(name: &str, visible_exts: &HashSet<String>) -> bool {
    match ext_of(name) {
        Some(ext) => visible_exts.contains(&ext.to_ascii_lowercase()),
        None => is_hidden_name(name),
    }
}

/// 目录名是否命中排除集合（不区分大小写）。
fn is_excluded_dir(name: &str, excluded_dirs: &HashSet<String>) -> bool {
    excluded_dirs.contains(&name.to_ascii_lowercase())
}

/// 把过滤器中的扩展名规范化为小写、含前导点的集合。
fn normalized_ext_set(filter: &TreeFilter) -> HashSet<String> {
    filter
        .visible_exts
        .iter()
        .map(|e| {
            let e = e.trim();
            let lowered = e.to_ascii_lowercase();
            if lowered.starts_with('.') {
                lowered
            } else {
                format!(".{lowered}")
            }
        })
        .collect()
}

/// 把过滤器中的排除目录名规范化为小写集合。
fn normalized_dir_set(filter: &TreeFilter) -> HashSet<String> {
    filter
        .excluded_dirs
        .iter()
        .map(|d| d.to_ascii_lowercase())
        .collect()
}

/// 校验并规范化 `rel_dir`：统一 `/` 分隔、丢弃空段与 `.` 段、拒绝越界语义。
///
/// 拒绝：根分量 / 盘符前缀（Unix `/x`、Windows `/x` `C:/x` `C:x`、双斜杠 UNC
/// 等——注意 Windows 下 `/x` 的 `is_absolute()` 为 false，必须按组件判定）、
/// 任何 `..` 段、含冒号或 NUL 的输入。返回清洗后的相对路径（空串表示根）。
fn validate_rel_dir(rel_dir: &str) -> Result<PathBuf, TreeError> {
    let invalid = || TreeError::InvalidRelDir(rel_dir.to_string());
    if rel_dir.contains('\0') {
        return Err(invalid());
    }
    // 原始输入不得包含根/前缀/父目录等非普通分量（仅普通名与 `.` 允许）
    if Path::new(rel_dir)
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(invalid());
    }
    let mut rel = PathBuf::new();
    for comp in rel_dir.replace('\\', "/").split('/') {
        match comp {
            "" | "." => {}
            ".." => return Err(invalid()),
            _ if comp.contains(':') => return Err(invalid()),
            _ => rel.push(comp),
        }
    }
    // 兜底：拼出的路径不得包含根/前缀等非普通分量（防御 Windows 盘符相对路径注入）
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(invalid());
    }
    Ok(rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- 纯函数单元测试（文件系统行为见 tests/tree_probe.rs） ----------

    #[test]
    fn 默认过滤器取主计划阶段1默认值() {
        let f = TreeFilter::default();
        assert_eq!(
            f.visible_exts,
            vec![
                ".md",
                ".markdown",
                ".txt",
                ".json",
                ".yaml",
                ".yml",
                ".toml",
                ".ini",
                ".csv"
            ]
        );
        assert_eq!(
            f.excluded_dirs,
            vec![
                ".git",
                "node_modules",
                "target",
                ".venv",
                "dist",
                "build",
                ".cache"
            ]
        );
        assert!(!f.show_hidden);
    }

    #[test]
    fn 扩展名集合规范化_补点与小写() {
        let f = TreeFilter {
            visible_exts: vec!["MD".to_string(), ".Txt".to_string()],
            excluded_dirs: vec!["Node_Modules".to_string()],
            show_hidden: false,
        };
        let exts = normalized_ext_set(&f);
        assert!(exts.contains(".md"));
        assert!(exts.contains(".txt"));
        let dirs = normalized_dir_set(&f);
        assert!(dirs.contains("node_modules"));
    }

    #[test]
    fn 扩展名提取_取最后一个点() {
        assert_eq!(ext_of("a.md"), Some(".md"));
        assert_eq!(ext_of("a.tar.gz"), Some(".gz"));
        assert_eq!(ext_of("a."), Some("."));
        assert_eq!(ext_of("Makefile"), None);
        // 纯点前缀名（无后续点）视为无扩展名：不受白名单约束，仅受隐藏开关约束
        assert_eq!(ext_of(".env"), None);
        assert_eq!(ext_of(".md"), None);
        // 点前缀名带后续点仍按扩展名参与过滤
        assert_eq!(ext_of(".hidden-note.md"), Some(".md"));
    }

    #[test]
    fn 可见性判断_大小写不敏感且无扩展名不可见() {
        let f = TreeFilter::default();
        let exts = normalized_ext_set(&f);
        assert!(is_visible_file("note.md", &exts));
        assert!(is_visible_file("NOTE.MD", &exts));
        assert!(!is_visible_file("main.rs", &exts));
        assert!(!is_visible_file("LICENSE", &exts));
        // 纯点前缀名视为无扩展名并放行（实际能否展示由 show_hidden 前置把关）
        assert!(is_visible_file(".env", &exts));
        assert!(is_visible_file(".hidden-note.md", &exts));
    }

    #[test]
    fn 排除目录判断_大小写不敏感() {
        let f = TreeFilter::default();
        let dirs = normalized_dir_set(&f);
        assert!(is_excluded_dir("node_modules", &dirs));
        assert!(is_excluded_dir("Build", &dirs));
        assert!(!is_excluded_dir("build2", &dirs));
    }

    #[test]
    fn 隐藏名判断为点前缀() {
        assert!(is_hidden_name(".env"));
        assert!(is_hidden_name(".hidden/a".split('/').next().unwrap()));
        assert!(!is_hidden_name("a.md"));
    }

    #[test]
    fn rel_dir_校验_接受空串点段与冗余分隔符() {
        assert_eq!(validate_rel_dir("").unwrap(), PathBuf::new());
        assert_eq!(validate_rel_dir("docs").unwrap(), PathBuf::from("docs"));
        assert_eq!(
            validate_rel_dir("docs/./notes/").unwrap(),
            PathBuf::from("docs").join("notes")
        );
        // 反斜杠统一按分隔符处理（wire 约定 `/`，此处宽容输入）
        assert_eq!(
            validate_rel_dir("docs\\notes").unwrap(),
            PathBuf::from("docs").join("notes")
        );
    }

    #[test]
    fn rel_dir_校验_拒绝越界语义() {
        for bad in [
            "..",
            "a/..",
            "../x",
            "a/../../b",
            "/etc",
            "//server/share",
            "C:/x",
            "C:x",
        ] {
            assert!(
                matches!(validate_rel_dir(bad), Err(TreeError::InvalidRelDir(_))),
                "应拒绝：{bad}"
            );
        }
        assert!(matches!(
            validate_rel_dir("a\0b"),
            Err(TreeError::InvalidRelDir(_))
        ));
    }

    #[test]
    fn 错误显示为中文() {
        assert_eq!(
            TreeError::InvalidRelDir("../x".to_string()).to_string(),
            "非法的相对目录「../x」（不允许绝对路径、`..` 或盘符前缀）"
        );
        assert!(TreeError::NotFound(PathBuf::from("G:/x"))
            .to_string()
            .contains("目录不存在"));
    }
}
