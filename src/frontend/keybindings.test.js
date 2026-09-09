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
  assert.equal(h.c.Keybindings.effective()['outline.toggle'], 'Ctrl+Shift+O');
  assert.equal(h.c.Keybindings.effective()['editor.togglePreview'], 'Ctrl+Shift+V');
  assert.equal(h.c.Keybindings.effective()['editor.toggleSplit'], 'Ctrl+\\');
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

/* ═══════════════════════════════════════════════════════════════════════════
 * 设置文档桥接（全局 settings.json 为事实源，schema v2）
 *
 * loadBridge 装载真实 facade（keybindings.js + keybinding-service.js）与
 * SettingsApply（settings-apply.js），并模拟 Rust 侧：
 *   - Workspace 事件分发器（on/fire）；
 *   - ipc.postMessage 同步响应 get-global / set-global / get-effective，
 *     磁盘文档保存在 docRef.doc（set-global 后广播 settings-changed）；
 *   - localStorage 可预置（遗留镜像 / 迁移标记）。
 * 用例按"重启 / 切方案 / 外部变化 / 未来 schema / 不覆写其他设置"维度验证。
 * ═══════════════════════════════════════════════════════════════════════════ */

function makeClassList() {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    toggle(name, force) {
      const on = force === undefined ? !set.has(name) : Boolean(force);
      if (on) set.add(name); else set.delete(name);
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
    attributes: {},
    listeners: {},
    style: {},
    children: [],
  };
  el.classList = makeClassList();
  el.appendChild = (child) => { el.children.push(child); return child; };
  el.removeChild = (child) => { const i = el.children.indexOf(child); if (i >= 0) el.children.splice(i, 1); return child; };
  Object.defineProperty(el, 'textContent', {
    get() { return el.children.length ? el.children.map((c) => c.textContent).join('\n') : (el._text || ''); },
    set(v) { el._text = String(v); el.children = []; },
  });
  el.getBoundingClientRect = () => ({ width: 800, height: 20, top: 0, bottom: 20, left: 0, right: 800 });
  el.addEventListener = (type, handler) => { (el.listeners[type] = el.listeners[type] || []).push(handler); };
  el.setAttribute = (name, value) => { el.attributes[name] = String(value); };
  el.getAttribute = (name) => (name in el.attributes ? el.attributes[name] : null);
  return el;
}

function makeWorkspace() {
  const subs = {};
  return {
    on(event, handler) { (subs[event] = subs[event] || []).push(handler); },
    fire(event, payload) { (subs[event] || []).slice().forEach((h) => h(payload)); },
  };
}

// Rust 侧模拟：ipc 消息同步回执（磁盘文档 = docRef.doc；set-global 落盘后广播变更）
function makeRustSim(ws, docRef, out) {
  return function handle(msg) {
    out.push(msg);
    if (msg.command === 'workspace.settings.get-global') {
      ws.fire('workspace:settings-global', { settings: JSON.parse(JSON.stringify(docRef.doc)) });
    } else if (msg.command === 'workspace.settings.set-global') {
      docRef.doc = JSON.parse(msg.data);
      ws.fire('workspace:settings-changed', { scope: 'global' });
    } else if (msg.command === 'workspace.settings.get-effective') {
      ws.fire('workspace:settings-effective', { settings: JSON.parse(JSON.stringify(docRef.doc)) });
    }
  };
}

function emptyDoc() {
  return { version: 2, keybindings: { activeScheme: 'ultra.eclipse', schemes: {} } };
}

// 装载 keybindings + settings-apply 全套（真实 facade + SettingsApply 事件流）。
function loadBridge({ doc, legacy } = {}) {
  const docRef = { doc: doc ? JSON.parse(JSON.stringify(doc)) : emptyDoc() };
  const ls = {};
  if (legacy) Object.assign(ls, legacy);
  const ipcMessages = [];
  const ws = makeWorkspace();
  const ipc = { postMessage: (m) => makeRustSim(ws, docRef, ipcMessages)(JSON.parse(m)) };

  const vars = {};
  const documentElement = {
    dataset: {},
    setAttribute: (name, value) => { if (name === 'data-theme') documentElement.dataset.theme = String(value); },
    style: {
      setProperty: (name, value) => { vars[name] = String(value); },
      getPropertyValue: (name) => (name in vars ? vars[name] : ''),
    },
  };
  const byId = {
    editor: makeElement('editor'),
    'editor-gutter': makeElement('editor-gutter'),
    'editor-container': makeElement('editor-container'),
  };

  const ctx = {
    console,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    localStorage: {
      getItem: (k) => (k in ls ? ls[k] : null),
      setItem: (k, v) => { ls[k] = String(v); },
      removeItem: (k) => { delete ls[k]; },
    },
    document: {
      documentElement,
      addEventListener() {},
      getElementById: (id) => byId[id] || null,
      createElement: (tag) => makeElement(tag),
    },
    ipc,
    Workspace: ws,
  };
  ctx.window = ctx;
  ctx.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  ctx.window.getComputedStyle = () => ({});
  ctx.CustomEvent = function CustomEvent(type, opts) { this.type = type; this.detail = opts && opts.detail; };
  ctx.dispatchEvent = () => true;

  const scripts = [
    'context-keys.js',
    'when-clause.js',
    'keybinding-parser.js',
    'default-keybindings.js',
    'keybinding-service.js',
    'keybindings.js',
    'settings-apply.js',
  ];
  scripts.forEach((f) => vm.runInNewContext(fs.readFileSync('src/frontend/' + f, 'utf8'), ctx, { filename: f }));
  return { ctx, ls, ipcMessages, ws, docRef };
}

// 最近一次 set-global 的 data（JSON 解析后）。
function lastSetGlobal(h) {
  const msg = h.ipcMessages.filter((m) => m.command === 'workspace.settings.set-global').pop();
  return msg ? JSON.parse(msg.data) : null;
}

test('启动：设置文档 keybindings 经 SettingsApply 事件装载到服务', () => {
  const h = loadBridge({
    doc: {
      version: 2,
      keybindings: {
        activeScheme: 'ultra.eclipse',
        schemes: { 'ultra.eclipse': [{ commandId: 'file.open', sequence: 'Alt+O' }] },
      },
    },
  });
  assert.equal(h.ctx.Keybindings.effective()['file.open'], 'Alt+O');
  const overrides = h.ctx.Keybindings.overrides();
  assert.equal(overrides['file.open'], 'Alt+O');
  assert.equal(h.ctx.Keybindings.getScheme(), 'ultra.eclipse');
});

test('启动：无遗留数据时零写入（不产生 set-global）', () => {
  const h = loadBridge();
  assert.equal(h.ipcMessages.filter((m) => m.command === 'workspace.settings.set-global').length, 0);
  assert.deepEqual(h.docRef.doc.keybindings, { activeScheme: 'ultra.eclipse', schemes: {} });
});

test('旧 localStorage 启动迁移 → 写入设置文档并置迁移标记', () => {
  const legacy = {
    'glancemd-ultra-keybindings': JSON.stringify({
      'file.open': [{ commandId: 'file.open', sequence: 'Alt+O', when: '', platform: '*', source: 'user', removed: false }],
      'editor.undo': [{ commandId: 'editor.undo', sequence: '', when: '', platform: '*', source: 'user', removed: true }],
    }),
    'glancemd-ultra-keyboard-scheme': 'ultra.eclipse',
  };
  const h = loadBridge({ doc: emptyDoc(), legacy });
  // 设置文档成为事实源：schemes.ultra.eclipse 含迁移记录（removed 保留）
  const kb = h.docRef.doc.keybindings;
  assert.equal(kb.activeScheme, 'ultra.eclipse');
  const records = kb.schemes['ultra.eclipse'];
  assert.ok(records.some((r) => r.commandId === 'file.open' && r.sequence === 'Alt+O'), '迁移普通覆盖');
  assert.ok(records.some((r) => r.commandId === 'editor.undo' && r.removed === true), '迁移 removed 记录');
  assert.equal(h.ls['glancemd-ultra-keybindings-migrated'], '1', '迁移标记防重入');
  // 服务已装载迁移后的绑定
  assert.equal(h.ctx.Keybindings.effective()['file.open'], 'Alt+O');
});

test('重启：设置文档优先于 localStorage 镜像（迁移不重复执行）', () => {
  const doc = {
    version: 2,
    keybindings: {
      activeScheme: 'ultra.vscode',
      schemes: { 'ultra.vscode': [{ commandId: 'file.open', sequence: 'Alt+V' }] },
    },
  };
  // 镜像携带过期数据 + 迁移标记已置
  const legacy = {
    'glancemd-ultra-keybindings': JSON.stringify({ 'file.open': [{ commandId: 'file.open', sequence: 'Alt+STALE' }] }),
    'glancemd-ultra-keybindings-migrated': '1',
  };
  const h = loadBridge({ doc, legacy });
  assert.equal(h.ctx.Keybindings.effective()['file.open'], 'Alt+V', '设置文档为事实源');
  assert.equal(h.ctx.Keybindings.getScheme(), 'ultra.vscode');
  assert.equal(h.ipcMessages.filter((m) => m.command === 'workspace.settings.set-global').length, 0, '不重复迁移/回写');
});

test('切方案：分方案独立保存，互不覆盖', () => {
  const h = loadBridge({
    doc: {
      version: 2,
      keybindings: {
        activeScheme: 'ultra.eclipse',
        schemes: {
          'ultra.eclipse': [{ commandId: 'file.open', sequence: 'Alt+O' }],
          'ultra.vscode': [{ commandId: 'file.open', sequence: 'Alt+V' }],
        },
      },
    },
  });
  assert.equal(h.ctx.Keybindings.effective()['file.open'], 'Alt+O', '当前方案 eclipse');

  h.ctx.Keybindings.setScheme('ultra.vscode');
  assert.equal(h.ctx.Keybindings.getScheme(), 'ultra.vscode');
  assert.equal(h.ctx.Keybindings.effective()['file.open'], 'Alt+V', '切方案后装载 vscode 独立绑定');

  // 在 vscode 方案下改绑定 → 回写仅动 vscode 方案条目
  h.ctx.Keybindings.save({ 'file.open': 'Alt+W' });
  const payload = lastSetGlobal(h);
  assert.equal(payload.keybindings.activeScheme, 'ultra.vscode');
  assert.equal(payload.keybindings.schemes['ultra.vscode'][0].sequence, 'Alt+W');
  assert.equal(payload.keybindings.schemes['ultra.eclipse'][0].sequence, 'Alt+O', 'eclipse 方案绑定原样保留');
});

test('写回以 get-global 为合并基座：不覆写其他设置，未来键保留', () => {
  const h = loadBridge({
    doc: {
      version: 2,
      futureTop: 1,
      appearance: { theme: 'dark' },
      editor: { fontSize: 18 },
      keybindings: {
        activeScheme: 'ultra.eclipse',
        futureKb: 'x',
        schemes: { 'ultra.eclipse': [{ commandId: 'file.open', sequence: 'Alt+O' }] },
      },
    },
  });
  h.ctx.Keybindings.save({ 'file.open': 'Alt+N' });
  const payload = lastSetGlobal(h);
  assert.equal(payload.appearance.theme, 'dark', '其他设置分类不被覆写');
  assert.equal(payload.editor.fontSize, 18, '其他设置分类不被覆写（editor）');
  assert.equal(payload.futureTop, 1, '未来顶层键保留');
  assert.equal(payload.keybindings.futureKb, 'x', 'keybindings 未来键保留');
  assert.equal(payload.keybindings.schemes['ultra.eclipse'][0].sequence, 'Alt+N', '当前方案绑定更新');
  assert.equal(payload.version, 2);
});

test('外部设置变化（另一窗口/手动改 JSON）：settings-changed 后装载新 keybindings', () => {
  const h = loadBridge({
    doc: {
      version: 2,
      keybindings: { activeScheme: 'ultra.eclipse', schemes: { 'ultra.eclipse': [{ commandId: 'file.open', sequence: 'Alt+O' }] } },
    },
  });
  assert.equal(h.ctx.Keybindings.effective()['file.open'], 'Alt+O');
  // 外部改写磁盘文档
  h.docRef.doc.keybindings = {
    activeScheme: 'ultra.vscode',
    schemes: { 'ultra.vscode': [{ commandId: 'file.open', sequence: 'Alt+EXT' }] },
  };
  h.ws.fire('workspace:settings-changed', { scope: 'global' });
  assert.equal(h.ctx.Keybindings.getScheme(), 'ultra.vscode');
  assert.equal(h.ctx.Keybindings.effective()['file.open'], 'Alt+EXT', '外部变化生效');
});

test('globalDoc 未就绪时的写入：暂存并等 get-global 回执后落盘', () => {
  // 手工构造：get-global 延迟回执，期间用户先改绑定 → 应暂存等待合并基座
  const docRef = { doc: emptyDoc() };
  const ls = {};
  const ipcMessages = [];
  const ws = makeWorkspace();
  let respond = false;
  const ipc = {
    postMessage(m) {
      const msg = JSON.parse(m);
      ipcMessages.push(msg);
      if (!respond) return;
      if (msg.command === 'workspace.settings.get-global') {
        ws.fire('workspace:settings-global', { settings: JSON.parse(JSON.stringify(docRef.doc)) });
      } else if (msg.command === 'workspace.settings.set-global') {
        docRef.doc = JSON.parse(msg.data);
        ws.fire('workspace:settings-changed', { scope: 'global' });
      } else if (msg.command === 'workspace.settings.get-effective') {
        ws.fire('workspace:settings-effective', { settings: JSON.parse(JSON.stringify(docRef.doc)) });
      }
    },
  };
  const vars = {};
  const documentElement = {
    dataset: {},
    style: { setProperty: (n, v) => { vars[n] = String(v); }, getPropertyValue: (n) => vars[n] || '' },
  };
  const byId = { editor: makeElement('editor'), 'editor-gutter': makeElement('editor-gutter'), 'editor-container': makeElement('editor-container') };
  const ctx = {
    console,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    localStorage: {
      getItem: (k) => (k in ls ? ls[k] : null),
      setItem: (k, v) => { ls[k] = String(v); },
      removeItem: (k) => { delete ls[k]; },
    },
    document: { documentElement, addEventListener() {}, getElementById: (id) => byId[id] || null, createElement: (t) => makeElement(t) },
    ipc,
    Workspace: ws,
  };
  ctx.window = ctx;
  ctx.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  ctx.window.getComputedStyle = () => ({});
  ctx.CustomEvent = function CustomEvent(type, opts) { this.type = type; this.detail = opts && opts.detail; };
  ctx.dispatchEvent = () => true;
  ['context-keys.js', 'when-clause.js', 'keybinding-parser.js', 'default-keybindings.js', 'keybinding-service.js', 'keybindings.js', 'settings-apply.js']
    .forEach((f) => vm.runInNewContext(fs.readFileSync('src/frontend/' + f, 'utf8'), ctx, { filename: f }));

  // 此时 get-global 未回执，用户就改了绑定 → 应暂存
  ctx.Keybindings.save({ 'file.open': 'Alt+O' });
  assert.equal(ipcMessages.filter((m) => m.command === 'workspace.settings.set-global').length, 0, '未落盘');
  assert.ok(ipcMessages.some((m) => m.command === 'workspace.settings.get-global'), '已请求合并基座');

  // get-global 回执到达 → 冲刷暂存写入
  respond = true;
  ws.fire('workspace:settings-global', { settings: docRef.doc });
  const payload = ipcMessages.filter((m) => m.command === 'workspace.settings.set-global').pop();
  assert.ok(payload, '回执后落盘');
  assert.equal(JSON.parse(payload.data).keybindings.schemes['ultra.eclipse'][0].sequence, 'Alt+O');
});
