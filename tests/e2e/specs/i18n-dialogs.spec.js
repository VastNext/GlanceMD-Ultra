/* i18n 弹框回归：设置切英文后，快捷键呼出的弹框（命令面板 / 快捷键助手 /
 * 快速打开 / 全文搜索）文案必须跟随界面语言，不得残留中文。
 *
 * 背景（用户反馈）：切换 en 后 Ctrl+3 / Ctrl+Shift+L 等弹框仍显示中文——
 * 命令 label 注册时固化 + 弹框静态文案只在 DOM 首建时渲染。
 *
 * 验证路径：
 * 1. zh-CN 下打开各弹框确认中文基线；
 * 2. I18n.setLanguage('en') 后重开各弹框，断言可见文本无 CJK 残留；
 * 3. 明暗双主题截图（docs/qa/i18n-dialogs-2026-09-12/）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('playwright/test');
const { pathToFileURL } = require('node:url');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE_PATH = path.join(REPO_ROOT, 'tests', '.tmp', 'index.html');
const SHOT_DIR = path.join(REPO_ROOT, 'docs', 'qa', 'i18n-dialogs-2026-09-12');

const CJK = /[\u4e00-\u9fff]/;

async function visibleText(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.innerText || el.textContent || '' : '';
  }, selector);
}

test('快捷键弹框文案跟随界面语言（zh 基线 → en 切换）', async ({ page }) => {
  await page.goto(pathToFileURL(PAGE_PATH).href);
  await expect(page.locator('#editor')).toBeVisible();

  // ── zh-CN 基线 ──
  await page.keyboard.press('Control+3');
  await expect(page.locator('#command-palette')).toBeVisible();
  await expect(page.locator('#palette-input')).toHaveAttribute('placeholder', '输入命令');
  await expect(page.locator('#palette-list')).toContainText('打开文件');
  await page.screenshot({ path: path.join(SHOT_DIR, 'zh-light-palette.png') });
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+Shift+L');
  await expect(page.locator('.key-assist-overlay.open')).toBeVisible();
  await expect(page.locator('#key-assist-title')).toHaveText('快捷键助手');
  await page.screenshot({ path: path.join(SHOT_DIR, 'zh-light-keyassist.png') });
  await page.keyboard.press('Escape');
  await expect(page.locator('.key-assist-overlay.open')).toBeHidden();

  // ── 切英文（与设置页 appearance.language 下拉同一入口 I18n.setLanguage） ──
  await page.evaluate(() => window.I18n.setLanguage('en'));

  // Ctrl+3 命令面板：占位符与命令名（经 Commands.get 动态取词）全英文
  await page.keyboard.press('Control+3');
  await expect(page.locator('#command-palette')).toBeVisible();
  await expect(page.locator('#palette-input')).toHaveAttribute('placeholder', 'Type a command');
  await expect(page.locator('#palette-list')).toContainText('Open File');
  const paletteText = await visibleText(page, '#command-palette');
  expect(paletteText, '命令面板可见文本不应残留中文').not.toMatch(CJK);
  await page.screenshot({ path: path.join(SHOT_DIR, 'en-light-palette.png') });
  await page.keyboard.press('Escape');

  // Ctrl+Shift+L 快捷键助手：标题/占位符/底部提示全英文
  await page.keyboard.press('Control+Shift+L');
  await expect(page.locator('.key-assist-overlay.open')).toBeVisible();
  await expect(page.locator('#key-assist-title')).toHaveText('Key Assist');
  await expect(page.locator('#key-assist-search-input')).toHaveAttribute('placeholder', /Search commands/);
  const assistText = await visibleText(page, '.key-assist-dialog');
  expect(assistText, '快捷键助手可见文本不应残留中文').not.toMatch(CJK);
  await page.screenshot({ path: path.join(SHOT_DIR, 'en-light-keyassist.png') });

  // 打开状态下切回中文：静态 chrome 即时刷新（i18n-changed 监听）
  await page.evaluate(() => window.I18n.setLanguage('zh-CN'));
  await expect(page.locator('#key-assist-title')).toHaveText('快捷键助手');
  await page.keyboard.press('Escape');
  await expect(page.locator('.key-assist-overlay.open')).toBeHidden();

  // Ctrl+E 快速切换标签页（quick-open tabs 模式）：占位符英文
  await page.evaluate(() => window.I18n.setLanguage('en'));
  await page.keyboard.press('Control+E');
  await expect(page.locator('#quick-open')).toBeVisible();
  await expect(page.locator('#quick-open-input')).toHaveAttribute('placeholder', /Quick switch tabs/);
  const quickOpenText = await visibleText(page, '#quick-open');
  expect(quickOpenText, '快速打开可见文本不应残留中文').not.toMatch(CJK);
  await page.screenshot({ path: path.join(SHOT_DIR, 'en-light-quickopen-tabs.png') });
  await page.keyboard.press('Escape');

  // Ctrl+H 全文搜索面板：标题/占位符英文
  await page.keyboard.press('Control+H');
  await expect(page.locator('#search-panel')).toBeVisible();
  await expect(page.locator('#search-panel header strong')).toHaveText('Full-Text Search');
  await expect(page.locator('#search-input')).toHaveAttribute('placeholder', 'Search project');
  const searchText = await visibleText(page, '#search-panel');
  expect(searchText, '搜索面板可见文本不应残留中文').not.toMatch(CJK);
  await page.screenshot({ path: path.join(SHOT_DIR, 'en-light-search.png') });
  await page.keyboard.press('Escape');
});

test('暗色主题下的英文弹框视觉', async ({ page }) => {
  await page.goto(pathToFileURL(PAGE_PATH).href);
  await expect(page.locator('#editor')).toBeVisible();

  await page.evaluate(() => {
    window.I18n.setLanguage('en');
    document.documentElement.setAttribute('data-theme', 'dark');
    try { window.localStorage.setItem('glancemd-ultra-theme', 'dark'); } catch (e) {}
  });

  await page.keyboard.press('Control+Shift+L');
  await expect(page.locator('.key-assist-overlay.open')).toBeVisible();
  await expect(page.locator('#key-assist-title')).toHaveText('Key Assist');
  await page.screenshot({ path: path.join(SHOT_DIR, 'en-dark-keyassist.png') });
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+3');
  await expect(page.locator('#command-palette')).toBeVisible();
  await page.screenshot({ path: path.join(SHOT_DIR, 'en-dark-palette.png') });
  await page.keyboard.press('Escape');
});
