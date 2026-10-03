/* help-menu.test.js — 顶栏「应用菜单」的单元测试（node:test + node:vm）
 * 覆盖：菜单构建（14 项 + 4 分隔线 + 扩展父项）、点击触发 Commands.run、
 * 快捷键提示注入、二级子菜单展开/收起/点击执行、Esc 分层关闭、
 * 方向键导航、i18n-changed / keybindings-changed 刷新。
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');

function load(options = {}) {
  const elements = new Map();
  const docListeners = {};
  const winListeners = {};
  let activeElement = null;

  function makeEl(tag) {
    const el = {};
    const classSet = new Set();
    /* className 与 classList 单源：赋值 className 时同步 classSet */
    let _className = '';
    Object.defineProperty(el, 'className', {
      get() { return _className; },
      set(v) {
        _className = String(v);
        classSet.clear();
        _className.split(/\s+/).filter(Boolean).forEach(c => classSet.add(c));
      }
    });
    el.tagName = String(tag).toUpperCase();
    el.className = '';
    el.id = '';
    el.hidden = false;
    el.textContent = '';
    el.style = {};
    el.attrs = {};
    el.dataset = {};
    el.children = [];
    el.parentNode = null;
    el.listeners = {};
    el.focused = false;
    el.classList = {
      _set: classSet,
      add(c) { classSet.add(c); _className = Array.from(classSet).join(' '); },
      remove(c) { classSet.delete(c); _className = Array.from(classSet).join(' '); },
      contains(c) { return classSet.has(c); },
      toggle(c, force) {
        if (force === undefined) { classSet.has(c) ? classSet.delete(c) : classSet.add(c); }
        else if (force) { classSet.add(c); } else { classSet.delete(c); }
        _className = Array.from(classSet).join(' ');
      }
    };
    el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
    el.getAttribute = k => (el.attrs[k] !== undefined ? el.attrs[k] : null);
    el.removeAttribute = k => { delete el.attrs[k]; };
    el.appendChild = child => {
      el.children.push(child);
      child.parentNode = el;
      registerTree(child);
    };
    el.removeChild = child => {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      child.parentNode = null;
    };
    el.contains = other => {
      let curr = other;
      while (curr) { if (curr === el) return true; curr = curr.parentNode; }
      return false;
    };
    el.addEventListener = (type, fn) => {
      el.listeners[type] = el.listeners[type] || [];
      el.listeners[type].push(fn);
    };
    el.removeEventListener = (type, fn) => {
      if (el.listeners[type]) el.listeners[type] = el.listeners[type].filter(f => f !== fn);
    };
    el.dispatchEvent = e => {
      (el.listeners[e.type] || []).forEach(fn => fn(e));
    };
    el.focus = () => { el.focused = true; activeElement = el; };
    el.getBoundingClientRect = () =>
      el._rect || { left: 10, right: 30, top: 5, bottom: 27, width: 20, height: 22 };
    el.querySelector = sel => {
      if (sel.startsWith('#')) return findById(el, sel.slice(1));
      if (sel.startsWith('.')) return findByClass(el, sel.slice(1))[0] || null;
      return null;
    };
    el.querySelectorAll = sel => {
      if (sel.startsWith('.')) return findByClass(el, sel.slice(1));
      if (sel.startsWith('#')) {
        const found = findById(el, sel.slice(1));
        return found ? [found] : [];
      }
      return [];
    };
    return el;
  }

  function findById(root, id) {
    if (root.id === id) return root;
    for (const child of root.children || []) {
      const found = findById(child, id);
      if (found) return found;
    }
    return null;
  }

  function findByClass(root, cls) {
    const out = [];
    const inStr = String(root.className || '').split(/\s+/).includes(cls);
    const inSet = root.classList && root.classList._set && root.classList._set.has(cls);
    if (inStr || inSet) out.push(root);
    for (const child of root.children || []) out.push(...findByClass(child, cls));
    return out;
  }

  function registerTree(node) {
    if (node.id) elements.set(node.id, node);
    (node.children || []).forEach(registerTree);
  }

  const doc = {
    readyState: 'complete',
    body: makeEl('body'),
    head: makeEl('head'),
    get activeElement() { return activeElement; },
    set activeElement(el) { activeElement = el; },
    createElement: tag => makeEl(tag),
    getElementById: id => elements.get(id) || null,
    addEventListener(type, fn) {
      docListeners[type] = docListeners[type] || [];
      docListeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      if (docListeners[type]) docListeners[type] = docListeners[type].filter(f => f !== fn);
    },
    dispatchEvent(e) {
      (docListeners[e.type] || []).forEach(fn => fn(e));
    }
  };

  const c = {
    window: null,
    document: doc,
    console,
    innerWidth: 1024,
    innerHeight: 768,
    setTimeout,
    clearTimeout
  };
  c.window = c;
  c.addEventListener = (type, fn) => {
    winListeners[type] = winListeners[type] || [];
    winListeners[type].push(fn);
  };
  c.removeEventListener = (type, fn) => {
    if (winListeners[type]) winListeners[type] = winListeners[type].filter(f => f !== fn);
  };
  c.dispatchEvent = e => (winListeners[e.type] || []).forEach(fn => fn(e));

  const runLog = [];
  const COMMAND_IDS = [
    'file.new', 'file.open', 'workspace.open', 'file.save', 'file.saveAs', 'file.saveAll',
    'resource.open', 'search.toggle', 'outline.toggle',
    'palette.toggle', 'keyassist.toggle', 'settings.toggle', 'help.about'
  ];
  c.Commands = {
    registry: {},
    get(id) { return this.registry[id] || null; },
    has(id) { return !!this.registry[id]; },
    run(id) { runLog.push(id); }
  };
  COMMAND_IDS.forEach(id => { c.Commands.registry[id] = { id, label: id }; });

  c.Keybindings = {
    map: { 'file.new': 'Ctrl+N', 'palette.toggle': 'Ctrl+3' },
    effective() { return this.map; }
  };

  // 预置顶栏按钮
  const btnMenu = makeEl('button');
  btnMenu.id = 'btn-menu';
  doc.body.appendChild(btnMenu);

  vm.runInNewContext(fs.readFileSync('src/frontend/help-menu.js', 'utf8'), c);
  return { c, doc, runLog, btnMenu, docListeners, winListeners };
}

function clickEl(el) {
  el.dispatchEvent({ type: 'click', stopPropagation() {}, preventDefault() {} });
}

function currentMenu(doc) {
  return doc.body.children.find(el => el.className && el.className.includes('ctx-menu'));
}

test('打开菜单：13 个命令项 + 1 个扩展父项 + 4 条分隔线，顺序符合结构定义', () => {
  const { c, doc } = load();
  c.HelpMenu.toggle();
  assert.equal(c.HelpMenu.isOpen(), true);
  const menu = currentMenu(doc);
  assert.ok(menu, '菜单应挂载到 body');
  const items = menu.querySelectorAll('.ctx-item');
  assert.equal(items.length, 14);
  const expected = [
    'file.new', 'file.open', 'workspace.open', 'file.save', 'file.saveAs', 'file.saveAll',
    'resource.open', 'search.toggle', 'outline.toggle',
    null, /* 扩展父项：无 commandId，有子菜单 */
    'palette.toggle', 'keyassist.toggle', 'settings.toggle', 'help.about'
  ];
  expected.forEach((id, i) => {
    if (id === null) {
      assert.ok(items[i].dataset.hasSub, '第 10 项应为扩展父项');
    } else {
      assert.equal(items[i].dataset.commandId, id);
    }
  });
  assert.equal(menu.querySelectorAll('.ctx-sep').length, 4);
  assert.equal(menu.querySelectorAll('.ctx-item-sub').length, 1);
});

test('点击普通菜单项触发对应命令并关闭菜单', () => {
  const { c, doc, runLog } = load();
  c.HelpMenu.toggle();
  const menu = currentMenu(doc);
  const item = menu.querySelectorAll('.ctx-item').find(el => el.dataset.commandId === 'file.new');
  clickEl(item);
  assert.deepEqual(runLog, ['file.new']);
  assert.equal(c.HelpMenu.isOpen(), false);
});

test('快捷键提示按 Keybindings.effective 注入，未绑定的项隐藏 kbd', () => {
  const { c, doc } = load();
  c.HelpMenu.toggle();
  const menu = currentMenu(doc);
  const items = menu.querySelectorAll('.ctx-item');
  const newFile = items.find(el => el.dataset.commandId === 'file.new');
  const about = items.find(el => el.dataset.commandId === 'help.about');
  assert.equal(newFile.querySelector('.kbd').textContent, 'Ctrl+N');
  assert.equal(about.querySelector('.kbd').style.display, 'none');
});

test('点击「扩展」父项展开二级子菜单（语层翻译面板），再点收起', () => {
  const { c, doc } = load();
  c.HelpMenu.toggle();
  const menu = currentMenu(doc);
  const ext = menu.querySelector('.ctx-item-sub');
  clickEl(ext);
  const sub = doc.body.children.find(el => el.className && el.className.includes('ctx-submenu'));
  assert.ok(sub, '子菜单应挂载到 body');
  const subItems = sub.querySelectorAll('.ctx-item');
  assert.equal(subItems.length, 1);
  assert.equal(subItems[0].dataset.commandId, 'translate.popup');
  assert.equal(ext.attrs['aria-expanded'], 'true');

  clickEl(ext);
  assert.equal(doc.body.children.filter(el => el.className && el.className.includes('ctx-submenu')).length, 0, '再次点击应收起子菜单');
});

test('点击子菜单项执行命令并关闭整个菜单（含子菜单）', () => {
  const { c, doc, runLog } = load();
  c.HelpMenu.toggle();
  const ext = currentMenu(doc).querySelector('.ctx-item-sub');
  clickEl(ext);
  const sub = doc.body.children.find(el => el.className && el.className.includes('ctx-submenu'));
  clickEl(sub.querySelector('.ctx-item'));
  assert.deepEqual(runLog, ['translate.popup']);
  assert.equal(c.HelpMenu.isOpen(), false, '主菜单应关闭');
  assert.equal(doc.body.children.filter(el => el.className && el.className.includes('ctx-submenu')).length, 0, '子菜单应移除');
});

test('Esc 分层关闭：先收子菜单，再关主菜单并还原按钮焦点', () => {
  const { c, doc, btnMenu, docListeners } = load();
  const esc = () => (docListeners.keydown || []).forEach(fn => fn({ key: 'Escape', preventDefault() {} }));

  c.HelpMenu.toggle();
  const ext = currentMenu(doc).querySelector('.ctx-item-sub');
  clickEl(ext);
  assert.ok(doc.body.children.find(el => el.className && el.className.includes('ctx-submenu')));

  esc();
  assert.equal(doc.body.children.filter(el => el.className && el.className.includes('ctx-submenu')).length, 0, '第一次 Esc 收子菜单');
  assert.equal(c.HelpMenu.isOpen(), true, '主菜单仍开');

  esc();
  assert.equal(c.HelpMenu.isOpen(), false, '第二次 Esc 关主菜单');
  assert.equal(btnMenu.focused, true, '焦点还原到触发按钮');
});

test('方向键：→ 在父项上展开子菜单，← 收起并回焦父项', () => {
  const { c, doc, docListeners } = load();
  const key = k => (docListeners.keydown || []).forEach(fn => fn({ key: k, preventDefault() {} }));

  c.HelpMenu.toggle();
  const ext = currentMenu(doc).querySelector('.ctx-item-sub');
  ext.focus();
  key('ArrowRight');
  assert.ok(doc.body.children.find(el => el.className && el.className.includes('ctx-submenu')), '→ 应展开子菜单');

  key('ArrowLeft');
  assert.equal(doc.body.children.filter(el => el.className && el.className.includes('ctx-submenu')).length, 0, '← 应收起子菜单');
  assert.equal(ext.focused, true, '焦点回父项');
});

test('i18n-changed / keybindings-changed 刷新标签与快捷键提示', () => {
  const { c, doc, winListeners } = load();
  c.HelpMenu.toggle();
  const menu = currentMenu(doc);
  const newFile = menu.querySelectorAll('.ctx-item').find(el => el.dataset.commandId === 'file.new');

  c.Keybindings.map['file.new'] = 'Ctrl+Shift+N';
  (winListeners['i18n-changed'] || []).forEach(fn => fn({ type: 'i18n-changed' }));
  (winListeners['keybindings-changed'] || []).forEach(fn => fn({ type: 'keybindings-changed' }));
  assert.equal(newFile.querySelector('.kbd').textContent, 'Ctrl+Shift+N');
});

test('重复 toggle 翻转开关；关闭后菜单与子菜单均从 DOM 移除', () => {
  const { c, doc } = load();
  assert.equal(c.HelpMenu.isOpen(), false);
  c.HelpMenu.toggle();
  c.HelpMenu.toggle();
  assert.equal(c.HelpMenu.isOpen(), false);
  const menus = doc.body.children.filter(el => el.className && el.className.includes('ctx-menu'));
  assert.equal(menus.length, 0);
});
