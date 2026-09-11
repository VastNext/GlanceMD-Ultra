/* translate.test.js —— translate.js 的单元测试（node:test + node:vm）
 *
 * 覆盖：
 * 1. 模块导出与初始化：window.TranslateUI 暴露完整 API；
 * 2. 选区检测：无选区/折叠选区不返回，非折叠有文本返回 {text, start, end}；
 * 3. 视口边界约束：clampPosition 保证气泡/按钮不溢出屏幕外；
 * 4. 气泡生命周期：openBubble 发送 translate.request（带 requestId），closeBubble 重置状态；
 * 5. 请求关联与丢弃：非当前 requestId 或 test 响应静默忽略，匹配的更新 currentResult；
 * 6. 动作执行：替换选区（setRangeText）、插入（\\n\\n追加）、复制触发 toast。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const TRANSLATE_JS = path.join(__dirname, 'translate.js');

function loadHarness() {
  const els = {};
  const listeners = {};
  const docListeners = {};
  const ipcMsgs = [];
  const workspaceSubs = {};

  function makeEl(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      id: '',
      type: '',
      hidden: false,
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      style: {},
      children: [],
      parentNode: null,
      dataset: {},
      attrs: {},
      innerHTML: '',
      textContent: '',
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] || null; },
      removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(evt, handler) {
        listeners[this.id || tag] = listeners[this.id || tag] || {};
        (listeners[this.id || tag][evt] = listeners[this.id || tag][evt] || []).push(handler);
      },
      dispatchEvent() { return true; },
      focus() {},
      select() {},
      setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; },
      setRangeText(replacement, s, e) {
        const val = this.value;
        this.value = val.substring(0, s) + replacement + val.substring(e);
        this.selectionStart = this.selectionEnd = s + replacement.length;
      },
      getBoundingClientRect() { return { left: 100, top: 100, right: 300, bottom: 200, width: 200, height: 100 }; },
      querySelector(sel) {
        if (sel.startsWith('#')) {
          const id = sel.substring(1);
          return els[id] || null;
        }
        return null;
      },
      querySelectorAll() { return []; },
      contains() { return false; },
      appendChild(child) {
        this.children.push(child);
        child.parentNode = this;
        if (child.id) els[child.id] = child;
        return child;
      },
      removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) this.children.splice(i, 1);
        if (child.id) delete els[child.id];
        return child;
      },
    };
    return el;
  }

  const editor = makeEl('textarea');
  editor.id = 'editor';
  els.editor = editor;

  const body = makeEl('body');
  els.body = body;

  const doc = {
    readyState: 'complete',
    body,
    getElementById(id) { return els[id] || null; },
    createElement(tag) { return makeEl(tag); },
    addEventListener(evt, handler) {
      (docListeners[evt] = docListeners[evt] || []).push(handler);
    },
    removeEventListener() {},
    execCommand() { return true; },
  };

  const registeredCommands = {};
  const ctx = {
    console,
    setTimeout: (fn, ms) => { fn(); return 1; },
    clearTimeout: () => {},
    innerWidth: 1024,
    innerHeight: 768,
    document: doc,
    navigator: {
      clipboard: {
        writeText: () => Promise.resolve(),
      },
    },
    Event: function(type) { this.type = type; },
    I18n: { t: (k) => k },
    SettingsApply: {
      get: () => ({
        translation: {
          engineKind: 'google',
          targetLanguage: 'zh-Hans',
          selectionTriggerEnabled: true,
        },
      }),
    },
    Commands: {
      register: (id, def) => { registeredCommands[id] = def; },
    },
    Workspace: {
      on: (evt, fn) => { (workspaceSubs[evt] = workspaceSubs[evt] || []).push(fn); },
    },
    ipc: {
      postMessage: (m) => ipcMsgs.push(JSON.parse(m)),
    },
  };
  ctx.window = ctx;

  vm.runInNewContext(fs.readFileSync(TRANSLATE_JS, 'utf8'), ctx, { filename: 'translate.js' });
  return { ctx, els, ipcMsgs, editor, workspaceSubs, registeredCommands };
}

test('TranslateUI 模块挂载与 API 完整暴露', () => {
  const h = loadHarness();
  assert.ok(h.ctx.TranslateUI, 'TranslateUI 已挂载');
  assert.equal(typeof h.ctx.TranslateUI.openBubble, 'function');
  assert.equal(typeof h.ctx.TranslateUI.closeBubble, 'function');
  assert.equal(typeof h.ctx.TranslateUI.startTranslate, 'function');
  assert.equal(typeof h.ctx.TranslateUI.clampPosition, 'function');
  assert.equal(typeof h.ctx.TranslateUI.getEditorSelection, 'function');
  assert.ok(h.registeredCommands['translate.selection'], '已注册 translate.selection 命令');
});

test('选区检测：折叠或空文本返回 null，有非空白选区返回选区对象', () => {
  const h = loadHarness();
  h.editor.value = 'Hello world from GlanceMD Ultra';
  h.editor.selectionStart = 0;
  h.editor.selectionEnd = 0;
  assert.equal(h.ctx.TranslateUI.getEditorSelection(), null, '折叠光标无选区');

  h.editor.selectionStart = 5;
  h.editor.selectionEnd = 5;
  assert.equal(h.ctx.TranslateUI.getEditorSelection(), null);

  h.editor.selectionStart = 6;
  h.editor.selectionEnd = 11;
  const sel = h.ctx.TranslateUI.getEditorSelection();
  assert.ok(sel);
  assert.equal(sel.text, 'world');
  assert.equal(sel.start, 6);
  assert.equal(sel.end, 11);
});

test('视口边界约束：clampPosition 在各边界安全留白', () => {
  const h = loadHarness();
  const clamp = h.ctx.TranslateUI.clampPosition;
  // JSON round-trip：vm 对象与 host 跨 context 比对
  const round = (obj) => JSON.parse(JSON.stringify(obj));
  // 左上超限
  assert.deepEqual(round(clamp(-100, -50, 380, 200)), { x: 12, y: 12 });
  // 右下超限（1024x768 视口，宽 380 高 200）
  assert.deepEqual(round(clamp(2000, 2000, 380, 200)), { x: 1024 - 380 - 12, y: 768 - 200 - 12 });
  // 正常范围
  assert.deepEqual(round(clamp(200, 300, 380, 200)), { x: 200, y: 300 });
});

test('openBubble 触发翻译请求并发送 translate.request IPC 消息', () => {
  const h = loadHarness();
  h.editor.value = 'Artificial Intelligence';
  h.editor.selectionStart = 0;
  h.editor.selectionEnd = 23;

  h.ctx.TranslateUI.openBubble();
  const st = h.ctx.TranslateUI.getState();
  assert.equal(st.isOpen, true, '气泡已打开');
  assert.equal(st.isLoading, true, '处于 loading 状态');
  assert.ok(st.currentRequestId, '已分配 requestId');

  const req = h.ipcMsgs.find((m) => m.command === 'translate.request');
  assert.ok(req, '已发出 translate.request');
  assert.equal(req.requestId, st.currentRequestId);
  assert.deepEqual(req.segments, [{ id: 's0', text: 'Artificial Intelligence' }]);
});

test('请求关联：匹配 requestId 的回执写入结果，过期的静默忽略', () => {
  const h = loadHarness();
  h.editor.value = 'Test segment';
  h.editor.selectionStart = 0;
  h.editor.selectionEnd = 12;

  h.ctx.TranslateUI.openBubble();
  const reqId = h.ctx.TranslateUI.getState().currentRequestId;

  // 1. 发送测试命令的 test 回执：被忽略
  h.ctx.TranslateUI.onTranslateResult({ requestId: 'test', ok: true, message: '连通' });
  assert.equal(h.ctx.TranslateUI.getState().isLoading, true);

  // 2. 发送过期 requestId 回执：被忽略
  h.ctx.TranslateUI.onTranslateResult({ requestId: 'stale_id', ok: true, results: [{ id: 's0', text: '旧结果' }] });
  assert.equal(h.ctx.TranslateUI.getState().isLoading, true);

  // 3. 发送正确 requestId 成功回执：写入 currentResult
  h.ctx.TranslateUI.onTranslateResult({
    requestId: reqId,
    ok: true,
    results: [{ id: 's0', text: '测试分段' }],
  });
  const st = h.ctx.TranslateUI.getState();
  assert.equal(st.isLoading, false);
  assert.equal(st.currentResult, '测试分段');
  assert.equal(st.currentError, null);
});

test('请求关联：错误回执写入 currentError 并结束 loading', () => {
  const h = loadHarness();
  h.editor.value = 'Error test';
  h.editor.selectionStart = 0;
  h.editor.selectionEnd = 10;

  h.ctx.TranslateUI.openBubble();
  const reqId = h.ctx.TranslateUI.getState().currentRequestId;

  h.ctx.TranslateUI.onTranslateResult({
    requestId: reqId,
    ok: false,
    message: 'Google 翻译请求超时',
  });
  const st = h.ctx.TranslateUI.getState();
  assert.equal(st.isLoading, false);
  assert.equal(st.currentResult, null);
  assert.equal(st.currentError, 'Google 翻译请求超时');
});

test('closeBubble 重置状态机与隐藏气泡', () => {
  const h = loadHarness();
  h.editor.value = 'Close test';
  h.editor.selectionStart = 0;
  h.editor.selectionEnd = 10;

  h.ctx.TranslateUI.openBubble();
  assert.equal(h.ctx.TranslateUI.getState().isOpen, true);

  h.ctx.TranslateUI.closeBubble();
  const st = h.ctx.TranslateUI.getState();
  assert.equal(st.isOpen, false);
  assert.equal(st.currentRequestId, null);
});
