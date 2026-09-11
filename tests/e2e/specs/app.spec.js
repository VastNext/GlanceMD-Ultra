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
  await page.evaluate((initialSettings) => {
    let currentSettings = JSON.parse(JSON.stringify(initialSettings));
    window.__ipcResponder = (raw) => {
      const message = JSON.parse(raw);
      if (message.command === 'workspace.settings.get-effective') {
        window.__fromRust('workspace:settings-effective', { settings: currentSettings });
      } else if (message.command === 'workspace.settings.get-global') {
        window.__fromRust('workspace:settings-global', { settings: currentSettings });
      } else if (message.command === 'workspace.settings.load-project') {
        window.__fromRust('workspace:settings-project', { patch: {} });
      } else if (message.command === 'workspace.settings.set-global') {
        try {
          const parsed = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
          currentSettings = parsed;
          window.__fromRust('workspace:settings-changed', {});
        } catch (e) {}
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

test('设置专项：modal 可见、十类真实分类与关闭/Escape', async ({ page }) => {
  await page.click('#btn-settings');
  const panel = page.locator('#settings-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('#settings-categories button')).toHaveCount(10);
  await expect(panel.locator('#settings-categories')).toContainText('外观');
  await expect(panel.locator('#settings-categories')).toContainText('文件');
  await expect(panel.locator('#settings-categories')).toContainText('监听');
  await expect(panel.locator('#settings-categories')).toContainText('窗口与命令行');
  await expect(panel.locator('#settings-categories')).toContainText('网络');
  await expect(panel.locator('#settings-categories')).toContainText('翻译');
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

  // 模拟 Rust 返回成功回执（真实经由 window.__fromRust 驱动事件网桥）
  await page.evaluate(() => {
    window.__fromRust('workspace:proxy-test-result', {
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

test('多语言切换专项：从设置切换为英文后全界面即时更新为英文，切回中文恢复', async ({ page }) => {
  await installSettingsMock(page);
  await page.click('#btn-settings');
  const panel = page.locator('#settings-panel');
  await expect(panel).toBeVisible();

  // 1. 在设置中将语言切换为 English
  const langSelect = panel.locator('[data-setting="language"]');
  await expect(langSelect).toBeAttached();
  // 查找 language 对应的自定义下拉组件
  const langRow = panel.locator('.setting-row').filter({ hasText: /界面语言|Language/ });
  const langTrigger = langRow.locator('.custom-select-trigger');
  await langTrigger.click();
  await page.locator('.custom-select-menu.open .custom-select-option[data-val="en"]').click();

  // 2. 验证设置弹窗内部即时更新为英文
  await expect(panel.locator('#settings-dialog-title')).toHaveText('Settings');
  await expect(panel.locator('#current-category-badge')).toHaveText('Appearance');
  await expect(panel.locator('#settings-reset-category')).toHaveText('Reset current category to defaults');
  await expect(panel.locator('#settings-done')).toHaveText('Done');
  await expect(panel.locator('#settings-categories button[data-category="appearance"]')).toContainText('Appearance');
  await expect(panel.locator('#settings-categories button[data-category="files"]')).toContainText('Files');
  await expect(panel.locator('#settings-categories button[data-category="editor"]')).toContainText('Editor');

  // 3. 关闭设置弹窗，验证主界面各区域
  await panel.locator('#settings-done').click();
  await expect(panel).toBeHidden();

  // 验证顶栏按钮 Tooltip / 描述（包含快捷键）
  await expect(page.locator('#btn-new')).toHaveAttribute('title', /New/);
  await expect(page.locator('#btn-open')).toHaveAttribute('title', /Open Folder/);
  await expect(page.locator('#btn-open-file')).toHaveAttribute('title', /Open File/);
  await expect(page.locator('#btn-settings')).toHaveAttribute('title', /Settings/);
  await expect(page.locator('#btn-save')).toHaveAttribute('title', /Save/);
  await expect(page.locator('#btn-split')).toHaveAttribute('title', /Split View/);
  await expect(page.locator('#btn-toc')).toHaveAttribute('title', /Outline/);

  // 验证欢迎页
  await expect(page.locator('.welcome-subtitle')).toHaveText('Lightweight native Markdown workspace editor');
  await expect(page.locator('#welcome-btn-new .welcome-btn-primary')).toHaveText('New File');
  await expect(page.locator('#welcome-btn-open-file .welcome-btn-primary')).toHaveText('Open File');
  await expect(page.locator('#welcome-btn-open-folder .welcome-btn-primary')).toHaveText('Open Folder');
  await expect(page.locator('#welcome-tab-projects')).toHaveText('Recent Projects');
  await expect(page.locator('#welcome-tab-files')).toHaveText('Recent Files');

  // 验证侧栏资源管理器与大纲面板
  await expect(page.locator('#panel-tree .panel-title')).toHaveText('Explorer');
  await expect(page.locator('#panel-tree .panel-empty')).toHaveText('No project opened');
  await expect(page.locator('#panel-outline .panel-title')).toHaveText('Outline');
  await expect(page.locator('#panel-outline .panel-empty')).toHaveText('No outline');

  // 4. 切回中文
  await page.click('#btn-settings');
  await expect(panel).toBeVisible();
  const langRowEn = panel.locator('.setting-row').filter({ hasText: /Language/ });
  const langTriggerEn = langRowEn.locator('.custom-select-trigger');
  await langTriggerEn.click();
  await page.locator('.custom-select-menu.open .custom-select-option[data-val="zh-CN"]').click();

  await expect(panel.locator('#settings-dialog-title')).toHaveText('设置');
  await expect(panel.locator('#current-category-badge')).toHaveText('外观');
  await panel.locator('#settings-done').click();
  await expect(page.locator('#panel-tree .panel-title')).toHaveText('资源管理器');
  await expect(page.locator('#btn-new')).toHaveAttribute('title', /新建/);
});

test('右键菜单专项：切换英文后已打开的项目树菜单立即刷新', async ({ page }) => {
  await installSettingsMock(page);
  await page.evaluate(() => {
    window.__fromRust('workspace:opened', { root: 'G:/workspace' });
    window.__fromRust('workspace:tree-listed', {
      path: '',
      entries: [{ name: 'README.md', relPath: 'README.md', kind: 'file' }]
    });
  });
  const row = page.locator('#project-tree-root .tree-row').first();
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  const menu = page.locator('.ctx-menu').last();
  await expect(menu).toContainText('新建文件');

  await page.evaluate(() => window.I18n.setLanguage('en'));
  await expect(menu).toContainText('New File');
  await expect(menu).toContainText('Copy Absolute Path');
  await expect(menu).not.toContainText('新建文件');
});

test('翻译专项：设置页翻译分类字段展示与测试连接交互', async ({ page }) => {
  await installSettingsMock(page);
  await page.click('#btn-settings');
  const panel = page.locator('#settings-panel');
  await panel.locator('#settings-categories button[data-category="translation"]').click();

  const engineRow = panel.locator('.setting-row', { hasText: '翻译引擎' });
  const testBtn = panel.locator('#setting-translate-test-btn');
  const resultBox = panel.locator('#setting-translate-result');

  await expect(engineRow).toBeVisible();
  await expect(engineRow.locator('.custom-select-trigger')).toBeVisible();
  await expect(testBtn).toBeVisible();

  // 点击测试连接
  await testBtn.click();
  await expect(resultBox).toHaveText('测试中…');

  const ipcMessages = await page.evaluate(() => (window.__ipcLog || []).map((msg) => JSON.parse(msg)));
  const testCmd = ipcMessages.find((m) => m.command === 'translate.test');
  expect(testCmd).toBeTruthy();
  expect(testCmd.engineKind).toBe('google');

  // 模拟 Rust 返回成功回执
  await page.evaluate(() => {
    window.__fromRust('workspace:translate-result', {
      requestId: 'test',
      ok: true,
      message: '连通成功（120ms）',
      latencyMs: 120
    });
  });

  await expect(resultBox).toHaveText('连通成功（120ms）');
  await expect(resultBox).toHaveClass(/setting-proxy-ok/);
});

test('划词翻译专项：Alt+T 弹出气泡、模拟回执展示译文并支持替换/插入/复制', async ({ page }) => {
  await installSettingsMock(page);

  // 聚焦编辑器并输入文本、选中其中一段
  const editor = page.locator('#editor');
  await editor.fill('Hello world from GlanceMD Ultra');
  await page.evaluate(() => {
    const ed = document.getElementById('editor');
    ed.focus();
    ed.setSelectionRange(6, 11); // 'world'
  });

  // Alt+T 触发翻译命令
  await page.keyboard.press('Alt+T');

  const bubble = page.locator('#translate-bubble');
  await expect(bubble).toBeVisible();
  await expect(bubble.locator('.translate-bubble-title')).toContainText('划词翻译');

  // 模拟 Rust 异步返回翻译回执
  const st = await page.evaluate(() => window.TranslateUI.getState());
  expect(st.currentRequestId).toBeTruthy();

  await page.evaluate((reqId) => {
    window.__fromRust('workspace:translate-result', {
      requestId: reqId,
      ok: true,
      results: [{ id: 's0', text: '世界' }]
    });
  }, st.currentRequestId);

  await expect(bubble.locator('#translate-result-text')).toHaveText('世界');

  // 点击替换选区
  await bubble.locator('#translate-btn-replace').click();
  await expect(bubble).toBeHidden();
  await expect(editor).toHaveValue('Hello 世界 from GlanceMD Ultra');

  // Escape 关闭气泡测试
  await page.evaluate(() => {
    const ed = document.getElementById('editor');
    ed.focus();
    ed.setSelectionRange(0, 5); // 'Hello'
  });
  await page.keyboard.press('Alt+T');
  await expect(bubble).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bubble).toBeHidden();
});

test('划词翻译专项：选中文本浮现翻译按钮、点击按钮弹出气泡并完成页面翻译', async ({ page }) => {
  await installSettingsMock(page);

  const editor = page.locator('#editor');
  await editor.fill('Good morning and welcome to GlanceMD Ultra');

  // 模拟鼠标选中 'Good morning' 并触发 mouseup
  await page.evaluate(() => {
    const ed = document.getElementById('editor');
    ed.focus();
    ed.setSelectionRange(0, 12); // 'Good morning'
    ed.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 200, clientY: 200 }));
  });

  const triggerBtn = page.locator('#translate-trigger-btn');
  await expect(triggerBtn).toBeVisible();

  // 点击浮动翻译按钮
  await triggerBtn.click();

  const bubble = page.locator('#translate-bubble');
  await expect(bubble).toBeVisible();

  // 获取 requestId 并模拟返回译文
  const st = await page.evaluate(() => window.TranslateUI.getState());
  expect(st.currentRequestId).toBeTruthy();

  await page.evaluate((reqId) => {
    window.__fromRust('workspace:translate-result', {
      requestId: reqId,
      ok: true,
      results: [{ id: 's0', text: '早上好' }]
    });
  }, st.currentRequestId);

  await expect(bubble.locator('#translate-result-text')).toHaveText('早上好');

  // 点击替换，验证页面内容已成功翻译替换
  await bubble.locator('#translate-btn-replace').click();
  await expect(bubble).toBeHidden();
  await expect(editor).toHaveValue('早上好 and welcome to GlanceMD Ultra');
});

test('顶栏翻译图标与 Popup 浮窗：点击展开 Popup、一键双语翻译预览区并支持还原', async ({ page }) => {
  await installSettingsMock(page);

  // 验证顶栏右侧 #btn-translate 存在且位于 #btn-theme 左侧
  const btnTranslate = page.locator('#btn-translate');
  const btnTheme = page.locator('#btn-theme');
  await expect(btnTranslate).toBeVisible();
  await expect(btnTheme).toBeVisible();

  // 切换到分屏或预览模式并输入内容
  const editor = page.locator('#editor');
  await editor.fill('# Welcome to GlanceMD\n\nGlanceMD Ultra is a lightweight markdown workspace.');
  await page.click('#btn-split'); // 分屏开启预览区

  const preview = page.locator('#preview');
  await expect(preview.locator('h1')).toContainText('Welcome to GlanceMD');
  await expect(preview.locator('p')).toContainText('GlanceMD Ultra is a lightweight markdown workspace.');

  // 点击顶栏翻译按钮，展开 Popup 浮窗
  await btnTranslate.click();
  const popup = page.locator('#translate-popup');
  await expect(popup).toBeVisible();
  await expect(popup.locator('.translate-popup-title')).toContainText('语层翻译');

  // 点击单一主操作按钮「翻译当前预览」
  const togglePreviewBtn = popup.locator('#popup-btn-toggle-preview');
  await expect(togglePreviewBtn).toBeVisible();
  await expect(togglePreviewBtn).toContainText('翻译当前预览');
  await togglePreviewBtn.click();

  // 获取 pending requestId 并模拟返回双语译文
  const st = await page.evaluate(() => window.TranslateUI.getState());
  expect(st.previewPendingReqId).toBeTruthy();

  await page.evaluate((reqId) => {
    window.__fromRust('workspace:translate-result', {
      requestId: reqId,
      ok: true,
      results: [
        { id: 'p_0', text: '欢迎使用 GlanceMD' },
        { id: 'p_1', text: 'GlanceMD Ultra 是一个轻量级 Markdown 工作区。' }
      ]
    });
  }, st.previewPendingReqId);

  // 验证预览区中已插入双语对照译文块（.preview-trans-block）
  const transBlocks = preview.locator('.preview-trans-block');
  await expect(transBlocks).toHaveCount(2);
  await expect(transBlocks.first()).toHaveText('欢迎使用 GlanceMD');
  await expect(transBlocks.last()).toHaveText('GlanceMD Ultra 是一个轻量级 Markdown 工作区。');

  // 验证主操作按钮已动态变为「还原预览原文」
  await expect(togglePreviewBtn).toContainText('还原预览原文');
  await togglePreviewBtn.click();

  // 验证双语译文块已被清除，还原纯净渲染
  await expect(preview.locator('.preview-trans-block')).toHaveCount(0);
  await expect(preview.locator('h1')).toHaveText('Welcome to GlanceMD');
});

test('划词翻译专项：预览区选中文字 Alt+T 呼出气泡（无需编辑器聚焦）', async ({ page }) => {
  await installSettingsMock(page);

  const editor = page.locator('#editor');
  await editor.fill('# Title\n\nThe quick brown fox jumps over the lazy dog.');
  await page.click('#btn-split');
  const preview = page.locator('#preview');
  await expect(preview.locator('p')).toContainText('The quick brown fox');

  // 在预览区用 Range API 选中段落文本（焦点不在编辑器），并派发 mouseup
  await page.evaluate(() => {
    const p = document.querySelector('#preview p');
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 400, clientY: 300 }));
  });

  // Alt+T：绑定已无 editorTextFocus 限制，预览区选区同样生效
  await page.keyboard.press('Alt+T');
  const bubble = page.locator('#translate-bubble');
  await expect(bubble).toBeVisible();
  await expect(bubble.locator('.translate-bubble-title')).toContainText('划词翻译');

  // 预览区来源：回执后仅提供复制，无替换/插入按钮
  const st = await page.evaluate(() => window.TranslateUI.getState());
  await page.evaluate((reqId) => {
    window.__fromRust('workspace:translate-result', {
      requestId: reqId,
      ok: true,
      results: [{ id: 's0', text: '敏捷的棕色狐狸跳过了懒狗。' }]
    });
  }, st.currentRequestId);
  await expect(bubble.locator('#translate-result-text')).toHaveText('敏捷的棕色狐狸跳过了懒狗。');
  await expect(bubble.locator('#translate-btn-replace')).toHaveCount(0);
  await expect(bubble.locator('#translate-btn-copy')).toBeVisible();
});

test('划词翻译专项：Alt+Shift+T 直达替换选区（不弹气泡）', async ({ page }) => {
  await installSettingsMock(page);

  const editor = page.locator('#editor');
  await editor.fill('Hello world from Ultra');
  await page.evaluate(() => {
    const ed = document.getElementById('editor');
    ed.focus();
    ed.setSelectionRange(6, 11); // 'world'
  });

  await page.keyboard.press('Alt+Shift+T');
  const bubble = page.locator('#translate-bubble');
  await expect(bubble).toBeHidden();

  const st = await page.evaluate(() => window.TranslateUI.getState());
  expect(st.currentRequestId).toBeTruthy();
  expect(st.pendingAutoReplace).toBe(true);

  await page.evaluate((reqId) => {
    window.__fromRust('workspace:translate-result', {
      requestId: reqId,
      ok: true,
      results: [{ id: 's0', text: '世界' }]
    });
  }, st.currentRequestId);

  await expect(editor).toHaveValue('Hello 世界 from Ultra');
  await expect(bubble).toBeHidden();
});

test('划词翻译专项：气泡替换后 Ctrl+Z 恢复原文（应用级撤销栈）', async ({ page }) => {
  await installSettingsMock(page);

  const editor = page.locator('#editor');
  await editor.fill('Hello world from Ultra');
  await page.evaluate(() => {
    const ed = document.getElementById('editor');
    ed.focus();
    ed.setSelectionRange(6, 11); // 'world'
    ed.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 300, clientY: 200 }));
  });

  await page.locator('#translate-trigger-btn').click();
  const bubble = page.locator('#translate-bubble');
  await expect(bubble).toBeVisible();

  const st = await page.evaluate(() => window.TranslateUI.getState());
  await page.evaluate((reqId) => {
    window.__fromRust('workspace:translate-result', {
      requestId: reqId,
      ok: true,
      results: [{ id: 's0', text: '世界' }]
    });
  }, st.currentRequestId);
  await expect(bubble.locator('#translate-result-text')).toHaveText('世界');

  await bubble.locator('#translate-btn-replace').click();
  await expect(editor).toHaveValue('Hello 世界 from Ultra');

  // 撤销必须精确回退本次替换（而非启动时的空文档）
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveValue('Hello world from Ultra');
});

test('划词翻译专项：气泡出现在划词位置旁且标题栏可拖动', async ({ page }) => {
  await installSettingsMock(page);

  const editor = page.locator('#editor');
  await editor.fill('Hello world from Ultra');
  // 在编辑器中部划词：触发按钮应出现在鼠标附近，气泡应紧随其下
  await page.evaluate(() => {
    const ed = document.getElementById('editor');
    ed.focus();
    ed.setSelectionRange(6, 11);
    const rect = ed.getBoundingClientRect();
    ed.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      clientX: rect.left + 120,
      clientY: rect.top + 80,
    }));
  });

  const trigger = page.locator('#translate-trigger-btn');
  await expect(trigger).toBeVisible();
  // 先记录触发按钮位置（气泡打开后触发按钮会隐藏）
  const triggerBox = await trigger.boundingBox();
  await trigger.click();

  const bubble = page.locator('#translate-bubble');
  await expect(bubble).toBeVisible();

  // 气泡锚定在触发按钮附近（同一区域，而非视口固定 (120,120) 回退值）
  const before = await bubble.boundingBox();
  expect(Math.abs(before.x - triggerBox.x)).toBeLessThan(24);
  expect(Math.abs(before.y - (triggerBox.y + triggerBox.height + 8))).toBeLessThan(24);

  // 标题栏拖拽：按住头部移动，气泡整体跟随（按压点落在标题栏文字区）
  await page.mouse.move(before.x + 60, before.y + 20);
  await page.mouse.down();
  await page.mouse.move(before.x + 160, before.y + 100, { steps: 6 });
  await page.mouse.up();
  const after = await bubble.boundingBox();
  expect(Math.round(after.x - before.x)).toBe(100);
  expect(Math.round(after.y - before.y)).toBe(80);
});
