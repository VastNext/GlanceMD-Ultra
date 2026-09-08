/* Playwright 端到端冒烟配置。
 *
 * 被测对象是 tools/build_test_page.py 组装的静态页（file:// 直接加载），
 * 不需要 webServer；global setup 每次运行均重建页面，兼容 spec 的缺页构建。
 * 运行：cd tests/e2e && npx playwright test
 * 前置：npm i -D playwright && npx playwright install chromium
 */
module.exports = {
  testDir: './specs',
  globalSetup: require.resolve('./global-setup'),
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: true,
    // file:// 页面无法用 baseURL，spec 里用 pathToFileURL 组装地址
    actionTimeout: 5_000,
  },
};
