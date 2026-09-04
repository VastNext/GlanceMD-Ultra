//! 编码与换行元数据读写（主实施计划阶段 6 交付项 2）。
//!
//! 产品决策（主计划 §0.2，不可重开）：第一阶段仅支持 UTF-8 / UTF-8 BOM，
//! 并保留原文件的换行风格（LF / CRLF）；GBK 等其他编码后置。因此：
//!
//! - 非 UTF-8 字节一律显式报错（[`CodecError::UnsupportedEncoding`]），
//!   **绝不静默错误解码**——那会把用户文件写成乱码；
//! - [`read_text`] 把内容统一为 LF 存储（确定换行风格时），同时记录原文件
//!   的 BOM 与换行元数据；[`encode`] 写回时按元数据还原原风格；
//! - Mixed（LF 与 CRLF 混杂）文件无法在"统一 LF 存储"的同时保证字节级
//!   零漂移，因此读取时**原样保留**内容中的换行序列，写回时也原样写出
//!   （尽力保留语义，见 [`Eol::Mixed`]）。
//!
//! 往返保证（`tests/file_codec_probe.rs` 全组合覆盖）：对同一份字节，
//! `encode(read_text(b).content, &meta)` 与 `b` 逐字节一致——编辑器未改动
//! 内容时，保存不会引入任何字节漂移（阶段 6 验收标准）。
//!
//! 接线说明：本模块为纯新增，`main.rs` 的 `mod file_codec;` 声明由集成方
//! 添加；集成前没有生产调用方（`file_ops::read_file/write_file` 仍是旧
//! 路径），因此暂时允许 dead_code。模块自含（仅依赖 std/serde_json），
//! 可被 `tests/file_codec_probe.rs` 以 `#[path]` 方式独立编译测试。

#![allow(dead_code)]

/// UTF-8 BOM 字节序列（EF BB BF）。
pub const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// 嗅探结果：只区分"能按 UTF-8 语义读取"的三种形态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetectedEncoding {
    /// 无 BOM 的合法 UTF-8。
    Utf8,
    /// 带 UTF-8 BOM（BOM 之后的其余字节也是合法 UTF-8）。
    Utf8Bom,
    /// 非 UTF-8（含"BOM + 非 UTF-8 内容"的畸形组合）——拒绝读取。
    NonUtf8,
}

/// 换行风格。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eol {
    /// 全部为 LF；完全不含换行符的文件也归入此档（写回不做转换，零风险）。
    Lf,
    /// 全部为 CRLF。
    Crlf,
    /// LF 与 CRLF 混杂（罕见）：读取与写回都按原样保留，不做统一——
    /// 统一化是有损的（无法记住"哪几行原本是 CRLF"），强行归一会破坏
    /// 零漂移往返，故对 Mixed 选择字节级保真。
    Mixed,
}

/// 一次读取得到的文本及其编码元数据。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextFile {
    /// 文本内容：确定换行风格（Lf / Crlf）时统一为 LF 存储；Mixed 原样保留。
    pub content: String,
    /// 读取时检测到的原文件换行风格，写回时据此还原。
    pub original_eol: Eol,
    /// 原文件是否带 UTF-8 BOM，写回时按原样回填。
    pub had_bom: bool,
}

/// 编解码错误。
#[derive(Debug)]
pub enum CodecError {
    /// 非 UTF-8 编码：仅支持 UTF-8 / UTF-8 BOM，不做静默错误解码。
    UnsupportedEncoding,
}

impl std::fmt::Display for CodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodecError::UnsupportedEncoding => write!(
                f,
                "仅支持 UTF-8 或 UTF-8 BOM 编码的文本文件（检测到非 UTF-8 字节，已拒绝读取以避免乱码）"
            ),
        }
    }
}

impl std::error::Error for CodecError {}

/// 嗅探字节序列的编码形态（廉价检查；[`read_text`] 才是权威校验）。
///
/// 语义与 [`read_text`] 严格一致：带 BOM 但 BOM 之后不是合法 UTF-8 的
/// 畸形文件同样报告 [`DetectedEncoding::NonUtf8`]——[`read_text`] 会拒绝
/// 它，嗅探结果不能承诺读不出来的事情。
pub fn detect(bytes: &[u8]) -> DetectedEncoding {
    match bytes.strip_prefix(&UTF8_BOM) {
        Some(rest) => {
            if std::str::from_utf8(rest).is_ok() {
                DetectedEncoding::Utf8Bom
            } else {
                DetectedEncoding::NonUtf8
            }
        }
        None => {
            if std::str::from_utf8(bytes).is_ok() {
                DetectedEncoding::Utf8
            } else {
                DetectedEncoding::NonUtf8
            }
        }
    }
}

/// 读取文本字节为 [`TextFile`]：剥离 BOM → 严格 UTF-8 解码 → 检测换行风格。
///
/// - 非 UTF-8 返回 [`CodecError::UnsupportedEncoding`]（中文错误消息，
///   明确"仅支持 UTF-8 / UTF-8 BOM"，绝不静默错误解码）；
/// - 确定换行风格（Lf / Crlf）时 `content` 统一为 LF 存储，CRLF 文件交给
///   前端的内容与手工新建内容形态一致；Mixed 原样保留（见模块文档）。
pub fn read_text(bytes: &[u8]) -> Result<TextFile, CodecError> {
    let (had_bom, payload) = match bytes.strip_prefix(&UTF8_BOM) {
        Some(rest) => (true, rest),
        None => (false, bytes),
    };
    let text = std::str::from_utf8(payload).map_err(|_| CodecError::UnsupportedEncoding)?;
    let original_eol = detect_eol(text);
    let content = match original_eol {
        // 统一 LF 存储：与 encode 的 LF→CRLF 转换互为逆操作，保证零漂移
        Eol::Crlf => text.replace("\r\n", "\n"),
        Eol::Lf | Eol::Mixed => text.to_string(),
    };
    Ok(TextFile {
        content,
        original_eol,
        had_bom,
    })
}

/// 把内容按 `original` 元数据编码回字节：换行风格还原 + BOM 原样回填。
///
/// 转换前先归一到 LF 再转目标风格（幂等），因此无论传入内容是"读取时的
/// LF 统一存储"还是编辑过程中混入的其他风格，写回结果都符合原文件风格：
///
/// - `Eol::Lf`：任何 CRLF 归一为 LF；
/// - `Eol::Crlf`：任何换行统一为 CRLF；
/// - `Eol::Mixed`：原样写出（无法重建原混杂模式，见 [`Eol::Mixed`]）。
pub fn encode(text: &str, original: &TextFile) -> Vec<u8> {
    let unified = match original.original_eol {
        Eol::Lf => text.replace("\r\n", "\n"),
        Eol::Crlf => text.replace("\r\n", "\n").replace('\n', "\r\n"),
        Eol::Mixed => text.to_string(),
    };
    let mut out =
        Vec::with_capacity(unified.len() + usize::from(original.had_bom) * UTF8_BOM.len());
    if original.had_bom {
        out.extend_from_slice(&UTF8_BOM);
    }
    out.extend_from_slice(unified.as_bytes());
    out
}

/// 检测换行风格：`has_crlf && has_lone_lf` → Mixed；只其一 → 对应风格；
/// 都没有（含空文件）→ Lf。
///
/// 孤立 `\r`（Classic Mac 风格，现代文本几乎不出现）不计为换行，作为普通
/// 内容字符原样保留——它既不参与风格判定，也不会被 encode 改写。
fn detect_eol(text: &str) -> Eol {
    let bytes = text.as_bytes();
    let mut has_crlf = false;
    let mut has_lone_lf = false;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            // CRLF 成对消费；其余 `\r` 落入默认分支按内容处理
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                has_crlf = true;
                i += 2;
                continue;
            }
            // 能独立走到此分支的 `\n` 必然不在 `\r\n` 对中（CRLF 已被成对消费）
            b'\n' => has_lone_lf = true,
            _ => {}
        }
        i += 1;
    }
    match (has_crlf, has_lone_lf) {
        (true, true) => Eol::Mixed,
        (true, false) => Eol::Crlf,
        (false, _) => Eol::Lf,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_eol_四种形态() {
        assert_eq!(detect_eol("a\nb"), Eol::Lf);
        assert_eq!(detect_eol("a\r\nb"), Eol::Crlf);
        assert_eq!(detect_eol("a\r\nb\nc"), Eol::Mixed);
        assert_eq!(detect_eol("无换行"), Eol::Lf);
        // 孤立 \r 不计入换行
        assert_eq!(detect_eol("a\rb\nc"), Eol::Lf);
    }

    #[test]
    fn encode_对_crlf_输入幂等() {
        let meta = TextFile {
            content: String::new(),
            original_eol: Eol::Crlf,
            had_bom: false,
        };
        let once = encode("x\r\ny\r\n", &meta);
        assert_eq!(once, b"x\r\ny\r\n");
    }
}
