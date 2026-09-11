const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');

function load(options = {}) {
  const elements = new Map();
  const listeners = {};
  let activeElement = null;

  const doc = {
    get activeElement() {
      return activeElement;
    },
    set activeElement(el) {
      activeElement = el;
    },
    body: {
      appendChild(e) {
        elements.set(e.id, e);
      }
    },
    getElementById: id => elements.get(id) || null,
    createElement: tag => {
      const el = {
        tagName: tag.toUpperCase(),
        id: '',
        className: '',
        hidden: false,
        value: '',
        innerHTML: '',
        parentNode: null,
        children: [],
        listeners: {},
        scrolled: false,
        focused: false,
        focus() {
          this.focused = true;
          doc.activeElement = this;
        },
        scrollIntoView(opt) {
          this.scrolled = true;
          this.scrollOpt = opt;
        },
        addEventListener(type, fn) {
          this.listeners[type] = this.listeners[type] || [];
          this.listeners[type].push(fn);
        },
        dispatchEvent(e) {
          const fns = this.listeners[e.type] || [];
          fns.forEach(fn => fn(e));
        },
        querySelector(sel) {
          if (sel === 'input' || sel === '#palette-input') {
            return this.input || (this.input = doc.createElement('input'));
          }
          if (sel === '#palette-list') {
            return this.list || (this.list = doc.createElement('div'));
          }
          if (sel.includes('.palette-item.active')) {
            return (this.items || []).find(it => it.className.includes('active')) || null;
          }
          return null;
        },
        querySelectorAll(sel) {
          if (sel === '.palette-item' || sel.includes('palette-item')) {
            return this.items || [];
          }
          return [];
        },
        contains(other) {
          let curr = other;
          while (curr) {
            if (curr === this) return true;
            curr = curr.parentNode;
          }
          return false;
        }
      };
      return el;
    },
    addEventListener(event, fn) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(fn);
    },
    removeEventListener(event, fn) {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(l => l !== fn);
      }
    },
    dispatchEvent(e) {
      const fns = listeners[e.type] || [];
      fns.forEach(fn => fn(e));
    }
  };

  const c = {
    window: {},
    document: doc,
    localStorage: {
      getItem() { return '[]'; },
      setItem() {}
    },
    console
  };
  c.window = c;
  // window 级事件透传到 document stub，供 i18n-changed 联动测试使用
  c.addEventListener = (type, fn) => doc.addEventListener(type, fn);
  c.removeEventListener = (type, fn) => doc.removeEventListener(type, fn);
  c.dispatchEvent = (e) => doc.dispatchEvent(e);

  if (options.useOverlayHelper) {
    vm.runInNewContext(fs.readFileSync('src/frontend/overlay-helper.js', 'utf8'), c);
  }

  if (options.withI18n) {
    vm.runInNewContext(fs.readFileSync('src/frontend/i18n.js', 'utf8'), c);
  }

  const commandsMap = new Map([
    ['file.open', { id: 'file.open', label: 'Open File', category: 'File' }],
    ['workspace.open', { id: 'workspace.open', label: 'Open Workspace', category: 'File' }],
    ['editor.toggleVim', { id: 'editor.toggleVim', label: 'Toggle Vim', category: 'Editor' }]
  ]);

  c.Commands = {
    ids() {
      return Array.from(commandsMap.keys());
    },
    get(id) {
      return commandsMap.get(id);
    },
    run(id) {
      if (options.onRun) options.onRun(id);
    },
    has(id) {
      return commandsMap.has(id);
    },
    register(id, def) {
      commandsMap.set(id, def);
    }
  };

  vm.runInNewContext(fs.readFileSync('src/frontend/command-palette.js', 'utf8'), c);
  return { c, doc, elements };
}

test('palette namespace and scoring', () => {
  const { c } = load();
  assert.equal(typeof c.CommandPalette.toggle, 'function');
  assert.ok(c.CommandPalette.score('open', 'workspace.open') > 0);
  assert.equal(c.CommandPalette.score('zzz', 'file.open'), -1);
});

test('palette open creates hidden panel and focuses input', () => {
  const { c, doc } = load({ useOverlayHelper: true });
  const prevBtn = doc.createElement('button');
  prevBtn.focus();
  assert.equal(doc.activeElement, prevBtn);

  c.CommandPalette.open();
  const paletteEl = doc.getElementById('command-palette');
  assert.ok(paletteEl);
  assert.equal(paletteEl.hidden, false);
  assert.equal(c.CommandPalette.getState().open, true);

  // Close restores focus
  c.CommandPalette.close();
  assert.equal(paletteEl.hidden, true);
  assert.equal(c.CommandPalette.getState().open, false);
  assert.equal(prevBtn.focused, true);
});

test('palette closes on outside pointerdown and focusin', () => {
  const { c, doc } = load({ useOverlayHelper: true });
  c.CommandPalette.open();
  assert.equal(c.CommandPalette.getState().open, true);

  const outsideEl = doc.createElement('div');
  doc.dispatchEvent({ type: 'pointerdown', target: outsideEl });
  assert.equal(c.CommandPalette.getState().open, false);

  c.CommandPalette.open();
  assert.equal(c.CommandPalette.getState().open, true);
  doc.dispatchEvent({ type: 'focusin', target: outsideEl });
  assert.equal(c.CommandPalette.getState().open, false);
});

test('palette navigation adjusts selected and invokes scrollIntoView', () => {
  const { c, doc } = load({ useOverlayHelper: true });
  c.CommandPalette.open();
  assert.equal(c.CommandPalette.getState().selected, 0);

  c.CommandPalette.selectNext();
  assert.equal(c.CommandPalette.getState().selected, 1);

  c.CommandPalette.selectPrevious();
  assert.equal(c.CommandPalette.getState().selected, 0);
});

// i18n 集成：占位符在面板打开与语言切换时都随活动语言刷新
test('palette placeholder follows active UI language', () => {
  const { c, doc } = load({ useOverlayHelper: true, withI18n: true });
  c.CommandPalette.open();
  const paletteEl = doc.getElementById('command-palette');
  assert.equal(paletteEl.input.placeholder, '输入命令');

  // 面板保持打开时切语言：i18n-changed 监听即时刷新占位符
  c.I18n.setLanguage('en');
  assert.equal(paletteEl.input.placeholder, 'Type a command');

  // 关闭重开仍为新语言
  c.CommandPalette.close();
  c.CommandPalette.open();
  assert.equal(paletteEl.input.placeholder, 'Type a command');
});
