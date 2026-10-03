/* verify-help-menu-about.js — 顶栏「应用菜单」+ 设置「关于」分类的浏览器实测
 * 用法：cd tests/e2e && node verify-help-menu-about.js
 * 前置：python tools/build_test_page.py（脚本内自动兜底）
 * 验证点：
 *  1. #btn-menu（☰）点击展开 .help-menu：14 项 + 4 分隔线 + 扩展父项
 *  2. 「扩展」点击展开二级子菜单（语层翻译面板），点击子项打开翻译浮窗
 *  3. 「关于 GlanceMD Ultra」→ 打开设置面板并定位「关于」分类：版本徽章 v0.7.0、
 *     官网/源码链接、open_external IPC 上行
 *  4. 明/暗双主题 + 英文界面截图
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

  // ── 1. ☰ 菜单展开（暗色）──
  await page.click('#btn-menu');
  await page.waitForTimeout(100);
  const menuInfo = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.help-menu > .ctx-item'));
    return {
      open: !!document.querySelector('.help-menu'),
      commandIds: items.filter(el => el.dataset.commandId).map(el => el.dataset.commandId),
      subParents: items.filter(el => el.dataset.hasSub).map(el => el.querySelector('.help-menu-label')?.textContent),
      seps: document.querySelectorAll('.help-menu > .ctx-sep').length,
      ariaExpanded: document.getElementById('btn-menu').getAttribute('aria-expanded'),
      kbdSample: document.querySelector('.help-menu .ctx-item[data-command-id="file.new"] .kbd')?.textContent
    };
  });
  check('☰ 菜单展开', menuInfo.open);
  check('13 个命令项齐全', JSON.stringify(menuInfo.commandIds) === JSON.stringify([
    'file.new', 'file.open', 'workspace.open', 'file.save', 'file.saveAs', 'file.saveAll',
    'resource.open', 'search.toggle', 'outline.toggle',
    'palette.toggle', 'keyassist.toggle', 'settings.toggle', 'help.about'
  ]), JSON.stringify(menuInfo.commandIds));
  check('「扩展」父项存在', JSON.stringify(menuInfo.subParents) === JSON.stringify(['扩展']), JSON.stringify(menuInfo.subParents));
  check('分隔线 4 条', menuInfo.seps === 4);
  check('aria-expanded 同步', menuInfo.ariaExpanded === 'true');
  check('快捷键提示注入 (Ctrl+N)', menuInfo.kbdSample === 'Ctrl+N', menuInfo.kbdSample);
  await page.screenshot({ path: path.join(outDir, 'app-menu-dark.png') });

  // ── 2. 扩展二级子菜单 ──
  await page.click('.help-menu .ctx-item-sub');
  await page.waitForTimeout(150);
  const subInfo = await page.evaluate(() => ({
    subOpen: !!document.querySelector('.ctx-submenu'),
    subLabel: document.querySelector('.ctx-submenu .help-menu-label')?.textContent,
    subCommand: document.querySelector('.ctx-submenu .ctx-item')?.dataset.commandId
  }));
  check('二级子菜单展开', subInfo.subOpen);
  check('子菜单项 = 语层翻译面板', subInfo.subLabel === '语层翻译面板' && subInfo.subCommand === 'translate.popup', JSON.stringify(subInfo));
  await page.screenshot({ path: path.join(outDir, 'app-menu-submenu-dark.png') });

  // ── 3. 点击子项 → 打开翻译浮窗 ──
  await page.click('.ctx-submenu .ctx-item');
  await page.waitForTimeout(200);
  const translateInfo = await page.evaluate(() => ({
    menuClosed: !document.querySelector('.help-menu'),
    subClosed: !document.querySelector('.ctx-submenu'),
    popupOpen: !!(window.TranslateUI && window.TranslateUI.getState && window.TranslateUI.getState().isPopupOpen)
      || !!(document.getElementById('translate-popup') && !document.getElementById('translate-popup').hidden)
  }));
  check('点击子项后整个菜单关闭', translateInfo.menuClosed && translateInfo.subClosed);
  check('语层翻译浮窗已打开', translateInfo.popupOpen);
  // 关闭翻译浮窗，继续验证
  await page.evaluate(() => window.TranslateUI && window.TranslateUI.closePopup && window.TranslateUI.closePopup());
  await page.waitForTimeout(80);

  // ── 4. 菜单 → 关于 → 设置面板「关于」分类 ──
  await page.click('#btn-menu');
  await page.waitForTimeout(100);
  await page.click('.help-menu .ctx-item[data-command-id="help.about"]');
  await page.waitForTimeout(200);
  const aboutInfo = await page.evaluate(() => ({
    settingsOpen: !!document.getElementById('settings-panel') && !document.getElementById('settings-panel').hidden,
    aboutPage: !!document.querySelector('.settings-about'),
    version: document.querySelector('.settings-about-version')?.textContent,
    desc: document.querySelector('.settings-about-desc')?.textContent,
    links: Array.from(document.querySelectorAll('.settings-about-link')).map(b => b.getAttribute('data-url')),
    menuClosed: !document.querySelector('.help-menu')
  }));
  check('菜单已关闭', aboutInfo.menuClosed);
  check('设置面板打开且定位「关于」分类', aboutInfo.settingsOpen && aboutInfo.aboutPage);
  check('版本徽章 v0.7.0', aboutInfo.version === 'v0.7.0', aboutInfo.version);
  check('简介文案', aboutInfo.desc === '轻量原生 Markdown 工作区编辑器', aboutInfo.desc);
  check('官网/源码链接', aboutInfo.links.length === 2 && /^https:\/\/vastnext\.com/.test(aboutInfo.links[0]) && /^https:\/\/github\.com\/VastNext/.test(aboutInfo.links[1]), JSON.stringify(aboutInfo.links));
  await page.screenshot({ path: path.join(outDir, 'settings-about-dark.png') });

  // ── 5. 关于页链接 → open_external IPC ──
  await page.click('.settings-about-link');
  await page.waitForTimeout(80);
  const ipcInfo = await page.evaluate(() =>
    (window.__ipcLog || []).map(m => { try { return JSON.parse(m); } catch (e) { return null; } })
      .filter(m => m && m.command === 'open_external')
  );
  check('open_external 上行', ipcInfo.length === 1 && ipcInfo[0].url === 'https://vastnext.com/glance-md-ultra', JSON.stringify(ipcInfo));

  // ── 6. 亮色主题：菜单 + 二级子菜单 + 设置关于页 ──
  await page.keyboard.press('Escape'); // 关设置面板
  await page.waitForTimeout(80);
  await page.click('#btn-theme');
  await page.waitForTimeout(80);
  const lightTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('切回亮色主题', lightTheme === 'light', 'data-theme=' + lightTheme);

  await page.click('#btn-menu');
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(outDir, 'app-menu-light.png') });
  await page.click('.help-menu .ctx-item-sub');
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(outDir, 'app-menu-submenu-light.png') });
  await page.keyboard.press('Escape'); // 收子菜单
  await page.keyboard.press('Escape'); // 关菜单
  await page.waitForTimeout(80);

  // 亮色下设置 → 关于
  await page.click('#btn-settings');
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const nav = document.querySelector('#settings-categories');
    const aboutBtn = Array.from(nav.children).find(b => b.dataset.category === 'about');
    aboutBtn.click();
  });
  await page.waitForTimeout(150);
  const lightAbout = await page.evaluate(() => ({
    aboutPage: !!document.querySelector('.settings-about'),
    version: document.querySelector('.settings-about-version')?.textContent
  }));
  check('亮色下设置「关于」分类可用', lightAbout.aboutPage && lightAbout.version === 'v0.7.0', lightAbout.version);
  await page.screenshot({ path: path.join(outDir, 'settings-about-light.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);

  // ── 7. 英文界面 ──
  await page.evaluate(() => window.I18n.setLanguage('en'));
  await page.waitForTimeout(80);
  await page.click('#btn-menu');
  await page.waitForTimeout(100);
  const enMenu = await page.evaluate(() => ({
    extensions: document.querySelector('.help-menu .ctx-item-sub .help-menu-label')?.textContent,
    about: document.querySelector('.help-menu .ctx-item[data-command-id="help.about"] .help-menu-label')?.textContent,
    newFile: document.querySelector('.help-menu .ctx-item[data-command-id="file.new"] .help-menu-label')?.textContent
  }));
  check('英文菜单：Extensions', enMenu.extensions === 'Extensions', enMenu.extensions);
  check('英文菜单：About GlanceMD Ultra', enMenu.about === 'About GlanceMD Ultra', enMenu.about);
  check('英文菜单：New File', enMenu.newFile === 'New File', enMenu.newFile);
  await page.screenshot({ path: path.join(outDir, 'app-menu-en.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);

  // Esc 关闭回归
  await page.click('#btn-menu');
  await page.waitForTimeout(100);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
  check('Esc 关闭菜单', await page.evaluate(() => !document.querySelector('.help-menu')));

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
