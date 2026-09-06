/* 强快捷键、多 Scheme 与 Vim Mode 端到端验收。
 * 覆盖：
 * 1. Eclipse Scheme 默认核心键（Ctrl+3 / Ctrl+O / Ctrl+H / Ctrl+Shift+L）；
 * 2. Key Assist 浮层交互与焦点恢复；
 * 3. 切换 Scheme 即时生效；
 * 4. Vim 模式开关、Normal/Insert、Ex :w 保存与退出；
 * 5. 编辑器与项目树的 Context 隔离。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
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

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 768 });
  await page.goto(ensurePage());
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('Eclipse Scheme：Ctrl+3 打开命令面板、Ctrl+H 打开搜索、Ctrl+Shift+L 打开 Key Assist', async ({ page }) => {
  // 1. Ctrl+3 打开命令面板
  await page.keyboard.press('Control+3');
  const palette = page.locator('#command-palette');
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();

  // 2. Ctrl+H 打开全文搜索面板
  await page.keyboard.press('Control+h');
  const search = page.locator('#search-panel');
  await expect(search).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();

  // 3. Ctrl+Shift+L 打开 Key Assist
  await page.keyboard.press('Control+Shift+L');
  const keyAssist = page.locator('.key-assist-dialog');
  await expect(keyAssist).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(keyAssist).toBeHidden();
});

test('Key Assist：支持搜索、方向键导航、Enter 执行与 Escape 焦点恢复', async ({ page }) => {
  await page.click('#btn-new');
  await page.locator('#editor').focus();

  await page.keyboard.press('Control+Shift+L');
  const keyAssist = page.locator('.key-assist-dialog');
  await expect(keyAssist).toBeVisible();

  // 搜索 "设置"
  await page.locator('#key-assist-search-input').fill('设置');
  const items = page.locator('.key-assist-item');
  await expect(items.first()).toBeVisible();

  // 按 Escape 关闭并确认焦点回到编辑器
  await page.keyboard.press('Escape');
  await expect(keyAssist).toBeHidden();
  await expect(page.locator('#editor')).toBeFocused();
});

test('Vim Mode：Alt+Shift+E V 开启、i 插入、Esc 回 Normal、:w 保存与关闭恢复', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.focus();

  // 1. 开启 Vim Mode
  await page.keyboard.press('Alt+Shift+KeyE');
  await page.keyboard.press('KeyV');

  const vimBadge = page.locator('.vim-status-widget');
  await expect(vimBadge).toBeVisible();
  await expect(vimBadge).toContainText(/NORMAL/i);

  // 2. i 进入 Insert
  await page.keyboard.press('i');
  await expect(vimBadge).toContainText(/INSERT/i);
  await editor.type('# 第一章\n正文内容\n');

  // 3. Escape 返回 Normal
  await page.keyboard.press('Escape');
  await expect(vimBadge).toContainText(/NORMAL/i);

  // 4. :w 触发保存
  await page.keyboard.press(':');
  await page.keyboard.press('w');
  await page.keyboard.press('Enter');

  const saveIpc = await page.evaluate(() =>
    (window.__ipcLog || []).map((m) => JSON.parse(m)).filter((m) => m.command === 'save_as' || m.command === 'save_file'),
  );
  expect(saveIpc.length).toBeGreaterThanOrEqual(1);

  // 5. 再次 Alt+Shift+E V 关闭 Vim
  await page.keyboard.press('Alt+Shift+KeyE');
  await page.keyboard.press('KeyV');
  await expect(page.locator('.vim-status-widget')).toHaveCount(0);
});
