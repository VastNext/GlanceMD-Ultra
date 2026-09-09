const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async function globalSetup() {
  const root = path.resolve(__dirname, '../..');
  // 在所有 worker 启动前统一组装，禁止用例并发覆盖同一个页面。
  execFileSync('python', [path.join(root, 'tools/build_test_page.py')], {
    cwd: root,
    stdio: 'inherit',
  });
};
