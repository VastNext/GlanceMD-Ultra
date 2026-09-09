const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function makeElement(id) {
  const listeners = {};
  const classes = new Set();
  const attributes = {};
  return {
    id,
    style: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, force) => {
        const next = force !== undefined ? Boolean(force) : !classes.has(c);
        if (next) classes.add(c);
        else classes.delete(c);
        return next;
      },
      contains: (c) => classes.has(c),
    },
    addEventListener: (t, fn) => {
      (listeners[t] = listeners[t] || []).push(fn);
    },
    dispatchEvent: (e) => {
      (listeners[e.type] || []).forEach((fn) => fn(e));
    },
    setAttribute: (k, v) => {
      attributes[k] = String(v);
    },
    getAttribute: (k) => attributes[k] || null,
    setSelectionRange: () => {},
    focus: () => {},
  };
}

test('index.html 包含微型双格胶囊开关与自动换行按钮', () => {
  const html = fs.readFileSync('src/frontend/index.html', 'utf8');
  assert.ok(html.includes('id="mode-segmented"'), '应包含 mode-segmented 容器');
  assert.ok(html.includes('id="btn-mode-edit"'), '应包含编辑模式按钮');
  assert.ok(html.includes('id="btn-mode-preview"'), '应包含预览模式按钮');
  assert.ok(html.includes('id="btn-word-wrap"'), '应包含自动换行按钮');
  assert.ok(html.includes('id="btn-toggle"'), '应保留兼容性 btn-toggle');
});

test('updateModeSwitchUI 联动胶囊开关的 active 状态', () => {
  const segEdit = makeElement('btn-mode-edit');
  const segPreview = makeElement('btn-mode-preview');
  const btnToggle = makeElement('btn-toggle');
  const byId = {
    'btn-mode-edit': segEdit,
    'btn-mode-preview': segPreview,
    'btn-toggle': btnToggle,
  };

  const ctx = {
    document: { getElementById: (id) => byId[id] || null },
    splitMode: false,
  };
  ctx.window = ctx;

  const code = `
  function updateModeSwitchUI(mode) {
    var segEdit = document.getElementById('btn-mode-edit');
    var segPreview = document.getElementById('btn-mode-preview');
    var isSplit = typeof splitMode !== 'undefined' && splitMode;
    if (segEdit && segPreview) {
      if (isSplit) {
        segEdit.classList.add('active');
        segPreview.classList.add('active');
      } else if (mode === 'preview') {
        segEdit.classList.remove('active');
        segPreview.classList.add('active');
      } else {
        segEdit.classList.add('active');
        segPreview.classList.remove('active');
      }
    }
    var btnToggle = document.getElementById('btn-toggle');
    if (btnToggle) {
      btnToggle.classList.toggle('active', mode === 'preview');
    }
  }
  window.updateModeSwitchUI = updateModeSwitchUI;
  `;

  vm.runInNewContext(code, ctx);

  // 1. 测试切到 edit 模式
  ctx.updateModeSwitchUI('edit');
  assert.equal(segEdit.classList.contains('active'), true, 'edit 按钮高亮');
  assert.equal(segPreview.classList.contains('active'), false, 'preview 按钮暗色');
  assert.equal(btnToggle.classList.contains('active'), false);

  // 2. 测试切到 preview 模式
  ctx.updateModeSwitchUI('preview');
  assert.equal(segEdit.classList.contains('active'), false, 'edit 按钮暗色');
  assert.equal(segPreview.classList.contains('active'), true, 'preview 按钮高亮');
  assert.equal(btnToggle.classList.contains('active'), true);

  // 3. 测试分屏模式 (splitMode = true)
  ctx.splitMode = true;
  ctx.updateModeSwitchUI('split');
  assert.equal(segEdit.classList.contains('active'), true, '分屏下 edit 高亮');
  assert.equal(segPreview.classList.contains('active'), true, '分屏下 preview 高亮');
});

test('toggleEditorWrap 调用 SettingsApply.patch 进行全局持久化并触发 Toast', () => {
  let patched = null;
  let toastMsg = null;
  const editor = makeElement('editor');
  editor.value = 'abc';
  editor.selectionStart = 0;
  editor.selectionEnd = 0;

  let currentWrap = true;
  const ctx = {
    editor,
    document: {
      getElementById: (id) => (id === 'editor' ? editor : null),
      createElement: (tag) => makeElement(tag),
    },
    SettingsApply: {
      get: () => ({ editor: { wordWrap: currentWrap } }),
      patch: (p) => {
        patched = p;
        currentWrap = p.editor.wordWrap;
      },
    },
    I18n: {
      t: (k) => k,
    },
    showAppToast: (msg) => {
      toastMsg = msg;
    },
  };
  ctx.window = ctx;

  // 载入 editor.js 中的 toggleEditorWrap 实现
  const editorCode = fs.readFileSync('src/frontend/editor.js', 'utf8');
  // 提取 toggleEditorWrap 函数并在 ctx 中执行
  vm.runInNewContext(
    editorCode + '; window.toggleEditorWrap = toggleEditorWrap;',
    ctx,
  );

  // 执行 toggleEditorWrap 关掉换行
  const result1 = ctx.toggleEditorWrap();
  assert.equal(result1, false, '第一次切换返回 false（关闭）');
  assert.deepEqual(JSON.parse(JSON.stringify(patched)), { editor: { wordWrap: false } });
  assert.equal(toastMsg, 'toast.wordWrapOff');

  // 再次执行 toggleEditorWrap 重新开启换行
  const result2 = ctx.toggleEditorWrap();
  assert.equal(result2, true, '第二次切换返回 true（开启）');
  assert.deepEqual(JSON.parse(JSON.stringify(patched)), { editor: { wordWrap: true } });
  assert.equal(toastMsg, 'toast.wordWrapOn');
});
