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
  el.children = [];
  el.appendChild = (child) => {
    el.children.push(child);
    return child;
  };
  el.removeChild = (child) => {
    const idx = el.children.indexOf(child);
    if (idx >= 0) el.children.splice(idx, 1);
    return child;
  };
  Object.defineProperty(el, 'textContent', {
    get() {
      if (el.children.length > 0) {
        return el.children.map((c) => c.textContent).join('\n');
      }
      return el._textContent || '';
    },
    set(v) {
      el._textContent = String(v);
      el.children = [];
    },
  });
  el.getBoundingClientRect = () => ({
    width: 800,
    height: 20,
    top: 0,
    bottom: 20,
    left: 0,
    right: 800,
  });
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
  const btnWordWrap = makeElement('btn-word-wrap');
  const byId = { editor, 'editor-gutter': gutter, 'editor-container': container, 'btn-word-wrap': btnWordWrap };

  const documentElement = {
    dataset: {},
    setAttribute: (name, value) => { if (name === 'data-theme') documentElement.dataset.theme = String(value); },
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
      createElement: (tag) => makeElement(tag),
    },
  };
  ctx.window = ctx;
  ctx.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  ctx.window.ipc = { postMessage: (m) => ipcMessages.push(JSON.parse(m)) };
  ctx.Workspace = {
    on(event, handler) {
      (subs[event] = subs[event] || []).push(handler);
    },
  };

  vm.runInNewContext(fs.readFileSync(SETTINGS_APPLY_JS, 'utf8'), ctx, {
    filename: 'settings-apply.js',
  });
  return { ctx, vars, ipcMessages, subs, editor, gutter, container, btnWordWrap };
}

/* ── get() 默认值与缓存 ── */

test('get() 未收到事件时返回内置默认值（与 Rust schema v2 Default 一致）', () => {
  const h = load();
  // JSON round-trip：vm 上下文与宿主的原型不同，deepStrictEqual 需同源对象
  assert.deepEqual(JSON.parse(JSON.stringify(h.ctx.SettingsApply.get())), {
    version: 2,
    appearance: { theme: 'light', sidebarFontSize: 14, language: 'zh-CN', outlineSide: 'right' },
    files: {
      visibleExts: ['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'toml', 'ini', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif'],
      showHidden: false,
      exclude: ['.git', 'node_modules', 'target', '.venv', 'dist', 'build', '.cache'],
      watcherExclude: ['.git', 'node_modules', 'target', '.venv', 'dist', 'build', '.cache'],
    },
    watching: { enableWatcher: true, autoSave: 'off', autoSaveDelayMs: 1000 },
    search: {
      exclude: ['.git', 'node_modules', 'target', '.venv', 'dist', 'build', '.cache'],
      maxFileSizeMB: 5,
      maxResults: 2000,
    },
    editor: { fontSize: 14, tabSize: 4, wordWrap: true, lineNumbers: true, largeFileMB: 5 },
    window: { reuseWindowForFolder: false },
    http: { proxySupport: 'off', proxy: '', proxyStrictSSL: true },
    translation: {
      engineKind: 'google',
      baseUrl: '',
      model: '',
      apiKey: '',
      targetLanguage: 'zh-Hans',
      inputTargetLanguage: 'en',
      selectionTriggerEnabled: true,
    },
    keybindings: { activeScheme: 'ultra.eclipse', schemes: {} },
    recovery: { confirmCloseDirty: true, crashRecovery: true, createProjectSettings: false },
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

test('apply 写入编辑器字号 / Tab 宽度 / 侧栏派生变量，非法值回退默认', () => {
  const h = load();
  h.ctx.SettingsApply.apply({
    editor: { fontSize: 16, tabSize: 2 },
    appearance: { sidebarFontSize: 15 },
  });
  assert.equal(h.vars['--editor-font-size'], '16px');
  assert.equal(h.vars['--editor-tab-size'], '2');
  assert.equal(h.vars['--panel-font-size'], '15px');
  assert.equal(h.vars['--tree-font-size'], '15px');
  assert.equal(h.vars['--tree-icon-size'], '21px');
  assert.equal(h.vars['--tree-caret-size'], '15px');
  assert.equal(h.vars['--tree-row-height'], '33px');
  assert.equal(h.vars['--tree-gap'], '9px');
  assert.equal(h.vars['--tree-indent'], '17px');

  h.ctx.SettingsApply.apply({ editor: { fontSize: 'abc' }, appearance: { sidebarFontSize: 99 } });
  assert.equal(h.vars['--editor-font-size'], '14px', '非法字号回退 14');
  assert.equal(h.vars['--editor-tab-size'], '4', '缺省 Tab 宽度回退 4');
  assert.equal(h.vars['--panel-font-size'], '18px', '侧栏字号上限 18');
  assert.equal(h.vars['--tree-font-size'], '18px');
});

test('主题 effective：light/dark 直接应用，system 解析系统并监听变化', () => {
  const h = load();
  h.ctx.SettingsApply.apply({ appearance: { theme: 'light' } });
  assert.equal(h.ctx.document.documentElement.dataset.theme, 'light');
  h.ctx.SettingsApply.apply({ appearance: { theme: 'system' } });
  assert.equal(h.ctx.document.documentElement.dataset.theme, 'dark');
});

test('settings-changed 与 workspace-opened 重新请求 effective', () => {
  const h = load();
  const before = h.ipcMessages.length;
  h.subs['workspace:settings-changed'][0]({});
  h.subs['workspace:opened'][0]({});
  assert.equal(h.ipcMessages.length, before + 2);
});

/* ── keybindings 装载（settings JSON 为事实源） ── */

test('apply(fromDocument) 把 keybindings 段传给 Keybindings.loadFromSettings', () => {
  const h = load();
  const calls = [];
  h.ctx.Keybindings = { loadFromSettings: (kb) => { calls.push(kb); return true; } };
  const kb = { activeScheme: 'ultra.vscode', schemes: { 'ultra.vscode': [{ commandId: 'file.open', sequence: 'Ctrl+O' }] } };
  h.subs['workspace:settings-effective'][0]({ settings: { keybindings: kb } });
  assert.equal(calls.length, 1, '真实文档回执装载一次');
  assert.equal(calls[0].activeScheme, 'ultra.vscode');
  assert.equal(calls[0].schemes['ultra.vscode'][0].sequence, 'Ctrl+O');
  // 事件负载同时驱动 DOM 生效（latest 缓存更新）
  assert.equal(h.ctx.SettingsApply.get().keybindings.activeScheme, 'ultra.vscode');
});

test('apply 内置默认值（非文档回执）不触发 keybindings 装载', () => {
  const h = load();
  const calls = [];
  h.ctx.Keybindings = { loadFromSettings: (kb) => { calls.push(kb); return true; } };
  // 直接调用 apply（相当于 init 的 apply(DEFAULTS)），fromDocument 缺省为假
  h.ctx.SettingsApply.apply({ keybindings: { activeScheme: 'ultra.vscode', schemes: {} } });
  assert.equal(calls.length, 0, '内置默认值不视为设置文档');
});

test('get() 的 keybindings 形状为 v2（activeScheme + schemes），合并有效值', () => {
  const h = load();
  const got = h.ctx.SettingsApply.get();
  assert.deepEqual(JSON.parse(JSON.stringify(got.keybindings)), { activeScheme: 'ultra.eclipse', schemes: {} });
  h.ctx.SettingsApply.apply({
    keybindings: { activeScheme: 'ultra.vscode', schemes: { 'ultra.vscode': [] } },
  }, true);
  const after = h.ctx.SettingsApply.get();
  assert.equal(after.keybindings.activeScheme, 'ultra.vscode');
  assert.deepEqual(JSON.parse(JSON.stringify(after.keybindings.schemes)), { 'ultra.vscode': [] });
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

test('syncGutter 响应 editor 真实换行状态：关闭换行时行高严格等于 lineHeight', () => {
  const h = load();
  h.editor.value = 'line1\nline2\nline3';

  // 1. 换行模式开启：子项创建
  h.ctx.SettingsApply.applyWordWrap(true);
  assert.equal(h.editor.getAttribute('wrap'), 'soft');
  assert.equal(h.editor.classList.contains('wrap-off'), false);
  assert.equal(h.gutter.children.length, 3);

  // 2. 换行模式关闭（如 Alt+Shift+Y）：每个 row 的 style.height 严格设为 lineHeight + 'px'
  h.ctx.SettingsApply.applyWordWrap(false);
  assert.equal(h.editor.getAttribute('wrap'), 'off');
  assert.equal(h.editor.classList.contains('wrap-off'), true);
  assert.equal(h.gutter.children.length, 3);
  h.gutter.children.forEach((row) => {
    assert.match(row.style.height, /px$/);
    assert.equal(row.style.height, row.style.lineHeight, '未开启换行时行号高度严格等于单行行高');
  });
});

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

test('patch 局部更新设置并发送 workspace.settings.set-global，且乐观生效', () => {
  const h = load();
  h.ctx.SettingsApply.patch({ editor: { wordWrap: false } });

  // 1. 内存中立即更新
  assert.equal(h.ctx.SettingsApply.get().editor.wordWrap, false);
  // 2. DOM wrap 立即生效
  assert.equal(h.editor.getAttribute('wrap'), 'off');
  assert.equal(h.editor.classList.contains('wrap-off'), true);
  // 3. 按钮状态联动
  assert.equal(h.btnWordWrap.classList.contains('active'), false);
  // 4. 发送 set-global 消息
  const lastMsg = h.ipcMessages[h.ipcMessages.length - 1];
  assert.equal(lastMsg.command, 'workspace.settings.set-global');
  const payload = JSON.parse(lastMsg.data);
  assert.equal(payload.editor.wordWrap, false);
});

test('applyWordWrap 驱动按钮 active 状态与 title/aria', () => {
  const h = load();
  h.ctx.SettingsApply.applyWordWrap(true);
  assert.equal(h.btnWordWrap.classList.contains('active'), true);
  assert.equal(h.btnWordWrap.getAttribute('aria-pressed'), 'true');

  h.ctx.SettingsApply.applyWordWrap(false);
  assert.equal(h.btnWordWrap.classList.contains('active'), false);
  assert.equal(h.btnWordWrap.getAttribute('aria-pressed'), 'false');
});
