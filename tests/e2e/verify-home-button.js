/* verify-home-button.js — 顶栏 Home（欢迎页）按钮的浏览器实测
 * 验证点：#btn-home 点击打开欢迎页覆盖层；再点回到编辑区（切换语义）；
 * 打开文件后欢迎页自动隐藏（updateWelcome 收敛）；明暗双主题截图。
 */
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..', '..');
const pagePath = path.join(root, 'tests', '.tmp', 'index.html');
if (!fs.existsSync(pagePath)) execFileSync('python', [path.join(root, 'tools', 'build_test_page.py')], { cwd: root });
const outDir = path.join(root, 'docs', 'qa', 'pandoc-export-2026-10-04');
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(pagePath).href);
  await page.waitForTimeout(200);

  const results = [];
  const check = (name, cond, detail) => {
    results.push({ name, ok: !!cond, detail: detail || '' });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  };
  const welcomeVisible = () => page.evaluate(() => {
    const w = document.getElementById('welcome-view');
    return !!w && w.classList.contains('visible') && w.style.display === 'flex';
  });

  // 1. 空态下点击 Home：幂等保持欢迎页
  await page.click('#btn-home');
  await page.waitForTimeout(120);
  check('空态点击 Home 欢迎页保持可见', await welcomeVisible());

  // 2. 打开文件（有标签）→ 欢迎页应被 updateWelcome 收敛隐藏
  await page.evaluate(() => window.__fromRust('file_opened', { content: '# Hello\n\nWorld', path: 'D:\\docs\\hello.md' }));
  await page.waitForTimeout(150);
  check('打开文件后欢迎页自动隐藏', !(await welcomeVisible()));

  // 3. 有标签时点击 Home：欢迎页覆盖显示
  await page.click('#btn-home');
  await page.waitForTimeout(120);
  check('有标签时点击 Home 显示欢迎页覆盖层', await welcomeVisible());
  check('欢迎页含新建/打开入口', await page.evaluate(() =>
    !!document.getElementById('welcome-btn-new') && !!document.getElementById('welcome-btn-open-file')));
  await page.screenshot({ path: path.join(outDir, 'light-home-welcome.png') });

  // 4. 再点 Home：回到编辑区
  await page.click('#btn-home');
  await page.waitForTimeout(120);
  check('再次点击 Home 回到编辑区', !(await welcomeVisible()));

  // 5. 暗色主题截图
  await page.click('#btn-theme');
  await page.waitForTimeout(100);
  await page.click('#btn-home');
  await page.waitForTimeout(120);
  check('暗色下 Home 同样可用', await welcomeVisible());
  await page.screenshot({ path: path.join(outDir, 'dark-home-welcome.png') });
  await browser.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length) { failed.forEach(r => console.log('FAIL: ' + r.name)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
