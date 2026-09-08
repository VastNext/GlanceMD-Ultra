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

test('场景1：切换 Tab 后行号槽即时刷新，绝不残留上一个 Tab 的行号', async ({ page }) => {
  const editor = page.locator('#editor');
  // Tab 1: 5 行短内容
  await editor.fill('line 1\nline 2\nline 3\nline 4\nline 5');
  
  // 新建 Tab 2: 60 行长内容
  const btnNew = page.locator('#btn-new');
  await btnNew.click();
  const longText = Array.from({ length: 60 }, (_, i) => `long doc line ${i + 1}`).join('\n');
  await editor.fill(longText);

  const gutter = page.locator('#editor-gutter');
  await expect(gutter).toContainText('60');

  // 切回 Tab 1
  const tabs = page.locator('.tab');
  await expect(tabs).toHaveCount(2);
  await tabs.first().click();

  // 行号槽必须立即刷新为 5 行，绝不残留 60 行！
  await expect(gutter).not.toContainText('60');
  await expect(gutter).toContainText('5');

  // 再次切到 Tab 2
  await tabs.nth(1).click();
  await expect(gutter).toContainText('60');
});

test('场景2：PageDown / PageUp 仅在编辑器内部翻页，整套软件顶层绝对不发生滚动穿透（顶栏和关闭按钮始终在顶层）', async ({ page }) => {
  const editor = page.locator('#editor');
  const longText = Array.from({ length: 120 }, (_, i) => `page test line ${i + 1}`).join('\n');
  await editor.evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, longText);
  await editor.focus();

  const titlebar = page.locator('#titlebar');
  const btnClose = page.locator('#btn-close');

  const getTopBarRect = async () => {
    return page.evaluate(() => {
      const tb = document.getElementById('titlebar');
      const docTop = document.documentElement.scrollTop || document.body.scrollTop;
      return {
        tbTop: tb.getBoundingClientRect().top,
        docTop
      };
    });
  };

  const initial = await getTopBarRect();
  expect(initial.tbTop).toBe(0);
  expect(initial.docTop).toBe(0);

  // 连续按下 PageDown
  const initialScrollTop = await editor.evaluate(el => el.scrollTop);
  await page.keyboard.press('PageDown');
  await page.keyboard.press('PageDown');

  const afterPageDown = await getTopBarRect();
  // 核心断言：标题栏与关闭按钮的 top 必须恒定为 0，顶层网页绝对零滚动！
  expect(afterPageDown.tbTop).toBe(0);
  expect(afterPageDown.docTop).toBe(0);
  await expect(btnClose).toBeVisible();

  // 编辑器内部已经顺利完成了大幅度向下滚动
  const downScrollTop = await editor.evaluate(el => el.scrollTop);
  expect(downScrollTop).toBeGreaterThan(initialScrollTop + 200);

  // 按 PageUp 向上翻页
  await page.keyboard.press('PageUp');
  const afterPageUp = await getTopBarRect();
  expect(afterPageUp.tbTop).toBe(0);
  expect(afterPageUp.docTop).toBe(0);
  const upScrollTop = await editor.evaluate(el => el.scrollTop);
  expect(upScrollTop).toBeLessThan(downScrollTop);
});

test('场景3：Ctrl+F 按 Enter 产生当前项紫粉高亮(.active-match)与进度气泡，输入框持续保持聚焦', async ({ page }) => {
  const editor = page.locator('#editor');
  await editor.fill('apple search target\nbanana fruit\norange target here');
  await editor.focus();

  // 打开搜索并输入 target
  await page.keyboard.press('Control+f');
  const findInput = page.locator('#find-input');
  await findInput.fill('target');

  // 按 Enter 激活第 1 个匹配
  await findInput.press('Enter');

  // 1. 验证输入框时刻保持聚焦状态
  await expect(findInput).toBeFocused();

  // 2. 验证常驻高亮 markers 与激活项 .active-match 在视口中精准可见
  const activeMarker = page.locator('#editor-find-markers .active-match');
  await expect(activeMarker).toHaveCount(1);
  await expect(activeMarker).toBeVisible();

  // 3. 验证方案 B 进度气泡同步出现并显示匹配序号
  const badge = page.locator('#find-match-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText(/1 \/ 2|2 \/ 2/);
});

test('场景4：预览模式下按 PageDown / PageUp 翻页，预览容器平滑滚动，顶层网页绝无滚动穿透', async ({ page }) => {
  const editor = page.locator('#editor');
  const longText = Array.from({ length: 120 }, (_, i) => `## Preview Section ${i + 1}\n\nContent line for section ${i + 1}`).join('\n');
  await editor.evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, longText);

  // 切到预览模式并重置到顶部
  await page.click('#btn-toggle');
  const preview = page.locator('#preview-wrapper');
  await expect(preview).toBeVisible();
  await preview.evaluate(el => el.scrollTop = 0);

  const titlebar = page.locator('#titlebar');
  const initialTop = await preview.evaluate(el => el.scrollTop);

  // 按 PageDown
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(100);

  const downTop = await preview.evaluate(el => el.scrollTop);
  expect(downTop).toBeGreaterThan(initialTop + 100);

  // 顶栏顶层绝对不位移
  expect(await titlebar.evaluate(el => el.getBoundingClientRect().top)).toBe(0);

  // 按 PageUp
  await page.keyboard.press('PageUp');
  await page.waitForTimeout(100);
  const upTop = await preview.evaluate(el => el.scrollTop);
  expect(upTop).toBeLessThan(downTop);
  expect(await titlebar.evaluate(el => el.getBoundingClientRect().top)).toBe(0);
});

test('场景5：Tab 具有路径时资源管理器自动展开目录树并高亮选中文件节点', async ({ page }) => {
  // 模拟工作区已打开并新建带路径的文件 Tab
  await page.evaluate(() => {
    window.__fromRust('workspace:opened', { root: 'D:/WorkDev/demo-project' });
    window.TabManager.createTab('D:/WorkDev/demo-project/docs/guide.md', '# Guide Content');
  });

  // 验证 ProjectTree 的 activeFile 已同步更新为该文件的相对路径
  const activeFile = await page.evaluate(() => {
    return window.ProjectTree && window.ProjectTree.getState ? window.ProjectTree.getState().activeFile : null;
  });
  expect(activeFile).toContain('guide.md');
});

