/* settings-apply.test.js —— settings-apply.js 的零依赖单测（node:test + node:vm）。
 *
 * stub 说明：settings-apply.js 对 DOM 的依赖集中在
 *   document.documentElement.style.setProperty（CSS 变量捕获）、
 *   getElementById('editor' | 'editor-gutter' | 'editor-container')（行号槽三件套）、
 *   元素的 classList.toggle、setAttribute/getAttribute（textarea wrap）、
 *   value/scrollTop/clientHeight/textContent、addEventListener。
 * 这里用最小 stub 捕获上述写入；CSS 不参与单测（明暗两主题均走既有 token，
 * 由 style.css 保证）。行号槽数量计算用受控输入值驱动（value 行数 +
 * clientHeight 视口容量）。
 *
 * editor.js 的 Tab 集成用例在同一 vm 上下文按页面顺序装载 settings-apply.js
 * 与 editor.js，验证 Tab 插入空格数读 SettingsApply.get().editor.tabSize。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SETTINGS_APPLY_JS = path.join(__dirname, 'settings-apply.js');
const EDITOR_JS = path.join(__dirname, 'editor.js');

/* ── 最小 DOM stub ── */

function makeClassList() {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    toggle(name, force) {
      const on = force === undefined ? !set.has(name) : Boolean(force);
      if (on) set.add(name);
      else set.delete(name);
      return on;
    },
    contains: (name) => set.has(name),
  };
}

function makeElement(id) {
  const el = {
    id,
    value: '',
    scrollTop: 0,
    clientHeight: 0,
    textContent: '',
    attributes: {},
    listeners: {},
    style: {},
  };
  el.classList = makeClassList();
  el.addEventListener = (type, handler) => {
    (el.listeners[type] = el.listeners[type] || []).push(handler);
  };
  el.dispatchEvent = (event) => {
    (el.listeners[event.type] || []).slice().forEach((fn) => fn(event));
  };
  el.setAttribute = (name, value) => {
    el.attributes[name] = String(value);
  };
  el.getAttribute = (name) => (name in el.attributes ? el.attributes[name] : null);
  return el;
}

/* 装载 settings-apply.js（init() 在装载时自动执行：发一次 get-effective 并订阅） */
function load() {
  const vars = {};
  const ipcMessages = [];
  const subs = {};
  const editor = makeElement('editor');
  const gutter = makeElement('editor-gutter');
  const container = makeElement('editor-container');
  const byId = { editor, 'editor-gutter': gutter, 'editor-container': container };

  const documentElement = {
    style: {
      setProperty: (name, value) => {
        vars[name] = String(value);
      },
      getPropertyValue: (name) => (name in vars ? vars[name] : ''),
    },
  };

  const ctx = {
    console,
    setInterval: () => 0, // 兜底轮询：stub 不驱动回调，行号同步由用例手动触发
    setTimeout: () => 0,  // editor.js input 回调依赖（回调体不触发）
    clearTimeout: () => {},
    document: {
      documentElement,
      getElementById: (id) => (id in byId ? byId[id] : null),
    },
  };
  ctx.window = ctx;
  ctx.window.ipc = { postMessage: (m) => ipcMessages.push(JSON.parse(m)) };
  ctx.Workspace = {
    on(event, handler) {
      (subs[event] = subs[event] || []).push(handler);
    },
  };

  vm.runInNewContext(fs.readFileSync(SETTINGS_APPLY_JS, 'utf8'), ctx, {
    filename: 'settings-apply.js',
  });
  return { ctx, vars, ipcMessages, subs, editor, gutter, container };
}

/* ── get() 默认值与缓存 ── */

test('get() 未收到事件时返回内置默认值（与 Rust schema v1 Default 一致）', () => {
  const h = load();
  // JSON round-trip：vm 上下文与宿主的原型不同，deepStrictEqual 需同源对象
  assert.deepEqual(JSON.parse(JSON.stringify(h.ctx.SettingsApply.get())), {
    editor: { fontSize: 14, tabSize: 4, wordWrap: true, lineNumbers: true, largeFileMB: 5 },
    search: { maxFileSizeMB: 5, maxResults: 2000 },
    appearance: { sidebarFontSize: 14 },
  });
});

test('get() 合并默认值且返回拷贝（外部改写不污染缓存）', () => {
  const h = load();
  h.ctx.SettingsApply.apply({ editor: { fontSize: 18 } });
  const snapshot = h.ctx.SettingsApply.get();
  assert.equal(snapshot.editor.fontSize, 18);
  assert.equal(snapshot.editor.tabSize, 4, '未指定的键回退默认');
  assert.equal(snapshot.search.maxResults, 2000);
  snapshot.editor.fontSize = 999;
  assert.equal(h.ctx.SettingsApply.get().editor.fontSize, 18, '返回拷贝');
});

/* ── init / apply ── */

test('装载即发一次 get-effective 并订阅 settings-effective，事件驱动 apply', () => {
  const h = load();
  assert.deepEqual(h.ipcMessages, [{ command: 'workspace.settings.get-effective' }]);
  const handlers = h.subs['workspace:settings-effective'];
  assert.ok(handlers && handlers.length >= 1, '已订阅 workspace:settings-effective');
  handlers[0]({ settings: { editor: { fontSize: 20 } } });
  assert.equal(h.vars['--editor-font-size'], '20px');
});

test('apply 写入编辑器字号 / Tab 宽度 / 侧栏字号 CSS 变量，非法值回退默认', () => {
  const h = load();
  h.ctx.SettingsApply.apply({
    editor: { fontSize: 16, tabSize: 2 },
    appearance: { sidebarFontSize: 15 },
  });
  assert.equal(h.vars['--editor-font-size'], '16px');
  assert.equal(h.vars['--editor-tab-size'], '2');
  assert.equal(h.vars['--panel-font-size'], '15px');

  h.ctx.SettingsApply.apply({ editor: { fontSize: 'abc' }, appearance: {} });
  assert.equal(h.vars['--editor-font-size'], '14px', '非法字号回退 14');
  assert.equal(h.vars['--editor-tab-size'], '4', '缺省 Tab 宽度回退 4');
  assert.equal(h.vars['--panel-font-size'], '14px', '缺省侧栏字号回退 14');
});

test('apply wordWrap 切换 textarea wrap 属性且 value 不丢，wrap-off 类随动', () => {
  const h = load();
  h.editor.value = 'hello';
  h.ctx.SettingsApply.apply({ editor: { wordWrap: false } });
  assert.equal(h.editor.getAttribute('wrap'), 'off');
  assert.equal(h.editor.value, 'hello', '改属性前保存 value 再恢复');
  assert.equal(h.editor.classList.contains('wrap-off'), true);

  h.editor.value = 'world';
  h.ctx.SettingsApply.apply({ editor: { wordWrap: true } });
  assert.equal(h.editor.getAttribute('wrap'), 'soft');
  assert.equal(h.editor.value, 'world');
  assert.equal(h.editor.classList.contains('wrap-off'), false);
});

test('apply lineNumbers 切换行号槽显隐（gutter-on 类 + display）', () => {
  const h = load();
  h.ctx.SettingsApply.apply({ editor: { lineNumbers: false } });
  assert.equal(h.container.classList.contains('gutter-on'), false);
  assert.equal(h.gutter.style.display, 'none');

  h.ctx.SettingsApply.apply({ editor: { lineNumbers: true } });
  assert.equal(h.container.classList.contains('gutter-on'), true);
  assert.equal(h.gutter.style.display, '');
});

/* ── 行号槽 ── */

test('行号槽：按逻辑行数渲染，不足视口容量时补足空行号，scrollTop 随编辑器', () => {
  const h = load();
  h.editor.value = 'a\nb\nc';
  h.ctx.SettingsApply.syncGutter();
  assert.equal(h.gutter.textContent, '1\n2\n3');

  // clientHeight=100px / (14px * 1.8) = 3.97 → 视口 4 行 > 逻辑 3 行 → 补到 4
  h.gutter.clientHeight = 100;
  h.editor.scrollTop = 0;
  h.ctx.SettingsApply.syncGutter();
  assert.equal(h.gutter.textContent, '1\n2\n3\n4');

  // 行数未变时滚动只同步 scrollTop，不重建文本
  h.editor.scrollTop = 120;
  h.ctx.SettingsApply.syncGutter();
  assert.equal(h.gutter.scrollTop, 120);
  assert.equal(h.gutter.textContent, '1\n2\n3\n4');
});

test('行号槽关闭（lineNumbers=false）时 syncGutter 不渲染', () => {
  const h = load();
  h.ctx.SettingsApply.apply({ editor: { lineNumbers: false } });
  h.editor.value = 'a\nb';
  h.ctx.SettingsApply.syncGutter();
  assert.equal(h.gutter.style.display, 'none');
  assert.equal(h.gutter.textContent, '1', '停留在装载时的空文档渲染，不再更新');
});

/* ── editor.js Tab 集成 ── */

function loadEditorWithSettingsApply() {
  const h = load();
  h.ctx.Event = function Event(type) {
    this.type = type;
  };
  h.ctx.TabManager = {
    getActiveTab: () => ({}),
    markDirty() {},
  };
  vm.runInNewContext(fs.readFileSync(EDITOR_JS, 'utf8'), h.ctx, { filename: 'editor.js' });
  return h;
}

function pressTab(h) {
  h.editor.listeners.keydown.forEach((fn) =>
    fn({ key: 'Tab', ctrlKey: false, metaKey: false, preventDefault() {} }),
  );
}

test('editor.js Tab 插入空格数读 SettingsApply：缺省 4、设置 2 生效', () => {
  const h = loadEditorWithSettingsApply();

  // 未收到设置事件：走内置默认 4
  h.editor.value = 'ab';
  h.editor.selectionStart = h.editor.selectionEnd = 2;
  pressTab(h);
  assert.equal(h.editor.value, 'ab    ', '默认插入 4 空格');
  assert.equal(h.editor.selectionStart, 6);

  // 设置 tabSize=2 生效
  h.ctx.SettingsApply.apply({ editor: { tabSize: 2 } });
  h.editor.selectionStart = h.editor.selectionEnd = h.editor.value.length;
  pressTab(h);
  assert.equal(h.editor.value, 'ab      ', '再插入 2 空格');
  assert.equal(h.editor.selectionStart, 8);
});
