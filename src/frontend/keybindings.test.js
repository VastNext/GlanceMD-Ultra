const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function load() {
  const ls = {};
  const c = {
    window: {},
    document: {
      addEventListener(n, f) { c.listener = f; }
    },
    localStorage: {
      getItem: k => ls[k] || null,
      setItem: (k, v) => { ls[k] = v; },
      removeItem: k => { delete ls[k]; }
    },
    console
  };
  c.window = c;
  vm.runInNewContext(fs.readFileSync('src/frontend/context-keys.js', 'utf8'), c);
  vm.runInNewContext(fs.readFileSync('src/frontend/when-clause.js', 'utf8'), c);
  vm.runInNewContext(fs.readFileSync('src/frontend/keybinding-parser.js', 'utf8'), c);
  vm.runInNewContext(fs.readFileSync('src/frontend/default-keybindings.js', 'utf8'), c);
  vm.runInNewContext(fs.readFileSync('src/frontend/keybinding-service.js', 'utf8'), c);
  vm.runInNewContext(fs.readFileSync('src/frontend/keybindings.js', 'utf8'), c);
  return { c, ls };
}

test('keybindings default map and persistence key', () => {
  const h = load();
  assert.equal(h.c.Keybindings.effective()['outline.quickOpen'], 'Ctrl+O');
  assert.equal(h.c.Keybindings.effective()['file.saveAll'], 'Ctrl+Shift+S');
});

test('overrides 只读快照：随 save/clear 反映当前覆盖表', () => {
  const h = load();
  assert.equal(JSON.stringify(h.c.Keybindings.overrides()), '{}');
  h.c.Keybindings.save({ 'file.open': 'Alt+O' });
  assert.equal(JSON.stringify(h.c.Keybindings.overrides()), '{"file.open":"Alt+O"}');
  h.c.Keybindings.clear();
  assert.equal(JSON.stringify(h.c.Keybindings.overrides()), '{}');
});

test('keybindings save/load roundtrip', () => {
  const h = load();
  h.c.Keybindings.save({ 'file.open': 'Alt+O' });
  const stored = JSON.parse(h.ls['glancemd-ultra-keybindings'])['file.open'];
  assert.equal(stored[0].sequence, 'Alt+O');
  assert.equal(h.c.Keybindings.effective()['file.open'], 'Alt+O');
});

test('key normalization', () => {
  const h = load();
  assert.equal(h.c.Keybindings.normalize({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: 'p' }), 'Ctrl+Shift+P');
});
