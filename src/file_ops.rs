use rfd::FileDialog;
use std::fs;

pub const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif",
];
pub const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "txt"];

pub fn is_image_extension(ext: &str) -> bool {
    let lower = ext.to_ascii_lowercase();
    IMAGE_EXTENSIONS.iter().any(|&e| e == lower)
}

pub fn is_image_path(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(is_image_extension)
        .unwrap_or(false)
}

pub fn pick_open_file() -> Option<String> {
    let mut all_supported = Vec::new();
    all_supported.extend_from_slice(MARKDOWN_EXTENSIONS);
    all_supported.extend_from_slice(IMAGE_EXTENSIONS);

    FileDialog::new()
        .add_filter("Supported Files", &all_supported)
        .add_filter("Markdown", MARKDOWN_EXTENSIONS)
        .add_filter("Images", IMAGE_EXTENSIONS)
        .add_filter("All files", &["*"])
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

pub fn pick_workspace_folder() -> Option<String> {
    FileDialog::new()
        .set_title("打开项目文件夹")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

pub fn pick_save_file() -> Option<String> {
    FileDialog::new()
        .add_filter("Markdown", &["md", "markdown"])
        .add_filter("All files", &["*"])
        .set_file_name("untitled.md")
        .save_file()
        .map(|p| p.to_string_lossy().to_string())
}

/// 设置页「浏览…」选择 pandoc 可执行文件（FEAT-006）。
/// Windows 按 .exe 过滤；macOS/Linux 的 pandoc 二进制无扩展名，只留 All files。
pub fn pick_pandoc_binary() -> Option<String> {
    let mut dialog = FileDialog::new().set_title("选择 pandoc 可执行文件");
    #[cfg(target_os = "windows")]
    {
        dialog = dialog.add_filter("pandoc (pandoc.exe)", &["exe"]);
    }
    dialog
        .add_filter("All files", &["*"])
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

fn export_filename(format: &str, suggest_name: &str) -> String {
    let extension = match format {
        "docx" | "epub" | "html" | "odt" | "pdf" => format,
        _ => "md",
    };
    let name = suggest_name.trim();
    let stem = match name.rsplit_once('.') {
        Some((stem, ext)) if ext.eq_ignore_ascii_case(extension) => stem,
        _ => name,
    };
    // 原生对话框只接收文件名；替换路径分隔符、控制字符和 Windows 非法字符。
    let cleaned: String = stem
        .chars()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut base = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if base.is_empty() {
        base = "untitled".into();
    }
    // Windows 设备名即使附带扩展名也不可用。
    let device = base.split('.').next().unwrap_or("").to_uppercase();
    let numbered_device = device
        .strip_prefix("COM")
        .or_else(|| device.strip_prefix("LPT"))
        .is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        });
    if matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL") || numbered_device {
        base.insert(0, '_');
    }
    format!("{base}.{extension}")
}

/// 导出另存为对话框（FEAT-006）：按格式加过滤器并预填建议文件名。
/// 未知格式回退 Markdown 过滤器（前端只发白名单格式，此处兜底）。
pub fn pick_export_file(format: &str, suggest_name: &str) -> Option<String> {
    let mut dialog = FileDialog::new();
    match format {
        "docx" => {
            dialog = dialog.add_filter("Word 文档", &["docx"]);
        }
        "epub" => {
            dialog = dialog.add_filter("EPUB 电子书", &["epub"]);
        }
        "html" => {
            dialog = dialog.add_filter("HTML", &["html", "htm"]);
        }
        "odt" => {
            dialog = dialog.add_filter("OpenDocument 文本", &["odt"]);
        }
        "pdf" => {
            dialog = dialog.add_filter("PDF", &["pdf"]);
        }
        _ => {
            dialog = dialog.add_filter("Markdown", &["md"]);
        }
    }
    dialog = dialog.add_filter("All files", &["*"]);
    dialog = dialog.set_file_name(export_filename(format, suggest_name));
    dialog.save_file().map(|p| p.to_string_lossy().to_string())
}

pub fn read_file(path: &str) -> Result<String, std::io::Error> {
    if is_image_path(path) {
        fs::metadata(path)?;
        Ok(String::new())
    } else {
        fs::read_to_string(path)
    }
}

pub fn write_file(path: &str, content: &str) -> Result<(), std::io::Error> {
    fs::write(path, content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_filename_preserves_document_basename() {
        assert_eq!(export_filename("pdf", "会议纪要.pdf"), "会议纪要.pdf");
        assert_eq!(export_filename("pdf", "draft.v2.pdf"), "draft.v2.pdf");
        assert_eq!(export_filename("pdf", "REPORT.PDF"), "REPORT.pdf");
        for format in ["docx", "epub", "html", "odt", "pdf"] {
            let name = format!("会议纪要.v2.{format}");
            assert_eq!(export_filename(format, &name), name);
            assert_eq!(export_filename(format, ""), format!("untitled.{format}"));
        }
        assert_eq!(export_filename("unknown", "note.md"), "note.md");
    }

    #[test]
    fn export_filename_replaces_invalid_windows_characters() {
        assert_eq!(
            export_filename("pdf", "a\\/:*?\"<>|\0\n.pdf"),
            "a___________.pdf"
        );
        assert_eq!(export_filename("pdf", "  会议纪要. .pdf  "), "会议纪要.pdf");
    }

    #[test]
    fn export_filename_always_has_a_usable_basename() {
        for name in ["", "   ", ".pdf", "...pdf"] {
            assert_eq!(export_filename("pdf", name), "untitled.pdf");
        }
        for name in ["CON", "nul", "COM1", "LPT9", "COM¹", "LPT²", "AUX.backup"] {
            assert_eq!(
                export_filename("pdf", &format!("{name}.pdf")),
                format!("_{name}.pdf")
            );
        }
        assert_eq!(export_filename("pdf", "COM10.pdf"), "COM10.pdf");
    }
}
