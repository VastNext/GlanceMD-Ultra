//! 命令注册表：以字符串命令 ID（命名空间式，如 `file.open`、`workspace.open`）
//! 为唯一键的进程级命令表。
//!
//! 约定（详见 `docs/dev/interfaces.md`）：
//! - 内置命令在 `main()` 启动时经 [`register_builtin`] 注册一次；
//! - IPC 消息中的命令经 [`dispatch`] 按命令 ID 分发；
//! - 菜单、按钮、快捷键、命令面板（后续阶段）只引用命令 ID，不直接调用处理函数。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::json;
use tao::window::Window;
use wry::WebView;

use crate::file_ops;
use crate::ipc;
use crate::state::AppState;
use crate::workspace;

/// 命令处理函数签名：纯函数指针，注册表可跨线程共享。
pub type CommandHandler = fn(&CommandContext, &CommandPayload);

/// 一次命令调用所需的宿主环境（主线程上的 WebView 与窗口、共享应用状态）。
pub struct CommandContext<'a> {
    pub webview: &'a WebView,
    pub window: &'a Window,
    /// 阶段 0 的内置命令尚未读取应用状态，为阶段 1+ 的命令（会话恢复等）保留。
    #[allow(dead_code)]
    pub state: &'a Arc<Mutex<AppState>>,
}

/// IPC 消息中除命令 ID 之外的可选字段（与上行 JSON 信封一一对应；
/// 阶段 0 仅 `path` 被消费，其余字段供后续阶段命令使用）。
#[derive(Debug, Default, Clone)]
pub struct CommandPayload {
    #[allow(dead_code)]
    pub content: Option<String>,
    pub path: Option<String>,
    #[allow(dead_code)]
    pub title: Option<String>,
    #[allow(dead_code)]
    pub dirty: Option<bool>,
}

#[derive(Debug)]
pub enum CommandError {
    /// 分发了未注册的命令 ID
    Unknown(String),
    /// 同一命令 ID 重复注册
    AlreadyRegistered(String),
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CommandError::Unknown(id) => write!(f, "未知命令: {id}"),
            CommandError::AlreadyRegistered(id) => write!(f, "命令重复注册: {id}"),
        }
    }
}

pub struct CommandRegistry {
    handlers: HashMap<String, CommandHandler>,
}

// 实例方法中的部分（dispatch/contains/ids）当前仅测试与后续阶段（菜单/命令面板
// 枚举命令）消费，非测试构建暂不可达。
#[allow(dead_code)]
impl CommandRegistry {
    pub fn new() -> Self {
        Self {
            handlers: HashMap::new(),
        }
    }

    /// 注册命令；同一 ID 重复注册报错（内置命令的幂等引导见 [`register_builtin`]）。
    pub fn register(&mut self, id: &str, handler: CommandHandler) -> Result<(), CommandError> {
        if self.handlers.contains_key(id) {
            return Err(CommandError::AlreadyRegistered(id.to_string()));
        }
        self.handlers.insert(id.to_string(), handler);
        Ok(())
    }

    /// 按命令 ID 查找处理函数；未知命令报错。
    pub fn lookup(&self, id: &str) -> Result<CommandHandler, CommandError> {
        self.handlers
            .get(id)
            .copied()
            .ok_or_else(|| CommandError::Unknown(id.to_string()))
    }

    /// 分发命令：查表后以宿主上下文调用处理函数（锁在查表后即释放，允许嵌套分发）。
    pub fn dispatch(
        &self,
        id: &str,
        payload: &CommandPayload,
        ctx: &CommandContext,
    ) -> Result<(), CommandError> {
        let handler = self.lookup(id)?;
        handler(ctx, payload);
        Ok(())
    }

    pub fn contains(&self, id: &str) -> bool {
        self.handlers.contains_key(id)
    }

    /// 全部命令 ID（字典序），供测试与后续命令面板枚举。
    pub fn ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = self.handlers.keys().map(String::as_str).collect();
        ids.sort_unstable();
        ids
    }
}

impl Default for CommandRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// 全局注册表（进程唯一，保证命令 ID 全局唯一）。
fn global() -> &'static Mutex<CommandRegistry> {
    static REGISTRY: OnceLock<Mutex<CommandRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(CommandRegistry::new()))
}

/// 向全局注册表注册命令。
pub fn register(id: &str, handler: CommandHandler) -> Result<(), CommandError> {
    global().lock().unwrap().register(id, handler)
}

/// 经全局注册表分发命令；失败只返回错误，由调用方决定如何呈现。
pub fn dispatch(
    id: &str,
    payload: &CommandPayload,
    ctx: &CommandContext,
) -> Result<(), CommandError> {
    let handler = global().lock().unwrap().lookup(id)?;
    handler(ctx, payload);
    Ok(())
}

/// 注册内置命令。可安全地多次调用（幂等引导：重复注册被忽略）。
pub fn register_builtin() {
    let _ = register("file.open", open_file);
    let _ = register("workspace.open", workspace_open);
}

/// `file.open`（wire 命令 `open_file`）：读取指定路径或弹出文件选择对话框。
///
/// 逻辑自 `ipc.rs` 原 "open_file" 分支逐行迁移，行为必须保持一致。
fn open_file(ctx: &CommandContext, payload: &CommandPayload) {
    let path = payload.path.clone().or_else(file_ops::pick_open_file);
    if let Some(p) = path {
        match file_ops::read_file(&p) {
            Ok(contents) => {
                ipc::send_to_js(
                    ctx.webview,
                    "file_opened",
                    &json!({
                        "content": contents,
                        "path": p
                    }),
                );
                // 单实例转发/拖放打开时确保窗口前置
                ctx.window.set_minimized(false);
                ctx.window.set_focus();
            }
            Err(e) => ipc::send_to_js(
                ctx.webview,
                "error",
                &json!({
                    "message": format!("Failed to open file: {e}")
                }),
            ),
        }
    }
}

/// `workspace.open`（wire 命令 `workspace.open`）：打开可信项目根并后台扫描。
fn workspace_open(_ctx: &CommandContext, payload: &CommandPayload) {
    match payload.path.as_deref() {
        Some(path) => {
            let _ = workspace::open_and_scan(path);
        }
        None => workspace::emit_error("workspace.open 缺少 path 参数".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noop(_ctx: &CommandContext, _payload: &CommandPayload) {}

    #[test]
    fn 注册后的命令可查表命中() {
        let mut registry = CommandRegistry::new();
        registry.register("demo.ok", noop).unwrap();
        assert!(registry.contains("demo.ok"));
        assert!(registry.lookup("demo.ok").is_ok());
    }

    #[test]
    fn 未知命令返回_unknown_错误() {
        let registry = CommandRegistry::new();
        match registry.lookup("demo.missing") {
            Err(CommandError::Unknown(id)) => assert_eq!(id, "demo.missing"),
            other => panic!("期望 Unknown 错误，实际 {other:?}"),
        }
    }

    #[test]
    fn 重复注册返回_already_registered_错误() {
        let mut registry = CommandRegistry::new();
        registry.register("demo.dup", noop).unwrap();
        match registry.register("demo.dup", noop) {
            Err(CommandError::AlreadyRegistered(id)) => assert_eq!(id, "demo.dup"),
            other => panic!("期望 AlreadyRegistered 错误，实际 {other:?}"),
        }
    }

    #[test]
    fn ids_返回字典序命令清单() {
        let mut registry = CommandRegistry::new();
        registry.register("b.two", noop).unwrap();
        registry.register("a.one", noop).unwrap();
        assert_eq!(registry.ids(), vec!["a.one", "b.two"]);
    }

    #[test]
    fn 内置命令注册到全局注册表且引导幂等() {
        register_builtin();
        register_builtin();
        assert!(global().lock().unwrap().contains("file.open"));
        assert!(global().lock().unwrap().contains("workspace.open"));
    }
}
