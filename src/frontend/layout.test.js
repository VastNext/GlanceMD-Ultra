const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// layout.js 单测（node:test + vm，零依赖）：折叠往返、持久化键名、restore、
// 拖宽钳制、reset、窄视口自动折叠。stub 风格照 smoke.test.js 的最小 DOM。
const SOURCE = fs.readFileSync(path.join(__dirname, 'layout.js'), 'utf8');

function makeElement(id) {
  const classes = new Set();
  return {
    id,
    style: {},
    listeners: {},
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
    addEventListener(type, handler) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    },
    // #content 的 rect：宽 1000，右缘 x=1000（拖宽计算的基准）
    getBoundingClientRect() {
      return { left: 0, right: 1000, top: 0, bottom: 0, width: 1000, height: 500 };
    },
  };
}

function loadLayout({ storage = new Map(), matchMedia } = {}) {
  const ids = {};
  const byId = (id) => (ids[id] = ids[id] || makeElement(id));
  const docHandlers = {};
  const windowObj = {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
  };
  if (matchMedia) windowObj.matchMedia = matchMedia;
  const context = {
    window: windowObj,
    document: {
      getElementById: byId,
      body: makeElement('body'),
      addEventListener(type, handler) {
        (docHandlers[type] = docHandlers[type] || []).push(handler);
      },
      removeEventListener() {},
    },
  };
  vm.runInNewContext(SOURCE, context, { filename: 'layout.js' });
  return {
    LayoutUI: context.window.LayoutUI,
    byId: ids, // 索引访问已创建的元素（init 时惰性填充）
    storage,
    fireDocument(type, event) {
      (docHandlers[type] || []).forEach((handler) => handler(event));
    },
  };
}

function pointerDown(h, resizerId) {
  h.byId[resizerId].listeners.pointerdown.forEach((fn) =>
    fn({ button: 0, preventDefault() {} }),
  );
}

test('折叠往返：collapsed 类、手柄同步隐藏与展开恢复', () => {
  const h = loadLayout();
  assert.equal(h.LayoutUI.isCollapsed('tree'), false);

  h.LayoutUI.toggle('tree');
  assert.equal(h.LayoutUI.isCollapsed('tree'), true);
  assert.equal(h.byId['panel-tree'].classList.contains('collapsed'), true);
  assert.equal(h.byId['panel-tree-resizer'].style.display, 'none', '折叠后手柄应隐藏');

  h.LayoutUI.toggle('tree');
  assert.equal(h.LayoutUI.isCollapsed('tree'), false);
  assert.equal(h.byId['panel-tree'].classList.contains('collapsed'), false);
  assert.equal(h.byId['panel-tree-resizer'].style.display, '', '展开后手柄恢复');
});

test('持久化键名：glancemd-ultra-layout-{tree,outline}-{width,collapsed}', () => {
  const h = loadLayout();
  h.LayoutUI.collapse('tree');
  h.LayoutUI.toggle('outline');

  assert.equal(h.storage.get('glancemd-ultra-layout-tree-collapsed'), '1');
  assert.equal(h.storage.get('glancemd-ultra-layout-outline-collapsed'), '1');
  // 未拖宽不写宽度键，避免把 CSS 默认值固化进存储
  assert.equal(h.storage.has('glancemd-ultra-layout-tree-width'), false);
  assert.equal(h.storage.has('glancemd-ultra-layout-outline-width'), false);

  h.LayoutUI.expand('outline');
  assert.equal(h.storage.get('glancemd-ultra-layout-outline-collapsed'), '0');
});

test('拖宽：pointermove 边界钳制 200–400px，pointerup 持久化', () => {
  const h = loadLayout();
  pointerDown(h, 'panel-tree-resizer');

  h.fireDocument('pointermove', { clientX: 5000 });
  assert.equal(h.byId['panel-tree'].style.width, '400px', '超上限钳制 400');
  h.fireDocument('pointermove', { clientX: -80 });
  assert.equal(h.byId['panel-tree'].style.width, '200px', '超下限钳制 200');
  h.fireDocument('pointermove', { clientX: 316.4 });
  assert.equal(h.byId['panel-tree'].style.width, '316px', '正常值取整');
  h.fireDocument('pointerup', {});
  assert.equal(h.storage.get('glancemd-ultra-layout-tree-width'), '316');

  // outline：面板在手柄右侧，宽度 = 内容区右缘 - 鼠标 X
  pointerDown(h, 'panel-outline-resizer');
  h.fireDocument('pointermove', { clientX: 640 });
  assert.equal(h.byId['panel-outline'].style.width, '360px');
  h.fireDocument('pointermove', { clientX: 999 });
  assert.equal(h.byId['panel-outline'].style.width, '200px', 'outline 同样受下限钳制');
  h.fireDocument('pointerup', {});
  assert.equal(h.storage.get('glancemd-ultra-layout-outline-width'), '200');
});

test('拖宽结束才持久化：移动中途不写 localStorage', () => {
  const h = loadLayout();
  pointerDown(h, 'panel-tree-resizer');
  h.fireDocument('pointermove', { clientX: 300 });
  assert.equal(h.storage.has('glancemd-ultra-layout-tree-width'), false);
  h.fireDocument('pointerup', {});
  assert.equal(h.storage.has('glancemd-ultra-layout-tree-width'), true);
});

test('restore：启动恢复持久化的宽度与折叠状态，越界与脏值回退', () => {
  const storage = new Map([
    ['glancemd-ultra-layout-tree-width', '320'],
    ['glancemd-ultra-layout-tree-collapsed', '1'],
    ['glancemd-ultra-layout-outline-width', '9999'], // 越上限 → 钳制 400
    ['glancemd-ultra-layout-outline-collapsed', '0'],
  ]);
  const h = loadLayout({ storage });

  assert.equal(h.byId['panel-tree'].style.width, '320px');
  assert.equal(h.byId['panel-tree'].classList.contains('collapsed'), true);
  assert.equal(h.byId['panel-outline'].style.width, '400px');
  assert.equal(h.byId['panel-outline'].classList.contains('collapsed'), false);

  // 脏值（非数字）→ 默认 240
  const h2 = loadLayout({
    storage: new Map([['glancemd-ultra-layout-tree-width', 'abc']]),
  });
  assert.equal(h2.byId['panel-tree'].style.width, '240px');
});

test('reset：清除持久化并恢复默认宽度与展开态', () => {
  const storage = new Map([
    ['glancemd-ultra-layout-tree-width', '380'],
    ['glancemd-ultra-layout-tree-collapsed', '1'],
  ]);
  const h = loadLayout({ storage });
  assert.equal(h.byId['panel-tree'].classList.contains('collapsed'), true);

  h.LayoutUI.reset();
  assert.equal(h.storage.size, 0, '四个布局键应全部清除');
  assert.equal(h.byId['panel-tree'].style.width, '240px');
  assert.equal(h.byId['panel-tree'].classList.contains('collapsed'), false);
  assert.equal(h.byId['panel-outline'].style.width, '240px');
});

test('窄视口（≤1024px）自动折叠 Outline，切回宽视口恢复且不写持久化', () => {
  const mql = { matches: false, listeners: [] };
  mql.addEventListener = function(type, fn) {
    if (type === 'change') this.listeners.push(fn);
  };
  const h = loadLayout({ matchMedia: () => mql });
  assert.equal(h.byId['panel-outline'].classList.contains('collapsed'), false);

  mql.matches = true;
  mql.listeners.forEach((fn) => fn());
  assert.equal(h.byId['panel-outline'].classList.contains('collapsed'), true, '窄视口自动折叠');
  assert.equal(
    h.storage.has('glancemd-ultra-layout-outline-collapsed'),
    false,
    '自动折叠不写持久化（只记用户手动操作）',
  );

  mql.matches = false;
  mql.listeners.forEach((fn) => fn());
  assert.equal(h.byId['panel-outline'].classList.contains('collapsed'), false, '宽视口恢复');
});

test('窄视口下手动展开后，切回宽视口不反向折叠', () => {
  const mql = { matches: true, listeners: [] };
  mql.addEventListener = function(type, fn) {
    if (type === 'change') this.listeners.push(fn);
  };
  const h = loadLayout({ matchMedia: () => mql });
  assert.equal(h.byId['panel-outline'].classList.contains('collapsed'), true);

  h.LayoutUI.expand('outline'); // 用户显式展开
  assert.equal(h.byId['panel-outline'].classList.contains('collapsed'), false);

  mql.matches = false;
  mql.listeners.forEach((fn) => fn());
  assert.equal(
    h.byId['panel-outline'].classList.contains('collapsed'),
    false,
    '手动展开应覆盖自动折叠记忆',
  );
});
