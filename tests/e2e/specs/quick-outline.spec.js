const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, expect } = require('playwright/test');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = path.join(ROOT, 'tests', '.tmp', 'index.html');

function url() {
  execFileSync('python', [path.join(ROOT, 'tools', 'build_test_page.py')], { cwd: ROOT, stdio: 'pipe' });
  return pathToFileURL(PAGE).href;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url());
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const btnNew = page.locator('#btn-new');
  await btnNew.waitFor({ state: 'visible' });
  await btnNew.click();
});

test('场景1：Editor 编辑模式下按 Ctrl+O 打开快速大纲弹窗，过滤标题，按 Enter 精准跳转到目标行', async ({ page }) => {
  const editor = page.locator('#editor');
  const markdown = [
    '# 顶级概览',
    '第一段内容文本。',
    '',
    '## 核心架构设计',
    '架构描述内容。',
    '',
    '### 前端状态机',
    '状态机细节描述。',
    '',
    '## 生产部署',
    '部署说明。'
  ].join('\n');

  await editor.fill(markdown);
  await editor.focus();

  // 1. 按 Ctrl+O 触发大纲弹窗
  await page.keyboard.press('Control+o');
  const overlay = page.locator('#quick-outline-overlay');
  await expect(overlay).toHaveClass(/open/);

  // 检查标题与条目总数徽章
  const dialog = page.locator('.quick-outline-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.quick-outline-title')).toHaveText('大纲');
  await expect(page.locator('#quick-outline-count-badge')).toHaveText('4 个标题');

  // 验证输入框已自动聚焦
  const searchInput = page.locator('#quick-outline-search-input');
  await expect(searchInput).toBeFocused();

  // 2. 截取暗色主题弹窗图
  fs.mkdirSync(path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07'), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07', 'quick-outline-dark.png') });

  // 3. 输入 "前端" 进行模糊过滤
  await searchInput.fill('前端');
  const items = page.locator('.quick-outline-item');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toHaveClass(/selected/);
  await expect(items.first().locator('.quick-outline-text')).toHaveText('前端状态机');

  // 4. 按 Enter 确认跳转
  await page.keyboard.press('Enter');
  await expect(overlay).not.toHaveClass(/open/);
  await expect(editor).toBeFocused();

  // 验证光标已跳转至“### 前端状态机”所在行 (第 7 行，index 6)
  await expect.poll(async () => {
    return await editor.evaluate(el => el.value.slice(0, el.selectionStart).split('\n').length);
  }).toBe(7);
});

test('场景2：Preview 预览模式下按 Ctrl+O 打开大纲弹窗，过滤并跳转，Preview 平滑居中并触发发光动画', async ({ page }) => {
  const editor = page.locator('#editor');
  const markdown = [
    '# 文档前言',
    '前言部分长文本。'.repeat(10),
    '',
    '## 中篇章节分析',
    '中篇部分文本。'.repeat(10),
    '',
    '## 尾声总结',
    '尾声部分文本。'.repeat(10)
  ].join('\n');

  await editor.fill(markdown);
  await page.keyboard.press('Control+s');

  // 切到 Preview 预览模式
  const btnToggle = page.locator('#btn-toggle');
  await btnToggle.click();
  await expect(page.locator('#status-mode')).toHaveText('PREVIEW');

  // 1. 在 Preview 状态下按 Ctrl+O
  await page.keyboard.press('Control+o');
  const overlay = page.locator('#quick-outline-overlay');
  await expect(overlay).toHaveClass(/open/);

  // 2. 键盘向下键选择第二项 (## 中篇章节分析)
  const searchInput = page.locator('#quick-outline-search-input');
  await searchInput.press('ArrowDown');
  const selectedItem = page.locator('.quick-outline-item.selected');
  await expect(selectedItem.locator('.quick-outline-text')).toHaveText('中篇章节分析');

  // 3. 按 Enter 跳转
  await searchInput.press('Enter');
  await expect(overlay).not.toHaveClass(/open/);

  // 验证 Preview 中对应的 h2 元素获得了 quick-outline-target-flash 发光高亮类
  const targetH2 = page.locator('#preview h2', { hasText: '中篇章节分析' });
  await expect(targetH2).toHaveClass(/quick-outline-target-flash/);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07', 'quick-outline-preview-jump.png') });
});

test('场景3：Split 分屏模式下按 Ctrl+O 跳转，Editor 与 Preview 双栏协同滚动，最终焦点稳落在 Editor', async ({ page }) => {
  const editor = page.locator('#editor');
  const markdown = [
    '# 概览介绍',
    '段落1。'.repeat(120),
    '',
    '## 双栏核心模块',
    '段落2。'.repeat(40),
    '',
    '## 结语',
    '段落3。'
  ].join('\n');

  await editor.fill(markdown);

  // 打开 Split View
  const btnSplit = page.locator('#btn-split');
  await btnSplit.click();
  await expect(page.locator('body')).toHaveClass(/split-mode/);
  await expect(page.locator('#editor-container')).toHaveClass(/active/);
  await expect(page.locator('#preview-container')).toHaveClass(/active/);

  // 1. 按 Ctrl+O 呼出大纲
  await page.keyboard.press('Control+o');
  const overlay = page.locator('#quick-outline-overlay');
  await expect(overlay).toHaveClass(/open/);

  // 2. 输入 "双栏"
  const searchInput = page.locator('#quick-outline-search-input');
  await searchInput.fill('双栏');
  const items = page.locator('.quick-outline-item');
  await expect(items).toHaveCount(1);

  // 3. 按 Enter 跳转
  await searchInput.press('Enter');
  await expect(overlay).not.toHaveClass(/open/);

  // 验证：
  // a) Editor 精准滚动并聚焦在“## 双栏核心模块” (第 4 行)
  await expect(editor).toBeFocused();
  const curLine = await editor.evaluate(el => el.value.slice(0, el.selectionStart).split('\n').length);
  expect(curLine).toBe(4);

  // b) Preview 中对应的 h2 获得聚焦发光动画，且只有 preview-wrapper 滚动
  const targetH2 = page.locator('#preview h2', { hasText: '双栏核心模块' });
  await expect(targetH2).toHaveClass(/quick-outline-target-flash/);
  await expect.poll(() => page.locator('#preview-wrapper').evaluate(el => el.scrollTop)).toBeGreaterThan(0);

  // c) 顶层窗口绝不能被 Preview 导航滚动；窗口控制和可拖标题栏保持完整
  const shellState = await page.evaluate(() => ({
    bodyScrollTop: document.body.scrollTop,
    htmlScrollTop: document.documentElement.scrollTop,
    titlebarTop: document.getElementById('titlebar').getBoundingClientRect().top,
    titlebarHeight: document.getElementById('titlebar').getBoundingClientRect().height,
    controlsTop: document.getElementById('window-controls').getBoundingClientRect().top,
    controlsHeight: document.getElementById('window-controls').getBoundingClientRect().height,
    titlebarDrag: getComputedStyle(document.getElementById('titlebar')).getPropertyValue('-webkit-app-region')
  }));
  expect(shellState.bodyScrollTop).toBe(0);
  expect(shellState.htmlScrollTop).toBe(0);
  expect(shellState.titlebarTop).toBe(0);
  expect(shellState.titlebarHeight).toBeGreaterThanOrEqual(37);
  expect(shellState.controlsTop).toBeGreaterThanOrEqual(0);
  expect(shellState.controlsHeight).toBeGreaterThanOrEqual(37);
  expect(shellState.titlebarDrag.trim()).toBe('drag');

  // 截取双栏联动跳转图
  await page.screenshot({ path: path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07', 'quick-outline-split-jump.png') });
});

test('场景4：原侧栏大纲快捷键已成功改绑为 Ctrl+Shift+O，按 Escape 能即刻退出大纲弹窗', async ({ page }) => {
  const editor = page.locator('#editor');
  await editor.fill('# 标题1\n内容\n## 标题2');

  // 1. 按 Ctrl+Shift+O：展开/折叠侧边栏 Outline 面板
  await page.keyboard.press('Control+Shift+o');
  const outlinePanel = page.locator('#panel-outline');
  await expect(outlinePanel).toHaveClass(/open/);

  // 再次按 Ctrl+Shift+O：关闭侧边栏 Outline 面板
  await page.keyboard.press('Control+Shift+o');
  await expect(outlinePanel).not.toHaveClass(/open/);

  // 2. 按 Ctrl+O 打开快速大纲弹窗，按 Escape 关闭
  await page.keyboard.press('Control+o');
  const overlay = page.locator('#quick-outline-overlay');
  await expect(overlay).toHaveClass(/open/);

  await page.keyboard.press('Escape');
  await expect(overlay).not.toHaveClass(/open/);
  await expect(editor).toBeFocused();
});
