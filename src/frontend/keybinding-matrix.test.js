const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(files) {
  const c = { console, setTimeout, clearTimeout };
  c.window = c;
  c.globalThis = c;
  files.forEach((file) => vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, file), 'utf8'),
    c,
    { filename: file },
  ));
  return c;
}

const contexts = [
  'editorTextFocus',
  'projectTreeFocus',
  'outlineFocus',
  'settingsFocus',
  'dialogOpen',
  'vim.normal',
  'vim.insert',
];
const schemes = ['ultra.eclipse', 'ultra.vscode'];

function contextValues(active) {
  const values = {};
  contexts.forEach((key) => { values[key] = key === active; });
  return values;
}

test('pairwise scheme-context runner resolves every active default binding', () => {
  const c = load([
    'context-keys.js',
    'when-clause.js',
    'keybinding-parser.js',
    'default-keybindings.js',
    'keybinding-service.js',
  ]);
  schemes.forEach((scheme) => {
    contexts.forEach((activeContext) => {
      const context = new c.ContextKeyService();
      context.setMany(contextValues(activeContext));
      const bindings = c.DefaultKeybindings.schemes[scheme];
      const commandIds = new Set(bindings.map((binding) => binding.commandId));
      const service = new c.BindingService({
        schemes: { [scheme]: bindings },
        scheme,
        context,
        platform: 'Windows',
        commands: Object.fromEntries([...commandIds].map((id) => [id, () => id])),
      });
      const active = bindings.filter((binding) => service.active(binding));
      const seen = new Set();
      active.forEach((binding) => {
        assert.ok(commandIds.has(binding.commandId), `${scheme}/${activeContext}: unknown ${binding.commandId}`);
        assert.ok(binding.sequence, `${scheme}/${activeContext}: empty sequence`);
        const key = `${binding.sequence}|${binding.when}|${binding.platform}`;
        assert.ok(!seen.has(key), `${scheme}/${activeContext}: duplicate ${key}`);
        seen.add(key);
        const resolved = service.resolve(binding.sequence);
        assert.ok(resolved.bindings.some((candidate) => candidate.commandId === binding.commandId),
          `${scheme}/${activeContext}: cannot resolve ${binding.commandId} ${binding.sequence}`);
      });
      assert.equal(service.scanConflicts().length, 0, `${scheme}/${activeContext}: conflicts`);
    });
  });
});

schemes.forEach((scheme) => {
  contexts.forEach((activeContext) => {
    test(`pairwise case ${scheme} / ${activeContext}`, () => {
      const c = load([
        'context-keys.js',
        'when-clause.js',
        'keybinding-parser.js',
        'default-keybindings.js',
        'keybinding-service.js',
      ]);
      const context = new c.ContextKeyService();
      context.setMany(contextValues(activeContext));
      const bindings = c.DefaultKeybindings.schemes[scheme];
      const service = new c.BindingService({ schemes: { [scheme]: bindings }, scheme, context, platform: 'Windows' });
      bindings.filter((binding) => !binding.when || binding.when === activeContext).forEach((binding) => {
        assert.ok(service.resolve(binding.sequence).bindings.some((candidate) => candidate.commandId === binding.commandId));
      });
    });
  });
});

['Windows', 'macOS', 'Linux', '*'].forEach((platform) => {
  test(`pairwise platform case ${platform}`, () => {
    const c = load([
      'context-keys.js',
      'when-clause.js',
      'keybinding-parser.js',
      'keybinding-service.js',
    ]);
    const context = new c.ContextKeyService();
    const service = new c.BindingService({
      schemes: { T: [{ commandId: 'global', sequence: 'Ctrl+G' }, { commandId: 'mac', sequence: 'Ctrl+M', platform: 'macOS' }] },
      scheme: 'T', context, platform,
    });
    assert.equal(service.resolve('Ctrl+G').bindings.length, 1);
    assert.equal(service.resolve('Ctrl+M').bindings.length, platform === 'macOS' ? 1 : 0);
  });
});

test('pairwise runner verifies context-gated bindings are isolated', () => {
  const c = load([
    'context-keys.js',
    'when-clause.js',
    'keybinding-parser.js',
    'default-keybindings.js',
    'keybinding-service.js',
  ]);
  const bindings = c.DefaultKeybindings.schemes['ultra.eclipse'];
  const gated = bindings.filter((binding) => binding.when);
  assert.ok(gated.length > 0);
  gated.forEach((binding) => {
    contexts.forEach((activeContext) => {
      const context = new c.ContextKeyService();
      context.setMany(contextValues(activeContext));
      const service = new c.BindingService({
        schemes: { eclipse: bindings },
        scheme: 'eclipse',
        context,
        platform: 'Windows',
      });
      const resolved = service.resolve(binding.sequence).bindings;
      const shouldBeActive = activeContext === binding.when;
      assert.equal(resolved.some((candidate) => candidate.commandId === binding.commandId), shouldBeActive,
        `${activeContext}: ${binding.commandId}`);
    });
  });
});
