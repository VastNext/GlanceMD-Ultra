const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');

function createDomStub() {
  const elements = new Map();
  let idCounter = 0;

  function createElement(tagName) {
    const id = 'el_' + (++idCounter);
    const listeners = {};
    const attributes = {};
    const classList = new Set();
    const children = [];

    const el = {
      _id: id,
      tagName: tagName.toUpperCase(),
      children: children,
      parentNode: null,
      style: {},
      value: '',
      textContent: '',

      get className() {
        return Array.from(classList).join(' ');
      },
      set className(val) {
        classList.clear();
        if (typeof val === 'string' && val.trim()) {
          val.trim().split(/\s+/).forEach(c => classList.add(c));
        }
      },

      setAttribute(name, val) {
        attributes[name] = String(val);
        if (name === 'id') el.id = val;
        if (name === 'class') el.className = val;
        if (name === 'value') el.value = val;
      },
      getAttribute(name) {
        if (name === 'id') return el.id || attributes['id'] || null;
        if (name === 'class') return el.className || attributes['class'] || null;
        if (name === 'value') return el.value !== undefined ? el.value : attributes['value'] || null;
        return attributes[name] !== undefined ? attributes[name] : null;
      },
      removeAttribute(name) {
        delete attributes[name];
        if (name === 'id') delete el.id;
        if (name === 'class') el.className = '';
      },
      classList: {
        add(...cls) {
          cls.forEach(c => {
            if (c) classList.add(c);
          });
        },
        remove(...cls) {
          cls.forEach(c => {
            if (c) classList.delete(c);
          });
        },
        contains(c) {
          return classList.has(c);
        },
        toggle(c, force) {
          if (force === true) {
            this.add(c);
          } else if (force === false) {
            this.remove(c);
          } else if (this.contains(c)) {
            this.remove(c);
          } else {
            this.add(c);
          }
        }
      },
      contains(target) {
        let curr = target;
        while (curr) {
          if (curr === el) return true;
          curr = curr.parentNode;
        }
        return false;
      },
      appendChild(child) {
        if (!child) return child;
        child.parentNode = el;
        children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = children.indexOf(child);
        if (idx !== -1) {
          children.splice(idx, 1);
          child.parentNode = null;
        }
        return child;
      },
      addEventListener(type, fn) {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(fn);
      },
      removeEventListener(type, fn) {
        if (listeners[type]) {
          listeners[type] = listeners[type].filter(f => f !== fn);
        }
      },
      dispatchEvent(event) {
        if (!event.target) event.target = el;
        const list = listeners[event.type] || [];
        for (const fn of list) {
          fn.call(el, event);
        }
        return true;
      },
      querySelector(sel) {
        const results = this.querySelectorAll(sel);
        return results[0] || null;
      },
      querySelectorAll(sel) {
        const found = [];
        function walk(node) {
          if (!node || !node.children) return;
          for (const child of node.children) {
            if (matches(child, sel)) {
              found.push(child);
            }
            walk(child);
          }
        }
        walk(el);
        return found;
      },
      closest(sel) {
        let curr = el;
        while (curr) {
          if (matches(curr, sel)) return curr;
          curr = curr.parentNode;
        }
        return null;
      },
      focus() {
        if (documentStub) documentStub.activeElement = el;
      },
      blur() {
        if (documentStub && documentStub.activeElement === el) {
          documentStub.activeElement = null;
        }
      }
    };

    Object.defineProperty(el, 'innerHTML', {
      get() {
        return el._innerHTML || '';
      },
      set(html) {
        el._innerHTML = html;
        el.children.length = 0;
        parseHtmlToNodes(html, el);
      }
    });

    elements.set(id, el);
    return el;
  }

  function matches(node, sel) {
    if (!node || !sel) return false;
    if (sel.startsWith('#')) {
      return node.id === sel.slice(1) || node.getAttribute('id') === sel.slice(1);
    }
    if (sel.startsWith('.')) {
      const classes = sel.slice(1).split('.');
      return classes.every(c => node.classList.contains(c));
    }
    if (sel === 'tr') return node.tagName === 'TR';
    if (sel === 'td') return node.tagName === 'TD';
    if (sel === 'button') return node.tagName === 'BUTTON';
    if (sel === 'input') return node.tagName === 'INPUT';
    if (sel === 'select') return node.tagName === 'SELECT';
    if (sel === 'div') return node.tagName === 'DIV';
    if (sel === 'span') return node.tagName === 'SPAN';
    return false;
  }

  function parseHtmlToNodes(html, parent) {
    if (!html.includes('<')) {
      parent.textContent = html;
      return;
    }

    const tokenRegex = /<\/?([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
    let match;
    const stack = [parent];

    while ((match = tokenRegex.exec(html)) !== null) {
      const full = match[0];
      if (full.startsWith('</')) {
        if (stack.length > 1) {
          stack.pop();
        }
      } else if (full.startsWith('<')) {
        const tagName = match[1];
        const attrString = match[2] || '';
        const node = createElement(tagName);

        const attrRegex = /([a-zA-Z0-9-_:]+)(?:="([^"]*)")?/g;
        let attrMatch;
        while ((attrMatch = attrRegex.exec(attrString)) !== null) {
          const attrName = attrMatch[1];
          const attrVal = attrMatch[2] !== undefined ? attrMatch[2] : '';
          node.setAttribute(attrName, attrVal);
        }

        const currParent = stack[stack.length - 1];
        if (currParent) {
          currParent.appendChild(node);
        }

        const isSelfClosing = /^(input|img|br|hr|meta|link)$/i.test(tagName) || attrString.trim().endsWith('/');
        if (!isSelfClosing) {
          stack.push(node);
        }
      } else if (match[3]) {
        const text = match[3].trim();
        if (text) {
          const currParent = stack[stack.length - 1];
          if (currParent) {
            currParent.textContent = (currParent.textContent ? currParent.textContent + ' ' : '') + text;
          }
        }
      }
    }
  }

  const documentStub = {
    activeElement: null,
    body: createElement('body'),
    createElement: createElement,
    getElementById(id) {
      function find(node) {
        if (!node) return null;
        if (node.id === id || node.getAttribute('id') === id) return node;
        for (const child of node.children || []) {
          const res = find(child);
          if (res) return res;
        }
        return null;
      }
      return find(this.body);
    },
    addEventListener() {},
    removeEventListener() {}
  };

  return { documentStub, createElement };
}

function makeBindingService(includeQuickopen = false) {
  let schemeId = 'ultra.eclipse';
  let overrides = {};
  const schemes = {
    'ultra.eclipse': [
      { commandId: 'file.open', sequence: 'Ctrl+O', when: 'global', platform: '*', source: 'default', removed: false },
      { commandId: 'file.save', sequence: 'Ctrl+S', when: 'global', platform: '*', source: 'default', removed: false },
      { commandId: 'settings.toggle', sequence: 'Alt+Shift+P', when: 'global', platform: '*', source: 'default', removed: false },
      ...(includeQuickopen ? [{ commandId: 'quickopen.toggle', sequence: 'Ctrl+O', when: 'global', platform: '*', source: 'default', removed: false }] : [])
    ],
    'ultra.vscode': [
      { commandId: 'file.open', sequence: 'Ctrl+O', when: 'global', platform: '*', source: 'default', removed: false }
    ]
  };
  return new (class BindingServiceMock {
    getSchemes() { return Object.keys(schemes).map(id => ({ id, label: id })); }
    getActiveSchemeId() { return schemeId; }
    setScheme(id) { if (!schemes[id]) throw new Error('Unknown'); schemeId = id; return id; }
    getBindings() {
      const base = schemes[schemeId].map(x => ({ ...x }));
      Object.keys(overrides).forEach(id => {
        const i = base.findIndex(x => x.commandId === id);
        if (i >= 0) base.splice(i, 1);
        overrides[id].filter(x => !x.removed && x.sequence).forEach(x => base.push({ ...x }));
      });
      return base;
    }
    getOverrides() { return JSON.parse(JSON.stringify(overrides)); }
    saveOverrides(map) { overrides = JSON.parse(JSON.stringify(map)); return this.getOverrides(); }
  })();
}

function loadKeybindingsSettings(customGlobals = {}) {
  const { documentStub, createElement } = createDomStub();
  const localStorageMock = {};
  const bindingService = customGlobals.BindingService || makeBindingService();
  const customGlobalsWithoutService = Object.assign({}, customGlobals);
  delete customGlobalsWithoutService.BindingService;

  const context = {
    document: documentStub,
    localStorage: {
      getItem: k => localStorageMock[k] || null,
      setItem: (k, v) => { localStorageMock[k] = String(v); },
      removeItem: k => { delete localStorageMock[k]; }
    },
    setTimeout: fn => { fn(); return 1; },
    clearTimeout: () => {},
    BindingService: bindingService,
    window: {
      CustomEvent: function (type, init) {
        return { type, detail: init ? init.detail : null };
      },
      dispatchEvent(e) {},
      addEventListener() {},
      setTimeout: fn => { fn(); return 1; },
      clearTimeout: () => {},
      localStorage: {
        getItem: k => localStorageMock[k] || null,
        setItem: (k, v) => { localStorageMock[k] = String(v); },
        removeItem: k => { delete localStorageMock[k]; }
      },
      ...customGlobalsWithoutService,
      BindingService: bindingService
    },
    console: console,
    ...customGlobalsWithoutService,
    BindingService: bindingService
  };
  context.window.document = documentStub;
  context.window.window = context.window;

  const code = fs.readFileSync('src/frontend/keybindings-settings.js', 'utf8');
  vm.runInNewContext(code, context);

  return {
    KeybindingsSettings: context.window.KeybindingsSettings,
    window: context.window,
    document: documentStub,
    createElement,
    localStorage: localStorageMock
  };
}

test('KeybindingsSettings mounts and renders scheme selector and toolbar', () => {
  const ctx = loadKeybindingsSettings();
  const container = ctx.createElement('div');
  ctx.document.body.appendChild(container);

  ctx.KeybindingsSettings.mount(container);
  const select = container.querySelector('#kb-scheme-select');
  assert.ok(select, 'Scheme select element rendered');

  const schemes = ctx.KeybindingsSettings.getSchemes();
  assert.ok(schemes.length >= 2, 'Has at least Eclipse and VS Code schemes');

  assert.equal(ctx.KeybindingsSettings.getActiveSchemeId(), 'ultra.eclipse');

  ctx.KeybindingsSettings.unmount();
  assert.equal(container.children.length, 0, 'Container cleared on unmount');
});

test('KeybindingsSettings switches scheme and dispatches event', () => {
  let changedEvent = null;
  const ctx = loadKeybindingsSettings();
  ctx.window.dispatchEvent = event => {
    if (event.type === 'scheme-changed') {
      changedEvent = event.detail;
    }
  };

  const container = ctx.createElement('div');
  ctx.document.body.appendChild(container);
  ctx.KeybindingsSettings.mount(container);

  ctx.KeybindingsSettings.setScheme('ultra.vscode');
  assert.equal(ctx.KeybindingsSettings.getActiveSchemeId(), 'ultra.vscode');
  assert.equal(ctx.localStorage['glancemd-ultra-keyboard-scheme'], undefined);
  assert.ok(changedEvent);
  assert.equal(changedEvent.schemeId, 'ultra.vscode');
});

test('KeybindingsSettings search filters by title, id, category, key', () => {
  const ctx = loadKeybindingsSettings({
    Commands: {
      ids: () => ['file.open', 'file.save', 'settings.toggle'],
      get: id => ({ label: id === 'settings.toggle' ? 'Open Preferences' : id })
    }
  });

  const container = ctx.createElement('div');
  ctx.document.body.appendChild(container);
  ctx.KeybindingsSettings.mount(container);

  const state = ctx.KeybindingsSettings._state;
  assert.equal(state.items.length, 3);

  // Search by keyword
  state.dom.searchInput.value = 'Preferences';
  state.dom.searchInput.dispatchEvent({ type: 'input', target: state.dom.searchInput });
  assert.equal(state.filteredItems.length, 1);
  assert.equal(state.filteredItems[0].id, 'settings.toggle');

  // Search by key
  state.dom.searchInput.value = 'Ctrl+O';
  state.dom.searchInput.dispatchEvent({ type: 'input', target: state.dom.searchInput });
  assert.equal(state.filteredItems.length, 1);
  assert.equal(state.filteredItems[0].id, 'file.open');
});

test('KeybindingsSettings chord recorder records 2-stroke chord sequences', () => {
  const ctx = loadKeybindingsSettings();
  const container = ctx.createElement('div');
  ctx.document.body.appendChild(container);
  ctx.KeybindingsSettings.mount(container);

  ctx.KeybindingsSettings.openRecorder('file.open');
  const state = ctx.KeybindingsSettings._state;
  assert.equal(state.recorder.isOpen, true);
  assert.equal(state.recorder.commandId, 'file.open');

  const overlay = ctx.document.getElementById('kb-recorder-overlay');
  assert.ok(overlay);
  const dialog = overlay.querySelector('.kb-recorder-dialog');

  // Stroke 1: Ctrl+K
  dialog.dispatchEvent({
    type: 'keydown',
    key: 'k',
    ctrlKey: true,
    preventDefault() {},
    stopPropagation() {}
  });
  assert.equal(state.recorder.firstStroke, 'Ctrl+K');
  assert.equal(state.recorder.isChordWaiting, true);

  // Stroke 2: Ctrl+O
  dialog.dispatchEvent({
    type: 'keydown',
    key: 'o',
    ctrlKey: true,
    preventDefault() {},
    stopPropagation() {}
  });
  assert.equal(state.recorder.recordedKey, 'Ctrl+K Ctrl+O');
  assert.equal(state.recorder.isChordWaiting, false);

  // Press Enter to save
  dialog.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    preventDefault() {},
    stopPropagation() {}
  });
  assert.equal(state.recorder.isOpen, false);
  assert.equal(state.overrides['file.open'][0].commandId, 'file.open');
  assert.equal(state.overrides['file.open'][0].sequence, 'Ctrl+K Ctrl+O');
});

test('KeybindingsSettings handles unbind, reset and restore defaults', () => {
  const ctx = loadKeybindingsSettings();
  const container = ctx.createElement('div');
  ctx.document.body.appendChild(container);
  ctx.KeybindingsSettings.mount(container);

  // Unbind
  ctx.KeybindingsSettings.unbind('file.open');
  const state = ctx.KeybindingsSettings._state;
  assert.equal(state.overrides['file.open'][0].sequence, '');
  assert.equal(state.overrides['file.open'][0].removed, true);

  // Reset
  ctx.KeybindingsSettings.reset('file.open');
  assert.equal(state.overrides['file.open'], undefined);

  // Set multiple overrides then restore defaults
  ctx.KeybindingsSettings.saveBinding('file.open', 'Ctrl+Alt+O');
  ctx.KeybindingsSettings.saveBinding('file.save', 'Ctrl+Alt+S');
  assert.equal(state.overrides['file.open'][0].sequence, 'Ctrl+Alt+O');

  ctx.KeybindingsSettings.restoreSchemeDefaults();
  assert.equal(Object.keys(state.overrides).length, 0);
});

test('KeybindingsSettings conflict warning in recorder when key is occupied', () => {
  const ctx = loadKeybindingsSettings({
    BindingService: makeBindingService(true),
    Commands: {
      ids: () => ['file.open', 'quickopen.toggle'],
      get: id => ({ label: id === 'file.open' ? '打开文件' : '快速打开' })
    }
  });

  const container = ctx.createElement('div');
  ctx.document.body.appendChild(container);
  ctx.KeybindingsSettings.mount(container);

  // In eclipse scheme, file.open is Ctrl+O. Let's edit quickopen.toggle to also be Ctrl+O
  ctx.KeybindingsSettings.openRecorder('quickopen.toggle');
  const overlay = ctx.document.getElementById('kb-recorder-overlay');
  const dialog = overlay.querySelector('.kb-recorder-dialog');

  dialog.dispatchEvent({
    type: 'keydown',
    key: 'o',
    ctrlKey: true,
    preventDefault() {},
    stopPropagation() {}
  });

  const conflictWarning = overlay.querySelector('#kb-recorder-conflict-warning');
  assert.ok(conflictWarning.classList.contains('show'), 'Conflict warning is shown');
  assert.ok(conflictWarning.textContent.includes('file.open'), 'Warning mentions conflicting command');
});

test('KeybindingsSettings normalizes modifiers and keys correctly', () => {
  const ctx = loadKeybindingsSettings();
  const normalize = ctx.KeybindingsSettings.normalizeSingleStroke;

  assert.equal(normalize({ key: 'Control', ctrlKey: true }), null);
  assert.equal(normalize({ key: 'o', ctrlKey: true, altKey: false }), 'Ctrl+O');
  assert.equal(normalize({ key: 'L', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+L');
  assert.equal(normalize({ key: 'F12' }), 'F12');
  assert.equal(normalize({ key: ' ', ctrlKey: true }), 'Ctrl+Space');
});

test('KeybindingsSettings supports English locale fallback', () => {
  const ctx = loadKeybindingsSettings({
    I18n: {
      getLanguage: () => 'en',
      t: key => key
    }
  });

  const container = ctx.createElement('div');
  ctx.document.body.appendChild(container);
  ctx.KeybindingsSettings.mount(container);

  const label = container.querySelector('.kb-scheme-label');
  assert.equal(label.textContent, 'Keymap Scheme:');

  const btnRestore = container.querySelector('#kb-btn-restore-defaults');
  assert.ok(btnRestore.textContent.includes('Restore Defaults'));
});
