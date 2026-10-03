/* export.test.js —— export.js 的单元测试（node:test + node:vm，FEAT-006）
 *
 * 覆盖：
 * 1. 模块导出与初始化：window.ExportUI 暴露完整 API，#btn-export 绑定；
 * 2. 菜单生命周期：toggleMenu 打开时懒发 pandoc.detect，再开不重复请求；
 * 3. 未检测到 pandoc：菜单项全部禁用并给安装指引入口；
 * 4. 已检测到（含 PDF 引擎）：状态行展示版本，五项可用，PDF 项带引擎徽标；
 * 5. 无 PDF 引擎：仅 PDF 项禁用（title 说明原因），其余可导；
 * 6. 导出流程：点击格式项 → pandoc.export（requestId/format/markdown 来自
 *    编辑器内存 buffer/sourceDir/suggestName）；导出中防重入；无文档拒绝；
 * 7. 回执处理：成功记 lastExport（菜单出现「打开所在文件夹」）、失败 toast
 *    透传 stderr、取消静默复位；
 * 8. 命令注册：export.menu + 每格式一条，run 可触发导出流程；
 * 9. i18n 完整性：export.* / command.export.* / commandDesc.export.* /
 *    help.menu.export / settings.cat.export / settings.pandoc.* 在 zh-CN 与
 *    en 两份语言表键集合一致。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadHarness() {
  const els = {};
  const listeners = {};
  const docListeners = {};
  const ipcMsgs = [];
  const workspaceSubs = {};
  const toasts = [];

  // 极简 HTML 解析：满足 export.js 菜单标记（div/span/button，class/id/data-* 属性，
  // 无嵌套引号）；textContent 按 DOM 语义聚合后代文本
  function parseInto(html, parentEl) {
    const stack = [parentEl];
    const re = /<\/?([a-zA-Z]+)([^>]*)>|([^<]+)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (m[1]) {
        const isClosing = html[m.index + 1] === '/';
        if (isClosing) {
          if (stack.length > 1) stack.pop();
        } else {
          const child = makeEl(m[1]);
          const attrRe = /([a-zA-Z-]+)(?:="([^"]*)")?/g;
          let am;
          while ((am = attrRe.exec(m[2])) !== null) {
            if (!am[1]) continue;
            child.setAttribute(am[1], am[2] !== undefined ? am[2] : '');
          }
          const top = stack[stack.length - 1];
          top.children.push(child);
          child.parentNode = top;
          if (child.id) els[child.id] = child;
          stack.push(child);
        }
      } else if (m[3] !== undefined && stack.length > 1) {
        stack[stack.length - 1]._ownText += m[3];
      }
    }
  }

  function finalizeText(el) {
    let text = el._ownText || '';
    el.children.forEach((c) => { text += finalizeText(c); });
    el.textContent = text;
    return text;
  }

  function makeEl(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      id: '',
      type: '',
      hidden: false,
      value: '',
      style: {},
      children: [],
      parentNode: null,
      dataset: {},
      attrs: {},
      _innerHTML: '',
      _ownText: '',
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
      // 渲染走 innerHTML：harness 内置极简解析器（div/span/button + class/id/data-* 属性）
      set innerHTML(v) {
        this._innerHTML = String(v);
        this.children.length = 0;
        this._ownText = '';
        parseInto(this._innerHTML, this);
        finalizeText(this);
      },
      get innerHTML() { return this._innerHTML; },
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
      getBoundingClientRect() { return { left: 100, top: 100, right: 300, bottom: 200, width: 200, height: 100 }; },
      querySelector(sel) {
        if (sel.startsWith('#')) return els[sel.substring(1)] || null;
        return this.querySelectorAll(sel)[0] || null;
      },
      querySelectorAll(sel) {
        const res = [];
        const attrMatch = sel.match(/^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/);
        function walk(node) {
          for (const c of node.children) {
            if (attrMatch) {
              const v = c.attrs[attrMatch[1]];
              if (v !== undefined && (attrMatch[2] === undefined || v === attrMatch[2])) res.push(c);
            } else if (sel.startsWith('.')) {
              if (c.classList && c.classList.contains(sel.substring(1))) res.push(c);
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
        const attrMatch = typeof sel === 'string' ? sel.match(/^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/) : null;
        let p = this;
        while (p) {
          if (attrMatch) {
            const v = p.attrs && p.attrs[attrMatch[1]];
            if (v !== undefined && (attrMatch[2] === undefined || v === attrMatch[2])) return p;
          } else if (sel.startsWith('.')) {
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
  editor.value = '# 标题\n\n正文';
  els.editor = editor;

  const btnExport = makeEl('button');
  btnExport.id = 'btn-export';
  els['btn-export'] = btnExport;

  const body = makeEl('body');
  body.appendChild(editor);
  body.appendChild(btnExport);
  els.body = body;

  const activeTab = { id: 'tab_1', path: 'D:/docs/note.md', filename: 'note.md', content: editor.value, isImage: false };
  const registeredCommands = {};
  const ctx = {
    console,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    innerWidth: 1024,
    innerHeight: 768,
    document: {
      readyState: 'complete',
      body,
      getElementById(id) { return els[id] || null; },
      createElement(tag) { return makeEl(tag); },
      addEventListener(evt, handler) {
        (docListeners[evt] = docListeners[evt] || []).push(handler);
      },
      removeEventListener() {},
    },
    I18n: { t: (k) => k },
    TabManager: {
      getActiveTab: () => activeTab,
    },
    Workspace: {
      getState: () => ({ root: 'D:/docs' }),
      on: (evt, fn) => { (workspaceSubs[evt] = workspaceSubs[evt] || []).push(fn); },
    },
    AppToast: {
      show: (text) => toasts.push(text),
      hide: () => toasts.push('__hide__'),
    },
    Commands: {
      register: (id, def) => { registeredCommands[id] = def; },
      run: () => {},
    },
    ipc: {
      postMessage: (m) => ipcMsgs.push(JSON.parse(m)),
    },
  };
  ctx.window = ctx;

  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'export.js'), 'utf8'), ctx, { filename: 'export.js' });
  return { ctx, els, ipcMsgs, editor, btnExport, body, workspaceSubs, registeredCommands, toasts, activeTab, makeEl, listeners, docListeners };
}

function emitDetect(h, payload) {
  (h.workspaceSubs['workspace:pandoc-detect-result'] || []).forEach((fn) => fn(payload));
}

function menuItems(h) {
  const menu = h.els['export-menu'];
  if (!menu) return [];
  // harness 的 querySelectorAll 只支持类/标签选择器，按 .ctx-item 过滤属性
  return menu.querySelectorAll('.ctx-item').filter((el) => el.attrs['data-export-format']);
}

test('ExportUI 模块挂载与 API 完整暴露', () => {
  const h = loadHarness();
  assert.ok(h.ctx.ExportUI, 'ExportUI 已挂载');
  ['init', 'openMenu', 'closeMenu', 'toggleMenu', 'startExport', 'onDetectResult', 'onExportResult', 'getExportTarget', 'itemDisabledReason'].forEach(
    (k) => assert.equal(typeof h.ctx.ExportUI[k], 'function', 'API: ' + k),
  );
  assert.ok(h.registeredCommands['export.menu'], 'export.menu 命令已注册');
  ['docx', 'epub', 'html', 'pdf', 'odt'].forEach((f) => {
    assert.ok(h.registeredCommands['export.' + f], 'export.' + f + ' 命令已注册');
  });
});

test('打开菜单懒发 pandoc.detect，再次打开不重复请求', () => {
  const h = loadHarness();
  h.ctx.ExportUI.toggleMenu();
  assert.equal(h.ctx.ExportUI.getState().isOpen, true, '菜单已打开');
  const detectMsgs = h.ipcMsgs.filter((m) => m.command === 'pandoc.detect');
  assert.equal(detectMsgs.length, 1, '首次打开发一次检测');
  assert.ok(detectMsgs[0].requestId.startsWith('detect-'), 'requestId 带 detect- 前缀');
  h.ctx.ExportUI.closeMenu();
  h.ctx.ExportUI.toggleMenu();
  assert.equal(h.ipcMsgs.filter((m) => m.command === 'pandoc.detect').length, 1, '会话内已请求过不再重发');
});

test('未检测到 pandoc：菜单项全部禁用并给安装指引', () => {
  const h = loadHarness();
  h.ctx.ExportUI.openMenu();
  emitDetect(h, { requestId: h.ipcMsgs.find((m) => m.command === 'pandoc.detect').requestId, ok: true, found: false });
  const items = menuItems(h);
  assert.equal(items.length, 5);
  items.forEach((el) => {
    assert.equal(el.attrs['aria-disabled'], 'true', el.attrs['data-export-format'] + ' 应禁用');
  });
  const guide = h.els['export-menu'].querySelector('[data-export-action="guide"]');
  assert.ok(guide, '未检测到时给安装指引入口');
  const redetect = h.els['export-menu'].querySelector('[data-export-action="redetect"]');
  assert.ok(redetect, '未检测到时也给重新检测（装完免重启就地刷新）');
});

test('设置页的检测结果也刷新菜单缓存（settings-detect）', () => {
  const h = loadHarness();
  h.ctx.ExportUI.openMenu();
  emitDetect(h, { requestId: 'settings-detect', ok: true, found: true, version: '3.7.0.2', source: 'hint', pdfEngine: 'tectonic' });
  const items = menuItems(h);
  assert.equal(items.filter((el) => el.attrs['aria-disabled'] === 'false').length, 5, '设置页检测到后菜单立即全部可用');
  assert.equal(h.ctx.ExportUI.getState().detect.pdfEngine, 'tectonic');
});

test('检测到 pandoc（含 PDF 引擎）：五项可用，PDF 带引擎徽标', () => {
  const h = loadHarness();
  h.ctx.ExportUI.openMenu();
  emitDetect(h, {
    requestId: h.ipcMsgs.find((m) => m.command === 'pandoc.detect').requestId,
    ok: true, found: true, version: '3.7.0.2', source: 'path', pdfEngine: 'xelatex',
  });
  const items = menuItems(h);
  assert.equal(items.length, 5);
  items.forEach((el) => assert.equal(el.attrs['aria-disabled'], 'false', el.attrs['data-export-format'] + ' 应可用'));
  const statusText = h.els['export-menu'].querySelector('.export-menu-status-text').textContent;
  assert.ok(statusText.includes('3.7.0.2'), '状态行展示版本号');
  assert.ok(statusText.includes('export.source.path'), '状态行展示命中来源（harness i18n 为恒等，返回键名）');
  const pdfItem = items.find((el) => el.attrs['data-export-format'] === 'pdf');
  assert.ok(pdfItem.textContent.includes('xelatex'), 'PDF 项带引擎徽标');
  assert.ok(h.els['export-menu'].querySelector('[data-export-action="redetect"]'), '检测到时提供重新检测');
});

test('无 PDF 引擎：仅 PDF 禁用且说明原因，其余可导', () => {
  const h = loadHarness();
  h.ctx.ExportUI.openMenu();
  emitDetect(h, {
    requestId: h.ipcMsgs.find((m) => m.command === 'pandoc.detect').requestId,
    ok: true, found: true, version: '3.7.0.2', source: 'hint', pdfEngine: null,
  });
  const items = menuItems(h);
  const pdf = items.find((el) => el.attrs['data-export-format'] === 'pdf');
  assert.equal(pdf.attrs['aria-disabled'], 'true', '无引擎时 PDF 禁用');
  assert.ok((pdf.attrs.title || '').includes('pdfNoEngine'), '禁用原因指向 PDF 引擎缺失（恒等 i18n 返回键名）');
  items.filter((el) => el.attrs['data-export-format'] !== 'pdf').forEach((el) => {
    assert.equal(el.attrs['aria-disabled'], 'false', el.attrs['data-export-format'] + ' 不受影响');
  });
});

test('点击格式项发送 pandoc.export：buffer/目录/建议文件名正确', () => {
  const h = loadHarness();
  h.ctx.ExportUI.openMenu();
  emitDetect(h, {
    requestId: h.ipcMsgs.find((m) => m.command === 'pandoc.detect').requestId,
    ok: true, found: true, version: '3.7.0.2', source: 'path', pdfEngine: 'tectonic',
  });
  const docx = menuItems(h).find((el) => el.attrs['data-export-format'] === 'docx');
  // 点击事件冒泡委托：直接调用菜单容器的 click 监听
  const menu = h.els['export-menu'];
  (h.listeners['export-menu'] && h.listeners['export-menu'].click || []).forEach((fn) => fn({
    target: docx,
    preventDefault() {}, stopPropagation() {},
  }));
  const msg = h.ipcMsgs.find((m) => m.command === 'pandoc.export');
  assert.ok(msg, '发送导出请求');
  assert.equal(msg.format, 'docx');
  assert.equal(msg.markdown, '# 标题\n\n正文', 'markdown 来自编辑器内存 buffer');
  assert.equal(msg.sourceDir, 'D:/docs', 'sourceDir 取源文件所在目录');
  assert.equal(msg.suggestName, 'note.docx', '建议文件名按目标格式换扩展名');
  assert.ok(msg.requestId.startsWith('export-'), 'requestId 带 export- 前缀');
  assert.equal(h.ctx.ExportUI.getState().isOpen, false, '发起导出后菜单关闭');
  assert.ok(menu, '菜单仍在 DOM（重开复用）');
});

test('导出中防重入：进行中再次发起不发送第二条请求', () => {
  const h = loadHarness();
  h.ctx.ExportUI.startExport('docx');
  const first = h.ipcMsgs.filter((m) => m.command === 'pandoc.export').length;
  assert.equal(first, 1);
  h.ctx.ExportUI.startExport('epub');
  assert.equal(h.ipcMsgs.filter((m) => m.command === 'pandoc.export').length, 1, '导出中不允许重入');
});

test('无文档：拒绝导出且不发请求，菜单项禁用', () => {
  const h = loadHarness();
  h.activeTab.isImage = true;
  h.ctx.ExportUI.startExport('docx');
  assert.equal(h.ipcMsgs.filter((m) => m.command === 'pandoc.export').length, 0, '无文档不发请求');
  assert.equal(h.ctx.ExportUI.getExportTarget(), null);
  assert.ok(h.ctx.ExportUI.itemDisabledReason('docx').length > 0, '禁用原因非空');
});

test('回执成功：记录 lastExport 并提供打开所在文件夹', () => {
  const h = loadHarness();
  h.ctx.ExportUI.startExport('docx');
  const requestId = h.ipcMsgs.find((m) => m.command === 'pandoc.export').requestId;
  h.ctx.ExportUI.onExportResult({ requestId, ok: true, outPath: 'D:/out/note.docx', elapsedMs: 120 });
  assert.equal(h.ctx.ExportUI.getState().exportingFormat, null, '导出态复位');
  // harness 的 I18n.t 为恒等（返回键名），{path} 占位无宿主可替换
  assert.equal(h.toasts[h.toasts.length - 1], 'export.success');
  h.ctx.ExportUI.openMenu();
  const reveal = h.els['export-menu'].querySelector('[data-export-action="reveal"]');
  assert.ok(reveal, '成功后菜单出现打开所在文件夹');
  (h.listeners['export-menu'].click || []).forEach((fn) => fn({
    target: reveal, preventDefault() {}, stopPropagation() {},
  }));
  const revealMsg = h.ipcMsgs.find((m) => m.command === 'pandoc.reveal');
  assert.ok(revealMsg && revealMsg.path === 'D:/out/note.docx', 'reveal 透传产物路径');
});

test('回执失败：透传错误消息；取消：静默复位不弹错', () => {
  const h = loadHarness();
  h.ctx.ExportUI.startExport('epub');
  let requestId = h.ipcMsgs.find((m) => m.command === 'pandoc.export').requestId;
  h.ctx.ExportUI.onExportResult({ requestId, ok: false, message: 'pandoc 导出失败：x' });
  assert.ok(h.toasts.includes('pandoc 导出失败：x'), '失败 toast 透传消息');
  assert.equal(h.ctx.ExportUI.getState().exportingFormat, null);

  h.ctx.ExportUI.startExport('pdf');
  requestId = h.ipcMsgs.filter((m) => m.command === 'pandoc.export')[1].requestId;
  const toastLen = h.toasts.length;
  h.ctx.ExportUI.onExportResult({ requestId, ok: false, cancelled: true });
  assert.equal(h.ctx.ExportUI.getState().exportingFormat, null, '取消后复位');
  assert.ok(!h.toasts.slice(toastLen).some((t) => t.includes('失败')), '取消不弹错误');
});

test('非本轮 requestId 的回执被忽略', () => {
  const h = loadHarness();
  h.ctx.ExportUI.onExportResult({ requestId: 'export-999', ok: false, message: '过期回执' });
  assert.equal(h.ctx.ExportUI.getState().exportingFormat, null, '未进入导出态不受影响');
  assert.ok(!h.toasts.includes('过期回执'), '过期回执不弹提示');
});

test('i18n 完整性：导出相关键在 zh-CN 与 en 键集合一致', () => {
  const ctx = { window: null };
  ctx.window = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8'), ctx, { filename: 'i18n.js' });
  const zh = ctx.I18n.LOCALES['zh-CN'];
  const en = ctx.I18n.LOCALES['en'];
  const prefixes = ['export.', 'command.export.', 'commandDesc.export.', 'help.menu.export', 'settings.cat.export', 'settings.pandoc.', 'toolbar.export'];
  const keysOf = (table) => Object.keys(table).filter((k) => prefixes.some((p) => k === p || k.startsWith(p)));
  const zhKeys = keysOf(zh).sort();
  const enKeys = keysOf(en).sort();
  assert.deepEqual(enKeys, zhKeys, 'zh/en 导出相关键集合一致');
  assert.ok(zhKeys.includes('toolbar.export'), '顶栏按钮词条存在');
  assert.ok(zhKeys.includes('settings.pandoc.downloadHint'), '下载直链词条存在');
  assert.ok(zhKeys.filter((k) => k.startsWith('command.export.')).length === 6, '六条命令词条');
});
