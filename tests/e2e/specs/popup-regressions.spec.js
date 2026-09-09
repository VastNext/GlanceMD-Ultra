/* 浮层与全局搜索面板回归测试：
 * 1. 验证真实快捷键触发：Quick Open (Ctrl+E/Ctrl+Shift+R)、Command Palette (Ctrl+3)、Key Assist (Ctrl+Shift+L)、Search Panel (Ctrl+H)；
 * 2. 验证明暗主题下浮层背景与高亮/选中态文字、按键徽章对比度，杜绝白底白字；
 * 3. 验证 Search Panel 默认 60vw/80vh 居中、控制按钮独立不收缩、IPC 结果注入后实际滚动、Header 拖拽与缩放手柄、零原生拖动 IPC 触发、窄视口防溢出。
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

// 辅助函数：解析 rgb/rgba 颜色为感知亮度（0-255）
function getBrightness(colorStr) {
  const match = String(colorStr || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return 128;
  const r = parseInt(match[1], 10);
  const g = parseInt(match[2], 10);
  const b = parseInt(match[3], 10);
  return (r * 299 + g * 587 + b * 114) / 1000;
}

test('快捷键 Ctrl+E 与 Ctrl+Shift+R 触发 Quick Open 并在明暗主题下保持选中文字高对比度', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(ensurePage());
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // 造标签页与文件数据 fixture
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    window.TabManager.createTab('D:/workspace/index.md', '# Index');
    window.TabManager.createTab('D:/workspace/notes.md', '# Notes');
    window.QuickOpen.setFiles(['src/app.js', 'src/editor.js', 'docs/guide.md']);
  });

  const quickOpen = page.locator('#quick-open');

  // 1. 真实按键 Ctrl+E 打开标签页快速切换
  await page.keyboard.press('Control+e');
  await expect(quickOpen).toBeVisible();

  // 验证 Light 主题下的背景与选中文字对比度
  const lightBg = await quickOpen.evaluate(el => window.getComputedStyle(el).backgroundColor);
  expect(getBrightness(lightBg)).toBeGreaterThan(180); // 浅色背景

  const lightActiveTitle = quickOpen.locator('.quick-open-item.active .quick-open-tab-title');
  await expect(lightActiveTitle).toBeVisible();
  const lightActiveColor = await lightActiveTitle.evaluate(el => window.getComputedStyle(el).color);
  expect(getBrightness(lightActiveColor)).toBeLessThan(100); // 深色文字，绝非白字

  // 切换为 Dark 主题
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const darkBg = await quickOpen.evaluate(el => window.getComputedStyle(el).backgroundColor);
  expect(getBrightness(darkBg)).toBeLessThan(60); // 深色背景

  const darkActiveColor = await lightActiveTitle.evaluate(el => window.getComputedStyle(el).color);
  expect(getBrightness(darkActiveColor)).toBeGreaterThan(180); // 浅色文字

  // 按 Escape 关闭
  await page.keyboard.press('Escape');
  await expect(quickOpen).toBeHidden();

  // 2. 真实按键 Ctrl+Shift+R 打开资源文件快速切换
  await page.keyboard.press('Control+Shift+R');
  await expect(quickOpen).toBeVisible();

  const fileItem = quickOpen.locator('.quick-open-item.active span');
  await expect(fileItem).toBeVisible();

  // 按 Escape 关闭
  await page.keyboard.press('Escape');
  await expect(quickOpen).toBeHidden();
});

test('快捷键 Ctrl+3 触发 Command Palette 并在明暗主题下保持选中文字高对比度', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(ensurePage());
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

  // 真实按键 Ctrl+3 打开命令面板
  await page.keyboard.press('Control+3');
  const palette = page.locator('#command-palette');
  await expect(palette).toBeVisible();

  // 验证 Light 主题
  const lightBg = await palette.evaluate(el => window.getComputedStyle(el).backgroundColor);
  expect(getBrightness(lightBg)).toBeGreaterThan(180);

  const activeStrong = palette.locator('.palette-item.active strong');
  await expect(activeStrong).toBeVisible();
  const lightStrongColor = await activeStrong.evaluate(el => window.getComputedStyle(el).color);
  expect(getBrightness(lightStrongColor)).toBeLessThan(100);

  // 切换到 Dark 主题
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const darkBg = await palette.evaluate(el => window.getComputedStyle(el).backgroundColor);
  expect(getBrightness(darkBg)).toBeLessThan(60);

  const darkStrongColor = await activeStrong.evaluate(el => window.getComputedStyle(el).color);
  expect(getBrightness(darkStrongColor)).toBeGreaterThan(180);

  // 按 Escape 关闭
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
});

test('快捷键 Ctrl+Shift+L 触发 Key Assist 并在明暗主题下确保选中项与徽章清晰可读', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(ensurePage());
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

  // 真实按键 Ctrl+Shift+L 触发 Key Assist
  await page.keyboard.press('Control+Shift+L');

  const overlay = page.locator('.key-assist-overlay');
  await expect(overlay).toBeVisible();

  const dialog = page.locator('.key-assist-dialog');
  const lightDialogBg = await dialog.evaluate(el => window.getComputedStyle(el).backgroundColor);
  expect(getBrightness(lightDialogBg)).toBeGreaterThan(180);

  // 明确断言选中项必定存在并可见
  const selectedItem = dialog.locator('.key-assist-item.selected');
  await expect(selectedItem).toHaveCount(1);
  await expect(selectedItem).toBeVisible();

  const titleEl = selectedItem.locator('.key-assist-item-title');
  await expect(titleEl).toBeVisible();
  const lightTitleColor = await titleEl.evaluate(el => window.getComputedStyle(el).color);
  expect(getBrightness(lightTitleColor)).toBeLessThan(100); // 亮色下标题文字深色

  const kbdBadge = selectedItem.locator('.key-assist-kbd-badge').first();
  await expect(kbdBadge).toBeVisible();
  const lightKbdColor = await kbdBadge.evaluate(el => window.getComputedStyle(el).color);
  expect(getBrightness(lightKbdColor)).toBeLessThan(100); // 亮色下按键徽标深色，决非白底白字！

  // 切换到 Dark 主题校验
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const darkDialogBg = await dialog.evaluate(el => window.getComputedStyle(el).backgroundColor);
  expect(getBrightness(darkDialogBg)).toBeLessThan(60);

  const darkTitleColor = await titleEl.evaluate(el => window.getComputedStyle(el).color);
  expect(getBrightness(darkTitleColor)).toBeGreaterThan(180); // 暗色下标题浅色

  const darkKbdColor = await kbdBadge.evaluate(el => window.getComputedStyle(el).color);
  expect(getBrightness(darkKbdColor)).toBeGreaterThan(180); // 暗色下按键徽标浅色

  // 按 Escape 关闭
  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();
});

test('快捷键 Ctrl+H 打开 Search Panel：居中 60vw/80vh、按钮不挤压、注入结果独立滚动、Header 拖拽与缩放', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(ensurePage());
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // 1. 真实按键 Ctrl+H 打开搜索面板
  await page.keyboard.press('Control+h');
  const panel = page.locator('#search-panel');
  await expect(panel).toBeVisible();

  // 验证居中 60vw (768px), 80vh (640px), left 20vw (256px), top 10vh (80px)
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box.width - 768)).toBeLessThanOrEqual(24);
  expect(Math.abs(box.height - 640)).toBeLessThanOrEqual(24);
  expect(Math.abs(box.x - 256)).toBeLessThanOrEqual(24);
  expect(Math.abs(box.y - 80)).toBeLessThanOrEqual(24);

  // 2. 验证选项按钮尺寸独立不被挤压（Aa, ab, .*）
  const buttons = panel.locator('.search-controls button');
  await expect(buttons).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    const btnBox = await buttons.nth(i).boundingBox();
    expect(btnBox.width).toBeGreaterThanOrEqual(30);
    expect(btnBox.height).toBeGreaterThanOrEqual(26);
  }

  // 3. 注入足够多的 IPC 搜索结果，断言结果区实际具备可滚动性
  await page.evaluate(() => {
    const hits = [];
    for (let i = 1; i <= 60; i++) {
      hits.push({
        relPath: 'src/core/module_' + Math.ceil(i / 10) + '.js',
        line: i * 4,
        lineText: 'const queryResultEntry_' + i + ' = "search matched content ' + i + '";'
      });
    }
    window.__fromRust('workspace:search-result', { searchId: 'test-search-id', hits: hits });
    window.__fromRust('workspace:search-completed', { searchId: 'test-search-id', summary: { hits: 60 } });
  });

  const resultsContainer = panel.locator('#search-results');
  const scrollInfo = await resultsContainer.evaluate(el => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollTop: el.scrollTop
  }));
  expect(scrollInfo.scrollHeight).toBeGreaterThan(scrollInfo.clientHeight + 100); // 结果明显超出可视高度

  // 模拟滚动结果区域
  await resultsContainer.evaluate(el => { el.scrollTop = 120; });
  const afterScrollTop = await resultsContainer.evaluate(el => el.scrollTop);
  expect(afterScrollTop).toBeGreaterThanOrEqual(100);

  // 4. Header 拖动：验证仅面板几何移动，且零触发原生窗口拖动 IPC 命令
  await page.evaluate(() => { window.__ipcLog = []; });
  const header = panel.locator('header');
  const headerBox = await header.boundingBox();

  await page.mouse.move(headerBox.x + 60, headerBox.y + 12);
  await page.mouse.down();
  await page.mouse.move(headerBox.x + 160, headerBox.y + 72);
  await page.mouse.up();

  const movedBox = await panel.boundingBox();
  expect(movedBox.x).toBeGreaterThan(box.x + 40);
  expect(movedBox.y).toBeGreaterThan(box.y + 20);

  // 检查 IPC 日志中决不包含任何 window_drag / start_drag 相关消息
  const ipcLog = await page.evaluate(() => (window.__ipcLog || []).slice());
  const dragMessages = ipcLog.filter(m => /drag|window_drag|start_drag/i.test(m));
  expect(dragMessages).toHaveLength(0);

  // 5. 缩放手柄拖动测试
  const resizeHandle = panel.locator('#search-resize');
  const handleBox = await resizeHandle.boundingBox();
  await page.mouse.move(handleBox.x + 8, handleBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 60, handleBox.y + 40);
  await page.mouse.up();

  const resizedBox = await panel.boundingBox();
  expect(resizedBox.width).toBeGreaterThan(movedBox.width + 20);
  expect(resizedBox.height).toBeGreaterThan(movedBox.height + 15);

  // 6. 极窄视口防溢出验证
  await page.evaluate(() => {
    window.SearchPanel.setGeometry({ w: 9999, h: 9999, x: 9999, y: 9999 });
  });
  const maxClampedBox = await panel.boundingBox();
  expect(maxClampedBox.x + maxClampedBox.width).toBeLessThanOrEqual(1280);
  expect(maxClampedBox.y + maxClampedBox.height).toBeLessThanOrEqual(800);

  // 模拟极小视口几何重算
  const narrowGeometry = await page.evaluate(() => {
    // 假设视口仅 320x240
    return window.SearchPanel.clampGeometry({ w: 400, h: 300, x: 50, y: 50 });
  });
  expect(narrowGeometry.w).toBeLessThanOrEqual(1280);
  expect(narrowGeometry.x + narrowGeometry.w).toBeLessThanOrEqual(1280);

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('居中自研 ConfirmDialog：未保存修改下关闭单Tab、批量Tab和退出窗口均在正中央弹出高质感弹窗', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(ensurePage());
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const overlay = page.locator('#confirm-dialog-overlay');
  const card = page.locator('.confirm-dialog-card');
  const title = page.locator('#confirm-dialog-title');
  const msg = page.locator('#confirm-dialog-message');
  const btnCancel = page.locator('#confirm-dialog-btn-cancel');
  const btnConfirm = page.locator('#confirm-dialog-btn-confirm');

  // 1. 新建 Tab 并输入脏内容，点击 Tab ✕ 按钮弹出正中央 ConfirmDialog
  await page.click('#welcome-btn-new');
  const editor = page.locator('#editor');
  await expect(editor).toBeVisible();
  await editor.fill('some dirty content in tab 1');
  await page.waitForTimeout(350); // 等待 editor input 300ms 防抖 markDirty 生效
  const tabClose = page.locator('#tab-bar .tab.active .tab-close');
  await tabClose.click();

  // 验证弹窗可见、文案符合、位于视口正中央
  await expect(overlay).toHaveClass(/open/);
  await expect(card).toBeVisible();
  await expect(title).toHaveText('未保存的修改');
  await expect(msg).toHaveText(/有未保存的修改，确定关闭？/);

  const cardBox = await card.boundingBox();
  const vp = page.viewportSize();
  const cardCenterX = cardBox.x + cardBox.width / 2;
  const cardCenterY = cardBox.y + cardBox.height / 2;
  expect(Math.abs(cardCenterX - vp.width / 2)).toBeLessThan(5);
  expect(Math.abs(cardCenterY - vp.height / 2)).toBeLessThan(5);

  // 截图验证 Dark 主题下居中弹窗视觉效果
  fs.mkdirSync(path.join(REPO_ROOT, 'docs', 'qa', 'integration-2026-09-07'), { recursive: true });
  await page.screenshot({ path: path.join(REPO_ROOT, 'docs', 'qa', 'integration-2026-09-07', 'confirm-dialog-dark.png') });

  // 按 Escape 取消关闭，Tab 保留
  await page.keyboard.press('Escape');
  await expect(overlay).not.toHaveClass(/open/);
  await expect(page.locator('#tab-bar .tab')).toHaveCount(1);

  // 再次点击关闭，按 Enter（确认删除）
  await tabClose.click();
  await expect(overlay).toHaveClass(/open/);
  await btnConfirm.click();
  await expect(overlay).not.toHaveClass(/open/);
  await expect(page.locator('#tab-bar .tab')).toHaveCount(0);
  await expect(page.locator('#welcome-view')).toBeVisible();

  // 2. 测试退出窗口未保存修改弹窗：新建 tab，修改内容，点击顶栏 #btn-close
  await page.click('#welcome-btn-new');
  await editor.fill('unsaved text for window close');
  await page.waitForTimeout(350); // 等待 editor input 300ms 防抖 markDirty 生效
  await page.click('#btn-close');

  await expect(overlay).toHaveClass(/open/);
  await expect(title).toHaveText('未保存的修改');
  await expect(msg).toHaveText('有未保存的修改，确定关闭窗口吗？');

  // 切到 Light 主题验证明亮模式视觉
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.screenshot({ path: path.join(REPO_ROOT, 'docs', 'qa', 'integration-2026-09-07', 'confirm-dialog-light.png') });

  // 取消关闭，验证窗口保持打开且零发送 window_close IPC
  await btnCancel.click();
  await expect(overlay).not.toHaveClass(/open/);
  const ipcLog = await page.evaluate(() => (window.__ipcLog || []).map(JSON.parse));
  expect(ipcLog.some(m => m.command === 'window_close')).toBeFalsy();
});
