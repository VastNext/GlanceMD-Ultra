/* translate.test.js —— translate.js 的单元测试（node:test + node:vm）
 *
 * 覆盖：
 * 1. 模块导出与初始化：window.TranslateUI 暴露完整 API；
 * 2. 选区检测：无选区/折叠选区不返回，编辑区/预览区非折叠有文本返回选区对象；
 * 3. 视口边界约束：clampPosition 保证气泡/按钮/Popup 不溢出屏幕外；
 * 4. 气泡生命周期：openBubble 发送 translate.request（带 requestId 与引擎/语言选择），closeBubble 重置状态；
 * 5. 独立引擎与目标语言记忆：saveEngine / saveTargetLang 写入 storage 并由下一次请求携带；
 * 6. 顶栏 Popup 浮窗：openPopup / closePopup / togglePopup 状态切换与渲染；
 * 7. Tab 隔离的翻译状态：isCurrentTabTranslated 准确反馈当前 Tab 的翻译状态；
 * 8. 预览区全文翻译与一键还原：collectPreviewSegments 提取段落，translatePreview 发送请求，applyPreviewTranslation 插入 .preview-trans-block，restorePreview 还原；
 * 9. 动作执行：替换选区（setRangeText）、插入（\n\n追加）、复制触发 toast；
 * 10. 气泡锚定：openBubble 定位在划词触发按钮（即鼠标/选区）旁，而非固定坐标；
 * 11. 直达替换：translateSelectionReplace 跳过气泡直接写回，失败回退弹气泡，写入经 EditorCommands.transact。
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
  const storage = new Map();

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
      _className: '',
      classList: {
        _classes: new Set(),
        add(c) { this._classes.add(c); },
        remove(c) { this._classes.delete(c); },
        contains(c) { return this._classes.has(c); },
        toggle(c, f) {
          if (f === undefined) f = !this.contains(c);
          if (f) this.add(c); else this.remove(c);
          return f;
        },
      },
      set className(v) {
        this._className = v;
        this.classList._classes = new Set(v.split(/\s+/).filter(Boolean));
      },
      get className() { return this._className || ''; },
      setAttribute(k, v) {
        this.attrs[k] = String(v);
        if (k === 'class') this.className = String(v);
      },
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
        for (const c of this.children) {
          if (c.tagName && c.tagName.toLowerCase() === sel) return c;
          if (c.querySelector) {
            const found = c.querySelector(sel);
            if (found) return found;
          }
        }
        return null;
      },
      querySelectorAll(sel) {
        const res = [];
        function walk(node) {
          for (const c of node.children) {
            if (sel.startsWith('.')) {
              if (c.classList && c.classList.contains(sel.substring(1))) res.push(c);
            } else if (sel.indexOf(',') >= 0) {
              const tags = sel.split(',').map((s) => s.trim().toUpperCase());
              if (tags.includes(c.tagName)) res.push(c);
            } else if (c.tagName && c.tagName.toUpperCase() === sel.toUpperCase()) {
              res.push(c);
            }
            if (c.children && c.children.length) walk(c);
          }
        }
        walk(this);
        return res;
      },
      closest(sel) {
        let p = this.parentNode;
        while (p) {
          if (sel.startsWith('.')) {
            if (p.classList && p.classList.contains(sel.substring(1))) return p;
          } else if (p.tagName && p.tagName.toUpperCase() === sel.toUpperCase()) {
            return p;
          }
          p = p.parentNode;
        }
        return null;
      },
      contains(target) {
        let p = target;
        while (p) {
          if (p === this) return true;
          p = p.parentNode;
        }
        return false;
      },
      appendChild(child) {
        this.children.push(child);
        child.parentNode = this;
        if (child.id) els[child.id] = child;
        return child;
      },
      insertBefore(newChild, refChild) {
        const idx = this.children.indexOf(refChild);
        if (idx >= 0) {
          this.children.splice(idx, 0, newChild);
        } else {
          this.children.push(newChild);
        }
        newChild.parentNode = this;
        if (newChild.id) els[newChild.id] = newChild;
        return newChild;
      },
      removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) this.children.splice(i, 1);
        if (child.id) delete els[child.id];
        child.parentNode = null;
        return child;
      },
    };
    return el;
  }

  const editor = makeEl('textarea');
  editor.id = 'editor';
  els.editor = editor;

  const preview = makeEl('div');
  preview.id = 'preview';
  els.preview = preview;

  const btnTranslate = makeEl('button');
  btnTranslate.id = 'btn-translate';
  els['btn-translate'] = btnTranslate;

  const body = makeEl('body');
  body.appendChild(editor);
  body.appendChild(preview);
  body.appendChild(btnTranslate);
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
    localStorage: {
      getItem: (k) => storage.get(k) || null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
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
      patch: () => {},
    },
    TabManager: {
      getActiveTab: () => ({ id: 'tab_1', title: 'test.md' }),
    },
    SettingsUI: {
      open: () => {},
      setCategory: () => {},
    },
    Commands: {
      register: (id, def) => { registeredCommands[id] = def; },
      run: () => {},
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
  return { ctx, els, ipcMsgs, editor, preview, btnTranslate, workspaceSubs, registeredCommands, makeEl, storage, listeners, docListeners };
}

test('TranslateUI 模块挂载与 API 完整暴露', () => {
  const h = loadHarness();
  assert.ok(h.ctx.TranslateUI, 'TranslateUI 已挂载');
  assert.equal(typeof h.ctx.TranslateUI.openBubble, 'function');
  assert.equal(typeof h.ctx.TranslateUI.closeBubble, 'function');
  assert.equal(typeof h.ctx.TranslateUI.openPopup, 'function');
  assert.equal(typeof h.ctx.TranslateUI.closePopup, 'function');
  assert.equal(typeof h.ctx.TranslateUI.togglePopup, 'function');
  assert.equal(typeof h.ctx.TranslateUI.translatePreview, 'function');
  assert.equal(typeof h.ctx.TranslateUI.restorePreview, 'function');
  assert.equal(typeof h.ctx.TranslateUI.saveEngine, 'function');
  assert.equal(typeof h.ctx.TranslateUI.saveTargetLang, 'function');
  assert.ok(h.registeredCommands['translate.selection'], '已注册 translate.selection 命令');
  assert.ok(h.registeredCommands['translate.selectionReplace'], '已注册 translate.selectionReplace 命令');
  assert.ok(h.registeredCommands['translate.bubble.replace'], '已注册 translate.bubble.replace 命令');
  assert.ok(h.registeredCommands['translate.bubble.insert'], '已注册 translate.bubble.insert 命令');
  assert.ok(h.registeredCommands['translate.bubble.copy'], '已注册 translate.bubble.copy 命令');
  assert.ok(h.registeredCommands['translate.popup.toggle'], '已注册 translate.popup.toggle 命令');
  assert.ok(h.registeredCommands['translate.popup.bilingual'], '已注册 translate.popup.bilingual 命令');
  assert.ok(h.registeredCommands['translate.popup.replaceMode'], '已注册 translate.popup.replaceMode 命令');
  assert.ok(h.registeredCommands['translate.popup'], '已注册 translate.popup 命令');
  assert.ok(h.registeredCommands['translate.preview'], '已注册 translate.preview 命令');
  assert.ok(h.registeredCommands['translate.restore'], '已注册 translate.restore 命令');
});

test('选区检测：折叠或空文本返回 null，有非空白选区返回选区对象', () => {
  const h = loadHarness();
  h.editor.value = 'Hello world from GlanceMD Ultra';
  h.editor.selectionStart = 0;
  h.editor.selectionEnd = 0;
  assert.equal(h.ctx.TranslateUI.getSelectionInfo(), null, '折叠光标无选区');

  h.editor.selectionStart = 6;
  h.editor.selectionEnd = 11;
  const sel = h.ctx.TranslateUI.getSelectionInfo();
  assert.ok(sel);
  assert.equal(sel.text, 'world');
  assert.equal(sel.start, 6);
  assert.equal(sel.end, 11);
  assert.equal(sel.source, 'editor');
});

test('视口边界约束：clampPosition 在各边界安全留白', () => {
  const h = loadHarness();
  const clamp = h.ctx.TranslateUI.clampPosition;
  const round = (obj) => JSON.parse(JSON.stringify(obj));
  assert.deepEqual(round(clamp(-100, -50, 380, 200)), { x: 12, y: 12 });
  assert.deepEqual(round(clamp(2000, 2000, 380, 200)), { x: 1024 - 380 - 12, y: 768 - 200 - 12 });
  assert.deepEqual(round(clamp(200, 300, 380, 200)), { x: 200, y: 300 });
});

test('划词气泡独立切换引擎与目标语言，并记住上次选择', () => {
  const h = loadHarness();
  h.ctx.TranslateUI.saveEngine('bing');
  h.ctx.TranslateUI.saveTargetLang('ja');
  assert.equal(h.ctx.TranslateUI.getSavedEngine(), 'bing');
  assert.equal(h.ctx.TranslateUI.getSavedTargetLang(), 'ja');

  h.editor.value = 'Deep learning';
  h.editor.selectionStart = 0;
  h.editor.selectionEnd = 13;

  h.ctx.TranslateUI.openBubble();
  const req = h.ipcMsgs.find((m) => m.command === 'translate.request');
  assert.ok(req);
  assert.equal(req.engineKind, 'bing');
  assert.equal(req.targetLanguage, 'ja');
});

test('顶栏 Popup 浮窗：openPopup / closePopup / togglePopup 状态切换与渲染', () => {
  const h = loadHarness();
  assert.equal(h.ctx.TranslateUI.getState().isPopupOpen, false);

  h.ctx.TranslateUI.togglePopup();
  assert.equal(h.ctx.TranslateUI.getState().isPopupOpen, true);
  assert.ok(h.els['translate-popup'], '已创建 #translate-popup');
  assert.equal(h.els['translate-popup'].hidden, false);

  h.ctx.TranslateUI.togglePopup();
  assert.equal(h.ctx.TranslateUI.getState().isPopupOpen, false);
  assert.equal(h.els['translate-popup'].hidden, true);
});

test('预览区全文翻译：collectPreviewSegments 过滤代码块与提取段落', () => {
  const h = loadHarness();

  const h1 = h.makeEl('h1');
  h1.textContent = 'Main Heading';
  const p1 = h.makeEl('p');
  p1.textContent = 'First paragraph content.';
  const pre = h.makeEl('pre');
  const code = h.makeEl('code');
  code.textContent = 'const a = 1;';
  pre.appendChild(code);
  const p2 = h.makeEl('p');
  p2.textContent = 'Second paragraph after code.';

  h.preview.appendChild(h1);
  h.preview.appendChild(p1);
  h.preview.appendChild(pre);
  h.preview.appendChild(p2);

  const collected = h.ctx.TranslateUI.collectPreviewSegments();
  assert.ok(collected);
  assert.equal(collected.segments.length, 3, '应提取 3 个文本块（跳过 pre/code）');
  assert.equal(collected.segments[0].text, 'Main Heading');
  assert.equal(collected.segments[1].text, 'First paragraph content.');
  assert.equal(collected.segments[2].text, 'Second paragraph after code.');
});

test('预览区双语对照翻译与一键还原：插入 .preview-trans-block 与 restorePreview 还原', () => {
  const h = loadHarness();
  const p = h.makeEl('p');
  p.textContent = 'English paragraph.';
  h.preview.appendChild(p);

  h.ctx.TranslateUI.translatePreview();
  const st = h.ctx.TranslateUI.getState();
  assert.equal(st.previewLoading, true);

  const req = h.ipcMsgs.find((m) => m.command === 'translate.request' && m.requestId.startsWith('prev_'));
  assert.ok(req, '已发出预览区全文翻译请求');

  // 模拟返回翻译结果
  h.ctx.TranslateUI.onTranslateResult({
    requestId: req.requestId,
    ok: true,
    results: [{ id: 'p_0', text: '中文段落。' }],
  });

  assert.equal(h.ctx.TranslateUI.isCurrentTabTranslated(), true);
  const transBlocks = h.preview.querySelectorAll('.preview-trans-block');
  assert.equal(transBlocks.length, 1, '已插入双语对照译文块');
  assert.equal(transBlocks[0].textContent, '中文段落。');

  // 测试一键还原
  h.ctx.TranslateUI.restorePreview();
  assert.equal(h.ctx.TranslateUI.isCurrentTabTranslated(), false);
  const transBlocksAfter = h.preview.querySelectorAll('.preview-trans-block');
  assert.equal(transBlocksAfter.length, 0, '双语译文块已全部清除');
});

test('已翻译后切换呈现模式：复用缓存译文本地重渲染，不发新请求', () => {
  const h = loadHarness();
  const p = h.makeEl('p');
  p.textContent = 'English paragraph.';
  h.preview.appendChild(p);

  h.ctx.TranslateUI.translatePreview();
  let reqCount = h.ipcMsgs.filter((m) => m.command === 'translate.request').length;
  assert.equal(reqCount, 1);
  const req = h.ipcMsgs.find((m) => m.command === 'translate.request');
  h.ctx.TranslateUI.onTranslateResult({
    requestId: req.requestId,
    ok: true,
    results: [{ id: 'p_0', text: '中文段落。' }],
  });
  assert.equal(h.ctx.TranslateUI.isCurrentTabTranslated(), true);

  // 双语对照 → 纯译文：本地重渲染，无新请求
  h.ctx.TranslateUI.setPreviewDisplayMode('replace');
  reqCount = h.ipcMsgs.filter((m) => m.command === 'translate.request').length;
  assert.equal(reqCount, 1, '切换模式未发新请求');
  assert.equal(h.ctx.TranslateUI.getState().displayMode, 'replace');
  assert.equal(h.preview.querySelectorAll('.preview-trans-block').length, 0, '双语译文块已清除');
  assert.equal(h.preview.children[0].textContent, '中文段落。', '原文段落显示纯译文');
  assert.equal(h.ctx.TranslateUI.getState().tabTranslationState.tab_1.results.length, 1, '回执已缓存');

  // 纯译文 → 双语对照：同样复用缓存
  h.ctx.TranslateUI.setPreviewDisplayMode('bilingual');
  reqCount = h.ipcMsgs.filter((m) => m.command === 'translate.request').length;
  assert.equal(reqCount, 1, '切回双语同样未发新请求');
  const blocks = h.preview.querySelectorAll('.preview-trans-block');
  assert.equal(blocks.length, 1, '双语译文块恢复');
  assert.equal(blocks[0].textContent, '中文段落。');
});

test('未翻译时切换呈现模式仅记录状态，不发请求', () => {
  const h = loadHarness();
  h.ctx.TranslateUI.setPreviewDisplayMode('replace');
  assert.equal(h.ctx.TranslateUI.getState().displayMode, 'replace');
  assert.equal(h.ipcMsgs.filter((m) => m.command === 'translate.request').length, 0);
  assert.equal(h.ctx.TranslateUI.isCurrentTabTranslated(), false);
});

test('气泡局部快捷键：Alt+R 替换，Alt+I 插入，Alt+C 复制', () => {
  const h = loadHarness();
  const cmds = h.registeredCommands;
  assert.equal(cmds['translate.bubble.replace'].isEnabled(), false, '气泡未打开时禁用');

  h.editor.value = 'Hello world';
  h.editor.selectionStart = 0;
  h.editor.selectionEnd = 5;
  h.ctx.TranslateUI.openBubble();
  assert.equal(cmds['translate.bubble.replace'].isEnabled(), false, '加载中（无结果）禁用');
  const req = h.ipcMsgs.find((m) => m.command === 'translate.request');
  h.ctx.TranslateUI.onTranslateResult({
    requestId: req.requestId,
    ok: true,
    results: [{ id: 's0', text: '世界' }],
  });
  assert.equal(cmds['translate.bubble.replace'].isEnabled(), true);
  assert.equal(cmds['translate.bubble.insert'].isEnabled(), true);
  assert.equal(cmds['translate.bubble.copy'].isEnabled(), true);

  // Alt+R 对应命令执行替换
  cmds['translate.bubble.replace'].run();
  assert.equal(h.editor.value, '世界 world');
  assert.equal(h.ctx.TranslateUI.getState().isOpen, false);
  assert.equal(cmds['translate.bubble.replace'].isEnabled(), false, '气泡关闭后禁用');

  // Alt+I 对应命令执行插入
  h.editor.value = 'Hello world';
  h.editor.selectionStart = 0;
  h.editor.selectionEnd = 5;
  h.ctx.TranslateUI.openBubble();
  const req2 = h.ipcMsgs.filter((m) => m.command === 'translate.request')[1];
  h.ctx.TranslateUI.onTranslateResult({
    requestId: req2.requestId,
    ok: true,
    results: [{ id: 's0', text: '世界' }],
  });
  cmds['translate.bubble.insert'].run();
  assert.equal(h.editor.value, 'Hello\n\n世界 world');
});

test('气泡错误态：Alt+R 对应命令触发重试（重发请求）', () => {
  const h = loadHarness();
  h.editor.value = 'Hello world';
  h.editor.selectionStart = 0;
  h.editor.selectionEnd = 5;
  h.ctx.TranslateUI.openBubble();
  const firstReq = h.ipcMsgs.find((m) => m.command === 'translate.request');
  h.ctx.TranslateUI.onTranslateResult({ requestId: firstReq.requestId, ok: false, message: '网络错误' });
  assert.equal(h.ctx.TranslateUI.getState().isOpen, true, '错误态气泡保持打开');
  assert.equal(h.registeredCommands['translate.bubble.replace'].isEnabled(), true, '错误态同槽可用');

  h.registeredCommands['translate.bubble.replace'].run();
  const requestCount = h.ipcMsgs.filter((m) => m.command === 'translate.request').length;
  assert.equal(requestCount, 2, 'Alt+R 在错误态触发重试');
  assert.equal(h.ctx.TranslateUI.getState().isLoading, true);
});

test('Popup 主操作为全局键：不开 Popup 也能 Alt+A 翻译 / Alt+B·V 切模式', () => {
  const h = loadHarness();
  const cmds = h.registeredCommands;
  const p = h.makeEl('p');
  p.textContent = 'English paragraph.';
  h.preview.appendChild(p);

  // 不打开 Popup 直接执行（全局键语义）
  cmds['translate.popup.toggle'].run();
  const req = h.ipcMsgs.find((m) => m.command === 'translate.request' && m.requestId.startsWith('prev_'));
  assert.ok(req, 'Alt+A 触发翻译当前预览');
  h.ctx.TranslateUI.onTranslateResult({
    requestId: req.requestId,
    ok: true,
    results: [{ id: 'p_0', text: '中文段落。' }],
  });
  assert.equal(h.ctx.TranslateUI.isCurrentTabTranslated(), true);

  cmds['translate.popup.replaceMode'].run();
  assert.equal(h.ctx.TranslateUI.getState().displayMode, 'replace', 'Alt+V 切纯译文');
  cmds['translate.popup.bilingual'].run();
  assert.equal(h.ctx.TranslateUI.getState().displayMode, 'bilingual', 'Alt+B 切双语对照');
  const requestCount = h.ipcMsgs.filter((m) => m.command === 'translate.request').length;
  assert.equal(requestCount, 1, '模式切换复用缓存，不发新请求');
});

test('直达替换使用输入翻译目标语言（默认 en），气泡使用默认目标语言', () => {
  const h = loadHarness();
  // 未配置该设置项时回落出厂默认 en
  h.editor.value = '你好世界';
  h.editor.selectionStart = 0;
  h.editor.selectionEnd = 4;
  h.ctx.TranslateUI.translateSelectionReplace();
  const direct = h.ipcMsgs.find((m) => m.command === 'translate.request');
  assert.equal(direct.targetLanguage, 'en', '直达替换默认译成英文');
  h.ctx.TranslateUI.onTranslateResult({
    requestId: direct.requestId,
    ok: true,
    results: [{ id: 's0', text: 'Hello world' }],
  });
  assert.equal(h.editor.value, 'Hello world');

  // 设置项生效：配置为 ja 时直达替换带 ja
  h.ctx.SettingsApply.get = () => ({
    translation: { targetLanguage: 'zh-Hans', inputTargetLanguage: 'ja', selectionTriggerEnabled: true },
  });
  h.editor.value = '你好世界';
  h.editor.selectionStart = 0;
  h.editor.selectionEnd = 4;
  h.ctx.TranslateUI.translateSelectionReplace();
  const direct2 = h.ipcMsgs.filter((m) => m.command === 'translate.request')[1];
  assert.equal(direct2.targetLanguage, 'ja', '设置项覆盖输入目标语言');
  h.ctx.TranslateUI.onTranslateResult({
    requestId: direct2.requestId,
    ok: true,
    results: [{ id: 's0', text: 'こんにちは' }],
  });
  assert.equal(h.editor.value, 'こんにちは');

  // 气泡（阅读向）仍使用默认目标语言 zh-Hans
  h.editor.value = 'Hello world';
  h.editor.selectionStart = 0;
  h.editor.selectionEnd = 11;
  h.ctx.TranslateUI.openBubble();
  const bubbleReq = h.ipcMsgs.filter((m) => m.command === 'translate.request')[2];
  assert.equal(bubbleReq.targetLanguage, 'zh-Hans', '气泡仍用阅读向目标语言');
});

test('划词气泡锚定在选区旁（触发按钮位置）而非固定坐标', () => {
  const h = loadHarness();
  h.editor.value = 'Hello world';
  h.editor.selectionStart = 0;
  h.editor.selectionEnd = 5;

  // 模拟编辑区 mouseup（携带鼠标坐标）→ 浮现触发按钮 → 点击弹出气泡
  (h.listeners.editor.mouseup || []).forEach((fn) => fn({ clientX: 200, clientY: 200 }));
  const trigger = h.els['translate-trigger-btn'];
  assert.equal(trigger.hidden, false, '划词后浮现触发按钮');

  h.ctx.TranslateUI.openBubble();
  const bubble = h.els['translate-bubble'];
  assert.equal(bubble.hidden, false);
  // 触发按钮的 getBoundingClientRect 桩返回 { left:100, top:100, bottom:200 }，
  // 气泡应锚定在其下方（left=100, bottom+8=208），而不是旧的固定回退 (120,120)
  assert.equal(bubble.style.left, '100px');
  assert.equal(bubble.style.top, '208px');
});

test('直达替换：translateSelectionReplace 跳过气泡直接写回选区', () => {
  const h = loadHarness();
  h.editor.value = 'Hello world from Ultra';
  h.editor.selectionStart = 6;
  h.editor.selectionEnd = 11;

  h.ctx.TranslateUI.translateSelectionReplace();
  assert.equal(h.ctx.TranslateUI.getState().isOpen, false, '请求阶段不弹出气泡');
  const req = h.ipcMsgs.find((m) => m.command === 'translate.request');
  assert.ok(req, '已发出翻译请求');

  h.ctx.TranslateUI.onTranslateResult({
    requestId: req.requestId,
    ok: true,
    results: [{ id: 's0', text: '世界' }],
  });
  assert.equal(h.editor.value, 'Hello 世界 from Ultra', '回执后直接替换选区');
  assert.equal(h.ctx.TranslateUI.getState().isOpen, false, '成功后也不弹气泡');
});

test('直达替换：接口失败时回退为弹出气泡展示', () => {
  const h = loadHarness();
  h.editor.value = 'Hello world';
  h.editor.selectionStart = 0;
  h.editor.selectionEnd = 5;

  h.ctx.TranslateUI.translateSelectionReplace();
  const req = h.ipcMsgs.find((m) => m.command === 'translate.request');
  h.ctx.TranslateUI.onTranslateResult({ requestId: req.requestId, ok: false, message: '网络错误' });

  const st = h.ctx.TranslateUI.getState();
  assert.equal(st.isOpen, true, '失败回退弹出气泡');
  assert.equal(st.pendingAutoReplace, false, '直达标记已消费');
});

test('直达替换：写回经 EditorCommands.transact 落应用级撤销栈', () => {
  const h = loadHarness();
  let transactCalls = 0;
  h.ctx.EditorCommands = {
    transact: (fn) => { transactCalls += 1; fn(h.editor); },
  };

  h.editor.value = 'Hello world';
  h.editor.selectionStart = 0;
  h.editor.selectionEnd = 5;
  h.ctx.TranslateUI.translateSelectionReplace();
  const req = h.ipcMsgs.find((m) => m.command === 'translate.request');
  h.ctx.TranslateUI.onTranslateResult({
    requestId: req.requestId,
    ok: true,
    results: [{ id: 's0', text: '世界' }],
  });

  assert.equal(transactCalls, 1, '替换写入走了 EditorCommands.transact');
  assert.equal(h.editor.value, '世界 world');
});
