const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// recovery.js 单测（node:test + vm，零依赖，stub 风格照 smoke.test.js / layout.test.js）。
// 与页面装载顺序一致：commands.js → workspace.js → recovery.js 同一 vm 上下文依序执行，
// 下行事件经真实 window.Workspace.dispatch 注入，上行消息经 window.ipc mock 捕获。
const FRONTEND = __dirname;
const I18N_SOURCE = fs.readFileSync(path.join(FRONTEND, 'i18n.js'), 'utf8');
const COMMANDS_SOURCE = fs.readFileSync(path.join(FRONTEND, 'commands.js'), 'utf8');
const WORKSPACE_SOURCE = fs.readFileSync(path.join(FRONTEND, 'workspace.js'), 'utf8');
const SOURCE = fs.readFileSync(path.join(FRONTEND, 'recovery.js'), 'utf8');

/* ── 最小 DOM stub（支持类/标签选择器的后代查询） ── */

function matchSelector(el, selector) {
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  return el.tagName === selector.toUpperCase();
}

function descendants(el) {
  const out = [];
  (el.children || []).forEach((child) => {
    if (!child || child.nodeType === 3) return;
    out.push(child);
    out.push(...descendants(child));
  });
  return out;
}

function makeElement(tag) {
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    listeners: {},
    dataset: {},
    attributes: {},
    style: {},
    textContent: '',
    value: '',
    offsetHeight: 0,
    parentNode: null,
    appendChild(child) {
      el.children.push(child);
      child.parentNode = el;
      return child;
    },
    insertBefore(node, ref) {
      const idx = ref ? el.children.indexOf(ref) : -1;
      if (idx === -1) el.children.push(node);
      else el.children.splice(idx, 0, node);
      node.parentNode = el;
      return node;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i !== -1) el.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, handler) {
      (el.listeners[type] = el.listeners[type] || []).push(handler);
    },
    removeEventListener() {},
    setAttribute(name, value) {
      el.attributes[name] = String(value);
    },
    getAttribute(name) {
      return name in el.attributes ? el.attributes[name] : null;
    },
    classList: {
      add(...names) { names.forEach((n) => classes.add(n)); },
      remove(...names) { names.forEach((n) => classes.delete(n)); },
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains(name) { return classes.has(name); },
    },
    querySelector(selector) {
      const parts = String(selector).split(',').map((s) => s.trim());
      return descendants(el).find((d) => parts.some((s) => matchSelector(d, s))) || null;
    },
    querySelectorAll(selector) {
      const parts = String(selector).split(',').map((s) => s.trim());
      return descendants(el).filter((d) => parts.some((s) => matchSelector(d, s)));
    },
    dispatchEvent(ev) {
      (el.listeners[ev.type] || []).forEach((fn) => fn(ev));
      return true;
    },
    click() {
      el.dispatchEvent({ type: 'click' });
    },
    scrollIntoView() {},
    getBoundingClientRect() {
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    },
    focus() {},
    select() {},
  };
  Object.defineProperty(el, 'className', {
    get: () => Array.from(classes).join(' '),
    set: (v) => {
      classes.clear();
      String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
  });
  let innerHTMLValue = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => innerHTMLValue,
    set: (value) => {
      innerHTMLValue = String(value);
      el.children.length = 0;
    },
  });
  return el;
}

function fire(el, type) {
  (el.listeners[type] || []).forEach((fn) => fn({ type, preventDefault() {} }));
}

/* ── 装载 harness ── */

function loadHarness(opts = {}) {
  const observers = [];
  const intervals = [];
  const ipcMessages = [];
  const windowEvents = [];
  const clipboardWrites = [];

  const ids = {};
  const byId = (id) => (ids[id] = ids[id] || makeElement('div'));

  // 页面骨架：body > [titlebar 占位, #content]；横幅栈将被插到两者之间。
  // 常用节点（tab-bar/editor/status-file/titlebar-title）预置空元素，测试按需填充。
  const documentElement = makeElement('html');
  documentElement.style.setProperty = (name, value) => {
    documentElement.style[name] = String(value);
  };
  const body = makeElement('body');
  body.appendChild(byId('titlebar'));
  body.appendChild(byId('content'));
  byId('tab-bar');
  byId('editor');
  byId('status-file');
  byId('titlebar-title');

  const doc = {
    documentElement,
    body,
    getElementById: (id) => (ids[id] ? ids[id] : null),
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    addEventListener() {},
  };

  const windowObj = {
    ipc: { postMessage: (msg) => ipcMessages.push(JSON.parse(msg)) },
    dispatchEvent: (ev) => {
      windowEvents.push(ev);
      return true;
    },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval() {},
    setTimeout() { return 0; },
    clearTimeout() {},
  };
  if (opts.tabManager) windowObj.TabManager = opts.tabManager;

  class MutationObserverStub {
    constructor(cb) {
      this.cb = cb;
      observers.push(this);
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
    }
    disconnect() {
      this.disconnected = true;
    }
  }

  const context = {
    window: windowObj,
    document: doc,
    navigator: { clipboard: { writeText: (text) => clipboardWrites.push(text) } },
    MutationObserver: MutationObserverStub,
    console,
  };
  if (opts.customEvent) {
    context.CustomEvent = function CustomEvent(type, params) {
      this.type = type;
      this.detail = params && params.detail;
    };
  }

  vm.createContext(context);
  vm.runInContext(I18N_SOURCE, context, { filename: 'i18n.js' }); // recovery.js 的 t() 依赖
  vm.runInContext(COMMANDS_SOURCE, context, { filename: 'commands.js' });
  vm.runInContext(WORKSPACE_SOURCE, context, { filename: 'workspace.js' });
  vm.runInContext(SOURCE, context, { filename: 'recovery.js' });

  return {
    ids,
    body,
    content: ids['content'],
    ipcMessages,
    windowEvents,
    clipboardWrites,
    observers,
    intervals,
    documentElement,
    Commands: windowObj.Commands,
    RecoveryUI: windowObj.RecoveryUI,
    dispatch(event, data) {
      windowObj.Workspace.dispatch(event, data);
    },
    makeTab({ name, dirty = false, active = false, tabId = '1' }) {
      const tab = makeElement('div');
      tab.className = 'tab' + (active ? ' active' : '');
      tab.dataset.tabId = tabId;
      const label = makeElement('span');
      label.className = 'tab-label';
      label.textContent = name;
      tab.appendChild(label);
      let dot = null;
      if (dirty) {
        dot = makeElement('span');
        dot.className = 'tab-dirty';
        dot.textContent = '•';
        tab.appendChild(dot);
      }
      ids['tab-bar'].appendChild(tab);
      return { tab, dot };
    },
    stack() {
      return body.children.find((c) => c.id === 'conflict-banner-stack') || null;
    },
    banners() {
      const stack = this.stack();
      return stack ? stack.children.filter((n) => n.classList.contains('recovery-banner')) : [];
    },
    moreRow() {
      const stack = this.stack();
      return stack ? stack.children.find((n) => n.classList.contains('recovery-banner-more')) : null;
    },
    panel() {
      return body.children.find((c) => c.id === 'recovery-panel') || null;
    },
    restored() {
      return body.children.find((c) => c.id === 'recovery-restored-overlay') || null;
    },
    buttonIn(container, text) {
      return descendants(container).find(
        (n) => n.tagName === 'BUTTON' && n.textContent === text) || null;
    },
    pushValue() {
      return documentElement.style['--recovery-push'];
    },
  };
}

const PATH = 'G:/proj/notes/a.md';
function modifiedEvent(path, ts) {
  return { path: path || PATH, kind: 'modified', ts: ts == null ? 1730000000000 : ts };
}

/* ══════════ 装载与注册 ══════════ */

test('装载后挂载 window.RecoveryUI 并注册 recovery.* 命令', () => {
  const h = loadHarness();
  assert.ok(h.RecoveryUI);
  assert.equal(typeof h.RecoveryUI.needsConfirm, 'function');
  ['recovery.reload', 'recovery.keep-edited', 'recovery.confirm-overwrite', 'recovery.save-as',
    'recovery.close-tab', 'recovery.restore-entry', 'recovery.discard-entry', 'recovery.discard-all',
  ].forEach((id) => assert.equal(h.Commands.has(id), true, id));
  assert.equal(h.intervals[0].ms, 30000, '周期快照定时器为 30s');
});

test('Modified × dirty：出现琥珀横幅，插在 #content 之前并注入下推量', () => {
  const h = loadHarness();
  h.makeTab({ name: 'a.md', dirty: true, active: true });

  h.dispatch('workspace:file-changed', modifiedEvent(PATH));

  const banners = h.banners();
  assert.equal(banners.length, 1);
  assert.equal(banners[0].classList.contains('recovery-banner--modified'), true);
  assert.equal(banners[0].getAttribute('data-path'), PATH);
  assert.equal(h.banners()[0].querySelector('.recovery-keep-note'), null, '初态无保留警示条');
  assert.equal(
    h.body.children.indexOf(h.stack()) < h.body.children.indexOf(h.content), true,
    '横幅栈插在 #content 之前（下推而非遮挡）');

  // 下推量经 CSS 变量注入（值 = 横幅栈 offsetHeight，stub 中手工设定）
  h.stack().offsetHeight = 92;
  h.makeTab({ name: 'b.md', dirty: true });
  h.dispatch('workspace:file-changed', modifiedEvent('G:/proj/notes/b.md', 1730000001000));
  assert.equal(h.pushValue(), '92px');
});

test('Modified × clean：不弹横幅', () => {
  const h = loadHarness();
  h.makeTab({ name: 'a.md', dirty: false, active: true });

  h.dispatch('workspace:file-changed', modifiedEvent(PATH));

  assert.equal(h.banners().length, 0);
});

test('Removed：红色变体（另存为/关闭，无重新加载）', () => {
  const h = loadHarness();
  h.makeTab({ name: 'a.md', dirty: true, active: true });

  h.dispatch('workspace:file-changed', { path: PATH, kind: 'removed', ts: 1730000000000 });

  const banner = h.banners()[0];
  assert.equal(banner.classList.contains('recovery-banner--removed'), true);
  assert.ok(h.buttonIn(banner, '另存为…'));
  assert.ok(h.buttonIn(banner, '关闭'));
  assert.equal(h.buttonIn(banner, '重新加载'), null, '删除变体不提供重新加载');
});

test('同一文件已有横幅不重复（仅更新时间戳）', () => {
  const h = loadHarness();
  h.makeTab({ name: 'a.md', dirty: true, active: true });

  h.dispatch('workspace:file-changed', modifiedEvent(PATH, 1730000000000));
  h.dispatch('workspace:file-changed', modifiedEvent(PATH, 1730009999999));

  assert.equal(h.banners().length, 1);
  assert.equal(h.RecoveryUI.getActiveConflicts()[0].ts, 1730009999999, '时间戳取最新');
});

test('多文件横幅堆叠上限：3 条 + "…还有 N 个"', () => {
  const h = loadHarness();
  h.makeTab({ name: 'a.md', dirty: true, active: true });
  h.makeTab({ name: 'b.md', dirty: true });
  h.makeTab({ name: 'c.md', dirty: true });
  h.makeTab({ name: 'd.md', dirty: true });

  ['a.md', 'b.md', 'c.md', 'd.md'].forEach((name, i) => {
    h.dispatch('workspace:file-changed', modifiedEvent('G:/proj/' + name, 1730000000000 + i));
  });

  assert.equal(h.banners().length, 3);
  assert.match(h.moreRow().textContent, /还有 1 个文件冲突/);
});

test('× 关闭为暂时关闭（dismiss-banner 移除横幅，事件再变时重现）', () => {
  const h = loadHarness();
  h.makeTab({ name: 'a.md', dirty: true, active: true });
  h.dispatch('workspace:file-changed', modifiedEvent(PATH));

  fire(h.buttonIn(h.banners()[0], '×'), 'click');
  assert.equal(h.banners().length, 0);

  h.dispatch('workspace:file-changed', modifiedEvent(PATH, 1730009999999));
  assert.equal(h.banners().length, 1);
});

/* ══════════ 按钮命令派发 ══════════ */

test('重新加载：经 open_file+path 派发并撤下横幅', () => {
  const h = loadHarness();
  h.makeTab({ name: 'a.md', dirty: true, active: true });
  h.dispatch('workspace:file-changed', modifiedEvent(PATH));

  fire(h.buttonIn(h.banners()[0], '重新加载'), 'click');

  assert.deepEqual(h.ipcMessages.find((m) => m.command === 'open_file'),
    { command: 'open_file', path: PATH });
  assert.equal(h.banners().length, 0, '点击后乐观撤下横幅');
});

test('重新加载：相对路径经 workspace:opened 的根拼接为绝对路径', () => {
  const h = loadHarness();
  h.makeTab({ name: 'a.md', dirty: true, active: true });
  h.dispatch('workspace:opened', { root: 'G:/proj', file_count: 0 });
  h.dispatch('workspace:file-changed', modifiedEvent('notes/a.md'));

  fire(h.buttonIn(h.banners()[0], '重新加载'), 'click');

  assert.deepEqual(h.ipcMessages.find((m) => m.command === 'open_file'),
    { command: 'open_file', path: 'G:/proj/notes/a.md' });
});

test('另存为：先激活对应 tab 再以 #editor 当前内容派发 save_as', () => {
  const h = loadHarness();
  const entry = h.makeTab({ name: 'a.md', dirty: true });
  h.makeTab({ name: 'b.md', dirty: true, active: true });
  h.dispatch('workspace:file-changed', modifiedEvent(PATH));
  h.ids['editor'].value = '# 保留的草稿内容';

  const clicks = [];
  entry.tab.addEventListener('click', () => clicks.push('a.md'));
  fire(h.buttonIn(h.banners()[0], '另存为…'), 'click');

  assert.deepEqual(clicks, ['a.md'], '先激活受影响的 tab');
  assert.deepEqual(h.ipcMessages.find((m) => m.command === 'save_as'),
    { command: 'save_as', content: '# 保留的草稿内容' });
});

test('关闭按钮（Removed 变体）：经 TabManager.closeTab 关闭并撤下横幅', () => {
  const closed = [];
  const h = loadHarness({
    tabManager: { getActiveTab: () => null, closeTab: (id) => closed.push(id) },
  });
  const entry = h.makeTab({ name: 'a.md', dirty: true, active: true, tabId: '5' });
  h.dispatch('workspace:file-changed', { path: PATH, kind: 'removed', ts: 1730000000000 });

  fire(h.buttonIn(h.banners()[0], '关闭'), 'click');

  assert.deepEqual(closed, [5]);
  assert.equal(h.banners().length, 0);
  assert.equal(h.ids['tab-bar'].children.indexOf(entry.tab) !== -1, true, 'tab 移除由 TabManager 负责');
});

/* ══════════ 保留编辑版本与二次确认 ══════════ */

test('保留编辑版本：needsConfirm 置位、常驻警示条出现、按钮收敛', () => {
  const h = loadHarness();
  h.makeTab({ name: 'a.md', dirty: true, active: true });
  h.dispatch('workspace:file-changed', modifiedEvent(PATH));

  assert.equal(h.RecoveryUI.needsConfirm(PATH), false);
  fire(h.buttonIn(h.banners()[0], '保留编辑版本'), 'click');

  assert.equal(h.RecoveryUI.needsConfirm(PATH), true);
  assert.equal(h.RecoveryUI.needsConfirm('g:\\PROJ\\NOTES\\A.MD'), true, '路径归一（大小写/斜杠不敏感）');
  assert.equal(h.banners().length, 1, '横幅保留为常驻警示');
  assert.match(h.banners()[0].querySelector('.recovery-keep-note').textContent, /保存将被覆盖/);
  assert.equal(h.buttonIn(h.banners()[0], '保留编辑版本'), null, '已保留后按钮收敛');
});

test('保留后再次外部变更（仍 dirty）→ 横幅重现且不重复', () => {
  const h = loadHarness();
  h.makeTab({ name: 'a.md', dirty: true, active: true });
  h.dispatch('workspace:file-changed', modifiedEvent(PATH));
  fire(h.buttonIn(h.banners()[0], '保留编辑版本'), 'click');

  h.dispatch('workspace:file-changed', modifiedEvent(PATH, 1730009999999));

  assert.equal(h.banners().length, 1);
  assert.equal(h.RecoveryUI.needsConfirm(PATH), true, '保留标记不受再次变更影响');
});

test('recovery.confirm-overwrite：解除 needsConfirm 并移除横幅', () => {
  const h = loadHarness();
  h.makeTab({ name: 'a.md', dirty: true, active: true });
  h.dispatch('workspace:file-changed', modifiedEvent(PATH));
  fire(h.buttonIn(h.banners()[0], '保留编辑版本'), 'click');

  h.Commands.run('recovery.confirm-overwrite', { path: PATH });

  assert.equal(h.RecoveryUI.needsConfirm(PATH), false);
  assert.equal(h.banners().length, 0);
});

test('保留标记随 tab 转为 clean 自动解除（tab 栏 MutationObserver 驱动）', () => {
  const h = loadHarness();
  const entry = h.makeTab({ name: 'a.md', dirty: true, active: true });
  h.dispatch('workspace:file-changed', modifiedEvent(PATH));
  fire(h.buttonIn(h.banners()[0], '保留编辑版本'), 'click');
  assert.equal(h.observers.length, 1, 'tab 栏观察器已接线');
  assert.equal(h.observers[0].target, h.ids['tab-bar']);

  entry.tab.removeChild(entry.dot); // 模拟保存成功后 dirty 圆点消失
  h.observers[0].cb();

  assert.equal(h.RecoveryUI.needsConfirm(PATH), false);
  assert.equal(h.banners().length, 0, '已保存/还原后横幅一并撤下');
});

test('保留标记随 tab 关闭自动解除', () => {
  const h = loadHarness();
  const entry = h.makeTab({ name: 'a.md', dirty: true, active: true });
  h.dispatch('workspace:file-changed', modifiedEvent(PATH));
  fire(h.buttonIn(h.banners()[0], '保留编辑版本'), 'click');

  h.ids['tab-bar'].removeChild(entry.tab);
  h.RecoveryUI.recheck();

  assert.equal(h.RecoveryUI.needsConfirm(PATH), false);
  assert.equal(h.banners().length, 0);
});

test('clean × Modified 清除遗留横幅与保留标记', () => {
  const h = loadHarness();
  const entry = h.makeTab({ name: 'a.md', dirty: true, active: true });
  h.dispatch('workspace:file-changed', modifiedEvent(PATH));
  fire(h.buttonIn(h.banners()[0], '保留编辑版本'), 'click');

  entry.tab.removeChild(entry.dot); // 转为 clean（自动重载场景）
  h.dispatch('workspace:file-changed', modifiedEvent(PATH, 1730009999999));

  assert.equal(h.banners().length, 0);
  assert.equal(h.RecoveryUI.needsConfirm(PATH), false);
});

/* ══════════ 重命名/移动路径迁移 ══════════ */

test('watcher rename 事件：横幅路径静默迁移到新路径', () => {
  const h = loadHarness();
  h.makeTab({ name: 'a.md', dirty: true, active: true });
  h.dispatch('workspace:file-changed', modifiedEvent(PATH));

  h.dispatch('workspace:file-changed', {
    path: 'G:/proj/notes/b.md', kind: 'renamed',
    from: PATH, to: 'G:/proj/notes/b.md', ts: 1730000005000,
  });

  const conflicts = h.RecoveryUI.getActiveConflicts();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, 'G:/proj/notes/b.md');
});

test('fs-op-done rename/move：保留标记与横幅路径同步迁移', () => {
  const h = loadHarness();
  h.makeTab({ name: 'a.md', dirty: true, active: true });
  h.dispatch('workspace:file-changed', modifiedEvent(PATH));
  fire(h.buttonIn(h.banners()[0], '保留编辑版本'), 'click');

  h.dispatch('workspace:fs-op-done', { op: 'move', paths: [PATH, 'G:/proj/archived/a.md'], undo_id: 3 });
  assert.equal(h.RecoveryUI.needsConfirm('G:/proj/archived/a.md'), true);
  assert.equal(h.RecoveryUI.getActiveConflicts()[0].path, 'G:/proj/archived/a.md');

  h.dispatch('workspace:fs-op-done', { op: 'undo-move', paths: ['G:/proj/archived/a.md', PATH], undo_id: 3 });
  assert.equal(h.RecoveryUI.needsConfirm(PATH), true, '撤销移动后迁回原路径');
});

/* ══════════ 周期快照 ══════════ */

function setupSnapshot(h) {
  h.makeTab({ name: 'a.md', dirty: true, active: true, tabId: '7' });
  h.ids['editor'].value = '# 草稿 v1';
}

test('周期快照：dirty 活动 tab 发送 snapshot（tab_id/path/content/saved_at_ms）', () => {
  const h = loadHarness({
    tabManager: { getActiveTab: () => ({ id: 7, path: PATH, dirty: true }) },
  });
  setupSnapshot(h);
  const before = Date.now();

  h.intervals[0].fn();

  const msgs = h.ipcMessages.filter((m) => m.command === 'workspace.recovery.snapshot');
  assert.equal(msgs.length, 1);
  const payload = JSON.parse(msgs[0].data);
  assert.deepEqual(Object.keys(payload).sort(), ['content', 'path', 'saved_at_ms', 'tab_id']);
  assert.equal(payload.tab_id, '7');
  assert.equal(payload.path, PATH);
  assert.equal(payload.content, '# 草稿 v1');
  assert.ok(payload.saved_at_ms >= before, 'saved_at_ms 取发送时刻');
});

test('周期快照：内容与上次相同则跳过，变化后重发', () => {
  const h = loadHarness();
  setupSnapshot(h);

  h.intervals[0].fn();
  h.intervals[0].fn();
  assert.equal(h.ipcMessages.length, 1, '同值跳过');

  h.ids['editor'].value = '# 草稿 v2';
  h.intervals[0].fn();
  const msgs = h.ipcMessages.filter((m) => m.command === 'workspace.recovery.snapshot');
  assert.equal(msgs.length, 2);
  assert.equal(JSON.parse(msgs[1].data).content, '# 草稿 v2');
});

test('周期快照：clean 活动 tab 与空内容均跳过', () => {
  const h = loadHarness();
  h.makeTab({ name: 'a.md', dirty: false, active: true });
  h.ids['editor'].value = '# 已保存';

  h.intervals[0].fn();
  assert.equal(h.ipcMessages.length, 0, 'clean tab 不快照');

  h.ids['editor'].value = '';
  h.makeTab({ name: 'a.md', dirty: true, active: true, tabId: '9' });
  h.intervals[0].fn();
  assert.equal(h.ipcMessages.length, 0, '空内容不快照');
});

test('周期快照：TabManager 不可用时 path 记 null 仍可快照', () => {
  const h = loadHarness();
  setupSnapshot(h);

  h.intervals[0].fn();

  const msgs = h.ipcMessages.filter((m) => m.command === 'workspace.recovery.snapshot');
  assert.equal(msgs.length, 1);
  assert.equal(JSON.parse(msgs[0].data).path, null);
});

test('周期快照：负载走 data 字段 JSON（信封契约 §1.1 扩展）', () => {
  const h = loadHarness();
  setupSnapshot(h);

  h.intervals[0].fn();

  const msg = h.ipcMessages[0];
  assert.equal(typeof msg.data, 'string');
  assert.equal(JSON.parse(msg.data).tab_id, '7');
});

/* ══════════ 崩溃恢复面板 ══════════ */

function recoveryEntries() {
  return [
    { tab_id: 't1', path: 'G:/proj/notes/one.md', saved_at_ms: 1730000000000 },
    { tab_id: 't2', path: null, saved_at_ms: 1730000100000 },
  ];
}

function panelRows(h) {
  return h.panel().children.filter((n) => n.classList.contains('recovery-entry'));
}

test('recovery-available：有条目时显示恢复面板（路径 + 时间 + 逐条恢复/丢弃 + 全部丢弃）', () => {
  const h = loadHarness();
  h.dispatch('workspace:recovery-available', { entries: recoveryEntries(), warnings: [] });

  const panel = h.panel();
  assert.ok(panel);
  assert.equal(panel.classList.contains('visible'), true);
  assert.deepEqual(h.RecoveryUI.getPendingEntries().map((e) => e.tab_id), ['t1', 't2']);
  const rows = panelRows(h);
  assert.equal(rows.length, 2);
  assert.match(rows[0].querySelector('.recovery-entry-path').textContent, /one\.md/);
  assert.match(rows[1].querySelector('.recovery-entry-path').textContent, /未命中文档路径/);
  assert.ok(rows[0].querySelector('.recovery-entry-time').textContent.length > 0, '含保存时间');
  assert.ok(h.buttonIn(rows[0], '恢复'));
  assert.ok(h.buttonIn(rows[0], '丢弃'));
  assert.ok(h.buttonIn(panel, '全部丢弃'));
});

test('recovery-available：无条目不显示面板', () => {
  const h = loadHarness();
  h.dispatch('workspace:recovery-available', { entries: [], warnings: [] });
  assert.equal(h.panel(), null);
});

test('恢复条目：按 tab_id 派发 workspace.recovery.restore（data JSON）', () => {
  const h = loadHarness();
  h.dispatch('workspace:recovery-available', { entries: recoveryEntries(), warnings: [] });

  fire(h.buttonIn(panelRows(h)[1], '恢复'), 'click');

  assert.deepEqual(h.ipcMessages, [{
    command: 'workspace.recovery.restore',
    data: JSON.stringify({ tab_id: 't2' }),
  }]);
});

test('恢复条目：restored 事件后移除对应行并展示只读恢复内容', () => {
  const h = loadHarness({ customEvent: true });
  h.dispatch('workspace:recovery-available', { entries: recoveryEntries(), warnings: [] });

  h.dispatch('workspace:recovery-restored', {
    tab_id: 't1', path: 'G:/proj/notes/one.md', content: '# 恢复的内容',
  });

  assert.deepEqual(h.RecoveryUI.getPendingEntries().map((e) => e.tab_id), ['t2']);
  const restored = h.restored();
  assert.ok(restored);
  assert.equal(restored.classList.contains('visible'), true);
  assert.match(restored.querySelector('.recovery-restored-content').textContent, /# 恢复的内容/);
  // vm 沙箱对象与宿主 realm 原型不同，按 interfaces.md §4.1 约定逐字段断言
  const last = h.RecoveryUI.getLastRestored();
  assert.equal(last.tabId, 't1');
  assert.equal(last.path, 'G:/proj/notes/one.md');
  assert.equal(last.content, '# 恢复的内容');
  const event = h.windowEvents.find((e) => e.type === 'recovery:restored');
  assert.ok(event, '已派发 recovery:restored 自定义事件');
  assert.equal(event.detail.content, '# 恢复的内容');
});

test('最后一条恢复后面板自动收起', () => {
  const h = loadHarness();
  h.dispatch('workspace:recovery-available', { entries: [recoveryEntries()[1]], warnings: [] });
  assert.equal(h.panel().classList.contains('visible'), true);

  h.dispatch('workspace:recovery-restored', { tab_id: 't2', path: null, content: 'x' });

  assert.equal(h.panel().classList.contains('visible'), false);
});

test('丢弃条目：立即派发 discard 并移除该行', () => {
  const h = loadHarness();
  h.dispatch('workspace:recovery-available', { entries: recoveryEntries(), warnings: [] });

  fire(h.buttonIn(panelRows(h)[0], '丢弃'), 'click');

  assert.deepEqual(h.ipcMessages, [{
    command: 'workspace.recovery.discard',
    data: JSON.stringify({ tab_id: 't1' }),
  }]);
  assert.deepEqual(h.RecoveryUI.getPendingEntries().map((e) => e.tab_id), ['t2']);
  assert.equal(panelRows(h).length, 1);
});

test('全部丢弃：逐条 discard、清空列表并收起面板', () => {
  const h = loadHarness();
  h.dispatch('workspace:recovery-available', { entries: recoveryEntries(), warnings: [] });

  fire(h.buttonIn(h.panel(), '全部丢弃'), 'click');

  assert.deepEqual(h.ipcMessages.map((m) => JSON.parse(m.data).tab_id).sort(), ['t1', 't2']);
  assert.equal(h.RecoveryUI.getPendingEntries().length, 0);
  assert.equal(h.panel().classList.contains('visible'), false);
});

test('复制全部：经剪贴板 API 写入恢复内容并反馈', () => {
  const h = loadHarness();
  h.dispatch('workspace:recovery-restored', { tab_id: 't1', path: 'G:/p.md', content: '恢复正文' });

  const copyBtn = h.buttonIn(h.restored(), '复制全部');
  fire(copyBtn, 'click');

  assert.deepEqual(h.clipboardWrites, ['恢复正文']);
  assert.equal(copyBtn.textContent, '已复制');
});

test('recovery.copy-restored 命令：无恢复内容时返回 false', () => {
  const h = loadHarness();
  assert.equal(h.Commands.run('recovery.copy-restored'), false);

  h.dispatch('workspace:recovery-restored', { tab_id: 't1', path: null, content: 'abc' });
  assert.equal(h.Commands.run('recovery.copy-restored'), true);
  assert.deepEqual(h.clipboardWrites, ['abc']);
});
