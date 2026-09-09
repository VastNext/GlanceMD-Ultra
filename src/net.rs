//! 网络层（FEAT-003）：代理 URL 解析 + 带代理/TLS 的 HTTP 客户端。
//!
//! 自包含模块：只依赖 `std` / `ureq`，不引用 `crate::` 路径，可在
//! `tests/net_probe.rs` 中以 `#[path]` 引入独立编译测试（与 `settings_probe.rs`
//! 同款约定）。命令粘合层把全局设置的 `Http` 分类字段传入本模块的纯参数接口。
//!
//! 后端 HTTP 客户端承载：设置页【测试连接】、以及未来 FEAT-002 的更新检查与
//! Release 下载。代理配置来自设置（`http.proxySupport` / `http.proxy` /
//! `http.proxyStrictSSL`），本模块只做纯逻辑与请求封装，不触碰设置持久化。
#![allow(dead_code)]

use std::time::Duration;

/// 代理协议（对齐 ureq 的 `ProxyProtocol` 子集，覆盖需求中的 HTTP/SOCKS5）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyScheme {
    Http,
    Https,
    Socks4,
    Socks4a,
    Socks5,
    Socks5h,
}

/// 解析出的代理规范：协议 + host[:port] + 可选用户名/密码。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxySpec {
    pub scheme: ProxyScheme,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl ProxySpec {
    /// 重建为标准 URI 形式（供 ureq `Proxy::new` 直接使用）。
    pub fn to_uri(&self) -> String {
        let scheme = match self.scheme {
            ProxyScheme::Http => "http",
            ProxyScheme::Https => "https",
            ProxyScheme::Socks4 => "socks4",
            ProxyScheme::Socks4a => "socks4a",
            ProxyScheme::Socks5 => "socks5",
            ProxyScheme::Socks5h => "socks5h",
        };
        let auth = match (&self.username, &self.password) {
            (Some(u), Some(p)) => format!("{u}:{p}@"),
            (Some(u), None) => format!("{u}@"),
            _ => String::new(),
        };
        format!("{scheme}://{auth}{}:{}", self.host, self.port)
    }
}

/// 解析代理地址字符串为 [`ProxySpec`]。
///
/// 支持 `http://host:port`、`https://host:port`、`socks4://`、`socks5://`、
/// `socks5h://`，以及可选的 `user:pass@` 前缀。缺省端口时给常用默认值
/// （http/https → 8080，socks → 1080）。非法协议或格式返回中文错误信息。
pub fn parse_proxy_url(input: &str) -> Result<ProxySpec, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("代理地址为空".to_string());
    }
    let (scheme, rest) = match input.find("://") {
        Some(idx) => {
            let scheme = &input[..idx];
            let rest = &input[idx + 3..];
            let scheme = match scheme.to_ascii_lowercase().as_str() {
                "http" => ProxyScheme::Http,
                "https" => ProxyScheme::Https,
                "socks" | "socks5" => ProxyScheme::Socks5,
                "socks4" => ProxyScheme::Socks4,
                "socks4a" => ProxyScheme::Socks4a,
                "socks5h" => ProxyScheme::Socks5h,
                other => return Err(format!("不支持的代理协议：{other}")),
            };
            (scheme, rest)
        }
        None => {
            // 无协议前缀：按 http 处理（带默认端口）
            (ProxyScheme::Http, input)
        }
    };

    let (userinfo, hostport) = match rest.rfind('@') {
        Some(idx) => (&rest[..idx], &rest[idx + 1..]),
        None => ("", rest),
    };

    let (username, password) = match userinfo {
        "" => (None, None),
        u => match u.split_once(':') {
            Some((user, pass)) => (Some(user.to_string()), Some(pass.to_string())),
            None => (Some(u.to_string()), None),
        },
    };

    if hostport.is_empty() {
        return Err("代理地址缺少 host".to_string());
    }
    let default_port = |scheme: ProxyScheme| match scheme {
        ProxyScheme::Socks4 | ProxyScheme::Socks4a | ProxyScheme::Socks5 | ProxyScheme::Socks5h => {
            1080
        }
        _ => 8080,
    };
    let (host, port) = if let Some(bracket) = hostport.find(']') {
        // IPv6 字面量：[addr] 或 [addr]:port（地址本身含冒号，必须先切方括号）
        let host = &hostport[1..bracket];
        let after = &hostport[bracket + 1..];
        let port = match after.strip_prefix(':') {
            Some(p) => p.parse::<u16>().map_err(|_| format!("代理端口无效：{p}"))?,
            None => default_port(scheme),
        };
        (host.to_string(), port)
    } else if let Some((h, p)) = hostport.split_once(':') {
        let port = p.parse::<u16>().map_err(|_| format!("代理端口无效：{p}"))?;
        (h.to_string(), port)
    } else {
        (hostport.to_string(), default_port(scheme))
    };
    if host.is_empty() {
        return Err("代理地址缺少 host".to_string());
    }

    Ok(ProxySpec {
        scheme,
        host,
        port,
        username,
        password,
    })
}

/// 构造带代理与 TLS 配置的 ureq Agent。
///
/// - `proxy_uri`：已由调用方按 `http.proxySupport` 决定；`override` 时传入
///   解析后的 URI（可直接 `parse_proxy_url(...).to_uri()`），`system`/`off`
///   传 `None`（跟随系统代理 / 直连）。
/// - `strict_ssl`：`false` 时关闭证书校验（`http.proxyStrictSSL=false` 的安全降级）。
/// - `timeout`：全局超时（测试连接用，默认给 8s 可调）。
pub fn build_agent(
    proxy_uri: Option<&str>,
    strict_ssl: bool,
    timeout: Duration,
) -> Result<ureq::Agent, String> {
    let mut builder = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .https_only(false);
    if let Some(uri) = proxy_uri {
        let proxy = ureq::Proxy::new(uri).map_err(|e| format!("代理配置无效：{e}"))?;
        builder = builder.proxy(Some(proxy));
    }
    if !strict_ssl {
        let tls = ureq::tls::TlsConfig::builder()
            .disable_verification(true)
            .build();
        builder = builder.tls_config(tls);
    }
    Ok(builder.build().into())
}

/// 测试连接结果。
#[derive(Debug, Clone, PartialEq)]
pub struct ProxyTestResult {
    /// 实际测通的 URL 状态码（200 表示连通）。
    pub status: u16,
    /// 往返耗时（毫秒）。
    pub latency_ms: u128,
    /// 目标地址（默认 https://api.github.com，供前端展示）。
    pub target: String,
}

/// 目标探测地址：连通性可代表公网可访问性（GitHub API 对代理场景最具代表性）。
pub const TEST_TARGET: &str = "https://api.github.com";

/// 执行一次代理连通性测试。
///
/// `proxy_uri` 语义与 [`build_agent`] 相同；`strict_ssl` 同设置字段。成功连通
/// 返回 [`ProxyTestResult`]，失败返回中文错误信息（含网络/超时/证书原因）。
pub fn test_proxy(
    proxy_uri: Option<&str>,
    strict_ssl: bool,
    timeout: Duration,
) -> Result<ProxyTestResult, String> {
    let agent = build_agent(proxy_uri, strict_ssl, timeout)?;
    let start = std::time::Instant::now();
    let resp = agent
        .get(TEST_TARGET)
        .header("User-Agent", "GlanceMD-Ultra/0.3.0")
        .call()
        .map_err(|e| format!("连接失败：{e}"))?;
    let latency_ms = start.elapsed().as_millis();
    Ok(ProxyTestResult {
        status: resp.status().as_u16(),
        latency_ms,
        target: TEST_TARGET.to_string(),
    })
}
