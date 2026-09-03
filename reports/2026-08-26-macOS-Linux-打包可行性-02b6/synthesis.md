# Synthesis

## 原始问题

GlanceMD 当前只构建 Windows EXE。需要判断它能否发布为 macOS 与 Linux 可用软件包，以及要完成哪些代码、运行时、桌面集成、打包和发布适配。

## 主线判断

1. **能够跨平台，而且无需迁移 Electron 或重写前端。** Wry、Tao、Rfd 本身支持 macOS/Linux，Markdown 与 UI 业务层基本可复用。当前障碍主要是 Windows 专属实现未被条件编译隔离。
2. **不能仅靠增加 Rust target 或重跑 `cargo build`。** Windows dependencies、资源脚本、Win32 resize/stdin、named mutex/pipe、Windows 专属 Wry API和自定义协议 URL都会阻断或破坏非 Windows 构建。
3. **macOS 是更适合先完成的新增平台。** 它直接使用系统 WebKit，依赖面较收敛；但正式分发必须补齐 `.app/.dmg`、`.icns`、Finder Opened 事件、Command 快捷键、Developer ID 签名和公证。
4. **Linux 可行但兼容承诺更复杂。** 当前版本依赖 GTK3 + WebKitGTK 4.1，X11/Wayland 需选择正确的 GTK container 构建路径；deb/AppImage 还要处理动态库、桌面 MIME、不同发行版和桌面环境测试。Linux 版本不应继续宣称“约 900 KB、无运行时依赖”。
5. **发布流水线应按平台原生构建。** Windows、macOS、Ubuntu GitHub runner 分别生成产物；macOS 构建 arm64/x86_64 并合并 Universal 2 或分别发布，Linux 先 x86_64。统一从 Windows 交叉生成所有正式包会把 SDK、原生动态库、包工具和签名问题混在一起。

## 证据强弱

- 判断 1：**高**。项目锁文件与上游文档明确显示跨平台后端，源码审计确认绝大多数业务逻辑不触碰系统 API。
- 判断 2：**高**。每个编译阻塞均能定位到当前源码行和全局 Cargo 依赖；自定义协议的跨平台 origin 差异有 Wry 官方文档直接说明。
- 判断 3：**高**（可行性与正式分发要求）；**中**（具体 UI 行为）。Apple 官方明确签名、公证、Universal Binary 和 app bundle 要求，但当前没有 macOS 实机构建与交互测试。
- 判断 4：**高**（依赖与架构事实）；**中**（AppImage 最终覆盖范围）。Wry/Tao 和 Linux 规范支撑依赖结论；WebKitGTK/AppImage 在各发行版上的实际兼容性只能靠样包测试确定。
- 判断 5：**高**。GitHub 官方提供所需原生 runner，Apple 签名工具链和 Linux native dependencies 使原生构建明显更可靠。

## 跨维度共识

- 条件编译和小型平台抽象足以解决架构问题，无需框架迁移。
- “能编译”与“能给普通用户安装”是两条不同门槛；安装元数据、文件关联、签名、公证和 GUI 实测不可省略。
- 单实例是最大的跨平台功能一致性成本；可在 MVP 暂时降级，而不应阻塞基础编辑/预览能力发布。
- 文件关联不仅是打包配置：macOS 必须消费 `Event::Opened`，Linux desktop entry 必须传 `%F`，运行时要正确接收路径。
- Linux Wayland 是支持声明的分界线；若不采用/验证 GTK container，就只能承诺 X11。

## 关键冲突与解释

- **“Wry 是跨平台”与“项目当前不能跨平台编译”不矛盾。** 前者描述库能力，后者来自应用直接导入 Windows extension 和 Win32 API。
- **“AppImage 是单文件”与“Linux 有运行时依赖”不矛盾。** AppImage 是封装格式，可捆绑部分库；WebKitGTK、glibc 和图形栈仍受系统兼容边界影响。
- **Rust 支持交叉编译与推荐原生构建不矛盾。** Rust target 能生成目标代码，但 macOS SDK/签名公证和 Linux pkg-config/共享库/包格式需要目标系统工具链。
- **macOS 可以无证书构建与正式发布需要证书不矛盾。** 未签名包适合开发测试，普通用户直发的 Gatekeeper 体验要求 Developer ID 和公证。

## 不确定性与信息缺口

- 当前执行环境缺少 Cargo，且没有 macOS/Linux GUI 环境，无法用编译器确认所有 0.49 API 细节，也无法实测标题栏、拖放、IME 和 Wayland。
- 项目是否已有 Apple Developer Program 账户与证书未知；没有时正式 macOS 发布会被外部凭据阻塞。
- Linux 最低发行版尚未由维护者指定。它决定 glibc/WebKitGTK 基线、AppImage 兼容范围和 CI runner/container 选择。
- 若用户要求 Mac App Store、Flathub 或发行版官方仓库，当前研究范围不足，需要额外评估 sandbox 和渠道审核。

## 对原始问题的回答

答案是“能，而且现有技术路线适合继续使用”，但需要先把 Windows 特有部分平台化，再分别完成 macOS 和 Linux 的原生运行与交付闭环。最小代码适配属于小到中等重构，正式发布的主要额外成本在 macOS 信任链和 Linux 兼容矩阵。推荐先做共用编译骨架，再做 macOS，随后做 Linux x86_64；单实例完全一致、Linux arm64 和更多渠道放到后续。

## 对终稿的结构建议

- 执行摘要直接回答“能否”和推荐顺序。
- 用一张平台矩阵区分 WebView、包格式、架构、依赖和发布信任。
- 当前阻塞点按“编译必做、运行必做、体验适配”分层。
- macOS/Linux 分章列出具体适配与验收。
- 最后用阶段路线、CI/测试矩阵、工作量等级和风险作决策收束。
