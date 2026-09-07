/* Outline 回归：点击预览标题同时定位编辑器源码与预览标题。 */

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

test('点击 Outline：跳过 YAML frontmatter 与 fenced 伪标题，定位混排标题真实源行', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 768 });
  await page.goto(ensurePage());
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.click('#btn-new');
  const markdown = [
    '---',
    'title: YAML title',
    '---',
    '',
    '~~~md',
    '# fence pseudo',
    '```',
    '## still pseudo',
    '~~~~',
    '',
    '首个 Setext 标题',
    '---',
    '',
    '# 首章',
    '',
    '## 目标标题',
    '',
    '### 后续标题',
  ].join('\n');
  await page.locator('#editor').fill(markdown);
  await page.click('#btn-toggle');
  await expect(page.locator('#preview h1')).toHaveText('首章');
  await expect(page.locator('#preview h2').nth(1)).toHaveText('目标标题');

  await page.click('#btn-toc');
  await page.waitForTimeout(250);
  const items = page.locator('#outline-list .outline-item');
  await expect(items).toHaveCount(4);
  await expect(items.nth(0).locator('.outline-line')).toHaveText('首个 Setext 标题');
  await expect(items.nth(1).locator('.outline-line')).toHaveText('首章');
  await items.nth(2).click();

  await expect(page.locator('#preview h2').nth(1)).toBeInViewport();
  const editorState = await page.locator('#editor').evaluate((editor) => ({
    selected: editor.value.slice(editor.selectionStart, editor.selectionEnd),
    line: editor.value.slice(0, editor.selectionStart).split('\n').length - 1,
  }));
  expect(editorState.selected).toBe('## 目标标题');
  expect(editorState.line).toBe(15);
});
