//! tree 模块的对外集成测试（`tests/platform_probe.rs` 同款探针模式）。
//!
//! 本项目是纯 bin crate：在 `src/workspace/mod.rs` 声明 `pub mod tree;` 之前，
//! src 侧 `#[cfg(test)]` 不会被收集，因此这里用 `#[path]` 直接引入模块源码，
//! 作为该分支上可独立运行的测试载体。文件长期保留，充当 tree 能力的对外行为
//! 契约；集成后与 src 侧单元测试并存不冲突。
//!
//! 覆盖：默认过滤值、目录/文件分组排序（不区分大小写）、扩展名与隐藏过滤、
//! 排除目录、rel_path 斜杠约定、非法 rel_dir 拒绝、错误分类、符号链接策略、
//! 懒加载逐层语义。文件系统操作全部在 `std::env::temp_dir` 下的临时目录进行。
//!
//! 另含 10k 文件树性能门禁测试（`--ignored` 运行，需先用
//! `python tools/gen-test-tree.py --count 10000 --root tests/.tmp/tree-10k`
//! 生成树；树不存在时自动跳过）。性能数据记录于
//! `docs/dev/contracts/tree-search.md`。

#[path = "../src/workspace/tree.rs"]
mod tree;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use tree::{list_dir, EntryKind, TreeError, TreeFilter};

/// 测试临时目录计数器（进程内唯一，避免并行测试互相覆盖）。
static TEMP_SEQ: AtomicUsize = AtomicUsize::new(0);

fn temp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "glancemd-ultra-tree-{}-{}-{}",
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

fn mkdir(root: &Path, rel: &str) -> PathBuf {
    let p = root.join(rel);
    fs::create_dir_all(&p).unwrap();
    p
}

fn write(root: &Path, rel: &str, content: &str) {
    let p = root.join(rel);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(p, content).unwrap();
}

/// 提取条目列表的 `(name, kind)` 摘要，便于断言。
fn summary(entries: &[tree::TreeEntry]) -> Vec<(String, EntryKind)> {
    entries.iter().map(|e| (e.name.clone(), e.kind)).collect()
}

// ---------- 默认过滤值 ----------

#[test]
fn 默认过滤器与主计划阶段1默认值一致() {
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
            ".csv",
            ".png",
            ".jpg",
            ".jpeg",
            ".gif",
            ".svg",
            ".webp",
            ".bmp",
            ".ico",
            ".avif"
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

// ---------- 分组排序与 rel_path ----------

#[test]
fn 目录排前且组内不区分大小写排序() {
    let dir = temp_root("sort");
    mkdir(&dir, "Beta");
    mkdir(&dir, "alpha");
    write(&dir, "B.md", "b");
    write(&dir, "a.md", "a");
    write(&dir, "中.md", "c");

    let entries = list_dir(&dir, "", &TreeFilter::default()).unwrap();
    assert_eq!(
        summary(&entries),
        vec![
            ("alpha".to_string(), EntryKind::Dir),
            ("Beta".to_string(), EntryKind::Dir),
            ("a.md".to_string(), EntryKind::File),
            ("B.md".to_string(), EntryKind::File),
            ("中.md".to_string(), EntryKind::File),
        ]
    );
    // 根层 rel_path 即名称本身
    assert_eq!(entries[0].rel_path, "alpha");
    cleanup(&dir);
}

#[test]
fn rel_path_使用斜杠分隔且随层级拼接() {
    let dir = temp_root("relpath");
    mkdir(&dir, "docs/notes");
    write(&dir, "docs/notes/a.md", "x");

    let root_view = list_dir(&dir, "", &TreeFilter::default()).unwrap();
    assert_eq!(root_view.len(), 1);
    assert_eq!(root_view[0].rel_path, "docs");

    let docs_view = list_dir(&dir, "docs", &TreeFilter::default()).unwrap();
    assert_eq!(docs_view[0].rel_path, "docs/notes");

    let notes_view = list_dir(&dir, "docs/notes", &TreeFilter::default()).unwrap();
    assert_eq!(notes_view[0].rel_path, "docs/notes/a.md");
    assert_eq!(notes_view[0].name, "a.md");
    cleanup(&dir);
}

// ---------- 过滤语义 ----------

#[test]
fn 扩展名白名单过滤() {
    let dir = temp_root("ext");
    for name in [
        "note.md",
        "note.markdown",
        "note.txt",
        "data.json",
        "cfg.yaml",
        "cfg.yml",
        "cfg.toml",
        "cfg.ini",
        "tbl.csv",
        "大写.MD", // 扩展名不区分大小写
        "main.rs", // 不可见
        "pic.png", // 图片后缀默认可见
        "LICENSE", // 无扩展名不可见
    ] {
        write(&dir, name, "x");
    }
    let entries = list_dir(&dir, "", &TreeFilter::default()).unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "cfg.ini",
            "cfg.toml",
            "cfg.yaml",
            "cfg.yml",
            "data.json",
            "note.markdown",
            "note.md",
            "note.txt",
            "pic.png",
            "tbl.csv",
            "大写.MD",
        ]
    );
    cleanup(&dir);
}

#[test]
fn 隐藏文件与隐藏目录默认隐藏_开启后显示() {
    let dir = temp_root("hidden");
    write(&dir, ".env", "secret");
    write(&dir, ".notes.md", "hidden note");
    write(&dir, ".notes.rs", "hidden but invisible ext");
    write(&dir, "normal.md", "visible");
    mkdir(&dir, ".hidden-dir");
    write(&dir, ".hidden-dir/inner.md", "inner");

    let entries = list_dir(&dir, "", &TreeFilter::default()).unwrap();
    assert_eq!(
        summary(&entries),
        vec![("normal.md".to_string(), EntryKind::File)]
    );

    // show_hidden = true：隐藏项显示，但仍受扩展名白名单约束
    let mut f = TreeFilter::default();
    f.show_hidden = true;
    let entries = list_dir(&dir, "", &f).unwrap();
    assert_eq!(
        summary(&entries),
        vec![
            (".hidden-dir".to_string(), EntryKind::Dir),
            (".env".to_string(), EntryKind::File),
            (".notes.md".to_string(), EntryKind::File),
            ("normal.md".to_string(), EntryKind::File),
        ]
    );
    cleanup(&dir);
}

#[test]
fn 排除目录不显示且大小写不敏感() {
    let dir = temp_root("excluded");
    for name in [
        ".git",
        "node_modules",
        "target",
        ".venv",
        "dist",
        "build",
        ".cache",
        "Build",
    ] {
        mkdir(&dir, name);
        write(&dir, &format!("{name}/inside.md"), "x");
    }
    write(&dir, "keep.md", "visible");
    let entries = list_dir(&dir, "", &TreeFilter::default()).unwrap();
    assert_eq!(
        summary(&entries),
        vec![("keep.md".to_string(), EntryKind::File)]
    );
    cleanup(&dir);
}

// ---------- 懒加载逐层语义 ----------

#[test]
fn 单次只列一层_子目录内容不外泄() {
    let dir = temp_root("lazy");
    mkdir(&dir, "a/b/c");
    write(&dir, "a/b/c/deep.md", "deep");
    write(&dir, "a/mid.md", "mid");
    write(&dir, "top.md", "top");

    let top = list_dir(&dir, "", &TreeFilter::default()).unwrap();
    assert_eq!(
        summary(&top),
        vec![
            ("a".to_string(), EntryKind::Dir),
            ("top.md".to_string(), EntryKind::File),
        ]
    );

    let a = list_dir(&dir, "a", &TreeFilter::default()).unwrap();
    assert_eq!(
        summary(&a),
        vec![
            ("b".to_string(), EntryKind::Dir),
            ("mid.md".to_string(), EntryKind::File),
        ]
    );

    let b = list_dir(&dir, "a/b", &TreeFilter::default()).unwrap();
    assert_eq!(summary(&b), vec![("c".to_string(), EntryKind::Dir)]);

    let c = list_dir(&dir, "a/b/c", &TreeFilter::default()).unwrap();
    assert_eq!(summary(&c), vec![("deep.md".to_string(), EntryKind::File)]);
    cleanup(&dir);
}

#[test]
fn 空目录返回空列表() {
    let dir = temp_root("empty");
    let entries = list_dir(&dir, "", &TreeFilter::default()).unwrap();
    assert!(entries.is_empty());
    cleanup(&dir);
}

// ---------- 错误分类与越界拒绝 ----------

#[test]
fn 非法_rel_dir_返回_invalid_rel_dir() {
    let dir = temp_root("invalid");
    for bad in ["..", "a/..", "../x", "/etc", "C:/x", "C:x", "a\0b"] {
        match list_dir(&dir, bad, &TreeFilter::default()) {
            Err(TreeError::InvalidRelDir(r)) => assert_eq!(r, bad),
            other => panic!("期望 InvalidRelDir({bad})，实际 {other:?}"),
        }
    }
    cleanup(&dir);
}

#[test]
fn 不存在与非目录返回对应错误() {
    let dir = temp_root("errors");
    write(&dir, "file.md", "x");
    match list_dir(&dir, "missing", &TreeFilter::default()) {
        Err(TreeError::NotFound(p)) => assert_eq!(p, dir.join("missing")),
        other => panic!("期望 NotFound，实际 {other:?}"),
    }
    match list_dir(&dir, "file.md", &TreeFilter::default()) {
        Err(TreeError::NotADirectory(p)) => assert_eq!(p, dir.join("file.md")),
        other => panic!("期望 NotADirectory，实际 {other:?}"),
    }
    cleanup(&dir);
}

// ---------- 符号链接策略（Unix 必测；Windows 需开发者模式，失败则降级跳过） ----------

#[cfg(unix)]
#[test]
fn 文件符号链接显示为_symlink_file_目录符号链接不显示() {
    use std::os::unix::fs::symlink;
    let dir = temp_root("symlink");
    mkdir(&dir, "real-dir");
    write(&dir, "target.md", "content");
    write(&dir, "target.rs", "invisible ext");
    symlink(dir.join("target.md"), dir.join("link.md")).unwrap();
    symlink(dir.join("target.rs"), dir.join("link.rs")).unwrap(); // 符号链接同样受扩展名过滤
    symlink(dir.join("real-dir"), dir.join("dir-link")).unwrap();
    symlink(dir.join("missing-target.md"), dir.join("broken.md")).unwrap(); // 断链按文件符号链接处理

    let entries = list_dir(&dir, "", &TreeFilter::default()).unwrap();
    assert_eq!(
        summary(&entries),
        vec![
            ("real-dir".to_string(), EntryKind::Dir),
            ("broken.md".to_string(), EntryKind::SymLinkFile),
            ("link.md".to_string(), EntryKind::SymLinkFile),
            ("target.md".to_string(), EntryKind::File),
        ]
    );
    cleanup(&dir);
}

#[cfg(windows)]
#[test]
fn 文件符号链接显示为_symlink_file_目录符号链接不显示() {
    use std::os::windows::fs::{symlink_dir, symlink_file};
    let dir = temp_root("symlink");
    mkdir(&dir, "real-dir");
    write(&dir, "target.md", "content");
    // Windows 创建符号链接需要开发者模式/管理员权限；无权限时降级为跳过
    let file_link = match symlink_file(dir.join("target.md"), dir.join("link.md")) {
        Ok(_) => true,
        Err(e) => {
            eprintln!("[skip] 无符号链接权限，跳过 Windows 符号链接用例：{e}");
            let _ = fs::remove_dir_all(&dir);
            return;
        }
    };
    let _ = file_link;
    let _ = symlink_dir(dir.join("real-dir"), dir.join("dir-link")).unwrap();

    let entries = list_dir(&dir, "", &TreeFilter::default()).unwrap();
    assert_eq!(
        summary(&entries),
        vec![
            ("real-dir".to_string(), EntryKind::Dir),
            ("link.md".to_string(), EntryKind::SymLinkFile),
            ("target.md".to_string(), EntryKind::File),
        ]
    );
    cleanup(&dir);
}

// ---------- 10k 文件树性能门禁（--ignored 运行；数据记录于契约文档） ----------

/// 门禁参考（主计划阶段 1）：单目录 list_dir < 50ms。
/// 运行方式：
/// ```text
/// python tools/gen-test-tree.py --count 10000 --root tests/.tmp/tree-10k
/// cargo test --release --test tree_probe -- --ignored --nocapture
/// ```
#[test]
#[ignore = "需要 tests/.tmp/tree-10k（tools/gen-test-tree.py 生成）；跑完即删，不入库"]
fn 性能_10k_树逐层_list_dir_实测() {
    let root = Path::new("tests/.tmp/tree-10k");
    if !root.is_dir() {
        eprintln!("[skip] 未找到 tests/.tmp/tree-10k，跳过 10k 性能实测");
        return;
    }
    let filter = TreeFilter::default();

    let t0 = Instant::now();
    let root_entries = list_dir(root, "", &filter).unwrap();
    let root_elapsed = t0.elapsed();

    let mut total_files = 0usize;
    let mut total_dirs = 0usize;
    let mut total_elapsed = std::time::Duration::ZERO;
    let mut max_elapsed = std::time::Duration::ZERO;
    let mut max_dir = String::new();
    let mut max_count = 0usize;
    let mut stack: Vec<String> = root_entries
        .iter()
        .filter(|e| e.kind == EntryKind::Dir)
        .map(|e| e.rel_path.clone())
        .collect();
    while let Some(rel) = stack.pop() {
        let t = Instant::now();
        let entries = list_dir(root, &rel, &filter).unwrap();
        let elapsed = t.elapsed();
        total_files += entries.iter().filter(|e| e.kind != EntryKind::Dir).count();
        total_dirs += 1;
        total_elapsed += elapsed;
        if elapsed > max_elapsed {
            max_elapsed = elapsed;
            max_dir = rel.clone();
            max_count = entries.len();
        }
        for e in entries.iter().filter(|e| e.kind == EntryKind::Dir) {
            stack.push(e.rel_path.clone());
        }
    }

    println!(
        "[perf] 根目录 list_dir：{:?}（{} 个条目）",
        root_elapsed,
        root_entries.len()
    );
    println!(
        "[perf] 其余 {} 个目录：累计 {:?}，单目录最大 {:?}（{}，{} 个条目），平均 {:?}",
        total_dirs,
        total_elapsed,
        max_elapsed,
        max_dir,
        max_count,
        total_elapsed.div_f64(total_dirs.max(1) as f64),
    );
    println!("[perf] 全树可见文件总数：{total_files}（gen-test-tree 应为 10000）");
    // 正确性联动断言：排除目录与隐藏文件被过滤后，可见文件恰为生成器保证的 10000
    assert_eq!(
        total_files, 10000,
        "可见文件数应与 gen-test-tree.py --count 一致"
    );
    // 宽松健全性断言（真正的 <50ms 门禁以 release 实测数据人工核对并记录契约）
    assert!(
        root_elapsed.as_millis() < 2000 && max_elapsed.as_millis() < 2000,
        "单目录 list_dir 异常缓慢：root={root_elapsed:?} max={max_elapsed:?}"
    );
}
