const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..', '..');
const pagePath = path.join(root, 'tests', '.tmp', 'index.html');
if (!fs.existsSync(pagePath)) execFileSync('python', [path.join(root, 'tools', 'build_test_page.py')], { cwd: root });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(pagePath).href);
  await page.evaluate(() => {
    window.Workspace.dispatch('workspace:opened', { root: 'D:/demo', file_count: 3 });
    window.Workspace.dispatch('workspace:tree-listed', { relDir: '', entries: [
      { name: 'docs', relPath: 'docs', kind: 'dir' },
      { name: 'README.md', relPath: 'README.md', kind: 'file' },
      { name: 'notes.md', relPath: 'notes.md', kind: 'file' },
    ] });
  });
  await page.waitForTimeout(100);
  const row = page.locator('.tree-row[data-rel="README.md"]');
  await row.click({ button: 'right', position: { x: 40, y: 10 } });
  await page.screenshot({ path: path.join(root, 'tests', '.tmp', 'context-menu-dark.png'), fullPage: false });
  const dark = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    role: document.querySelector('.ctx-menu')?.getAttribute('role'),
    items: document.querySelectorAll('.ctx-item').length,
    ariaDisabled: document.querySelector('.ctx-item')?.getAttribute('aria-disabled'),
    left: document.querySelector('.ctx-menu')?.style.left,
    top: document.querySelector('.ctx-menu')?.style.top,
  }));
  await page.click('#btn-theme');
  await row.click({ button: 'right', position: { x: 40, y: 10 } });
  await page.screenshot({ path: path.join(root, 'tests', '.tmp', 'context-menu-light.png'), fullPage: false });
  const light = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    background: getComputedStyle(document.querySelector('.ctx-menu')).backgroundColor,
    border: getComputedStyle(document.querySelector('.ctx-menu')).borderTopColor,
    shadow: getComputedStyle(document.querySelector('.ctx-menu')).boxShadow,
  }));
  console.log(JSON.stringify({ dark, light }));
  await browser.close();
})();
