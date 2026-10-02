/* help-menu.test.js — 顶栏「更多」下拉菜单的单元测试（node:test + node:vm）
 * 覆盖：菜单构建与命令引用、点击触发 Commands.run、快捷键提示注入、
 * Esc / 项点击关闭、i18n-changed / keybindings-changed 刷新。
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
    const el = {
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      hidden: false,
      textContent: '',
      style: {},
      attrs: {},
      dataset: {},
      children: [],
      parentNode: null,
      listeners: {},
      focused: false,
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        contains(c) { return this._set.has(c); },
        toggle(c, force) {
          if (force === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); }
          else if (force) { this._set.add(c); } else { this._set.delete(c); }
        }
      },
      setAttribute(k, v) { el.attrs[k] = String(v); },
      getAttribute(k) { return el.attrs[k] !== undefined ? el.attrs[k] : null; },
      removeAttribute(k) { delete el.attrs[k]; },
      appendChild(child) {
        el.children.push(child);
        child.parentNode = el;
        registerTree(child);
      },
      removeChild(child) {
        const i = el.children.indexOf(child);
        if (i >= 0) el.children.splice(i, 1);
        child.parentNode = null;
      },
      contains(other) {
        let curr = other;
        while (curr) { if (curr === el) return true; curr = curr.parentNode; }
        return false;
      },
      addEventListener(type, fn) {
        el.listeners[type] = el.listeners[type] || [];
        el.listeners[type].push(fn);
      },
      removeEventListener(type, fn) {
        if (el.listeners[type]) el.listeners[type] = el.listeners[type].filter(f => f !== fn);
      },
      dispatchEvent(e) {
        (el.listeners[e.type] || []).forEach(fn => fn(e));
      },
      focus() { el.focused = true; activeElement = el; },
      getBoundingClientRect() {
        return el._rect || { left: 10, right: 30, top: 5, bottom: 27, width: 20, height: 22 };
      },
      querySelector(sel) {
        if (sel.startsWith('#')) {
          return findById(el, sel.slice(1));
        }
        if (sel.startsWith('.')) {
          const cls = sel.slice(1);
          return findByClass(el, cls)[0] || null;
        }
        return null;
      },
      querySelectorAll(sel) {
        if (sel.startsWith('.')) return findByClass(el, sel.slice(1));
        if (sel.startsWith('#')) {
          const found = findById(el, sel.slice(1));
          return found ? [found] : [];
        }
        return [];
      }
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
    if (String(root.className || '').split(/\s+/).includes(cls)) out.push(root);
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
  c.Commands = {
    registry: {
      'palette.toggle': { id: 'palette.toggle', label: '命令面板' },
      'resource.open': { id: 'resource.open', label: '快速打开文件' },
      'search.toggle': { id: 'search.toggle', label: '全文搜索' },
      'settings.toggle': { id: 'settings.toggle', label: '设置' },
      'keyassist.toggle': { id: 'keyassist.toggle', label: '快捷键速查' },
      'help.about': { id: 'help.about', label: '关于 GlanceMD Ultra' }
    },
    get(id) { return this.registry[id] || null; },
    has(id) { return !!this.registry[id]; },
    run(id) { runLog.push(id); }
  };
  c.Keybindings = {
    map: { 'palette.toggle': 'Ctrl+3', 'search.toggle': 'Ctrl+H' },
    effective() { return this.map; }
  };

  // 预置顶栏按钮
  const btnMore = makeEl('button');
  btnMore.id = 'btn-more';
  doc.body.appendChild(btnMore);

  vm.runInNewContext(fs.readFileSync('src/frontend/help-menu.js', 'utf8'), c);
  return { c, doc, runLog, btnMore, docListeners, winListeners };
}

function clickItem(item) {
  item.dispatchEvent({ type: 'click', stopPropagation() {}, preventDefault() {} });
}

test('打开菜单：6 个命令项 + 2 条分隔线，顺序与命令 ID 契约一致', () => {
  const { c, doc } = load();
  c.HelpMenu.toggle();
  assert.equal(c.HelpMenu.isOpen(), true);
  const menu = doc.body.children.find(el => el.className.includes('ctx-menu'));
  assert.ok(menu, '菜单应挂载到 body');
  const items = menu.querySelectorAll('.ctx-item');
  assert.equal(items.length, 6);
  assert.deepEqual(
    items.map(el => el.dataset.commandId),
    ['palette.toggle', 'resource.open', 'search.toggle', 'settings.toggle', 'keyassist.toggle', 'help.about']
  );
  assert.equal(menu.querySelectorAll('.ctx-sep').length, 2);
});

test('点击菜单项触发对应命令并关闭菜单', () => {
  const { c, doc, runLog } = load();
  c.HelpMenu.toggle();
  const menu = doc.body.children.find(el => el.className.includes('ctx-menu'));
  const about = menu.querySelectorAll('.ctx-item').find(el => el.dataset.commandId === 'help.about');
  clickItem(about);
  assert.deepEqual(runLog, ['help.about']);
  assert.equal(c.HelpMenu.isOpen(), false);
});

test('快捷键提示按 Keybindings.effective 注入，未绑定的项隐藏 kbd', () => {
  const { c, doc } = load();
  c.HelpMenu.toggle();
  const menu = doc.body.children.find(el => el.className.includes('ctx-menu'));
  const items = menu.querySelectorAll('.ctx-item');
  const palette = items.find(el => el.dataset.commandId === 'palette.toggle');
  const about = items.find(el => el.dataset.commandId === 'help.about');
  assert.equal(palette.querySelector('.kbd').textContent, 'Ctrl+3');
  assert.equal(about.querySelector('.kbd').style.display, 'none');
});

test('Esc / 外部点击关闭菜单，aria-expanded 同步', () => {
  const { c, doc, btnMore, docListeners } = load();
  c.HelpMenu.toggle();
  assert.equal(btnMore.attrs['aria-expanded'], 'true');

  (docListeners.keydown || []).forEach(fn => fn({ key: 'Escape', preventDefault() {} }));
  assert.equal(c.HelpMenu.isOpen(), false);
  assert.equal(btnMore.attrs['aria-expanded'], 'false');

  c.HelpMenu.toggle();
  assert.equal(c.HelpMenu.isOpen(), true);
  (docListeners.click || []).forEach(fn => fn({ type: 'click', target: { id: 'elsewhere' } }));
  assert.equal(c.HelpMenu.isOpen(), false);
});

test('i18n-changed / keybindings-changed 刷新标签与快捷键', () => {
  const { c, doc, winListeners } = load();
  c.HelpMenu.toggle();
  const menu = doc.body.children.find(el => el.className.includes('ctx-menu'));
  const palette = menu.querySelectorAll('.ctx-item').find(el => el.dataset.commandId === 'palette.toggle');

  c.Commands.registry['palette.toggle'].label = '命令面板（新）';
  c.Keybindings.map['palette.toggle'] = 'Ctrl+Shift+3';
  (winListeners['i18n-changed'] || []).forEach(fn => fn({ type: 'i18n-changed' }));
  (winListeners['keybindings-changed'] || []).forEach(fn => fn({ type: 'keybindings-changed' }));
  assert.equal(palette.querySelector('.help-menu-label').textContent, '命令面板（新）');
  assert.equal(palette.querySelector('.kbd').textContent, 'Ctrl+Shift+3');
});

test('重复 toggle 翻转开关；未建菜单时 isOpen 为 false', () => {
  const { c, doc } = load();
  assert.equal(c.HelpMenu.isOpen(), false);
  c.HelpMenu.toggle();
  assert.equal(c.HelpMenu.isOpen(), true);
  c.HelpMenu.toggle();
  assert.equal(c.HelpMenu.isOpen(), false);
  // 关闭后菜单应从 DOM 移除
  const menus = doc.body.children.filter(el => el.className && el.className.includes('ctx-menu'));
  assert.equal(menus.length, 0);
});
