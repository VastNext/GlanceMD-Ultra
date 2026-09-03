# GlanceMD 适配飞牛 OS 与应用商店发布可行性研究

> 研究日期：2026-08-26
>
> 适用范围：飞牛 fnOS 当前公开开发平台、fnpack 1.2.3、开放 API 第一阶段，以及 GlanceMD 当前 Rust/Wry + 内嵌 Web 前端架构。

## 执行摘要

**GlanceMD 可以改造成飞牛 OS 应用，也存在进入官方应用中心的现实路径。** 但适配方式不是把现有 Linux AppImage 塞进 `.fpk`，而是新增一个运行在飞牛桌面中的 Web 版 Markdown 编辑器。

推荐路线是：

- 复用 GlanceMD 的 Markdown 渲染、编辑器、多标签、主题、查找、目录和分屏前端逻辑；
- 把当前 `window.ipc` 文件桥接改成可切换的平台接口；
- 飞牛版增加一个 Node.js v22 Native 后端服务；
- 通过飞牛统一网关接入 NAS 登录态和当前用户身份；
- 通过官方文件授权与 ACL API 安全读写用户允许的 Markdown 文件；
- 使用官方 `fnpack` 生成 `.fpk`；
- 先在 GitHub Release 发布侧载测试包，完成 x86 fnOS 真机验证后，再进入开发者先锋群申请官方商店上架。

三条路线比较如下：

| 路线 | 现有代码复用 | fnOS 体验 | x86/ARM | 权限与登录态 | 维护成本 | 建议 |
|---|---:|---:|---:|---:|---:|---|
| 直接封装 Linux Wry/GTK GUI | Rust 外壳可复用 | 很差：NAS 无可交互桌面窗口 | 需分架构、带 GTK/WebKitGTK | 难接飞牛授权 | 高 | 不采用 |
| Native Web + Node 后端 | 前端复用高 | 最佳：iframe/文件入口/统一网关 | JS 包可全架构 | 原生接开放 API | 中 | **首选** |
| Docker Web 服务 | 前端复用高 | 良好 | 需要多架构镜像 | 可接，但 Socket/卷映射复杂 | 中到高 | 备选 |

核心判断是：这项工作技术可行，工程量属于中等规模的“平台壳重构 + 新文件服务”，不是简单打包；商店上架的最大外部条件是必须准备一台 fnOS 真机并参与人工开发者/审核流程。

## 真机验证补充

用户现有 fnOS 设备已通过 SSH 完成只读盘点，因此“缺少测试设备”不再是阻塞项。

| 项目 | 真机结果 | 影响 |
|---|---|---|
| fnOS | `1.2.0203` | 低于新版文件 ACL API 要求的 `1.2.0401`，建议先升级 |
| 系统/CPU | Debian 12、x86_64、2 核 | 可承担首版 x86 验证 |
| 内存 | 7.6 GiB | Node Native MVP 资源充足 |
| Node | `nodejs_v22`，v22.18.0 | 推荐路线运行时已具备 |
| Docker | 28.5.2 / Compose 2.40.3 | Docker 备选路线可用 |
| fnpack | 设备内置 1.0.0 | 构建应使用官方 1.2.3 |
| appcenter-cli | install-fpk/install-local/start/stop/status 可用 | 可自动化侧载与测试 |
| 手动安装 | 已启用 | 可立即安装测试 FPK |
| API Scope Socket | 未发现 | 升级前不能完整验证最新授权 API |

设备还已安装第三方 `App.Native.MdEditor2` 1.30.1 和官方 `trim.text-editor`。前者验证了 Node Native + iframe + package 用户的可行性，后者验证了 `md/markdown` 文件右键入口。这也意味着 GlanceMD 需要明确差异化：轻量、极速打开、Marco 阅读排版、无独立账号、与文件管理器原生集成，而不是与现有应用比拼 AI、Office 和图床等重功能。

详细盘点见 [device-validation.md](device-validation.md)。

## 一、飞牛 OS 的应用模型意味着什么

fnOS 基于 Debian 系 Linux，成熟主线是 x86；ARM 版本已经进入公测，但应用中心仍存在部分 x86 应用不可用的情况。官方开发文档已同时支持 x86 和 ARM 设备，Manifest 通过 `platform=x86|arm|all` 声明兼容范围。

fnOS 是 NAS 系统，用户通常在电脑或手机浏览器中打开飞牛桌面。飞牛所说的 Native 应用，是运行在宿主 Linux 上的后台进程，可以提供 Web UI、API 或 CLI；并不是在 NAS 本地弹出 GTK 窗口。

官方支持三类 UI 服务：

- `index.cgi`：适合静态或很轻的页面；每个请求启动 CGI，不适合复杂编辑器后端。
- Native 服务 + 统一网关：长期后台服务监听 Unix Socket，由飞牛网关提供登录校验和用户 Header。
- Docker Compose：适合已有容器或复杂多服务应用，可通过端口或 Unix Socket 对外提供 Web UI。

飞牛官方甚至提供了一个完整的 Native Notepad 示例：React 前端、Node 后端、Unix Socket、按用户保存笔记和 FPK 生命周期。它与 GlanceMD 的目标高度同构，是推荐实现的直接模板。

## 二、为什么不能直接使用现有 Linux 包

当前 Linux 版 GlanceMD 依赖 Tao 创建窗口、Wry WebKitGTK 渲染和 GTK 桌面会话。它在普通 Ubuntu 桌面上成立，但在 NAS 上存在三个根本问题：

1. NAS 宿主通常没有用户正在操作的本地图形桌面，窗口即使创建也无法显示在远程飞牛桌面里；
2. 它无法自然获得飞牛当前登录用户身份；
3. 它绕开了飞牛应用文件授权、ACL、入口、安装升级和商店生命周期。

因此 `.deb`/AppImage 只能证明 Rust 代码可在 Linux 编译，不是飞牛应用交付物。`.fpk` 也不是简单压缩格式，它包含 Manifest、权限、资源、生命周期、桌面入口和应用运行文件。

## 三、推荐目标架构

下图是推荐的飞牛版数据流。浏览器不直接接触 NAS 文件系统；所有路径和读写操作必须经过后端授权与 ACL 校验。

```mermaid
flowchart LR
  U[飞牛桌面 / 文件管理器] -->|iframe 或 md 文件入口| G[统一网关 /app/glancemd]
  G -->|NAS 登录校验 + 用户 Header| S[GlanceMD Node 服务]
  F[共享前端核心<br/>Editor / Preview / Tabs] -->|HTTP FileBridge| S
  F -->|@trimjs/web-app| A[文件/目录授权页面]
  S -->|TRIM_API_TOKEN + Unix Socket| API[飞牛开放 API]
  API -->|授权路径 + 用户 ACL| S
  S -->|规范化路径 / 原子读写| D[用户授权的 Markdown 文件]

  classDef core fill:#eef7f5,stroke:#0f766e,color:#134e4a,stroke-width:1.5px;
  classDef support fill:#eef4f8,stroke:#2563eb,color:#17324d,stroke-width:1.2px;
  classDef warning fill:#fff7ed,stroke:#c2410c,color:#7c2d12,stroke-width:1.2px;
  class U,F core;
  class G,S,API support;
  class A,D warning;
```

### 前端复用与拆分

可以直接复用或轻量调整：

- marked.js、highlight.js 和 Markdown renderer；
- TabManager、多标签状态；
- 编辑器、预览、分屏、目录、查找、主题和缩放；
- 主要 HTML/CSS 视觉系统。

需要抽象的关键点是文件桥接。建议建立统一接口：

```text
FileBridge.open(path)
FileBridge.save(path, content, expectedVersion)
FileBridge.pickFile()
FileBridge.pickDirectory()
FileBridge.getRecentFiles()
```

- 桌面版本继续由 Rust/Wry IPC 实现；
- 飞牛版本由统一网关下的 HTTP API 实现。

这样前端业务只有一份，避免飞牛版长期漂移。

### Node Native 后端

首版推荐使用飞牛官方 `nodejs_v22` 运行时，而不是编译新的 Rust 服务，原因是：

- 官方案例可直接复用；
- JavaScript 服务不含架构相关二进制，FPK 可设计为 `platform=all`；
- Unix Socket、JSON API 和飞牛 API调用简单；
- 无需 Docker 镜像仓库和多架构镜像维护。

后端至少提供：

- 授权目录/文件状态查询；
- 文件打开、保存和元数据接口；
- UTF-8 与文件大小限制；
- mtime 或内容 hash 冲突检测；
- 同目录临时文件 + rename 的原子保存；
- 路径 canonicalize 与授权根校验；
- 当前 UID readable/writable ACL 检查。

服务通过 `${TRIM_APPDEST}/app.sock` 监听，所有 HTTP 路由位于 `/app/glancemd`。用户身份只接受统一网关注入的 `X-Trim-Userid` 等 Header，不接受客户端自报 UID。

## 四、文件授权和安全边界

飞牛的权限模型有两层，必须同时满足：

1. 用户授权后，系统给 GlanceMD 专用应用用户授予目标路径 ACL；
2. 后端根据当前登录用户 UID 再检查该用户对具体文件的 readable/writable/deletable 权限。

Manifest 需要 `micro_app=true` 才能初始化前端 JS SDK。`config/resource` 只声明实际使用的 Scope，例如：

```json
{
  "api-scope": [
    "trim.file.userAccess",
    "trim.file.userAcl",
    "trim.file.path"
  ]
}
```

`TRIM_API_TOKEN` 由系统注入后端进程。它不能保存到文件、数据库、浏览器 localStorage 或静态 JavaScript中。

文件管理器入口可以声明：

```json
{
  ".url": {
    "glancemd.editor": {
      "title": "使用 GlanceMD 打开",
      "type": "iframe",
      "gatewayPrefix": "/app/glancemd",
      "gatewaySocket": "app.sock",
      "url": "/app/glancemd/edit",
      "fileTypes": ["md", "markdown", "txt"],
      "noDisplay": true,
      "allUsers": true
    }
  }
}
```

系统会把路径追加为查询参数。这个参数必须视为不可信输入；前端不得直接据此读取，后端需要拒绝 `..`、NUL、软链接逃逸和授权目录之外的路径。

## 五、FPK 包结构和打包

建议在仓库中增加 `packaging/fnos/glancemd/`：

```text
packaging/fnos/glancemd/
├── manifest
├── ICON.PNG
├── ICON_256.PNG
├── app/
│   ├── server/
│   │   ├── server.js
│   │   ├── package.json
│   │   └── public/            # 构建后的 GlanceMD Web 前端
│   └── ui/
│       ├── config
│       └── images/
│           ├── icon_64.png
│           └── icon_256.png
├── cmd/
│   ├── main
│   ├── install_init
│   ├── install_callback
│   ├── upgrade_init
│   ├── upgrade_callback
│   ├── uninstall_init
│   └── uninstall_callback
├── config/
│   ├── privilege
│   └── resource
└── wizard/
```

核心 Manifest 方向：

```ini
appname=glancemd
version=0.1.0
display_name=GlanceMD
desc=在飞牛 fnOS 中查看和编辑 Markdown 文件
source=thirdparty
platform=all
maintainer=VastNext
desktop_uidir=ui
desktop_applaunchname=glancemd.main
install_dep_apps=nodejs_v22
os_min_version=<按最终 API 要求填写>
ctl_stop=true
disable_authorization_path=false
micro_app=true
```

`config/privilege` 使用专用 package 用户，不使用 root。`cmd/main` 必须实现幂等的 start/stop/status，status 未运行返回 3；日志、PID 和 Socket 使用系统环境变量目录。

官方 `fnpack 1.2.3` 支持 Windows、Linux、macOS和 ARM 开发机。CI 可以固定下载对应 binary，执行：

```bash
fnpack build --directory packaging/fnos/glancemd
```

生成 `.fpk` 后作为 GitHub prerelease 资产，供真机侧载测试。

## 六、官方应用商店上架流程

当前开发者后台首页仍将“我的应用”标注为即将推出。官方公开文档给出的现行流程仍是人工协作：

```mermaid
flowchart LR
  A[GitHub Actions 构建 FPK] --> B[应用中心手动安装]
  B --> C[x86 fnOS 真机测试]
  C --> D[发布侧载测试版收集反馈]
  D --> E[加入飞牛粉丝群]
  E --> F[联系社区主理人]
  F --> G[加入开发者先锋群]
  G --> H[提交身份、FPK、图标、截图、测试材料]
  H --> I[按审核反馈修改]
  I --> J[官方应用中心上架]

  classDef core fill:#eef7f5,stroke:#0f766e,color:#134e4a,stroke-width:1.5px;
  classDef support fill:#eef4f8,stroke:#2563eb,color:#17324d,stroke-width:1.2px;
  classDef warning fill:#fff7ed,stroke:#c2410c,color:#7c2d12,stroke-width:1.2px;
  class A,B,C,D support;
  class E,F,G,H,I warning;
  class J core;
```

需要准备：

- 最终 `.fpk`；
- 64/256 图标与商店图；
- 真实截图，而不是设计稿；
- 准确的版本、描述、开源地址、维护者和最低系统版本；
- 隐私与文件访问说明；
- 安装、升级、卸载、权限、多用户和错误场景测试记录；
- 若声明 ARM，则提供 ARM 公测设备实测结果。

开发者身份信息、审核 SLA、费用和固定模板目前没有完整公开说明，应以开发者群工作人员的当前要求为准。

## 七、分阶段实施路线

### 阶段 0：前端解耦

- 把 Wry 专属 IPC 从前端业务逻辑中抽出为 FileBridge；
- 建立浏览器开发模式；
- 确保桌面版行为和 Windows 构建不回退。

### 阶段 1：飞牛 Web MVP

- Node 后端 + 统一网关；
- 目录/文件授权、ACL、打开和原子保存；
- 主入口与文件右键入口；
- 只支持 `.md/.markdown/.txt`；
- GitHub Actions 生成测试 FPK。

### 阶段 2：x86 真机验证

- 干净设备安装、启动、停止、升级、卸载；
- 管理员与普通用户；
- 未授权、只读、可写文件；
- 中文/空格路径、大文件、空文件、CRLF；
- 双浏览器并发冲突；
- 登录过期和服务重启。

### 阶段 3：商店申请

- 发布侧载 beta；
- 收集问题并修复；
- 准备截图、隐私说明和测试报告；
- 进入开发者群提交审核。

### 阶段 4：ARM

- 在 ARM 公测 fnOS 真机验证 Node runtime、开放 API和 FPK；
- 通过后再把 ARM 纳入正式支持范围。

## 八、风险与门禁

| 风险 | 影响 | 必须门禁 | 回退方案 |
|---|---|---|---|
| 把 Linux GUI 当 NAS 应用 | 窗口不可见、无法接登录态 | 禁止复用 AppImage 作为 FPK 主程序 | 改为 Web 平台壳 |
| 路径参数被伪造 | 越权读写 NAS 文件 | canonicalize + 授权根 + ACL 三重检查 | 拒绝请求并记录安全日志 |
| 应用授权与用户权限混淆 | 普通用户读取他人文件 | 每次按网关 UID 调用 userAcl | 默认拒绝 |
| 保存覆盖并发修改 | 数据丢失 | mtime/hash 乐观锁 + 原子 rename | 弹出冲突提示、另存副本 |
| Token 泄露 | 开放 API被滥用 | Token 只在后端内存，禁止日志/持久化 | 重启/重装刷新 Token |
| ARM 仅理论兼容 | 商店用户无法启动 | ARM 真机通过后才声明支持 | 首发只标 x86 |
| 仅 CI 生成 FPK | 安装/升级/权限问题漏检 | 官方要求的干净 fnOS 真机测试 | 只发 GitHub beta，不申请上架 |
| 开发者后台流程变化 | 申请阻塞 | 进入官方开发者群确认最新要求 | 保持侧载测试分发 |

## 最终建议

值得做，而且产品定位清晰：让飞牛用户在文件管理器中右键 Markdown 文件，直接在 NAS 登录态下用 GlanceMD 查看和编辑。这比单纯提供 Linux 桌面包更能发挥 NAS 本地数据和多用户权限的价值。

建议把成功标准分成两层：

1. **工程成功：** CI 生成 FPK、x86 真机完整验证、GitHub beta 可侧载；
2. **生态成功：** 完成开发者认证、提交真实测试材料、通过飞牛应用中心审核。

第一层可以由项目开发自主完成；x86 fnOS 测试设备已经具备，但设备应先升级到满足目标开放 API 的系统版本。第二层仍必须由项目所有者参与飞牛官方开发者群与人工审核。当前不应承诺直接上架时间，也不应在没有 ARM 真机的情况下提前声明正式 ARM 支持。
