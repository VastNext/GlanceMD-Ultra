//! 设置 schema v1、加载/保存、字段级合并引擎与迁移框架（主实施计划阶段 5 的
//! Rust 侧核心）。
//!
//! 分类对齐产品架构方案 §7.1 的七类：`appearance`（外观与布局）、
//! `files`（文件类型、隐藏文件和排除规则）、`watching`（文件监听与自动保存）、
//! `search`（搜索）、`editor`（编辑器与大文件模式）、`keybindings`（快捷键）、
//! `recovery`（恢复与启动行为）。
//!
//! 自包含模块：只依赖 `std` / `serde` / `serde_json`，不引用 `crate::` 路径，
//! 可在 `tests/settings_probe.rs` 中以 `#[path]` 引入独立编译测试（纯 bin crate
//! 可测性模式，与 `tests/platform_probe.rs` 同款约定）。集成时由
//! `workspace/mod.rs` 声明 `pub mod settings;`；命令粘合层（CommandContext
//! handler）由主 Agent 统一编写，命令/事件/路径契约见
//! `docs/dev/contracts/settings.md`。
//!
//! 向后兼容优先：未知键不拒绝（不使用 `deny_unknown_fields`），收集进
//! warnings 返回；损坏文件回退默认设置而不阻断启动。
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 当前 schema 版本。升级 schema 时递增，并在 [`MIGRATION_STEPS`] 登记迁移步骤。
pub const SCHEMA_VERSION: u32 = 1;

/// 设置文件名（全局与项目设置同名，靠所在目录区分）。
pub const SETTINGS_FILE_NAME: &str = "settings.json";

/// 项目设置目录名（位于项目根下），与主计划"`.glancemd/settings.json`"一致。
pub const PROJECT_SETTINGS_DIR: &str = ".glancemd";

// ---------------------------------------------------------------------------
// 路径约定（base_dir / root 均由调用方注入；生产环境取值见契约文档）
// ---------------------------------------------------------------------------

/// 全局设置文件路径：`{base_dir}/settings.json`。
///
/// 生产环境 `base_dir` 由粘合层注入 `dirs::config_dir()/glancemd-ultra`；
/// 探针测试注入临时目录（本模块不触碰真实配置目录）。
pub fn global_settings_path(base_dir: &Path) -> PathBuf {
    base_dir.join(SETTINGS_FILE_NAME)
}

/// 项目设置文件路径：`{root}/.glancemd/settings.json`。
pub fn project_settings_path(root: &Path) -> PathBuf {
    root.join(PROJECT_SETTINGS_DIR).join(SETTINGS_FILE_NAME)
}

// ---------------------------------------------------------------------------
// Schema v1（具体值类型：全局设置与合并后的有效设置）
// ---------------------------------------------------------------------------

/// 完整设置（schema v1，带版本字段）。既用于全局设置，也用于合并后的有效设置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// schema 版本；加载时经迁移框架归一到 [`SCHEMA_VERSION`]，保存时随之写出。
    pub version: u32,
    /// 外观与布局。
    pub appearance: Appearance,
    /// 文件类型、隐藏文件和排除规则。
    pub files: Files,
    /// 文件监听与自动保存。
    pub watching: Watching,
    /// 搜索。
    pub search: Search,
    /// 编辑器与大文件模式。
    pub editor: Editor,
    /// 快捷键。
    pub keybindings: Keybindings,
    /// 恢复与启动行为。
    pub recovery: Recovery,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            version: SCHEMA_VERSION,
            appearance: Appearance::default(),
            files: Files::default(),
            watching: Watching::default(),
            search: Search::default(),
            editor: Editor::default(),
            keybindings: Keybindings::default(),
            recovery: Recovery::default(),
        }
    }
}

/// 外观与布局（方案 §7.1 类 1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Appearance {
    /// 主题：`light` | `dark` | `system`。默认 `light`，与基线行为一致
    /// （app.js 启动时 `setTheme(saved || 'light')`）；`system` 随阶段 5 前端生效。
    pub theme: Theme,
    /// 侧栏（资源管理器 / Outline）基准字号（px）。默认 14，各面板字号按
    /// calc 比例换算后视觉 ≈ 基线（树行 13px / 面板标题 11px / 空态 12px）。
    pub sidebar_font_size: u32,
}

impl Default for Appearance {
    fn default() -> Self {
        Appearance {
            theme: Theme::Light,
            sidebar_font_size: 14,
        }
    }
}

/// 主题取值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    Light,
    Dark,
    System,
}

impl Default for Theme {
    fn default() -> Self {
        Theme::Light
    }
}

/// 文件类型、隐藏文件和排除规则（方案 §7.1 类 2）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Files {
    /// 项目树可见扩展名（不带点、小写）。默认为主计划阶段 1 清单
    /// （`.md .markdown .txt .json .yaml .yml .toml .ini .csv`）。
    pub visible_exts: Vec<String>,
    /// 是否显示隐藏文件（主计划阶段 1：默认隐藏）。
    pub show_hidden: bool,
    /// 项目树浏览排除规则（目录名/路径段）。默认与 [`Files::watcher_exclude`]
    /// 相同（主计划阶段 1 清单）。
    pub exclude: Vec<String>,
    /// 文件监听排除规则——主计划阶段 2 点名的字面键 `files.watcherExclude`。
    pub watcher_exclude: Vec<String>,
}

impl Default for Files {
    fn default() -> Self {
        Files {
            visible_exts: default_visible_exts(),
            show_hidden: false,
            exclude: default_exclude_dirs(),
            watcher_exclude: default_exclude_dirs(),
        }
    }
}

/// 文件监听与自动保存（方案 §7.1 类 3）。监听排除规则在 [`Files::watcher_exclude`]
/// （保持与主计划阶段 2 的字面键名一致），本类承载监听/保存的行为开关。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Watching {
    /// 是否启用文件监听。默认开；关闭后打开项目不启动监听、运行中变更
    /// 自动 pause/resume（接线见 commands.rs，阶段 5+）。
    pub enable_watcher: bool,
    /// 自动保存模式（阶段 6 生效）：`off` | `afterDelay` | `onFocusLost`，默认关闭。
    pub auto_save: AutoSave,
    /// `afterDelay` 模式的延时（毫秒）。
    pub auto_save_delay_ms: u64,
}

impl Default for Watching {
    fn default() -> Self {
        Watching {
            enable_watcher: true,
            auto_save: AutoSave::Off,
            auto_save_delay_ms: 1000,
        }
    }
}

/// 自动保存模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutoSave {
    Off,
    AfterDelay,
    OnFocusLost,
}

impl Default for AutoSave {
    fn default() -> Self {
        AutoSave::Off
    }
}

/// 搜索（方案 §7.1 类 4）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Search {
    /// 搜索排除 glob（主计划阶段 4 的 `search.exclude`）。默认值与文件排除
    /// 清单一致；条目按 glob 语义匹配（匹配规则由搜索模块实现，通常按路径段）。
    pub exclude: Vec<String>,
    /// 跳过超过该大小（MB）的文件（主计划阶段 4：">5 MB 或阈值可配置"）。
    #[serde(rename = "maxFileSizeMB")]
    pub max_file_size_mb: u64,
    /// 结果数上限。
    pub max_results: usize,
}

impl Default for Search {
    fn default() -> Self {
        Search {
            exclude: default_exclude_dirs(),
            max_file_size_mb: 5,
            max_results: 2000,
        }
    }
}

/// 编辑器与大文件模式（方案 §7.1 类 5）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Editor {
    /// 编辑区字号（px）。默认 14，与基线样式一致。
    pub font_size: u32,
    /// Tab 宽度（空格数）。默认 4，与基线 `tab-size: 4` 一致。
    pub tab_size: u32,
    /// 自动换行。默认开，与基线编辑区 `pre-wrap` 一致。
    pub word_wrap: bool,
    /// 显示行号（基线暂无行号渲染，随阶段 5+ 编辑器增强生效）。
    pub line_numbers: bool,
    /// 大文件模式阈值（MB；主计划阶段 6：">5 MB（可配置）禁用实时预览"等）。
    #[serde(rename = "largeFileMB")]
    pub large_file_mb: u64,
}

impl Default for Editor {
    fn default() -> Self {
        Editor {
            font_size: 14,
            tab_size: 4,
            word_wrap: true,
            line_numbers: true,
            large_file_mb: 5,
        }
    }
}

/// 快捷键（方案 §7.1 类 6）。v1 仅保留覆盖表占位；组合键格式与冲突检测
/// 由阶段 5 快捷键流实现（格式约定见契约文档）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Keybindings {
    /// 命令 ID → canonical 组合键（如 `"file.save" → "Ctrl+S"`）。
    /// 使用 `BTreeMap` 保证序列化键序稳定（roundtrip 零漂移）。
    pub overrides: BTreeMap<String, String>,
}

/// 恢复与启动行为（方案 §7.1 类 7）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Recovery {
    /// 退出/切换项目存在未保存修改时弹出确认对话框（阶段 6 生效；保护性默认开）。
    pub confirm_close_dirty: bool,
    /// 崩溃恢复开关：编辑内容周期性写入恢复区（阶段 6 生效）。
    pub crash_recovery: bool,
    /// 打开工作区时是否自动创建 `.glancemd/settings.json`
    /// （方案 §7.1："是否自动创建由用户设置决定"；默认不自动创建，与现状一致）。
    pub create_project_settings: bool,
}

impl Default for Recovery {
    fn default() -> Self {
        Recovery {
            confirm_close_dirty: true,
            crash_recovery: true,
            create_project_settings: false,
        }
    }
}

/// 项目树可见扩展名默认值（主计划阶段 1 清单）。
fn default_visible_exts() -> Vec<String> {
    [
        "md", "markdown", "txt", "json", "yaml", "yml", "toml", "ini", "csv",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// 排除规则默认值（主计划阶段 1 清单；阶段 2/4 沿用同一组目录）。
fn default_exclude_dirs() -> Vec<String> {
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

// ---------------------------------------------------------------------------
// 项目设置补丁（可选字段镜像：Some = 项目显式覆盖，None = 沿用全局）
// ---------------------------------------------------------------------------

/// 项目设置补丁：[`Settings`] 的全可选镜像。由 [`load_project`] 解析、
/// [`effective`] 消费、[`is_overridden`] 查询；序列化时省略 `None` 字段，
/// 项目文件只落盘显式覆盖项。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SettingsPatch {
    /// 项目文件自报版本；合并时不消费（合并对象是已迁移到当前版本的全局值），
    /// 仅在项目文件版本高于 [`SCHEMA_VERSION`] 时触发整体忽略守卫。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub appearance: Option<AppearancePatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<FilesPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub watching: Option<WatchingPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<SearchPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor: Option<EditorPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keybindings: Option<KeybindingsPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<RecoveryPatch>,
}

/// [`Appearance`] 的补丁镜像。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppearancePatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<Theme>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidebar_font_size: Option<u32>,
}

/// [`Files`] 的补丁镜像。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FilesPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible_exts: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub watcher_exclude: Option<Vec<String>>,
}

/// [`Watching`] 的补丁镜像。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WatchingPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_watcher: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_save: Option<AutoSave>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_save_delay_ms: Option<u64>,
}

/// [`Search`] 的补丁镜像。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SearchPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude: Option<Vec<String>>,
    #[serde(rename = "maxFileSizeMB", skip_serializing_if = "Option::is_none")]
    pub max_file_size_mb: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_results: Option<usize>,
}

/// [`Editor`] 的补丁镜像。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EditorPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub word_wrap: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_numbers: Option<bool>,
    #[serde(rename = "largeFileMB", skip_serializing_if = "Option::is_none")]
    pub large_file_mb: Option<u64>,
}

/// [`Keybindings`] 的补丁镜像。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct KeybindingsPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overrides: Option<BTreeMap<String, String>>,
}

/// [`Recovery`] 的补丁镜像。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RecoveryPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirm_close_dirty: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crash_recovery: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_project_settings: Option<bool>,
}

// ---------------------------------------------------------------------------
// 合并引擎
// ---------------------------------------------------------------------------

/// 合并引擎：项目设置按**字段级**覆盖全局——补丁中 `Some` 的字段覆盖全局对应
/// 字段，`None` 保留全局值；`Vec` / `BTreeMap` 为**整体替换**（不做并集合并）。
/// 返回结果的 `version` 恒为 [`SCHEMA_VERSION`]。
pub fn effective(global: &Settings, project: &SettingsPatch) -> Settings {
    Settings {
        version: SCHEMA_VERSION,
        appearance: Appearance {
            theme: project
                .appearance
                .as_ref()
                .and_then(|a| a.theme)
                .unwrap_or(global.appearance.theme),
            sidebar_font_size: opt_or(
                project
                    .appearance
                    .as_ref()
                    .and_then(|a| a.sidebar_font_size),
                global.appearance.sidebar_font_size,
            ),
        },
        files: Files {
            visible_exts: opt_or(
                project.files.as_ref().and_then(|f| f.visible_exts.clone()),
                global.files.visible_exts.clone(),
            ),
            show_hidden: opt_or(
                project.files.as_ref().and_then(|f| f.show_hidden),
                global.files.show_hidden,
            ),
            exclude: opt_or(
                project.files.as_ref().and_then(|f| f.exclude.clone()),
                global.files.exclude.clone(),
            ),
            watcher_exclude: opt_or(
                project
                    .files
                    .as_ref()
                    .and_then(|f| f.watcher_exclude.clone()),
                global.files.watcher_exclude.clone(),
            ),
        },
        watching: Watching {
            enable_watcher: opt_or(
                project.watching.as_ref().and_then(|w| w.enable_watcher),
                global.watching.enable_watcher,
            ),
            auto_save: opt_or(
                project.watching.as_ref().and_then(|w| w.auto_save),
                global.watching.auto_save,
            ),
            auto_save_delay_ms: opt_or(
                project.watching.as_ref().and_then(|w| w.auto_save_delay_ms),
                global.watching.auto_save_delay_ms,
            ),
        },
        search: Search {
            exclude: opt_or(
                project.search.as_ref().and_then(|s| s.exclude.clone()),
                global.search.exclude.clone(),
            ),
            max_file_size_mb: opt_or(
                project.search.as_ref().and_then(|s| s.max_file_size_mb),
                global.search.max_file_size_mb,
            ),
            max_results: opt_or(
                project.search.as_ref().and_then(|s| s.max_results),
                global.search.max_results,
            ),
        },
        editor: Editor {
            font_size: opt_or(
                project.editor.as_ref().and_then(|e| e.font_size),
                global.editor.font_size,
            ),
            tab_size: opt_or(
                project.editor.as_ref().and_then(|e| e.tab_size),
                global.editor.tab_size,
            ),
            word_wrap: opt_or(
                project.editor.as_ref().and_then(|e| e.word_wrap),
                global.editor.word_wrap,
            ),
            line_numbers: opt_or(
                project.editor.as_ref().and_then(|e| e.line_numbers),
                global.editor.line_numbers,
            ),
            large_file_mb: opt_or(
                project.editor.as_ref().and_then(|e| e.large_file_mb),
                global.editor.large_file_mb,
            ),
        },
        keybindings: Keybindings {
            overrides: opt_or(
                project
                    .keybindings
                    .as_ref()
                    .and_then(|k| k.overrides.clone()),
                global.keybindings.overrides.clone(),
            ),
        },
        recovery: Recovery {
            confirm_close_dirty: opt_or(
                project
                    .recovery
                    .as_ref()
                    .and_then(|r| r.confirm_close_dirty),
                global.recovery.confirm_close_dirty,
            ),
            crash_recovery: opt_or(
                project.recovery.as_ref().and_then(|r| r.crash_recovery),
                global.recovery.crash_recovery,
            ),
            create_project_settings: opt_or(
                project
                    .recovery
                    .as_ref()
                    .and_then(|r| r.create_project_settings),
                global.recovery.create_project_settings,
            ),
        },
    }
}

/// `Some(v)` 取覆盖值，否则取回退值（合并引擎的字段级原语）。
fn opt_or<T>(overridden: Option<T>, fallback: T) -> T {
    match overridden {
        Some(v) => v,
        None => fallback,
    }
}

/// 查询项目补丁是否覆盖了某个设置键，供设置 UI 显示"项目已覆盖"徽标。
///
/// `key_path` 使用 JSON 键名：字段级形如 `"appearance.theme"`、
/// `"files.watcherExclude"`；类级形如 `"files"`（该类任一字段被覆盖即为 true）。
/// 未知键路径一律返回 `false`。
pub fn is_overridden(project: &SettingsPatch, key_path: &str) -> bool {
    let Some((category, field)) = key_path.split_once('.') else {
        return match key_path {
            "appearance" => project.appearance.is_some(),
            "files" => project.files.is_some(),
            "watching" => project.watching.is_some(),
            "search" => project.search.is_some(),
            "editor" => project.editor.is_some(),
            "keybindings" => project.keybindings.is_some(),
            "recovery" => project.recovery.is_some(),
            _ => false,
        };
    };
    match (category, field) {
        ("appearance", "theme") => project
            .appearance
            .as_ref()
            .is_some_and(|a| a.theme.is_some()),
        ("appearance", "sidebarFontSize") => project
            .appearance
            .as_ref()
            .is_some_and(|a| a.sidebar_font_size.is_some()),
        ("files", "visibleExts") => project
            .files
            .as_ref()
            .is_some_and(|f| f.visible_exts.is_some()),
        ("files", "showHidden") => project
            .files
            .as_ref()
            .is_some_and(|f| f.show_hidden.is_some()),
        ("files", "exclude") => project.files.as_ref().is_some_and(|f| f.exclude.is_some()),
        ("files", "watcherExclude") => project
            .files
            .as_ref()
            .is_some_and(|f| f.watcher_exclude.is_some()),
        ("watching", "enableWatcher") => project
            .watching
            .as_ref()
            .is_some_and(|w| w.enable_watcher.is_some()),
        ("watching", "autoSave") => project
            .watching
            .as_ref()
            .is_some_and(|w| w.auto_save.is_some()),
        ("watching", "autoSaveDelayMs") => project
            .watching
            .as_ref()
            .is_some_and(|w| w.auto_save_delay_ms.is_some()),
        ("search", "exclude") => project.search.as_ref().is_some_and(|s| s.exclude.is_some()),
        ("search", "maxFileSizeMB") => project
            .search
            .as_ref()
            .is_some_and(|s| s.max_file_size_mb.is_some()),
        ("search", "maxResults") => project
            .search
            .as_ref()
            .is_some_and(|s| s.max_results.is_some()),
        ("editor", "fontSize") => project
            .editor
            .as_ref()
            .is_some_and(|e| e.font_size.is_some()),
        ("editor", "tabSize") => project
            .editor
            .as_ref()
            .is_some_and(|e| e.tab_size.is_some()),
        ("editor", "wordWrap") => project
            .editor
            .as_ref()
            .is_some_and(|e| e.word_wrap.is_some()),
        ("editor", "lineNumbers") => project
            .editor
            .as_ref()
            .is_some_and(|e| e.line_numbers.is_some()),
        ("editor", "largeFileMB") => project
            .editor
            .as_ref()
            .is_some_and(|e| e.large_file_mb.is_some()),
        ("keybindings", "overrides") => project
            .keybindings
            .as_ref()
            .is_some_and(|k| k.overrides.is_some()),
        ("recovery", "confirmCloseDirty") => project
            .recovery
            .as_ref()
            .is_some_and(|r| r.confirm_close_dirty.is_some()),
        ("recovery", "crashRecovery") => project
            .recovery
            .as_ref()
            .is_some_and(|r| r.crash_recovery.is_some()),
        ("recovery", "createProjectSettings") => project
            .recovery
            .as_ref()
            .is_some_and(|r| r.create_project_settings.is_some()),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// 加载 / 保存
// ---------------------------------------------------------------------------

/// 全局设置加载结果：设置 + 告警通道（损坏回退、未知键、迁移提示；中文文案）。
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedSettings {
    pub settings: Settings,
    pub warnings: Vec<String>,
}

/// 项目设置加载结果：`patch` 为解析出的覆盖补丁（解析失败时为空补丁）。
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedPatch {
    pub patch: SettingsPatch,
    pub warnings: Vec<String>,
}

/// 加载全局设置（丢弃告警的便捷封装；粘合层与测试需要告警通道时用
/// [`load_global_checked`]）。
pub fn load_global(base_dir: &Path) -> Settings {
    load_global_checked(base_dir).settings
}

/// 加载全局设置：
/// - 文件不存在 → 全默认、无告警；
/// - 读取/解析/迁移失败 → 全默认 + 告警（不阻断启动）；
/// - 正常加载 → 迁移到当前版本 + 未知键告警（如有）。
pub fn load_global_checked(base_dir: &Path) -> LoadedSettings {
    let path = global_settings_path(base_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return LoadedSettings {
                settings: Settings::default(),
                warnings: Vec::new(),
            };
        }
        Err(e) => {
            return LoadedSettings {
                settings: Settings::default(),
                warnings: vec![format!("读取全局设置失败：{e}，已回退默认设置")],
            };
        }
    };
    let raw: Value = match serde_json::from_str(&text) {
        Ok(raw) => raw,
        Err(e) => {
            return LoadedSettings {
                settings: Settings::default(),
                warnings: vec![format!("全局设置 JSON 解析失败：{e}，已回退默认设置")],
            };
        }
    };
    match migrate_checked(&raw) {
        Ok(migrated) => LoadedSettings {
            settings: migrated.settings,
            warnings: migrated.warnings,
        },
        Err(e) => LoadedSettings {
            settings: Settings::default(),
            warnings: vec![format!("全局设置迁移失败：{e}，已回退默认设置")],
        },
    }
}

/// 加载项目设置补丁（丢弃告警的便捷封装）。
///
/// 返回 `None` 表示无项目设置文件（完全沿用全局）。
pub fn load_project(root: &Path) -> Option<SettingsPatch> {
    load_project_checked(root).map(|loaded| loaded.patch)
}

/// 加载项目设置补丁：
/// - `.glancemd/settings.json` 不存在 → `None`；
/// - 读取/解析失败 → 空补丁 + 告警（忽略项目覆盖，不阻断）；
/// - 版本高于 [`SCHEMA_VERSION`] → 空补丁 + 告警（整体忽略，避免半新半旧的混合覆盖）；
/// - 正常加载 → 补丁 + 未知键告警（如有）。
pub fn load_project_checked(root: &Path) -> Option<LoadedPatch> {
    let path = project_settings_path(root);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => return None,
        Err(e) => {
            return Some(LoadedPatch {
                patch: SettingsPatch::default(),
                warnings: vec![format!("读取项目设置失败：{e}，已忽略项目覆盖")],
            });
        }
    };
    let raw: Value = match serde_json::from_str(&text) {
        Ok(raw) => raw,
        Err(e) => {
            return Some(LoadedPatch {
                patch: SettingsPatch::default(),
                warnings: vec![format!("项目设置 JSON 解析失败：{e}，已忽略项目覆盖")],
            });
        }
    };
    if let Some(v) = raw.get("version").and_then(Value::as_u64) {
        if v > SCHEMA_VERSION as u64 {
            return Some(LoadedPatch {
                patch: SettingsPatch::default(),
                warnings: vec![format!(
                    "项目设置文件版本 {v} 高于当前支持的 {SCHEMA_VERSION}，已忽略全部项目覆盖"
                )],
            });
        }
    }
    let mut warnings = Vec::new();
    collect_unknown_keys(&raw, &mut warnings);
    match serde_json::from_value::<SettingsPatch>(raw) {
        Ok(patch) => Some(LoadedPatch { patch, warnings }),
        Err(e) => {
            warnings.push(format!("项目设置解析失败：{e}，已忽略项目覆盖"));
            Some(LoadedPatch {
                patch: SettingsPatch::default(),
                warnings,
            })
        }
    }
}

/// 保存全局设置：pretty JSON + 末尾换行；`base_dir` 不存在时自动创建。
///
/// 原子性说明：本实现直接 `std::fs::write`（**非原子**）。阶段 6 `atomic_save`
/// 落地后，粘合层应切换为"临时文件写入 → 替换目标"路径（见契约文档）。
pub fn save(base_dir: &Path, settings: &Settings) -> std::io::Result<()> {
    write_settings_file(&global_settings_path(base_dir), settings)
}

/// 保存项目设置补丁：写入 `{root}/.glancemd/settings.json`（自动创建
/// `.glancemd` 目录）；`None` 字段不落盘，文件只包含显式覆盖项。
pub fn save_project(root: &Path, patch: &SettingsPatch) -> std::io::Result<()> {
    write_settings_file(&project_settings_path(root), patch)
}

fn write_settings_file<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let mut text = serde_json::to_string_pretty(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    text.push('\n');
    std::fs::write(path, text)
}

// ---------------------------------------------------------------------------
// 迁移框架
// ---------------------------------------------------------------------------

/// 迁移结果：迁移到当前版本的设置 + 迁移过程中的提示。
#[derive(Debug, Clone, PartialEq)]
pub struct MigratedSettings {
    pub settings: Settings,
    pub warnings: Vec<String>,
}

/// 迁移失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrateError {
    /// 文档不是 JSON 对象，或迁移后无法按 schema 解析。
    InvalidDocument(String),
    /// 文档版本高于当前支持的版本（未来版本不做降级迁移）。
    UnsupportedVersion { found: u32, current: u32 },
    /// 注册表中缺少某段版本的迁移步骤（扩展点：向 [`MIGRATION_STEPS`] 登记）。
    NoMigrationPath { from: u32, current: u32 },
}

impl std::fmt::Display for MigrateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MigrateError::InvalidDocument(detail) => {
                write!(f, "设置文档不是合法的设置对象：{detail}")
            }
            MigrateError::UnsupportedVersion { found, current } => {
                write!(
                    f,
                    "设置文档版本 {found} 高于当前支持的版本 {current}，无法迁移"
                )
            }
            MigrateError::NoMigrationPath { from, current } => {
                write!(f, "缺少从版本 {from} 到版本 {current} 的迁移步骤")
            }
        }
    }
}

impl std::error::Error for MigrateError {}

/// 单步迁移：把文档从 `from` 版本改写为 `from + 1` 版本；迁移提示写入 `warnings`。
type MigrationStep = fn(&mut Value, &mut Vec<String>);

/// 迁移步骤注册表：按起始版本升序登记 `(from_version, step)`。schema 升级到 v2
/// 时在此追加 `(1, migrate_v1_to_v2)`，[`migrate_checked`] 即沿链式步骤把旧文档
/// 逐级推进到 [`SCHEMA_VERSION`]，无需改动加载路径。
const MIGRATION_STEPS: &[(u32, MigrationStep)] = &[(0, migrate_v0_to_v1)];

/// 迁移设置文档到当前版本（丢弃告警的便捷封装，签名满足契约）。
pub fn migrate(raw: &Value) -> Result<Settings, MigrateError> {
    migrate_checked(raw).map(|migrated| migrated.settings)
}

/// 迁移设置文档到当前版本：
/// - 缺 `version`（或显式 `0`）视为 v0，沿 [`MIGRATION_STEPS`] 链式推进；
/// - `version == SCHEMA_VERSION` 直通；
/// - `version > SCHEMA_VERSION` 报 [`MigrateError::UnsupportedVersion`]；
/// - 迁移完成后统一补写版本号、收集未知键告警并按 schema 解析。
pub fn migrate_checked(raw: &Value) -> Result<MigratedSettings, MigrateError> {
    if !raw.is_object() {
        return Err(MigrateError::InvalidDocument(format!(
            "期望 JSON 对象，实际为 {raw}"
        )));
    }
    let declared = raw.get("version").and_then(Value::as_u64).map(|v| v as u32);
    if let Some(v) = declared {
        if v > SCHEMA_VERSION {
            return Err(MigrateError::UnsupportedVersion {
                found: v,
                current: SCHEMA_VERSION,
            });
        }
    }
    let mut doc = raw.clone();
    let mut warnings = Vec::new();
    let mut current = declared.unwrap_or(0);
    while current < SCHEMA_VERSION {
        match MIGRATION_STEPS.iter().find(|(from, _)| *from == current) {
            Some((_, step)) => {
                step(&mut doc, &mut warnings);
                current += 1;
            }
            None => {
                return Err(MigrateError::NoMigrationPath {
                    from: current,
                    current: SCHEMA_VERSION,
                });
            }
        }
    }
    if let Some(obj) = doc.as_object_mut() {
        obj.insert("version".to_string(), json!(SCHEMA_VERSION));
    }
    collect_unknown_keys(&doc, &mut warnings);
    let settings: Settings =
        serde_json::from_value(doc).map_err(|e| MigrateError::InvalidDocument(e.to_string()))?;
    Ok(MigratedSettings { settings, warnings })
}

/// v0 → v1 迁移规则（演练步，证明迁移框架可扩展）。
///
/// v0 特征：无 `version` 字段——v1.6.3 基线时代设置散落在 localStorage，尚无
/// 统一 settings.json；本规则处理手写/外部工具生成的无版本旧文档：
/// 1. 顶层散落的 `theme`（若为合法值）映射到 `appearance.theme` 后移除旧键；
/// 2. 补写 `version = 1`，其余字段交由 schema 默认值填充。
fn migrate_v0_to_v1(doc: &mut Value, warnings: &mut Vec<String>) {
    warnings.push("设置文档缺少 version 字段，已按 v0→v1 迁移".to_string());
    let Some(obj) = doc.as_object_mut() else {
        return;
    };
    if let Some(legacy) = obj.remove("theme") {
        match legacy.as_str() {
            Some(t @ ("dark" | "light" | "system")) => {
                warnings.push(format!("已迁移旧设置键 theme → appearance.theme（{t}）"));
                let appearance = obj.entry("appearance").or_insert_with(|| json!({}));
                if let Some(appearance_obj) = appearance.as_object_mut() {
                    appearance_obj.insert("theme".to_string(), json!(t));
                }
            }
            Some(other) => {
                warnings.push(format!("旧设置键 theme 的值“{other}”不是合法主题，已忽略"))
            }
            None => warnings.push("旧设置键 theme 的值不是字符串，已忽略".to_string()),
        }
    }
    obj.insert("version".to_string(), json!(SCHEMA_VERSION));
}

/// 已知顶层键（与 [`Settings`] 字段一一对应；全字段文档测试守护两者不失同步）。
const KNOWN_TOP_LEVEL: &[&str] = &[
    "version",
    "appearance",
    "files",
    "watching",
    "search",
    "editor",
    "keybindings",
    "recovery",
];

/// 已知类内字段（JSON 键名）。`keybindings` 不在表中：其内层键是命令 ID
/// （开放集合），不做未知键检查。
const KNOWN_CATEGORY_FIELDS: &[(&str, &[&str])] = &[
    ("appearance", &["theme", "sidebarFontSize"]),
    (
        "files",
        &["visibleExts", "showHidden", "exclude", "watcherExclude"],
    ),
    (
        "watching",
        &["autoSave", "autoSaveDelayMs", "enableWatcher"],
    ),
    ("search", &["exclude", "maxFileSizeMB", "maxResults"]),
    (
        "editor",
        &[
            "fontSize",
            "tabSize",
            "wordWrap",
            "lineNumbers",
            "largeFileMB",
        ],
    ),
    (
        "recovery",
        &[
            "confirmCloseDirty",
            "crashRecovery",
            "createProjectSettings",
        ],
    ),
];

/// 收集未知键告警（向后兼容优先：不拒绝、不删除，serde 默认忽略之）。
/// schema 深度为两层，逐层比对已知键；`keybindings` 内层不做检查。
fn collect_unknown_keys(doc: &Value, warnings: &mut Vec<String>) {
    let Some(obj) = doc.as_object() else {
        return;
    };
    for (key, value) in obj {
        if !KNOWN_TOP_LEVEL.contains(&key.as_str()) {
            warnings.push(format!("未知设置键“{key}”，已忽略"));
            continue;
        }
        let Some((_, fields)) = KNOWN_CATEGORY_FIELDS.iter().find(|(c, _)| *c == key) else {
            continue;
        };
        if let Some(fields_obj) = value.as_object() {
            for field_key in fields_obj.keys() {
                if !fields.contains(&field_key.as_str()) {
                    warnings.push(format!("未知设置键“{key}.{field_key}”，已忽略"));
                }
            }
        }
    }
}
