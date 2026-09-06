const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// 创建轻量完整的 DOM 桩对象
function createDomStub() {
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
      ownerDocument: null,
      style: {},
      value: '',
      type: 'text',
      placeholder: '',
      _innerHTML: '',

      get textContent() {
        if (this._innerHTML) {
          return this._innerHTML.replace(/<[^>]*>/g, '');
        }
        return this._textContent || '';
      },
      set textContent(val) {
        this._textContent = String(val);
        this._innerHTML = '';
      },

      get innerHTML() {
        return this._innerHTML || this._textContent || '';
      },
      set innerHTML(val) {
        this._innerHTML = String(val);
        this._textContent = '';
      },

      get className() {
        return Array.from(classList).join(' ');
      },
      set className(val) {
        classList.clear();
        if (typeof val === 'string' && val.trim()) {
          val.trim().split(/\s+/).forEach(c => {
            if (c) classList.add(c);
          });
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

      appendChild(child) {
        if (!child) return child;
        child.parentNode = el;
        child.ownerDocument = el.ownerDocument;
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
        if (!listeners[type]) return;
        const idx = listeners[type].indexOf(fn);
        if (idx !== -1) listeners[type].splice(idx, 1);
      },
      dispatchEvent(event) {
        const type = event.type || event;
        const fns = listeners[type] || [];
        fns.forEach(fn => {
          try {
            fn.call(el, event);
          } catch (err) {
            console.error('Event dispatch error:', err);
          }
        });
        return true;
      },

      querySelector(selector) {
        return findFirst(el, selector);
      },
      querySelectorAll(selector) {
        const results = [];
        findAll(el, selector, results);
        return results;
      },

      focus() {
        if (el.ownerDocument) {
          el.ownerDocument.activeElement = el;
        }
      },
      blur() {
        if (el.ownerDocument && el.ownerDocument.activeElement === el) {
          el.ownerDocument.activeElement = null;
        }
      },
      select() {
        this._selected = true;
      }
    };

    return el;
  }

  function matchesSelector(elem, selector) {
    if (!selector) return false;
    if (selector.startsWith('.')) {
      return elem.classList.contains(selector.slice(1));
    }
    if (selector.startsWith('#')) {
      return elem.getAttribute('id') === selector.slice(1);
    }
    return elem.tagName.toLowerCase() === selector.toLowerCase();
  }

  function findFirst(elem, selector) {
    for (const child of elem.children) {
      if (matchesSelector(child, selector)) return child;
      const found = findFirst(child, selector);
      if (found) return found;
    }
    return null;
  }

  function findAll(elem, selector, out) {
    for (const child of elem.children) {
      if (matchesSelector(child, selector)) out.push(child);
      findAll(child, selector, out);
    }
  }

  const body = createElement('body');
  const doc = {
    createElement(tag) {
      const e = createElement(tag);
      e.ownerDocument = doc;
      return e;
    },
    getElementById(id) {
      return findFirst(body, '#' + id);
    },
    querySelector(selector) {
      if (selector === 'body') return body;
      return findFirst(body, selector);
    },
    querySelectorAll(selector) {
      const results = [];
      findAll(body, selector, results);
      return results;
    },
    body: body,
    activeElement: null
  };
  body.ownerDocument = doc;

  const windowListeners = {};
  const win = {
    document: doc,
    addEventListener(type, fn) {
      if (!windowListeners[type]) windowListeners[type] = [];
      windowListeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      if (!windowListeners[type]) return;
      const idx = windowListeners[type].indexOf(fn);
      if (idx !== -1) windowListeners[type].splice(idx, 1);
    },
    dispatchEvent(event) {
      const type = event.type || event;
      const fns = windowListeners[type] || [];
      fns.forEach(fn => fn(event));
    }
  };

  return { doc, win, body };
}

function setupEnvironment() {
  const { doc, win, body } = createDomStub();
  const context = {
    window: win,
    document: doc,
    console: console,
    module: { exports: {} },
    exports: {}
  };
  context.globalThis = win;

  const filePath = path.join(__dirname, 'vim-ui.js');
  const code = fs.readFileSync(filePath, 'utf8');
  vm.runInNewContext(code, context);

  return {
    VimUI: context.VimUI || context.module.exports,
    doc,
    win,
    body
  };
}

test('VimUI: mount 初始化挂载、DOM结构与 ARIA 属性验证', () => {
  const { VimUI, doc } = setupEnvironment();

  const statusBar = doc.createElement('div');
  statusBar.id = 'status-bar';
  doc.body.appendChild(statusBar);

  const editorContainer = doc.createElement('div');
  editorContainer.id = 'editor-container';
  doc.body.appendChild(editorContainer);

  VimUI.mount({
    container: statusBar,
    editorTarget: editorContainer,
    document: doc
  });

  const widget = statusBar.querySelector('.vim-status-widget');
  assert.ok(widget, '状态栏挂载了 .vim-status-widget');
  assert.equal(widget.getAttribute('role'), 'status');
  assert.equal(widget.getAttribute('aria-live'), 'polite');

  const modeBadge = widget.querySelector('.vim-mode-badge');
  assert.ok(modeBadge, '包含模式徽章');
  assert.equal(modeBadge.textContent, '-- NORMAL --');
  assert.ok(modeBadge.classList.contains('mode-normal'));

  // 验证关联编辑器的 CSS 样式类
  assert.ok(editorContainer.classList.contains('vim-mode-active'));
  assert.ok(editorContainer.classList.contains('vim-normal-mode'));

  // 验证命令行浮层结构
  const overlay = editorContainer.querySelector('.vim-command-line-overlay');
  assert.ok(overlay, '挂载了命令行浮层 .vim-command-line-overlay');
  assert.equal(overlay.getAttribute('role'), 'dialog');

  const prompt = overlay.querySelector('.vim-cmd-prompt');
  assert.ok(prompt, '包含提示符 span');
  assert.equal(prompt.textContent, ':');

  const input = overlay.querySelector('.vim-cmd-input');
  assert.ok(input, '包含命令行输入框');
  assert.equal(input.getAttribute('autocomplete'), 'off');
});

test('VimUI: 模式切换与展示适配 (NORMAL / INSERT / VISUAL / VISUAL LINE / VISUAL BLOCK / REPLACE / COMMAND)', () => {
  const { VimUI, doc } = setupEnvironment();
  const statusBar = doc.createElement('div');
  const editorContainer = doc.createElement('div');
  doc.body.appendChild(statusBar);
  doc.body.appendChild(editorContainer);

  VimUI.mount({ container: statusBar, editorTarget: editorContainer, document: doc });

  const modeBadge = statusBar.querySelector('.vim-mode-badge');

  // Insert 模式
  VimUI.update({ mode: 'insert' });
  assert.equal(modeBadge.textContent, '-- INSERT --');
  assert.ok(modeBadge.classList.contains('mode-insert'));
  assert.ok(editorContainer.classList.contains('vim-insert-mode'));
  assert.ok(!editorContainer.classList.contains('vim-normal-mode'));

  // Visual 模式
  VimUI.update({ mode: 'visual' });
  assert.equal(modeBadge.textContent, '-- VISUAL --');
  assert.ok(modeBadge.classList.contains('mode-visual'));
  assert.ok(editorContainer.classList.contains('vim-visual-mode'));

  // Visual Line 模式
  VimUI.update({ mode: 'visual-line' });
  assert.equal(modeBadge.textContent, '-- VISUAL LINE --');
  assert.ok(modeBadge.classList.contains('mode-visual-line'));
  assert.ok(editorContainer.classList.contains('vim-visual-line-mode'));

  // Visual Block 模式
  VimUI.update({ mode: 'visual-block' });
  assert.equal(modeBadge.textContent, '-- VISUAL BLOCK --');
  assert.ok(modeBadge.classList.contains('mode-visual-block'));
  assert.ok(editorContainer.classList.contains('vim-visual-block-mode'));

  // Replace 模式
  VimUI.update({ mode: 'replace' });
  assert.equal(modeBadge.textContent, '-- REPLACE --');
  assert.ok(modeBadge.classList.contains('mode-replace'));
  assert.ok(editorContainer.classList.contains('vim-replace-mode'));

  // Command 模式
  VimUI.update({ mode: 'command' });
  assert.equal(modeBadge.textContent, '-- COMMAND --');
  assert.ok(modeBadge.classList.contains('mode-command'));
  assert.ok(editorContainer.classList.contains('vim-command-mode'));

  // 切回 Normal
  VimUI.setMode('normal');
  assert.equal(modeBadge.textContent, '-- NORMAL --');
  assert.ok(modeBadge.classList.contains('mode-normal'));
  assert.ok(editorContainer.classList.contains('vim-normal-mode'));
});

test('VimUI: Pending Count / Operator / KeyBuffer 徽章展示与清除', () => {
  const { VimUI, doc } = setupEnvironment();
  const statusBar = doc.createElement('div');
  doc.body.appendChild(statusBar);

  VimUI.mount({ container: statusBar, document: doc });

  const countBadge = statusBar.querySelector('.vim-badge-count');
  const opBadge = statusBar.querySelector('.vim-badge-operator');
  const bufferBadge = statusBar.querySelector('.vim-badge-buffer');

  // 初始隐藏
  assert.equal(countBadge.style.display, 'none');
  assert.equal(opBadge.style.display, 'none');

  // 更新 pending count
  VimUI.update({ pendingCount: 3 });
  assert.equal(countBadge.style.display, 'inline-flex');
  assert.equal(countBadge.textContent, '3');

  // 更新 pending operator
  VimUI.update({ pendingOperator: 'd', keyBuffer: '3d' });
  assert.equal(opBadge.style.display, 'inline-flex');
  assert.equal(opBadge.textContent, 'd');
  assert.equal(bufferBadge.style.display, 'inline-flex');
  assert.equal(bufferBadge.textContent, '3d');

  // 清除待决状态
  VimUI.update({ pendingCount: null, pendingOperator: null, keyBuffer: '' });
  assert.equal(countBadge.style.display, 'none');
  assert.equal(opBadge.style.display, 'none');
  assert.equal(bufferBadge.style.display, 'none');
});

test('VimUI: Macro 宏录制状态指示与脉冲动画标记', () => {
  const { VimUI, doc } = setupEnvironment();
  const statusBar = doc.createElement('div');
  doc.body.appendChild(statusBar);

  VimUI.mount({ container: statusBar, document: doc });

  const recBadge = statusBar.querySelector('.vim-badge-recording');
  assert.equal(recBadge.style.display, 'none');

  // 开始录制 @q
  VimUI.update({ recordingRegister: 'q' });
  assert.equal(recBadge.style.display, 'inline-flex');
  assert.ok(recBadge.innerHTML.includes('vim-recording-dot'));
  assert.ok(recBadge.textContent.includes('@q'));

  // 结束录制
  VimUI.update({ recordingRegister: null });
  assert.equal(recBadge.style.display, 'none');
});

test('VimUI: 状态与错误/提示消息展示', () => {
  const { VimUI, doc } = setupEnvironment();
  const statusBar = doc.createElement('div');
  doc.body.appendChild(statusBar);

  VimUI.mount({ container: statusBar, document: doc });

  const msgEl = statusBar.querySelector('.vim-status-message');
  assert.equal(msgEl.style.display, 'none');

  // 普通/信息提示
  VimUI.setMessage('5 lines yanked', 'info');
  assert.equal(msgEl.style.display, 'inline-block');
  assert.equal(msgEl.textContent, '5 lines yanked');
  assert.ok(msgEl.classList.contains('is-info'));

  // 错误提示
  VimUI.update({ error: 'E492: Not an editor command' });
  assert.equal(msgEl.textContent, 'E492: Not an editor command');
  assert.ok(msgEl.classList.contains('is-error'));

  // 清除消息
  VimUI.clearMessage();
  assert.equal(msgEl.style.display, 'none');
  assert.equal(msgEl.textContent, '');
});

test('VimUI: showCommandLine 命令行浮层唤起、提交与取消交互', () => {
  const { VimUI, doc } = setupEnvironment();
  const container = doc.createElement('div');
  doc.body.appendChild(container);

  VimUI.mount({ container: container, commandContainer: container, document: doc });

  const overlay = container.querySelector('.vim-command-line-overlay');
  const prompt = overlay.querySelector('.vim-cmd-prompt');
  const input = overlay.querySelector('.vim-cmd-input');

  let submittedCommand = null;
  let cancelCalled = false;

  // 1. 弹出 Ex 命令行 ':'
  VimUI.showCommandLine({
    prompt: ':',
    initialValue: 'w',
    onSubmit: (val) => { submittedCommand = val; },
    onCancel: () => { cancelCalled = true; }
  });

  assert.ok(overlay.classList.contains('active'));
  assert.equal(prompt.textContent, ':');
  assert.equal(input.value, 'w');
  assert.equal(doc.activeElement, input);

  // 模拟输入修改并按 Enter 提交
  input.value = 'w output.md';
  input.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault: () => {} });

  assert.equal(submittedCommand, 'w output.md');
  assert.ok(!overlay.classList.contains('active'), '提交后命令行浮层关闭');

  // 2. 弹出搜索模式 '/' 并按 Escape 取消
  cancelCalled = false;
  VimUI.showCommandLine({
    prompt: '/',
    initialValue: 'function',
    onCancel: () => { cancelCalled = true; }
  });

  assert.ok(overlay.classList.contains('active'));
  assert.equal(prompt.textContent, '/');

  input.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault: () => {} });
  assert.equal(cancelCalled, true);
  assert.ok(!overlay.classList.contains('active'), '取消后命令行浮层关闭');
});

test('VimUI: 命令行历史记录上下导航 (ArrowUp / ArrowDown)', () => {
  const { VimUI, doc } = setupEnvironment();
  const container = doc.createElement('div');
  doc.body.appendChild(container);

  VimUI.mount({ container: container, commandContainer: container, document: doc });

  const overlay = container.querySelector('.vim-command-line-overlay');
  const input = overlay.querySelector('.vim-cmd-input');

  const history = ['w', 'q!', 's/foo/bar/g'];

  VimUI.showCommandLine({
    prompt: ':',
    history: history
  });

  // 按 ArrowUp 浏览上一条历史（从最新开始）
  input.dispatchEvent({ type: 'keydown', key: 'ArrowUp', preventDefault: () => {} });
  assert.equal(input.value, 's/foo/bar/g');

  input.dispatchEvent({ type: 'keydown', key: 'ArrowUp', preventDefault: () => {} });
  assert.equal(input.value, 'q!');

  // 按 ArrowDown 返回
  input.dispatchEvent({ type: 'keydown', key: 'ArrowDown', preventDefault: () => {} });
  assert.equal(input.value, 's/foo/bar/g');
});

test('VimUI: 多语言与 Fallback 支持 (zh-CN & en 及 i18n-changed 事件)', () => {
  const { VimUI, doc, win } = setupEnvironment();
  const statusBar = doc.createElement('div');
  doc.body.appendChild(statusBar);

  // 模拟 I18n 基础设施
  let currentLang = 'zh-CN';
  win.I18n = {
    getLanguage: () => currentLang,
    t: (key, params) => {
      if (key === 'vim.mode.normal') return currentLang === 'zh-CN' ? '-- 普通 --' : '-- NORMAL --';
      return null; // fallback
    }
  };

  VimUI.mount({ container: statusBar, document: doc });
  const modeBadge = statusBar.querySelector('.vim-mode-badge');
  assert.equal(modeBadge.textContent, '-- NORMAL --');

  // 切换为英文并派发 i18n-changed
  currentLang = 'en';
  win.dispatchEvent({ type: 'i18n-changed', detail: { language: 'en' } });
  assert.equal(modeBadge.textContent, '-- NORMAL --');
});

test('VimUI: unmount 卸载清理 DOM 与样式类', () => {
  const { VimUI, doc } = setupEnvironment();
  const statusBar = doc.createElement('div');
  const editorContainer = doc.createElement('div');
  doc.body.appendChild(statusBar);
  doc.body.appendChild(editorContainer);

  VimUI.mount({ container: statusBar, editorTarget: editorContainer, document: doc });

  assert.equal(statusBar.children.length, 1);
  assert.ok(editorContainer.classList.contains('vim-mode-active'));

  VimUI.unmount();

  assert.equal(statusBar.children.length, 0);
  assert.ok(!editorContainer.classList.contains('vim-mode-active'));
  assert.ok(!editorContainer.classList.contains('vim-normal-mode'));
  assert.equal(VimUI.getState().mounted, false);
});
