/* verify-pandoc-status-layout.js — pandoc 状态行竖排 bug 修复证明（FEAT-006 反馈）
 * 场景：自定义路径检测成功 + 无 PDF 引擎（长文案，正是把左列挤成竖排的原场景）。
 * 断言：真实浏览器布局下 ① 结果区独立于 .setting-control；② 左列宽度正常
 * （>200px，竖排时会被压到 ~30px）；③ 结果行完整展示版本与 PDF 引擎文案。
 * 产出：明暗双主题证明截图。
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
  const page = await browser.newPage({ viewport: { width: 964, height: 700 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(pagePath).href);
  await page.waitForTimeout(200);

  const results = [];
  const check = (name, cond, detail) => {
    results.push({ name, ok: !!cond, detail: detail || '' });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  };

  // 模拟检测回执：自定义路径命中 + 无 PDF 引擎（长文案原场景）
  await page.evaluate(() => {
    window.__ipcResponder = (msg) => {
      const m = JSON.parse(msg);
      if (m.command === 'pandoc.detect' && m.requestId === 'settings-detect') {
        window.__fromRust('workspace:pandoc-detect-result', {
          requestId: 'settings-detect', ok: true, found: true,
          version: '3.7.0.2', source: 'hint', pdfEngine: null,
        });
      }
    };
    window.SettingsUI.open();
    window.SettingsUI.setCategory('pandoc');
  });
  await page.waitForTimeout(150);
  await page.click('#setting-pandoc-redetect');
  await page.waitForTimeout(250);

  const layout = await page.evaluate(() => {
    const row = document.querySelector('.setting-row-pandoc-status');
    if (!row) return null;
    const info = row.querySelector('.setting-info');
    const control = row.querySelector('.setting-control');
    const results = row.querySelector('.pandoc-status-results');
    const resultText = document.getElementById('setting-pandoc-status-result');
    return {
      hasRow: true,
      resultsInControl: control.contains(resultText),
      resultsInOwnArea: !!(results && results.contains(resultText)),
      infoWidth: Math.round(info.getBoundingClientRect().width),
      rowWidth: Math.round(row.getBoundingClientRect().width),
      resultText: resultText ? resultText.textContent : '',
      buttonCount: control.querySelectorAll('button').length,
    };
  });
  check('状态行存在', layout && layout.hasRow);
  check('结果文本不在 .setting-control 内（竖排根因回归）', layout && layout.resultsInControl === false);
  check('结果文本位于全宽结果区', layout && layout.resultsInOwnArea === true);
  check('左列宽度正常（>200px，竖排时 ≈30px）', layout && layout.infoWidth > 200, 'infoWidth=' + (layout && layout.infoWidth));
  check('右列仅一个按钮', layout && layout.buttonCount === 1);
  check('版本回显', layout && layout.resultText.includes('3.7.0.2'), layout && layout.resultText);
  check('PDF 引擎长文案完整展示', layout && layout.resultText.includes('pandoc 不内置'));

  await page.screenshot({ path: path.join(outDir, 'status-layout-fix-light.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await page.click('#btn-theme');
  await page.waitForTimeout(120);
  await page.evaluate(() => { window.SettingsUI.open(); window.SettingsUI.setCategory('pandoc'); });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, 'status-layout-fix-dark.png') });
  await browser.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length) { failed.forEach(r => console.log('FAIL: ' + r.name)); process.exit(1); }
  console.log('证明截图: ' + outDir + '/status-layout-fix-{light,dark}.png');
})().catch(e => { console.error(e); process.exit(1); });
