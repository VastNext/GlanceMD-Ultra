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

test.beforeAll(() => {
  pageUrl = ensurePage();
});

test.beforeEach(async ({ page }) => {
  // file:// origin 的 localStorage 在同一 context 内持久；先清空保证初始状态一致
  await page.goto(pageUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('页面加载：标题栏、平台标记与编辑器就绪', async ({ page }) => {
  await expect(page.locator('#titlebar-title')).toHaveText('Untitled');
  await expect(page.locator('body[data-platform="windows"]')).toHaveCount(1);
  await expect(page.locator('#editor')).toBeVisible();
  // 产品脚本就绪：初始化会向 Rust 发送 ready
  const commands = await page.evaluate(() =>
    (window.__ipcLog || []).map((msg) => JSON.parse(msg).command),
  );
  expect(commands).toContain('ready');
});

test('新建 tab：点击 #btn-new 后 tab 栏出现两个 tab 且可切换', async ({ page }) => {
  // 初始只有 1 个 tab，tab 栏隐藏；新建后应有 2 个 tab 元素
  await page.click('#btn-new');
  const tabs = page.locator('#tab-bar .tab');
  await expect(tabs).toHaveCount(2);
  const activeText = await page.locator('#tab-bar .tab.active .tab-label').textContent();
  expect(activeText).toBe('Untitled');

  // 点击第一个 tab 切换回去
  await tabs.first().click();
  await expect(tabs.first()).toHaveClass(/active/);
});

test('主题切换：data-theme 在 light/dark 间往返并持久化', async ({ page }) => {
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-theme', 'light');

  await page.click('#btn-theme');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('glancemd-theme'))).toBe('dark');

  await page.click('#btn-theme');
  await expect(root).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('glancemd-theme'))).toBe('light');

  // 持久化：dark 时 reload，偏好应恢复
  await page.click('#btn-theme');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'dark');
});
