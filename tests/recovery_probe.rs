//! recovery 的对外集成测试（主实施计划阶段 6 交付项 4 探针）。
//!
//! 模式同 `tests/platform_probe.rs`：用 `#[path]` 引入模块源码（模块自含，
//! 不引用 `crate::` 路径，可脱离 bin crate 独立编译）。文件长期保留，充当
//! 崩溃恢复区的对外行为契约：快照存取与幂等、重复快照原子覆盖、损坏条目
//! 隔离、过期清理。
//!
//! 阶段 6 验收标准对照（主计划）：kill -9 后重启可恢复未保存内容——本
//! 文件覆盖存储层语义，真实进程级 kill -9 恢复属人工专项（主计划 §2）。

#[path = "../src/workspace/recovery.rs"]
mod recovery;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use recovery::{RecoveryEntry, RecoveryStore};

/// 测试临时目录计数器（进程内唯一，避免并行测试互相踩踏）。
static TEMP_SEQ: AtomicUsize = AtomicUsize::new(0);

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "glancemd-ultra-recovery-{}-{}-{}",
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

fn entry(tab_id: &str, path: Option<&str>, content: &str, saved_at_ms: u64) -> RecoveryEntry {
    RecoveryEntry {
        tab_id: tab_id.to_string(),
        path: path.map(|p| p.to_string()),
        content: content.to_string(),
        saved_at_ms,
    }
}

/// 断言恢复目录内没有 `.tmp-` 前缀残留（快照必须原子覆盖）。
fn assert_no_tmp(store: &RecoveryStore) {
    let leftovers: Vec<String> = std::fs::read_dir(store.dir())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(".tmp-"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "恢复区存在临时文件残留：{leftovers:?}"
    );
}

// ---------- 存取链路 ----------

#[test]
fn 快照_列出_取走_全链路与幂等() {
    let base = temp_dir("lifecycle");
    let store = RecoveryStore::open(&base);
    assert_eq!(store.dir(), base.join("recovery"));
    // 目录未创建前列出为空（惰性初始化）
    assert!(store.list_pending().is_empty());

    let e = entry("tab-1", Some("G:/proj/notes/理想.md"), "未保存的内容", 1000);
    store.snapshot(&e).unwrap();

    // 列出即得完整条目（含 path 字段）
    let listed = store.list_pending();
    assert_eq!(listed, vec![e.clone()]);

    // 取走即删；重复取走为 None（幂等安全）
    assert_eq!(store.take("tab-1"), Some(e));
    assert!(store.list_pending().is_empty());
    assert_eq!(store.take("tab-1"), None);
    assert_no_tmp(&store);

    cleanup(&base);
}

#[test]
fn 重复快照原子覆盖不产生重复条目() {
    let base = temp_dir("overwrite");
    let store = RecoveryStore::open(&base);

    let v1 = entry("tab-9", None, "第一版", 100);
    let v2 = entry("tab-9", Some("G:/p/a.md"), "第二版-更长", 200);
    store.snapshot(&v1).unwrap();
    store.snapshot(&v2).unwrap();

    let listed = store.list_pending();
    assert_eq!(listed.len(), 1, "同 tab 重复快照必须覆盖而非新增");
    assert_eq!(listed[0], v2);
    assert_no_tmp(&store);

    // 覆盖后取走的是最新版本
    assert_eq!(store.take("tab-9"), Some(v2));

    cleanup(&base);
}

#[test]
fn discard_移除条目且对不存在的tab静默() {
    let base = temp_dir("discard");
    let store = RecoveryStore::open(&base);
    store.snapshot(&entry("tab-x", None, "c", 1)).unwrap();
    store.discard("tab-x");
    assert!(store.list_pending().is_empty());
    // 不存在的 tab 丢弃不报错、不 panic
    store.discard("从未存在");
    assert_no_tmp(&store);

    cleanup(&base);
}

// ---------- 损坏隔离 ----------

#[test]
fn 损坏条目被跳过且收集警告_不影响其他条目() {
    let base = temp_dir("corrupt");
    let store = RecoveryStore::open(&base);
    let good = entry("good", None, "完好内容", 10);
    store.snapshot(&good).unwrap();

    // 直接向恢复区写一个损坏条目（模拟历史版本/磁盘损坏/写入中断后的残迹）
    let bad = store.dir().join("bad.json");
    std::fs::write(&bad, "{oops-not-json").unwrap();

    // list 只返回完好条目
    assert_eq!(store.list_pending(), vec![good.clone()]);

    // 报告版收集到警告，指名损坏文件
    let report = store.list_pending_report();
    assert_eq!(report.entries, vec![good.clone()]);
    assert_eq!(
        report.warnings.len(),
        1,
        "应收集警告：{:?}",
        report.warnings
    );
    assert!(report.warnings[0].contains("bad.json"));
    assert!(report.warnings[0].contains("跳过损坏的恢复条目"));

    // take 损坏条目返回 None 且不销毁（留给警告暴露与 prune 清理）
    assert_eq!(store.take("bad"), None);
    assert!(bad.exists());
    // 完好条目不受影响
    assert_eq!(store.take("good"), Some(good));

    cleanup(&base);
}

#[test]
fn 非json文件与临时残留不进入条目列表() {
    let base = temp_dir("noise");
    let store = RecoveryStore::open(&base);
    store.snapshot(&entry("t", None, "c", 1)).unwrap();
    // 杂物：非 .json 文件、.tmp- 半成品、子目录
    std::fs::write(store.dir().join("desktop.ini"), "junk").unwrap();
    std::fs::write(store.dir().join(".tmp-999-stale"), "half").unwrap();
    std::fs::create_dir_all(store.dir().join("子目录")).unwrap();

    let report = store.list_pending_report();
    assert_eq!(report.entries.len(), 1);
    assert!(
        report.warnings.is_empty(),
        "杂物不应产生警告：{:?}",
        report.warnings
    );

    cleanup(&base);
}

// ---------- 清理 ----------

#[test]
fn prune_before_按保留期清理并顺带清除损坏与临时残留() {
    let base = temp_dir("prune");
    let store = RecoveryStore::open(&base);
    let now: u64 = 1_700_000_000_000;
    let day_ms: u64 = 24 * 3600 * 1000;
    store
        .snapshot(&entry("old", None, "过期", now - 8 * day_ms))
        .unwrap();
    store
        .snapshot(&entry("recent", None, "保留", now - day_ms))
        .unwrap();
    store.snapshot(&entry("fresh", None, "保留", now)).unwrap();
    let bad = store.dir().join("bad.json");
    std::fs::write(&bad, "{corrupt").unwrap();
    let stale_tmp = store.dir().join(".tmp-1-2-3");
    std::fs::write(&stale_tmp, "half").unwrap();

    // 默认保留 7 天（由调用方换算毫秒传入）：清掉 8 天前的条目 + 损坏 + 残留
    let pruned = store.prune_before(7 * day_ms, now);
    assert_eq!(pruned, 3, "应清理：过期 1 + 损坏 1 + 临时残留 1");
    let left: Vec<String> = store
        .list_pending()
        .iter()
        .map(|e| e.tab_id.clone())
        .collect();
    assert_eq!(left.len(), 2);
    assert!(left.contains(&"recent".to_string()) && left.contains(&"fresh".to_string()));
    assert!(!bad.exists());
    assert!(!stale_tmp.exists());

    // now 小于保留期时 cutoff 饱和为 0，不误删任何条目
    assert_eq!(store.prune_before(u64::MAX, 0), 0);
    assert_eq!(store.list_pending().len(), 2);

    cleanup(&base);
}

// ---------- tab_id 清洗的对称性 ----------

#[test]
fn 含非法字符的tab_id_文件名清洗且存取对称还原() {
    let base = temp_dir("sanitize");
    let store = RecoveryStore::open(&base);

    let weird_id = r#"a/b:c*d?e<f>g|h"i"#; // 含路径分隔符、Windows 非法字符与引号
    let e = entry(weird_id, None, "内容", 1);
    store.snapshot(&e).unwrap();

    // 文件名被清洗（不含路径分隔符等非法字符），条目 JSON 内保持原值
    let listed = store.list_pending();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].tab_id, weird_id, "条目内的 tab_id 必须保持原值");
    let names: Vec<String> = std::fs::read_dir(store.dir())
        .unwrap()
        .filter_map(|x| x.ok())
        .map(|x| x.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(
        names,
        vec!["a_b_c_d_e_f_g_h_i.json".to_string()],
        "文件名应被清洗"
    );

    // 用原 id 取走/丢弃与快照对称（同一清洗映射）
    assert_eq!(store.take(weird_id), Some(e));

    // 中文等多字节字母直接保留为文件名
    let zh = entry("tab-中文-1", None, "c", 2);
    store.snapshot(&zh).unwrap();
    assert!(store.dir().join("tab-中文-1.json").exists());
    assert_eq!(store.take("tab-中文-1"), Some(zh));

    cleanup(&base);
}
