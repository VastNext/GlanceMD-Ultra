const { execFileSync } = require('node:child_process');
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
});

test('软换行开启与关闭下连续三次 Ctrl+L 46 均精确对齐目标行', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.focus();

  // 构造含长中文软换行的 60 行文档，第 46 行带明确标记
  const text = Array.from({ length: 60 }, (_, i) => {
    const lineNum = i + 1;
    if (lineNum === 46) {
      return '【逻辑第46行】这是一段非常重要的标记行，包含目标锚点。';
    }
    if (lineNum % 5 === 0) {
      return `第${lineNum}行 这是一段超长的中文段落用来强制产生浏览器的软换行效果，文字很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长。`;
    }
    return `第${lineNum}行 普通测试内容`;
  }).join('\n');

  await editor.fill(text);

  // 1. 软换行开启下连续三次跳转 46 行
  for (let round = 1; round <= 3; round++) {
    await page.keyboard.press('Control+l');
    const gotoBar = page.locator('#goto-bar');
    await expect(gotoBar).toBeVisible();
    const input = page.locator('#goto-input');
    await input.fill('46');
    await input.press('Enter');
    await expect(gotoBar).toBeHidden();

    const currentLine = await editor.evaluate((el) => {
      return el.value.slice(0, el.selectionStart).split('\n').length;
    });
    expect(currentLine).toBe(46);

    const selectedText = await editor.evaluate((el) => {
      const lineStart = el.value.lastIndexOf('\n', el.selectionStart - 1) + 1;
      const lineEnd = el.value.indexOf('\n', el.selectionStart);
      return el.value.slice(lineStart, lineEnd === -1 ? el.value.length : lineEnd);
    });
    expect(selectedText).toContain('【逻辑第46行】');
  }

  // 截图验证软换行开启下的行号与正文对齐
  await page.screenshot({ path: path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07', 'goto-line-46-wrap-on.png') });

  // 2. 关闭软换行再次跳转 46 行（验证行号槽已正确收缩并对齐）
  await page.keyboard.press('Alt+Shift+y');
  await page.keyboard.press('Control+l');
  const input2 = page.locator('#goto-input');
  await input2.fill('46');
  await input2.press('Enter');

  const currentLineOff = await editor.evaluate((el) => {
    return el.value.slice(0, el.selectionStart).split('\n').length;
  });
  expect(currentLineOff).toBe(46);

  await page.screenshot({ path: path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07', 'goto-line-46-wrap-off.png') });
});

test('查找交互：Enter 保持搜索框焦点，Ctrl+K 定位匹配并聚焦编辑器', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.fill('first tool in line\nsecond tool in text\nthird tool at end');
  await editor.focus();

  // 选中 "tool" 并按 Ctrl+F
  await editor.evaluate((el) => el.setSelectionRange(6, 10));
  await page.keyboard.press('Control+f');

  const findInput = page.locator('#find-input');
  await expect(findInput).toBeFocused();
  await expect(findInput).toHaveValue('tool');

  // 回车查找下一个，焦点仍停留在搜索输入框
  await findInput.press('Enter');
  await expect(findInput).toBeFocused();

  // 按 Ctrl+K：查找下一个并直接聚焦编辑器中的匹配项
  await page.keyboard.press('Control+k');
  await expect(editor).toBeFocused();

  const activeSelection = await editor.evaluate((el) => {
    return el.value.slice(el.selectionStart, el.selectionEnd);
  });
  expect(activeSelection).toBe('tool');

  // 再次按 Ctrl+F：焦点回到搜索框且光标在词尾
  await page.keyboard.press('Control+f');
  await expect(findInput).toBeFocused();

  // 按 Esc：关闭查找栏，焦点回到编辑器最后匹配处
  await page.keyboard.press('Escape');
  const findBar = page.locator('#find-bar');
  await expect(findBar).toBeHidden();
  await expect(editor).toBeFocused();
});

test('非 Vim 模式下存在可见 3px 自定义光标且输入跟随', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.focus();

  const caret = page.locator('#custom-caret');
  await expect(caret).toBeVisible();

  const width = await caret.evaluate((el) => parseFloat(window.getComputedStyle(el).width));
  expect(width).toBeGreaterThanOrEqual(2.5);

  // 输入文字后光标位置应改变且保持可见
  const beforeLeft = await caret.evaluate((el) => parseFloat(el.style.left || '0'));
  await editor.type('Hello GlanceMD');
  const afterLeft = await caret.evaluate((el) => parseFloat(el.style.left || '0'));
  expect(afterLeft).toBeGreaterThan(beforeLeft);

  // 截图验证亮色与暗色模式下的可见光标
  await page.screenshot({ path: path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07', 'non-vim-caret-light.png') });
  await page.click('#btn-theme');
  await page.screenshot({ path: path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07', 'non-vim-caret-dark.png') });
});

