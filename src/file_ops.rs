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
    if !suggest_name.trim().is_empty() {
        dialog = dialog.set_file_name(suggest_name.trim());
    }
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
