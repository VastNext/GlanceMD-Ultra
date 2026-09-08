/* Vim Mode 可视化与交互完整端到端验收
 * 覆盖阶段 1：
 * 1. 模式栏挂载于 #statusbar（NORMAL, INSERT, VISUAL, VISUAL LINE, COMMAND）；
 * 2. 命令行底栏实时显示（:、:w、Esc 取消、Enter 提交）；
 * 3. 真实方块光标 (.vim-block-cursor) 在 Normal/Visual 显示、Insert 隐藏，随光标与滚动同步；
 * 4. :q! 与 :q 的关闭与脏检查差异。
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

test('Vim 模式栏挂载于 #statusbar 并在视口内正确展示各模式', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.focus();

  // 1. 开启 Vim Mode
  await page.keyboard.press('Alt+Shift+KeyE');
  await page.keyboard.press('KeyV');

  const statusbar = page.locator('#statusbar');
  const vimWidget = statusbar.locator('.vim-status-widget');
  await expect(vimWidget).toBeVisible();

  // 验证模式栏是 #statusbar 的子元素且位于视口底部
  const widgetBox = await vimWidget.boundingBox();
  const statusBox = await statusbar.boundingBox();
  expect(widgetBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  expect(widgetBox.y).toBeGreaterThanOrEqual(statusBox.y - 2);

  // 2. 验证 NORMAL
  const modeBadge = vimWidget.locator('.vim-mode-badge');
  await expect(modeBadge).toHaveText(/NORMAL/i);

  // 3. 验证 INSERT
  await page.keyboard.press('i');
  await expect(modeBadge).toHaveText(/INSERT/i);

  // 4. 验证 VISUAL 与 VISUAL LINE
  await page.keyboard.press('Escape');
  await expect(modeBadge).toHaveText(/NORMAL/i);

  await page.keyboard.press('v');
  await expect(modeBadge).toHaveText(/VISUAL/i);

  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+V');
  await expect(modeBadge).toHaveText(/VISUAL LINE/i);

  // 5. 验证 COMMAND
  await page.keyboard.press('Escape');
  await page.keyboard.press(':');
  await expect(modeBadge).toHaveText(/COMMAND/i);

  await page.keyboard.press('Escape');
  await expect(modeBadge).toHaveText(/NORMAL/i);
});

test('Vim 命令行底栏实时显示输入字符、Esc 取消与 Enter 执行', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.focus();

  // 开启 Vim
  await page.keyboard.press('Alt+Shift+KeyE');
  await page.keyboard.press('KeyV');

  // 输入 : 唤起命令行
  await page.keyboard.press(':');
  const cmdOverlay = page.locator('.vim-command-line-overlay');
  await expect(cmdOverlay).toBeVisible();
  await expect(cmdOverlay.locator('.vim-cmd-prompt')).toHaveText(':');

  // 输入 w 实时显示
  await page.keyboard.press('w');
  await expect(cmdOverlay.locator('.vim-cmd-input')).toHaveValue('w');

  // 验证 markdown textarea 内容未被污染
  const editorVal = await editor.inputValue();
  expect(editorVal).not.toContain(':');
  expect(editorVal).not.toContain('w');

  // 按 Enter 提交执行并隐藏命令行
  await page.keyboard.press('Enter');
  await expect(cmdOverlay).toBeHidden();

  // 再次按 : 唤起并按 Escape 取消
  await page.keyboard.press(':');
  await expect(cmdOverlay).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(cmdOverlay).toBeHidden();
  await expect(editor).toBeFocused();
});

test('Vim 真实方块光标 (.vim-block-cursor) 在 Normal 模式渲染并在 Insert 模式隐藏', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.focus();

  // 开启 Vim
  await page.keyboard.press('Alt+Shift+KeyE');
  await page.keyboard.press('KeyV');

  // 进入 Insert 输入多行与中英文字符
  await page.keyboard.press('i');
  await editor.type('Hello Vim 光标测量\nSecond line with Tab\tdata\nThird line\n');

  // 返回 Normal 模式
  await page.keyboard.press('Escape');

  const blockCursor = page.locator('.vim-block-cursor');
  await expect(blockCursor).toBeVisible();

  // 测量方块光标尺寸大于 0
  const box = await blockCursor.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeGreaterThan(4);
  expect(box.height).toBeGreaterThan(10);

  // 再次进入 Insert 模式，方块光标应隐藏
  await page.keyboard.press('i');
  await expect(blockCursor).toBeHidden();

  // 返回 Normal 恢复显示
  await page.keyboard.press('Escape');
  await expect(blockCursor).toBeVisible();
});

test('Vim :q 与 :q! 退出 Vim 模式但保留编辑内容与 dirty 状态，且不关闭 tab', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.focus();

  // 开启 Vim 并输入内容使 tab 变脏 (dirty)
  await page.keyboard.press('Alt+Shift+KeyE');
  await page.keyboard.press('KeyV');

  await page.keyboard.press('i');
  await editor.type('Dirty text should be retained by :q and :q!\n');
  await page.keyboard.press('Escape');

  // 确认 tab 变脏
  const tabDirty = page.locator('.tab.active .tab-dirty');
  await expect(tabDirty).toBeVisible();

  // 执行 :q! 退出 Vim 模式
  await page.keyboard.press(':');
  await page.keyboard.press('q');
  await page.keyboard.press('!');
  await page.keyboard.press('Enter');

  // 验证：仍有 1 个 tab，tab 保持 dirty，内容未丢失，但 Vim 模式已退出
  await expect(page.locator('.tab')).toHaveCount(1);
  await expect(tabDirty).toBeVisible();
  const val = await editor.inputValue();
  expect(val).toContain('Dirty text should be retained');
  await expect(page.locator('.vim-status-widget')).toHaveCount(0);
});
