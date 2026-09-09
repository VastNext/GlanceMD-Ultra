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
          if (sel === 'input' || sel === '#quick-open-input') {
            return this.input || (this.input = doc.createElement('input'));
          }
          if (sel === '#quick-open-list') {
            return this.list || (this.list = doc.createElement('div'));
          }
          if (sel.includes('.quick-open-item.active')) {
            return (this.items || []).find(it => it.className.includes('active')) || null;
          }
          return null;
        },
        querySelectorAll(sel) {
          if (sel === '.quick-open-item' || sel.includes('quick-open-item')) {
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

  const wsHandlers = {};
  const commandsMap = new Map();

  const c = {
    window: {},
    document: doc,
    console,
    Workspace: {
      on(evt, fn) {
        wsHandlers[evt] = wsHandlers[evt] || [];
        wsHandlers[evt].push(fn);
      },
      emit(evt, data) {
        (wsHandlers[evt] || []).forEach(fn => fn(data));
      }
    },
    Commands: {
      ids() {
        return Array.from(commandsMap.keys());
      },
      get(id) {
        return commandsMap.get(id);
      },
      run(id, arg) {
        if (options.onRun) options.onRun(id, arg);
      },
      has(id) {
        return commandsMap.has(id);
      },
      register(id, def) {
        commandsMap.set(id, def);
      }
    },
    TabManager: options.TabManager || {
      getTabs() {
        return [
          { id: 'tab-1', title: 'README.md', path: 'README.md', isDirty: false, active: true },
          { id: 'tab-2', title: 'config.json', path: 'src/config.json', isDirty: true, active: false }
        ];
      },
      switchTab(id) {
        if (options.onSwitchTab) options.onSwitchTab(id);
      }
    }
  };
  c.window = c;

  if (options.useOverlayHelper) {
    vm.runInNewContext(fs.readFileSync('src/frontend/overlay-helper.js', 'utf8'), c);
  }

  vm.runInNewContext(fs.readFileSync('src/frontend/quick-open.js', 'utf8'), c);

  return { c, doc, elements, wsHandlers, commandsMap };
}

test('quick open score favors matching filename', () => {
  const { c } = load();
  assert.ok(c.QuickOpen.score('read', 'docs/readme.md') > c.QuickOpen.score('read', 'docs/example.md'));
});

test('quick open toggle creates floating panel and closes on close', () => {
  const { c, doc } = load({ useOverlayHelper: true });
  c.QuickOpen.open();
  const el = doc.getElementById('quick-open');
  assert.ok(el);
  assert.equal(el.hidden, false);
  assert.equal(c.QuickOpen.getState().open, true);

  c.QuickOpen.close();
  assert.equal(el.hidden, true);
  assert.equal(c.QuickOpen.getState().open, false);
});

test('quick open setFiles deduplicates and updates state', () => {
  const { c } = load();
  c.QuickOpen.setFiles(['a.md', 'docs/b.md', 'a.md']);
  assert.deepEqual(Array.from(c.QuickOpen.getState().files), ['a.md', 'docs/b.md']);
});

test('quick open deduplicates tree-listed recursive results', () => {
  const { c } = load();
  c.Workspace.emit('workspace:opened', { root: '/project' });
  c.Workspace.emit('workspace:tree-listed', {
    entries: [
      { relPath: 'src/app.js', kind: 'file' },
      { relPath: 'src/tabs.js', kind: 'file' }
    ]
  });
  // Simulate duplicate tree-listed event from deeper scan
  c.Workspace.emit('workspace:tree-listed', {
    entries: [
      { relPath: 'src/app.js', kind: 'file' },
      { relPath: 'docs/readme.md', kind: 'file' }
    ]
  });
  assert.deepEqual(Array.from(c.QuickOpen.getState().files), ['src/app.js', 'src/tabs.js', 'docs/readme.md']);
});

test('quick open tab switcher mode is isolated from workspace files', () => {
  let switchedTo = null;
  const { c } = load({
    onSwitchTab(id) { switchedTo = id; }
  });

  // Open in tabs mode
  c.QuickOpen.openTabs();
  assert.equal(c.QuickOpen.getState().mode, 'tabs');
  assert.equal(c.QuickOpen.getState().open, true);

  // TabManager has 2 tabs
  const tabs = c.QuickOpen.getTabs();
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].id, 'tab-1');

  // Open selected tab
  c.QuickOpen.openSelected();
  assert.equal(switchedTo, 'tab-1');
  assert.equal(c.QuickOpen.getState().open, false);
});

test('quick open closes on outside pointerdown and restores focus', () => {
  const { c, doc } = load({ useOverlayHelper: true });
  const editorBtn = doc.createElement('button');
  editorBtn.focus();
  assert.equal(doc.activeElement, editorBtn);

  c.QuickOpen.open();
  assert.equal(c.QuickOpen.getState().open, true);

  const outside = doc.createElement('div');
  doc.dispatchEvent({ type: 'pointerdown', target: outside });
  assert.equal(c.QuickOpen.getState().open, false);
  assert.equal(editorBtn.focused, true);
});
