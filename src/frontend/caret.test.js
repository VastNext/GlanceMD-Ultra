const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// 读取 caret.js 源码
const CARET_SRC = fs.readFileSync(path.join(__dirname, 'caret.js'), 'utf8');

function createTestEnvironment(initialText = '') {
  let activeElement = null;

  function createEl(tag) {
    const classList = new Set();
    const children = [];
    const listeners = {};
    const attributes = {};

    const el = {
      tagName: tag.toUpperCase(),
      children: children,
      parentNode: null,
      ownerDocument: null,
      value: initialText,
      selectionStart: 0,
      selectionEnd: 0,
      offsetLeft: 10,
      offsetTop: 20,
      scrollLeft: 0,
      scrollTop: 0,
      clientWidth: 600,
      clientHeight: 400,
      scrollHeight: 1000,
      style: {},

      get className() {
        return Array.from(classList).join(' ');
      },
      set className(v) {
        classList.clear();
        if (typeof v === 'string' && v.trim()) {
          v.trim().split(/\s+/).forEach(c => classList.add(c));
        }
      },

      classList: {
        add(...cls) { cls.forEach(c => classList.add(c)); },
        remove(...cls) { cls.forEach(c => classList.delete(c)); },
        contains(c) { return classList.has(c); }
      },

      setAttribute(k, v) { attributes[k] = String(v); if (k === 'id') el.id = v; },
      getAttribute(k) { return attributes[k] || (k === 'id' ? el.id : null); },

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
      dispatchEvent(e) {
        const fns = listeners[e.type || e] || [];
        fns.forEach(fn => fn.call(el, e));
      },

      focus() {
        activeElement = el;
      },
      blur() {
        if (activeElement === el) activeElement = null;
      },

      // 模拟镜像/Marker 测量坐标
      get offsetLeft() {
        if (classList.has('custom-caret-marker')) {
          return 50;
        }
        return el._offsetLeft !== undefined ? el._offsetLeft : 10;
      },
      set offsetLeft(v) { el._offsetLeft = v; },

      get offsetTop() {
        if (classList.has('custom-caret-marker')) {
          return 30;
        }
        return el._offsetTop !== undefined ? el._offsetTop : 20;
      },
      set offsetTop(v) { el._offsetTop = v; },

      get offsetWidth() { return 8.5; },
      get offsetHeight() { return 20; }
    };
    return el;
  }

  const doc = {
    createElement(tag) {
      const e = createEl(tag);
      e.ownerDocument = doc;
      return e;
    },
    createTextNode(txt) {
      return {
        nodeType: 3,
        textContent: String(txt),
        parentNode: null
      };
    },
    get activeElement() {
      return activeElement;
    }
  };

  const container = doc.createElement('div');
  container.id = 'editor-container';

  const editor = doc.createElement('textarea');
  editor.id = 'editor';
  container.appendChild(editor);

  const win = {
    getComputedStyle(elem) {
      return {
        fontFamily: 'Consolas, monospace',
        fontSize: '14px',
        fontWeight: 'normal',
        fontStyle: 'normal',
        letterSpacing: 'normal',
        lineHeight: '20px',
        paddingTop: '8px',
        paddingRight: '8px',
        paddingBottom: '8px',
        paddingLeft: '8px',
        borderTopWidth: '0px',
        borderLeftWidth: '0px',
        borderRightWidth: '0px',
        borderBottomWidth: '0px',
        boxSizing: 'border-box',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
        wordBreak: 'break-word',
        tabSize: '4',
        width: '600px'
      };
    },
    addEventListener() {},
    removeEventListener() {}
  };
  doc.defaultView = win;

  const sandbox = {
    window: win,
    document: doc,
    setTimeout,
    clearTimeout,
    console,
    parseFloat,
    Math
  };

  vm.createContext(sandbox);
  vm.runInContext(CARET_SRC, sandbox);

  return {
    CustomCaret: sandbox.window.CustomCaret || sandbox.CustomCaret,
    editor,
    container,
    doc,
    win,
    setActiveElement(el) { activeElement = el; }
  };
}

test('CustomCaret: 初始化挂载、DOM结构与默认 3px 竖线光标结构', () => {
  const env = createTestEnvironment('Hello Caret');
  const caret = env.CustomCaret.mount({
    editor: env.editor,
    container: env.container
  });

  const caretEl = env.container.children.find(c => c.id === 'custom-caret');
  assert.ok(caretEl, '应在容器中创建 #custom-caret 元素');
  assert.ok(caretEl.classList.contains('custom-caret'), '应包含 custom-caret 类');
  assert.ok(caretEl.classList.contains('custom-caret-blink'), '初始应包含呼吸闪烁类');

  const mirrorEl = env.container.children.find(c => c.classList.contains('custom-caret-mirror'));
  assert.ok(mirrorEl, '应在容器中创建测量镜像 custom-caret-mirror');

  caret.unmount();
});

test('CustomCaret: 聚焦与坐标测量成功后显示 3px 竖线光标并隐藏原生光标', () => {
  const env = createTestEnvironment('Hello Caret World');
  const caret = env.CustomCaret.mount({
    editor: env.editor,
    container: env.container
  });

  env.setActiveElement(env.editor);
  env.editor.selectionStart = 5;
  env.editor.selectionEnd = 5;

  caret.update();

  const caretEl = env.container.children.find(c => c.id === 'custom-caret');
  assert.equal(caretEl.style.display, 'block', '聚焦且折叠选区时光标应显示');
  assert.ok(parseInt(caretEl.style.left) >= 0, '应计算出有效的 left 坐标');
  assert.ok(parseInt(caretEl.style.top) >= 0, '应计算出有效的 top 坐标');
  assert.equal(env.editor.style.caretColor, 'transparent', '自定义光标显示时原生光标应透明');

  caret.unmount();
});

test('CustomCaret: 输入常亮（typing 触发 solid，500ms 后恢复 blink）', async () => {
  const env = createTestEnvironment('Hello');
  const caret = env.CustomCaret.mount({
    editor: env.editor,
    container: env.container
  });

  env.setActiveElement(env.editor);
  caret.update();

  const caretEl = env.container.children.find(c => c.id === 'custom-caret');
  assert.ok(caretEl.classList.contains('custom-caret-blink'));

  // 触发输入事件
  caret.triggerTyping();
  assert.ok(caretEl.classList.contains('custom-caret-solid'), '输入期间应变为常亮 solid');
  assert.equal(caretEl.classList.contains('custom-caret-blink'), false, '输入期间不应闪烁');

  // 等待 550ms
  await new Promise(r => setTimeout(r, 550));
  assert.ok(caretEl.classList.contains('custom-caret-blink'), '输入停止 500ms 后应恢复平滑呼吸闪烁');

  caret.unmount();
});

test('CustomCaret: 光标重定位常亮 1 秒（relocate 保持 1000ms solid 后恢复 blink）', async () => {
  const env = createTestEnvironment('Hello World');
  const caret = env.CustomCaret.mount({
    editor: env.editor,
    container: env.container
  });

  env.setActiveElement(env.editor);
  caret.update();

  const caretEl = env.container.children.find(c => c.id === 'custom-caret');

  // 触发定位事件
  caret.triggerRelocated();
  assert.ok(caretEl.classList.contains('custom-caret-solid'), '重定位后应立即常亮');

  // 600ms 时仍应保持常亮
  await new Promise(r => setTimeout(r, 600));
  assert.ok(caretEl.classList.contains('custom-caret-solid'), '600ms 时仍应常亮');

  // 1100ms 时恢复闪烁
  await new Promise(r => setTimeout(r, 500));
  assert.ok(caretEl.classList.contains('custom-caret-blink'), '1000ms 后恢复闪烁');

  caret.unmount();
});

test('CustomCaret: 非折叠选区（Range Selection）与失焦（Blur）时隐藏自定义光标', () => {
  const env = createTestEnvironment('Hello Selection');
  const caret = env.CustomCaret.mount({
    editor: env.editor,
    container: env.container
  });

  env.setActiveElement(env.editor);
  env.editor.selectionStart = 0;
  env.editor.selectionEnd = 5; // 选中 "Hello"

  caret.update();
  const caretEl = env.container.children.find(c => c.id === 'custom-caret');
  assert.equal(caretEl.style.display, 'none', '非折叠选区存在时应隐藏竖线光标');

  // 折叠选区后恢复显示
  env.editor.selectionEnd = 0;
  caret.update();
  assert.equal(caretEl.style.display, 'block', '折叠选区后应恢复显示竖线光标');

  // 失焦
  env.setActiveElement(null);
  env.editor.dispatchEvent({ type: 'blur' });
  assert.equal(caretEl.style.display, 'none', '失焦时应隐藏光标');

  caret.unmount();
});

test('CustomCaret: IME Composition 输入法状态下回退原生光标，不干扰输入法候选窗', () => {
  const env = createTestEnvironment('');
  const caret = env.CustomCaret.mount({
    editor: env.editor,
    container: env.container
  });

  env.setActiveElement(env.editor);
  caret.update();
  const caretEl = env.container.children.find(c => c.id === 'custom-caret');

  // 模拟输入法组合开始 (中文输入中: compositionstart)
  env.editor.dispatchEvent({ type: 'compositionstart' });
  assert.equal(caret.getState().isComposing, true, 'isComposing 应置为 true');
  assert.equal(caretEl.style.display, 'none', 'IME 组合期间自定义光标应隐藏');
  assert.equal(env.editor.style.caretColor, '', 'IME 组合期间原生光标应恢复以定位候选窗口');

  // 模拟输入法组合结束 (compositionend)
  env.editor.dispatchEvent({ type: 'compositionend' });
  assert.equal(caret.getState().isComposing, false, 'isComposing 应恢复 false');
  assert.equal(caretEl.style.display, 'block', 'IME 结束后自定义竖线光标恢复');
  assert.equal(env.editor.style.caretColor, 'transparent', 'IME 结束后原生光标恢复透明');

  caret.unmount();
});

test('CustomCaret: 测量失败时优雅回退原生光标，绝不丢失光标', () => {
  const env = createTestEnvironment('Fallback Test');
  // 模拟异常 computedStyle 导致测量失败
  env.win.getComputedStyle = () => { throw new Error('Simulated measurement fault'); };

  const caret = env.CustomCaret.mount({
    editor: env.editor,
    container: env.container
  });

  env.setActiveElement(env.editor);
  caret.update();

  const caretEl = env.container.children.find(c => c.id === 'custom-caret');
  assert.equal(caretEl.style.display, 'none', '测量失败时隐藏自定义光标');
  assert.equal(env.editor.style.caretColor, '', '测量失败时必须恢复原生光标，不能全部隐藏');

  caret.unmount();
});
