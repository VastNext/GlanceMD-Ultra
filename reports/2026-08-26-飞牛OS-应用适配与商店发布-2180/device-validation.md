# fnOS 真机只读盘点

> 盘点日期：2026-08-26
>
> 方式：通过用户提供的 SSH 主机别名进行只读命令检查；未安装应用、未修改配置、未重启服务。

## 设备基线

| 项目 | 实测结果 | 对实施的影响 |
|---|---|---|
| fnOS 版本 | `1.2.0203` | 低于文件 ACL API 文档要求的 `1.2.0401`，开发新授权流程前需升级或采用兼容降级 |
| 系统基础 | Debian GNU/Linux 12 (bookworm) | 与官方 Native Node 示例一致 |
| CPU | x86_64，2 核 | 首版 x86 真机测试条件已满足 |
| 内存 | 7.6 GiB，可用约 3.6 GiB | Node Native MVP 资源充足，应保持轻量 |
| 存储 | 系统盘约 63 GiB；`/vol1` 约 3.7 TiB | 可创建独立测试应用和授权目录 |
| SSH 用户 | 普通管理员账号，属于 Administrators/docker | 可做日常测试 |
| sudo | `sudo -n` 可获得 root | 可自动化安装和诊断；应用仍不应长期以 root 运行 |

## 开发与运行能力

| 能力 | 实测结果 | 结论 |
|---|---|---|
| `fnpack` | 已安装，但为 1.0.0 | 不作为构建基线；CI/开发机固定使用官方 1.2.3 |
| `appcenter-cli` | 支持 install-fpk/install-local/start/stop/status/list | 可脚本化真机验收 |
| 手动安装 | 已启用 | 可直接侧载测试 FPK |
| Docker | 28.5.2，Compose v2.40.3 | Docker 路线可用，但非 MVP 首选 |
| Node.js v22 | 应用已安装，Node v22.18.0 | 推荐 Native Node 路线无需新增运行时 |
| 应用中心 | 服务 active | 测试环境正常 |
| 统一网关 | 服务 active，存在旧版 `/run/trim_open_gateway.socket` | 可参考现有应用 |
| 新 API Scope Socket | 未发现 `/var/run/trim_open_gateway_apiscope.socket` | 当前不能按最新文档完整验证文件授权后端 API |

## 真实应用参照

### 第三方 Markdown 编辑器

设备已安装 `App.Native.MdEditor2` 1.30.1：

- x86 平台，依赖 `nodejs_v22`；
- package 用户运行；
- Node 服务监听 18080；
- 通过 `proxy.cgi` 以 iframe 打开；
- 使用 data-share 挂载 `mdeditor` 目录；
- 包含 AI、Office/PDF、图床与发布等重功能；
- 产品使用独立默认账号密码。

这证明 Node Native + iframe + 文件共享目录方案在当前设备上可运行，也说明 GlanceMD 将面对直接竞品。

### 官方文本编辑器

`trim.text-editor` 0.3.3 已注册隐藏文件入口，支持 `md`、`markdown`、`mdown`、`mkdn` 等扩展名，并通过 `/app/text-editor/` 打开。这证明当前系统已支持文件管理器右键入口。

### PDF 阅读器

`leelaa.pdfload` 同时注册 iframe 和外部 URL 两种 PDF 文件入口，说明第三方应用可用 `fileTypes` 注册文件处理器。

## 对研究结论的校准

1. Node Native 路线得到真机已安装应用验证，方向不变。
2. 当前设备版本不能直接使用最新开放 API 完整方案；开发前应优先升级 fnOS。
3. 若暂不升级，可用应用设置授权目录、`TRIM_DATA_ACCESSIBLE_PATHS` 和 package 用户 ACL 做兼容 MVP，但多用户精细权限能力较弱。
4. 首版只需 x86；这台设备可以承担官方要求的 x86 真机测试。
5. 产品差异化应聚焦轻量、快速打开、阅读排版、无独立账号和文件管理器原生集成，不与现有重型编辑器比拼 AI/Office 功能。

## 建议的下一步真机动作

以下动作尚未执行：

1. 在飞牛 UI 检查并升级到支持开放 API 的最新稳定版本；
2. 升级后确认 API Scope Socket 与系统版本；
3. 创建独立测试应用名（如 `glancemd-beta`），避免污染正式 ID；
4. 用 fnpack 1.2.3 构建最小 FPK，验证 CI → SSH → install-fpk 流程；
5. 再进入 GlanceMD Web MVP 实施。
