//! watcher 模块的对外集成测试（主实施计划阶段 2，Wave 2a watcher 流交付项）。
//!
//! 本项目是纯 bin crate：在 `src/workspace/mod.rs` 声明 `pub mod watcher;`
//! 之前，src 内的 `#[cfg(test)]` 测试不会被收集，因此这里用 `#[path]` 直接
//! 引入模块源码，作为该分支上可独立运行的测试载体（照 `platform_probe.rs`
//! 的探针模式）。文件长期保留，充当 watcher 能力的对外行为契约；集成后
//! 两者并存不冲突。
//!
//! 测试纪律：`Debouncer` / `LoopSuppressor` / `is_excluded` /
//! `map_notify_event` 为纯逻辑，全部用合成时间戳或直接构造的 notify 事件
//! 驱动，不触碰真实文件系统监听；`WatchService` 只走构造期的参数校验路径。
//! 唯一的真实 notify 集成冒烟标记为 `#[ignore]`，本地以
//! `cargo test -- --ignored` 按需执行。

#[path = "../src/workspace/watcher.rs"]
#[allow(dead_code)]
mod watcher;

use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Barrier};
use std::time::Duration;

use watcher::{
    is_excluded, map_notify_event, Debouncer, EventKind, LoopSuppressor, MergedEvent, RawEvent,
    WatchError, WatchOutcome, WatchService, DEBOUNCE_WINDOW_MS, DEFAULT_EXCLUDES,
    SELF_GRACE_DEFAULT_MS,
};

// ---------- 构造辅助（全部不触碰文件系统） ----------

fn p(s: &str) -> PathBuf {
    PathBuf::from(s)
}

fn created(path: &str, ts: u64) -> RawEvent {
    RawEvent {
        kind: EventKind::Created,
        path: p(path),
        ts_ms: ts,
    }
}

fn modified(path: &str, ts: u64) -> RawEvent {
    RawEvent {
        kind: EventKind::Modified,
        path: p(path),
        ts_ms: ts,
    }
}

fn removed(path: &str, ts: u64) -> RawEvent {
    RawEvent {
        kind: EventKind::Removed,
        path: p(path),
        ts_ms: ts,
    }
}

fn renamed(from: &str, to: &str, ts: u64) -> RawEvent {
    RawEvent::renamed(p(from), p(to), ts)
}

// ---------- 去抖器：规格验收与合并规则 ----------

/// 主计划阶段 2 验收：1s 内同文件 100 次写入只触发一次重载。
#[test]
fn 事件风暴_1秒内同文件100次写入只产生1个事件() {
    let mut d = Debouncer::new();
    for i in 0..100 {
        let out = d.feed(modified("G:/proj/notes/风暴.md", i * 10));
        assert!(
            out.is_empty(),
            "第 {i} 次写入（t={}ms）不应提前届满：{out:?}",
            i * 10
        );
    }
    assert!(!d.is_empty(), "风暴期间应保留未决事件");
    let out = d.flush(10_000);
    assert_eq!(out.len(), 1, "100 次写入必须合并为恰好 1 个事件");
    match &out[0] {
        MergedEvent::Modified { path, ts_ms } => {
            assert_eq!(path, &p("G:/proj/notes/风暴.md"));
            assert_eq!(*ts_ms, 990, "时间戳取最后一次观测");
        }
        other => panic!("期望 Modified，实际 {other:?}"),
    }
    assert!(d.is_empty(), "冲刷后不得残留未决事件");
}

#[test]
fn 同窗口内创建加修改合并为创建() {
    let mut d = Debouncer::new();
    assert!(d.feed(created("G:/proj/a.md", 0)).is_empty());
    assert!(d.feed(modified("G:/proj/a.md", 200)).is_empty());
    assert_eq!(
        d.flush(1000),
        vec![MergedEvent::Created {
            path: p("G:/proj/a.md"),
            ts_ms: 200
        }]
    );
}

#[test]
fn 同窗口内创建加删除对消_不产出任何事件() {
    let mut d = Debouncer::new();
    assert!(d.feed(created("G:/proj/临时.md", 0)).is_empty());
    assert!(d.feed(removed("G:/proj/临时.md", 100)).is_empty());
    assert!(d.is_empty(), "对消后不应残留未决事件");
    assert!(d.flush(5000).is_empty());
}

#[test]
fn 同窗口内修改加删除合并为删除() {
    let mut d = Debouncer::new();
    assert!(d.feed(modified("G:/proj/a.md", 0)).is_empty());
    assert!(d.feed(removed("G:/proj/a.md", 150)).is_empty());
    assert_eq!(
        d.flush(1000),
        vec![MergedEvent::Removed {
            path: p("G:/proj/a.md"),
            ts_ms: 150
        }]
    );
}

#[test]
fn 同窗口内删除加创建视为重建() {
    let mut d = Debouncer::new();
    assert!(d.feed(removed("G:/proj/a.md", 0)).is_empty());
    assert!(d.feed(created("G:/proj/a.md", 100)).is_empty());
    assert_eq!(
        d.flush(1000),
        vec![MergedEvent::Created {
            path: p("G:/proj/a.md"),
            ts_ms: 100
        }]
    );
}

#[test]
fn 重命名事件合并产出_保留来源与目标() {
    let mut d = Debouncer::new();
    let raw = renamed("G:/proj/旧名.md", "G:/proj/新名.md", 0);
    assert_eq!(raw.path, p("G:/proj/旧名.md"), "RawEvent 主路径恒等于 from");
    assert!(d.feed(raw).is_empty());
    assert_eq!(
        d.flush(1000),
        vec![MergedEvent::Renamed {
            from: p("G:/proj/旧名.md"),
            to: p("G:/proj/新名.md"),
            ts_ms: 0
        }]
    );
}

/// 典型场景：工具先建临时文件再重命名为正式名（原子写），应当只产出重命名。
#[test]
fn 同窗口内创建加重命名合并为一次重命名() {
    let mut d = Debouncer::new();
    assert!(d.feed(created("G:/proj/tmp-123.tmp", 0)).is_empty());
    assert!(d
        .feed(renamed("G:/proj/tmp-123.tmp", "G:/proj/正文.md", 100))
        .is_empty());
    assert_eq!(
        d.flush(1000),
        vec![MergedEvent::Renamed {
            from: p("G:/proj/tmp-123.tmp"),
            to: p("G:/proj/正文.md"),
            ts_ms: 100
        }]
    );
}

/// 锁定行为：重命名目标路径上的后续修改不经同一合并键，单独产出一次
/// Modified（对消费方是良性的：先更新路径再重载内容）。
#[test]
fn 重命名后目标路径的修改单独产出() {
    let mut d = Debouncer::new();
    assert!(d
        .feed(renamed("G:/proj/a.md", "G:/proj/b.md", 0))
        .is_empty());
    assert!(d.feed(modified("G:/proj/b.md", 100)).is_empty());
    assert_eq!(
        d.flush(1000),
        vec![
            MergedEvent::Renamed {
                from: p("G:/proj/a.md"),
                to: p("G:/proj/b.md"),
                ts_ms: 0
            },
            MergedEvent::Modified {
                path: p("G:/proj/b.md"),
                ts_ms: 100
            },
        ]
    );
}

#[test]
fn 窗口边界_间隔299毫秒合并_间隔300毫秒开新窗口() {
    // 间隔 299ms：仍在窗口内 → 合并
    let mut merged = Debouncer::new();
    assert!(merged.feed(modified("G:/proj/a.md", 0)).is_empty());
    assert!(merged.feed(modified("G:/proj/a.md", 299)).is_empty());
    assert_eq!(
        merged.flush(600),
        vec![MergedEvent::Modified {
            path: p("G:/proj/a.md"),
            ts_ms: 299
        }]
    );

    // 间隔恰为 300ms：旧未决事件届满产出，新事件独立成窗
    let mut split = Debouncer::new();
    assert!(split.feed(modified("G:/proj/a.md", 0)).is_empty());
    assert_eq!(
        split.feed(modified("G:/proj/a.md", 300)),
        vec![MergedEvent::Modified {
            path: p("G:/proj/a.md"),
            ts_ms: 0
        }],
        "喂入时同步届满窗口已满的未决事件"
    );
    assert_eq!(
        split.flush(1000),
        vec![MergedEvent::Modified {
            path: p("G:/proj/a.md"),
            ts_ms: 300
        }]
    );

    // 届满时机：now - last_ts >= 300 才冲刷
    let mut timing = Debouncer::new();
    assert!(timing.feed(modified("G:/proj/a.md", 1000)).is_empty());
    assert!(timing.flush(1299).is_empty(), "299ms 未届满，不得产出");
    assert_eq!(timing.flush(1300).len(), 1, "300ms 整届满产出");
}

#[test]
fn 不同路径各自独立去抖并按字典序产出() {
    let mut d = Debouncer::new();
    assert!(d.feed(modified("G:/proj/b.md", 0)).is_empty());
    assert!(d.feed(modified("G:/proj/a.md", 50)).is_empty());
    assert!(d.feed(modified("G:/proj/a.md", 100)).is_empty());
    assert_eq!(
        d.flush(2000),
        vec![
            MergedEvent::Modified {
                path: p("G:/proj/a.md"),
                ts_ms: 100
            },
            MergedEvent::Modified {
                path: p("G:/proj/b.md"),
                ts_ms: 0
            },
        ]
    );
}

#[test]
fn 强制冲刷无视窗口届满() {
    let mut d = Debouncer::new();
    assert!(d.feed(modified("G:/proj/a.md", 0)).is_empty());
    assert!(d.flush(0).is_empty(), "窗口未届满的周期冲刷不得产出");
    assert_eq!(
        d.flush_all(),
        vec![MergedEvent::Modified {
            path: p("G:/proj/a.md"),
            ts_ms: 0
        }]
    );
    assert!(d.is_empty());
}

#[test]
fn 关键常量与规格一致() {
    assert_eq!(
        DEBOUNCE_WINDOW_MS, 300,
        "去抖窗口按主计划阶段 2 固定为 300ms"
    );
    assert_eq!(SELF_GRACE_DEFAULT_MS, 750, "回环抑制默认宽限期");
    assert_eq!(
        DEFAULT_EXCLUDES,
        &[
            ".git",
            "node_modules",
            "target",
            ".venv",
            "dist",
            "build",
            ".cache"
        ]
    );
}

// ---------- 回环抑制器 ----------

#[test]
fn 抑制器_mark后命中_complete后宽限期内仍命中_过期后放行() {
    let sup = LoopSuppressor::with_grace(Duration::from_millis(50));
    sup.mark(1, &[p("G:/proj/a.md"), p("G:/proj/b.md")]);
    assert!(sup.is_self(&p("G:/proj/a.md")));
    assert!(sup.is_self(&p("G:/proj/b.md")));
    assert!(!sup.is_self(&p("G:/proj/c.md")), "未登记路径必须放行");

    sup.complete(1);
    assert!(
        sup.is_self(&p("G:/proj/a.md")),
        "complete 后宽限期内仍视为自身操作（文件系统通知晚于保存返回）"
    );
    std::thread::sleep(Duration::from_millis(120));
    assert!(!sup.is_self(&p("G:/proj/a.md")), "宽限期过后应放行");

    // 未知 op_id 的 complete 为无害 no-op
    sup.complete(999);
    // 重复 mark 同一 op_id 为覆盖语义
    sup.mark(1, &[p("G:/proj/d.md")]);
    assert!(sup.is_self(&p("G:/proj/d.md")));
    assert!(!sup.is_self(&p("G:/proj/a.md")), "覆盖后旧路径集合不再命中");
    sup.complete(1);
}

#[cfg(windows)]
#[test]
fn 抑制器匹配兼容windows_verbatim前缀与斜杠大小写差异() {
    let sup = LoopSuppressor::new();
    // 登记侧：canonicalize 坐标系（\\?\ 前缀，反斜杠）
    sup.mark(7, &[p(r"\\?\G:\Proj\笔记.md")]);
    // 查询侧：展示坐标系 / 前端传来的斜杠形式
    assert!(
        sup.is_self(&p(r"G:\Proj\笔记.md")),
        "剥离 \\\\?\\ 前缀后应命中"
    );
    assert!(
        sup.is_self(&p("G:/proj/笔记.md")),
        "Windows 下斜杠与大小写宽松匹配"
    );
    assert!(!sup.is_self(&p(r"G:\Proj\其他.md")));
    sup.complete(7);
}

#[test]
fn 抑制器并发mark_complete与is_self无死锁() {
    let sup = Arc::new(LoopSuppressor::with_grace(Duration::from_millis(20)));
    let barrier = Arc::new(Barrier::new(5));
    let mut handles = Vec::new();
    for t in 0..4u64 {
        let sup = Arc::clone(&sup);
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            for i in 0..200u64 {
                let id = t * 1000 + i;
                let path = p(&format!("G:/proj/t{t}/f{i}.md"));
                sup.mark(id, &[path.clone()]);
                assert!(sup.is_self(&path), "进行中操作必须命中抑制");
                sup.complete(id);
            }
        }));
    }
    barrier.wait();
    for i in 0..500u64 {
        assert!(
            !sup.is_self(&p(&format!("G:/proj/外部/{i}.md"))),
            "并发读不应误抑制无关路径"
        );
    }
    for h in handles {
        h.join().expect("工作线程不得 panic");
    }
}

// ---------- 排除过滤 ----------

#[test]
fn 排除过滤_按组件名整段精确匹配() {
    let ex = vec![
        ".git".to_string(),
        "node_modules".to_string(),
        "target".to_string(),
    ];
    // 排除目录自身与任意深度的后代
    assert!(is_excluded(&p("G:/proj/.git"), &ex));
    assert!(is_excluded(&p("G:/proj/.git/objects/ab/cd"), &ex));
    assert!(is_excluded(&p("G:/proj/a/node_modules/b/c.md"), &ex));
    // 普通文件不命中
    assert!(!is_excluded(&p("G:/proj/笔记.md"), &ex));
    // 组件名必须整段相等：子串与后缀不误伤
    assert!(!is_excluded(&p("G:/proj/mytarget/a.md"), &ex));
    assert!(!is_excluded(&p("G:/proj/target.md"), &ex));
    // 空列表不过滤
    assert!(!is_excluded(&p("G:/proj/.git/config"), &[]));
    // 项目根本身不含排除组件，永不被排除
    assert!(!is_excluded(&p("G:/proj"), &ex));
}

// ---------- notify 事件映射（直接构造 notify 类型，不启动监听） ----------

fn notify_event(kind: notify::EventKind, paths: &[&str]) -> notify::Event {
    let mut ev = notify::Event::new(kind);
    for s in paths {
        ev = ev.add_path(p(s));
    }
    ev
}

#[test]
fn notify映射_创建修改删除与多路径() {
    use notify::event::{AccessKind, CreateKind, DataChange, ModifyKind};

    let raws = map_notify_event(
        &notify_event(
            notify::EventKind::Create(CreateKind::File),
            &["G:/proj/新.md"],
        ),
        42,
    );
    assert_eq!(raws.len(), 1);
    assert_eq!(raws[0].kind, EventKind::Created);
    assert_eq!(raws[0].ts_ms, 42);

    let raws = map_notify_event(
        &notify_event(
            notify::EventKind::Modify(ModifyKind::Data(DataChange::Any)),
            &["G:/proj/a.md"],
        ),
        42,
    );
    assert_eq!(raws[0].kind, EventKind::Modified);

    let raws = map_notify_event(
        &notify_event(
            notify::EventKind::Remove(notify::event::RemoveKind::Any),
            &["G:/proj/a.md"],
        ),
        42,
    );
    assert_eq!(raws[0].kind, EventKind::Removed);

    // 同一 notify 事件携带多路径 → 每路径一个 RawEvent，共享时间戳
    let raws = map_notify_event(
        &notify_event(
            notify::EventKind::Create(CreateKind::Any),
            &["G:/proj/a.md", "G:/proj/b.md"],
        ),
        7,
    );
    assert_eq!(raws.len(), 2);
    assert!(raws.iter().all(|r| r.ts_ms == 7));

    // 访问类事件（打开/读取）不产生对外事件
    let raws = map_notify_event(
        &notify_event(
            notify::EventKind::Access(AccessKind::Any),
            &["G:/proj/a.md"],
        ),
        1,
    );
    assert!(raws.is_empty());

    // 泛化事件（FSEvents 等）防御性按修改处理：宁可多报重载不漏变更
    let raws = map_notify_event(&notify_event(notify::EventKind::Any, &["G:/proj/a.md"]), 1);
    assert_eq!(raws[0].kind, EventKind::Modified);
}

#[test]
fn notify映射_重命名三形态() {
    use notify::event::{ModifyKind, RenameMode};

    // Windows 主形态：单事件同时携带来源与目标 → 单个 Renamed
    let raws = map_notify_event(
        &notify_event(
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            &["G:/proj/旧.md", "G:/proj/新.md"],
        ),
        5,
    );
    assert_eq!(raws.len(), 1);
    assert_eq!(
        raws[0].kind,
        EventKind::Renamed {
            from: p("G:/proj/旧.md"),
            to: p("G:/proj/新.md")
        }
    );
    assert_eq!(raws[0].path, p("G:/proj/旧.md"), "主路径恒等于 from");
    assert_eq!(
        raws[0].involved_paths(),
        vec![Path::new("G:/proj/旧.md"), Path::new("G:/proj/新.md")]
    );

    // 拆分形态后端：From → Removed、To → Created
    // （对应主计划"无法唯一识别时按删除+新增处理"）
    let from = map_notify_event(
        &notify_event(
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            &["G:/proj/旧.md"],
        ),
        5,
    );
    assert_eq!(from[0].kind, EventKind::Removed);
    let to = map_notify_event(
        &notify_event(
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            &["G:/proj/新.md"],
        ),
        5,
    );
    assert_eq!(to[0].kind, EventKind::Created);
}

/// 监听根经 canonicalize 后 notify 事件路径带 `\\?\` 前缀（Windows 主平台
/// 的真实形态），映射必须剥离为展示路径，否则消费方按展示路径比对永远
/// 对不上——曾导致真实后端冒烟失败，锁定防回归。
#[test]
fn notify映射_剥离windows_verbatim前缀() {
    let raws = map_notify_event(
        &notify_event(
            notify::EventKind::Create(notify::event::CreateKind::Any),
            &[r"\\?\G:\proj\a.md"],
        ),
        1,
    );
    assert_eq!(raws[0].path, p(r"G:\proj\a.md"));

    let raws = map_notify_event(
        &notify_event(
            notify::EventKind::Modify(notify::event::ModifyKind::Name(
                notify::event::RenameMode::Both,
            )),
            &[r"\\?\G:\proj\旧.md", r"\\?\G:\proj\新.md"],
        ),
        1,
    );
    assert_eq!(
        raws[0].kind,
        EventKind::Renamed {
            from: p(r"G:\proj\旧.md"),
            to: p(r"G:\proj\新.md")
        }
    );

    // UNC verbatim 前缀同样剥离为 \\server\share 形态
    let raws = map_notify_event(
        &notify_event(
            notify::EventKind::Remove(notify::event::RemoveKind::Any),
            &[r"\\?\UNC\server\share\删除.md"],
        ),
        1,
    );
    assert_eq!(raws[0].path, p(r"\\server\share\删除.md"));
}

// ---------- 类型 Display 与 WatchService 构造校验 ----------

#[test]
fn 类型_display完整() {
    let me = MergedEvent::Renamed {
        from: p("G:/proj/a.md"),
        to: p("G:/proj/b.md"),
        ts_ms: 1,
    };
    let text = me.to_string();
    assert!(
        text.contains("a.md") && text.contains("b.md") && text.contains("→"),
        "{text}"
    );
    assert_eq!(me.kind_name(), "renamed");

    let out = WatchOutcome::ExternalChange(MergedEvent::Modified {
        path: p("G:/proj/a.md"),
        ts_ms: 1,
    });
    assert!(out.to_string().contains("a.md"));
    assert_eq!(
        WatchOutcome::SelfSuppressed.to_string(),
        "自身操作事件（已抑制）"
    );
    assert!(WatchOutcome::Error("后端失效".to_string())
        .to_string()
        .contains("后端失效"));

    let raw = renamed("G:/proj/a.md", "G:/proj/b.md", 9);
    assert!(raw.to_string().contains("a.md") && raw.to_string().contains("9"));
    assert!(EventKind::Created.to_string() == "创建");
    assert!(WatchError::NotFound(p("G:/proj/缺"))
        .to_string()
        .contains("不存在"));
    assert!(
        WatchError::NotADirectory(p("G:/proj/文件"))
            .to_string()
            .contains("不是目录"),
        "Display 文案需面向用户"
    );
}

#[test]
fn watch_service构造校验_不启动真实监听() {
    // 根不存在 → NotFound（错误路径在创建监听器之前返回）
    let missing = std::env::temp_dir().join(format!(
        "glancemd-ultra-watch-probe-缺失-{}",
        std::process::id()
    ));
    match WatchService::new(&missing, &[]) {
        Err(WatchError::NotFound(pp)) => assert_eq!(pp, missing),
        other => panic!("期望 NotFound，实际 {other:?}"),
    }
    assert!(
        WatchService::new(&missing, &[]).is_err_and(|e| e.to_string().contains("不存在")),
        "错误文案需面向用户"
    );

    // 根是文件 → NotADirectory
    let dir =
        std::env::temp_dir().join(format!("glancemd-ultra-watch-probe-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("普通文件.md");
    std::fs::write(&file, "x").unwrap();
    match WatchService::new(&file, &[]) {
        Err(WatchError::NotADirectory(pp)) => assert_eq!(pp, file),
        other => panic!("期望 NotADirectory，实际 {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------- 真实 notify 集成冒烟（默认忽略） ----------

/// 在时限内等待针对目标路径的 ExternalChange；其余结果吞掉后继续等。
fn wait_external(rx: &Receiver<WatchOutcome>, path: &Path, timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        let remain = deadline
            .saturating_duration_since(std::time::Instant::now())
            .min(Duration::from_millis(200));
        match rx.recv_timeout(remain) {
            Ok(WatchOutcome::ExternalChange(me)) => {
                if me.involved_paths().iter().any(|p| *p == path) {
                    return true;
                }
            }
            Ok(_) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return false,
        }
    }
    false
}

/// 真实 notify 后端集成冒烟：变更到达、排除目录过滤、暂停/恢复。
/// 默认忽略（时序敏感，CI 不执行）；本地以 `cargo test -- --ignored` 验证。
/// 断言窗口放宽到 5s 以避开杀毒扫描等干扰；负向断言用 700ms 静默窗。
#[test]
#[ignore = "真实文件系统 + notify 集成，时序敏感；本地以 cargo test -- --ignored 验证"]
fn watchservice_真实后端冒烟_变更到达_排除过滤_暂停恢复() {
    let dir =
        std::env::temp_dir().join(format!("glancemd-ultra-watch-live-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::create_dir_all(dir.join(".git")).unwrap();

    // exclude 传空切片 → 启用默认排除（含 .git），顺带验证默认排除生效
    let svc = WatchService::new(&dir, &[]).expect("构造 WatchService");
    let rx = svc.take_receiver().expect("接收端仅有一个，应能取到");
    assert!(!svc.is_paused());
    assert_eq!(svc.root(), dir.canonicalize().unwrap());

    // 1) 外部写入 → 收到 ExternalChange（Created/Modified 均算到达）
    let a = dir.join("a.md");
    std::fs::write(&a, "# hello").unwrap();
    assert!(wait_external(&rx, &a, 5000), "5s 内未收到 a.md 的外部变更");

    // 2) 默认排除目录（.git）内写入 → 不产出
    let git_conf = dir.join(".git").join("config");
    std::fs::write(&git_conf, "x").unwrap();
    assert!(
        !wait_external(&rx, &git_conf, 700),
        ".git 内的变更不应产出外部事件"
    );

    // 3) 暂停期间写入 → 不产出（丢弃不回放）；恢复后新写入 → 产出
    svc.pause();
    assert!(svc.is_paused());
    let b = dir.join("b.md");
    std::fs::write(&b, "paused").unwrap();
    assert!(!wait_external(&rx, &b, 700), "暂停期间不应产出事件");
    svc.resume();
    std::fs::write(&b, "resumed").unwrap();
    assert!(
        wait_external(&rx, &b, 5000),
        "恢复后 5s 内未收到 b.md 的外部变更"
    );

    // Drop 停止：服务析构后通道关闭，recv 端自然收尾
    drop(svc);
    let _ = std::fs::remove_dir_all(&dir);
}
