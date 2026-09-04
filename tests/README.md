# 测试与门禁基建说明（阶段 0）

本目录与 `tools/` 组成 GlanceMD Ultra 的测试基建：**零依赖**的 JS 模块单测与冒烟套件（node:test + node:vm），加上可选的 Playwright 端到端冒烟。前端内嵌进二进制（`main.rs::build_html()` 拼接单 HTML），因此浏览器类测试都基于 `tools/build_test_page.py` 组装出的等价页面。

## 一、三种测试的运行方式

### 1. 前端模块单测（零依赖，必跑）

```bash
node --test src/frontend/*.test.js
```

- 针对 `src/frontend/` 下各模块的独立测试（如 `preview.test.js`）。
- **勿用目录形式**（`node --test src/frontend/`）：Node 22 在 Windows 下会把目录误当模块路径。
- 新增模块测试照 `preview.test.js` 的 stub 风格：node:test + node:vm + 最小 DOM stub，不引入任何 npm 依赖。

### 2. 冒烟套件（零依赖，必跑）

```bash
node --test tests/smoke.test.js
```

覆盖三组内容：

- **tabs.js 冒烟**：tab 创建/激活切换/dirty 标记/关闭确认/同路径复用（vm 中按页面顺序加载 tabs.js + app.js，以 stub 驱动）；
- **app.js 冒烟**：主题切换 light/dark 往返 + localStorage 键名（当前 `glancemd-theme`，兼容阶段 0 身份重命名后的 `glancemd-ultra-theme`）、`window.__fromRust` IPC 事件桥（file_opened / error / 最近文件）；
- **组装页完整性**：`tests/.tmp/index.html` 包含全部 6 个产品脚本且顺序与 `build_html` 一致、CSS 完整注入、mock 引导脚本先于产品脚本、无残留占位符（纯字符串断言；缺页时会自动调用 `tools/build_test_page.py` 重新生成）。

### 3. Playwright 端到端冒烟（可选，需浏览器）

```bash
cd tests/e2e
npm i -D playwright        # 仅需一次；网络需走代理
npx playwright install chromium
npx playwright test
```

- 被测对象是组装页（`file://` 直接加载，无 webServer），见 `playwright.config.js` 与 `specs/app.spec.js`。
- 覆盖：页面加载（标题栏/平台标记/编辑器/ready 命令）、新建 tab 核心交互、主题切换往返与持久化。
- 若浏览器下载失败，可降级为只跑前两类零依赖测试；spec 与 config 保留，待 CI 补跑。

### 合并前检查清单

```bash
node --test src/frontend/*.test.js
node --test tests/smoke.test.js
cd tests/e2e && npx playwright test   # 环境就绪时
```

三者全绿 + `cargo test` / `cargo fmt --check` 通过，方可合并（完整门禁见 AGENTS.md 与主实施计划"回归自动化策略"）。

## 二、工具脚本

### tools/build_test_page.py — 组装前端测试页

复刻 `main.rs::build_html()` 的占位符拼接（`/* __CSS__ */` → style.css、`<body>` → 平台标记、`<!-- __SCRIPTS__ -->` → 按序 6 个内联 script，含 `</script` 转义），并在首个 script 注入 `tests/mock-bootstrap.js` 的 IPC mock：

```bash
python tools/build_test_page.py                 # 输出 tests/.tmp/index.html + tests/.tmp/mock-ipc.js
python tools/build_test_page.py --platform macos
```

- 拼接规则与 `main.rs::build_html` 保持一致，`main.rs` 的脚本顺序变更时需同步修改本脚本（否则冒烟套件的组装页断言会失败并暴露漂移）。
- 产物写换行保持 LF，与真实二进制内的 HTML 一致。
- `tests/.tmp/mock-ipc.js` 是独立 mock 副本，供 Playwright `page.addInitScript()` 场景使用（当前 spec 直接用组装页内联的 mock，无需 addInitScript）。

### tools/gen-test-tree.py — 生成确定性测试目录树

```bash
python tools/gen-test-tree.py                                        # 10000 文件 → G:/worktrees/zcode/test-tree-10k
python tools/gen-test-tree.py --count 300 --root tests/.tmp/tree     # 小规模自测
```

- 固定随机种子，同参数产出完全一致的树；`--count` 精确控制默认可见文件数。
- 目录深度确定性覆盖 2–6 层；扩展名覆盖默认可见集合（.md .markdown .txt .json .yaml .yml .toml .ini .csv）。
- 夹带默认排除目录（node_modules/target/.venv/dist/build/.cache，根级各 50–100 文件 + 深层嵌套实例）与隐藏文件，供阶段 1 过滤逻辑测试。
- 每个 .md 含标题 + 段落 + 代码块与全文唯一搜索锚点 `needle-NNNNN`，供全文搜索测试断言命中与不误报。

## 三、10k 文件门禁（阶段 1）

主实施计划阶段 1 的性能门禁（一万文件项目树枚举/搜索）使用本目录的工具生成夹具：

```bash
python tools/gen-test-tree.py --count 10000 --root G:/worktrees/zcode/test-tree-10k
```

随后以 workspace 子系统枚举该目录，断言：可见文件数 = 10000、排除目录与隐藏文件被过滤、目录深度 2–6 层全展示；再对 `needle-00001` 等锚点做全文搜索命中验证。阶段 1 的 Playwright 冒烟用例应扩展现有 `tests/e2e/specs/app.spec.js`（或并列新增 spec），继续复用 `build_test_page.py` 组装页 + mock 引导的模式。
