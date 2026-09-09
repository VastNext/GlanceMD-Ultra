/* 端到端冒烟：在真实 Chromium 中加载 build_test_page.py 组装页（file://）。
 *
 * 覆盖：
 * 1. 页面加载：应用标题栏、平台标记、编辑器可见；
 * 2. 新建 tab 核心交互：#btn-new 点击后 tab 栏出现 tab 并可切换；
 * 3. 主题切换：data-theme 在 light/dark 间往返并写入 localStorage；
 * 4. IPC mock 生效：产品发出的 ready 命令被 window.__ipcLog 记录。
 *
 * 组装页由根目录的 tools/build_test_page.py 生成（缺失时此处自动补跑一次）；
 * mock（window.ipc / __fromRust）已内联在组装页首个 <script>，无需 addInitScript。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
// 本目录仅安装 playwright（非 @playwright/test），runner 由 playwright/test 子路径提供
const { test, expect } = require('playwright/test');
const { pathToFileURL } = require('node:url');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE_PATH = path.join(REPO_ROOT, 'tests', '.tmp', 'index.html');

function ensurePage() {
  if (!fs.existsSync(PAGE_PATH)) {
    execFileSync('python', [path.join(REPO_ROOT, 'tools', 'build_test_page.py')], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
  }
  return pathToFileURL(PAGE_PATH).href;
}

let pageUrl;

const SETTINGS_FIXTURE = {
  version: 1,
  appearance: { theme: 'light', language: 'zh-CN', sidebarFontSize: 14 },
  files: { visibleExts: ['md'], showHidden: false, exclude: ['.git'], watcherExclude: ['.git'] },
  watching: { enableWatcher: true, autoSave: 'off', autoSaveDelayMs: 1000 },
  search: { exclude: ['.git'], maxFileSizeMB: 5, maxResults: 2000 },
  editor: { fontSize: 14, tabSize: 4, wordWrap: true, lineNumbers: true, largeFileMB: 5 },
  keybindings: { overrides: {} },
  recovery: { confirmCloseDirty: true, crashRecovery: true, createProjectSettings: false },
  http: { proxySupport: 'off', proxy: '', proxyStrictSSL: true },
};

async function installSettingsMock(page) {
  await page.evaluate((settings) => {
    window.__ipcResponder = (raw) => {
      const message = JSON.parse(raw);
      if (message.command === 'workspace.settings.get-effective') {
        window.__fromRust('workspace:settings-effective', { settings });
      } else if (message.command === 'workspace.settings.get-global') {
        window.__fromRust('workspace:settings-global', { settings });
      } else if (message.command === 'workspace.settings.load-project') {
        window.__fromRust('workspace:settings-project', { patch: {} });
      }
    };
  }, SETTINGS_FIXTURE);
}

test.beforeAll(() => {
  pageUrl = ensurePage();
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 768 });
  // file:// origin 的 localStorage 在同一 context 内持久；先清空保证初始状态一致
  await page.goto(pageUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('页面加载：标题栏、平台标记与欢迎视图就绪', async ({ page }) => {
  await expect(page.locator('#titlebar-title')).toHaveText('GlanceMD Ultra');
  await expect(page.locator('body[data-platform="windows"]')).toHaveCount(1);
  await expect(page.locator('#welcome-view')).toBeVisible();
  await expect(page.locator('#tab-bar-wrap')).toBeHidden();
  // 产品脚本就绪：初始化会向 Rust 发送 ready
  const commands = await page.evaluate(() =>
    (window.__ipcLog || []).map((msg) => JSON.parse(msg).command),
  );
  expect(commands).toContain('ready');
});

test('Ctrl+Alt+O：完整脚本加载后触发一次 open_file IPC', async ({ page }) => {
  await page.evaluate(() => { window.__ipcLog = []; });
  await page.keyboard.press('Control+Alt+KeyO');
  const openMessages = await page.evaluate(() =>
    (window.__ipcLog || []).map((message) => JSON.parse(message)).filter((message) => message.command === 'open_file'),
  );
  expect(openMessages).toHaveLength(1);
});

test('新建 tab 核心交互：新建后欢迎隐藏且 tab 栏出现，多 tab 可切换', async ({ page }) => {
  await expect(page.locator('#tab-bar-wrap')).toBeHidden();
  await expect(page.locator('#welcome-view')).toBeVisible();

  await page.click('#btn-new');
  await expect(page.locator('#tab-bar-wrap')).toBeVisible();
  await expect(page.locator('#welcome-view')).toBeHidden();
  const tabs = page.locator('#tab-bar .tab');
  await expect(tabs).toHaveCount(1);
  const activeText = await page.locator('#tab-bar .tab.active .tab-label').textContent();
  expect(activeText).toBe('未命名');
  await expect(page.locator('#titlebar-title')).toHaveText('未命名');

  // 新建第 2 个 tab
  await page.click('#btn-new');
  await expect(tabs).toHaveCount(2);

  // 点击第 1 个 tab 切换回去
  await tabs.first().click();
  await expect(tabs.first()).toHaveClass(/active/);
});

test('欢迎视图：启动展示最近文件，点击可触发打开，快捷新建可直接进入编辑', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('glancemd-ultra-recent', JSON.stringify([
      { path: 'D:/test/demo.md', filename: 'demo.md' }
    ]));
  });
  await page.reload();

  const welcome = page.locator('#welcome-view');
  await expect(welcome).toBeVisible();

  // 切换到最近文件 Tab
  await page.click('#welcome-tab-files');
  await expect(page.locator('#welcome-tab-files')).toHaveClass(/active/);

  const recentItems = welcome.locator('#welcome-recent-list .welcome-recent-item');
  await expect(recentItems).toHaveCount(1);
  await expect(recentItems.first().locator('.recent-name')).toHaveText('demo.md');
  await expect(recentItems.first().locator('.recent-path')).toHaveText('D:/test/demo.md');

  // 点击最近文件触发 open_file
  await recentItems.first().click();
  const openMessages = await page.evaluate(() =>
    (window.__ipcLog || []).map((m) => JSON.parse(m)).filter((m) => m.command === 'open_file')
  );
  expect(openMessages).toHaveLength(1);
  expect(openMessages[0].path).toBe('D:/test/demo.md');

  // 点击欢迎视图中的"新建文件"快捷按钮
  await page.click('#welcome-btn-new');
  await expect(welcome).toBeHidden();
  await expect(page.locator('#tab-bar .tab')).toHaveCount(1);
});

test('欢迎视图双 Tab：默认展示最近项目，可切到最近文件，点击项目触发 workspace.open', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('glancemd-ultra-recent-projects', JSON.stringify([
      { path: 'D:/projects/glance-docs', name: 'glance-docs', ts: Date.now() }
    ]));
    localStorage.setItem('glancemd-ultra-recent', JSON.stringify([
      { path: 'D:/test/notes.md', filename: 'notes.md' }
    ]));
  });
  await page.reload();

  const welcome = page.locator('#welcome-view');
  await expect(welcome).toBeVisible();

  // 默认选中最近项目
  await expect(page.locator('#welcome-tab-projects')).toHaveClass(/active/);
  const projectItems = welcome.locator('#welcome-recent-projects-list .welcome-recent-item');
  await expect(projectItems).toHaveCount(1);
  await expect(projectItems.first().locator('.recent-name')).toHaveText('glance-docs');
  await expect(projectItems.first().locator('.recent-path')).toHaveText('D:/projects/glance-docs');

  // 点击项目触发 workspace.open
  await projectItems.first().click();
  const openProjectMessages = await page.evaluate(() =>
    (window.__ipcLog || []).map((m) => JSON.parse(m)).filter((m) => m.command === 'workspace.open')
  );
  expect(openProjectMessages).toHaveLength(1);
  expect(openProjectMessages[0].path).toBe('D:/projects/glance-docs');

  // 切换到最近文件
  await page.click('#welcome-tab-files');
  await expect(page.locator('#welcome-tab-files')).toHaveClass(/active/);
  const fileItems = welcome.locator('#welcome-recent-list .welcome-recent-item');
  await expect(fileItems).toHaveCount(1);
  await expect(fileItems.first().locator('.recent-name')).toHaveText('notes.md');
});

test('大纲单入口：顶栏 #btn-toc 切换 Outline 面板，不增加独立活动栏占宽', async ({ page }) => {
  const outlinePanel = page.locator('#panel-outline');
  await expect(outlinePanel).toBeHidden();
  await expect(outlinePanel).not.toHaveClass(/open/);

  const editorBoxBefore = await page.locator('#editor').boundingBox();
  expect(editorBoxBefore).not.toBeNull();

  // 点击 #btn-toc 打开 Outline 面板
  await page.click('#btn-toc');
  await expect(outlinePanel).toBeVisible();
  await expect(outlinePanel).toHaveClass(/open/);

  // 开启面板后，编辑器宽度让出 Outline 空间
  const editorBoxAfterOpen = await page.locator('#editor').boundingBox();
  expect(editorBoxAfterOpen).not.toBeNull();
  expect(editorBoxAfterOpen.width).toBeLessThan(editorBoxBefore.width);

  // 再次点击 #btn-toc 关闭 Outline 面板
  await page.click('#btn-toc');
  await expect(outlinePanel).toBeHidden();
  await expect(outlinePanel).not.toHaveClass(/open/);

  // 关闭面板后，编辑器宽度恢复
  const editorBoxAfterClose = await page.locator('#editor').boundingBox();
  expect(editorBoxAfterClose).not.toBeNull();
  expect(editorBoxAfterClose.width).toBe(editorBoxBefore.width);
});

test('双入口与设置：文件、项目、设置按钮分别触发对应命令', async ({ page }) => {
  await page.click('#btn-open-file');
  await page.click('#btn-open');
  await page.click('#btn-settings');

  const messages = await page.evaluate(() => (window.__ipcLog || []).map((msg) => JSON.parse(msg)));
  expect(messages.filter((message) => message.command === 'open_file')).toHaveLength(1);
  expect(messages.filter((message) => message.command === 'workspace.open')).toHaveLength(1);
  // settings-apply.js 开机会自动请求一次 get-effective；打开面板再发一次，共 2 次
  expect(messages.filter((message) => message.command === 'workspace.settings.get-effective')).toHaveLength(2);
  await expect(page.locator('#settings-panel')).toBeVisible();
});

test('设置专项：modal 可见、九类真实分类与关闭/Escape', async ({ page }) => {
  await page.click('#btn-settings');
  const panel = page.locator('#settings-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('#settings-categories button')).toHaveCount(9);
  await expect(panel.locator('#settings-categories')).toContainText('外观');
  await expect(panel.locator('#settings-categories')).toContainText('文件');
  await expect(panel.locator('#settings-categories')).toContainText('监听');
  await expect(panel.locator('#settings-categories')).toContainText('窗口与命令行');
  await expect(panel.locator('#settings-categories')).toContainText('网络');
  await expect(panel.locator('#settings-categories')).toContainText('搜索');
  await expect(panel.locator('#settings-categories')).toContainText('编辑器');
  await expect(panel.locator('#settings-categories')).toContainText('快捷键');
  await expect(panel.locator('#settings-categories')).toContainText('恢复');

  await page.locator('#settings-close').click();
  await expect(panel).toBeHidden();
  await page.click('#btn-settings');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('设置专项：搜索按真实中文分类聚合，点击分类后保留过滤词', async ({ page }) => {
  await installSettingsMock(page);
  await page.click('#btn-settings');
  const panel = page.locator('#settings-panel');
  const filter = panel.locator('#settings-filter');
  await filter.fill('排除');
  await expect(panel.locator('[data-goto="files"]')).toBeVisible();
  await expect(panel.locator('[data-goto="search"]')).toBeVisible();
  await expect(panel.locator('#settings-body')).toContainText('浏览排除');
  await expect(panel.locator('#settings-body')).toContainText('搜索排除');
  await panel.locator('[data-goto="search"]').click();
  await expect(panel.locator('#settings-categories button[data-category="search"]')).toHaveClass(/active/);
  await expect(filter).toHaveValue('排除');
  await expect(panel.locator('[data-setting="exclude"]')).toHaveCount(1);
});

test('设置专项：原生枚举 select 保持可操作且明暗主题 token 生效', async ({ page }) => {
  await installSettingsMock(page);
  await page.click('#btn-settings');
  const panel = page.locator('#settings-panel');
  const theme = panel.locator('[data-setting="theme"]');
  await expect(theme).toHaveValue('light');
  await expect(theme.locator('option')).toHaveCount(3);
  const trigger = panel.locator('.custom-select-trigger').first();
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.locator('.custom-select-menu.open .custom-select-option[data-val="dark"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await trigger.click();
  await page.locator('.custom-select-menu.open .custom-select-option[data-val="light"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await expect(theme).toBeAttached();
});

test('设置专项：网络分类代理配置与测试连接交互', async ({ page }) => {
  await installSettingsMock(page);
  await page.click('#btn-settings');
  const panel = page.locator('#settings-panel');
  await panel.locator('#settings-categories button[data-category="http"]').click();

  const proxyInput = panel.locator('#setting-proxy-url');
  const testBtn = panel.locator('#setting-proxy-test-btn');
  const resultBox = panel.locator('#setting-proxy-result');

  // 默认 off 模式：输入框与按钮禁用
  await expect(proxyInput).toBeDisabled();
  await expect(testBtn).toBeDisabled();

  // 切换为 override 模式
  await page.evaluate(() => {
    window.SettingsUI.receive('workspace:settings-effective', {
      settings: {
        version: 1,
        http: { proxySupport: 'override', proxy: 'http://127.0.0.1:7890', proxyStrictSSL: true }
      },
      warnings: [],
      overridden: []
    });
  });

  await expect(proxyInput).toBeEnabled();
  await expect(testBtn).toBeEnabled();
  await expect(proxyInput).toHaveValue('http://127.0.0.1:7890');

  // 点击测试连接：发出 net.testProxy 命令
  await testBtn.click();
  await expect(resultBox).toHaveText('测试中…');

  const ipcMessages = await page.evaluate(() => (window.__ipcLog || []).map((msg) => JSON.parse(msg)));
  const testCmd = ipcMessages.find((m) => m.command === 'net.testProxy');
  expect(testCmd).toBeTruthy();
  expect(testCmd.proxy).toBe('http://127.0.0.1:7890');
  expect(testCmd.strictSsl).toBe(true);

  // 模拟 Rust 返回成功回执
  await page.evaluate(() => {
    window.SettingsUI.receive('net:test-proxy-result', {
      ok: true,
      message: '连通成功：https://api.github.com（45ms，状态 200）',
      status: 200,
      latencyMs: 45,
      target: 'https://api.github.com'
    });
  });

  await expect(resultBox).toContainText('连通成功');
  await expect(resultBox).toHaveClass(/setting-proxy-ok/);
});

test('设置与布局关键路径：窄视口保留编辑器可用区域且 modal 不溢出', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const editor = page.locator('#editor');
  const editorBox = await editor.boundingBox();
  expect(editorBox).not.toBeNull();
  expect(editorBox.width).toBeGreaterThanOrEqual(80);
  await page.click('#btn-settings');
  const panelBox = await page.locator('#settings-panel').boundingBox();
  expect(panelBox).not.toBeNull();
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(1024);
});

test('侧栏自由拖宽：项目树可拖至窗口右侧附近，仅保留最小编辑区', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 768 });
  const resizer = page.locator('#panel-tree-resizer');
  const box = await resizer.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(1250, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const treeBox = await page.locator('#panel-tree').boundingBox();
  expect(treeBox.width).toBeGreaterThan(900);
  const editorBox = await page.locator('#editor').boundingBox();
  expect(editorBox.width).toBeGreaterThanOrEqual(40);
});

test('主题切换：data-theme 往返并通过统一 settings 命令持久化', async ({ page }) => {
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-theme', 'light');

  await page.click('#btn-theme');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.click('#btn-theme');
  await expect(root).toHaveAttribute('data-theme', 'light');

  expect(await page.evaluate(() => localStorage.getItem('glancemd-ultra-theme'))).toBeNull();
  const themes = await page.evaluate(() => window.__ipcLog
    .map((raw) => JSON.parse(raw))
    .filter((message) => message.command === 'workspace.settings.set-theme')
    .map((message) => message.theme));
  expect(themes.slice(-2)).toEqual(['dark', 'light']);
});

test('Outline 左右侧拖动与停靠验收：right 拖左缘向左变宽、left 拖右缘向右变宽且边界正确、关闭无折叠窄条', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 768 });
  const outlinePanel = page.locator('#panel-outline');
  const outlineResizer = page.locator('#panel-outline-resizer');
  const treePanel = page.locator('#panel-tree');
  const editor = page.locator('#editor');

  // 1. 初始关闭态验证：Outline 与手柄均不可见且不占宽，不存在独立折叠窄条
  await expect(outlinePanel).toBeHidden();
  await expect(outlineResizer).toBeHidden();
  expect(await outlinePanel.boundingBox()).toBeNull();
  expect(await outlineResizer.boundingBox()).toBeNull();
  await expect(page.locator('#panel-outline .panel-expand-btn')).toBeHidden();

  // 2. right 模式打开后拖动左缘向左，宽度明显增加且编辑器变窄
  await page.click('#btn-toc');
  await expect(outlinePanel).toBeVisible();
  await expect(outlinePanel).toHaveClass(/open/);
  await expect(outlineResizer).toBeVisible();

  const outlineBoxBeforeRightDrag = await outlinePanel.boundingBox();
  const editorBoxBeforeRightDrag = await editor.boundingBox();
  expect(outlineBoxBeforeRightDrag).not.toBeNull();
  expect(editorBoxBeforeRightDrag).not.toBeNull();

  // 拖动左缘（#panel-outline-resizer）向左 100px
  const resizerBoxRight = await outlineResizer.boundingBox();
  expect(resizerBoxRight).not.toBeNull();
  await page.mouse.move(resizerBoxRight.x + resizerBoxRight.width / 2, resizerBoxRight.y + 100);
  await page.mouse.down();
  await page.mouse.move(resizerBoxRight.x - 100, resizerBoxRight.y + 100, { steps: 8 });
  await page.mouse.up();

  const outlineBoxAfterRightDrag = await outlinePanel.boundingBox();
  const editorBoxAfterRightDrag = await editor.boundingBox();
  expect(outlineBoxAfterRightDrag.width).toBeGreaterThan(outlineBoxBeforeRightDrag.width + 50);
  expect(editorBoxAfterRightDrag.width).toBeLessThan(editorBoxBeforeRightDrag.width - 50);

  // 3. 切 outlineSide=left（可直接调用 LayoutUI.setOutlineSide('left') 模拟设置生效）
  await page.evaluate(() => window.LayoutUI.setOutlineSide('left'));

  // 确认 Outline bounding box 位于 Tree 右侧和 Editor 左侧
  const treeBoxLeftMode = await treePanel.boundingBox();
  const outlineBoxLeftMode = await outlinePanel.boundingBox();
  const editorBoxLeftMode = await editor.boundingBox();

  expect(treeBoxLeftMode).not.toBeNull();
  expect(outlineBoxLeftMode).not.toBeNull();
  expect(editorBoxLeftMode).not.toBeNull();

  // Outline 在 Tree 右侧（Outline.x >= Tree.x + Tree.width）
  expect(outlineBoxLeftMode.x).toBeGreaterThanOrEqual(treeBoxLeftMode.x + treeBoxLeftMode.width);
  // Editor 在 Outline 右侧（Editor.x >= Outline.x + Outline.width）
  expect(editorBoxLeftMode.x).toBeGreaterThanOrEqual(outlineBoxLeftMode.x + outlineBoxLeftMode.width);

  const outlineWidthBeforeLeftDrag = outlineBoxLeftMode.width;
  const editorWidthBeforeLeftDrag = editorBoxLeftMode.width;

  // left 模式下拖动右缘（#panel-outline-resizer）向右
  const resizerBoxLeft = await outlineResizer.boundingBox();
  expect(resizerBoxLeft).not.toBeNull();
  // 手柄位于 Outline 右侧
  expect(resizerBoxLeft.x).toBeGreaterThanOrEqual(outlineBoxLeftMode.x + outlineBoxLeftMode.width - 2);

  await page.mouse.move(resizerBoxLeft.x + resizerBoxLeft.width / 2, resizerBoxLeft.y + 100);
  await page.mouse.down();
  await page.mouse.move(resizerBoxLeft.x + 80, resizerBoxLeft.y + 100, { steps: 8 });
  await page.mouse.up();

  const outlineBoxAfterLeftDrag = await outlinePanel.boundingBox();
  const editorBoxAfterLeftDrag = await editor.boundingBox();
  expect(outlineBoxAfterLeftDrag.width).toBeGreaterThan(outlineWidthBeforeLeftDrag + 40);
  expect(editorBoxAfterLeftDrag.width).toBeLessThan(editorWidthBeforeLeftDrag - 40);

  // 拖动后相对位置依旧正确：Outline 仍位于 Tree 右侧和 Editor 左侧
  expect(outlineBoxAfterLeftDrag.x).toBeGreaterThanOrEqual(treeBoxLeftMode.x + treeBoxLeftMode.width);
  expect(editorBoxAfterLeftDrag.x).toBeGreaterThanOrEqual(outlineBoxAfterLeftDrag.x + outlineBoxAfterLeftDrag.width);

  // 4. 关闭后 Outline 与 resizer 都不占宽/不可见，不存在独立折叠窄条
  await page.click('#btn-toc');
  await expect(outlinePanel).toBeHidden();
  await expect(outlineResizer).toBeHidden();
  expect(await outlinePanel.boundingBox()).toBeNull();
  expect(await outlineResizer.boundingBox()).toBeNull();
  await expect(page.locator('#panel-outline .panel-expand-btn')).toBeHidden();
});
