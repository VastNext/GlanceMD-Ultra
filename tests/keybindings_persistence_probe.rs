//! 快捷键持久化探针（schema v2 事实源契约）。
//!
//! 覆盖三个维度——前端设置桥（`src/frontend/keybindings.js`）以
//! `workspace.settings.get-global` 为写入合并基座所依赖的 Rust 侧行为：
//!
//! 1. **多方案独立保存/加载**：`keybindings.schemes` 按方案 ID 隔离，
//!    `save` → `load_global` 零漂移（"分 scheme overrides 独立"）；
//! 2. **v1 → v2 迁移**：旧 `keybindings.overrides` map 落入默认活动方案的
//!    binding records（旧 localStorage 迁移由前端执行，本模块定义握手）；
//! 3. **仅改 keybindings 不扰动其他设置**：前端桥每次回写只替换 keybindings
//!    段，其他分类与未改动的方案绑定必须在落盘后原样保留（"全局设置 JSON
//!    为事实源、不覆写其他设置"）。
//!
//! 额外验证未来 schema 容忍：Keybinding 记录中的未知字段不告警、不阻断
//! （后端不降级、不覆写）。
//!
//! 测试纪律：`base_dir` 一律使用临时目录注入，绝不触碰真实配置目录；
//! 测试间用进程内唯一计数器隔离目录，结束后清理。

#[path = "../src/workspace/settings.rs"]
mod settings;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use settings::{load_global, migrate_checked, save, Keybinding, Settings, SCHEMA_VERSION};

/// 测试临时目录计数器（进程内唯一，避免并行测试互相覆盖）。
static TEMP_SEQ: AtomicUsize = AtomicUsize::new(0);

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "glancemd-ultra-kb-{}-{}-{}",
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

fn binding(command_id: &str, sequence: &str) -> Keybinding {
    Keybinding {
        command_id: command_id.to_string(),
        sequence: sequence.to_string(),
        context: None,
        when: None,
        platform: None,
        removed: false,
    }
}

#[test]
fn v2_多方案roundtrip_保存加载零漂移() {
    let dir = temp_dir("multi-scheme-roundtrip");
    let mut settings = Settings::default();
    settings.keybindings.active_scheme = "ultra.vscode".to_string();
    settings.keybindings.schemes = BTreeMap::from([
        (
            "ultra.eclipse".to_string(),
            vec![
                binding("file.open", "Alt+O"),
                binding("file.save", "Ctrl+S"),
            ],
        ),
        (
            "ultra.vscode".to_string(),
            vec![binding("file.open", "Ctrl+O")],
        ),
    ]);
    save(&dir, &settings).unwrap();
    let reloaded = load_global(&dir);
    cleanup(&dir);

    assert_eq!(reloaded.version, SCHEMA_VERSION);
    // 整个 keybindings 段零漂移（activeScheme + 各方案绑定独立保留）
    assert_eq!(reloaded.keybindings, settings.keybindings);
    assert_eq!(reloaded.keybindings.active_scheme, "ultra.vscode");
    assert_eq!(reloaded.keybindings.schemes.len(), 2);
    assert_eq!(
        reloaded.keybindings.schemes["ultra.eclipse"][0].sequence,
        "Alt+O"
    );
    assert_eq!(
        reloaded.keybindings.schemes["ultra.vscode"][0].sequence,
        "Ctrl+O"
    );
}

#[test]
fn v1_迁移_旧overrides落入默认活动方案() {
    let raw = serde_json::json!({
        "version": 1,
        "keybindings": { "overrides": { "file.open": "Alt+O", "editor.undo": "Ctrl+Z" } },
    });
    let migrated = migrate_checked(&raw).unwrap();
    let k = migrated.settings.keybindings;

    assert_eq!(k.active_scheme, "ultra.eclipse");
    let records = &k.schemes["ultra.eclipse"];
    assert_eq!(records.len(), 2);
    assert!(records
        .iter()
        .any(|r| r.command_id == "file.open" && r.sequence == "Alt+O"));
    assert!(records
        .iter()
        .any(|r| r.command_id == "editor.undo" && r.sequence == "Ctrl+Z"));
    // 迁移提示随 warnings 透出（契约 §4 握手文案）
    assert!(migrated
        .warnings
        .iter()
        .any(|w| w.contains("overrides") && w.contains("ultra.eclipse")));
}

#[test]
fn 仅改keybindings_保存后其他设置分类与未动方案不被扰动() {
    let dir = temp_dir("kb-merge-base");
    let mut settings = Settings::default();
    settings.appearance.theme = settings::Theme::Dark;
    settings.editor.font_size = 18;
    settings.keybindings.active_scheme = "ultra.eclipse".to_string();
    settings.keybindings.schemes = BTreeMap::from([(
        "ultra.eclipse".to_string(),
        vec![binding("file.open", "Alt+O")],
    )]);
    save(&dir, &settings).unwrap();

    // 模拟前端桥：读全局文档 → 只替换 keybindings 段（切方案 + 写当前方案）→ 落盘
    let mut next = load_global(&dir);
    next.keybindings.active_scheme = "ultra.vscode".to_string();
    next.keybindings.schemes.insert(
        "ultra.vscode".to_string(),
        vec![binding("file.open", "Alt+V")],
    );
    save(&dir, &next).unwrap();

    let reloaded = load_global(&dir);
    cleanup(&dir);

    // 其他设置分类不受 keybindings 回写影响（前端以 get-global 为合并基座）
    assert_eq!(reloaded.appearance.theme, settings::Theme::Dark);
    assert_eq!(reloaded.editor.font_size, 18);
    // 未改动的方案绑定原样保留（分方案独立）
    assert_eq!(reloaded.keybindings.active_scheme, "ultra.vscode");
    assert_eq!(
        reloaded.keybindings.schemes["ultra.eclipse"][0].sequence,
        "Alt+O"
    );
    assert_eq!(
        reloaded.keybindings.schemes["ultra.vscode"][0].sequence,
        "Alt+V"
    );
}

#[test]
fn 记录内未知字段_容忍不告警_不阻断解析与落盘() {
    let raw = serde_json::json!({
        "version": 2,
        "keybindings": {
            "activeScheme": "ultra.eclipse",
            "schemes": {
                "ultra.eclipse": [
                    { "commandId": "file.open", "sequence": "Alt+O", "futureField": 1 }
                ]
            }
        }
    });
    let migrated = migrate_checked(&raw).unwrap();

    // 记录内未知字段静默容忍（内层不做键检查，契约 §2.6/§4）：不告警、不阻断
    assert!(
        migrated.warnings.is_empty(),
        "keybindings 内层记录未知字段不应产生告警：{:?}",
        migrated.warnings
    );
    assert_eq!(
        migrated.settings.keybindings.schemes["ultra.eclipse"][0].sequence,
        "Alt+O"
    );

    // 含未来字段的记录落盘-加载仍零漂移于 schema 值（未来 schema 不覆写既有绑定）
    let dir = temp_dir("future-field");
    save(&dir, &migrated.settings).unwrap();
    let reloaded = load_global(&dir);
    cleanup(&dir);
    assert_eq!(
        reloaded.keybindings.schemes["ultra.eclipse"][0].sequence,
        "Alt+O"
    );
}
