/* verify-print-pdf-pages.js — 打印导出 PDF 分页验证（竖排/单页 bug 家族回归）
 * 场景：注入远超一页的长文档 → 打印流程同款浅色渲染 → Chromium 打印管线
 * （page.pdf，与 WebView2 PrintToPdf 同源）生成 PDF → 断言页数 > 1。
 * 同时把生成的多页 PDF 存档到 docs/qa 作为证据。
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
const outPdf = path.join(outDir, 'print-pdf-multipage-proof.pdf');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(pathToFileURL(pagePath).href);
  await page.waitForTimeout(200);

  // 注入远超一页的长文档（40 节：标题 + 正文 + 代码块 + 列表），按打印流程
  // 浅色渲染预览（与 export.js printPreviewForPrint 同步骤）
  await page.evaluate(() => {
    let md = '# 分页验证文档\n';
    for (let i = 1; i <= 40; i++) {
      md += `\n\n## 第 ${i} 节 标题\n\n这是一段用于验证打印分页的正文内容，包含中英文 mixed content、标点与数字 1234567890。`
        + '\n\n```js\nconsole.log("code block ' + i + '");\n```\n\n- 列表项 A\n- 列表项 B\n- 列表项 C\n';
    }
    window.__fromRust('file_opened', { content: md, path: 'D:\\docs\\long.md' });
    document.documentElement.setAttribute('data-theme', 'light');
    const previewEl = document.getElementById('preview');
    previewEl.innerHTML = window.marked.parse(md);
  });
  await page.waitForTimeout(300);

  // Chromium 打印管线生成 PDF（与 WebView2 PrintToPdf 同源，应用 @media print）
  await page.pdf({ path: outPdf, format: 'A4', printBackground: true });
  await browser.close();

  // 页数统计：数 /Type /Page 对象（Chromium PDF 的页对象为明文）
  const raw = fs.readFileSync(outPdf).toString('latin1');
  const pageObjs = (raw.match(/\/Type\s*\/Page(?![s])/g) || []).length;
  const countMatch = raw.match(/\/Type\s*\/Pages[\s\S]{0,120}?\/Count\s+(\d+)/);
  const pages = pageObjs || (countMatch ? Number(countMatch[1]) : 0);
  const sizeKB = Math.round(fs.statSync(outPdf).size / 1024);

  const ok = pages > 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  打印导出 PDF 分页：${pages} 页（${sizeKB} KB）`);
  if (!ok) {
    console.log('FAIL  预期多页，实际 ' + pages + ' 页——打印碎片根被钉死（html/body 高度/溢出未重置？）');
    process.exit(1);
  }
  console.log('证据 PDF: ' + outPdf);
})().catch(e => { console.error(e); process.exit(1); });
