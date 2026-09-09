//! settings 模块的对外行为契约测试（阶段 5 设置体系，可测性模式）。
//!
//! 本项目是纯 bin crate：在 `workspace/mod.rs` 声明 `pub mod settings;` 之前，
//! src 内的 `#[cfg(test)]` 测试不会被收集，因此这里用 `#[path]` 直接引入模块
//! 源码（只依赖 std/serde/serde_json，无 `crate::` 引用），作为该分支上可独立
//! 运行的测试载体。文件长期保留，充当设置体系的行为契约；集成后与 src 侧
//! 单元测试并存不冲突。
//!
//! 测试纪律：base_dir / root 一律使用临时目录注入，绝不触碰真实配置目录；
//! 测试间用进程内唯一计数器隔离目录，结束后清理。

#[path = "../src/workspace/settings.rs"]
mod settings;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use settings::{
    effective, global_settings_path, is_overridden, load_global, load_global_checked, load_project,
    load_project_checked, migrate, migrate_checked, project_settings_path, save, save_project,
    Appearance, AppearancePatch, AutoSave, Editor, EditorPatch, Files, FilesPatch, Keybinding,
    Keybindings, KeybindingsPatch, LoadedSettings, MigrateError, Recovery, RecoveryPatch, Search,
    SearchPatch, Settings, SettingsPatch, Theme, Watching, WatchingPatch, PROJECT_SETTINGS_DIR,
    SCHEMA_VERSION, SETTINGS_FILE_NAME,
};

/// 测试临时目录计数器（进程内唯一，避免并行测试互相覆盖）。
static TEMP_SEQ: AtomicUsize = AtomicUsize::new(0);

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "glancemd-ultra-settings-{}-{}-{}",
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

fn write_json(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, text).unwrap();
}

// ---------- 默认值 ----------

#[test]
fn 默认值与主计划及基线一致() {
    let s = Settings::default();
    assert_eq!(s.version, 2);
    assert!(!s.window.reuse_window_for_folder);
    assert_eq!(s.keybindings.active_scheme, "ultra.eclipse");
    assert!(s.keybindings.schemes.is_empty());
    // 阶段 1：默认可见扩展名与排除清单
    assert_eq!(
        s.files.visible_exts,
        [
            "md", "markdown", "txt", "json", "yaml", "yml", "toml", "ini", "csv", "png", "jpg",
            "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif"
        ]
    );
    assert_eq!(
        s.files.watcher_exclude,
        [
            ".git",
            "node_modules",
            "target",
            ".venv",
            "dist",
            "build",
            ".cache"
        ]
    );
    assert_eq!(s.files.exclude, s.files.watcher_exclude);
    assert!(!s.files.show_hidden);
    // 阶段 4：search.exclude 与过滤默认值相同；>5MB；结果数上限
    assert_eq!(s.search.exclude, s.files.watcher_exclude);
    assert_eq!(s.search.max_file_size_mb, 5);
    // 基线：主题默认 light、字号 14、tab 4、自动换行开
    assert_eq!(s.appearance.theme, Theme::Light);
    assert_eq!(
        s.editor,
        Editor {
            font_size: 14,
            tab_size: 4,
            word_wrap: true,
            line_numbers: true,
            large_file_mb: 5,
        }
    );
    // 自动保存默认关闭（阶段 6）
    assert_eq!(s.watching.auto_save, AutoSave::Off);
    assert_eq!(s.watching.auto_save_delay_ms, 1000);
    // 监听开关默认开启（阶段 5+ 接线）
    assert!(s.watching.enable_watcher);
    // 侧栏基准字号默认 14（换算比例后视觉 ≈ 基线树行 13px）
    assert_eq!(s.appearance.sidebar_font_size, 14);
    assert_eq!(s.appearance.outline_side, "right");
    assert!(s.keybindings.schemes.is_empty());
    assert!(s.recovery.confirm_close_dirty);
    assert!(s.recovery.crash_recovery);
    assert!(!s.recovery.create_project_settings);
}

#[test]
fn 窗口复用策略默认多开且仅取全局设置() {
    let global = Settings::default();
    assert!(!global.window.reuse_window_for_folder);

    let mut enabled = global.clone();
    enabled.window.reuse_window_for_folder = true;
    let merged = effective(&enabled, &SettingsPatch::default());
    assert!(merged.window.reuse_window_for_folder);

    let json = serde_json::to_value(&merged).unwrap();
    assert_eq!(json["window"]["reuseWindowForFolder"], true);
}

#[test]
fn 路径约定_全局与项目文件名() {
    assert_eq!(
        global_settings_path(Path::new("/cfg/root")),
        Path::new("/cfg/root").join(SETTINGS_FILE_NAME)
    );
    let p = project_settings_path(Path::new("/ws"));
    assert_eq!(
        p,
        Path::new("/ws")
            .join(PROJECT_SETTINGS_DIR)
            .join(SETTINGS_FILE_NAME)
    );
    // 按路径组件断言（避免依赖平台路径分隔符）
    assert_eq!(
        p.parent()
            .and_then(|parent| parent.file_name())
            .map(|s| s.to_string_lossy().into_owned()),
        Some(PROJECT_SETTINGS_DIR.to_string())
    );
    assert_eq!(
        p.file_name().map(|s| s.to_string_lossy().into_owned()),
        Some(SETTINGS_FILE_NAME.to_string())
    );
}

// ---------- 全局加载 ----------

#[test]
fn 全默认加载_无文件时零告警() {
    let dir = temp_dir("empty");
    let loaded = load_global_checked(&dir);
    assert_eq!(
        loaded,
        LoadedSettings {
            settings: Settings::default(),
            warnings: Vec::new(),
        }
    );
    assert_eq!(load_global(&dir), Settings::default());
    cleanup(&dir);
}

#[test]
fn 损坏_json_回退默认并产生告警() {
    let dir = temp_dir("corrupt");
    write_json(&global_settings_path(&dir), "{ 不是合法 JSON");
    let loaded = load_global_checked(&dir);
    assert_eq!(loaded.settings, Settings::default());
    assert_eq!(loaded.warnings.len(), 1);
    assert!(
        loaded.warnings[0].contains("解析失败"),
        "{}",
        loaded.warnings[0]
    );
    cleanup(&dir);
}

#[test]
fn v1_部分文档_缺省字段由默认值填充() {
    let dir = temp_dir("partial-v1");
    write_json(
        &global_settings_path(&dir),
        r#"{ "version": 1, "appearance": { "theme": "dark" } }"#,
    );
    let loaded = load_global_checked(&dir);
    assert!(
        loaded.warnings.iter().any(|w| w.contains("v1→v2")),
        "{:?}",
        loaded.warnings
    );
    assert_eq!(loaded.settings.appearance.theme, Theme::Dark);
    // 其余字段取默认
    assert_eq!(loaded.settings.editor, Editor::default());
    assert_eq!(loaded.settings.files, Files::default());
    cleanup(&dir);
}

#[test]
fn 未知键_顶层与字段级均收集进告警且不阻断() {
    let dir = temp_dir("unknown-keys");
    write_json(
        &global_settings_path(&dir),
        r#"{
            "version": 1,
            "mystery": true,
            "appearance": { "theme": "dark", "bogus": 1 },
            "editor": { "fontSize": 18 }
        }"#,
    );
    let loaded = load_global_checked(&dir);
    assert_eq!(loaded.settings.appearance.theme, Theme::Dark);
    assert_eq!(loaded.settings.editor.font_size, 18);
    assert!(
        loaded
            .warnings
            .iter()
            .any(|w| w.contains("mystery") && w.contains("未知设置键")),
        "{:?}",
        loaded.warnings
    );
    assert!(
        loaded
            .warnings
            .iter()
            .any(|w| w.contains("appearance.bogus")),
        "{:?}",
        loaded.warnings
    );
    cleanup(&dir);
}

#[test]
fn keybindings_内层键是命令_id_不产生未知键告警() {
    let dir = temp_dir("keybindings-open-set");
    write_json(
        &global_settings_path(&dir),
        r#"{ "version": 1, "keybindings": { "overrides": { "file.save": "Ctrl+Alt+S" } } }"#,
    );
    let loaded = load_global_checked(&dir);
    assert!(
        loaded
            .warnings
            .iter()
            .any(|w| w.contains("keybindings.overrides") && w.contains("ultra.eclipse")),
        "{:?}",
        loaded.warnings
    );
    assert_eq!(
        loaded.settings.keybindings.schemes["ultra.eclipse"],
        vec![Keybinding {
            command_id: "file.save".to_string(),
            sequence: "Ctrl+Alt+S".to_string(),
            ..Keybinding::default()
        }]
    );
    cleanup(&dir);
}

// ---------- 版本与迁移 ----------

#[test]
fn 高于当前版本的文档_迁移报错_加载回退默认并告警() {
    let future = SCHEMA_VERSION + 1;
    let raw = serde_json::json!({ "version": future, "appearance": { "theme": "dark" } });
    match migrate(&raw) {
        Err(MigrateError::UnsupportedVersion { found, current }) => {
            assert_eq!(found, future);
            assert_eq!(current, SCHEMA_VERSION);
        }
        other => panic!("期望 UnsupportedVersion，实际 {other:?}"),
    }
    let dir = temp_dir("future-version");
    write_json(&global_settings_path(&dir), r#"{ "version": 99 }"#);
    let loaded = load_global_checked(&dir);
    assert_eq!(loaded.settings, Settings::default());
    assert!(loaded.warnings[0].contains("99"), "{}", loaded.warnings[0]);
    cleanup(&dir);
}

#[test]
fn v0_迁移演练_缺version视为v0并补默认version1() {
    // 伪造 v0 文档：无 version 字段，顶层散落旧键 theme（演练一条字段映射规则）
    let raw = serde_json::json!({ "theme": "dark" });
    let migrated = migrate_checked(&raw).unwrap();
    assert_eq!(migrated.settings.version, SCHEMA_VERSION);
    assert_eq!(migrated.settings.appearance.theme, Theme::Dark);
    // 其余字段全部取 v1 默认值
    assert_eq!(migrated.settings.files, Files::default());
    assert!(
        migrated.warnings.iter().any(|w| w.contains("v0→v1")),
        "{:?}",
        migrated.warnings
    );
    assert!(migrated
        .warnings
        .iter()
        .any(|w| w.contains("theme") && w.contains("appearance.theme")));
}

#[test]
fn v0_迁移演练_非法theme值被忽略且不阻断() {
    let raw = serde_json::json!({ "theme": "solarized" });
    let migrated = migrate_checked(&raw).unwrap();
    assert_eq!(migrated.settings, Settings::default());
    assert!(
        migrated.warnings.iter().any(|w| w.contains("solarized")),
        "{:?}",
        migrated.warnings
    );
    // 显式 version: 0 与缺 version 同路径
    let raw0 = serde_json::json!({ "version": 0, "theme": "system" });
    let migrated0 = migrate_checked(&raw0).unwrap();
    assert_eq!(migrated0.settings.version, SCHEMA_VERSION);
    assert_eq!(migrated0.settings.appearance.theme, Theme::System);
}

#[test]
fn 非对象文档_迁移报错() {
    assert!(matches!(
        migrate(&serde_json::json!([1, 2, 3])),
        Err(MigrateError::InvalidDocument(_))
    ));
}

#[test]
fn 全字段v1文档_迁移无告警且逐字段相等_守护已知键表不失同步() {
    let raw = serde_json::json!({
        "version": 1,
        "appearance": { "theme": "dark", "sidebarFontSize": 16, "outlineSide": "left" },
        "files": {
            "visibleExts": ["md"],
            "showHidden": true,
            "exclude": ["x"],
            "watcherExclude": ["y"]
        },
        "watching": { "enableWatcher": false, "autoSave": "afterDelay", "autoSaveDelayMs": 2500 },
        "search": { "exclude": ["s"], "maxFileSizeMB": 10, "maxResults": 100 },
        "editor": {
            "fontSize": 16,
            "tabSize": 2,
            "wordWrap": false,
            "lineNumbers": false,
            "largeFileMB": 20
        },
        "keybindings": { "overrides": { "file.save": "Ctrl+Alt+S" } },
        "recovery": {
            "confirmCloseDirty": false,
            "crashRecovery": false,
            "createProjectSettings": true
        }
    });
    let migrated = migrate_checked(&raw).unwrap();
    assert!(
        migrated
            .warnings
            .iter()
            .any(|w| w.contains("keybindings.overrides") && w.contains("ultra.eclipse")),
        "{:?}",
        migrated.warnings
    );
    assert_eq!(
        migrated.settings,
        Settings {
            version: SCHEMA_VERSION,
            appearance: Appearance {
                theme: Theme::Dark,
                sidebar_font_size: 16,
                outline_side: "left".to_string(),
                language: "zh-CN".to_string(),
            },
            files: Files {
                visible_exts: vec!["md".to_string()],
                show_hidden: true,
                exclude: vec!["x".to_string()],
                watcher_exclude: vec!["y".to_string()],
                terminal_path: String::new(),
                terminal_args: String::new(),
            },
            watching: Watching {
                enable_watcher: false,
                auto_save: AutoSave::AfterDelay,
                auto_save_delay_ms: 2500
            },
            search: Search {
                exclude: vec!["s".to_string()],
                max_file_size_mb: 10,
                max_results: 100,
            },
            editor: Editor {
                font_size: 16,
                tab_size: 2,
                word_wrap: false,
                line_numbers: false,
                large_file_mb: 20,
            },
            keybindings: Keybindings {
                active_scheme: "ultra.eclipse".to_string(),
                schemes: [(
                    "ultra.eclipse".to_string(),
                    vec![Keybinding {
                        command_id: "file.save".to_string(),
                        sequence: "Ctrl+Alt+S".to_string(),
                        ..Keybinding::default()
                    }]
                )]
                .into_iter()
                .collect(),
                overrides: BTreeMap::new(),
            },
            recovery: Recovery {
                confirm_close_dirty: false,
                crash_recovery: false,
                create_project_settings: true,
            },
            window: settings::Window::default(),
        }
    );
}

// ---------- 合并引擎 ----------

#[test]
fn 项目部分覆盖全局_未覆盖字段保留全局值() {
    let global = Settings {
        appearance: Appearance {
            theme: Theme::Dark,
            sidebar_font_size: 18,
            outline_side: "right".to_string(),
            language: "zh-CN".to_string(),
        },
        editor: Editor {
            font_size: 20,
            ..Editor::default()
        },
        ..Settings::default()
    };
    let project = SettingsPatch {
        appearance: Some(AppearancePatch {
            theme: Some(Theme::Light),
            sidebar_font_size: Some(12),
            outline_side: Some("left".to_string()),
            language: Some("en".to_string()),
        }),
        watching: Some(WatchingPatch {
            enable_watcher: Some(false),
            ..WatchingPatch::default()
        }),
        editor: Some(EditorPatch {
            tab_size: Some(2),
            ..EditorPatch::default()
        }),
        ..SettingsPatch::default()
    };
    let merged = effective(&global, &project);
    // 覆盖项
    assert_eq!(merged.appearance.theme, Theme::Light);
    assert_eq!(merged.appearance.sidebar_font_size, 12);
    assert_eq!(merged.editor.tab_size, 2);
    assert!(!merged.watching.enable_watcher);
    // 未覆盖项保留全局（含全局里显式改过的与未改过的）
    assert_eq!(merged.editor.font_size, 20);
    assert_eq!(merged.editor.word_wrap, true);
    assert_eq!(merged.watching.auto_save, AutoSave::Off);
    assert_eq!(merged.files, Files::default());
    assert_eq!(merged.version, SCHEMA_VERSION);
}

#[test]
fn 嵌套vec与map为整体覆盖_不做并集合并() {
    // 语义约定：Vec / BTreeMap 以项目设置为单位整体替换全局值，
    // 不做按元素合并——项目想"在全局基础上追加"必须自行写出完整列表。
    let global = Settings::default(); // watcher_exclude = 7 项默认
    let project = SettingsPatch {
        files: Some(FilesPatch {
            watcher_exclude: Some(vec!["logs".to_string()]),
            ..FilesPatch::default()
        }),
        ..SettingsPatch::default()
    };
    let merged = effective(&global, &project);
    assert_eq!(merged.files.watcher_exclude, vec!["logs".to_string()]);
    // 同类其他字段不受影响
    assert_eq!(merged.files.visible_exts, Files::default().visible_exts);
    // 快捷键覆盖同理：整体替换
    let project = SettingsPatch {
        keybindings: Some(KeybindingsPatch {
            active_scheme: Some("custom".to_string()),
            schemes: Some(BTreeMap::new()),
            overrides: None,
        }),
        ..SettingsPatch::default()
    };
    let merged = effective(&global, &project);
    assert_eq!(
        merged.keybindings.active_scheme,
        Settings::default().keybindings.active_scheme
    );
    assert!(merged.keybindings.schemes.is_empty());
}

#[test]
fn 空补丁_有效设置等于全局() {
    let global = Settings {
        recovery: Recovery {
            create_project_settings: true,
            ..Recovery::default()
        },
        ..Settings::default()
    };
    assert_eq!(effective(&global, &SettingsPatch::default()), global);
}

// ---------- is_overridden ----------

#[test]
fn is_overridden_字段级_类级_未知路径() {
    let project = SettingsPatch {
        appearance: Some(AppearancePatch {
            theme: Some(Theme::Dark),
            ..AppearancePatch::default()
        }),
        files: Some(FilesPatch {
            show_hidden: Some(true),
            ..FilesPatch::default()
        }),
        ..SettingsPatch::default()
    };
    // 字段级：覆盖过的为 true
    assert!(is_overridden(&project, "appearance.theme"));
    assert!(!is_overridden(&project, "appearance.sidebarFontSize"));
    assert!(is_overridden(&project, "files.showHidden"));
    assert!(!is_overridden(&project, "watching.enableWatcher"));
    // 字段级：补丁里该类存在但字段为 None → false
    assert!(!is_overridden(&project, "files.watcherExclude"));
    // 类级：该类任一字段被覆盖 → true；补丁未出现该类 → false
    assert!(is_overridden(&project, "appearance"));
    assert!(is_overridden(&project, "files"));
    assert!(!is_overridden(&project, "editor"));
    // 未知路径一律 false
    assert!(!is_overridden(&project, "appearance.notAField"));
    assert!(!is_overridden(&project, "noSuchCategory"));
    assert!(!is_overridden(&project, "noSuchCategory.field"));
    // 大小写敏感（JSON 键名精确匹配）
    assert!(!is_overridden(&project, "appearance.Theme"));
}

// ---------- roundtrip（保存→加载零漂移） ----------

#[test]
fn v1_roundtrip_自定义设置_保存加载零漂移() {
    let dir = temp_dir("roundtrip-custom");
    let original = Settings {
        version: SCHEMA_VERSION,
        appearance: Appearance {
            theme: Theme::System,
            sidebar_font_size: 16,
            outline_side: "left".to_string(),
            language: "en".to_string(),
        },
        files: Files {
            visible_exts: vec!["md".to_string(), "txt".to_string()],
            show_hidden: true,
            exclude: vec!["secrets".to_string()],
            watcher_exclude: vec!["logs".to_string(), "tmp".to_string()],
            terminal_path: "custom-terminal".to_string(),
            terminal_args: "--cwd {dir}".to_string(),
        },
        watching: Watching {
            enable_watcher: false,
            auto_save: AutoSave::OnFocusLost,
            auto_save_delay_ms: 800,
        },
        search: Search {
            exclude: vec!["dist".to_string()],
            max_file_size_mb: 8,
            max_results: 500,
        },
        editor: Editor {
            font_size: 18,
            tab_size: 2,
            word_wrap: false,
            line_numbers: false,
            large_file_mb: 12,
        },
        keybindings: Keybindings {
            active_scheme: "ultra.eclipse".to_string(),
            schemes: [(
                "ultra.eclipse".to_string(),
                vec![
                    Keybinding {
                        command_id: "file.save".to_string(),
                        sequence: "Ctrl+Alt+S".to_string(),
                        ..Keybinding::default()
                    },
                    Keybinding {
                        command_id: "workspace.open".to_string(),
                        sequence: "Ctrl+Shift+O".to_string(),
                        ..Keybinding::default()
                    },
                ],
            )]
            .into_iter()
            .collect(),
            overrides: BTreeMap::new(),
        },
        recovery: Recovery {
            confirm_close_dirty: false,
            crash_recovery: false,
            create_project_settings: true,
        },
        window: settings::Window {
            reuse_window_for_folder: true,
        },
    };
    save(&dir, &original).unwrap();
    // 零漂移：加载回来的设置与原值全等
    let loaded = load_global_checked(&dir);
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    assert_eq!(loaded.settings, original);
    // 字节级确定性：重复保存产生逐字节相同的文件（BTreeMap 键序稳定）
    let first = std::fs::read_to_string(global_settings_path(&dir)).unwrap();
    save(&dir, &original).unwrap();
    let second = std::fs::read_to_string(global_settings_path(&dir)).unwrap();
    assert_eq!(first, second);
    assert!(first.starts_with('{') && first.ends_with("}\n"));
    cleanup(&dir);
}

#[test]
fn v1_roundtrip_默认设置_保存加载零漂移() {
    let dir = temp_dir("roundtrip-default");
    save(&dir, &Settings::default()).unwrap();
    let loaded = load_global_checked(&dir);
    assert!(loaded.warnings.is_empty());
    assert_eq!(loaded.settings, Settings::default());
    cleanup(&dir);
}

// ---------- 项目设置 ----------

#[test]
fn 项目设置_无文件返回none_有文件解析为补丁() {
    let dir = temp_dir("project");
    assert!(load_project(&dir).is_none());
    assert!(load_project_checked(&dir).is_none());

    write_json(
        &project_settings_path(&dir),
        r#"{ "version": 1, "editor": { "fontSize": 22 } }"#,
    );
    let loaded = load_project_checked(&dir).unwrap();
    assert!(
        loaded.warnings.iter().any(|w| w.contains("v1→v2")),
        "{:?}",
        loaded.warnings
    );
    assert_eq!(loaded.patch.editor.as_ref().unwrap().font_size, Some(22));
    // 未出现的类别为 None（沿用全局）
    assert!(loaded.patch.appearance.is_none());
    cleanup(&dir);
}

#[test]
fn 项目设置_补丁保存加载roundtrip且只落盘覆盖项() {
    let dir = temp_dir("project-roundtrip");
    let patch = SettingsPatch {
        version: Some(SCHEMA_VERSION),
        search: Some(SearchPatch {
            exclude: Some(vec!["vendor".to_string()]),
            max_file_size_mb: Some(3),
            ..SearchPatch::default()
        }),
        recovery: Some(RecoveryPatch {
            create_project_settings: Some(true),
            ..RecoveryPatch::default()
        }),
        ..SettingsPatch::default()
    };
    // 自动创建 .glancemd 目录
    assert!(!dir.join(PROJECT_SETTINGS_DIR).exists());
    save_project(&dir, &patch).unwrap();
    assert!(dir
        .join(PROJECT_SETTINGS_DIR)
        .join(SETTINGS_FILE_NAME)
        .is_file());

    let text = std::fs::read_to_string(project_settings_path(&dir)).unwrap();
    assert!(!text.contains("appearance"), "None 字段不应落盘：{text}");
    assert!(!text.contains("maxResults"), "None 字段不应落盘：{text}");

    let loaded = load_project_checked(&dir).unwrap();
    assert_eq!(loaded.patch, patch);
    // 与合并引擎串联：覆盖生效
    let merged = effective(&Settings::default(), &loaded.patch);
    assert_eq!(merged.search.max_file_size_mb, 3);
    assert_eq!(
        merged.search.max_results,
        Settings::default().search.max_results
    );
    assert_eq!(merged.search.exclude, vec!["vendor".to_string()]);
    cleanup(&dir);
}

#[test]
fn 项目设置_版本过新_整体忽略并告警() {
    let dir = temp_dir("project-future");
    let future = SCHEMA_VERSION + 1;
    write_json(
        &project_settings_path(&dir),
        &format!(r#"{{ "version": {future}, "editor": {{ "fontSize": 30 }} }}"#),
    );
    let loaded = load_project_checked(&dir).unwrap();
    assert_eq!(loaded.patch, SettingsPatch::default());
    assert!(
        loaded.warnings[0].contains(&future.to_string()),
        "{}",
        loaded.warnings[0]
    );
    // 损坏 JSON → 空补丁 + 告警
    let dir2 = temp_dir("project-corrupt");
    write_json(&project_settings_path(&dir2), "[[[");
    let loaded = load_project_checked(&dir2).unwrap();
    assert_eq!(loaded.patch, SettingsPatch::default());
    assert!(
        loaded.warnings[0].contains("解析失败"),
        "{}",
        loaded.warnings[0]
    );
    cleanup(&dir);
    cleanup(&dir2);
}

#[test]
fn 项目设置_未知键_收集进告警() {
    let dir = temp_dir("project-unknown");
    write_json(
        &project_settings_path(&dir),
        r#"{ "editor": { "fontSize": 15, "lineHeight": 1.5 }, "wat": {} }"#,
    );
    let loaded = load_project_checked(&dir).unwrap();
    assert_eq!(loaded.patch.editor.as_ref().unwrap().font_size, Some(15));
    assert!(
        loaded
            .warnings
            .iter()
            .any(|w| w.contains("editor.lineHeight")),
        "{:?}",
        loaded.warnings
    );
    assert!(
        loaded.warnings.iter().any(|w| w.contains("wat")),
        "{:?}",
        loaded.warnings
    );
    cleanup(&dir);
}

#[test]
fn 项目设置_window分类被忽略并明确告警() {
    let dir = temp_dir("project-window-global-only");
    let project = dir.join("project");
    std::fs::create_dir_all(project.join(PROJECT_SETTINGS_DIR)).unwrap();
    std::fs::write(
        project_settings_path(&project),
        r#"{"version":1,"window":{"reuseWindowForFolder":true}}"#,
    )
    .unwrap();

    let loaded = load_project_checked(&project).unwrap();
    assert_eq!(loaded.patch.version, Some(1));
    assert!(loaded.patch.appearance.is_none());
    assert!(loaded.patch.files.is_none());
    assert!(loaded.patch.watching.is_none());
    assert!(loaded.patch.search.is_none());
    assert!(loaded.patch.editor.is_none());
    assert!(loaded.patch.keybindings.is_none());
    assert!(loaded.patch.recovery.is_none());
    assert!(loaded
        .warnings
        .iter()
        .any(|w| w.contains("window") && w.contains("全局设置")));
    cleanup(&dir);
}

#[test]
fn 端到端_全局加载_项目覆盖_合并_保存有效值() {
    // 全局：主题 dark、字号 20
    let global_dir = temp_dir("e2e-global");
    write_json(
        &global_settings_path(&global_dir),
        r#"{ "version": 1, "appearance": { "theme": "dark" }, "editor": { "fontSize": 20 } }"#,
    );
    let global = load_global(&global_dir);
    // 项目：只覆盖字号
    let project_dir = temp_dir("e2e-project");
    write_json(
        &project_settings_path(&project_dir),
        r#"{ "version": 1, "editor": { "fontSize": 12 } }"#,
    );
    let patch = load_project(&project_dir).unwrap();
    let merged = effective(&global, &patch);
    assert_eq!(merged.appearance.theme, Theme::Dark);
    assert_eq!(merged.editor.font_size, 12);
    assert_eq!(merged.editor.tab_size, 4);
    // 有效值可直接保存回全局（含 version）
    let out_dir = temp_dir("e2e-out");
    save(&out_dir, &merged).unwrap();
    assert_eq!(load_global(&out_dir), merged);
    cleanup(&global_dir);
    cleanup(&project_dir);
    cleanup(&out_dir);
}

#[test]
fn outline位置_非法值加载回退并告警_保存拒绝() {
    let dir = temp_dir("outline-side-validation");
    write_json(
        &global_settings_path(&dir),
        r#"{ "version": 1, "appearance": { "outlineSide": "middle" } }"#,
    );
    let loaded = load_global_checked(&dir);
    assert_eq!(loaded.settings.appearance.outline_side, "right");
    assert!(loaded.warnings.iter().any(|w| w.contains("outlineSide")));
    let invalid = Settings {
        appearance: Appearance {
            outline_side: "middle".to_string(),
            ..Appearance::default()
        },
        ..Settings::default()
    };
    assert!(save(&dir, &invalid).is_err());
    cleanup(&dir);
}

#[test]
fn sidebar字号_超出范围加载回退并告警_保存拒绝() {
    let dir = temp_dir("sidebar-font-size-validation");
    write_json(
        &global_settings_path(&dir),
        r#"{ "version": 1, "appearance": { "sidebarFontSize": 19 } }"#,
    );
    let loaded = load_global_checked(&dir);
    assert_eq!(loaded.settings.appearance.sidebar_font_size, 14);
    assert!(loaded
        .warnings
        .iter()
        .any(|w| w.contains("sidebarFontSize")));
    let invalid = Settings {
        appearance: Appearance {
            sidebar_font_size: 11,
            ..Appearance::default()
        },
        ..Settings::default()
    };
    assert!(save(&dir, &invalid).is_err());
    cleanup(&dir);
}

#[test]
fn overridden_keys_只返回真实显式字段() {
    let patch = SettingsPatch {
        appearance: Some(AppearancePatch {
            sidebar_font_size: Some(16),
            outline_side: Some("left".to_string()),
            ..AppearancePatch::default()
        }),
        files: Some(FilesPatch {
            show_hidden: Some(true),
            ..FilesPatch::default()
        }),
        ..SettingsPatch::default()
    };
    assert_eq!(
        settings::overridden_keys(&patch),
        vec![
            "appearance.sidebarFontSize".to_string(),
            "appearance.outlineSide".to_string(),
            "files.showHidden".to_string()
        ]
    );
}
