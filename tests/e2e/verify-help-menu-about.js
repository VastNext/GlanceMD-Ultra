/* verify-help-menu-about.js — 顶栏「更多」菜单与「关于」对话框的浏览器实测
 * 用法：cd tests/e2e && node verify-help-menu-about.js
 * 前置：python tools/build_test_page.py（脚本内自动兜底）
 * 验证点：
 *  1. #btn-more 点击展开 .help-menu，6 个命令项 + 2 条分隔线，快捷键提示注入
 *  2. help.about → AboutDialog 打开，版本徽章与 Cargo.toml 同源（v0.6.1）
 *  3. 官网链接点击 → __ipcLog 记录 open_external（http/https URL）
 *  4. 明/暗双主题截图 + 英文语言截图
 */
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..', '..');
const pagePath = path.join(root, 'tests', '.tmp', 'index.html');
if (!fs.existsSync(pagePath)) execFileSync('python', [path.join(root, 'tools', 'build_test_page.py')], { cwd: root });

const outDir = path.join(root, 'tests', '.tmp');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(pagePath).href);
  await page.waitForTimeout(150);

  // 组装页默认亮色：先切到暗色做主路径，后续再切回亮色
  await page.click('#btn-theme');
  await page.waitForTimeout(80);

  const results = [];
  const check = (name, cond, detail) => {
    results.push({ name, ok: !!cond, detail: detail || '' });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  };

  // ── 1. 菜单展开（暗色）──
  await page.click('#btn-more');
  await page.waitForTimeout(80);
  const menuInfo = await page.evaluate(() => ({
    open: !!document.querySelector('.help-menu'),
    items: Array.from(document.querySelectorAll('.help-menu .ctx-item')).map(el => el.dataset.commandId),
    seps: document.querySelectorAll('.help-menu .ctx-sep').length,
    ariaExpanded: document.getElementById('btn-more').getAttribute('aria-expanded'),
    kbdSample: document.querySelector('.help-menu .ctx-item[data-command-id="palette.toggle"] .kbd')?.textContent,
    labelSample: document.querySelector('.help-menu .ctx-item[data-command-id="help.about"] .help-menu-label')?.textContent
  }));
  check('菜单展开', menuInfo.open);
  check('菜单项 6 个且顺序正确', JSON.stringify(menuInfo.items) === JSON.stringify(['palette.toggle', 'resource.open', 'search.toggle', 'settings.toggle', 'keyassist.toggle', 'help.about']), JSON.stringify(menuInfo.items));
  check('分隔线 2 条', menuInfo.seps === 2);
  check('aria-expanded 同步', menuInfo.ariaExpanded === 'true');
  check('快捷键提示注入 (Ctrl+3)', menuInfo.kbdSample === 'Ctrl+3', menuInfo.kbdSample);
  check('关于项标签 i18n', menuInfo.labelSample === '关于 GlanceMD Ultra', menuInfo.labelSample);
  await page.screenshot({ path: path.join(outDir, 'help-menu-dark.png') });

  // ── 2. 关于对话框（暗色）──
  await page.click('.help-menu .ctx-item[data-command-id="help.about"]');
  await page.waitForTimeout(120);
  const aboutInfo = await page.evaluate(() => ({
    open: document.getElementById('about-dialog-overlay')?.classList.contains('open'),
    version: document.getElementById('about-dialog-version')?.textContent,
    desc: document.getElementById('about-dialog-desc')?.textContent,
    website: document.getElementById('about-dialog-link-website')?.textContent,
    copyright: document.getElementById('about-dialog-copyright')?.textContent,
    menuClosed: !document.querySelector('.help-menu')
  }));
  check('点击关于项后菜单关闭', aboutInfo.menuClosed);
  check('关于对话框打开', aboutInfo.open);
  check('版本徽章 v0.6.1', aboutInfo.version === 'v0.6.1', aboutInfo.version);
  check('描述文案', aboutInfo.desc === '轻量原生 Markdown 工作区编辑器', aboutInfo.desc);
  check('版权行', /© \d{4} VastNext · GlanceMD Ultra/.test(aboutInfo.copyright || ''), aboutInfo.copyright);
  await page.screenshot({ path: path.join(outDir, 'about-dark.png') });

  // ── 3. 官网链接 → open_external IPC ──
  await page.click('#about-dialog-link-website');
  await page.waitForTimeout(80);
  const ipcInfo = await page.evaluate(() => ({
    log: (window.__ipcLog || []).map(m => { try { return JSON.parse(m); } catch (e) { return null; } })
      .filter(m => m && m.command === 'open_external'),
    closed: !document.getElementById('about-dialog-overlay')?.classList.contains('open')
  }));
  check('open_external 上行', ipcInfo.log.length === 1 && /https:\/\/vastnext\.com\/glance-md-ultra/.test(ipcInfo.log[0].url), JSON.stringify(ipcInfo.log));
  check('点击链接后对话框关闭', ipcInfo.closed);

  // ── 4. 亮色主题：菜单 + 关于 ──
  await page.click('#btn-theme');
  await page.waitForTimeout(80);
  const lightTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('切回亮色主题', lightTheme === 'light', 'data-theme=' + lightTheme);
  await page.click('#btn-more');
  await page.waitForTimeout(80);
  check('亮色下菜单可开', await page.evaluate(() => !!document.querySelector('.help-menu')));
  await page.screenshot({ path: path.join(outDir, 'help-menu-light.png') });
  await page.click('.help-menu .ctx-item[data-command-id="help.about"]');
  await page.waitForTimeout(120);
  check('亮色下对话框可开', await page.evaluate(() => document.getElementById('about-dialog-overlay')?.classList.contains('open')));
  await page.screenshot({ path: path.join(outDir, 'about-light.png') });
  await page.click('#about-dialog-btn-close');
  await page.waitForTimeout(60);

  // ── 5. 英文界面 ──
  await page.evaluate(() => window.I18n.setLanguage('en'));
  await page.waitForTimeout(60);
  await page.click('#btn-more');
  await page.waitForTimeout(80);
  const enMenu = await page.evaluate(() => document.querySelector('.help-menu .ctx-item[data-command-id="help.about"] .help-menu-label')?.textContent);
  check('英文菜单标签', enMenu === 'About GlanceMD Ultra', enMenu);
  await page.click('.help-menu .ctx-item[data-command-id="help.about"]');
  await page.waitForTimeout(120);
  const enAbout = await page.evaluate(() => ({
    desc: document.getElementById('about-dialog-desc')?.textContent,
    website: document.getElementById('about-dialog-link-website')?.textContent
  }));
  check('英文描述', enAbout.desc === 'Lightweight native Markdown workspace editor', enAbout.desc);
  check('英文链接文案', enAbout.website === 'Website', enAbout.website);
  await page.screenshot({ path: path.join(outDir, 'about-en.png') });

  // ── Esc 关闭回归 ──
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
  check('Esc 关闭对话框', await page.evaluate(() => !document.getElementById('about-dialog-overlay')?.classList.contains('open')));

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
