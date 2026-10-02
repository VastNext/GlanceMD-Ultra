/* about-dialog.test.js — 「关于 GlanceMD Ultra」对话框的单元测试（node:test + node:vm）
 * 覆盖：版本徽章渲染（__APP_VERSION__ 同源）、链接点击走 open_external IPC、
 * 非 http(s) URL 拒绝、Esc / 遮罩 / 关闭按钮关闭、焦点还原、i18n-changed 刷新。
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');

function load(options = {}) {
  const elements = new Map();
  const docListeners = {};
  const winListeners = {};
  let activeElement = null;

  // 极简 HTML 片段拍平：抽 id/class/data-url 构建扁平元素（满足选择器查询即可）
  function parseFragment(html) {
    const els = [];
    const re = /<(\w+)([^>]*)>/g;
    let m;
    while ((m = re.exec(html))) {
      const el = makeEl(m[1]);
      const attrs = m[2] || '';
      const idM = attrs.match(/id="([^"]+)"/);
      if (idM) { el.id = idM[1]; }
      const clsM = attrs.match(/class="([^"]+)"/);
      if (clsM) { el.className = clsM[1]; }
      const urlM = attrs.match(/data-url="([^"]+)"/);
      if (urlM) { el.attrs['data-url'] = urlM[1]; }
      els.push(el);
    }
    return els;
  }

  function findById(root, id) {
    if (root.id === id) return root;
    for (const child of root.children || []) {
      const found = findById(child, id);
      if (found) return found;
    }
    return null;
  }

  function findByClass(root, cls) {
    const out = [];
    if (String(root.className || '').split(/\s+/).includes(cls)) out.push(root);
    for (const child of root.children || []) out.push(...findByClass(child, cls));
    return out;
  }

  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      textContent: '',
      attrs: {},
      dataset: {},
      children: [],
      parentNode: null,
      listeners: {},
      focused: false,
      set innerHTML(html) {
        el.children = parseFragment(html);
        el.children.forEach(ch => { ch.parentNode = el; registerTree(ch); });
      },
      get innerHTML() { return ''; },
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        contains(c) { return this._set.has(c); }
      },
      setAttribute(k, v) { el.attrs[k] = String(v); },
      getAttribute(k) { return el.attrs[k] !== undefined ? el.attrs[k] : null; },
      appendChild(child) {
        el.children.push(child);
        child.parentNode = el;
        registerTree(child);
      },
      removeChild(child) {
        const i = el.children.indexOf(child);
        if (i >= 0) el.children.splice(i, 1);
        child.parentNode = null;
      },
      contains(other) {
        let curr = other;
        while (curr) { if (curr === el) return true; curr = curr.parentNode; }
        return false;
      },
      addEventListener(type, fn) {
        el.listeners[type] = el.listeners[type] || [];
        el.listeners[type].push(fn);
      },
      dispatchEvent(e) {
        (el.listeners[e.type] || []).forEach(fn => fn(e));
      },
      focus() { el.focused = true; activeElement = el; },
      querySelector(sel) {
        if (sel.startsWith('#')) return findById(el, sel.slice(1));
        if (sel.startsWith('.')) return findByClass(el, sel.slice(1))[0] || null;
        return null;
      },
      querySelectorAll(sel) {
        if (sel.startsWith('.')) return findByClass(el, sel.slice(1));
        if (sel.startsWith('#')) {
          const found = findById(el, sel.slice(1));
          return found ? [found] : [];
        }
        return [];
      }
    };
    return el;
  }

  function registerTree(node) {
    if (node.id) elements.set(node.id, node);
    (node.children || []).forEach(registerTree);
  }

  const doc = {
    readyState: 'complete',
    body: makeEl('body'),
    get activeElement() { return activeElement; },
    set activeElement(el) { activeElement = el; },
    createElement: tag => makeEl(tag),
    getElementById: id => elements.get(id) || null,
    addEventListener(type, fn) {
      docListeners[type] = docListeners[type] || [];
      docListeners[type].push(fn);
    },
    dispatchEvent(e) {
      (docListeners[e.type] || []).forEach(fn => fn(e));
    }
  };

  const ipcLog = [];
  const c = {
    window: null,
    document: doc,
    console,
    setTimeout,
    clearTimeout,
    ipc: { postMessage: msg => ipcLog.push(JSON.parse(msg)) },
    __APP_VERSION__: options.version || '0.6.1'
  };
  c.window = c;
  c.addEventListener = (type, fn) => {
    winListeners[type] = winListeners[type] || [];
    winListeners[type].push(fn);
  };
  c.dispatchEvent = e => (winListeners[e.type] || []).forEach(fn => fn(e));

  if (options.withI18n) {
    vm.runInNewContext(fs.readFileSync('src/frontend/i18n.js', 'utf8'), c);
  }
  vm.runInNewContext(fs.readFileSync('src/frontend/about-dialog.js', 'utf8'), c);
  return { c, doc, ipcLog, winListeners };
}

function openDialog(c) {
  const prevFocus = c.document.createElement('button');
  prevFocus.focus();
  c.AboutDialog.show();
  const overlay = c.document.getElementById('about-dialog-overlay');
  return { overlay, prevFocus };
}

test('show：创建遮罩与卡片，open 态生效，版本徽章与 Cargo 版本同源', () => {
  const { c, doc } = load({ version: '0.6.1' });
  const { overlay } = openDialog(c);
  assert.ok(overlay, '遮罩应挂载到 DOM');
  assert.equal(c.AboutDialog.isOpen(), true);
  assert.equal(overlay.classList.contains('open'), true);

  const card = overlay.querySelector('.about-dialog-card');
  assert.ok(card, '卡片应存在');
  const version = card.querySelector('#about-dialog-version');
  assert.equal(version.textContent, 'v0.6.1');
  // 版本值来源是启动引导写入的 window.__APP_VERSION__
  assert.equal(c.__APP_VERSION__, '0.6.1');
  void doc;
});

test('链接点击：http(s) URL 经 open_external 上行并关闭对话框', () => {
  const { c, ipcLog } = load();
  const { overlay } = openDialog(c);
  const card = overlay.querySelector('.about-dialog-card');
  const links = card.querySelectorAll('.about-dialog-link');
  assert.equal(links.length, 2);
  assert.match(links[0].attrs['data-url'], /^https:\/\/vastnext\.com/);
  assert.match(links[1].attrs['data-url'], /^https:\/\/github\.com\/VastNext/);

  links[0].dispatchEvent({ type: 'click', preventDefault() {} });
  assert.equal(ipcLog.length, 1);
  assert.equal(ipcLog[0].command, 'open_external');
  assert.equal(ipcLog[0].url, links[0].attrs['data-url']);
  assert.equal(c.AboutDialog.isOpen(), false);
});

test('非 http(s) URL 被拒绝，不产生 IPC 上行', () => {
  const { c, ipcLog } = load();
  const { overlay } = openDialog(c);
  const card = overlay.querySelector('.about-dialog-card');
  const link = card.querySelectorAll('.about-dialog-link')[0];
  link.setAttribute('data-url', 'javascript:alert(1)');
  link.dispatchEvent({ type: 'click', preventDefault() {} });
  assert.equal(ipcLog.length, 0);
  assert.equal(c.AboutDialog.isOpen(), true);
});

test('Esc / 关闭按钮 / 遮罩点击均可关闭并还原焦点', () => {
  const { c } = load();
  // Esc（keydown 挂在卡片上）
  let { overlay, prevFocus } = openDialog(c);
  const card = overlay.querySelector('.about-dialog-card');
  card.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(c.AboutDialog.isOpen(), false);
  assert.equal(prevFocus.focused, true);

  // 关闭按钮
  ({ overlay, prevFocus } = openDialog(c));
  const closeBtn = overlay.querySelector('#about-dialog-btn-close');
  closeBtn.dispatchEvent({ type: 'click' });
  assert.equal(c.AboutDialog.isOpen(), false);

  // 遮罩空白处 pointerdown
  ({ overlay } = openDialog(c));
  overlay.dispatchEvent({ type: 'pointerdown', target: overlay });
  assert.equal(c.AboutDialog.isOpen(), false);
});

test('i18n-changed 刷新描述与版权年份（真实 I18n 词表）', () => {
  const { c, winListeners } = load({ withI18n: true });
  const { overlay } = openDialog(c);
  const card = overlay.querySelector('.about-dialog-card');
  const desc = card.querySelector('#about-dialog-desc');
  const copyright = card.querySelector('#about-dialog-copyright');
  assert.equal(desc.textContent, '轻量原生 Markdown 工作区编辑器');
  assert.match(copyright.textContent, /© \d{4} VastNext · GlanceMD Ultra/);

  c.I18n.setLanguage('en');
  (winListeners['i18n-changed'] || []).forEach(fn => fn({ type: 'i18n-changed' }));
  assert.equal(desc.textContent, 'Lightweight native Markdown workspace editor');

  // website / source 链接文案随语言刷新（getElementById 全局可查）
  const website = c.document.getElementById('about-dialog-link-website');
  assert.equal(website.textContent, 'Website');
});

test('测试钩子可注入伪版本号并渲染到徽章', () => {
  const { c } = load();
  c.AboutDialog._setVersionForTest('9.9.9');
  const { overlay } = openDialog(c);
  const card = overlay.querySelector('.about-dialog-card');
  assert.equal(card.querySelector('#about-dialog-version').textContent, 'v9.9.9');
});
