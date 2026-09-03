# 研究请求

- 用户原始需求：研究 GlanceMD 当前仅提供 Windows EXE 的现状，判断能否打包为 macOS 和 Linux 可用的软件包，并明确需要做哪些适配。
- 当前日期：2026-08-26
- 工作目录：`D:\WorkDev\MyShare\Peekdown`
- 目标读者与用途：项目维护者，用于决定是否启动跨平台适配及如何安排实现顺序。
- 已知约束：项目采用 Rust、tao、wry、rfd，前端资源内嵌；当前代码和依赖包含显著 Windows 专属实现；希望维持轻量、原生 WebView、无 Electron 的产品方向。
- 范围：当前代码可移植性、macOS/Linux 运行时后端、安装包与签名发布、CI 构建、测试与分阶段实施建议。
- 排除项：本轮不直接实现跨平台代码，不替项目申请 Apple Developer 证书，不执行实际 macOS/Linux 构建。
- 澄清记录：用户未限定发行渠道；默认同时考虑 GitHub Release 直发，以及 macOS 正常用户下载安装所需的签名/公证。Linux 默认优先 AppImage 与 `.deb`，兼顾其他格式的取舍。
- 当前执行假设：优先支持 macOS 近年版本的 Intel 与 Apple Silicon；Linux 优先 Ubuntu/Debian 系桌面，先支持 X11，再评估 Wayland 完整支持。
