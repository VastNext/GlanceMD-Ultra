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
 *   - ipc.postMessage 同步响应 get-global / set-global / set-keybindings /
 *     get-effective，磁盘文档保存在 docRef.doc（写入成功后广播 settings-changed）；
 *   - set-keybindings 模拟 commands.rs::apply_keybindings_at 的段级 patch 语义
 *     （以磁盘最新文档为基座、版本守卫、失败经 error 事件透出）；
 *   - localStorage 可预置（遗留镜像 / 迁移标记）。
 * 用例按"重启 / 切方案 / 外部变化 / 顺序交错 / 写入失败 / 未来 schema"维度验证。
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

// Rust 侧模拟：ipc 消息同步回执。磁盘文档 = docRef.doc。
// - set-global：全量落盘（模拟 settings.js 设置 UI 的完整文档写入）后广播变更；
// - set-keybindings：模拟 commands.rs::apply_keybindings_at —— 以磁盘最新文档
//   为基座做段级 patch（activeScheme 替换、schemes 按方案键合并），段内未知键
//   经结构化解析丢弃；版本高于 2 或 failKeybindings 时拒绝落盘并派发 error 事件。
function makeRustSim(ws, docRef, out, state) {
  return function handle(msg) {
    out.push(msg);
    if (msg.command === 'workspace.settings.get-global') {
      ws.fire('workspace:settings-global', { settings: JSON.parse(JSON.stringify(docRef.doc)) });
    } else if (msg.command === 'workspace.settings.set-global') {
      docRef.doc = JSON.parse(msg.data);
      ws.fire('workspace:settings-changed', { scope: 'global' });
    } else if (msg.command === 'workspace.settings.set-keybindings') {
      if (state.failKeybindings) {
        state.errors.push('模拟写入失败');
        ws.fire('workspace:error', { message: '保存快捷键设置失败：模拟写入失败' });
        return;
      }
      const disk = docRef.doc;
      if (disk && typeof disk.version === 'number' && disk.version > 2) {
        state.errors.push('版本过高');
        ws.fire('workspace:error', { message: '已拒绝快捷键写入：设置文档版本 3 高于当前支持的版本 2，无法迁移' });
        return;
      }
      const section = JSON.parse(msg.data);
      const kb = disk.keybindings && typeof disk.keybindings === 'object' ? disk.keybindings : {};
      // 结构化语义：段内未知键（activeScheme/schemes 之外）与全量写一致地丢弃
      docRef.doc = Object.assign({}, disk, {
        version: 2,
        keybindings: {
          activeScheme: section.activeScheme,
          schemes: Object.assign({}, kb.schemes || {}, section.schemes || {}),
        },
      });
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
function loadBridge({ doc, legacy, failKeybindings } = {}) {
  const docRef = { doc: doc ? JSON.parse(JSON.stringify(doc)) : emptyDoc() };
  const ls = {};
  if (legacy) Object.assign(ls, legacy);
  const ipcMessages = [];
  const state = { failKeybindings: Boolean(failKeybindings), errors: [] };
  const ws = makeWorkspace();
  const ipc = { postMessage: (m) => makeRustSim(ws, docRef, ipcMessages, state)(JSON.parse(m)) };

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
  return { ctx, ls, ipcMessages, ws, docRef, state };
}

// 最近一次 set-keybindings 的 data（JSON 解析后）。
function lastSetKeybindings(h) {
  const msg = h.ipcMessages.filter((m) => m.command === 'workspace.settings.set-keybindings').pop();
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

test('启动：无遗留数据时零写入（不产生任何写入命令）', () => {
  const h = loadBridge();
  assert.equal(h.ipcMessages.filter((m) => m.command === 'workspace.settings.set-keybindings').length, 0);
  assert.deepEqual(h.docRef.doc.keybindings, { activeScheme: 'ultra.eclipse', schemes: {} });
});

test('旧 localStorage 启动迁移 → 段级写入设置文档，确认回执后才置迁移标记', () => {
  const legacy = {
    'glancemd-ultra-keybindings': JSON.stringify({
      'file.open': [{ commandId: 'file.open', sequence: 'Alt+O', when: '', platform: '*', source: 'user', removed: false }],
      'editor.undo': [{ commandId: 'editor.undo', sequence: '', when: '', platform: '*', source: 'user', removed: true }],
    }),
    'glancemd-ultra-keyboard-scheme': 'ultra.eclipse',
  };
  const h = loadBridge({ doc: emptyDoc(), legacy });
  // 写入确认链：set-keybindings 落盘成功 → settings-changed → get-global 回执
  // → 磁盘已有用户数据 → 迁移标记补置（防写入失败丢旧数据）
  assert.equal(h.ls['glancemd-ultra-keybindings-migrated'], '1', '确认回执后标记完成');
  const kb = h.docRef.doc.keybindings;
  assert.equal(kb.activeScheme, 'ultra.eclipse');
  const records = kb.schemes['ultra.eclipse'];
  assert.ok(records.some((r) => r.commandId === 'file.open' && r.sequence === 'Alt+O'), '迁移普通覆盖');
  assert.ok(records.some((r) => r.commandId === 'editor.undo' && r.removed === true), '迁移 removed 记录');
  // 迁移写入走段级专用命令（不携带全量文档）
  const kbMsgs = h.ipcMessages.filter((m) => m.command === 'workspace.settings.set-keybindings');
  assert.equal(kbMsgs.length, 1, '迁移只写入一次');
  assert.deepEqual(Object.keys(JSON.parse(kbMsgs[0].data).schemes), ['ultra.eclipse']);
  // 服务已装载迁移后的绑定
  assert.equal(h.ctx.Keybindings.effective()['file.open'], 'Alt+O');
});

test('迁移写入失败：错误可见、迁移标记未置、遗留数据保留', () => {
  const legacyData = {
    'file.open': [{ commandId: 'file.open', sequence: 'Alt+O' }],
  };
  const h = loadBridge({
    doc: emptyDoc(),
    legacy: { 'glancemd-ultra-keybindings': JSON.stringify(legacyData) },
    failKeybindings: true,
  });
  assert.equal(h.state.errors.length, 1, '失败经 error 事件透出（app.js 统一展示）');
  assert.equal(h.ls['glancemd-ultra-keybindings-migrated'], undefined, '失败不置迁移标记');
  assert.deepEqual(
    JSON.parse(h.ls['glancemd-ultra-keybindings']),
    legacyData,
    '遗留 localStorage 旧数据保留，下次启动可重试',
  );
  // 会话内不重试：外部变化触发的刷新不产生第二次写入
  h.ws.fire('workspace:settings-changed', { scope: 'global' });
  assert.equal(h.ipcMessages.filter((m) => m.command === 'workspace.settings.set-keybindings').length, 1, '会话内只尝试一次');
});

test('未来版本磁盘文档：快捷键写入拒绝、不覆写、标记未置', () => {
  const legacyData = { 'file.open': [{ commandId: 'file.open', sequence: 'Alt+O' }] };
  const futureDoc = { version: 3, appearance: { theme: 'dark' }, keybindings: { activeScheme: 'ultra.eclipse', schemes: {} } };
  const h = loadBridge({
    doc: futureDoc,
    legacy: { 'glancemd-ultra-keybindings': JSON.stringify(legacyData) },
  });
  assert.equal(h.state.errors.length, 1, '未来版本拒绝写入并经 error 事件透出');
  assert.deepEqual(h.docRef.doc, futureDoc, '未来版本磁盘文档原样保留，未覆写');
  assert.equal(h.ls['glancemd-ultra-keybindings-migrated'], undefined, '标记未置，旧数据不丢');
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
  assert.equal(h.ipcMessages.filter((m) => m.command === 'workspace.settings.set-keybindings').length, 0, '不重复迁移/回写');
});

test('切方案：分方案独立保存，互不覆盖（后端按方案键合并）', () => {
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

  // 在 vscode 方案下改绑定 → 补丁只携带 vscode 方案；后端以磁盘为基座按键合并
  h.ctx.Keybindings.save({ 'file.open': 'Alt+W' });
  const section = lastSetKeybindings(h);
  assert.equal(section.activeScheme, 'ultra.vscode');
  assert.deepEqual(Object.keys(section.schemes), ['ultra.vscode'], '补丁只含当前方案');
  assert.equal(section.schemes['ultra.vscode'][0].sequence, 'Alt+W');
  // 磁盘最终状态：eclipse 方案绑定原样保留（未回滚）
  assert.equal(h.docRef.doc.keybindings.activeScheme, 'ultra.vscode');
  assert.equal(h.docRef.doc.keybindings.schemes['ultra.eclipse'][0].sequence, 'Alt+O', 'eclipse 方案绑定原样保留');
});

test('写回走后端段级 patch：其他设置分类与未来顶层键不被覆写', () => {
  const h = loadBridge({
    doc: {
      version: 2,
      futureTop: 1,
      appearance: { theme: 'dark' },
      editor: { fontSize: 18 },
      keybindings: {
        activeScheme: 'ultra.eclipse',
        schemes: { 'ultra.eclipse': [{ commandId: 'file.open', sequence: 'Alt+O' }] },
      },
    },
  });
  h.ctx.Keybindings.save({ 'file.open': 'Alt+N' });
  // 后端模拟以磁盘最新文档为基座：keybindings 段之外的一切保留
  assert.equal(h.docRef.doc.appearance.theme, 'dark', '其他设置分类不被覆写');
  assert.equal(h.docRef.doc.editor.fontSize, 18, '其他设置分类不被覆写（editor）');
  assert.equal(h.docRef.doc.futureTop, 1, '未来顶层键保留');
  assert.equal(h.docRef.doc.keybindings.schemes['ultra.eclipse'][0].sequence, 'Alt+N', '当前方案绑定更新');
  assert.equal(h.docRef.doc.version, 2);
});

test('顺序交错：设置 UI 全量写主题后改绑定，主题与字号不回滚', () => {
  const h = loadBridge({
    doc: {
      version: 2,
      appearance: { theme: 'light' },
      editor: { fontSize: 14 },
      keybindings: { activeScheme: 'ultra.eclipse', schemes: {} },
    },
  });
  // 模拟 settings.js：设置面板以 state.global 为基座的全量 set-global 改主题
  const next = JSON.parse(JSON.stringify(h.docRef.doc));
  next.appearance.theme = 'dark';
  next.editor.fontSize = 18;
  h.ctx.ipc.postMessage(JSON.stringify({ command: 'workspace.settings.set-global', data: JSON.stringify(next) }));
  assert.equal(h.docRef.doc.appearance.theme, 'dark');
  // 交错：此刻改快捷键（persist 不再依赖前端 globalDoc 缓存）
  h.ctx.Keybindings.save({ 'file.open': 'Alt+O' });
  assert.equal(h.docRef.doc.appearance.theme, 'dark', '快捷键写入不回滚主题');
  assert.equal(h.docRef.doc.editor.fontSize, 18, '快捷键写入不回滚编辑器字号');
  assert.equal(h.docRef.doc.keybindings.schemes['ultra.eclipse'][0].sequence, 'Alt+O', '绑定已落盘');
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

test('globalDoc 未就绪时的写入：直接经后端段级 patch 落盘（不等回执）', () => {
  // 写入不再依赖前端 globalDoc 缓存做合并基座——后端以磁盘最新文档为基座，
  // 因此 get-global 未回执时用户改绑定也应立即落盘。
  const docRef = { doc: emptyDoc() };
  const ls = {};
  const ipcMessages = [];
  const state = { errors: [] };
  const ws = makeWorkspace();
  let respond = false;
  const ipc = {
    postMessage(m) {
      const msg = JSON.parse(m);
      ipcMessages.push(msg);
      if (!respond) return;
      makeRustSim(ws, docRef, ipcMessages, state)(msg);
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

  // get-global 未回执（respond=false），用户就改了绑定 → 立即发出段级写入
  ctx.Keybindings.save({ 'file.open': 'Alt+O' });
  const section = ipcMessages.filter((m) => m.command === 'workspace.settings.set-keybindings').pop();
  assert.ok(section, '写入直接发出（不暂存等待 get-global）');
  assert.equal(JSON.parse(section.data).schemes['ultra.eclipse'][0].sequence, 'Alt+O');

  // 磁盘文档以真实落盘验证（respond 打开后模拟后端处理在途消息不会重复落盘；
  // 直接复用模拟后端对同一段执行一次，证明段级 patch 语义成立）
  respond = true;
  makeRustSim(ws, docRef, ipcMessages, state)({ command: 'workspace.settings.set-keybindings', data: section.data });
  assert.equal(docRef.doc.keybindings.schemes['ultra.eclipse'][0].sequence, 'Alt+O', '后端以磁盘文档为基座落盘');
});
