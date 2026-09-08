const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async function globalSetup() {
  const root = path.resolve(__dirname, '../..');
  // Always rebuild before workers start: an existing page can contain stale code.
  execFileSync('python', [path.join(root, 'tools/build_test_page.py')], {
    cwd: root,
    stdio: 'inherit',
  });
};
