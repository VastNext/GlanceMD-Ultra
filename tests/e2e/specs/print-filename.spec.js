const { test, expect } = require('playwright/test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

for (const theme of ['light', 'dark']) {
  test(`打印导出保留当前中文文档名与取消后再次导出：${theme}`, async ({ page }, testInfo) => {
    await page.goto(pathToFileURL(path.resolve(__dirname, '../../.tmp/index.html')).href);
    await page.evaluate((theme) => {
      document.documentElement.setAttribute('data-theme', theme);
      window.__fromRust('file_opened', { path: 'D:/docs/会议纪要.md', content: '# 会议纪要\n\n打印文件名验证' });
    }, theme);
    await page.locator('#btn-export').click();
    await page.screenshot({ path: testInfo.outputPath(`print-menu-${theme}.png`) });
    await page.locator('[data-export-format="pdf-print"]').click();
    const request = await page.evaluate(() => window.__ipcLog.map(JSON.parse).find(m => m.command === 'app.printToPdf'));
    expect(request.suggestName).toBe('会议纪要.pdf');
    await page.evaluate((requestId) => {
      window.__fromRust('workspace:print-pdf-result', { requestId, ok: false, cancelled: true });
      window.__fromRust('file_opened', { path: 'D:/docs/第二份.v2.md', content: '# 第二份' });
      window.ExportUI.startExport('pdf-print');
    }, request.requestId);
    const requests = await page.evaluate(() => window.__ipcLog.map(JSON.parse).filter(m => m.command === 'app.printToPdf'));
    expect(requests).toHaveLength(2);
    expect(requests[1].suggestName).toBe('第二份.v2.pdf');
    expect(requests[1].requestId).not.toBe(request.requestId);
  });
}
