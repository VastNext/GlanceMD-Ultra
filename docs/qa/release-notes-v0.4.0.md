# 🎉 GlanceMD Ultra v0.4.0 — 自定义网络代理、连通性测试与搜索定位强化

> 本版本新增 HTTP/HTTPS/SOCKS5 网络代理支持与即时连通性测试，打通外部网络基础设施；同时优化搜索定位与快捷键助手稳定性，并立项翻译功能集成提案。  
> 🔍 上个版本：[v0.3.0](https://github.com/VastNext/GlanceMD-Ultra/releases/tag/v0.3.0)

---

## ✨ 新功能

### 🌐 HTTP/HTTPS/SOCKS5 网络代理配置 (`FEAT-003`)

- ⚙️ **设置页新增「网络 / Network」分类**：支持直连（`off`）、跟随系统代理（`system`）、使用指定代理（`override`）三种工作模式。
- 🔌 **全协议支持**：支持 `http://`、`https://`、`socks5://`（及 `socks://` 别名）、支持用户名密码认证（`user:pass@host:port`）与 IPv6 字面量地址；缺省端口自动适配（HTTP 8080 / SOCKS 1080）。
- 🔒 **严格 SSL 证书校验开关**：默认开启严格验证；关闭后允许跳过证书校验（明确安全降级提示，专用于企业自签证书或抓包调试等特殊网络环境）。
- 🖥️ **原生 WebView 全局代理注入**：启动时将代理参数直接注入底层引擎（Windows WebView2 / macOS WKWebView / Linux WebKitGTK），Markdown 预览中的在线图片与外部静态资源请求自动走代理。

### ⚡ 代理即时连通性探测

- 🧪 设置页代理输入框旁配备【测试连接】按钮，直接针对当前输入的地址发起探测（**无需先保存**即可快速排错）。
- 📊 实时展示连接状态、往返耗时（毫秒）与响应状态码（测试目标为 GitHub API），失败时精确反馈中文错误原因。
- 🚀 为后续版本的一键检查更新 (`FEAT-002`) 与划词翻译 (`FEAT-005`) 打下坚实底座。

---

## 🔧 改进与优化

- 🎯 **查找定位优化**：修复在正文中已定位到某个匹配项后，再次按下 `Ctrl+F` 会重置并跳回第 1 项的问题，确保当前选区或光标锚点平滑保留。
- ⌨️ **快捷键助手稳健性增强**：为 `Key Assist` (`Ctrl+Shift+L`) 浮层补充顶级 `Escape` 兜底监听与同步抢焦，修复在快速按键场景下弹窗关闭偶发失效的问题。
- 🌏 **中英双语覆盖**：设置项、状态描述、测试反馈全量覆盖 `zh-CN` 与 `en` 国际化字典。
- 📝 **规划立项**：完成 `FEAT-005`（选中文本划词翻译，复用 VastTranslator 引擎层）立项提案并并入 `docs/backlog.md`。

---

## 📦 下载

| 平台 | 产物 | 说明 |
|---|---|---|
| 🪟 Windows x64 | `GlanceMD-Ultra-windows-x64.exe` | 绿色单执行文件，支持 `gmdu .` 命令行 |
| 🍎 macOS Apple Silicon | `GlanceMD-Ultra-macos-arm64-unsigned.dmg` | M1/M2/M3/M4 系列芯片原生 |
| 🍎 macOS Intel | `GlanceMD-Ultra-macos-x64-unsigned.dmg` | x86_64 架构芯片 |
| 🐧 Debian / Ubuntu x64 | `GlanceMD-Ultra_0.4.0_amd64.deb` | 原生安装包，集成桌面图标与命令行软链接 |
| 🐧 Linux 通用 x64 | `GlanceMD-Ultra_0.4.0_x86_64.AppImage` | 免安装便携运行 |

---

## 💡 说明

- ⚠️ **代理生效时机**：由于平台 WebView 原生限制，代理配置的修改需在**重启软件**后对 WebView 渲染引擎生效（设置界面已有醒目提示）。
- 🍎 **macOS 首次运行提示**：由于安装包尚未加入 Apple 开发者签名，首次打开如遇拦截，请前往「系统设置 → 隐私与安全性」点击「仍要打开」。
- 🪟 **命令行工具**：Windows 用户如在设置中安装了 `gmdu` 命令，请重新打开终端使环境变量生效。
