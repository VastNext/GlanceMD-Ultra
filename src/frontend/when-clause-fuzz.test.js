const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function load(files) {
  const c = { console };
  c.window = c;
  c.globalThis = c;
  files.forEach((file) => vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, file), 'utf8'),
    c,
    { filename: file },
  ));
  return c;
}

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function generateExpression(random, depth) {
  const keys = ['editorTextFocus', 'projectTreeFocus', 'vim.normal', 'settingsFocus', 'count', 'mode'];
  const values = ['true', 'false', '0', '1', '2', 'vim', 'insert', '"vim"', "'insert'"];
  if (depth <= 0) {
    const key = keys[Math.floor(random() * keys.length)];
    if (random() < 0.45) return `${key} ${random() < 0.5 ? '==' : '!='} ${values[Math.floor(random() * values.length)]}`;
    return random() < 0.35 ? `!${key}` : key;
  }
  const choice = Math.floor(random() * 5);
  if (choice === 0) return `!(${generateExpression(random, depth - 1)})`;
  const left = generateExpression(random, depth - 1);
  const right = generateExpression(random, depth - 1);
  const op = choice < 3 ? '&&' : '||';
  return random() < 0.5 ? `${left} ${op} ${right}` : `(${left}) ${op} (${right})`;
}

test('when-clause generated expressions are deterministic and total', () => {
  const c = load(['context-keys.js', 'when-clause.js']);
  const service = new c.ContextKeyService();
  service.setMany({ editorTextFocus: true, projectTreeFocus: false, 'vim.normal': true, settingsFocus: false, count: 2, mode: 'vim' });
  const random = rng(0x51ced); const expressions = [];
  for (let i = 0; i < 180; i += 1) expressions.push(generateExpression(random, 3));
  expressions.forEach((source) => {
    const clause = new c.WhenClause(source);
    assert.equal(clause.evaluate(service), clause.evaluate(service), source);
    assert.equal(typeof clause.evaluate(service), 'boolean', source);
  });
});

test('when-clause malformed fuzz inputs fail cleanly without partial evaluation', () => {
  const c = load(['context-keys.js', 'when-clause.js']);
  const service = new c.ContextKeyService();
  const random = rng(0xdecafbad);
  const atoms = ['a', 'b', '!', '&&', '||', '(', ')', '==', '!=', '"unterminated', '???', '1'];
  for (let i = 0; i < 160; i += 1) {
    const count = 1 + Math.floor(random() * 8);
    let source = '';
    for (let j = 0; j < count; j += 1) source += `${j ? ' ' : ''}${atoms[Math.floor(random() * atoms.length)]}`;
    try {
      const clause = new c.WhenClause(source);
      assert.equal(typeof clause.evaluate(service), 'boolean', source);
    } catch (error) {
      assert.match(String(error && error.message), /Expected|Unexpected/ , source);
    }
  }
});

test('keybinding parser fuzz preserves stroke sequence boundaries', () => {
  const c = load(['keybinding-parser.js']);
  const parser = c.KeybindingParser;
  const random = rng(0x12345678);
  const keys = ['a', 'Z', 'F12', 'Space', 'Enter', 'Escape', 'Unidentified'];
  const mods = ['', 'Ctrl+', 'Alt+', 'Shift+', 'Meta+', 'Ctrl+Alt+'];
  for (let i = 0; i < 220; i += 1) {
    const count = 1 + Math.floor(random() * 4);
    const source = Array.from({ length: count }, () => `${mods[Math.floor(random() * mods.length)]}${keys[Math.floor(random() * keys.length)]}`).join(' ');
    const parsed = parser.parse(source);
    assert.equal(parsed.length, count, source);
    assert.deepEqual(parser.parse(parsed.join(' ')), parsed, source);
    assert.equal(parser.format(source), parsed.join(' '), source);
  }
});
