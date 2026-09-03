# mdview — Lightweight Windows Markdown Viewer/Editor

> **归档说明**（2026-09-04）：本文档是 GlanceMD 前身（mdview/Peekdown 时期）的初始开发计划，描述的"Windows 单文件查看器"定位已被 GlanceMD Ultra 工作区产品取代，**内容已失效，仅作历史档案保留**。现行有效的开发计划见 `docs/plans/2026-09-04-glancemd-ultra-workspace-implementation-plan.md`，独立仓库决策见 `docs/adr/0001-glancemd-ultra-独立仓库.md`。

## Context
Build a native Windows markdown reader/editor that feels as fast as old-school Notepad but looks modern (Obsidian/Discord aesthetic). Single `.exe`, near-instant startup, minimal footprint.

## Tech Stack
- **Rust** + **WebView2** (via `wry` + `tao` crates — the Tauri engine, without the full Tauri framework)
- HTML/CSS/JS frontend embedded in the binary via `include_str!()`
- `marked.js` (~36KB) for markdown rendering client-side
- `rfd` for native file dialogs
- WebView2 is pre-installed on Windows 10/11 — no extra runtime needed

**Expected**: ~1-2MB binary, ~50-100ms startup

## Architecture

```
Rust (main.rs)                    WebView2 (HTML/CSS/JS)
┌─────────────────┐              ┌─────────────────────┐
│ Window (tao)    │              │ Toolbar              │
│ WebView (wry)   │◄──IPC──────►│ Editor (textarea)    │
│ File I/O        │              │ Preview (marked.js)  │
│ App State       │              │ Status Bar           │
│ Drag & Drop     │              │ Dark Theme CSS       │
└─────────────────┘              └─────────────────────┘
```

- **Rust side**: Window creation, file I/O, drag & drop handling, app state (current file, dirty flag)
- **JS side**: UI rendering, mode toggle, keyboard shortcuts, markdown parsing
- **IPC**: JS→Rust via `window.ipc.postMessage(JSON)`, Rust→JS via `webview.evaluate_script()`

## UI: Toggle Mode
Single pane that switches between:
- **Edit mode**: Textarea with monospace font, syntax-friendly
- **Preview mode**: Rendered markdown with modern typography

Toggle via `Ctrl+E` or toolbar button.

## Features
- **File ops**: New (`Ctrl+N`), Open (`Ctrl+O`), Save (`Ctrl+S`), Save As (`Ctrl+Shift+S`)
- **Drag & drop**: Drop a `.md` file onto the window to open it
- **Dirty tracking**: Title bar shows `*` when unsaved
- **Window state**: Remembers position/size across sessions (`%APPDATA%/mdview/`)
- **CLI arg**: Pass a file path to open on startup (for "Open with..." in Explorer)

## Project Structure
```
MarkdownViewer/
├── Cargo.toml
├── build.rs
├── assets/
│   └── icon.ico
└── src/
    ├── main.rs
    ├── ipc.rs
    ├── file_ops.rs
    ├── state.rs
    ├── window_state.rs
    └── frontend/
        ├── index.html
        ├── style.css
        ├── app.js
        ├── editor.js
        ├── preview.js
        └── marked.min.js
```

## Key Dependencies
| Crate | Purpose |
|-------|---------|
| `wry` | WebView2 wrapper |
| `tao` | Window creation/event loop |
| `serde` + `serde_json` | IPC message serialization |
| `rfd` | Native file dialogs |
| `dirs` | Config directory resolution |
| `winresource` | Build-time icon embedding |
