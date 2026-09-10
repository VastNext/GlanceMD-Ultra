//! FEAT-003 网络层探针测试：`parse_proxy_url` / `ProxySpec::to_uri` 纯逻辑。
//!
//! 以 `#[path]` 引入 `src/net.rs` 独立编译（bin crate 可测性模式，同
//! `settings_probe.rs` 约定）。仅测纯解析逻辑；`build_agent` / `test_proxy`
//! 依赖真实网络与 ureq 构造，由真实环境验证，不在此处发网络请求。

#[path = "../src/net.rs"]
mod net;

use net::{parse_proxy_url, ProxyScheme};

#[test]
fn 解析_http_代理() {
    let spec = parse_proxy_url("http://127.0.0.1:7890").unwrap();
    assert_eq!(spec.scheme, ProxyScheme::Http);
    assert_eq!(spec.host, "127.0.0.1");
    assert_eq!(spec.port, 7890);
    assert_eq!(spec.username, None);
    assert_eq!(spec.to_uri(), "http://127.0.0.1:7890");
}

#[test]
fn 解析_socks5_代理() {
    let spec = parse_proxy_url("socks5://127.0.0.1:1080").unwrap();
    assert_eq!(spec.scheme, ProxyScheme::Socks5);
    assert_eq!(spec.host, "127.0.0.1");
    assert_eq!(spec.port, 1080);
}

#[test]
fn 解析_socks_别名_视为socks5() {
    let spec = parse_proxy_url("socks://127.0.0.1:1080").unwrap();
    assert_eq!(spec.scheme, ProxyScheme::Socks5);
}

#[test]
fn 解析_带认证_代理() {
    let spec = parse_proxy_url("http://user:pass@127.0.0.1:7890").unwrap();
    assert_eq!(spec.username.as_deref(), Some("user"));
    assert_eq!(spec.password.as_deref(), Some("pass"));
    assert_eq!(spec.to_uri(), "http://user:pass@127.0.0.1:7890");
}

#[test]
fn 解析_无协议前缀_按http带默认端口() {
    let spec = parse_proxy_url("myproxy.example.com").unwrap();
    assert_eq!(spec.scheme, ProxyScheme::Http);
    assert_eq!(spec.port, 8080);
}

#[test]
fn 解析_无端口_socks用默认1080_http用默认8080() {
    assert_eq!(parse_proxy_url("socks5://host").unwrap().port, 1080);
    assert_eq!(parse_proxy_url("http://host").unwrap().port, 8080);
}

#[test]
fn 解析_ipv6字面量() {
    let spec = parse_proxy_url("http://[::1]:7890").unwrap();
    assert_eq!(spec.host, "::1");
    assert_eq!(spec.port, 7890);
}

#[test]
fn 解析_大小写协议不敏感() {
    let spec = parse_proxy_url("SOCKS5://host:1080").unwrap();
    assert_eq!(spec.scheme, ProxyScheme::Socks5);
}

#[test]
fn 解析_非法输入报错() {
    assert!(parse_proxy_url("").is_err());
    assert!(parse_proxy_url("ftp://host:21").is_err());
    assert!(parse_proxy_url("http://host:notaport").is_err());
    assert!(parse_proxy_url("http://:7890").is_err());
    assert!(parse_proxy_url("http://host:70000").is_err());
}

#[test]
fn 真实网络测试_测试代理请求() {
    let r = net::test_proxy(
        Some("http://127.0.0.1:7890"),
        true,
        std::time::Duration::from_secs(5),
    );
    println!("test_proxy result: {:?}", r);
}
