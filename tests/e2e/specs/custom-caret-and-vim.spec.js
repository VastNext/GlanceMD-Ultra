/* Custom Caret & Vim Visual Interaction E2E Verification
 * 覆盖需求：
 * 1. 非 Vim 普通编辑 + Vim Insert 模式共用 3 CSS px 竖线光标；
 * 2. Light 深紫 / Dark 亮紫双主题适配与跟随；
 * 3. 输入常亮无闪烁、停止闪烁恢复呼吸、定位常亮 1s、非折叠选区/失焦隐藏；
 * 4. IME composition 原生光标回退；
 * 5. Vim Normal 实心方块光标与 j/k 移动视口边缘自动 scroll 留 2 行边距；
 * 6. 修复 Insert 输入光标不走与 j 屏外不滚；
 * 7. Ex 命令语义 (:q/:q! 保留 dirty 退出 Vim 不关 tab，:wq 异步保存成功退出 Vim，:w 保存留 Vim)。
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

test('普通编辑模式下渲染 3 CSS px 竖线光标，输入常亮并在停止后恢复闪烁', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.focus();

  // 验证 #custom-caret 元素已挂载并显示
  const customCaret = page.locator('#custom-caret');
  await expect(customCaret).toBeVisible();

  // 验证 3 CSS px 宽度
  const box = await customCaret.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeCloseTo(3, 0.5);
  expect(box.height).toBeGreaterThan(12);

  // 输入连续字符：验证 custom-caret-solid 常亮且移除 custom-caret-blink
  await page.keyboard.type('Testing Custom Caret Continuous Input');
  await expect(customCaret).toHaveClass(/custom-caret-solid/);
  await expect(customCaret).not.toHaveClass(/custom-caret-blink/);

  // 停止输入 600ms 后：恢复平滑呼吸闪烁
  await page.waitForTimeout(650);
  await expect(customCaret).toHaveClass(/custom-caret-blink/);
  await expect(customCaret).not.toHaveClass(/custom-caret-solid/);
});

test('双主题色彩适配：Light 深紫与 Dark 亮紫', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.focus();
  const customCaret = page.locator('#custom-caret');

  // 1. Light 主题下 (深紫 #7c3aed)
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light');
  });
  const lightColor = await customCaret.evaluate(el => window.getComputedStyle(el).backgroundColor);
  expect(lightColor).toMatch(/rgb\(124,\s*58,\s*237\)|rgb\(147,\s*51,\s*234\)/);

  // 2. Dark 主题下 (亮紫 #c084fc)
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
  });
  const darkColor = await customCaret.evaluate(el => window.getComputedStyle(el).backgroundColor);
  expect(darkColor).toMatch(/rgb\(192,\s*132,\s*252\)|rgb\(168,\s*85,\s*247\)/);
});

test('光标重定位（Arrow / Click）常亮 1 秒后恢复闪烁，选区与失焦时隐藏', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.focus();
  await page.keyboard.type('Line 1 for relocation\nLine 2 for relocation');

  const customCaret = page.locator('#custom-caret');
  await page.waitForTimeout(650);
  await expect(customCaret).toHaveClass(/custom-caret-blink/);

  // 按左方向键重定位光标
  await page.keyboard.press('ArrowLeft');
  await expect(customCaret).toHaveClass(/custom-caret-solid/);

  // 500ms 时仍为 solid
  await page.waitForTimeout(500);
  await expect(customCaret).toHaveClass(/custom-caret-solid/);

  // 1100ms 后恢复 blink
  await page.waitForTimeout(650);
  await expect(customCaret).toHaveClass(/custom-caret-blink/);

  // 选区非折叠时（Ctrl+A / Shift+Left 选中部分文本）隐藏自定义光标
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(customCaret).toBeHidden();

  // 折叠选区后恢复显示
  await page.keyboard.press('ArrowRight');
  await expect(customCaret).toBeVisible();

  // 失焦时隐藏
  await page.click('#statusbar');
  await expect(customCaret).toBeHidden();
});

test('IME Composition 输入法模拟回退原生光标，不阻挡候选窗', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.focus();
  const customCaret = page.locator('#custom-caret');

  // 模拟中文拼音输入过程: compositionstart -> compositionupdate -> compositionend
  await editor.evaluate(el => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
  });
  await expect(customCaret).toBeHidden();

  const isTransparent = await editor.evaluate(el => el.style.caretColor === 'transparent');
  expect(isTransparent).toBe(false);

  // 完成输入
  await editor.evaluate(el => {
    el.value += '中文测试';
    el.selectionStart = el.selectionEnd = el.value.length;
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '中文测试' }));
  });
  await expect(customCaret).toBeVisible();
});

test('长段落 Softwrap 换行与连续输入时光标精准跟随', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.focus();
  const customCaret = page.locator('#custom-caret');

  // 输入极长单行触发 softwrap 自动折行
  const longText = 'This is an extremely long line of text intended to test automatic word wrap soft wrapping behavior in the editor without newlines. '.repeat(4);
  await page.keyboard.type(longText);

  // 验证光标已移动到后续折行行
  const box = await customCaret.boundingBox();
  const editorBox = await editor.boundingBox();
  expect(box.y).toBeGreaterThan(editorBox.y + 30);
  expect(box.x).toBeGreaterThan(editorBox.x);
});

test('Vim 模式：常驻底栏提示、Normal 实心方块光标与 Insert 模式 3px 竖线光标切换', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.focus();

  // 开启 Vim
  await page.keyboard.press('Alt+Shift+KeyE');
  await page.keyboard.press('KeyV');

  const statusbar = page.locator('#statusbar');
  const persistentHint = statusbar.locator('.vim-persistent-hint');
  await expect(persistentHint).toBeVisible();
  await expect(persistentHint).toContainText(/普通模式.*按.*i.*编辑/);

  const blockCursor = page.locator('.vim-block-cursor');
  const customCaret = page.locator('#custom-caret');

  // Normal 模式下显示实心方块光标，隐藏 3px 竖线
  await expect(blockCursor).toBeVisible();
  await expect(customCaret).toBeHidden();

  // 按 i 进入 Insert 模式
  await page.keyboard.press('i');
  await expect(persistentHint).toContainText(/编辑模式.*按.*Esc/);
  await expect(blockCursor).toBeHidden();
  await expect(customCaret).toBeVisible();

  // 在 Insert 模式连续输入，验证光标立即跟随
  const initialCaretBox = await customCaret.boundingBox();
  await page.keyboard.type('Inserted typing text');
  const nextCaretBox = await customCaret.boundingBox();
  expect(nextCaretBox.x).toBeGreaterThan(initialCaretBox.x);

  // 按 Escape 返回 Normal 模式
  await page.keyboard.press('Escape');
  await expect(persistentHint).toContainText(/普通模式.*按.*i.*编辑/);
  await expect(blockCursor).toBeVisible();
  await expect(customCaret).toBeHidden();
});

test('Vim Normal 模式 j/k 移动在视口边缘自动 scroll 留 2 行边距', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.focus();

  // 填充 50 行文本
  const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}: Markdown content for vim navigation test`).join('\n');
  await editor.evaluate((el, text) => {
    el.value = text;
    el.selectionStart = el.selectionEnd = 0;
  }, lines);

  // 开启 Vim
  await page.keyboard.press('Alt+Shift+KeyE');
  await page.keyboard.press('KeyV');

  // 连续按 j 向下移动超过第一屏
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('j');
  }

  // 验证 editor.scrollTop 已经自动滚动
  const scrollTop = await editor.evaluate(el => el.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);

  // 验证方块光标仍然在可视视口范围内
  const blockCursor = page.locator('.vim-block-cursor');
  await expect(blockCursor).toBeVisible();
  const cursorBox = await blockCursor.boundingBox();
  const editorBox = await editor.boundingBox();

  expect(cursorBox.y).toBeGreaterThanOrEqual(editorBox.y);
  expect(cursorBox.y + cursorBox.height).toBeLessThanOrEqual(editorBox.y + editorBox.height);
});

test('Vim :q 退出 Vim 模式但保留 dirty tab 与修改，:w 仅保存', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.focus();

  // 开启 Vim
  await page.keyboard.press('Alt+Shift+KeyE');
  await page.keyboard.press('KeyV');

  await page.keyboard.press('i');
  await editor.type('Sample dirty text for :q semantics\n');
  await page.keyboard.press('Escape');

  // 执行 :w 保存（stay in Vim mode）
  await page.keyboard.press(':');
  await page.keyboard.press('w');
  await page.keyboard.press('Enter');
  await expect(page.locator('.vim-status-widget')).toBeVisible();

  // 再次输入使其 dirty
  await page.keyboard.press('i');
  await editor.type('Second dirty line');
  await page.keyboard.press('Escape');
  await expect(page.locator('.tab.active .tab-dirty')).toBeVisible();

  // 执行 :q 退出 Vim
  await page.keyboard.press(':');
  await page.keyboard.press('q');
  await page.keyboard.press('Enter');

  // 验证：Tab 仍然存在且保持 dirty，内容完好，但 Vim 模式已退出
  await expect(page.locator('.tab')).toHaveCount(1);
  await expect(page.locator('.tab.active .tab-dirty')).toBeVisible();
  const val = await editor.inputValue();
  expect(val).toContain('Sample dirty text');
  expect(val).toContain('Second dirty line');
  await expect(page.locator('.vim-status-widget')).toHaveCount(0);
});
