//! search 模块的对外集成测试（`tests/platform_probe.rs` 同款探针模式）。
//!
//! 用 `#[path]` 直接引入 `src/workspace/search.rs`，作为该分支上可独立运行的
//! 测试载体；文件长期保留，充当搜索能力的对外行为契约。文件系统操作全部在
//! `std::env::temp_dir` 下的临时目录进行。
//!
//! 覆盖：字面量行列、大小写开关、全词边界（含中文）、glob 包含/排除（目录剪枝
//! 与 basename 规则）、树默认过滤语义复用、二进制嗅探、超大文件跳过、结果截断、
//! 取消、非法 glob 不 panic、regex 未支持、wire 序列化形状，以及 10k 文件树
//! 搜索性能实测（`--ignored`，数据记录于 `docs/dev/contracts/tree-search.md`）。

#[path = "../src/workspace/search.rs"]
mod search;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use search::{
    search, SearchError, SearchHit, SearchOptions, BINARY_SNIFF_BYTES, DEFAULT_MAX_FILE_BYTES,
    DEFAULT_MAX_RESULTS,
};

/// 测试临时目录计数器（进程内唯一，避免并行测试互相覆盖）。
static TEMP_SEQ: AtomicUsize = AtomicUsize::new(0);

fn temp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "glancemd-ultra-search-{}-{}-{}",
        std::process::id(),
        tag,
        TEMP_SEQ.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn cleanup(dir: &Path) {
    let _ = fs::remove_dir_all(dir);
}

fn write(root: &Path, rel: &str, content: &str) {
    write_bytes(root, rel, content.as_bytes());
}

fn write_bytes(root: &Path, rel: &str, bytes: &[u8]) {
    let p = root.join(rel);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(p, bytes).unwrap();
}

/// 以默认取消标志运行搜索并收集全部命中。
fn run(root: &Path, opts: &SearchOptions) -> (Vec<SearchHit>, search::SearchSummary) {
    let cancel = AtomicBool::new(false);
    let mut hits = Vec::new();
    let summary = search(root, opts, &cancel, &mut |h| hits.push(h)).unwrap();
    (hits, summary)
}

fn opts(query: &str) -> SearchOptions {
    SearchOptions {
        query: query.to_string(),
        ..SearchOptions::default()
    }
}

// ---------- 字面量命中：行列与行文本 ----------

#[test]
fn 字面量命中_相对路径行列与行文本() {
    let dir = temp_root("literal");
    write(&dir, "notes/a.md", "first line\nsecond 搜索 line\nthird");
    let (hits, summary) = run(&dir, &opts("搜索"));
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].rel_path, "notes/a.md");
    assert_eq!(hits[0].line, 2);
    // s-e-c-o-n-d-空格 共 7 个字符，"搜索" 从第 8 个字符开始
    assert_eq!(hits[0].col, 8);
    assert_eq!(hits[0].line_text, "second 搜索 line");
    assert_eq!(summary.hits, 1);
    assert_eq!(summary.files_scanned, 1);
    assert!(!summary.truncated);
    assert!(!summary.cancelled);
    cleanup(&dir);
}

#[test]
fn crlf_文件的行文本不含_carriage() {
    let dir = temp_root("crlf");
    write(&dir, "win.md", "l1\r\nmatch me\r\nl3");
    let (hits, _) = run(&dir, &opts("match"));
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].line, 2);
    assert_eq!(hits[0].col, 1);
    assert_eq!(hits[0].line_text, "match me");
    cleanup(&dir);
}

#[test]
fn utf8_bom_不影响首行列号() {
    let dir = temp_root("bom");
    write_bytes(&dir, "bom.md", b"\xEF\xBB\xBFabc needle");
    let (hits, _) = run(&dir, &opts("needle"));
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].line, 1);
    assert_eq!(hits[0].col, 5);
    cleanup(&dir);
}

// ---------- 大小写与全词 ----------

#[test]
fn 大小写敏感开关() {
    let dir = temp_root("case");
    write(&dir, "case.md", "Todo todo TODO");
    let (ci, _) = run(&dir, &opts("todo"));
    assert_eq!(ci.len(), 3);
    // 大小写敏感：needle 按精确字节匹配，只命中小写的 "todo"（第 6 列）
    let sensitive = SearchOptions {
        case_sensitive: true,
        ..opts("todo")
    };
    let (cs, _) = run(&dir, &sensitive);
    assert_eq!(cs.len(), 1);
    assert_eq!(cs[0].col, 6);
    let (exact, _) = run(
        &dir,
        &SearchOptions {
            case_sensitive: true,
            ..opts("Todo")
        },
    );
    assert_eq!(exact.len(), 1);
    assert_eq!(exact[0].col, 1);
    cleanup(&dir);
}

#[test]
fn 全词边界_英文() {
    let dir = temp_root("word");
    write(&dir, "w.md", "catalog cat category end-cat\nthe cat");
    let word = SearchOptions {
        whole_word: true,
        ..opts("cat")
    };
    let (hits, _) = run(&dir, &word);
    // 整词命中：" cat "（1 行 9 列）、"end-cat" 连字符后（1 行 26 列）、
    // 行尾 "cat"（2 行 5 列）；catalog/category 内部不命中
    assert_eq!(hits.len(), 3);
    assert_eq!((hits[0].line, hits[0].col), (1, 9));
    assert_eq!((hits[1].line, hits[1].col), (1, 26));
    assert_eq!((hits[2].line, hits[2].col), (2, 5));
    cleanup(&dir);
}

#[test]
fn 全词边界_非_ascii_视为边界_中文可整词命中() {
    let dir = temp_root("word-cjk");
    write(&dir, "cjk.md", "这是中文的例子，中文出现两次：中文。");
    let word = SearchOptions {
        whole_word: true,
        ..opts("中文")
    };
    let (hits, _) = run(&dir, &word);
    assert_eq!(hits.len(), 3); // 前后均为非词字符（CJK 与标点）
    assert_eq!(hits[0].col, 3);
    cleanup(&dir);
}

// ---------- glob 包含 / 排除 ----------

#[test]
fn glob_包含收窄与排除剪枝() {
    let dir = temp_root("glob");
    for rel in ["docs/a.md", "docs/notes/b.md", "drafts/c.md", "top.md"] {
        write(&dir, rel, "needle");
    }

    // include：含 `/` 的模式按相对路径匹配
    let inc = SearchOptions {
        include_globs: vec!["docs/**".to_string()],
        ..opts("needle")
    };
    let (hits, _) = run(&dir, &inc);
    assert_eq!(hits.len(), 2);
    assert!(hits.iter().all(|h| h.rel_path.starts_with("docs/")));

    // include：不含 `/` 的模式按文件名匹配（任意层级）
    let inc_name = SearchOptions {
        include_globs: vec!["*.md".to_string()],
        ..opts("needle")
    };
    let (hits, _) = run(&dir, &inc_name);
    assert_eq!(hits.len(), 4);

    // exclude：basename 模式命中目录即整棵剪枝
    let exc = SearchOptions {
        exclude_globs: vec!["drafts".to_string()],
        ..opts("needle")
    };
    let (hits, _) = run(&dir, &exc);
    assert_eq!(hits.len(), 3);

    // exclude：`**/drafts/**` 同样把 drafts 目录剪掉
    let exc2 = SearchOptions {
        exclude_globs: vec!["**/drafts/**".to_string()],
        ..opts("needle")
    };
    let (hits, _) = run(&dir, &exc2);
    assert_eq!(hits.len(), 3);

    // exclude 优先于 include
    let both = SearchOptions {
        include_globs: vec!["docs/**".to_string()],
        exclude_globs: vec!["**/notes/**".to_string()],
        ..opts("needle")
    };
    let (hits, _) = run(&dir, &both);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].rel_path, "docs/a.md");
    cleanup(&dir);
}

#[test]
fn 复用树的默认过滤语义_排除目录与隐藏文件不搜索() {
    let dir = temp_root("tree-filter");
    write(&dir, "node_modules/pkg.md", "needle");
    write(&dir, ".git/config.md", "needle");
    write(&dir, ".hidden-dir/inner.md", "needle");
    write(&dir, ".env", "needle");
    write(&dir, "normal.md", "needle");
    let (hits, summary) = run(&dir, &opts("needle"));
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].rel_path, "normal.md");
    assert_eq!(summary.files_scanned, 1);
    cleanup(&dir);
}

// ---------- 二进制嗅探与超大文件 ----------

#[test]
fn 前_8kb_含_nul_判为二进制跳过() {
    let dir = temp_root("binary");
    write_bytes(&dir, "binary.md", b"needle\x00binary-ish");
    let (hits, summary) = run(&dir, &opts("needle"));
    assert!(hits.is_empty());
    assert_eq!(summary.files_scanned, 0);
    cleanup(&dir);
}

#[test]
fn nul_在嗅探窗口之外仍参与搜索() {
    let dir = temp_root("late-nul");
    let mut buf = b"needle here\n".to_vec();
    buf.resize(BINARY_SNIFF_BYTES + 900, b'x');
    buf.push(0);
    buf.extend_from_slice(b"\nneedle again\n");
    write_bytes(&dir, "late.md", &buf);
    let (hits, summary) = run(&dir, &opts("needle"));
    assert_eq!(hits.len(), 2);
    assert_eq!(summary.files_scanned, 1);
    cleanup(&dir);
}

#[test]
fn 超过_max_file_bytes_的文件跳过() {
    let dir = temp_root("bigfile");
    // 20 字节：内容含 needle，长度超过下方 10 字节上限
    write(&dir, "big.md", "needle padded       ");
    let small = SearchOptions {
        max_file_bytes: 10,
        ..opts("needle")
    };
    let (hits, summary) = run(&dir, &small);
    assert!(hits.is_empty());
    assert_eq!(summary.files_scanned, 0);

    let big_enough = SearchOptions {
        max_file_bytes: 100,
        ..opts("needle")
    };
    let (hits, _) = run(&dir, &big_enough);
    assert_eq!(hits.len(), 1);
    cleanup(&dir);
}

#[test]
fn 默认上限为_5mb_与_10000_条() {
    let o = SearchOptions::default();
    assert_eq!(o.max_file_bytes, DEFAULT_MAX_FILE_BYTES);
    assert_eq!(DEFAULT_MAX_FILE_BYTES, 5 * 1024 * 1024);
    assert_eq!(o.max_results, DEFAULT_MAX_RESULTS);
    assert_eq!(DEFAULT_MAX_RESULTS, 10_000);
    assert_eq!(BINARY_SNIFF_BYTES, 8 * 1024);
}

// ---------- 截断与取消 ----------

#[test]
fn 达到_max_results_置_truncated_并停止() {
    let dir = temp_root("truncate");
    for rel in ["a.md", "b.md", "c.md"] {
        write(&dir, rel, "needle\nneedle");
    }
    let limited = SearchOptions {
        max_results: 4,
        ..opts("needle")
    };
    let (hits, summary) = run(&dir, &limited);
    assert_eq!(hits.len(), 4);
    assert_eq!(summary.hits, 4);
    assert!(summary.truncated);

    let (hits, summary) = run(&dir, &opts("needle"));
    assert_eq!(hits.len(), 6);
    assert!(!summary.truncated);

    // max_results = 0：不扫描直接返回截断
    let zero = SearchOptions {
        max_results: 0,
        ..opts("needle")
    };
    let (hits, summary) = run(&dir, &zero);
    assert!(hits.is_empty());
    assert!(summary.truncated);
    assert_eq!(summary.files_scanned, 0);
    cleanup(&dir);
}

#[test]
fn 预置取消_立即返回_cancelled() {
    let dir = temp_root("cancel-pre");
    write(&dir, "a.md", "needle");
    let cancel = AtomicBool::new(true);
    let mut hits = Vec::new();
    let summary = search(&dir, &opts("needle"), &cancel, &mut |h| hits.push(h)).unwrap();
    assert!(summary.cancelled);
    assert!(hits.is_empty());
    assert_eq!(summary.files_scanned, 0);
    cleanup(&dir);
}

#[test]
fn 运行中取消_在文件检查点停下() {
    let dir = temp_root("cancel-run");
    for rel in ["a.md", "b.md", "c.md"] {
        write(&dir, rel, "needle");
    }
    let cancel = AtomicBool::new(false);
    let mut hits = Vec::new();
    let summary = search(&dir, &opts("needle"), &cancel, &mut |h| {
        hits.push(h);
        cancel.store(true, Ordering::Relaxed); // 首个命中后取消
    })
    .unwrap();
    // 每文件恰 1 个命中：取消后不再扫后续文件
    assert_eq!(hits.len(), 1);
    assert!(summary.cancelled);
    assert_eq!(summary.hits, 1);
    assert!(!summary.truncated);
    cleanup(&dir);
}

// ---------- 错误路径 ----------

#[test]
fn use_regex_返回_unsupported_feature() {
    let dir = temp_root("regex");
    write(&dir, "a.md", "needle");
    let re = SearchOptions {
        use_regex: true,
        ..opts("needle.*")
    };
    let cancel = AtomicBool::new(false);
    let err = search(&dir, &re, &cancel, &mut |_| {}).unwrap_err();
    match err {
        SearchError::UnsupportedFeature(msg) => assert_eq!(msg, "regex 引擎待集成"),
        other => panic!("期望 UnsupportedFeature，实际 {other:?}"),
    }
    cleanup(&dir);
}

#[test]
fn 非法_glob_返回错误而不_panic() {
    let dir = temp_root("bad-glob");
    write(&dir, "a.md", "needle");
    for pattern in ["{a,b", "{a,{b,c}}"] {
        let o = SearchOptions {
            include_globs: vec![pattern.to_string()],
            ..opts("needle")
        };
        let cancel = AtomicBool::new(false);
        match search(&dir, &o, &cancel, &mut |_| {}) {
            Err(SearchError::InvalidGlob(e)) => {
                assert_eq!(e.pattern, pattern);
                assert!(!e.reason.is_empty());
                assert!(e.to_string().contains(pattern));
            }
            other => panic!("期望 InvalidGlob({pattern})，实际 {other:?}"),
        }
    }
    cleanup(&dir);
}

#[test]
fn 空查询与根校验() {
    let dir = temp_root("errors");
    write(&dir, "a.md", "needle");
    let cancel = AtomicBool::new(false);
    match search(&dir, &opts(""), &cancel, &mut |_| {}) {
        Err(SearchError::EmptyQuery) => {}
        other => panic!("期望 EmptyQuery，实际 {other:?}"),
    }
    let missing = dir.join("不存在");
    match search(&missing, &opts("needle"), &cancel, &mut |_| {}) {
        Err(SearchError::RootNotFound(p)) => assert_eq!(p, missing),
        other => panic!("期望 RootNotFound，实际 {other:?}"),
    }
    // 文件路径作根同样拒绝
    match search(&dir.join("a.md"), &opts("needle"), &cancel, &mut |_| {}) {
        Err(SearchError::RootNotFound(_)) => {}
        other => panic!("期望 RootNotFound（文件根），实际 {other:?}"),
    }
    cleanup(&dir);
}

// ---------- 遍历顺序与符号链接 ----------

#[test]
fn 遍历顺序确定_目录内文件名升序_深度优先() {
    let dir = temp_root("order");
    for rel in ["b.md", "a.md", "c.md", "zz/d.md"] {
        write(&dir, rel, "needle");
    }
    let (hits, _) = run(&dir, &opts("needle"));
    let paths: Vec<&str> = hits.iter().map(|h| h.rel_path.as_str()).collect();
    assert_eq!(paths, vec!["a.md", "b.md", "c.md", "zz/d.md"]);
    cleanup(&dir);
}

#[cfg(unix)]
#[test]
fn 搜索不跟踪任何符号链接() {
    use std::os::unix::fs::symlink;
    let dir = temp_root("symlink");
    let outside = temp_root("symlink-outside");
    write(&outside, "secret.md", "needle");
    write(&dir, "local.md", "needle");
    symlink(outside.join("secret.md"), dir.join("link.md")).unwrap(); // 文件符号链接
    symlink(&outside, dir.join("dir-link")).unwrap(); // 目录符号链接
    write(&dir, "dir-link/nested.md", "needle");

    let (hits, _) = run(&dir, &opts("needle"));
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].rel_path, "local.md");
    cleanup(&dir);
    cleanup(&outside);
}

// ---------- wire 序列化形状（粘合层 JSON 契约） ----------

#[test]
fn wire_序列化形状() {
    let hit = SearchHit {
        rel_path: "docs/a.md".to_string(),
        line: 2,
        col: 8,
        line_text: "second 搜索 line".to_string(),
    };
    let v = serde_json::to_value(&hit).unwrap();
    assert_eq!(
        v,
        serde_json::json!({
            "rel_path": "docs/a.md",
            "line": 2,
            "col": 8,
            "line_text": "second 搜索 line"
        })
    );

    // SearchOptions 反序列化：缺省字段回落默认值（粘合层可只传 query）
    let parsed: SearchOptions = serde_json::from_str(r#"{"query":"x","whole_word":true}"#).unwrap();
    assert_eq!(parsed.query, "x");
    assert!(parsed.whole_word);
    assert!(!parsed.case_sensitive);
    assert_eq!(parsed.max_results, DEFAULT_MAX_RESULTS);
    assert_eq!(parsed.max_file_bytes, DEFAULT_MAX_FILE_BYTES);
}

// ---------- 10k 文件树搜索性能实测（--ignored 运行；数据记录于契约文档） ----------

/// 门禁参考（主计划阶段 4）：10k 文件目录首结果 < 1s、全量完成 < 5s
/// （中端硬件基准；实测以 release 模式为准并记录契约）。
/// 运行方式：
/// ```text
/// python tools/gen-test-tree.py --count 10000 --root tests/.tmp/tree-10k
/// cargo test --release --test search_probe -- --ignored --nocapture
/// ```
#[test]
#[ignore = "需要 tests/.tmp/tree-10k（tools/gen-test-tree.py 生成）；跑完即删，不入库"]
fn 性能_10k_搜索实测() {
    let root = Path::new("tests/.tmp/tree-10k");
    if !root.is_dir() {
        eprintln!("[skip] 未找到 tests/.tmp/tree-10k，跳过 10k 性能实测");
        return;
    }

    // 高频查询：多数可见文件含 "needle-"（截断在默认 10000 条上限）
    let common = opts("needle-");
    let cancel = AtomicBool::new(false);
    let mut first_hit: Option<Duration> = None;
    let t0 = Instant::now();
    let (hits, summary) = {
        let mut hits = Vec::new();
        let s = search(root, &common, &cancel, &mut |h| {
            if first_hit.is_none() {
                first_hit = Some(t0.elapsed());
            }
            hits.push(h);
        })
        .unwrap();
        (hits, s)
    };
    let common_total = t0.elapsed();
    println!(
        "[perf] 高频查询 \"needle-\"：首结果 {:?}，全量 {:?}，命中 {}（truncated={}），扫描 {} 文件",
        first_hit.unwrap_or_default(),
        common_total,
        summary.hits,
        summary.truncated,
        summary.files_scanned,
    );
    assert_eq!(hits.len(), summary.hits);
    assert!(summary.truncated, "needle- 命中应超过默认 10000 上限");

    // 唯一锚点查询：全量扫完 10000 文件
    let unique = opts("needle-04217");
    let t1 = Instant::now();
    let (hits, summary) = run(root, &unique);
    let unique_total = t1.elapsed();
    println!(
        "[perf] 唯一查询 \"needle-04217\"：全量 {:?}，命中 {}，扫描 {} 文件",
        unique_total, summary.hits, summary.files_scanned,
    );
    assert!(!hits.is_empty(), "needle-04217 应至少命中 1 个文件");
    assert_eq!(summary.files_scanned, 10000, "应扫完全部可见文件");
    assert!(!summary.cancelled);

    // 宽松健全性断言（真正的 <1s/<5s 门禁以 release 实测数据人工核对并记录契约）
    assert!(
        first_hit.unwrap_or_default() < Duration::from_secs(10),
        "首结果异常缓慢：{:?}",
        first_hit
    );
    assert!(
        common_total < Duration::from_secs(60) && unique_total < Duration::from_secs(60),
        "全量搜索异常缓慢：common={common_total:?} unique={unique_total:?}"
    );
}
