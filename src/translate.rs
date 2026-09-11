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

// ── 语言码映射（移植自插件 `translate-http.ts` 与 `languages.ts`）──

/// 支持的目标语言集合（BCP-47 风格；`auto` 仅允许作为源语言）。
pub const SUPPORTED_LANGUAGES: &[&str] = &[
    "zh-Hans", "zh-Hant", "en", "ja", "ko", "fr", "it", "de", "es", "pt", "ru", "ar",
];

/// Google 引擎语言码映射（缺省原样透传）。
pub fn map_google_language(language: &str) -> String {
    match language {
        "zh-Hans" => "zh-CN".to_string(),
        "zh-Hant" => "zh-TW".to_string(),
        "pt" => "pt-PT".to_string(),
        other => other.to_string(),
    }
}

/// Bing 引擎语言码映射（缺省原样透传）。
pub fn map_bing_language(language: &str) -> String {
    match language {
        "pt" => "pt-pt".to_string(),
        other => other.to_string(),
    }
}

/// 语言码归一化：`_` → `-`、取主子码、中文区细分简繁。
///
/// 对齐插件 `normalizeLanguage`：`zh-TW`/`zh-HK`/`zh-MO`/`zh-Hant` 归
/// `zh-Hant`，其余 zh 归 `zh-Hans`；未知语言取主子码小写。
pub fn normalize_language(language: &str) -> String {
    let normalized = language.trim().replace('_', "-");
    let lower = normalized.to_lowercase();
    if lower.starts_with("zh") {
        let hant = [ "-tw", "-hk", "-mo", "-hant" ]
            .iter()
            .any(|suffix| {
                lower == suffix.trim_start_matches('-')
                    || lower.starts_with(&format!("{suffix}-"))
                    || lower.starts_with(suffix)
            });
        return if hant { "zh-Hant".to_string() } else { "zh-Hans".to_string() };
    }
    lower.split('-').next().unwrap_or("en").to_string()
}

/// 校验目标语言合法（`auto` 不可作为目标；未知码报错）。
pub fn validate_target_language(language: &str) -> Result<String, String> {
    let normalized = normalize_language(language);
    if normalized == "auto" {
        return Err("目标语言不能为 auto".to_string());
    }
    if SUPPORTED_LANGUAGES.contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        Err(format!("不支持的目标语言：{language}"))
    }
}

// ── 分批与结果重排（移植自插件 `batching.ts`）──

/// 默认分批参数：每批最多 8 段、6000 字符（对齐插件默认值）。
pub const MAX_SEGMENTS_PER_BATCH: usize = 8;
pub const MAX_CHARACTERS_PER_BATCH: usize = 6000;

/// 把分段列表切分为引擎请求批次。
///
/// 单段超过 `max_characters` 直接报错（提示用户缩小选区）；常规切分规则：
/// 当前批非空且（段数达上限或累计字符将超限）时先落批。
pub fn create_batches(
    segments: &[TranslationSegment],
    max_segments: usize,
    max_characters: usize,
) -> Result<Vec<Vec<TranslationSegment>>, String> {
    let mut batches: Vec<Vec<TranslationSegment>> = Vec::new();
    let mut batch: Vec<TranslationSegment> = Vec::new();
    let mut characters = 0usize;
    for segment in segments {
        if segment.text.chars().count() > max_characters {
            return Err(format!(
                "分段 {} 超过单段字符上限 {max_characters}",
                segment.id
            ));
        }
        if !batch.is_empty()
            && (batch.len() >= max_segments || characters + segment.text.chars().count() > max_characters)
        {
            batches.push(std::mem::take(&mut batch));
            characters = 0;
        }
        characters += segment.text.chars().count();
        batch.push(segment.clone());
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    Ok(batches)
}

/// 把结果按请求分段顺序重排（缺段直接丢弃；调用方负责校验完整性）。
pub fn order_results(
    segments: &[TranslationSegment],
    results: &[TranslationResult],
) -> Vec<TranslationResult> {
    let by_id: std::collections::HashMap<&str, &TranslationResult> = results
        .iter()
        .map(|r| (r.id.as_str(), r))
        .collect();
    segments
        .iter()
        .filter_map(|segment| by_id.get(segment.id.as_str()).map(|r| (*r).clone()))
        .collect()
}

// ── 可重试请求（移植自插件 `retry.ts`）──

/// 翻译引擎错误：可选 HTTP 状态码（重试判定）与可选 `Retry-After` 提示。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslateError {
    pub status: Option<u16>,
    pub message: String,
    pub retry_after_ms: Option<u64>,
}

impl TranslateError {
    pub fn new(message: impl Into<String>) -> Self {
        TranslateError { status: None, message: message.into(), retry_after_ms: None }
    }

    pub fn with_status(status: u16, message: impl Into<String>) -> Self {
        TranslateError { status: Some(status), message: message.into(), retry_after_ms: None }
    }

    /// 429（限频）与 5xx（服务端错误）可重试，对齐插件 `isRetryable`。
    pub fn is_retryable(&self) -> bool {
        matches!(self.status, Some(429) | Some(500..=599))
    }
}

impl std::fmt::Display for TranslateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// 解析 `Retry-After` 头：秒数或 HTTP 日期，返回相对当前时刻的毫秒数。
pub fn parse_retry_after(value: Option<&str>, now_ms: u64) -> Option<u64> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(seconds.saturating_mul(1000));
    }
    // HTTP 日期格式：仅识别常见 GMT 形态，解析失败返回 None。
    // 简化处理：不引入时间解析依赖，日期形态退回固定 1s 退避。
    if value.to_lowercase().ends_with("gmt") {
        return Some(1000);
    }
    let _ = now_ms;
    None
}

/// 默认重试参数：最多 2 次重试（共 3 次尝试），退避 500ms×2^n 封顶 30s。
pub const MAX_RETRIES: u32 = 2;
const RETRY_BASE_MS: u64 = 500;
const RETRY_CAP_MS: u64 = 30_000;

fn backoff_ms(error: &TranslateError, attempt: u32) -> u64 {
    error
        .retry_after_ms
        .unwrap_or_else(|| RETRY_BASE_MS.saturating_mul(1u64 << attempt.min(6)))
        .min(RETRY_CAP_MS)
}

/// 带重试执行引擎请求。可重试错误按指数退避重试，其余立即失败；
/// 最终失败时把最后一次错误转为面向用户的中文消息。
pub fn with_retry<T, F>(mut op: F) -> Result<T, String>
where
    F: FnMut() -> Result<T, TranslateError>,
{
    with_retry_impl(MAX_RETRIES, &mut op, &|ms| std::thread::sleep(std::time::Duration::from_millis(ms)))
}

/// 探针测试用：显式注入重试次数与 sleep（不真实等待）。
pub fn with_retry_impl<T, F, S>(
    retries: u32,
    op: &mut F,
    sleep: &S,
) -> Result<T, String>
where
    F: FnMut() -> Result<T, TranslateError>,
    S: Fn(u64),
{
    let mut last: Option<TranslateError> = None;
    for attempt in 0..=retries {
        match op() {
            Ok(value) => return Ok(value),
            Err(error) => {
                if !error.is_retryable() || attempt == retries {
                    return Err(error.message);
                }
                let wait = backoff_ms(&error, attempt);
                sleep(wait);
                last = Some(error);
            }
        }
    }
    Err(last.map(|e| e.message).unwrap_or_else(|| "翻译请求失败".to_string()))
}
