//! Windows 静默导出 PDF（FEAT-008）。
//!
//! [`print_webview_to_pdf`]：把 WebView 当前内容（应用 `@media print` 样式，
//! 即 print.css）直写为 PDF 文件。Windows 走 WebView2 `PrintToPdf`；其余
//! 平台未实现（返回错误，前端不调用，维持系统打印对话框路线）。

use std::path::Path;

use wry::WebView;

/// 把 WebView 当前内容导出为 PDF 文件。阻塞直至完成，返回成败。
pub fn print_webview_to_pdf(webview: &WebView, out_path: &Path) -> Result<(), String> {
    imp::print_webview_to_pdf(webview, out_path)
}

#[cfg(target_os = "windows")]
mod imp {
    //! `WebViewExtWindows::controller()` 取 `ICoreWebView2Controller` →
    //! `CoreWebView2` cast `ICoreWebView2_16` → `PrintToPdf`。
    //!
    //! 完成回执经 [`webview2_com::wait_with_pump`] 消息泵等待——泵保持 UI
    //! 消息循环运转（重绘/输入不冻结），完成事件在泵内送达后同步返回。
    //!
    //! 打印设置传 `None`（默认纸型/页边距）：开背景打印需经 environment 创建
    //! `ICoreWebView2PrintSettings`，wry 0.49 未暴露 environment，v1 不开
    //! （代码块无底色但有边框，可读）。

    use std::path::Path;

    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_16;
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING};
    use wry::{WebView, WebViewExtWindows};

    pub fn print_webview_to_pdf(webview: &WebView, out_path: &Path) -> Result<(), String> {
        let controller = webview.controller();
        let core =
            unsafe { controller.CoreWebView2() }.map_err(|e| format!("获取 WebView2 失败：{e}"))?;
        let core16 = core
            .cast::<ICoreWebView2_16>()
            .map_err(|e| format!("WebView2 Runtime 过旧，不支持静默导出 PDF：{e}"))?;

        let (tx, rx) = std::sync::mpsc::channel();
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |_hr, ok| {
            let _ = tx.send(ok);
            Ok(())
        }));

        let path = HSTRING::from(out_path.as_os_str());
        unsafe {
            // 默认打印设置（None）；完成回执由 handler 经 channel 送回
            core16
                .PrintToPdf(&path, None, &handler)
                .map_err(|e| format!("发起 PDF 导出失败：{e}"))?;
        }

        let ok =
            webview2_com::wait_with_pump(rx).map_err(|e| format!("等待 PDF 导出完成失败：{e}"))?;
        if ok {
            Ok(())
        } else {
            Err("PDF 导出失败，请重试".to_string())
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    //! 非 Windows 占位：静默导出未实现（macOS/Linux 维持系统打印对话框
    //! 路线，由前端按平台分支调用 `app.print`，不会走到这里）。

    use std::path::Path;

    use wry::WebView;

    pub fn print_webview_to_pdf(_webview: &WebView, _out_path: &Path) -> Result<(), String> {
        Err("当前平台不支持静默导出 PDF".to_string())
    }
}
