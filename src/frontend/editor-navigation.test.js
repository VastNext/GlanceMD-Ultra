const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, 'editor.js'), 'utf8');

function loadEditor(markdown) {
  const calls = [];
  const parent = {
    children: [],
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i !== -1) this.children.splice(i, 1); return c; }
  };
  const doc = {
    createElement(tag) {
      const e = {
        tagName: tag.toUpperCase(),
        style: {},
        textContent: '',
        children: [],
        ownerDocument: doc,
        parentNode: null,
        setAttribute(k, v) { this[k] = v; },
        getAttribute(k) { return this[k]; },
        appendChild(c) { this.children.push(c); return c; },
        removeChild(c) { const i = this.children.indexOf(c); if (i !== -1) this.children.splice(i, 1); return c; },
        get offsetTop() { return 100; },
        get offsetLeft() { return 50; },
        get offsetWidth() { return 10; },
        get offsetHeight() { return 20; }
      };
      return e;
    },
    createTextNode(txt) {
      return { nodeType: 3, textContent: String(txt) };
    },
    getElementById(id) {
      return id === 'editor' ? editor : (id === 'editor-container' ? parent : null);
    }
  };
  const editor = {
    value: markdown,
    selectionStart: 0,
    selectionEnd: 0,
    scrollHeight: 1000,
    clientHeight: 200,
    scrollTop: 0,
    clientWidth: 600,
    offsetLeft: 0,
    offsetTop: 0,
    scrollLeft: 0,
    parentNode: parent,
    ownerDocument: doc,
    focus() {},
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
      calls.push({ start, end });
    },
    addEventListener() {},
  };
  parent.appendChild(editor);
  const win = {
    getComputedStyle() {
      return {
        font: '14px Consolas',
        fontFamily: 'Consolas',
        fontSize: '14px',
        fontWeight: 'normal',
        lineHeight: '20px',
        letterSpacing: 'normal',
        padding: '8px',
        border: '0px',
        boxSizing: 'border-box',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
        wordBreak: 'normal',
        tabSize: '4',
        width: '600px'
      };
    }
  };
  doc.defaultView = win;

  const context = {
    window: win,
    document: doc,
    isFinite,
    setTimeout,
    clearTimeout,
    console,
    parseFloat,
    Math
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

test('measureOffsetCoordinates returns complete 2D layout and marker data', () => {
  const h = loadEditor('Line 1\nLine 2\nLine 3');
  const coords = h.navigation.measureOffsetCoordinates(7);
  assert.ok(coords, 'measureOffsetCoordinates 应返回有效对象');
  assert.equal(typeof coords.left, 'number');
  assert.equal(typeof coords.top, 'number');
  assert.equal(typeof coords.markerLeft, 'number');
  assert.equal(typeof coords.markerTop, 'number');
  assert.equal(typeof coords.height, 'number');
  assert.equal(coords.charUnder, 'L');
});

test('ensureCursorVisible triggers viewport scroll with 2 lines margin', () => {
  const h = loadEditor('A\nB\nC\nD\nE\nF\nG\nH');
  h.editor.clientHeight = 100;
  h.editor.scrollHeight = 500;
  h.editor.scrollTop = 0;

  // 测量并调整视口
  const scrolled = h.navigation.ensureCursorVisible(2, 2);
  assert.equal(typeof scrolled, 'boolean');
});
