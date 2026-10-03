//! Pandoc 文档导出模块（FEAT-006）：检测 + 导出，"内置扩展 + 外置二进制"。
//!
//! 自包含模块：只依赖 `std` / `serde`，不引用 `crate::` 路径，可在探针测试中
//! 以 `#[path]` 引入独立编译测试（与 `translate_probe.rs` 同款约定）。
//! 命令粘合层（`commands.rs`）把全局设置中的 `pandoc.path` 与前端负载组装为
//! 本模块的纯参数接口。
//!
//! 设计要点（提案 `docs/proposals/2026-10-04-文档导出Pandoc扩展提案.md`）：
//! - 不打包 pandoc（~150MB vs 2–8MB 体积预算），只检测与调用用户机器上的
//!   pandoc；未安装时上层负责降级引导。
//! - 检测三层：自定义路径（hint，失败不回退）→ PATH → 平台兜底绝对路径
//!   清单（不受 GUI 进程 PATH 快照影响，装完即用免重启；同时覆盖
//!   macOS/Linux launchd 环境不继承 shell PATH 的问题）。
//! - 导出：markdown 全文经 stdin 传入（未保存改动可导，不落临时文件、不
//!   触发监听/冲突保护），`--resource-path` 解析相对图片；参数模板按格式
//!   白名单分派，不透传用户自定义参数；120s 超时强杀。
//! - 进程纪律沿用 `open_external`：参数数组（绝不拼 shell 字符串），
//!   Windows 下 CREATE_NO_WINDOW。
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// 支持的导出格式（`build_args` 的白名单）。
pub const FORMATS: &[&str] = &["docx", "epub", "html", "pdf", "odt"];

/// 导出超时秒数：超时强杀 pandoc 进程并报错。
pub const EXPORT_TIMEOUT_SECS: u64 = 120;

/// PDF 引擎探测顺序（提案 D2：检测到才启用 PDF 导出）。
pub const PDF_ENGINES: &[&str] = &["xelatex", "tectonic", "typst"];

/// `--embed-resources` 起始版本（2.19 之前叫 `--self-contained`）。
const EMBED_RESOURCES_SINCE: (u32, u32) = (2, 19);

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── 检测 ──

/// 检测到的 pandoc 信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PandocInfo {
    /// 用于实际导出的程序路径（PATH 命中时为裸名 `pandoc`，由子进程继承 PATH 解析）。
    pub path: String,
    /// `pandoc --version` 首行解析出的版本号（如 `3.7.0.2`）。
    pub version: String,
    /// 命中来源：`hint`（自定义路径）/ `path`（PATH）/ `fallback`（内置兜底路径）。
    pub source: &'static str,
}

/// 检测回执负载（`workspace:pandoc-detect-result` 事件）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectOutcome {
    pub request_id: String,
    pub ok: bool,
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// 检测到的 PDF 引擎（[`PDF_ENGINES`] 之一；未检测到为 `None`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_engine: Option<String>,
    /// 失败时的中文原因。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl DetectOutcome {
    pub fn found(
        request_id: impl Into<String>,
        info: PandocInfo,
        pdf_engine: Option<String>,
    ) -> Self {
        DetectOutcome {
            request_id: request_id.into(),
            ok: true,
            found: true,
            version: Some(info.version),
            path: Some(info.path),
            source: Some(info.source.to_string()),
            pdf_engine,
            message: None,
        }
    }

    pub fn missing(request_id: impl Into<String>, pdf_engine: Option<String>) -> Self {
        DetectOutcome {
            request_id: request_id.into(),
            ok: true,
            found: false,
            version: None,
            path: None,
            source: None,
            pdf_engine,
            message: None,
        }
    }

    pub fn failure(request_id: impl Into<String>, message: impl Into<String>) -> Self {
        DetectOutcome {
            request_id: request_id.into(),
            ok: false,
            found: false,
            version: None,
            path: None,
            source: None,
            pdf_engine: None,
            message: Some(message.into()),
        }
    }
}

/// 解析 `pandoc --version` 输出的版本号：取首行中第一个以数字开头的 token
/// （兼容 `pandoc 3.7.0.2` 与带构建后缀的形态）。
pub fn parse_version(output: &str) -> Option<String> {
    output
        .lines()
        .next()?
        .split_whitespace()
        .find(|token| token.chars().next().map_or(false, |c| c.is_ascii_digit()))
        .map(str::to_string)
}

/// 版本比较：`version` 的前两段数字是否 ≥ `(major, minor)`。
/// 非数字前缀被截断（如 `3-dev` 视作 3）；解析失败按 0 处理。
pub fn version_at_least(version: &str, major: u32, minor: u32) -> bool {
    let mut nums = version.split('.');
    let parse_head = |s: Option<&str>| -> u32 {
        s.and_then(|s| {
            let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse().ok()
        })
        .unwrap_or(0)
    };
    let (v_major, v_minor) = (parse_head(nums.next()), parse_head(nums.next()));
    (v_major, v_minor) >= (major, minor)
}

/// 校验导出格式在白名单内。
pub fn validate_format(format: &str) -> Result<(), String> {
    if FORMATS.contains(&format) {
        Ok(())
    } else {
        Err(format!("不支持的导出格式：{format}"))
    }
}

/// 平台兜底目录下的候选可执行文件路径（不受 PATH 环境影响）。
pub fn fallback_binaries(name: &str) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if cfg!(target_os = "windows") {
        let file_name = format!("{name}.exe");
        // 环境变量缺失时退回硬编码默认安装位置
        if let Some(dir) = std::env::var_os("ProgramFiles") {
            out.push(
                std::path::PathBuf::from(dir)
                    .join("Pandoc")
                    .join(&file_name),
            );
        }
        out.push(std::path::PathBuf::from(r"C:\Program Files\Pandoc").join(&file_name));
        if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
            out.push(
                std::path::PathBuf::from(dir)
                    .join("Pandoc")
                    .join(&file_name),
            );
        }
    } else {
        out.push(std::path::PathBuf::from("/opt/homebrew/bin").join(name));
        out.push(std::path::PathBuf::from("/usr/local/bin").join(name));
        out.push(std::path::PathBuf::from("/usr/bin").join(name));
        if let Some(home) = std::env::var_os("HOME") {
            out.push(std::path::PathBuf::from(home).join(".local/bin").join(name));
        }
    }
    out
}

/// 按平台探测检测顺序执行：自定义路径（hint）→ PATH → 兜底路径清单。
/// hint 非空但探测失败时直接报错，不静默回退其他来源。
pub fn detect(path_hint: Option<&str>) -> Result<PandocInfo, String> {
    if let Some(hint) = path_hint.map(str::trim).filter(|s| !s.is_empty()) {
        return match probe_version(hint) {
            Some(version) => Ok(PandocInfo {
                path: hint.to_string(),
                version,
                source: "hint",
            }),
            None => Err(format!("指定的 pandoc 路径不可用：{hint}")),
        };
    }
    if let Some(version) = probe_version("pandoc") {
        return Ok(PandocInfo {
            path: "pandoc".to_string(),
            version,
            source: "path",
        });
    }
    for candidate in fallback_binaries("pandoc") {
        let candidate = candidate.to_string_lossy().into_owned();
        if let Some(version) = probe_version(&candidate) {
            return Ok(PandocInfo {
                path: candidate,
                version,
                source: "fallback",
            });
        }
    }
    Err("未检测到 pandoc。请安装后重新检测，或在设置 · 导出中指定 pandoc 路径".to_string())
}

/// 探测单个程序：spawn `<program> --version`，成功返回版本号。
/// 含路径分隔符的程序先做存在性检查（快速失败，避免慢速 spawn 报错）。
pub fn probe_version(program: &str) -> Option<String> {
    if (program.contains('/') || program.contains('\\')) && !std::path::Path::new(program).exists()
    {
        return None;
    }
    let mut cmd = std::process::Command::new(program);
    cmd.arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_version(&String::from_utf8_lossy(&output.stdout))
}

/// PDF 引擎检测：按 [`PDF_ENGINES`] 顺序，PATH 与兜底路径均尝试。
pub fn detect_pdf_engine() -> Option<String> {
    PDF_ENGINES.iter().find_map(|name| {
        if probe_version(name).is_some() {
            Some((*name).to_string())
        } else {
            fallback_binaries(name)
                .iter()
                .find_map(|candidate| probe_version(&candidate.to_string_lossy()))
                .map(|_| (*name).to_string())
        }
    })
}

/// 组装导出参数模板（格式白名单分派；调用方保证版本号来自检测结果）。
pub fn build_args(
    format: &str,
    pdf_engine: &str,
    out_path: &str,
    source_dir: &str,
    pandoc_version: &str,
) -> Result<Vec<String>, String> {
    validate_format(format)?;
    let mut args: Vec<String> = vec!["-f".into(), "markdown".into()];
    match format {
        "docx" => args.extend(["-t".into(), "docx".into()]),
        "epub" => args.extend(["-t".into(), "epub3".into()]),
        "odt" => args.extend(["-t".into(), "odt".into()]),
        "html" => {
            args.extend(["-t".into(), "html5".into(), "--standalone".into()]);
            if version_at_least(
                pandoc_version,
                EMBED_RESOURCES_SINCE.0,
                EMBED_RESOURCES_SINCE.1,
            ) {
                args.push("--embed-resources".into());
            } else {
                args.push("--self-contained".into());
            }
        }
        "pdf" => {
            let engine = pdf_engine.trim();
            if engine.is_empty() {
                return Err("PDF 导出缺少 pdf-engine 参数".to_string());
            }
            args.push(format!("--pdf-engine={engine}"));
        }
        other => return Err(format!("不支持的导出格式：{other}")),
    }
    let dir = source_dir.trim();
    if !dir.is_empty() {
        args.push(format!("--resource-path={dir}"));
    }
    args.push("-o".into());
    args.push(out_path.to_string());
    Ok(args)
}

// ── 导出 ──

/// 导出请求（`pandoc.export` 命令负载）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    /// 请求关联 id：前端生成，回执原样带回。
    pub request_id: String,
    /// 目标格式（[`FORMATS`] 白名单）。
    pub format: String,
    /// 导出目标绝对路径（前端先经原生另存为对话框取得）。
    pub out_path: String,
    /// 源文件所在目录（`--resource-path`；未保存新文件时可留空）。
    pub source_dir: String,
    /// 编辑器内存 buffer 全文（经 stdin 传入）。
    pub markdown: String,
}

/// 导出回执负载（`workspace:pandoc-export-result` 事件）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub request_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub out_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
}

impl ExportOutcome {
    pub fn success(
        request_id: impl Into<String>,
        out_path: impl Into<String>,
        elapsed_ms: u64,
    ) -> Self {
        ExportOutcome {
            request_id: request_id.into(),
            ok: true,
            out_path: Some(out_path.into()),
            message: None,
            elapsed_ms: Some(elapsed_ms),
        }
    }

    pub fn failure(request_id: impl Into<String>, message: impl Into<String>) -> Self {
        ExportOutcome {
            request_id: request_id.into(),
            ok: false,
            out_path: None,
            message: Some(message.into()),
            elapsed_ms: None,
        }
    }
}

/// 执行导出：检测 → 组参 → spawn pandoc（stdin 投喂全文，120s 超时）。
pub fn run_export(req: &ExportRequest, path_hint: Option<&str>) -> ExportOutcome {
    let start = std::time::Instant::now();
    if let Err(e) = validate_format(&req.format) {
        return ExportOutcome::failure(&req.request_id, e);
    }
    if req.out_path.trim().is_empty() {
        return ExportOutcome::failure(&req.request_id, "导出目标路径为空");
    }
    let info = match detect(path_hint) {
        Ok(info) => info,
        Err(e) => return ExportOutcome::failure(&req.request_id, e),
    };
    let engine = if req.format == "pdf" {
        match detect_pdf_engine() {
            Some(engine) => engine,
            None => {
                return ExportOutcome::failure(
                    &req.request_id,
                    "未检测到 PDF 引擎（需要 xelatex / tectonic / typst 之一）",
                )
            }
        }
    } else {
        String::new()
    };
    let args = match build_args(
        &req.format,
        &engine,
        &req.out_path,
        &req.source_dir,
        &info.version,
    ) {
        Ok(args) => args,
        Err(e) => return ExportOutcome::failure(&req.request_id, e),
    };
    match spawn_export(&info.path, &args, req.markdown.as_bytes()) {
        Ok(()) => ExportOutcome::success(
            &req.request_id,
            &req.out_path,
            start.elapsed().as_millis() as u64,
        ),
        Err(e) => ExportOutcome::failure(&req.request_id, e),
    }
}

/// spawn pandoc 并等待退出：stdin 写全文、stderr 收集各走独立线程，
/// 主流程轮询 `try_wait` 直到超时强杀。失败时回传 stderr 末几行。
fn spawn_export(program: &str, args: &[String], markdown: &[u8]) -> Result<(), String> {
    use std::io::{Read, Write};

    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("启动 pandoc 失败：{e}"))?;

    let mut stdin = child.stdin.take().ok_or("pandoc stdin 不可用")?;
    let markdown = markdown.to_vec();
    let stdin_thread = std::thread::spawn(move || {
        let _ = stdin.write_all(&markdown);
    });
    let mut stderr = child.stderr.take();
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(stream) = stderr.as_mut() {
            let _ = stream.read_to_string(&mut buf);
        }
        buf
    });

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(EXPORT_TIMEOUT_SECS);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "导出超时（超过 {EXPORT_TIMEOUT_SECS} 秒），已终止 pandoc 进程"
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(format!("等待 pandoc 退出失败：{e}")),
        }
    };
    let _ = stdin_thread.join();
    let stderr_text = stderr_thread.join().unwrap_or_default();
    if !status.success() {
        let tail: Vec<&str> = stderr_text.lines().rev().take(6).collect();
        let detail = if tail.iter().all(|l| l.trim().is_empty()) {
            format!("退出码 {:?}", status.code())
        } else {
            tail.iter().rev().copied().collect::<Vec<_>>().join("\n")
        };
        return Err(format!("pandoc 导出失败：{detail}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_取首行数字token() {
        assert_eq!(
            parse_version("pandoc 3.7.0.2\nCopyright (C) 2006-2026\n"),
            Some("3.7.0.2".to_string())
        );
        assert_eq!(parse_version("pandoc 2.9.2.1"), Some("2.9.2.1".to_string()));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("未找到"), None);
    }

    #[test]
    fn version_at_least_边界比较() {
        assert!(version_at_least("3.7.0.2", 2, 19));
        assert!(version_at_least("2.19.0", 2, 19));
        assert!(!version_at_least("2.18.9", 2, 19));
        assert!(!version_at_least("2.9.2.1", 2, 19));
        assert!(version_at_least("3", 2, 19));
        assert!(!version_at_least("", 1, 0));
    }

    #[test]
    fn validate_format_白名单() {
        assert!(validate_format("docx").is_ok());
        assert!(validate_format("pdf").is_ok());
        assert!(validate_format("exe").is_err());
        assert!(validate_format("").is_err());
        // 路径穿越与注入形态一律不在白名单
        assert!(validate_format("../../x").is_err());
    }

    #[test]
    fn build_args_各格式模板() {
        // docx：-f markdown -t docx + resource-path + -o 收尾
        let args = build_args("docx", "", "D:/out/a.docx", "D:/src", "3.7.0.2").unwrap();
        assert_eq!(
            args,
            vec![
                "-f",
                "markdown",
                "-t",
                "docx",
                "--resource-path=D:/src",
                "-o",
                "D:/out/a.docx"
            ]
        );
        // epub 显式 epub3；odt 常规
        let args = build_args("epub", "", "a.epub", "", "3.7.0.2").unwrap();
        assert!(args.contains(&"epub3".to_string()));
        assert!(!args.iter().any(|a| a.starts_with("--resource-path")));
        assert!(build_args("odt", "", "a.odt", "", "3.7.0.2").is_ok());
        // html：standalone + 新版 embed-resources
        let args = build_args("html", "", "a.html", "", "3.7.0.2").unwrap();
        assert!(args.contains(&"--standalone".to_string()));
        assert!(args.contains(&"--embed-resources".to_string()));
        // html：旧版回退 self-contained
        let args = build_args("html", "", "a.html", "", "2.11").unwrap();
        assert!(args.contains(&"--self-contained".to_string()));
        assert!(!args.contains(&"--embed-resources".to_string()));
        // pdf：必须带引擎
        let args = build_args("pdf", "xelatex", "a.pdf", "", "3.7.0.2").unwrap();
        assert!(args.contains(&"--pdf-engine=xelatex".to_string()));
        assert!(build_args("pdf", "", "a.pdf", "", "3.7.0.2").is_err());
        // 未知格式与 -o 永远收尾
        assert!(build_args("exe", "", "a.exe", "", "3.7.0.2").is_err());
        let args = build_args("docx", "", "D:/out/a.docx", "", "3.7.0.2").unwrap();
        assert_eq!(args[args.len() - 2], "-o");
    }

    #[test]
    fn fallback_binaries_非空且含平台特征() {
        let candidates = fallback_binaries("pandoc");
        assert!(!candidates.is_empty());
        if cfg!(target_os = "windows") {
            assert!(candidates
                .iter()
                .any(|p| p.to_string_lossy().contains("Pandoc")));
        }
    }

    #[test]
    fn detect_hint_不可用时报错不回退() {
        let missing = if cfg!(target_os = "windows") {
            "Z:/definitely/not/here/pandoc.exe"
        } else {
            "/definitely/not/here/pandoc"
        };
        let err = detect(Some(missing)).unwrap_err();
        assert!(err.contains("不可用"));
    }

    #[test]
    fn outcome_构造与序列化_camelCase() {
        let outcome = ExportOutcome::success("r1", "D:/out/a.docx", 120);
        let json = serde_json::to_value(&outcome).unwrap();
        assert_eq!(json["requestId"], "r1");
        assert_eq!(json["outPath"], "D:/out/a.docx");
        assert_eq!(json["elapsedMs"], 120);
        let failure = DetectOutcome::failure("r2", "未检测到 pandoc");
        let json = serde_json::to_value(&failure).unwrap();
        assert_eq!(json["message"], "未检测到 pandoc");
        assert!(json.get("version").is_none());
    }
}
