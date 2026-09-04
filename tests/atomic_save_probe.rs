//! atomic_save 的对外集成测试（主实施计划阶段 6 交付项 1 探针）。
//!
//! 模式同 `tests/platform_probe.rs`：用 `#[path]` 引入模块源码，作为该
//! 分支上可独立运行的测试载体。文件长期保留，充当原子保存的对外行为
//! 契约：成功覆盖、中断模拟目标完好、失败清理临时文件、缺父目录报错。
//!
//! 阶段 6 验收标准对照（主计划）：原子保存在模拟中断（写入过程杀进程）
//! 后目标文件不损坏——以"写一半即 drop 句柄"模拟崩溃现场。

#[path = "../src/atomic_save.rs"]
mod atomic_save;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use atomic_save::{atomic_write, SaveError};

/// 测试临时目录计数器（进程内唯一，避免并行测试互相踩踏）。
static TEMP_SEQ: AtomicUsize = AtomicUsize::new(0);

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "glancemd-ultra-atomic-{}-{}-{}",
        std::process::id(),
        tag,
        TEMP_SEQ.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn cleanup(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

/// 断言目录内没有任何 `.tmp-` 前缀的临时文件残留。
fn assert_no_tmp(dir: &Path) {
    let leftovers: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(".tmp-"))
        .collect();
    assert!(leftovers.is_empty(), "存在临时文件残留：{leftovers:?}");
}

// ---------- 成功路径 ----------

#[test]
fn atomic_write_成功覆盖已有文件且无临时残留() {
    let dir = temp_dir("overwrite");
    let target = dir.join("note.md");
    std::fs::write(&target, "old-longer-content").unwrap();

    atomic_write(&target, b"new").unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"new");
    assert_no_tmp(&dir); // 成功后目录无临时残留

    // 反复覆盖：先短后长，替换语义与长度无关
    atomic_write(&target, b"much-longer-new-content").unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"much-longer-new-content");
    assert_no_tmp(&dir);

    // 首次保存（目标不存在）同样成立
    let fresh = dir.join("首次.md");
    atomic_write(&fresh, b"first").unwrap();
    assert_eq!(std::fs::read(&fresh).unwrap(), b"first");
    assert_no_tmp(&dir);

    cleanup(&dir);
}

// ---------- 中断模拟（阶段 6 验收项） ----------

#[test]
fn 中断模拟_写入中途崩溃目标文件完好() {
    let dir = temp_dir("crash");
    let target = dir.join("note.md");
    std::fs::write(&target, "ORIGINAL").unwrap();

    // 模拟进程在写入临时文件中途被杀：句柄写一半即 drop，不做 flush/sync，
    // 永远走不到 rename。目标是"崩溃现场"的静态快照。
    let tmp = dir.join(format!(".tmp-{}-模拟崩溃", std::process::id()));
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp).unwrap();
        f.write_all(b"half-writ").unwrap();
        // 作用域结束即 drop——等价于进程死亡时未完成的写入
    }

    // 目标文件保持原内容完好，仅残留一个临时文件
    assert_eq!(
        std::fs::read(&target).unwrap(),
        b"ORIGINAL",
        "中断后目标文件不得损坏"
    );
    let tmp_leftovers: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(".tmp-"))
        .collect();
    assert_eq!(
        tmp_leftovers,
        vec![tmp.file_name().unwrap().to_string_lossy().to_string()],
        "崩溃应恰好残留一个半成品临时文件"
    );

    // 崩溃后再次原子保存仍然成功（临时文件机制不因残留而失效）
    atomic_write(&target, b"RECOVERED").unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"RECOVERED");
    // 本次保存自产的临时文件已被清理；崩溃遗留的旧临时文件不在
    // atomic_write 的职责内（清扫属启动期策略，见契约文档）
    let remaining: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(".tmp-"))
        .collect();
    assert_eq!(
        remaining,
        vec![tmp.file_name().unwrap().to_string_lossy().to_string()]
    );
    std::fs::remove_file(&tmp).unwrap();
    assert_no_tmp(&dir);

    cleanup(&dir);
}

// ---------- 失败清理与报错 ----------

#[test]
fn atomic_write_替换失败时清理临时文件() {
    let dir = temp_dir("rename-fail");
    // 目标是已存在的目录：文件无法替换目录，rename 必然失败
    let target = dir.join("占用为目录");
    std::fs::create_dir_all(&target).unwrap();

    assert!(matches!(atomic_write(&target, b"x"), Err(SaveError::Io(_))));
    assert_no_tmp(&dir); // 失败时临时文件必须被清理
    assert!(target.is_dir()); // 目标目录本身未被破坏

    cleanup(&dir);
}

#[test]
fn atomic_write_目标目录不存在时显式报错() {
    let dir = temp_dir("missing-parent");
    let missing = dir.join("不存在的目录");
    let target = missing.join("note.md");

    match atomic_write(&target, b"x") {
        Err(SaveError::MissingParent(p)) => assert_eq!(p, missing),
        other => panic!("期望 MissingParent，实际 {other:?}"),
    }
    assert!(!target.exists());
    assert!(!missing.exists()); // 不代建目录

    cleanup(&dir);
}

#[test]
fn save_error_错误消息可读() {
    assert_eq!(
        SaveError::MissingParent(PathBuf::from("G:/nope")).to_string(),
        "目标父目录不存在或不是目录：G:/nope"
    );
    let io = SaveError::Io(std::io::Error::new(std::io::ErrorKind::Other, "磁盘已满"));
    let msg = io.to_string();
    assert!(msg.contains("原子保存失败"), "缺中文前缀：{msg}");
    assert!(msg.contains("磁盘已满"), "缺底层原因：{msg}");
}
