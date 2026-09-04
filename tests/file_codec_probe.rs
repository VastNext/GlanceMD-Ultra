//! file_codec 的对外集成测试（主实施计划阶段 6 交付项 2 探针）。
//!
//! 本项目是纯 bin crate：`main.rs` 声明 `mod file_codec;` 之前，src 侧的
//! `#[cfg(test)]` 测试不会被收集，因此这里用 `#[path]` 直接引入模块源码
//! （模式同 `tests/platform_probe.rs`）。文件长期保留，充当编码读写的
//! 对外行为契约：BOM/换行零漂移往返、非 UTF-8 显式拒绝、Mixed 语义。
//!
//! 阶段 6 验收标准对照（主计划）：BOM 与换行符往返（读→存→读）零漂移。

#[path = "../src/file_codec.rs"]
mod file_codec;

use file_codec::{
    detect, encode, read_text, CodecError, DetectedEncoding, Eol, TextFile, UTF8_BOM,
};

const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

fn meta(content: &str, eol: Eol, had_bom: bool) -> TextFile {
    TextFile {
        content: content.to_string(),
        original_eol: eol,
        had_bom,
    }
}

// ---------- 零漂移往返（全组合） ----------

/// 主计划阶段 6 验收项：对 {无BOM/LF、无BOM/CRLF、BOM/LF、BOM/CRLF、Mixed}
/// 全组合，读→写 必须逐字节还原原始输入，读→写→读 元数据与内容完全一致。
#[test]
fn 往返_全组合_读写出原始字节零漂移() {
    let bom_lf = {
        let mut v = BOM.to_vec();
        v.extend_from_slice("你好\nmarkdown\n".as_bytes());
        v
    };
    let bom_crlf = {
        let mut v = BOM.to_vec();
        v.extend_from_slice("你好\r\nmarkdown\r\n".as_bytes());
        v
    };
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("无BOM/LF", b"# Title\n\nline1\nline2\n".to_vec()),
        ("无BOM/CRLF", b"# Title\r\n\r\nline1\r\nline2\r\n".to_vec()),
        ("BOM/LF", bom_lf),
        ("BOM/CRLF", bom_crlf),
        ("Mixed", b"a\r\nb\nc\r\n\nd\n".to_vec()),
    ];
    for (name, bytes) in cases {
        let tf = read_text(&bytes).unwrap_or_else(|e| panic!("{name}: 读取失败：{e}"));
        let written = encode(&tf.content, &tf);
        assert_eq!(written, bytes, "{name}: 写回字节与原始字节不一致");

        let reread = read_text(&written).unwrap_or_else(|e| panic!("{name}: 复读失败：{e}"));
        assert_eq!(reread, tf, "{name}: 读→写→读 后内容/元数据不一致");
    }
}

/// 退化输入的往返：空文件与仅含 BOM 的文件。
#[test]
fn 往返_空文件与仅bom文件零漂移() {
    for bytes in [b"".to_vec(), BOM.to_vec()] {
        let tf = read_text(&bytes).unwrap();
        assert_eq!(encode(&tf.content, &tf), bytes);
        assert_eq!(read_text(&encode(&tf.content, &tf)).unwrap(), tf);
    }
}

/// 编辑场景：CRLF 原文件上用户新输入的 LF 行，保存时统一还原为 CRLF；
/// 反之 LF 原文件中混入的 CRLF 保存时归一为 LF。
#[test]
fn encode_按原风格转换新增行并回填bom() {
    // CRLF 原文件：新增 LF 行 → 全部转 CRLF
    assert_eq!(
        encode("old\nnew\n", &meta("", Eol::Crlf, false)),
        b"old\r\nnew\r\n"
    );
    // 内容已是 CRLF 时幂等（写回不叠加 \r）
    assert_eq!(
        encode("old\r\nnew\r\n", &meta("", Eol::Crlf, false)),
        b"old\r\nnew\r\n"
    );
    // LF 原文件：混入的 CRLF → 归一 LF
    assert_eq!(
        encode("old\r\nnew\n", &meta("", Eol::Lf, false)),
        b"old\nnew\n"
    );
    // BOM 按原样回填（且只回填一次）
    assert_eq!(
        encode("x\n", &meta("", Eol::Lf, true)),
        [UTF8_BOM.as_slice(), b"x\n"].concat()
    );
    // Mixed：原样写出，不强行统一
    assert_eq!(
        encode("x\r\ny\n", &meta("", Eol::Mixed, false)),
        b"x\r\ny\n"
    );
}

// ---------- 非 UTF-8：显式拒绝，不静默错误解码 ----------

#[test]
fn read_text_非utf8显式报错() {
    // GBK 编码的 "中文"（D6 D0 CE C4），是真实世界最常见的非 UTF-8 输入
    let gbk_chinese = [0xD6u8, 0xD0, 0xCE, 0xC4];
    let bom_gbk = [BOM, gbk_chinese.as_slice()].concat(); // BOM 也救不了非法内容
    let raw_fffe = vec![0xFFu8, 0xFE, 0x00];
    for bytes in [
        gbk_chinese.as_slice(),
        bom_gbk.as_slice(),
        raw_fffe.as_slice(),
    ] {
        assert!(matches!(
            read_text(bytes),
            Err(CodecError::UnsupportedEncoding)
        ));
        assert_eq!(detect(bytes), DetectedEncoding::NonUtf8);
    }
    // 错误消息明确"仅支持 UTF-8"，指引而非含糊
    let msg = CodecError::UnsupportedEncoding.to_string();
    assert!(msg.contains("仅支持 UTF-8"), "错误消息不达标：{msg}");
}

// ---------- detect 嗅探 ----------

#[test]
fn detect_区分三种形态() {
    assert_eq!(detect(b"plain text"), DetectedEncoding::Utf8);
    assert_eq!(detect(b""), DetectedEncoding::Utf8);
    assert_eq!(
        detect(&[BOM, b"hello\n".as_slice()].concat()),
        DetectedEncoding::Utf8Bom
    );
    assert_eq!(detect(BOM), DetectedEncoding::Utf8Bom);
    assert_eq!(detect(&[0xFF, 0xFE]), DetectedEncoding::NonUtf8);
    // 畸形：BOM + 非 UTF-8 内容，read_text 拒绝，嗅探同样不给绿色承诺
    assert_eq!(
        detect(&[BOM, [0xD6u8, 0xD0].as_slice()].concat()),
        DetectedEncoding::NonUtf8
    );
}

// ---------- 换行语义 ----------

#[test]
fn read_text_换行检测与lf统一存储语义() {
    // 纯 LF：原样
    let tf = read_text(b"a\nb\n").unwrap();
    assert_eq!(tf.original_eol, Eol::Lf);
    assert_eq!(tf.content, "a\nb\n");
    assert!(!tf.had_bom);

    // 纯 CRLF：检测为 Crlf，内容统一为 LF 存储（与前端编辑器形态一致）
    let tf = read_text(b"a\r\nb\r\n").unwrap();
    assert_eq!(tf.original_eol, Eol::Crlf);
    assert_eq!(tf.content, "a\nb\n");

    // BOM 记录进元数据并从内容剥离
    let tf = read_text(&[BOM, b"a\r\n".as_slice()].concat()).unwrap();
    assert!(tf.had_bom);
    assert_eq!(tf.content, "a\n");
    assert_eq!(tf.original_eol, Eol::Crlf);

    // Mixed：检测为 Mixed，内容原样保留（不统一），写回零漂移的前提
    let tf = read_text(b"a\r\nb\nc").unwrap();
    assert_eq!(tf.original_eol, Eol::Mixed);
    assert_eq!(tf.content, "a\r\nb\nc");

    // 无换行符：按 Lf 处理；孤立 \r 作为内容字符保留
    let tf = read_text(b"no-eol").unwrap();
    assert_eq!(tf.original_eol, Eol::Lf);
    let tf = read_text(b"a\rb\nc\n").unwrap();
    assert_eq!(tf.original_eol, Eol::Lf);
    assert_eq!(tf.content, "a\rb\nc\n");
}
