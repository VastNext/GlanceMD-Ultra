const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, 'editor.js'), 'utf8');

function loadEditor(markdown) {
  const calls = [];
  const editor = {
    value: markdown,
    selectionStart: 0,
    selectionEnd: 0,
    scrollHeight: 1000,
    clientHeight: 200,
    scrollTop: 0,
    focus() {},
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
      calls.push({ start, end });
    },
    addEventListener() {},
  };
  const context = {
    window: {},
    document: { getElementById: (id) => id === 'editor' ? editor : null },
    isFinite,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'editor.js' });
  return { editor, navigation: context.window.EditorNavigation, calls };
}

test('heading descriptors skip initial YAML frontmatter and retain source lines', () => {
  const h = loadEditor('---\ntitle: YAML title\n---\n\n正文\n\n真实标题\n---\n\n# ATX');
  assert.deepEqual([...h.navigation.getHeadingDescriptors()].map((x) => ({ line: x.line, level: x.level, text: x.text })), [
    { line: 6, level: 2, text: '真实标题' },
    { line: 9, level: 1, text: 'ATX' },
  ]);
});

test('fences close only with same marker and sufficient length', () => {
  const markdown = [
    '~~~js',
    '# pseudo one',
    '```',
    '# pseudo two',
    '~~~~',
    '# real title',
    '---',
    '## after title',
  ].join('\n');
  const h = loadEditor(markdown);
  assert.deepEqual([...h.navigation.getHeadingDescriptors()].map((x) => ({ line: x.line, level: x.level, text: x.text })), [
    { line: 5, level: 1, text: 'real title' },
    { line: 7, level: 2, text: 'after title' },
  ]);
});

test('resolveHeading matches expected level and normalized text, then safely falls back to index', () => {
  const h = loadEditor('# One\n\n# Two\n\nTwo body');
  const resolved = h.navigation.resolveHeading(0, { level: 1, text: ' Two ' });
  assert.equal(resolved.line, 2);
  assert.equal(h.navigation.scrollToHeading(0, { level: 1, text: ' Two ' }), true);
  assert.equal(h.editor.selectionStart, 7);
  assert.equal(h.editor.selectionEnd, 12);
  assert.equal(h.navigation.scrollToHeading(1, { level: 2, text: 'missing' }), true);
  assert.equal(h.editor.selectionStart, 7);
  assert.deepEqual([...h.navigation.getHeadingLines()], [0, 2]);
});

test('resolveHeading preserves the indexed occurrence when headings have duplicate text', () => {
  const h = loadEditor('# Repeated\n\nbody\n\n# Repeated');
  const resolved = h.navigation.resolveHeading(1, { level: 1, text: 'Repeated' });
  assert.equal(resolved.line, 4);
  assert.equal(h.navigation.scrollToHeading(1, { level: 1, text: 'Repeated' }), true);
  assert.equal(h.editor.value.slice(h.editor.selectionStart, h.editor.selectionEnd), '# Repeated');
  assert.equal(h.editor.value.slice(0, h.editor.selectionStart).split('\n').length - 1, 4);
});
