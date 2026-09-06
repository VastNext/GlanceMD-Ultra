const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// layout.js 单测（node:test + vm，零依赖）：树与 Outline 折叠往返、
// Outline 左右侧停靠与拖宽坐标计算、持久化键名、restore、拖宽钳制、reset。
const SOURCE = fs.readFileSync(path.join(__dirname, 'layout.js'), 'utf8');

function makeElement(id, getContext) {
  const classes = new Set();
  const attributes = new Map();
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
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener(type, handler) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    },
    // 元素真实边界：支持基于当前状态的动态边界模拟（如 #panel-outline 在 left/right 下的真实 left/right）
    getBoundingClientRect() {
      if (getContext) {
        const rect = getContext(id, this);
        if (rect) return rect;
      }
      return { left: 0, right: 1000, top: 0, bottom: 500, width: 1000, height: 500 };
    },
  };
}

function loadLayout({ storage = new Map(), withCommands = false } = {}) {
  const ids = {};
  const docElement = makeElement('html');
  const bodyElement = makeElement('body');
  const commandsRegistry = {};
  const commandsObj = {
    register(id, def) {
      commandsRegistry[id] = def;
      return id;
    },
    has(id) {
      return Object.prototype.hasOwnProperty.call(commandsRegistry, id);
    },
    get(id) {
      return commandsRegistry[id] || null;
    },
    run(id, arg) {
      if (!commandsRegistry[id]) throw new Error('Unknown command: ' + id);
      return commandsRegistry[id].run(arg);
    },
    ids() {
      return Object.keys(commandsRegistry);
    }
  };
  const getElementRect = (id, el) => {
    if (id === 'content') {
      return { left: 0, right: 1000, top: 0, bottom: 500, width: 1000, height: 500 };
    }
    if (id === 'panel-tree') {
      const isCollapsed = el.classList.contains('collapsed');
      const w = isCollapsed ? 36 : (parseInt(el.style.width, 10) || 264);
      return { left: 0, right: w, top: 0, bottom: 500, width: w, height: 500 };
    }
    if (id === 'panel-tree-resizer') {
      const treeEl = ids['panel-tree'];
      const isCollapsed = treeEl && treeEl.classList.contains('collapsed');
      const treeW = isCollapsed ? 36 : (parseInt(treeEl?.style?.width, 10) || 264);
      return { left: treeW, right: treeW + 5, top: 0, bottom: 500, width: 5, height: 500 };
    }
    if (id === 'panel-outline') {
      const contentEl = ids['content'];
      const isLeft = docElement.getAttribute('data-outline-side') === 'left' ||
                     (contentEl && contentEl.getAttribute('data-outline-side') === 'left');
      const outlineW = parseInt(el.style.width, 10) || 264;
      if (isLeft) {
        const treeEl = ids['panel-tree'];
        const isCollapsed = treeEl && treeEl.classList.contains('collapsed');
        const treeW = isCollapsed ? 36 : (parseInt(treeEl?.style?.width, 10) || 264);
        const resizerW = isCollapsed ? 0 : 5;
        const left = treeW + resizerW;
        return { left, right: left + outlineW, top: 0, bottom: 500, width: outlineW, height: 500 };
      } else {
        return { left: 1000 - outlineW, right: 1000, top: 0, bottom: 500, width: outlineW, height: 500 };
      }
    }
    return null;
  };
  const byId = (id) => (ids[id] = ids[id] || makeElement(id, getElementRect));
  const docHandlers = {};
  const windowObj = {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    addEventListener() {},
  };
  if (withCommands) {
    windowObj.Commands = commandsObj;
  }
  const context = {
    window: windowObj,
    document: {
      documentElement: docElement,
      body: bodyElement,
      getElementById: byId,
      addEventListener(type, handler) {
        (docHandlers[type] = docHandlers[type] || []).push(handler);
      },
      removeEventListener() {},
    },
  };
  vm.runInNewContext(SOURCE, context, { filename: 'layout.js' });
  return {
    LayoutUI: context.window.LayoutUI,
    Commands: context.window.Commands || commandsObj,
    commandsRegistry,
    byId: ids,
    docElement,
    bodyElement,
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

test('树面板折叠往返：collapsed 类、手柄同步隐藏与展开恢复', () => {
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

test('持久化键名：glancemd-ultra-layout-tree-{width,collapsed}、glancemd-ultra-layout-outline-width 与 glancemd-ultra-outline-open', () => {
  const h = loadLayout();
  h.LayoutUI.collapse('tree');
  h.LayoutUI.toggle('outline');

  assert.equal(h.storage.get('glancemd-ultra-layout-tree-collapsed'), '1');
  assert.equal(h.storage.get('glancemd-ultra-outline-open'), '1');
  assert.equal(h.storage.has('glancemd-ultra-layout-tree-width'), false);
  assert.equal(h.storage.has('glancemd-ultra-layout-outline-width'), false);

  // 拖动 outline 手柄后持久化 outline 宽度
  pointerDown(h, 'panel-outline-resizer');
  h.fireDocument('pointermove', { clientX: 700 });
  h.fireDocument('pointerup', {});
  assert.equal(h.storage.get('glancemd-ultra-layout-outline-width'), '300');

  h.LayoutUI.collapse('outline');
  assert.equal(h.storage.get('glancemd-ultra-outline-open'), '0');

  h.LayoutUI.expand('outline');
  assert.equal(h.storage.get('glancemd-ultra-outline-open'), '1');
});

test('树拖宽：pointermove 自由拖动并受编辑器最小宽度保护钳制，pointerup 持久化', () => {
  const h = loadLayout();
  pointerDown(h, 'panel-tree-resizer');

  h.fireDocument('pointermove', { clientX: 5000 });
  assert.equal(h.byId['panel-tree'].style.width, '920px', '1000px 总宽保留 80 编辑器后最大 920');
  h.fireDocument('pointermove', { clientX: -80 });
  assert.equal(h.byId['panel-tree'].style.width, '180px', '超下限钳制 180');
  h.fireDocument('pointermove', { clientX: 316.4 });
  assert.equal(h.byId['panel-tree'].style.width, '316px', '正常值取整');
  h.fireDocument('pointerup', {});
  assert.equal(h.storage.get('glancemd-ultra-layout-tree-width'), '316');
});

test('Outline 拖宽（默认右侧）：向左拖动增大宽度，受保护钳制，pointerup 持久化', () => {
  const h = loadLayout();
  h.LayoutUI.expand('outline');
  pointerDown(h, 'panel-outline-resizer');

  // content right=1000, clientX=700 -> width=300
  h.fireDocument('pointermove', { clientX: 700 });
  assert.equal(h.byId['panel-outline'].style.width, '300px');

  // clientX=-500 -> 1000 - (-500) = 1500, clamped by total - tree(264) - editor(80) = 656
  h.fireDocument('pointermove', { clientX: -500 });
  assert.equal(h.byId['panel-outline'].style.width, '656px');

  // clientX=950 -> 1000 - 950 = 50 -> clamped to MIN_WIDTH(180)
  h.fireDocument('pointermove', { clientX: 950 });
  assert.equal(h.byId['panel-outline'].style.width, '180px');

  h.fireDocument('pointerup', {});
  assert.equal(h.storage.get('glancemd-ultra-layout-outline-width'), '180');
});

test('Outline 拖宽（left 模式）：outlineSide=left 时位于树右侧，向右拖增宽，pointerup 持久化', () => {
  const h = loadLayout();
  h.LayoutUI.setOutlineSide('left');
  h.LayoutUI.expand('outline');

  // 树宽 264px + 树手柄 5px = 269px，outline 位于树右侧 (left=269)
  assert.equal(h.byId['panel-outline'].getBoundingClientRect().left, 269);
  pointerDown(h, 'panel-outline-resizer');

  // 手柄拖至 x=569 -> outline 宽 = 569 - 269 = 300px
  h.fireDocument('pointermove', { clientX: 569 });
  assert.equal(h.byId['panel-outline'].style.width, '300px');

  // 手柄拖至 x=200 -> 200 - 269 = -69 -> clamped to 180
  h.fireDocument('pointermove', { clientX: 200 });
  assert.equal(h.byId['panel-outline'].style.width, '180px');

  h.fireDocument('pointerup', {});
  assert.equal(h.storage.get('glancemd-ultra-layout-outline-width'), '180');
});

test('拖宽结束才持久化：移动中途不写 localStorage', () => {
  const h = loadLayout();
  pointerDown(h, 'panel-tree-resizer');
  h.fireDocument('pointermove', { clientX: 300 });
  assert.equal(h.storage.has('glancemd-ultra-layout-tree-width'), false);
  h.fireDocument('pointerup', {});
  assert.equal(h.storage.has('glancemd-ultra-layout-tree-width'), true);

  pointerDown(h, 'panel-outline-resizer');
  h.fireDocument('pointermove', { clientX: 700 });
  assert.equal(h.storage.has('glancemd-ultra-layout-outline-width'), false);
  h.fireDocument('pointerup', {});
  assert.equal(h.storage.has('glancemd-ultra-layout-outline-width'), true);
});

test('restore：启动恢复持久化的树宽度/折叠状态、大纲宽度与开启状态，越界与脏值回退', () => {
  const storage = new Map([
    ['glancemd-ultra-layout-tree-width', '320'],
    ['glancemd-ultra-layout-tree-collapsed', '1'],
    ['glancemd-ultra-layout-outline-width', '280'],
    ['glancemd-ultra-outline-open', '1'],
  ]);
  const h = loadLayout({ storage });

  assert.equal(h.byId['panel-tree'].style.width, '320px');
  assert.equal(h.byId['panel-tree'].classList.contains('collapsed'), true);
  assert.equal(h.byId['panel-outline'].style.width, '280px');
  assert.equal(h.LayoutUI.isCollapsed('outline'), false);
  assert.equal(h.byId['panel-outline'].classList.contains('open'), true);
  assert.equal(h.byId['panel-outline-resizer'].style.display, '');
  assert.equal(h.byId['btn-toc'].classList.contains('active'), true);

  // 脏值（非数字）→ 默认 264
  const h2 = loadLayout({
    storage: new Map([
      ['glancemd-ultra-layout-tree-width', 'abc'],
      ['glancemd-ultra-layout-outline-width', 'xyz'],
    ]),
  });
  assert.equal(h2.byId['panel-tree'].style.width, '264px');
  assert.equal(h2.byId['panel-outline'].style.width, '264px');
});

test('reset：清除持久化并恢复树与大纲默认宽度、展开及大纲关闭态', () => {
  const storage = new Map([
    ['glancemd-ultra-layout-tree-width', '380'],
    ['glancemd-ultra-layout-tree-collapsed', '1'],
    ['glancemd-ultra-layout-outline-width', '350'],
    ['glancemd-ultra-outline-open', '1'],
  ]);
  const h = loadLayout({ storage });
  assert.equal(h.byId['panel-tree'].classList.contains('collapsed'), true);
  assert.equal(h.byId['panel-outline'].classList.contains('open'), true);

  h.LayoutUI.reset();
  assert.equal(h.storage.size, 0, '布局相关键应全部清除');
  assert.equal(h.byId['panel-tree'].style.width, '264px');
  assert.equal(h.byId['panel-outline'].style.width, '264px');
  assert.equal(h.byId['panel-tree'].classList.contains('collapsed'), false);
  assert.equal(h.byId['panel-outline'].classList.contains('open'), false);
  assert.equal(h.byId['panel-outline-resizer'].style.display, 'none');
  assert.equal(h.LayoutUI.isCollapsed('outline'), true);
});

test('Outline 开关：toggle / collapse / expand 控制 .open 类、手柄显隐、isCollapsed 语义与 #btn-toc 激活态', () => {
  const h = loadLayout();
  // 默认关闭
  assert.equal(h.LayoutUI.isCollapsed('outline'), true);
  assert.equal(h.byId['panel-outline'].classList.contains('open'), false);
  assert.equal(h.byId['panel-outline-resizer'].style.display, 'none');
  assert.equal(h.byId['btn-toc'].classList.contains('active'), false);

  // toggle 打开
  h.LayoutUI.toggle('outline');
  assert.equal(h.LayoutUI.isCollapsed('outline'), false);
  assert.equal(h.byId['panel-outline'].classList.contains('open'), true);
  assert.equal(h.byId['panel-outline-resizer'].style.display, '');
  assert.equal(h.byId['btn-toc'].classList.contains('active'), true);
  assert.equal(h.storage.get('glancemd-ultra-outline-open'), '1');

  // collapse 关闭
  h.LayoutUI.collapse('outline');
  assert.equal(h.LayoutUI.isCollapsed('outline'), true);
  assert.equal(h.byId['panel-outline'].classList.contains('open'), false);
  assert.equal(h.byId['panel-outline-resizer'].style.display, 'none');
  assert.equal(h.byId['btn-toc'].classList.contains('active'), false);
  assert.equal(h.storage.get('glancemd-ultra-outline-open'), '0');

  // expand 打开
  h.LayoutUI.expand('outline');
  assert.equal(h.LayoutUI.isCollapsed('outline'), false);
  assert.equal(h.byId['panel-outline'].classList.contains('open'), true);
  assert.equal(h.byId['panel-outline-resizer'].style.display, '');
  assert.equal(h.byId['btn-toc'].classList.contains('active'), true);
  assert.equal(h.storage.get('glancemd-ultra-outline-open'), '1');
});

test('setOutlineSide：设置 content 与 documentElement 的 data-outline-side 属性且幂等', () => {
  const h = loadLayout();
  // 默认 right
  assert.equal(h.byId['content'].getAttribute('data-outline-side'), 'right');
  assert.equal(h.docElement.getAttribute('data-outline-side'), 'right');

  // 切到 left
  h.LayoutUI.setOutlineSide('left');
  assert.equal(h.byId['content'].getAttribute('data-outline-side'), 'left');
  assert.equal(h.docElement.getAttribute('data-outline-side'), 'left');

  // 幂等重复设置
  h.LayoutUI.setOutlineSide('left');
  assert.equal(h.byId['content'].getAttribute('data-outline-side'), 'left');
  assert.equal(h.docElement.getAttribute('data-outline-side'), 'left');

  // 切回 right
  h.LayoutUI.setOutlineSide('right');
  assert.equal(h.byId['content'].getAttribute('data-outline-side'), 'right');
  assert.equal(h.docElement.getAttribute('data-outline-side'), 'right');

  // 非法值安全回退 right
  h.LayoutUI.setOutlineSide('invalid');
  assert.equal(h.byId['content'].getAttribute('data-outline-side'), 'right');
  assert.equal(h.docElement.getAttribute('data-outline-side'), 'right');
});

test('双击 resizer 恢复对应面板默认宽度', () => {
  const h = loadLayout();
  h.LayoutUI.expand('outline');
  pointerDown(h, 'panel-tree-resizer');
  h.fireDocument('pointermove', { clientX: 350 });
  h.fireDocument('pointerup', {});
  assert.equal(h.byId['panel-tree'].style.width, '350px');

  // 双击 tree resizer 恢复默认
  h.byId['panel-tree-resizer'].listeners.dblclick.forEach((fn) => fn());
  assert.equal(h.byId['panel-tree'].style.width, '264px');

  // 调整 outline 宽度后双击恢复
  pointerDown(h, 'panel-outline-resizer');
  h.fireDocument('pointermove', { clientX: 600 });
  h.fireDocument('pointerup', {});
  assert.equal(h.byId['panel-outline'].style.width, '400px');

  h.byId['panel-outline-resizer'].listeners.dblclick.forEach((fn) => fn());
  assert.equal(h.byId['panel-outline'].style.width, '264px');
});

test('命令注册：向 window.Commands 注册 layout.tree.{toggle,collapse,expand,resetWidth}', () => {
  const h = loadLayout({ withCommands: true });
  assert.equal(h.Commands.has('layout.tree.toggle'), true);
  assert.equal(h.Commands.has('layout.tree.collapse'), true);
  assert.equal(h.Commands.has('layout.tree.expand'), true);
  assert.equal(h.Commands.has('layout.tree.resetWidth'), true);

  // toggle
  h.Commands.run('layout.tree.toggle');
  assert.equal(h.LayoutUI.isCollapsed('tree'), true);
  assert.equal(h.byId['panel-tree'].classList.contains('collapsed'), true);

  // expand
  h.Commands.run('layout.tree.expand');
  assert.equal(h.LayoutUI.isCollapsed('tree'), false);
  assert.equal(h.byId['panel-tree'].classList.contains('collapsed'), false);

  // collapse
  h.Commands.run('layout.tree.collapse');
  assert.equal(h.LayoutUI.isCollapsed('tree'), true);

  // resetWidth
  pointerDown(h, 'panel-tree-resizer');
  h.fireDocument('pointermove', { clientX: 340 });
  h.fireDocument('pointerup', {});
  assert.equal(h.byId['panel-tree'].style.width, '340px');
  assert.equal(h.storage.get('glancemd-ultra-layout-tree-width'), '340');

  h.Commands.run('layout.tree.resetWidth');
  assert.equal(h.byId['panel-tree'].style.width, '264px');
  assert.equal(h.storage.has('glancemd-ultra-layout-tree-width'), false);
});
