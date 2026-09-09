/* editor.js 输入 dirty 标记的零依赖单测：node:test + node:vm + 最小 DOM stub
 * （stub 风格照 tests/smoke.test.js；在 vm 中按组装页顺序加载 i18n.js → tabs.js → editor.js）。
 *
 * 覆盖三件事（对应"输入后立即关闭丢数据"缺陷回归）：
 * 1. input 事件同步标记 dirty：不等 300ms 防抖，输入后立即保存/关闭不丢标记；
 * 2. 300ms 防抖到期只做重计算（字数等），不得把已保存（clean）的 tab 重新标 dirty；
 * 3. 输入发生在 tab A，切到 tab B 后防抖到期不得误标 B。
 *
 * 运行：node --test src/frontend/editor-dirty.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const FRONTEND = __dirname;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── 最小 DOM stub ── */

function createElement(tag) {
  const classes = new Set();
  const element = {
    tagName: tag,
    children: [],
    listeners: {},
    dataset: {},
    attributes: {},
    style: {},
    className: '',
    textContent: '',
    value: '',
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    clientWidth: 0,
    scrollWidth: 0,
    selectionStart: 0,
    selectionEnd: 0,
    appendChild(child) {
      child.parentNode = element;
      element.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = element.children.indexOf(child);
      if (idx !== -1) element.children.splice(idx, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, handler) {
      (element.listeners[type] = element.listeners[type] || []).push(handler);
    },
    removeEventListener() {},
    setAttribute(name, value) {
      element.attributes[name] = String(value);
    },
    getAttribute(name) {
      return name in element.attributes ? element.attributes[name] : null;
    },
    classList: {
      add(...names) {
        names.forEach((n) => classes.add(n));
      },
      remove(...names) {
        names.forEach((n) => classes.delete(n));
      },
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains(name) {
        return classes.has(name);
      },
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    focus() {},
  };
  return element;
}

function createHarness() {
  const ids = {};
  const docHandlers = {};
  const ipcMessages = [];
  const storage = new Map();
  let wordCountCalls = 0;
  const byId = (id) => (ids[id] = ids[id] || createElement('div'));

  const context = {
    console,
    confirm: () => true,
    // 防抖等待使用真实时钟，贴近"300ms 后"的真实语义
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    marked: { parse: (md) => '<p>' + md + '</p>', use() {}, setOptions() {} },
    hljs: {},
    navigator: { platform: 'win32' },
    // app.js 提供的编辑器全局（此处以 stub 代替，仅统计防抖重计算是否执行）
    updateWordCount() {
      wordCountCalls++;
    },
    // tabs.js 的 set_title / set_dirty_state 上行
    sendToRust(command, data) {
      ipcMessages.push(Object.assign({ command }, data || {}));
    },
    // saveTabState 读取的全局模式标记（app.js 提供，浏览器中为全局变量）
    currentMode: 'edit',
    document: {
      createElement,
      body: createElement('body'),
      activeElement: { focus() {} },
      readyState: 'complete',
      getElementById: byId,
      addEventListener(type, handler) {
        (docHandlers[type] = docHandlers[type] || []).push(handler);
      },
      removeEventListener() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
  };
  context.window = {
    addEventListener() {},
    getSelection() {
      return { toString: () => '' };
    },
    ipc: {
      postMessage(msg) {
        ipcMessages.push(JSON.parse(msg));
      },
    },
  };
  context.window.window = context.window;

  // 与组装页一致的相对顺序（省略 highlight/marked/preview：以 stub 代替）
  vm.runInNewContext(fs.readFileSync(path.join(FRONTEND, 'i18n.js'), 'utf8'), context, { filename: 'i18n.js' });
  vm.runInNewContext(fs.readFileSync(path.join(FRONTEND, 'tabs.js'), 'utf8'), context, { filename: 'tabs.js' });
  vm.runInNewContext(fs.readFileSync(path.join(FRONTEND, 'editor.js'), 'utf8'), context, { filename: 'editor.js' });

  return {
    context,
    editor: byId('editor'),
    wordCountCalls: () => wordCountCalls,
    fireInput() {
      const handlers = byId('editor').listeners.input || [];
      assert.ok(handlers.length > 0, 'editor 应绑定 input 监听');
      handlers.forEach((handler) => handler({}));
    },
  };
}

/* ── 用例 ── */

test('input 事件同步标记 dirty，不等待 300ms 防抖', () => {
  const h = createHarness();
  const tab = h.context.TabManager.createTab(null, '草稿内容');
  assert.equal(tab.dirty, false);

  // createTab/switchTab 自身会触发一次字数刷新，用基线排除干扰
  const before = h.wordCountCalls();
  h.fireInput();

  assert.equal(tab.dirty, true, '输入应立即标记 dirty（立即关闭/保存不丢标记）');
  assert.equal(h.wordCountCalls(), before, '重计算应保持防抖，此刻尚未执行');
});

test('300ms 防抖到期只做重计算，不把已保存的 tab 重新标 dirty', async () => {
  const h = createHarness();
  const tab = h.context.TabManager.createTab(null, '草稿内容');

  h.fireInput();
  assert.equal(tab.dirty, true);

  // 模拟保存成功回执后的 markClean（输入与保存间隔通常小于防抖窗口）
  h.context.TabManager.markClean();
  assert.equal(tab.dirty, false);

  await sleep(320);

  assert.equal(tab.dirty, false, '防抖回调不得把已保存的 tab 重新标 dirty');
  assert.ok(h.wordCountCalls() >= 1, '防抖重计算（字数刷新）应已执行，不得因去 dirty 而丢失');
});

test('输入发生在 tab A，切到 tab B 后防抖到期不误标 B', async () => {
  const h = createHarness();
  const a = h.context.TabManager.createTab(null, 'A 内容');
  const b = h.context.TabManager.createTab(null, 'B 内容');

  h.context.TabManager.switchTab(a.id);
  assert.equal(h.context.TabManager.getActiveTab(), a);

  h.fireInput();
  assert.equal(a.dirty, true, '输入应标在产生输入的 tab A 上');

  h.context.TabManager.switchTab(b.id);
  assert.equal(h.context.TabManager.getActiveTab(), b);

  await sleep(320);

  assert.equal(b.dirty, false, '防抖到期不得把新活动 tab B 误标 dirty');
  assert.equal(a.dirty, true, 'A 的未保存状态保持不变');
});
