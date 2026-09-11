//! 翻译模块（FEAT-005）：三引擎客户端 + 分批/重试/分段 id 对齐。
//!
//! 自包含模块：只依赖 `std` / `serde` / `ureq`，不引用 `crate::` 路径，
//! 可在 `tests/translate_probe.rs` 中以 `#[path]` 引入独立编译测试（与
//! `net_probe.rs` 同款约定）。命令粘合层（`commands.rs`）把全局设置中的
//! 代理参数与 `translation` 分类字段组装为本模块的纯参数接口。
//!
//! 移植来源：VastTranslator（LexiLayer）v0.10.9 引擎层
//! （`src/background/{google,bing,openai}-client.ts`、`translate-http.ts`、
//! `retry.ts`、`batching.ts` 与 `src/shared/messages.ts`）。上游更新时需
//! 手动比对同步（漂移管理：同一逻辑双修 ≥3 次/月时评估共享内核提取）。
//!
//! 设计要点：
//! - 分段协议：请求带 `segments: [{id, text}]`，响应逐段带 id 回来；
//!   AI 引擎响应做 id 对齐校验，漏翻/错位直接报错，绝不静默展示错位译文。
//! - 分批：每批 ≤8 段且 ≤6000 字符（对齐插件 `batching.ts` 默认值）。
//! - 重试：429/5xx 可重试，指数退避 500ms×2^n 封顶 30s，`Retry-After` 优先
//!   （对齐插件 `retry.ts`）。
//! - 超时：单请求 30s（对齐插件 `translate-http.ts` 默认值），由调用方传入
//!   `net::build_agent` 的全局超时实现，本模块不自行计时。
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// 单个待翻译分段。`id` 由前端生成并在响应中原样带回，用于分段对齐。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationSegment {
    pub id: String,
    pub text: String,
}

/// 单个翻译结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationResult {
    pub id: String,
    pub text: String,
}

/// 翻译引擎配置（来自全局设置 `translation` 分类；命令粘合层组装）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EngineConfig {
    /// Google 公开翻译接口（免 key）。
    #[serde(rename = "google")]
    Google,
    /// Bing（Edge）公开翻译接口（免 key）。
    #[serde(rename = "bing")]
    Bing,
    /// 自定义 OpenAI 兼容接口。
    #[serde(rename = "customAi")]
    CustomAi {
        base_url: String,
        model: String,
        api_key: String,
    },
}

/// 翻译请求（`translate.request` 命令负载）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateRequest {
    /// 请求关联 id：前端生成，回执原样带回以匹配过期/乱序响应。
    pub request_id: String,
    pub engine: EngineConfig,
    /// 源语言（`auto` 表示自动判断）。
    pub source_language: String,
    pub target_language: String,
    pub segments: Vec<TranslationSegment>,
}

/// 翻译回执负载（`workspace:translate-result` 事件）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateOutcome {
    pub request_id: String,
    pub ok: bool,
    /// 成功时的分段结果（按请求顺序重排）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<TranslationResult>>,
    /// 失败时的中文错误原因。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl TranslateOutcome {
    pub fn success(request_id: impl Into<String>, results: Vec<TranslationResult>) -> Self {
        TranslateOutcome {
            request_id: request_id.into(),
            ok: true,
            results: Some(results),
            message: None,
        }
    }

    pub fn failure(request_id: impl Into<String>, message: impl Into<String>) -> Self {
        TranslateOutcome {
            request_id: request_id.into(),
            ok: false,
            results: None,
            message: Some(message.into()),
        }
    }
}

/// 引擎连通性测试请求（`translate.test` 命令负载）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateTestRequest {
    pub engine: EngineConfig,
}
