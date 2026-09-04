//! 后台全文搜索核心（主实施计划阶段 4）。
//!
//! 职责：在项目根内做一次**同步的**递归全文搜索（后台线程由命令粘合层负责
//! 启动），逐命中回调、可取消、可截断。匹配、过滤、嗅探语义：
//!
//! - 文件范围复用树过滤语义（与 `tree.rs` 的默认值保持同步）：默认可见扩展名、
//!   默认排除目录、跳过隐藏文件/隐藏目录；**搜索不跟踪任何符号链接**（防越出
//!   可信项目根与环路，树中显示的 SymLinkFile 不参与搜索）；
//! - `include_globs` / `exclude_globs` 为补充过滤：exclude 命中目录即剪枝整棵
//!   子树、命中文件即跳过（exclude 优先于 include）；include 非空时文件必须
//!   命中其一（只做收窄，不能扩大扩展名白名单）；
//! - 二进制嗅探：文件前 8 KB 含 NUL 字节即跳过（UTF-16 等编码文件因此被跳过，
//!   阶段 4 范围仅 UTF-8/BOM）；超过 `max_file_bytes` 的文件跳过；
//! - 达到 `max_results` 后置 `truncated` 并停止；`cancel` 在每次进入下一文件
//!   前检查，命中后置 `cancelled` 并正常返回（不视为错误）；
//! - `use_regex = true` 返回 [`SearchError::UnsupportedFeature`]——regex 引擎
//!   是否引入由主 Agent 在阶段 4 集成时裁决，本模块不引入新依赖。
//!
//! 匹配语义（字面量）：按 UTF-8 字节匹配；大小写不敏感为 ASCII 折叠（非 ASCII
//! 字符按精确比较，如 `İ`/`ß` 的 Unicode 折叠不支持）；全词边界的"词字符"仅为
//! `[A-Za-z0-9_]`（与 JS `\b` 一致：中日韩等非 ASCII 字符视为非词字符，因此
//! 全词搜索中文可命中）；文件头 UTF-8 BOM 在匹配前剥离，行列计数不受影响。
//!
//! glob 子集（手写，不引入依赖）：`*`（不跨 `/`）、`**`（独立路径段，跨段含零段）、
//! `?`（单字符）、`{a,b}`（一层的花括号展开，不支持嵌套）；不含 `/` 的模式按
//! 文件名（basename）匹配，含 `/` 的按相对路径匹配；匹配对 ASCII 大小写不敏感；
//! 非法模式（未闭合/嵌套花括号、展开数量超限）返回错误而非 panic。
//!
//! 可测性约定：本模块自包含，仅依赖 std 与 serde（derive），不引用 `crate::`
//! 任何路径；分支内测试载体为 `tests/search_probe.rs`（`#[path]` 引入本文件）。
//! 集成时由主 Agent 在 `src/workspace/mod.rs` 声明 `pub mod search;`。
//!
//! 契约唯一事实源：`docs/dev/contracts/tree-search.md`。

use std::borrow::Cow;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

/// 默认单文件大小上限：5 MB（主计划阶段 4）。
pub const DEFAULT_MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// 默认结果数上限。
pub const DEFAULT_MAX_RESULTS: usize = 10_000;

/// 二进制嗅探窗口：文件前 8 KB 含 NUL 即判定为二进制。
pub const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// 行文本截断上限（字符数）；命中列保持在截断窗口内（见 [`clamp_line_text`]）。
const MAX_LINE_TEXT_CHARS: usize = 500;

/// 截断窗口内命中列之前保留的上下文字符数。
const MATCH_CONTEXT_CHARS: usize = 200;

/// 花括号展开数量上限（超过即视为非法模式）。
const MAX_GLOB_EXPANSIONS: usize = 64;

/// 搜索选项。
///
/// `Default` 即产品默认值；wire 反序列化（serde）时缺省字段回落到 `Default`
/// （粘合层可只传 `query` 与需要覆盖的开关）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SearchOptions {
    /// 搜索关键词（字面量；可为任意 UTF-8 文本）。为空返回 [`SearchError::EmptyQuery`]。
    pub query: String,
    /// 大小写敏感（默认 false：ASCII 折叠匹配）。
    pub case_sensitive: bool,
    /// 全词匹配（词字符为 `[A-Za-z0-9_]`，非 ASCII 视为边界）。
    pub whole_word: bool,
    /// 正则开关：true 时返回 [`SearchError::UnsupportedFeature`]（regex 引擎待集成）。
    pub use_regex: bool,
    /// 包含 glob（相对路径/文件名；非空时文件必须命中其一）。
    pub include_globs: Vec<String>,
    /// 排除 glob（命中目录剪枝、命中文件跳过；优先于 include）。
    pub exclude_globs: Vec<String>,
    /// 单文件大小上限（字节；超过跳过）。
    pub max_file_bytes: u64,
    /// 命中数上限（达到后置 `truncated` 停止；0 表示不扫描直接返回截断）。
    pub max_results: usize,
}

impl Default for SearchOptions {
    fn default() -> Self {
        SearchOptions {
            query: String::new(),
            case_sensitive: false,
            whole_word: false,
            use_regex: false,
            include_globs: Vec::new(),
            exclude_globs: Vec::new(),
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            max_results: DEFAULT_MAX_RESULTS,
        }
    }
}

/// 单条搜索命中。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchHit {
    /// 相对项目根的路径，`/` 分隔。
    pub rel_path: String,
    /// 行号（1 起）。
    pub line: u32,
    /// 列号（1 起，按 Unicode 字符计数；无效字节按替换符计 1）。
    pub col: u32,
    /// 命中所在行文本（不含行尾符；超长行截断到 ≤ [`MAX_LINE_TEXT_CHARS`]
    /// 字符并夹带省略号，命中列保持在窗口内）。
    pub line_text: String,
}

/// 搜索汇总。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchSummary {
    /// 实际读入并扫描的文本文件数（二进制/超大/不可读/被过滤的不计入）。
    pub files_scanned: usize,
    /// 命中总数（等于 on_hit 回调次数）。
    pub hits: usize,
    /// 是否因达到 `max_results` 而提前截断。
    pub truncated: bool,
    /// 是否因 cancel 而中止。
    pub cancelled: bool,
}

/// 非法 glob 模式错误（含模式文本与原因）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobError {
    /// 原始模式文本。
    pub pattern: String,
    /// 非法原因（中文，面向用户）。
    pub reason: String,
}

impl std::fmt::Display for GlobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "模式「{}」{}（{}）",
            self.pattern, self.reason, "仅支持 * ** ? {a,b}"
        )
    }
}

/// 搜索错误。
#[derive(Debug)]
pub enum SearchError {
    /// 查询关键词为空。
    EmptyQuery,
    /// 功能未支持（当前仅 regex：引擎是否引入由主 Agent 阶段 4 集成时裁决）。
    UnsupportedFeature(&'static str),
    /// 非法 glob 模式（未闭合/嵌套花括号、展开数量超限）。
    InvalidGlob(GlobError),
    /// 搜索根不存在或不是目录。
    RootNotFound(PathBuf),
    /// 底层 I/O 错误（根目录读取失败等；子目录/文件级错误一律跳过不报）。
    /// 当前核心实现内不构造（子级错误被吞掉降级为跳过），供粘合层与未来
    /// 实现演进保留；无构造点的构建阶段允许 dead_code。
    #[allow(dead_code)]
    Io(std::io::Error),
}

impl std::fmt::Display for SearchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SearchError::EmptyQuery => write!(f, "搜索关键词为空"),
            SearchError::UnsupportedFeature(what) => write!(f, "暂不支持的搜索特性：{what}"),
            SearchError::InvalidGlob(e) => write!(f, "搜索过滤模式非法：{e}"),
            SearchError::RootNotFound(p) => {
                write!(f, "搜索根目录不存在或不是目录：{}", p.display())
            }
            SearchError::Io(e) => write!(f, "搜索过程中发生 I/O 错误：{e}"),
        }
    }
}

impl std::error::Error for SearchError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SearchError::Io(e) => Some(e),
            _ => None,
        }
    }
}

/// 执行一次同步全文搜索（后台线程由粘合层负责）。
///
/// - `on_hit` 逐命中回调（按遍历顺序：目录内文件名升序、深度优先）；
/// - 返回 [`SearchSummary`]；取消与截断都属于正常返回（`Ok`）。
pub fn search(
    root: &Path,
    opts: &SearchOptions,
    cancel: &AtomicBool,
    on_hit: &mut dyn FnMut(SearchHit),
) -> Result<SearchSummary, SearchError> {
    if opts.use_regex {
        return Err(SearchError::UnsupportedFeature("regex 引擎待集成"));
    }
    if opts.query.is_empty() {
        return Err(SearchError::EmptyQuery);
    }
    if !root.is_dir() {
        return Err(SearchError::RootNotFound(root.to_path_buf()));
    }
    if opts.max_results == 0 {
        return Ok(SearchSummary {
            files_scanned: 0,
            hits: 0,
            truncated: true,
            cancelled: false,
        });
    }

    let includes = compile_globs(&opts.include_globs)?;
    let excludes = compile_globs(&opts.exclude_globs)?;

    // 与 tree.rs 的默认过滤语义保持同步（两模块自包含，常量各持一份，改动需同步）
    let visible_exts: HashSet<String> = super_default_exts();
    let excluded_dirs: HashSet<String> = super_default_dirs();

    let needle: Vec<u8> = if opts.case_sensitive {
        opts.query.as_bytes().to_vec()
    } else {
        opts.query.as_bytes().to_ascii_lowercase()
    };

    let mut summary = SearchSummary {
        files_scanned: 0,
        hits: 0,
        truncated: false,
        cancelled: false,
    };
    // 显式栈深度优先（防超深目录爆栈）；子目录逆序入栈保证兄弟目录升序访问
    let mut stack: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];

    'outer: while let Some((abs_dir, rel_dir)) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            summary.cancelled = true;
            break 'outer;
        }
        let Ok(read_dir) = fs::read_dir(&abs_dir) else {
            continue; // 不可读目录跳过
        };
        let mut items: Vec<(String, PathBuf, bool)> = Vec::new();
        for entry in read_dir.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue; // 搜索不跟踪任何符号链接（防越界与环路）
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            items.push((name, entry.path(), ft.is_dir()));
        }
        items.sort_by(|a, b| {
            a.0.to_lowercase()
                .cmp(&b.0.to_lowercase())
                .then_with(|| a.0.cmp(&b.0))
        });

        let mut subdirs: Vec<(PathBuf, String)> = Vec::new();
        for (name, path, is_dir) in items {
            if cancel.load(Ordering::Relaxed) {
                summary.cancelled = true;
                break 'outer;
            }
            let child_rel = if rel_dir.is_empty() {
                name.clone()
            } else {
                format!("{rel_dir}/{name}")
            };
            if is_dir {
                if is_hidden_name(&name) || excluded_dirs.contains(&name.to_ascii_lowercase()) {
                    continue;
                }
                if excludes.iter().any(|g| g.is_match(&child_rel)) {
                    continue; // 命中排除 glob 的目录整棵剪枝
                }
                subdirs.push((path, child_rel));
                continue;
            }
            // ---- 文件管线：隐藏/扩展名/glob 过滤 → 大小上限 → 读入 → 嗅探 → 匹配 ----
            if is_hidden_name(&name) {
                continue;
            }
            if !is_visible_ext(&name, &visible_exts) {
                continue;
            }
            if excludes.iter().any(|g| g.is_match(&child_rel)) {
                continue;
            }
            if !includes.is_empty() && !includes.iter().any(|g| g.is_match(&child_rel)) {
                continue;
            }
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            if meta.len() > opts.max_file_bytes {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else { continue };
            let sniff_end = bytes.len().min(BINARY_SNIFF_BYTES);
            if bytes[..sniff_end].contains(&0) {
                continue; // 二进制文件
            }
            summary.files_scanned += 1;
            for hit in collect_hits(
                &bytes,
                &needle,
                !opts.case_sensitive,
                opts.whole_word,
                &child_rel,
            ) {
                on_hit(hit);
                summary.hits += 1;
                if summary.hits >= opts.max_results {
                    summary.truncated = true;
                    break 'outer;
                }
            }
        }
        for d in subdirs.into_iter().rev() {
            stack.push(d);
        }
    }
    Ok(summary)
}

/// 与 `tree.rs` 同步的默认可见扩展名集合（小写、含前导点）。
fn super_default_exts() -> HashSet<String> {
    [
        ".md",
        ".markdown",
        ".txt",
        ".json",
        ".yaml",
        ".yml",
        ".toml",
        ".ini",
        ".csv",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// 与 `tree.rs` 同步的默认排除目录集合（小写）。
fn super_default_dirs() -> HashSet<String> {
    [
        ".git",
        "node_modules",
        "target",
        ".venv",
        "dist",
        "build",
        ".cache",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

/// 文件名是否通过扩展名白名单（不区分大小写；无扩展名不可见）。
fn is_visible_ext(name: &str, visible_exts: &HashSet<String>) -> bool {
    match name.rfind('.') {
        Some(dot) => visible_exts.contains(&name[dot..].to_ascii_lowercase()),
        None => false,
    }
}

/// 剥离文件头 UTF-8 BOM（若有）。
fn strip_bom(bytes: &[u8]) -> &[u8] {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        bytes
    }
}

/// 首字节跳过的朴素字节查找（needle 非空，由调用方保证）。
fn find_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
    debug_assert!(!needle.is_empty());
    let first = needle[0];
    let last_start = hay.len().checked_sub(needle.len())?;
    let mut i = 0usize;
    while i <= last_start {
        if hay[i] == first && &hay[i..i + needle.len()] == needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// 词字符：仅 `[A-Za-z0-9_]`（与 JS `\b` 一致，非 ASCII 视为边界）。
fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// 全词边界判断：匹配两侧必须都不是词字符（行首/行尾视为边界）。
fn word_bounded(hay: &[u8], start: usize, len: usize) -> bool {
    let before_ok = start == 0 || !is_word_byte(hay[start - 1]);
    let end = start + len;
    let after_ok = end >= hay.len() || !is_word_byte(hay[end]);
    before_ok && after_ok
}

/// 在单个文件缓冲中收集全部命中（行号增量推进，单文件总计 O(文件大小)）。
///
/// 文件头 UTF-8 BOM 在此剥离，行列计数不受影响。`fold_hay` = true 时对缓冲做
/// ASCII 小写折叠后再查找（大小写不敏感模式，needle 已由调用方预折叠）；
/// 行文本始终取自原始字节。
fn collect_hits(
    payload: &[u8],
    needle: &[u8],
    fold_hay: bool,
    whole_word: bool,
    rel_path: &str,
) -> Vec<SearchHit> {
    let payload = strip_bom(payload);
    // ASCII 折叠按字节 1:1 进行，不改变偏移与字符边界，行列计数不受影响
    let hay: Cow<'_, [u8]> = if fold_hay {
        Cow::Owned(payload.to_ascii_lowercase())
    } else {
        Cow::Borrowed(payload)
    };
    let mut hits = Vec::new();
    let mut pos = 0usize;
    // 行号增量追踪：(已定位的行首偏移, 该行行号)；命中按字节序升序出现
    let (mut last_line_start, mut last_line_no) = (0usize, 1u64);

    while let Some(off) = find_bytes(&hay[pos..], needle) {
        let m = pos + off;
        if whole_word && !word_bounded(&hay, m, needle.len()) {
            pos = m + 1;
            continue;
        }
        let line_start = hay[..m]
            .iter()
            .rposition(|&b| b == b'\n')
            .map_or(0, |i| i + 1);
        let line_end_raw = hay[m..]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(hay.len(), |i| m + i);
        let mut line_end = line_end_raw;
        if line_end > line_start && hay[line_end - 1] == b'\r' {
            line_end -= 1; // 行文本不含 CRLF 的 \r
        }
        let line_no: u64 = if line_start >= last_line_start {
            last_line_no
                + hay[last_line_start..line_start]
                    .iter()
                    .filter(|&&b| b == b'\n')
                    .count() as u64
        } else {
            1 + hay[..line_start].iter().filter(|&&b| b == b'\n').count() as u64
        };
        last_line_start = line_start;
        last_line_no = line_no;

        // 列按 Unicode 字符计数：对前缀做有损解码后数字符（无效字节计 1）；
        // ASCII 折叠保持字节 1:1，在折叠后的 hay 上计数与原文一致
        let col = String::from_utf8_lossy(&hay[line_start..m]).chars().count() + 1;

        let text = String::from_utf8_lossy(&payload[line_start..line_end]).into_owned();
        let line_text = clamp_line_text(text, col);

        hits.push(SearchHit {
            rel_path: rel_path.to_string(),
            line: u32::try_from(line_no).unwrap_or(u32::MAX),
            col: col_u32(col),
            line_text,
        });
        pos = m + needle.len();
    }
    hits
}

/// 超长行截断：保留命中附近窗口（命中列约在窗口第 [`MATCH_CONTEXT_CHARS`]+1
/// 字符处），两端视需要补省略号；总字符数 ≤ [`MAX_LINE_TEXT_CHARS`] + 2。
fn clamp_line_text(text: String, match_col: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= MAX_LINE_TEXT_CHARS {
        return text;
    }
    let match_idx = match_col.saturating_sub(1).min(chars.len() - 1);
    let start = match_idx.saturating_sub(MATCH_CONTEXT_CHARS);
    let end = (start + MAX_LINE_TEXT_CHARS).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(chars[start..end].iter());
    if end < chars.len() {
        out.push('…');
    }
    out
}

// ---------- glob 子集匹配器 ----------

/// 编译后的 glob 模式（见模块头：`*` `**` `?` `{a,b}` 子集；ASCII 大小写不敏感）。
#[derive(Debug, Clone)]
pub struct Glob {
    /// 花括号展开后的全部候选模式。
    alternatives: Vec<GlobPattern>,
}

#[derive(Debug, Clone)]
struct GlobPattern {
    /// `/` 分隔的路径段；`**` 独立段为 [`Comp::DoubleStar`]。
    comps: Vec<Comp>,
    /// 模式不含 `/`：按文件名（basename）匹配。
    basename: bool,
}

#[derive(Debug, Clone)]
enum Comp {
    /// `**`：匹配零个或多个路径段。
    DoubleStar,
    /// 单个路径段内的 token 序列。
    Seg(Vec<PatTok>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PatTok {
    /// 字面字符（编译期已 ASCII 小写化）。
    Lit(char),
    /// `?`：任意单字符。
    AnyOne,
    /// `*`（段内 `**` 亦折叠为它）：任意字符序列（不含 `/`）。
    AnyRun,
}

/// 编译 glob 模式；非法模式（未闭合/嵌套花括号、展开数量超限）返回 [`GlobError`]。
pub fn compile_glob(pattern: &str) -> Result<Glob, GlobError> {
    let expanded = brace_expand(pattern)?;
    if expanded.len() > MAX_GLOB_EXPANSIONS {
        return Err(GlobError {
            pattern: pattern.to_string(),
            reason: format!("花括号展开数量超过上限（{MAX_GLOB_EXPANSIONS}）"),
        });
    }
    let mut alternatives = Vec::with_capacity(expanded.len());
    for p in expanded {
        let mut p = p.strip_prefix("./").unwrap_or(&p).to_string();
        while p.ends_with('/') {
            p.pop();
        }
        let basename = !p.contains('/');
        let comps: Vec<Comp> = p
            .split('/')
            .filter(|c| !c.is_empty())
            .map(compile_comp)
            .collect();
        alternatives.push(GlobPattern { comps, basename });
    }
    Ok(Glob { alternatives })
}

impl Glob {
    /// 判断相对路径（`/` 分隔）是否命中；不含 `/` 的模式按文件名匹配。
    pub fn is_match(&self, rel_path: &str) -> bool {
        let text_comps: Vec<Vec<char>> = rel_path
            .split('/')
            .filter(|c| !c.is_empty())
            .map(|c| c.chars().map(|ch| ch.to_ascii_lowercase()).collect())
            .collect();
        self.alternatives.iter().any(|p| {
            if p.basename {
                let name = rel_path.rsplit('/').next().unwrap_or(rel_path);
                let name_chars: Vec<char> =
                    name.chars().map(|ch| ch.to_ascii_lowercase()).collect();
                match_comps(&p.comps, std::slice::from_ref(&name_chars))
            } else {
                match_comps(&p.comps, &text_comps)
            }
        })
    }
}

/// 单个路径段编译：`**` 独立段 → DoubleStar；`*` 折叠为 AnyRun；`?` → AnyOne。
fn compile_comp(comp: &str) -> Comp {
    if comp == "**" {
        return Comp::DoubleStar;
    }
    let mut toks: Vec<PatTok> = Vec::new();
    for c in comp.chars() {
        match c {
            '*' => {
                if !matches!(toks.last(), Some(PatTok::AnyRun)) {
                    toks.push(PatTok::AnyRun);
                }
            }
            '?' => toks.push(PatTok::AnyOne),
            other => toks.push(PatTok::Lit(other.to_ascii_lowercase())),
        }
    }
    Comp::Seg(toks)
}

/// 一层花括号展开（不支持嵌套；未闭合报错）。空候选允许（展开为空串）。
fn brace_expand(pattern: &str) -> Result<Vec<String>, GlobError> {
    let err = |reason: &str| {
        Err(GlobError {
            pattern: pattern.to_string(),
            reason: reason.to_string(),
        })
    };
    let Some(open) = pattern.find('{') else {
        return Ok(vec![pattern.to_string()]);
    };
    let rest = &pattern[open + 1..];
    match rest.find(['{', '}']) {
        None => err("花括号未闭合"),
        Some(i) if rest[i..].starts_with('{') => err("不支持嵌套的花括号"),
        Some(close) => {
            let alts: Vec<&str> = rest[..close].split(',').collect();
            let prefix = &pattern[..open];
            let suffix = &rest[close + 1..];
            let tails = brace_expand(suffix)?;
            let mut out = Vec::with_capacity(alts.len() * tails.len());
            for a in alts {
                for t in &tails {
                    out.push(format!("{prefix}{a}{t}"));
                }
            }
            Ok(out)
        }
    }
}

/// 段序列匹配（`**` 允许吞零段或多段；其余段一一对应）。
fn match_comps(pat: &[Comp], txt: &[Vec<char>]) -> bool {
    match pat.split_first() {
        None => txt.is_empty(),
        Some((Comp::DoubleStar, rest)) => {
            (0..=txt.len()).any(|skip| match_comps(rest, &txt[skip..]))
        }
        Some((Comp::Seg(toks), rest)) => {
            !txt.is_empty() && match_seg(toks, &txt[0]) && match_comps(rest, &txt[1..])
        }
    }
}

/// 单段匹配：经典星号回溯算法（`?` 单字符、`*` 任意序列）。
fn match_seg(toks: &[PatTok], txt: &[char]) -> bool {
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star_pi: Option<usize> = None;
    let mut star_ti = 0usize;
    while ti < txt.len() {
        if pi < toks.len() {
            match &toks[pi] {
                PatTok::AnyOne => {
                    pi += 1;
                    ti += 1;
                    continue;
                }
                PatTok::Lit(c) if *c == txt[ti] => {
                    pi += 1;
                    ti += 1;
                    continue;
                }
                PatTok::AnyRun => {
                    star_pi = Some(pi);
                    star_ti = ti;
                    pi += 1;
                    continue;
                }
                _ => {}
            }
        }
        match star_pi {
            Some(sp) => {
                pi = sp + 1;
                star_ti += 1;
                ti = star_ti;
            }
            None => return false,
        }
    }
    while pi < toks.len() && matches!(toks[pi], PatTok::AnyRun) {
        pi += 1;
    }
    pi == toks.len()
}

/// 批量编译 glob 模式（任一非法即整体失败，携带该模式信息）。
fn compile_globs(patterns: &[String]) -> Result<Vec<Glob>, SearchError> {
    patterns
        .iter()
        .map(|p| compile_glob(p).map_err(SearchError::InvalidGlob))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(pattern: &str, path: &str) -> bool {
        compile_glob(pattern).expect("模式应合法").is_match(path)
    }

    fn bad(pattern: &str) -> GlobError {
        compile_glob(pattern).expect_err("模式应非法")
    }

    #[test]
    fn 星号不跨路径段() {
        assert!(m("docs/*.md", "docs/a.md"));
        assert!(!m("docs/*.md", "docs/sub/a.md"));
        assert!(!m("docs/*.md", "other/a.md"));
    }

    #[test]
    fn 双星号跨段且可吞零段() {
        assert!(m("**/a.md", "a.md"));
        assert!(m("**/a.md", "x/y/a.md"));
        assert!(m("docs/**/*.md", "docs/a.md"));
        assert!(m("docs/**/*.md", "docs/x/y/a.md"));
        assert!(!m("docs/**/*.md", "other/a.md"));
        assert!(m("**", "任何/路径/文件.txt"));
    }

    #[test]
    fn 问号恰配单字符() {
        assert!(m("a?c.md", "abc.md"));
        assert!(!m("a?c.md", "ac.md"));
        assert!(!m("a?c.md", "abbc.md"));
    }

    #[test]
    fn 花括号展开候选() {
        assert!(m("x.{md,txt}", "x.md"));
        assert!(m("x.{md,txt}", "x.txt"));
        assert!(!m("x.{md,txt}", "x.rst"));
        assert!(m("{a,b}/c.md", "b/c.md"));
        assert!(m("n{,1}.md", "n.md")); // 空候选
    }

    #[test]
    fn 无斜杠模式按文件名匹配() {
        assert!(m("*.md", "docs/deep/a.md"));
        assert!(m("node_modules", "a/node_modules"));
        assert!(!m("*.md", "docs/a.md.txt"));
        assert!(!m("node_modules", "a/node_modules2"));
    }

    #[test]
    fn glob_匹配_ascii_大小写不敏感() {
        assert!(m("*.MD", "a.md"));
        assert!(m("README.md", "readme.md"));
        assert!(m("Docs/**/*.MD", "DOCS/x/a.md"));
    }

    #[test]
    fn 非法_glob_报错而不_panic() {
        assert_eq!(bad("{a,b").reason, "花括号未闭合");
        assert_eq!(bad("{a,{b,c}}").reason, "不支持嵌套的花括号");
        // 单个右花括号按字面量处理（合法）
        assert!(m("x}y.md", "x}y.md"));
        // 展开数量超限：7 组 {1,2} = 128 > 64
        let e = bad("{1,2}{1,2}{1,2}{1,2}{1,2}{1,2}{1,2}");
        assert!(e.reason.contains("上限"));
    }

    #[test]
    fn 段内双星折叠为单星语义() {
        assert!(m("a**b", "aXXb"));
        assert!(!m("a**b", "aXXb/c"));
    }

    #[test]
    fn 字面量行列与行文本提取() {
        let buf = b"first line\nsecond needle line\nthird";
        let hits = collect_hits(buf, b"needle", false, false, "a.md");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);
        assert_eq!(hits[0].col, 8);
        assert_eq!(hits[0].line_text, "second needle line");
        assert_eq!(hits[0].rel_path, "a.md");
    }

    #[test]
    fn 行文本剔除_crlf_回车符() {
        let buf = b"l1\r\nmatch me\r\nl3";
        let hits = collect_hits(buf, b"match", false, false, "a.md");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);
        assert_eq!(hits[0].col, 1);
        assert_eq!(hits[0].line_text, "match me");
    }

    #[test]
    fn 同行多命中分别给列() {
        let buf = b"a cat cat cat";
        let hits = collect_hits(buf, b"cat", false, false, "a.md");
        assert_eq!(
            hits.iter().map(|h| h.col).collect::<Vec<_>>(),
            vec![3, 7, 11]
        );
        assert!(hits.iter().all(|h| h.line == 1));
    }

    #[test]
    fn bom_剥离后列号不受影响() {
        let buf: &[u8] = b"\xEF\xBB\xBFabc needle";
        let hits = collect_hits(buf, b"needle", false, false, "a.md");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].col, 5); // a b c 空格 之后
        assert_eq!(hits[0].line, 1);
    }

    #[test]
    fn 全词边界判断() {
        let buf = b"catalog cat category end-cat";
        let hits = collect_hits(buf, b"cat", false, true, "a.md");
        // " cat "（第 9 列）与 "end-cat" 连字符后（第 26 列）是整词；
        // catalog/category 内部不命中（连字符不是词字符）
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].col, 9);
        assert_eq!(hits[1].col, 26);
        // 词在行尾也是边界
        let hits2 = collect_hits(b"the cat", b"cat", false, true, "a.md");
        assert_eq!(hits2.len(), 1);
        assert_eq!(hits2[0].col, 5);
    }

    #[test]
    fn 非_ascii_视为非词字符_全词搜索中文可命中() {
        let hits = collect_hits(
            "这是中文的例子".as_bytes(),
            "中文".as_bytes(),
            false,
            true,
            "a.md",
        );
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].col, 3);
    }

    #[test]
    fn 大小写折叠查找() {
        let buf = b"Todo todo TODO";
        // 大小写不敏感：hay 与 needle 均折叠后逐字节比较
        let ci = collect_hits(buf, b"todo", true, false, "a.md");
        assert_eq!(ci.len(), 3);
        // 大小写敏感：精确字节匹配，仅命中首处的 "Todo"
        let cs = collect_hits(buf, b"Todo", false, false, "a.md");
        assert_eq!(cs.len(), 1);
        assert_eq!(cs[0].col, 1);
    }

    #[test]
    fn 超长行截断保留命中窗口() {
        let mut buf = vec![b'x'; 600];
        buf.extend_from_slice(b"needle");
        let hits = collect_hits(&buf, b"needle", false, false, "a.md");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].col, 601);
        let chars = hits[0].line_text.chars().count();
        assert!(chars <= MAX_LINE_TEXT_CHARS + 2, "实际 {chars} 字符");
        assert!(hits[0].line_text.starts_with('…'));
        assert!(hits[0].line_text.contains("needle"));
    }

    #[test]
    fn find_bytes_与_word_bounded_基本语义() {
        assert_eq!(find_bytes(b"hello", b"ll"), Some(2));
        assert_eq!(find_bytes(b"hello", b"loo"), None);
        assert_eq!(find_bytes(b"ab", b"abc"), None);
        assert!(word_bounded(b" cat ", 1, 3));
        assert!(!word_bounded(b" catalog", 1, 3));
        assert!(word_bounded(b"cat", 0, 3));
    }
}

/// u32 列号换算的小工具（保持独立便于阅读）。
fn col_u32(col: usize) -> u32 {
    u32::try_from(col).unwrap_or(u32::MAX)
}
