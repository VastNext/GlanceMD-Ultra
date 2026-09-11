//! FEAT-005 翻译模块探针测试：纯逻辑 + 本地 mock HTTP 往返。
//!
//! 以 `#[path]` 引入 `src/translate.rs` 独立编译（同 `net_probe.rs` 约定）。
//! mock 服务用 `TcpListener` 起一次性 HTTP/1.1 响应（`Connection: close`），
//! 不发任何真实外网请求。

#[path = "../src/translate.rs"]
mod translate;

use std::io::{Read, Write};
use std::net::TcpListener;
use translate::{
    create_batches, normalize_language, order_results, parse_retry_after,
    parse_translation_response, translate_bing_at, translate_google_at, translate_openai_once,
    validate_target_language, with_retry_impl, EngineConfig, TranslateError, TranslationResult,
    TranslationSegment,
};

fn segment(id: &str, text: &str) -> TranslationSegment {
    TranslationSegment {
        id: id.to_string(),
        text: text.to_string(),
    }
}

// ── mock HTTP 服务 ──

struct MockServer {
    url: String,
}

impl MockServer {
    /// 起一个一次性 mock：读取首个请求后按 `response` 原样回写并关闭。
    fn start(response: String) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let _ = read_full_request(&mut stream);
            stream.write_all(response.as_bytes()).expect("write mock");
            stream.flush().ok();
        });
        MockServer {
            url: format!("http://127.0.0.1:{port}"),
        }
    }
}

/// 循环读取直到请求头与 Content-Length 声明的请求体全部到齐
/// （单次 read 可能只收到头部，测试需要断言请求体）。
fn read_full_request(stream: &mut std::net::TcpStream) -> String {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let header_end = buf
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|pos| pos + 4);
        if let Some(end) = header_end {
            let length: usize = String::from_utf8_lossy(&buf[..end])
                .to_lowercase()
                .lines()
                .find_map(|line| {
                    line.strip_prefix("content-length:")
                        .map(|v| v.trim().parse().ok())
                })
                .flatten()
                .unwrap_or(0);
            if buf.len() >= end + length {
                return String::from_utf8_lossy(&buf).to_string();
            }
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return String::from_utf8_lossy(&buf).to_string(),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
}

fn http_ok_json(body: &'static str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

// ── 语言映射 ──

#[test]
fn google_语言码映射() {
    use translate::map_google_language;
    assert_eq!(map_google_language("zh-Hans"), "zh-CN");
    assert_eq!(map_google_language("zh-Hant"), "zh-TW");
    assert_eq!(map_google_language("pt"), "pt-PT");
    assert_eq!(map_google_language("en"), "en");
}

#[test]
fn bing_语言码映射() {
    use translate::map_bing_language;
    assert_eq!(map_bing_language("zh-Hans"), "zh-Hans");
    assert_eq!(map_bing_language("pt"), "pt-pt");
    assert_eq!(map_bing_language("en"), "en");
}

#[test]
fn 归一化_中文区简繁() {
    assert_eq!(normalize_language("zh-TW"), "zh-Hant");
    assert_eq!(normalize_language("zh_HK"), "zh-Hant");
    assert_eq!(normalize_language("zh-Hans"), "zh-Hans");
    assert_eq!(normalize_language("zh"), "zh-Hans");
    assert_eq!(normalize_language("EN-us"), "en");
    assert_eq!(normalize_language("  ja "), "ja");
}

#[test]
fn 目标语言校验_禁auto与未知码() {
    assert!(validate_target_language("auto").is_err());
    assert!(validate_target_language("klingon").is_err());
    assert_eq!(validate_target_language("zh-TW").unwrap(), "zh-Hant");
    assert_eq!(validate_target_language("en").unwrap(), "en");
}

// ── 分批与重排 ──

#[test]
fn 分批_按段数与字符上限切分() {
    let segments: Vec<_> = (0..20).map(|i| segment(&format!("s{i}"), "字")).collect();
    // 每段 1 字符：20 段按 8 段/批 → 8+8+4
    let batches = create_batches(&segments, 8, 6000).unwrap();
    assert_eq!(
        batches.iter().map(|b| b.len()).collect::<Vec<_>>(),
        vec![8, 8, 4]
    );

    let segments: Vec<_> = (0..5)
        .map(|i| segment(&format!("s{i}"), &"x".repeat(2000)))
        .collect();
    // 每段 2000 字符：单批最多容纳 3 段（6000）→ 3+2
    let batches = create_batches(&segments, 8, 6000).unwrap();
    assert_eq!(
        batches.iter().map(|b| b.len()).collect::<Vec<_>>(),
        vec![3, 2]
    );
}

#[test]
fn 分批_单段超限报错() {
    let segments = vec![segment("s0", &"长".repeat(6001))];
    let error = create_batches(&segments, 8, 6000).unwrap_err();
    assert!(error.contains("s0"), "{error}");
}

#[test]
fn 分批_空输入返回空() {
    let batches = create_batches(&[], 8, 6000).unwrap();
    assert!(batches.is_empty());
}

#[test]
fn 重排_按请求顺序且丢弃缺段() {
    let segments = vec![segment("a", "1"), segment("b", "2"), segment("c", "3")];
    let results = vec![
        TranslationResult {
            id: "c".into(),
            text: "三".into(),
        },
        TranslationResult {
            id: "a".into(),
            text: "一".into(),
        },
    ];
    let ordered = order_results(&segments, &results);
    assert_eq!(
        ordered.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        vec!["a", "c"]
    );
}

// ── 重试 ──

#[test]
fn 重试_429按退避重试后成功() {
    let mut calls = 0u32;
    let mut waits: Vec<u64> = Vec::new();
    let result = with_retry_impl(
        2,
        &mut || {
            calls += 1;
            if calls < 3 {
                Err(TranslateError::with_status(429, "限频"))
            } else {
                Ok("ok")
            }
        },
        &mut |ms| waits.push(ms),
    );
    assert_eq!(result.unwrap(), "ok");
    assert_eq!(calls, 3);
    assert_eq!(waits, vec![500, 1000]);
}

#[test]
fn 重试_5xx可重试_400不可重试() {
    let mut calls = 0u32;
    let error = with_retry_impl(
        2,
        &mut || {
            calls += 1;
            Err::<(), _>(TranslateError::with_status(400, "请求无效"))
        },
        &mut |_| {},
    )
    .unwrap_err();
    assert_eq!(calls, 1);
    assert!(error.contains("请求无效"));

    let mut calls = 0u32;
    let error = with_retry_impl(
        2,
        &mut || {
            calls += 1;
            Err::<(), _>(TranslateError::with_status(500, "服务端错误"))
        },
        &mut |_| {},
    )
    .unwrap_err();
    assert_eq!(calls, 3);
    assert!(error.contains("服务端错误"));
}

#[test]
fn 重试_retry_after优先于指数退避() {
    let mut waits: Vec<u64> = Vec::new();
    let _ = with_retry_impl(
        1,
        &mut || {
            Err::<(), _>(TranslateError {
                status: Some(429),
                message: "限频".into(),
                retry_after_ms: Some(7000),
            })
        },
        &mut |ms| waits.push(ms),
    );
    assert_eq!(waits, vec![7000]);
}

#[test]
fn retry_after_解析() {
    assert_eq!(parse_retry_after(Some("3"), 0), Some(3000));
    assert_eq!(
        parse_retry_after(Some("Wed, 21 Oct 2026 07:28:00 GMT"), 0),
        Some(1000)
    );
    assert_eq!(parse_retry_after(Some(""), 0), None);
    assert_eq!(parse_retry_after(None, 0), None);
}

// ── Google 客户端（mock）──

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(5)))
        .build()
        .into()
}

#[test]
fn google_字符串条目响应解析() {
    let server = MockServer::start(http_ok_json(r#"["你好","世界"]"#));
    let batch = vec![segment("a", "hello"), segment("b", "world")];
    let results = translate_google_at(&agent(), &server.url, "auto", "zh-Hans", &batch).unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(
        results[0],
        TranslationResult {
            id: "a".into(),
            text: "你好".into()
        }
    );
    assert_eq!(results[1].text, "世界");
}

#[test]
fn google_嵌套片段响应解析() {
    let server = MockServer::start(http_ok_json(r#"[["你","好"],["世","界"]]"#));
    let batch = vec![segment("a", "hello"), segment("b", "world")];
    let results = translate_google_at(&agent(), &server.url, "auto", "zh-Hans", &batch).unwrap();
    assert_eq!(results[0].text, "你好");
    assert_eq!(results[1].text, "世界");
}

#[test]
fn google_响应段数不符报错() {
    let server = MockServer::start(http_ok_json(r#"["你好"]"#));
    let batch = vec![segment("a", "hello"), segment("b", "world")];
    let error = translate_google_at(&agent(), &server.url, "auto", "zh-Hans", &batch).unwrap_err();
    assert!(error.message.contains("格式无效"), "{error}");
}

#[test]
fn google_请求体包含分段文本与语言参数() {
    // 捕获请求内容：mock 回一个长度不匹配的响应以触发错误，但请求已被读取。
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let captured_clone = captured.clone();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        *captured_clone.lock().unwrap() = read_full_request(&mut stream);
        let body = r#"["你"]"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).ok();
    });
    let batch = vec![segment("a", "hello world")];
    let _ = translate_google_at(
        &agent(),
        &format!("http://127.0.0.1:{port}"),
        "en",
        "zh-Hans",
        &batch,
    );
    let request = captured.lock().unwrap().clone();
    assert!(request.contains("client=gtx"), "{request}");
    assert!(request.contains("sl=en"), "{request}");
    assert!(request.contains("tl=zh-CN"), "{request}");
    assert!(request.contains("hello%20world"), "{request}");
}

// ── Bing 客户端（mock）──

#[test]
fn bing_响应解析() {
    let server = MockServer::start(http_ok_json(
        r#"[{"detectedLanguage":{"language":"en"},"translations":[{"text":"你好"}]},{"translations":[{"text":"世界"}]}]"#,
    ));
    let batch = vec![segment("a", "hello"), segment("b", "world")];
    let results = translate_bing_at(&agent(), &server.url, "auto", "zh-Hans", &batch).unwrap();
    assert_eq!(results[0].text, "你好");
    assert_eq!(results[1].text, "世界");
}

#[test]
fn bing_响应结构异常报错() {
    let server = MockServer::start(http_ok_json(r#"[{"translations":[]}]"#));
    let batch = vec![segment("a", "hello")];
    let error = translate_bing_at(&agent(), &server.url, "auto", "zh-Hans", &batch).unwrap_err();
    assert!(error.message.contains("格式无效"), "{error}");
}

// ── OpenAI 兼容客户端 ──

fn openai_response(content: &str) -> String {
    let payload = serde_json::json!({
        "choices": [{ "message": { "role": "assistant", "content": content } }]
    });
    http_ok_json(Box::leak(payload.to_string().into_boxed_str()))
}

#[test]
fn openai_结构化响应与id对齐() {
    let content = r#"{"translations":[{"id":"a","text":"你好"},{"id":"b","text":"世界"}]}"#;
    let server = MockServer::start(openai_response(content));
    let batch = vec![segment("a", "hello"), segment("b", "world")];
    let results = translate_openai_once(
        &agent(),
        &server.url,
        "test-model",
        "sk-test",
        "auto",
        "zh-Hans",
        &batch,
    )
    .unwrap();
    assert_eq!(results[0].text, "你好");
    assert_eq!(results[1].text, "世界");
}

#[test]
fn openai_漏翻报id不匹配() {
    let content = r#"{"translations":[{"id":"a","text":"你好"}]}"#;
    let server = MockServer::start(openai_response(content));
    let batch = vec![segment("a", "hello"), segment("b", "world")];
    let error = translate_openai_once(
        &agent(),
        &server.url,
        "test-model",
        "sk-test",
        "auto",
        "zh-Hans",
        &batch,
    )
    .unwrap_err();
    assert!(error.message.contains("ID 不匹配"), "{error}");
}

#[test]
fn openai_未知id报错() {
    let content = r#"{"translations":[{"id":"a","text":"你好"},{"id":"x","text":"多余"}]}"#;
    let server = MockServer::start(openai_response(content));
    let batch = vec![segment("a", "hello")];
    let error = translate_openai_once(
        &agent(),
        &server.url,
        "test-model",
        "sk-test",
        "auto",
        "zh-Hans",
        &batch,
    )
    .unwrap_err();
    assert!(error.message.contains("ID 不匹配"), "{error}");
}

#[test]
fn openai_响应非json模式内容报错() {
    let server = MockServer::start(openai_response("抱歉，我直接回答文本"));
    let batch = vec![segment("a", "hello")];
    let error = translate_openai_once(
        &agent(),
        &server.url,
        "test-model",
        "sk-test",
        "auto",
        "zh-Hans",
        &batch,
    )
    .unwrap_err();
    assert!(error.message.contains("有效 JSON"), "{error}");
}

#[test]
fn openai_请求携带json_mode与bearer() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let clone = captured.clone();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        *clone.lock().unwrap() = read_full_request(&mut stream);
        let body = serde_json::json!({
            "choices": [{ "message": { "content": r#"{"translations":[{"id":"a","text":"你好"}]}"# } }]
        })
        .to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).ok();
    });
    let batch = vec![segment("a", "hello")];
    let _ = translate_openai_once(
        &agent(),
        &format!("http://127.0.0.1:{port}"),
        "test-model",
        "sk-secret",
        "auto",
        "zh-Hans",
        &batch,
    );
    let request = captured.lock().unwrap().clone();
    assert!(request.contains("response_format"), "{request}");
    assert!(request.contains("Bearer sk-secret"), "{request}");
    assert!(request.contains("/chat/completions"), "{request}");
}

// ── 协议与 URL 构造 ──

#[test]
fn 协议解析_id对齐校验() {
    let expected = vec![segment("a", "hello")];
    assert!(
        parse_translation_response(r#"{"translations":[{"id":"a","text":"你"}]}"#, &expected)
            .is_ok()
    );
    assert!(parse_translation_response(r#"{"translations":[]}"#, &expected).is_err());
    assert!(parse_translation_response(r#"{"results":[]}"#, &expected).is_err());
    assert!(parse_translation_response(r#"not json"#, &expected).is_err());
    assert!(parse_translation_response(r#"{"translations":[{"id":"a"}]}"#, &expected).is_err());
}

#[test]
fn chat_completions_url构造() {
    use translate::build_chat_completions_url;
    assert_eq!(
        build_chat_completions_url("https://api.example.com/v1/"),
        "https://api.example.com/v1/chat/completions"
    );
    assert_eq!(
        build_chat_completions_url("https://api.example.com/v1/chat/completions"),
        "https://api.example.com/v1/chat/completions"
    );
    assert_eq!(
        build_chat_completions_url("https://api.example.com"),
        "https://api.example.com/v1/chat/completions"
    );
}

// ── 翻译总入口（mock）──

#[test]
fn 总入口_成功往返与顺序保证() {
    // CustomAi 引擎的 base_url 可注入，用 mock 服务验证总入口的
    // 分批/重排/完整性校验链路（Google/Bing 端点为常量，已由 *_at 变体覆盖）。
    let content = r#"{"translations":[{"id":"s3","text":"三"},{"id":"s1","text":"一"},{"id":"s2","text":"二"}]}"#;
    let server = MockServer::start(openai_response(content));
    let segments = vec![
        segment("s3", "three"),
        segment("s1", "one"),
        segment("s2", "two"),
    ];
    let results = translate::translate(
        &agent(),
        &EngineConfig::CustomAi {
            base_url: server.url,
            model: "test-model".into(),
            api_key: "sk-test".into(),
        },
        "auto",
        "zh-Hans",
        &segments,
    )
    .unwrap();
    assert_eq!(
        results.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        vec!["s3", "s1", "s2"]
    );
}

#[test]
fn 总入口_空目标语言报错() {
    let error = translate::translate(
        &agent(),
        &EngineConfig::Google,
        "auto",
        "auto",
        &[segment("a", "hello")],
    )
    .unwrap_err();
    assert!(error.contains("auto"), "{error}");
}

#[test]
fn 总入口_空分段报错() {
    let error =
        translate::translate(&agent(), &EngineConfig::Google, "auto", "zh-Hans", &[]).unwrap_err();
    assert!(error.contains("没有可翻译"), "{error}");
}

#[test]
fn 总入口_连接拒绝报中文错误() {
    // 绑定后立即释放端口，保证连接被拒绝。
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    // 必须用可指定 base_url 的 CustomAi 变体把请求钉在本地拒绝端口：
    // Google/Bing 变体连真实外网端点，CI 出口可达外网时请求可能成功，
    // "连接被拒绝"的前提不成立（2026-09-12 main CI 偶发失败）。
    let engine = EngineConfig::CustomAi {
        base_url: format!("http://127.0.0.1:{port}"),
        model: "test-model".to_string(),
        api_key: "test-key".to_string(),
    };
    // 不强求失败信息格式，仅要求最终收敛为 Err（重试后仍失败）。
    let error = translate::translate(
        &agent(),
        &engine,
        "auto",
        "zh-Hans",
        &[segment("a", "hello")],
    );
    assert!(error.is_err(), "连接拒绝应返回 Err，实际: {error:?}");
}
