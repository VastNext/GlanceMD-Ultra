const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('playwright/test');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = path.join(ROOT, 'tests', '.tmp', 'index.html');
function pageUrl() {
  if (!fs.existsSync(PAGE)) execFileSync('python', [path.join(ROOT, 'tools', 'build_test_page.py')], { cwd: ROOT, stdio: 'pipe' });
  return pathToFileURL(PAGE).href;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 768 });
  await page.goto(pageUrl());
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const btnNew = page.locator('#btn-new');
  await btnNew.waitFor({ state: 'visible' });
  await btnNew.click();
});

test('Ctrl+F searches selected text in the editor and keeps find inline', async ({ page }) => {
  const editor = page.locator('#editor');
  await editor.fill('first line\nneedle in the middle\nlast line');
  await editor.evaluate(el => {
    el.selectionStart = el.value.indexOf('needle in the middle');
    el.selectionEnd = el.selectionStart + 'needle in the middle'.length;
  });
  await page.keyboard.press('Control+f');
  await expect(page.locator('#find-bar')).toBeVisible();
  await expect(page.locator('#find-bar')).toHaveCSS('position', 'absolute');
  await expect(page.locator('#find-input')).toHaveValue('needle in the middle');
  await page.locator('html').evaluate(el => el.setAttribute('data-theme', 'dark'));
  await page.screenshot({ path: path.join(ROOT, 'tests', '.tmp', 'editor-navigation-dark.png'), fullPage: true });
  await page.locator('html').evaluate((el) => el.setAttribute('data-theme', 'light'));
  await page.screenshot({ path: path.join(ROOT, 'tests', '.tmp', 'editor-navigation-light.png'), fullPage: true });
});

test('Ctrl+L accepts an exact logical line and selects it', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.fill('one\ntwo\nthree\nfour');
  await editor.focus();
  await page.keyboard.press('Control+l');
  const input = page.locator('#goto-input');
  await expect(input).toBeVisible();
  await input.fill('3');
  await input.press('Enter');
  await expect(editor).toHaveValue('one\ntwo\nthree\nfour');
  expect(await editor.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('three');
});

test('Vim enters with current tab cursor and keeps a resident status hint', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  await editor.fill('top\n'.repeat(30) + 'current line');
  await editor.focus();
  await editor.evaluate(el => { el.selectionStart = el.selectionEnd = el.value.length - 5; el.scrollTop = 240; });
  await page.keyboard.press('Alt+Shift+e');
  await page.keyboard.press('v');
  await expect(page.locator('#statusbar .vim-status-widget')).toBeVisible();
  await expect(page.locator('.vim-enabled-hint')).toContainText('普通模式');
  expect(await editor.inputValue()).toContain('current line');
  expect(await editor.evaluate(el => el.selectionStart)).toBe(('top\n'.repeat(30) + 'current line').length - 5);
});

async function selectionVisible(editor) {
  return editor.evaluate(el => {
    const top = EditorNavigation.measureOffsetTop(el.selectionStart) - el.scrollTop;
    return top >= 0 && top + parseFloat(getComputedStyle(el).lineHeight) <= el.clientHeight;
  });
}

test('Ctrl+L 31 repeated three times selects a visible logical line after long Chinese soft wraps', async ({ page }) => {
  await page.click('#btn-new');
  const editor = page.locator('#editor');
  const lines = Array.from({ length: 80 }, (_, i) => `${i + 1} 中文软换行` + '宽字符内容'.repeat(i % 4 === 0 ? 100 : 2));
  await editor.evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, lines.join('\n'));
  for (let i = 0; i < 3; i++) {
    await editor.focus();
    await page.keyboard.press('Control+l');
    const input = page.locator('#goto-input');
    await input.fill('31');
    await input.press('Enter');
    expect(await editor.evaluate(el => el.value.slice(0, el.selectionStart).split('\n').length)).toBe(31);
    expect(await editor.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd))).toBe(lines[30]);
    expect(await selectionVisible(editor)).toBe(true);
  }
});

test('Ctrl+K and Ctrl+Shift+K from find input scroll to visible next and previous matches', async ({ page }) => {
  const editor = page.locator('#editor');
  await editor.focus();
  const textVal = 'needle\n' + '长段落中文'.repeat(600) + '\nneedle\n' + '尾部\n'.repeat(30);
  await editor.evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, textVal);
  await editor.evaluate(el => el.setSelectionRange(0, 6));
  await page.keyboard.press('Control+f');
  const input = page.locator('#find-input');
  await input.focus();
  await page.keyboard.press('Control+k');
  expect(await editor.evaluate(el => el.selectionStart)).toBeGreaterThan(1000);
  expect(await editor.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await selectionVisible(editor)).toBe(true);
  await input.focus();
  await page.keyboard.press('Control+Shift+k');
  expect(await editor.evaluate(el => el.selectionStart)).toBe(0);
  expect(await selectionVisible(editor)).toBe(true);
});

test('Entering Vim from middle of preview preserves reading location and shows the block cursor', async ({ page }) => {
  const editor = page.locator('#editor');
  await expect(editor).toBeVisible();
  const bigText = Array.from({ length: 100 }, (_, i) => `## Section ${i}\n\nParagraph ${i} content.\n`).join('\n');
  await editor.evaluate((el, val) => {
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, bigText);
  await page.evaluate(() => toggleMode());
  const preview = page.locator('#preview-wrapper');
  await preview.evaluate(el => el.scrollTop = (el.scrollHeight - el.clientHeight) / 2);
  expect(await preview.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Alt+Shift+e');
  await page.keyboard.press('v');
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  expect(await editor.evaluate(el => el.selectionStart)).toBeGreaterThan(500);
  await expect(page.locator('.vim-block-cursor')).toBeInViewport();
  await expect(page.locator('#statusbar .vim-enabled-hint')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(800);
});

for (const reducedMotion of ['no-preference', 'reduce']) {
  test(`F7/F12 focus flash remains visible with reduced-motion ${reducedMotion}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    const editor = page.locator('#editor');
    await editor.focus();
    await page.keyboard.press('Control+F7');
    const target = page.locator(':focus');
    await expect(target).toHaveClass(/vim-focus-flash/);
    await page.keyboard.press('F12');
    await expect(editor).toBeFocused();
    await expect(editor).toHaveClass(/vim-focus-flash/);
    if (reducedMotion === 'reduce') {
      await expect(editor).toHaveCSS('animation-name', 'none');
      await expect(editor).toHaveCSS('outline-style', 'solid');
      await expect(editor).toHaveCSS('outline-width', '2px');
    } else await expect(editor).toHaveCSS('animation-name', 'vim-focus-flash');
  });
}

for (const theme of ['light', 'dark']) {
  test('Inline find follows actual view toggle and closes in preview: ' + theme, async ({ page }) => {
    await page.locator('html').evaluate((el, t) => el.setAttribute('data-theme', t), theme);
    const editor = page.locator('#editor');
    await editor.fill(`needle first

needle second`);
    await editor.focus();
    await editor.evaluate(el => el.setSelectionRange(0, 6));
    await page.keyboard.press('Control+f');
    await page.evaluate(() => window.originalFindBar = document.getElementById('find-bar'));
    await page.click('#btn-toggle');
    const bar = page.locator('#preview-container > #find-bar');
    await expect(bar).toBeVisible();
    expect(await page.evaluate(() => document.getElementById('find-bar') === window.originalFindBar)).toBe(true);
    await expect(page.locator('#preview-container')).toHaveClass(/find-open/);
    await expect(page.locator('#find-count')).toHaveText('1 of 2');
    await page.click('#find-next');
    await expect(page.locator('#find-count')).toHaveText('2 of 2');
    await page.click('#find-prev');
    await expect(page.locator('#find-count')).toHaveText('1 of 2');
    await page.screenshot({ path: path.join(ROOT, 'docs/qa/integration-2026-09-07', 'find-preview-' + theme + '.png') });
    await page.click('#btn-toggle');
    await expect(page.locator('#editor-container > #find-bar')).toBeVisible();
    await page.click('#btn-toggle');
    await page.click('#find-close');
    await expect(page.locator('#find-bar')).toBeHidden();
    await expect(page.locator('#preview mark.find-match')).toHaveCount(0);
    await expect(page.locator('#preview-container')).not.toHaveClass(/find-open/);
    await page.click('#btn-toggle');
    await expect(editor).toBeVisible();
    await expect(page.locator('#find-bar')).toBeHidden();
    await expect(page.locator('#editor-container')).not.toHaveClass(/find-open/);
  });
}
