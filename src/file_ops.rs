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

pub fn is_supported_file_extension(ext: &str) -> bool {
    let lower = ext.to_ascii_lowercase();
    MARKDOWN_EXTENSIONS.iter().any(|&e| e == lower) || is_image_extension(&lower)
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

pub fn pick_save_file() -> Option<String> {
    FileDialog::new()
        .add_filter("Markdown", &["md", "markdown"])
        .add_filter("All files", &["*"])
        .set_file_name("untitled.md")
        .save_file()
        .map(|p| p.to_string_lossy().to_string())
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
