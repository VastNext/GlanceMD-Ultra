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
        let hant = ["tw", "hk", "mo", "hant"]
            .iter()
            .any(|code| lower == format!("zh-{code}") || lower.starts_with(&format!("zh-{code}-")));
        return if hant {
            "zh-Hant".to_string()
        } else {
            "zh-Hans".to_string()
        };
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
            && (batch.len() >= max_segments
                || characters + segment.text.chars().count() > max_characters)
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
    let by_id: std::collections::HashMap<&str, &TranslationResult> =
        results.iter().map(|r| (r.id.as_str(), r)).collect();
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
        TranslateError {
            status: None,
            message: message.into(),
            retry_after_ms: None,
        }
    }

    pub fn with_status(status: u16, message: impl Into<String>) -> Self {
        TranslateError {
            status: Some(status),
            message: message.into(),
            retry_after_ms: None,
        }
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
    let mut sleep_fn = |ms: u64| std::thread::sleep(std::time::Duration::from_millis(ms));
    with_retry_impl(MAX_RETRIES, &mut op, &mut sleep_fn)
}

/// 探针测试用：显式注入重试次数与 sleep（不真实等待）。
pub fn with_retry_impl<T, F, S>(retries: u32, op: &mut F, sleep: &mut S) -> Result<T, String>
where
    F: FnMut() -> Result<T, TranslateError>,
    S: FnMut(u64),
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
    Err(last
        .map(|e| e.message)
        .unwrap_or_else(|| "翻译请求失败".to_string()))
}

// ── HTTP 辅助 ──

/// 引擎请求总入口：按引擎分发并应用重试。
///
/// `agent` 由调用方经 `net::build_agent` 构造（代理/SSL/30s 全局超时统一生效）；
/// 本函数只做引擎分发、分批与结果完整性校验。
pub fn translate(
    agent: &ureq::Agent,
    engine: &EngineConfig,
    source_language: &str,
    target_language: &str,
    segments: &[TranslationSegment],
) -> Result<Vec<TranslationResult>, String> {
    if segments.is_empty() {
        return Err("没有可翻译的内容".to_string());
    }
    let target = validate_target_language(target_language)?;
    let batches = create_batches(segments, MAX_SEGMENTS_PER_BATCH, MAX_CHARACTERS_PER_BATCH)?;
    let mut results: Vec<TranslationResult> = Vec::new();
    for batch in &batches {
        let batch_results = with_retry(|| match engine {
            EngineConfig::Google => translate_google_once(agent, source_language, &target, batch),
            EngineConfig::Bing => translate_bing_once(agent, source_language, &target, batch),
            EngineConfig::CustomAi {
                base_url,
                model,
                api_key,
            } => translate_openai_once(
                agent,
                base_url,
                model,
                api_key,
                source_language,
                &target,
                batch,
            ),
        })?;
        results.extend(batch_results);
    }
    // 完整性校验：逐批已对齐，这里兜底确认无缺段（防引擎层回归）。
    let ordered = order_results(segments, &results);
    if ordered.len() != segments.len() {
        return Err("翻译结果不完整：部分分段未返回译文".to_string());
    }
    Ok(ordered)
}

/// 引擎连通性测试：单段最小请求，成功返回耗时毫秒。
pub fn test_connection(agent: &ureq::Agent, engine: &EngineConfig) -> Result<u128, String> {
    let start = std::time::Instant::now();
    translate(
        agent,
        engine,
        "en",
        "zh-Hans",
        &[TranslationSegment {
            id: "test".to_string(),
            text: "Hello, world.".to_string(),
        }],
    )?;
    Ok(start.elapsed().as_millis())
}

/// 发送 POST 并读取响应体文本；非 2xx 转换为带状态码的 [`TranslateError`]，
/// `Retry-After` 头透传给重试层。`name` 用于中文错误消息前缀。
fn post_and_read(
    agent: &ureq::Agent,
    name: &str,
    url: &str,
    content_type: &str,
    body: &str,
) -> Result<String, TranslateError> {
    let mut response = agent
        .post(url)
        .header("Content-Type", content_type)
        .send(body)
        .map_err(|e| status_error_from_ureq(name, e))?;
    let retry_after = response
        .headers()
        .get("Retry-After")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());
    let mut error = status_error_from_response(name, response.status().as_u16());
    if error.is_none() {
        return response
            .body_mut()
            .read_to_string()
            .map_err(|e| TranslateError::new(format!("{name}翻译响应读取失败：{e}")));
    }
    let mut e = error.take().unwrap();
    if let Some(raw) = retry_after {
        e.retry_after_ms = parse_retry_after(Some(&raw), 0);
    }
    Err(e)
}

/// 把 `ureq::Error` 归一为 [`TranslateError`]。
fn status_error_from_ureq(name: &str, error: ureq::Error) -> TranslateError {
    match error {
        ureq::Error::StatusCode(code) => {
            TranslateError::with_status(code, format!("{name}翻译请求失败（{code}）"))
        }
        other => TranslateError::new(format!("{name}翻译请求失败：{other}")),
    }
}

/// 按状态码生成错误；2xx 返回 None。
fn status_error_from_response(name: &str, status: u16) -> Option<TranslateError> {
    if (200..300).contains(&status) {
        return None;
    }
    let message = if status == 429 {
        format!("{name}翻译请求过于频繁（429）")
    } else {
        format!("{name}翻译请求失败（{status}）")
    };
    Some(TranslateError::with_status(status, message))
}

/// application/x-www-form-urlencoded 值编码（全量百分号编码，Google 兼容）。
fn form_urlencode(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}

// ── Google 客户端（移植自插件 `google-translate-client.ts`）──

const GOOGLE_ENDPOINT: &str = "https://translate.googleapis.com/translate_a/t";

/// Google 单批翻译（不含重试；重试由 [`with_retry`] 包裹）。
pub fn translate_google_once(
    agent: &ureq::Agent,
    source_language: &str,
    target_language: &str,
    batch: &[TranslationSegment],
) -> Result<Vec<TranslationResult>, TranslateError> {
    translate_google_at(
        agent,
        GOOGLE_ENDPOINT,
        source_language,
        target_language,
        batch,
    )
}

/// Google 单批翻译（端点可注入，探针测试用 mock 服务）。
pub fn translate_google_at(
    agent: &ureq::Agent,
    endpoint: &str,
    source_language: &str,
    target_language: &str,
    batch: &[TranslationSegment],
) -> Result<Vec<TranslationResult>, TranslateError> {
    let sl = if source_language == "auto" {
        "auto".to_string()
    } else {
        map_google_language(normalize_language(source_language).as_str())
    };
    let tl = map_google_language(target_language);
    let url = format!("{endpoint}?client=gtx&dt=t&sl={sl}&tl={tl}");
    let body: String = batch
        .iter()
        .map(|segment| format!("q={}", form_urlencode(&segment.text)))
        .collect::<Vec<_>>()
        .join("&");

    let text = post_and_read(
        agent,
        "Google ",
        &url,
        "application/x-www-form-urlencoded;charset=UTF-8",
        &body,
    )?;
    let payload: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| TranslateError::new("Google 翻译响应不是有效 JSON"))?;
    let items = payload
        .as_array()
        .filter(|items| items.len() == batch.len())
        .ok_or_else(|| TranslateError::new("Google 翻译响应格式无效"))?;

    batch
        .iter()
        .zip(items.iter())
        .map(|(segment, item)| {
            let translated = read_google_text(item)
                .ok_or_else(|| TranslateError::new("Google 翻译响应格式无效"))?;
            Ok(TranslationResult {
                id: segment.id.clone(),
                text: translated,
            })
        })
        .collect()
}

/// Google `translate_a/t` 响应条目两种形态：字符串或嵌套片段数组。
fn read_google_text(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    let array = value.as_array()?;
    // 形态一：[["片段","片段"]]；形态二：[["片段"],["片段"]]
    if array.iter().all(|item| item.is_array()) {
        let mut out = String::new();
        for fragment in array {
            let inner = fragment.as_array()?;
            let text = inner.first()?.as_str()?;
            out.push_str(text);
        }
        return Some(out);
    }
    let mut out = String::new();
    for fragment in array {
        out.push_str(fragment.as_str()?);
    }
    Some(out)
}

// ── Bing 客户端（移植自插件 `bing-translate-client.ts`）──

const BING_ENDPOINT: &str = "https://edge.microsoft.com/translate/translatetext";

/// Bing 单批翻译（不含重试）。
pub fn translate_bing_once(
    agent: &ureq::Agent,
    source_language: &str,
    target_language: &str,
    batch: &[TranslationSegment],
) -> Result<Vec<TranslationResult>, TranslateError> {
    translate_bing_at(
        agent,
        BING_ENDPOINT,
        source_language,
        target_language,
        batch,
    )
}

/// Bing 单批翻译（端点可注入，探针测试用 mock 服务）。
pub fn translate_bing_at(
    agent: &ureq::Agent,
    endpoint: &str,
    source_language: &str,
    target_language: &str,
    batch: &[TranslationSegment],
) -> Result<Vec<TranslationResult>, TranslateError> {
    let mut params = format!(
        "to={}&isEnterpriseClient=false",
        form_urlencode(&map_bing_language(target_language))
    );
    if source_language != "auto" {
        params.push_str(&format!(
            "&from={}",
            form_urlencode(&map_bing_language(
                normalize_language(source_language).as_str()
            ))
        ));
    }
    let url = format!("{endpoint}?{params}");
    let texts: Vec<&str> = batch.iter().map(|segment| segment.text.as_str()).collect();
    let body = serde_json::to_string(&texts)
        .map_err(|_| TranslateError::new("Bing 翻译请求体序列化失败"))?;

    let text = post_and_read(agent, "Bing ", &url, "application/json", &body)?;
    let payload: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| TranslateError::new("Bing 翻译响应不是有效 JSON"))?;
    let items = payload
        .as_array()
        .filter(|items| items.len() == batch.len())
        .ok_or_else(|| TranslateError::new("Bing 翻译响应格式无效"))?;

    batch
        .iter()
        .zip(items.iter())
        .map(|(segment, item)| {
            let text = item
                .get("translations")
                .and_then(|t| t.get(0))
                .and_then(|t| t.get("text"))
                .and_then(|t| t.as_str())
                .ok_or_else(|| TranslateError::new("Bing 翻译响应格式无效"))?;
            Ok(TranslationResult {
                id: segment.id.clone(),
                text: text.to_string(),
            })
        })
        .collect()
}

// ── OpenAI 兼容客户端（移植自插件 `openai-client.ts` 与 `messages.ts`）──

/// 组装 AI 翻译消息：system 提示词 + user JSON 分段载荷。
///
/// 对齐插件 `createTranslationMessages`：要求模型保留每个 id 并返回
/// `{"translations":[{"id":"...","text":"..."}]}`。
fn create_translation_messages(
    source_language: &str,
    target_language: &str,
    batch: &[TranslationSegment],
    user_instruction: Option<&str>,
) -> Vec<serde_json::Value> {
    let source = normalize_language(source_language);
    let source_display = if source == "auto" {
        "auto".to_string()
    } else {
        source
    };
    let mut instruction = format!(
        "将输入从 {source_display} 翻译为 {target_language}。\n保留每个 id，返回 {{\"translations\":[{{\"id\":\"...\",\"text\":\"...\"}}]}}，不得添加其他内容。"
    );
    if let Some(extra) = user_instruction.map(str::trim).filter(|s| !s.is_empty()) {
        instruction.push('\n');
        instruction.push_str(extra);
    }
    let segments_payload = serde_json::json!({ "segments": batch });
    vec![
        serde_json::json!({ "role": "system", "content": instruction }),
        serde_json::json!({ "role": "user", "content": segments_payload.to_string() }),
    ]
}

/// 校验 AI 响应与期望 id 集合对齐（漏翻/错位/重复 id 一律报错）。
///
/// 对齐插件 `parseTranslationResponse`：JSON 结构、逐段 id/text 类型、
/// 数量一致、无未知 id。
pub fn parse_translation_response(
    content: &str,
    expected: &[TranslationSegment],
) -> Result<Vec<TranslationResult>, TranslateError> {
    let payload: serde_json::Value =
        serde_json::from_str(content).map_err(|_| TranslateError::new("翻译响应不是有效 JSON"))?;
    let translations = payload
        .get("translations")
        .and_then(|t| t.as_array())
        .ok_or_else(|| TranslateError::new("翻译响应格式无效"))?;

    let results: Vec<TranslationResult> = translations
        .iter()
        .map(|item| {
            let id = item.get("id").and_then(|v| v.as_str());
            let text = item.get("text").and_then(|v| v.as_str());
            match (id, text) {
                (Some(id), Some(text)) => Ok(TranslationResult {
                    id: id.to_string(),
                    text: text.to_string(),
                }),
                _ => Err(TranslateError::new("翻译响应格式无效")),
            }
        })
        .collect::<Result<_, _>>()?;

    if results.is_empty()
        || results.len() != expected.len()
        || results
            .iter()
            .any(|r| !expected.iter().any(|segment| segment.id == r.id))
        || {
            let ids: std::collections::HashSet<&str> =
                results.iter().map(|r| r.id.as_str()).collect();
            ids.len() != results.len()
        }
    {
        return Err(TranslateError::new("翻译响应 ID 不匹配"));
    }
    Ok(results)
}

/// 从 400 响应体判断是否 response_format 不受支持（对齐插件
/// `isResponseFormatUnsupported`：错误信息中提到 response_format/json）。
fn is_response_format_unsupported(body: &str) -> bool {
    let lower = body.to_lowercase();
    lower.contains("response_format")
        || lower.contains("json_schema")
        || lower.contains("json_object")
}

/// 规范化 base_url：去尾部斜杠；对 OpenAI 兼容端点补 /chat/completions。
///
/// 用户可填 `https://api.openai.com/v1` 或 `https://api.openai.com/v1/chat/completions`。
pub fn build_chat_completions_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else if trimmed.ends_with("/v1") {
        format!("{trimmed}/chat/completions")
    } else {
        format!("{trimmed}/v1/chat/completions")
    }
}

/// OpenAI 兼容单批翻译（不含重试）：优先 JSON mode，400 且提示不支持时
/// 降级为纯文本模式重发一次。
#[allow(clippy::too_many_arguments)]
pub fn translate_openai_once(
    agent: &ureq::Agent,
    base_url: &str,
    model: &str,
    api_key: &str,
    source_language: &str,
    target_language: &str,
    batch: &[TranslationSegment],
) -> Result<Vec<TranslationResult>, TranslateError> {
    let url = build_chat_completions_url(base_url);
    let messages = create_translation_messages(source_language, target_language, batch, None);

    let send = |json_mode: bool| -> Result<(u16, String), TranslateError> {
        let mut payload = serde_json::json!({ "model": model, "messages": messages });
        if json_mode {
            payload["response_format"] = serde_json::json!({ "type": "json_object" });
        }
        let body = serde_json::to_string(&payload)
            .map_err(|_| TranslateError::new("翻译请求体序列化失败"))?;
        let mut response = agent
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", &format!("Bearer {api_key}"))
            .send(&body)
            .map_err(|e| status_error_from_ureq("AI ", e))?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .read_to_string()
            .map_err(|e| TranslateError::new(format!("AI 翻译响应读取失败：{e}")))?;
        Ok((status, text))
    };

    let (status, body) = send(true)?;
    let (status, body) = if status == 400 && is_response_format_unsupported(&body) {
        send(false)?
    } else {
        (status, body)
    };
    if let Some(error) = status_error_from_response("AI ", status) {
        return Err(error);
    }

    let payload: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| TranslateError::new("AI 翻译响应不是有效 JSON"))?;
    let content = payload
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .ok_or_else(|| TranslateError::new("AI 翻译响应格式无效"))?;

    parse_translation_response(content, batch)
}
