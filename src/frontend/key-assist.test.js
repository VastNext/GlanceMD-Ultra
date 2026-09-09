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
      },
      getAttribute(name) {
        if (name === 'id') return el.id || attributes['id'] || null;
        if (name === 'class') return el.className || attributes['class'] || null;
        return attributes[name] !== undefined ? attributes[name] : null;
      },
      removeAttribute(name) {
        delete attributes[name];
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
      },
      scrollIntoView() {}
    };

    // Helper for innerHTML parsing of basic templates
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
    if (sel === 'li') return node.tagName === 'LI';
    if (sel === 'button') return node.tagName === 'BUTTON';
    if (sel === 'input') return node.tagName === 'INPUT';
    if (sel === 'div') return node.tagName === 'DIV';
    if (sel === 'ul') return node.tagName === 'UL';
    if (sel === 'span') return node.tagName === 'SPAN';
    return false;
  }

  function parseHtmlToNodes(html, parent) {
    if (!html.includes('<')) {
      parent.textContent = html;
      return;
    }

    // Match list items
    const liRegex = /<li\s+([^>]+)>([\s\S]*?)<\/li>/gi;
    let liMatch;
    let foundLi = false;

    while ((liMatch = liRegex.exec(html)) !== null) {
      foundLi = true;
      const attrStr = liMatch[1];
      const li = createElement('li');

      const idM = attrStr.match(/id="([^"]+)"/i);
      if (idM) li.setAttribute('id', idM[1]);

      const classM = attrStr.match(/class="([^"]+)"/i);
      if (classM) li.className = classM[1];

      const idxM = attrStr.match(/data-index="([^"]+)"/i);
      if (idxM) li.setAttribute('data-index', idxM[1]);

      const dataIdM = attrStr.match(/data-id="([^"]+)"/i);
      if (dataIdM) li.setAttribute('data-id', dataIdM[1]);

      const roleM = attrStr.match(/role="([^"]+)"/i);
      if (roleM) li.setAttribute('role', roleM[1]);

      const ariaSelM = attrStr.match(/aria-selected="([^"]+)"/i);
      if (ariaSelM) li.setAttribute('aria-selected', ariaSelM[1]);

      parent.appendChild(li);
    }

    if (foundLi) return;

    if (html.includes('key-assist-empty')) {
      const emptyLi = createElement('li');
      emptyLi.className = 'key-assist-empty';
      emptyLi.textContent = 'empty';
      parent.appendChild(emptyLi);
      return;
    }

    if (html.includes('key-assist-header') || html.includes('key-assist-dialog')) {
      // Header
      const header = createElement('div');
      header.className = 'key-assist-header';
      const titleWrap = createElement('div');
      titleWrap.className = 'key-assist-title-wrap';
      const title = createElement('h2');
      title.id = 'key-assist-title';
      title.setAttribute('id', 'key-assist-title');
      const titleM = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
      if (titleM) title.textContent = titleM[1];

      const badge = createElement('span');
      badge.id = 'key-assist-context-badge';
      badge.setAttribute('id', 'key-assist-context-badge');
      titleWrap.appendChild(title);
      titleWrap.appendChild(badge);
      header.appendChild(titleWrap);

      const btnClose = createElement('button');
      btnClose.id = 'key-assist-btn-close';
      btnClose.setAttribute('id', 'key-assist-btn-close');
      header.appendChild(btnClose);
      parent.appendChild(header);

      // Search box
      const searchBox = createElement('div');
      searchBox.className = 'key-assist-search-box';
      const input = createElement('input');
      input.id = 'key-assist-search-input';
      input.setAttribute('id', 'key-assist-search-input');
      const phM = html.match(/placeholder="([^"]+)"/i);
      if (phM) input.setAttribute('placeholder', phM[1]);
      searchBox.appendChild(input);
      parent.appendChild(searchBox);

      // List
      const ul = createElement('ul');
      ul.id = 'key-assist-list';
      ul.setAttribute('id', 'key-assist-list');
      parent.appendChild(ul);

      // Footer
      const footer = createElement('div');
      footer.className = 'key-assist-footer';
      const countEl = createElement('div');
      countEl.id = 'key-assist-count';
      countEl.setAttribute('id', 'key-assist-count');
      footer.appendChild(countEl);
      parent.appendChild(footer);

      // Live region
      const live = createElement('div');
      live.id = 'key-assist-live-region';
      live.setAttribute('id', 'key-assist-live-region');
      parent.appendChild(live);
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

function loadKeyAssist(customGlobals = {}) {
  const { documentStub, createElement } = createDomStub();
  const context = {
    document: documentStub,
    setTimeout: fn => { fn(); return 1; },
    clearTimeout: () => {},
    window: {
      CustomEvent: function (type, init) {
        return { type, detail: init ? init.detail : null };
      },
      dispatchEvent(e) {},
      addEventListener() {},
      setTimeout: fn => { fn(); return 1; },
      clearTimeout: () => {},
      ...customGlobals
    },
    console: console,
    ...customGlobals
  };
  context.window.document = documentStub;
  context.window.window = context.window;

  // Mock initial document.activeElement
  const initialFocus = createElement('textarea');
  documentStub.body.appendChild(initialFocus);
  initialFocus.focus();

  const code = fs.readFileSync('src/frontend/key-assist.js', 'utf8');
  vm.runInNewContext(code, context);

  return {
    KeyAssist: context.window.KeyAssist,
    window: context.window,
    document: documentStub,
    initialFocus
  };
}

test('KeyAssist opens, sets ARIA attributes and focus restoration', () => {
  const ctx = loadKeyAssist();
  assert.equal(ctx.KeyAssist.isOpen(), false);

  ctx.KeyAssist.open();
  assert.equal(ctx.KeyAssist.isOpen(), true);

  const dialog = ctx.document.getElementById('key-assist-search-input');
  assert.ok(dialog);

  // Check ARIA
  const overlay = ctx.document.body.querySelector('.key-assist-overlay');
  assert.ok(overlay);
  assert.equal(overlay.getAttribute('aria-hidden'), 'false');

  ctx.KeyAssist.close();
  assert.equal(ctx.KeyAssist.isOpen(), false);
  assert.equal(overlay.getAttribute('aria-hidden'), 'true');
  assert.equal(ctx.document.activeElement, ctx.initialFocus, 'Restores previous active element');
});

test('KeyAssist navigates with Arrow keys and updates selection', () => {
  const commandsRun = [];
  const ctx = loadKeyAssist({
    Commands: {
      ids: () => ['file.open', 'workspace.open', 'settings.toggle'],
      get: id => ({ label: 'Label ' + id, run: () => commandsRun.push(id) }),
      run: id => commandsRun.push(id)
    },
    BindingService: new (class {
      getBindings() { return [
        { commandId: 'file.open', sequence: 'Ctrl+O', source: 'default' },
        { commandId: 'workspace.open', sequence: 'Ctrl+K Ctrl+O', source: 'default' },
        { commandId: 'settings.toggle', sequence: '', source: 'default' }
      ]; }
      execute(id) { commandsRun.push(id); }
    })()
  });

  ctx.KeyAssist.open();
  const state = ctx.KeyAssist._state;
  assert.equal(state.selectedIndex, 0);

  // ArrowDown
  state.dom.dialog.dispatchEvent({ type: 'keydown', key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  assert.equal(state.selectedIndex, 1);

  // ArrowDown again
  state.dom.dialog.dispatchEvent({ type: 'keydown', key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  assert.equal(state.selectedIndex, 2);

  // ArrowUp
  state.dom.dialog.dispatchEvent({ type: 'keydown', key: 'ArrowUp', preventDefault() {}, stopPropagation() {} });
  assert.equal(state.selectedIndex, 1);

  // Enter executes selected command
  state.dom.dialog.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(commandsRun, ['workspace.open']);
  assert.equal(ctx.KeyAssist.isOpen(), false, 'Closes upon execution');
});

test('KeyAssist search filtering matches command title and id', () => {
  const ctx = loadKeyAssist({
    Commands: {
      get: id => ({ label: id === 'settings.toggle' ? 'Open Settings' : 'Command ' + id }),
      run: () => {}
    },
    BindingService: new (class {
      getBindings() { return [
        { commandId: 'file.open', sequence: 'Ctrl+O', source: 'default' },
        { commandId: 'workspace.open', sequence: 'Ctrl+K Ctrl+O', source: 'default' },
        { commandId: 'settings.toggle', sequence: 'Alt+Shift+P', source: 'default' }
      ]; }
    })()
  });

  ctx.KeyAssist.open();
  const state = ctx.KeyAssist._state;
  assert.equal(state.filteredItems.length, 3);

  // Filter for 'Settings'
  state.dom.searchInput.value = 'Settings';
  state.dom.searchInput.dispatchEvent({ type: 'input', target: state.dom.searchInput });

  assert.equal(state.filteredItems.length, 1);
  assert.equal(state.filteredItems[0].id, 'settings.toggle');
});

test('KeyAssist F2 triggers edit binding event/callback and Delete triggers unbind', () => {
  let editEventDetail = null;
  let customCallbackCalled = false;
  let unbindCalled = null;

  const ctx = loadKeyAssist({
    BindingService: new (class {
      getBindings() { return [{ commandId: 'file.open', title: 'Open File', sequence: 'Ctrl+O', source: 'default' }]; }
      execute() {}
      unbind(id) { unbindCalled = id; }
    })()
  });

  ctx.window.addEventListener = (type, fn) => {};
  ctx.window.dispatchEvent = event => {
    if (event.type === 'key-assist-edit-binding') {
      editEventDetail = event.detail;
    }
  };

  ctx.KeyAssist.open({
    onEdit: item => {
      customCallbackCalled = true;
    }
  });

  const state = ctx.KeyAssist._state;
  // Press F2
  state.dom.dialog.dispatchEvent({ type: 'keydown', key: 'F2', preventDefault() {}, stopPropagation() {} });
  assert.ok(editEventDetail);
  assert.equal(editEventDetail.commandId, 'file.open');
  assert.equal(customCallbackCalled, true);

  // Press Delete
  state.dom.dialog.dispatchEvent({ type: 'keydown', key: 'Delete', preventDefault() {}, stopPropagation() {} });
  assert.equal(unbindCalled, 'file.open');
});

test('KeyAssist toggle opens when closed, closes when open', () => {
  const ctx = loadKeyAssist();
  assert.equal(ctx.KeyAssist.isOpen(), false);
  ctx.KeyAssist.toggle();
  assert.equal(ctx.KeyAssist.isOpen(), true);
  ctx.KeyAssist.toggle();
  assert.equal(ctx.KeyAssist.isOpen(), false);
});

test('KeyAssist respects disabled commands and does not run them', () => {
  let executed = false;
  const ctx = loadKeyAssist({
    BindingService: new (class {
      getBindings() { return [{ commandId: 'file.save', title: 'Save File', sequence: 'Ctrl+S', source: 'default', enabled: false }]; }
      execute() { executed = true; }
    })()
  });

  ctx.KeyAssist.open();
  const state = ctx.KeyAssist._state;
  state.dom.dialog.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {}, stopPropagation() {} });

  assert.equal(executed, false, 'Disabled command is not executed');
  assert.equal(ctx.KeyAssist.isOpen(), true, 'Key assist stays open when disabled command pressed');
});

test('KeyAssist handles English locale and fallback gracefully', () => {
  const ctx = loadKeyAssist({
    I18n: {
      getLanguage: () => 'en',
      t: (key) => key // Returns key to trigger fallback
    }
  });

  ctx.KeyAssist.open();
  const state = ctx.KeyAssist._state;
  assert.equal(state.dom.title.textContent, 'Key Assist');
  assert.equal(state.dom.searchInput.getAttribute('placeholder').includes('Search commands'), true);
});

test('KeyAssist closes on backdrop / outside pointerdown', () => {
  const ctx = loadKeyAssist();
  ctx.KeyAssist.open();
  assert.equal(ctx.KeyAssist.isOpen(), true);

  const state = ctx.KeyAssist._state;
  // Click on overlay backdrop
  state.dom.overlay.dispatchEvent({ type: 'click', target: state.dom.overlay });
  assert.equal(ctx.KeyAssist.isOpen(), false);
});

