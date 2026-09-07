use std::path::PathBuf;

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let mut res = winresource::WindowsResource::new();
    res.set_icon("assets/icon.ico");
    res.compile().unwrap();

    // webview2-com-sys 在 MSVC 下静态链接 WebView2LoaderStatic.lib；GNU 目标则
    // 固定动态导入 WebView2Loader.dll。为保证本机 windows-gnu 的 exe 可直接运行，
    // 把 crate 对应版本的官方 x64 loader sidecar 复制到 target/<profile>/。
    // CI/Release 使用 MSVC，不需要 sidecar，正式发布物仍保持单 exe。
    let is_gnu = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu");
    let is_x64 = std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("x86_64");
    if is_gnu && is_x64 {
        let source = PathBuf::from("assets/windows/WebView2Loader.dll");
        println!("cargo:rerun-if-changed={}", source.display());

        let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
        let profile_dir = out_dir
            .ancestors()
            .nth(3)
            .expect("Cargo OUT_DIR 缺少 target/<profile> 层级");
        let destination = profile_dir.join("WebView2Loader.dll");
        std::fs::copy(&source, &destination).unwrap_or_else(|e| {
            panic!(
                "复制 WebView2Loader.dll 到 {} 失败：{e}",
                destination.display()
            )
        });
    }
}
