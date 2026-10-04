/* verify-export-pandoc.js — 文档导出（Pandoc，FEAT-006）的浏览器实测
 * 用法：cd tests/e2e && node verify-export-pandoc.js
 * 前置：python tools/build_test_page.py（脚本内自动兜底）
 * 验证点：
 *  1. 顶栏 #btn-export 点击展开导出菜单；首次打开懒发 pandoc.detect
 *  2. 未检测到：五个格式项全部禁用 + 「安装指引」入口
 *  3. 检测到（含 PDF 引擎）：状态行 pandoc 3.7.0.2 · 来源，PDF 项带 (xelatex) 徽标
 *  4. 无 PDF 引擎：仅 PDF 禁用并带原因 tooltip
 *  5. 点击「导出为 Word 文档」→ pandoc.export 上行（markdown/sourceDir/suggestName
 *     正确）→ 回执成功后 toast；菜单出现「打开所在文件夹」
 *  6. ☰ 应用菜单 → 扩展 → 「导出…」命令可达；Ctrl+Shift+E 呼出菜单
 *  7. 设置「导出」分类：状态行/路径输入/浏览…/下载直链（版本常量与资产名）、
 *     重新检测带 pathHint、路径保存即检测
 *  8. 明/暗双主题截图（导出菜单 + 设置导出分类）
 */
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..', '..');
const pagePath = path.join(root, 'tests', '.tmp', 'index.html');
if (!fs.existsSync(pagePath)) {
  execFileSync('python', [path.join(root, 'tools', 'build_test_page.py')], { cwd: root });
}

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

  // mock 场景开关：pandoc.detect 回执形态（missing / ok / noengine）
  await page.addInitScript(() => {});
  await page.evaluate(() => {
    window.__pandocScenario = 'missing';
    window.__ipcResponder = (msg) => {
      const m = JSON.parse(msg);
      if (m.command === 'pandoc.detect') {
        const scn = window.__pandocScenario || 'missing';
        const payload = { requestId: m.requestId, ok: true };
        if (scn === 'missing') {
          window.__fromRust('workspace:pandoc-detect-result', Object.assign(payload, { found: false }));
        } else {
          window.__fromRust('workspace:pandoc-detect-result', Object.assign(payload, {
            found: true,
            version: '3.7.0.2',
            path: 'C:/Program Files/Pandoc/pandoc.exe',
            source: scn === 'ok' ? 'path' : 'hint',
            pdfEngine: scn === 'ok' ? 'xelatex' : null,
          }));
        }
      } else if (m.command === 'pandoc.export') {
        window.__fromRust('workspace:pandoc-export-result', {
          requestId: m.requestId, ok: true, outPath: 'D:/out/' + (m.suggestName || 'out.docx'), elapsedMs: 120,
        });
      }
    };
    // 造一个已打开文档（导出需要活动标签；同时隐藏欢迎页）
    window.__fromRust('file_opened', { content: '# Hello\n\nWorld', path: 'D:\\docs\\hello.md' });
  });
  await page.waitForTimeout(150);

  const ipcLog = () => page.evaluate(() => (window.__ipcLog || []).map((m) => JSON.parse(m)));

  // ── 1. 未检测到 pandoc ──
  await page.click('#btn-export');
  await page.waitForTimeout(120);
  const missing = await page.evaluate(() => {
    const menu = document.getElementById('export-menu');
    const items = Array.from(menu.querySelectorAll('[data-export-format]'));
    return {
      open: !!menu && !menu.hidden,
      statusText: menu.querySelector('.export-menu-status-text')?.textContent,
      disabled: items.filter((el) => el.getAttribute('aria-disabled') === 'true').length,
      total: items.length,
      hasGuide: !!menu.querySelector('[data-export-action="guide"]'),
    };
  });
  check('导出菜单打开', missing.open);
  const detectSent = (await ipcLog()).some((m) => m.command === 'pandoc.detect');
  check('打开菜单触发 pandoc.detect', detectSent);
  check('未检测到：状态行文案', (missing.statusText || '').includes('未检测到 pandoc'), missing.statusText);
  check('未检测到：除打印项外全部禁用', missing.total === 6 && missing.disabled === 5, JSON.stringify(missing));
  const printEnabledMissing = await page.evaluate(() => {
    const el = document.querySelector('#export-menu [data-export-format="pdf-print"]');
    return el && el.getAttribute('aria-disabled') === 'false';
  });
  check('未检测到 pandoc：打印项仍可用（零依赖）', printEnabledMissing);
  check('未检测到：给安装指引', missing.hasGuide);
  await page.screenshot({ path: path.join(outDir, 'light-menu-missing.png') });

  // ── 2. 切换到已检测到（含 PDF 引擎）──
  await page.evaluate(() => { window.__pandocScenario = 'ok'; });
  await page.click('#export-menu [data-export-action="redetect"]');
  await page.waitForTimeout(120);
  const found = await page.evaluate(() => {
    const menu = document.getElementById('export-menu');
    const items = Array.from(menu.querySelectorAll('[data-export-format]'));
    const pdf = items.find((el) => el.dataset.exportFormat === 'pdf');
    return {
      statusText: menu.querySelector('.export-menu-status-text')?.textContent,
      enabled: items.filter((el) => el.getAttribute('aria-disabled') === 'false').length,
      pdfBadge: pdf ? pdf.textContent : '',
      hasRedetect: !!menu.querySelector('[data-export-action="redetect"]'),
    };
  });
  check('检测到：状态行含版本与来源', (found.statusText || '').includes('3.7.0.2'), found.statusText);
  check('检测到：六个格式项全部可用', found.enabled === 6, 'enabled=' + found.enabled);
  check('PDF 项带引擎徽标', found.pdfBadge.includes('xelatex'), found.pdfBadge);
  await page.screenshot({ path: path.join(outDir, 'light-menu-found.png') });

  // ── 3. 导出为 Word：上行参数与成功 toast ──
  await page.click('#export-menu [data-export-format="docx"]');
  await page.waitForTimeout(150);
  const exportMsg = (await ipcLog()).find((m) => m.command === 'pandoc.export');
  check('pandoc.export 上行', !!exportMsg);
  check('format=docx', exportMsg && exportMsg.format === 'docx');
  check('markdown 来自编辑器 buffer', exportMsg && exportMsg.markdown.includes('# Hello'));
  check('sourceDir 为源文件目录', exportMsg && exportMsg.sourceDir.replace(/\\/g, '/') === 'D:/docs', exportMsg && exportMsg.sourceDir);
  check('suggestName 换扩展名', exportMsg && exportMsg.suggestName === 'hello.docx', exportMsg && exportMsg.suggestName);
  await page.waitForTimeout(150);
  const toastText = await page.evaluate(() => document.getElementById('app-toast')?.textContent || '');
  check('成功 toast（含产物路径）', toastText.includes('已导出到') && toastText.includes('hello.docx'), toastText);

  // 菜单重开出现「打开所在文件夹」
  await page.click('#btn-export');
  await page.waitForTimeout(100);
  const hasReveal = await page.evaluate(() => {
    const menu = document.getElementById('export-menu');
    const reveal = menu.querySelector('[data-export-action="reveal"]');
    return { has: !!reveal, text: reveal ? reveal.textContent : '' };
  });
  check('上次导出行 + 打开所在文件夹', hasReveal.has && hasReveal.text.includes('打开所在文件夹'), hasReveal.text);
  await page.evaluate(() => document.body.click());
  await page.waitForTimeout(80);

  // ── 4. 无 PDF 引擎：仅 PDF 禁用 ──
  await page.evaluate(() => { window.__pandocScenario = 'noengine'; });
  await page.click('#btn-export');
  await page.waitForTimeout(100);
  await page.click('#export-menu [data-export-action="redetect"]');
  await page.waitForTimeout(120);
  const noengine = await page.evaluate(() => {
    const items = Array.from(document.getElementById('export-menu').querySelectorAll('[data-export-format]'));
    return {
      pdfDisabled: items.find((el) => el.dataset.exportFormat === 'pdf')?.getAttribute('aria-disabled'),
      pdfTitle: items.find((el) => el.dataset.exportFormat === 'pdf')?.getAttribute('title'),
      othersEnabled: items.filter((el) => el.dataset.exportFormat !== 'pdf' && el.getAttribute('aria-disabled') === 'false').length,
    };
  });
  check('无引擎：排版引擎项禁用', noengine.pdfDisabled === 'true');
  check('无引擎：禁用原因 tooltip', (noengine.pdfTitle || '').includes('PDF'), noengine.pdfTitle);
  check('无引擎：其余五项（含打印路线）可用', noengine.othersEnabled === 5);

  // ── 4.5 打印导出路线：点击 → 预览刷新 + app.print 上行 ──
  const beforePrint = (await ipcLog()).filter((m) => m.command === 'app.print').length;
  await page.click('#export-menu [data-export-format="pdf-print"]');
  await page.waitForTimeout(200);
  const afterPrint = (await ipcLog()).filter((m) => m.command === 'app.print').length;
  const previewRendered = await page.evaluate(() => {
    const p = document.getElementById('preview');
    return !!p && p.innerHTML.length > 0;
  });
  check('打印项点击上行 app.print', afterPrint === beforePrint + 1);
  check('打印前预览 DOM 已强制刷新', previewRendered);
  await page.screenshot({ path: path.join(outDir, 'light-menu-noengine.png') });
  await page.evaluate(() => document.body.click());

  // ── 5. ☰ 应用菜单 → 扩展 → 导出… ──
  await page.click('#btn-menu');
  await page.waitForTimeout(100);
  await page.hover('.help-menu .ctx-item-sub');
  await page.waitForTimeout(250);
  const subInfo = await page.evaluate(() => {
    const sub = document.querySelector('.ctx-submenu');
    return sub ? Array.from(sub.querySelectorAll('.ctx-item')).map((el) => el.dataset.commandId) : [];
  });
  check('扩展子菜单含 export.menu', subInfo.includes('export.menu'), JSON.stringify(subInfo));
  await page.click('.ctx-submenu .ctx-item[data-command-id="export.menu"]');
  await page.waitForTimeout(120);
  const viaAppMenu = await page.evaluate(() => {
    const menu = document.getElementById('export-menu');
    return !!menu && !menu.hidden;
  });
  check('应用菜单「导出…」打开导出菜单', viaAppMenu);
  await page.evaluate(() => document.body.click());

  // ── 6. Ctrl+Shift+E 快捷键 ──
  await page.keyboard.press('Control+Shift+E');
  await page.waitForTimeout(120);
  const viaKb = await page.evaluate(() => {
    const menu = document.getElementById('export-menu');
    return !!menu && !menu.hidden;
  });
  check('Ctrl+Shift+E 呼出导出菜单', viaKb);
  await page.evaluate(() => document.body.click());

  // ── 7. 设置 · 导出分类 ──
  await page.evaluate(() => { window.SettingsUI.open(); window.SettingsUI.setCategory('pandoc'); });
  await page.waitForTimeout(150);
  const settingsCat = await page.evaluate(() => {
    const body = document.getElementById('settings-body');
    return {
      label: body.querySelector('h2')?.textContent,
      hasStatus: !!body.querySelector('#setting-pandoc-redetect'),
      hasPath: !!body.querySelector('#setting-pandoc-path'),
      hasBrowse: !!body.querySelector('#setting-pandoc-browse'),
      downloadUrl: body.querySelector('#setting-pandoc-download')?.getAttribute('data-url'),
      downloadLabel: body.querySelector('#setting-pandoc-download')?.textContent,
    };
  });
  check('设置侧栏定位导出分类', (settingsCat.label || '').includes('导出'), settingsCat.label);
  check('状态行 + 重新检测', settingsCat.hasStatus);
  check('路径输入 + 浏览…', settingsCat.hasPath && settingsCat.hasBrowse);
  check('「去下载 pandoc」指向 GitHub Releases 最新页', (settingsCat.downloadUrl || '') === 'https://github.com/jgm/pandoc/releases/latest', settingsCat.downloadUrl);
  check('按钮文案为「去下载 pandoc」', (settingsCat.downloadLabel || '').includes('去下载 pandoc'), settingsCat.downloadLabel);
  await page.screenshot({ path: path.join(outDir, 'light-settings-export.png') });

  // 路径填写 → 精确派发一次 change（Playwright fill 只派 input）→ 保存 + 带 pathHint 的检测
  await page.evaluate(() => { window.__pandocScenario = 'ok'; });
  const before = (await ipcLog()).filter((m) => m.command === 'pandoc.detect').length;
  await page.evaluate(() => {
    const input = document.getElementById('setting-pandoc-path');
    input.value = 'D:/tools/pandoc.exe';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(150);
  const afterDetect = (await ipcLog()).filter((m) => m.command === 'pandoc.detect');
  const saved = (await ipcLog()).some((m) => m.command === 'workspace.settings.set-global' && JSON.stringify(m.data || '').includes('pandoc'));
  check('路径保存走 set-global', saved);
  check('路径变更触发带 pathHint 的检测', afterDetect.length === before + 1 && afterDetect[afterDetect.length - 1].pathHint === 'D:/tools/pandoc.exe', JSON.stringify(afterDetect[afterDetect.length - 1] || {}));
  await page.waitForTimeout(100);
  const statusAfter = await page.evaluate(() => document.getElementById('setting-pandoc-status-result')?.textContent || '');
  check('检测结果回显版本', statusAfter.includes('3.7.0.2'), statusAfter);

  // ── 8. 暗色主题截图 ──
  await page.evaluate(() => { window.SettingsUI.close(); });
  await page.click('#btn-theme');
  await page.waitForTimeout(120);
  await page.click('#btn-export');
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(outDir, 'dark-menu-found.png') });
  await page.evaluate(() => document.body.click());
  await page.evaluate(() => { window.SettingsUI.open(); window.SettingsUI.setCategory('pandoc'); });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(outDir, 'dark-settings-export.png') });

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length) {
    failed.forEach((r) => console.log('FAIL: ' + r.name + (r.detail ? ' -- ' + r.detail : '')));
    process.exit(1);
  }
  console.log('截图目录: ' + outDir);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
