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
      focus() {
        this.focused = true;
        document.activeElement = this;
      },
      scrollIntoView(opt) {
        this.scrolled = true;
        this.scrollOpt = opt;
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
        this.focused = true;
        if (documentStub) documentStub.activeElement = el;
      },
      blur() {
        this.focused = false;
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

function makeBindingService(opts) {
  opts = opts || {};
  let schemeId = 'ultra.eclipse';
  let overrides = {};
  const schemes = {
    'ultra.eclipse': [
      { commandId: 'file.open', sequence: 'Ctrl+O', when: 'global', platform: '*', source: 'default', removed: false },
      { commandId: 'file.save', sequence: 'Ctrl+S', when: 'global', platform: '*', source: 'default', removed: false },
      { commandId: 'settings.toggle', sequence: 'Alt+Shift+P', when: 'global', platform: '*', source: 'default', removed: false },
      ...(opts.quickopen ? [{ commandId: 'quickopen.toggle', sequence: 'Ctrl+O', when: 'global', platform: '*', source: 'default', removed: false }] : []),
      // 模拟 vscode 方案中 editor.toggleSplit 的同命令双绑定场景
      ...(opts.multiBinding ? [
        { commandId: 'editor.toggleSplit', sequence: 'Ctrl+\\', when: 'global', platform: '*', source: 'default', removed: false },
        { commandId: 'editor.toggleSplit', sequence: 'Ctrl+K V', when: 'global', platform: '*', source: 'default', removed: false }
      ] : []),
      // 剪切/复制类原生放行绑定（编辑时不得丢失 passthrough）
      ...(opts.copyPassthrough ? [
        { commandId: 'editor.copy', sequence: 'Ctrl+C', when: 'editorTextFocus', platform: '*', source: 'default', removed: false, passthrough: true }
      ] : []),
      // 平台专属绑定与跨平台重叠冲突场景
      ...(opts.platformBinding ? [
        { commandId: 'editor.goToLine', sequence: 'Ctrl+L', when: 'editorTextFocus', platform: 'Windows', source: 'default', removed: false },
        { commandId: 'misc.anyPlatform', sequence: 'Ctrl+Alt+K', when: 'global', platform: '*', source: 'default', removed: false },
        { commandId: 'misc.macOnly', sequence: 'Ctrl+Alt+L', when: 'global', platform: 'macOS', source: 'default', removed: false }
      ] : [])
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
      // 与真实 BindingService 一致：override 按命令级全量替换默认绑定
      let base = schemes[schemeId].map(x => ({ ...x }));
      Object.keys(overrides).forEach(id => {
        base = base.filter(x => x.commandId !== id);
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
    BindingService: makeBindingService({ quickopen: true }),
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

test('KeybindingsSettings recorder restores focus and closes on backdrop click', () => {
  const ctx = loadKeybindingsSettings();
  const container = ctx.createElement('div');
  ctx.document.body.appendChild(container);
  ctx.KeybindingsSettings.mount(container);

  const prevBtn = ctx.createElement('button');
  prevBtn.focus();
  assert.equal(ctx.document.activeElement, prevBtn);

  ctx.KeybindingsSettings.openRecorder('file.open');
  const state = ctx.KeybindingsSettings._state;
  assert.equal(state.recorder.isOpen, true);

  const overlay = ctx.document.getElementById('kb-recorder-overlay');
  assert.ok(overlay);
  assert.equal(overlay.classList.contains('open'), true);

  // Click on backdrop
  overlay.dispatchEvent({ type: 'click', target: overlay });
  assert.equal(state.recorder.isOpen, false);
  assert.equal(overlay.classList.contains('open'), false);
  assert.equal(prevBtn.focused, true);
});

test('KeybindingsSettings saveBinding 拒绝与其他命令冲突的保存（仅提示不落盘是缺陷）', () => {
  const ctx = loadKeybindingsSettings();
  const container = ctx.createElement('div');
  ctx.document.body.appendChild(container);
  ctx.KeybindingsSettings.mount(container);

  // file.save 已占用 Ctrl+S (when=global)，为 file.open 保存相同组合键应被拒绝
  const result = ctx.KeybindingsSettings.saveBinding('file.open', 'Ctrl+S', 'global');
  assert.equal(result.ok, false, '冲突保存被拒绝');
  assert.equal(result.reason, 'conflict');
  assert.equal(result.conflict.commandId, 'file.save', '冲突目标指向占用命令');

  // 冲突不落盘
  const state = ctx.KeybindingsSettings._state;
  assert.equal(state.overrides['file.open'], undefined, '冲突保存不写入 overrides');

  // 无冲突时仍可正常保存
  const okResult = ctx.KeybindingsSettings.saveBinding('file.open', 'Ctrl+Alt+O', 'global');
  assert.equal(okResult.ok, true);
  assert.equal(state.overrides['file.open'][0].sequence, 'Ctrl+Alt+O');
});

test('KeybindingsSettings 录制弹层保存被冲突拒绝时不关闭且显示错误', () => {
  const ctx = loadKeybindingsSettings();
  const container = ctx.createElement('div');
  ctx.document.body.appendChild(container);
  ctx.KeybindingsSettings.mount(container);

  ctx.KeybindingsSettings.openRecorder('file.open');
  const overlay = ctx.document.getElementById('kb-recorder-overlay');
  const dialog = overlay.querySelector('.kb-recorder-dialog');
  const state = ctx.KeybindingsSettings._state;

  // 录制 Ctrl+S（与 file.save 冲突）
  dialog.dispatchEvent({
    type: 'keydown',
    key: 's',
    ctrlKey: true,
    preventDefault() {},
    stopPropagation() {}
  });

  // Enter 保存 → 被冲突拒绝：弹层保持打开，overrides 不落盘
  dialog.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    preventDefault() {},
    stopPropagation() {}
  });
  assert.equal(state.recorder.isOpen, true, '保存被拒后弹层不关闭');
  assert.equal(state.overrides['file.open'], undefined, '冲突保存不落盘');

  const conflictWarning = overlay.querySelector('#kb-recorder-conflict-warning');
  assert.ok(conflictWarning.classList.contains('show'), '保存被拒时展示错误提示');
  assert.ok(conflictWarning.textContent.includes('file.save'), '提示包含冲突命令');

  // 修正为无冲突组合键后可保存并关闭
  dialog.dispatchEvent({
    type: 'keydown',
    key: 'k',
    ctrlKey: true,
    preventDefault() {},
    stopPropagation() {}
  });
  dialog.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    preventDefault() {},
    stopPropagation() {}
  });
  assert.equal(state.recorder.isOpen, false, '合法保存后弹层关闭');
  assert.equal(state.overrides['file.open'][0].sequence, 'Ctrl+K');
});

test('KeybindingsSettings saveBinding 拒绝非法 When 表达式', () => {
  const ctx = loadKeybindingsSettings({
    When: {
      parse(expr) {
        // 模拟 when-clause.js 的语法校验：悬空运算符/未闭合括号抛错
        if (/\s&&\s*$|\|\|\s*$|\($/.test(expr)) throw new Error('Expected key');
        return {};
      }
    }
  });
  const container = ctx.createElement('div');
  ctx.document.body.appendChild(container);
  ctx.KeybindingsSettings.mount(container);
  const state = ctx.KeybindingsSettings._state;

  // 非法 When 拒绝保存
  const bad = ctx.KeybindingsSettings.saveBinding('file.open', 'Ctrl+Alt+O', 'a &&');
  assert.equal(bad.ok, false, '非法 When 保存被拒绝');
  assert.equal(bad.reason, 'invalid-when');
  assert.equal(state.overrides['file.open'], undefined, '非法 When 不落盘');

  // 合法 When 正常保存
  const good = ctx.KeybindingsSettings.saveBinding('file.open', 'Ctrl+Alt+O', 'editorTextFocus');
  assert.equal(good.ok, true);
  assert.equal(state.overrides['file.open'][0].when, 'editorTextFocus');

  // 空与 global 视为合法
  assert.equal(ctx.KeybindingsSettings.saveBinding('file.save', 'Ctrl+Alt+S', 'global').ok, true);
});

test('KeybindingsSettings saveBinding 仅替换所选目标，保留同命令其他绑定', () => {
  const svc = makeBindingService({ multiBinding: true }); // editor.toggleSplit 有 Ctrl+\ 与 Ctrl+K V 两条默认绑定
  const ctx = loadKeybindingsSettings({
    BindingService: svc,
    Commands: { ids: () => ['editor.toggleSplit'], get: () => ({ label: '切换分屏' }) }
  });
  const container = ctx.createElement('div');
  ctx.document.body.appendChild(container);
  ctx.KeybindingsSettings.mount(container);

  // 编辑第一条（Ctrl+\）为新键，指定 previousSequence
  const result = ctx.KeybindingsSettings.saveBinding('editor.toggleSplit', 'Ctrl+X', 'global', 'Ctrl+\\');
  assert.equal(result.ok, true);

  const effective = svc.getBindings()
    .filter(b => b.commandId === 'editor.toggleSplit')
    .map(b => b.sequence)
    .sort();
  assert.deepEqual(effective, ['Ctrl+K V', 'Ctrl+X'], '其余绑定保留，仅目标被替换');

  // 不传 previousSequence 时替换第一条（与 UI 每命令一行语义一致），其余仍保留
  const result2 = ctx.KeybindingsSettings.saveBinding('editor.toggleSplit', 'Ctrl+Alt+X', 'global');
  assert.equal(result2.ok, true);
  const effective2 = svc.getBindings()
    .filter(b => b.commandId === 'editor.toggleSplit')
    .map(b => b.sequence)
    .sort();
  assert.deepEqual(effective2, ['Ctrl+Alt+X', 'Ctrl+K V'], '未指定目标时替换第一条且保留其余');
});

test('KeybindingsSettings 冲突检查扫描全部绑定条目（含同命令多绑定），而非仅每命令第一条', () => {
  const svc = makeBindingService({ multiBinding: true });
  const ctx = loadKeybindingsSettings({
    BindingService: svc,
    Commands: { ids: () => ['editor.toggleSplit'], get: () => ({ label: '切换分屏' }) }
  });
  const container = ctx.createElement('div');
  ctx.document.body.appendChild(container);
  ctx.KeybindingsSettings.mount(container);
  const state = ctx.KeybindingsSettings._state;

  // 漏报复现：file.open 拟改为 Ctrl+K V —— 该键被 editor.toggleSplit 的"第二条"占用；
  // 旧实现 items 仅含每命令第一条（Ctrl+\）而漏检，导致冲突绑定静默落盘
  const r1 = ctx.KeybindingsSettings.saveBinding('file.open', 'Ctrl+K V', 'global');
  assert.equal(r1.ok, false, '同命令第二条绑定占用的键也必须判冲突');
  assert.equal(r1.reason, 'conflict');
  assert.equal(r1.conflict.commandId, 'editor.toggleSplit');
  assert.equal(state.overrides['file.open'], undefined, '漏报场景下不落盘');

  // 同命令内部冲突：把 toggleSplit 第一条改成与第二条相同的键+上下文 → 拒绝
  // （仅排除被编辑的目标条目本身，同命令其余条目仍参与冲突判定）
  const r2 = ctx.KeybindingsSettings.saveBinding('editor.toggleSplit', 'Ctrl+K V', 'global', 'Ctrl+\\');
  assert.equal(r2.ok, false, '命令内部按键重叠也是运行时冲突');
  assert.equal(r2.reason, 'conflict');
  assert.equal(r2.conflict.commandId, 'editor.toggleSplit');
  assert.equal(state.overrides['editor.toggleSplit'], undefined, '内部冲突不落盘');
});

test('KeybindingsSettings 编辑绑定保留目标的 passthrough 与 platform', () => {
  const svc = makeBindingService({ copyPassthrough: true, platformBinding: true });
  const ctx = loadKeybindingsSettings({
    BindingService: svc,
    Commands: { ids: () => ['editor.copy', 'editor.goToLine'], get: id => ({ label: id }) }
  });
  const container = ctx.createElement('div');
  ctx.document.body.appendChild(container);
  ctx.KeybindingsSettings.mount(container);
  const state = ctx.KeybindingsSettings._state;

  // passthrough：编辑 editor.copy（Ctrl+C 剪切复制类原生放行）为新键，放行语义不得丢失
  const r1 = ctx.KeybindingsSettings.saveBinding('editor.copy', 'Ctrl+Shift+C', 'editorTextFocus');
  assert.equal(r1.ok, true);
  const copyRec = state.overrides['editor.copy'][0];
  assert.equal(copyRec.passthrough, true, '编辑后 passthrough 保留，剪切复制等原生放行不被破坏');
  assert.equal(copyRec.platform, '*', '编辑后 platform 保留目标值');

  // platform：编辑 Windows 专属绑定，替换条目不得漂移为 '*'
  const r2 = ctx.KeybindingsSettings.saveBinding('editor.goToLine', 'Ctrl+Alt+G', 'global');
  assert.equal(r2.ok, true);
  const gotoRec = state.overrides['editor.goToLine'][0];
  assert.equal(gotoRec.platform, 'Windows', '替换条目继承目标的平台生效域');

  // 纯新增（无既有目标）时使用默认值
  const r3 = ctx.KeybindingsSettings.saveBinding('brand.new.command', 'Ctrl+9', 'global');
  assert.equal(r3.ok, true);
  const newRec = state.overrides['brand.new.command'][0];
  assert.equal(newRec.platform, '*', '无目标时 platform 默认 *');
  assert.equal(newRec.passthrough, false, '无目标时 passthrough 默认 false');
});

test('KeybindingsSettings 冲突判定考虑 platform 生效域重叠', () => {
  const svc = makeBindingService({ platformBinding: true });
  const ctx = loadKeybindingsSettings({
    BindingService: svc,
    Commands: { ids: () => ['editor.goToLine'], get: id => ({ label: id }) }
  });
  const container = ctx.createElement('div');
  ctx.document.body.appendChild(container);
  ctx.KeybindingsSettings.mount(container);
  const state = ctx.KeybindingsSettings._state;

  // '*' 全平台占位 × Windows 目标 → 生效域重叠 → 冲突拒绝
  const r1 = ctx.KeybindingsSettings.saveBinding('editor.goToLine', 'Ctrl+Alt+K', 'global');
  assert.equal(r1.ok, false, '全平台占位与平台专属目标重叠，视为冲突');
  assert.equal(r1.conflict.commandId, 'misc.anyPlatform');
  assert.equal(state.overrides['editor.goToLine'], undefined);

  // 'macOS' 占位 × Windows 目标 → 生效域不重叠 → 允许保存
  const r2 = ctx.KeybindingsSettings.saveBinding('editor.goToLine', 'Ctrl+Alt+L', 'global');
  assert.equal(r2.ok, true, '平台不重叠的占用不构成冲突');
  assert.equal(state.overrides['editor.goToLine'][0].platform, 'Windows');
});
