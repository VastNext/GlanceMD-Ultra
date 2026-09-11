/* i18n.test.js —— i18n.js 的零依赖单测（node:test + node:vm）。
 *
 * stub：i18n.js 依赖 window.localStorage / document.documentElement / window.dispatchEvent；
 * applyDom 需要元素 querySelectorAll 与 getAttribute——用与 settings.test.js 同款的
 * 迷你 DOM 提供。CSS 不参与单测。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const I18N_JS = path.join(__dirname, 'i18n.js');

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);

function makeElement(tag) {
  const el = {
    tagName: String(tag || '').toLowerCase(),
    children: [],
    attributes: {},
    dataset: {},
    hidden: false,
    className: '',
    id: '',
    _text: '',
    setAttribute(n, v) { el.attributes[n] = String(v); },
    getAttribute(n) { return n in el.attributes ? el.attributes[n] : null; },
    appendChild(c) { el.children.push(c); return c; },
    addEventListener() {},
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => { n.children.forEach((c) => { if (matchesSel(c, sel)) out.push(c); walk(c); }); };
      walk(el);
      return out;
    },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return (el._text || '') + el.children.map((c) => c.textContent || '').join(''); },
    set(v) { el._text = String(v); el.children.length = 0; },
  });
  el.innerHTML = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => el.innerHTMLValue || '',
    set(html) { el.innerHTMLValue = String(html); },
  });
  return el;
}

function dataKey(name) {
  return name.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
}

function matchesSel(el, sel) {
  // 支持 applyDom 的逗号组合选择器：任一分支命中即匹配
  return sel.split(',').some((s) => matchOne(el, s));
}

function matchOne(el, sel) {
  sel = sel.trim();
  if (sel[0] === '#') return el.id === sel.slice(1);
  if (sel[0] === '.') return false;
  const m = sel.match(/^\[([^\]~=]+)\]$/);
  if (m) {
    const name = m[1];
    if (name.indexOf('data-') === 0) {
      const got = el.dataset[dataKey(name)];
      if (got !== undefined) return true;
    }
    return el.getAttribute(name) !== null;
  }
  return false;
}

function load(prefillLanguage) {
  const storage = new Map();
  if (prefillLanguage) storage.set('glancemd-ultra-language', prefillLanguage);
  const docElement = makeElement('html');
  const body = makeElement('body');
  const head = makeElement('head');
  const winHandlers = {};
  const doc = {
    documentElement: docElement,
    body,
    head,
    getElementById: (id) => null,
    createElement: (tag) => makeElement(tag),
    querySelectorAll: (sel) => {
      const out = [];
      [head, body].forEach((root) => {
        const walk = (n) => { n.children.forEach((c) => { if (matchesSel(c, sel)) out.push(c); walk(c); }); };
        walk(root);
      });
      return out;
    },
    addEventListener() {},
  };
  const ctx = { console, document: doc };
  ctx.window = ctx;
  ctx.CustomEvent = function (type, init) { this.type = type; this.detail = init && init.detail; };
  ctx.dispatchEvent = undefined; // 走降级分支（普通对象事件），vm 兼容
  ctx.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  ctx.window.dispatchEvent = (ev) => { (winHandlers[ev.type] = winHandlers[ev.type] || []).push(ev); };
  vm.runInNewContext(fs.readFileSync(I18N_JS, 'utf8'), ctx, { filename: 'i18n.js' });
  return { ctx, storage, docElement, body, winHandlers };
}

test('默认语言 zh-CN：t 取词与 {n} 占位', () => {
  const h = load();
  assert.equal(h.ctx.I18n.getLanguage(), 'zh-CN');
  assert.equal(h.ctx.I18n.t('tabs.menuClose'), '关闭');
  assert.equal(h.ctx.I18n.t('tabs.closeBatchConfirm', { n: 2 }), '有 2 个未保存的标签页，确定全部关闭？');
});

test('缺键回退 zh-CN，再缺返回 key 本身', () => {
  const h = load();
  assert.equal(h.ctx.I18n.t('no.such.key'), 'no.such.key');
});

test('setLanguage(en) 切换、持久化、派发事件、更新 html lang', () => {
  const h = load();
  assert.equal(h.ctx.I18n.setLanguage('en'), true);
  assert.equal(h.ctx.I18n.getLanguage(), 'en');
  assert.equal(h.storage.get('glancemd-ultra-language'), 'en');
  assert.equal(h.docElement.getAttribute('lang'), 'en');
  assert.equal(h.ctx.I18n.t('tabs.menuClose'), 'Close');
  const events = h.winHandlers['i18n-changed'] || [];
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.language, 'en');
  // 未支持语言：no-op
  assert.equal(h.ctx.I18n.setLanguage('fr'), false);
  assert.equal(h.ctx.I18n.getLanguage(), 'en');
});

test('init 读取持久化语言（装载时 storage 已含 en）', () => {
  const h = load('en'); // load 的 prefill 在 vm 执行 i18n.js 之前写入
  assert.equal(h.ctx.I18n.getLanguage(), 'en');
  assert.equal(h.ctx.I18n.t('tabs.menuClose'), 'Close');
});

test('applyDom 按 data-i18n* 属性替换静态 chrome', () => {
  const h = load();
  const btn = makeElement('button');
  btn.setAttribute('data-i18n-title', 'toolbar.settings');
  btn.setAttribute('data-i18n-aria', 'toolbar.settings');
  h.body.appendChild(btn);
  const input = makeElement('input');
  input.setAttribute('data-i18n-placeholder', 'app.find');
  h.body.appendChild(input);
  const label = makeElement('span');
  label.setAttribute('data-i18n', 'tabs.menuClose');
  h.body.appendChild(label);
  h.ctx.I18n.applyDom();
  assert.equal(btn.getAttribute('title'), '设置');
  assert.equal(btn.getAttribute('aria-label'), '设置');
  assert.equal(input.getAttribute('placeholder'), '查找…');
  assert.equal(label.textContent, '关闭');
});

test('applyDom 在 en 下使用英文词条', () => {
  const h = load();
  h.ctx.I18n.setLanguage('en');
  const btn = makeElement('button');
  btn.setAttribute('data-i18n-title', 'toolbar.settings');
  h.body.appendChild(btn);
  h.ctx.I18n.applyDom();
  assert.equal(btn.getAttribute('title'), 'Settings');
});

test('设置页 CLI 静态文案在 zh-CN 与 en 下均有定义', () => {
  const h = load();
  assert.equal(h.ctx.I18n.t('settings.cliInstall'), '安装 gmdu 命令');
  assert.equal(h.ctx.I18n.t('settings.cliRemove'), '移除 gmdu 命令');
  assert.equal(h.ctx.I18n.t('settings.cliTitle'), 'Glance 命令行工具');

  h.ctx.I18n.setLanguage('en');
  assert.equal(h.ctx.I18n.t('settings.cliInstall'), 'Install gmdu command');
  assert.equal(h.ctx.I18n.t('settings.cliRemove'), 'Remove gmdu command');
  assert.equal(h.ctx.I18n.t('settings.cliTitle'), 'Glance Command Line Tool');
});

test('窗口与命令行分类及复用开关在英文模式下完整翻译', () => {
  const h = load();
  h.ctx.I18n.setLanguage('en');
  assert.equal(h.ctx.I18n.t('settings.windowCategory'), 'Window & Command Line');
  assert.match(h.ctx.I18n.t('settings.windowCategoryDesc'), /command-line/i);
  assert.match(h.ctx.I18n.t('settings.reuseWindowForFolder'), /Reuse an existing window/);
  assert.match(h.ctx.I18n.t('settings.reuseWindowForFolderDesc'), /Windows only/);
});

test('设置分类、设置项、枚举与快速大纲在中英双语下均全量翻译', () => {
  const h = load();
  // zh-CN
  assert.equal(h.ctx.I18n.t('settings.cat.appearance'), '外观');
  assert.equal(h.ctx.I18n.t('settings.meta.editor.fontSize'), '字号（px）');
  assert.equal(h.ctx.I18n.t('settings.enum.theme.system'), '跟随系统');
  assert.equal(h.ctx.I18n.t('quickoutline.title'), '大纲');

  // en
  h.ctx.I18n.setLanguage('en');
  assert.equal(h.ctx.I18n.t('settings.cat.appearance'), 'Appearance');
  assert.equal(h.ctx.I18n.t('settings.meta.editor.fontSize'), 'Font Size (px)');
  assert.equal(h.ctx.I18n.t('settings.enum.theme.system'), 'System');
  assert.equal(h.ctx.I18n.t('quickoutline.title'), 'Outline');
});

test('command.* / commandDesc.* 键在 zh-CN 与 en 字典一一对应（防漏译）', () => {
  const h = load();
  const prefix = (map, p) => Object.keys(map).filter((k) => k.startsWith(p)).sort();
  for (const p of ['command.', 'commandDesc.']) {
    const zh = prefix(h.ctx.I18n.LOCALES['zh-CN'], p);
    const en = prefix(h.ctx.I18n.LOCALES['en'], p);
    assert.ok(zh.length > 0, p + ' 键应存在');
    assert.deepEqual(en, zh, p + ' 键应对齐');
  }
  const commands = prefix(h.ctx.I18n.LOCALES['zh-CN'], 'command.');
  assert.ok(commands.length > 100, 'zh-CN 字典应收录全量命令');
});

test('命令面板/快捷键助手/快速打开静态文案双语齐全', () => {
  const h = load();
  assert.equal(h.ctx.I18n.t('palette.placeholder'), '输入命令');
  assert.equal(h.ctx.I18n.t('quickopen.tabPlaceholder'), '快速切换标签页 (↑↓ 导航)...');
  assert.equal(h.ctx.I18n.t('quickopen.noTabs'), '当前无已打开的标签页');

  h.ctx.I18n.setLanguage('en');
  assert.equal(h.ctx.I18n.t('palette.placeholder'), 'Type a command');
  assert.equal(h.ctx.I18n.t('quickopen.tabPlaceholder'), 'Quick switch tabs (↑↓ to navigate)...');
  assert.equal(h.ctx.I18n.t('quickopen.noTabs'), 'No open tabs');
});

test('确认框按钮与关闭 aria 双语齐全', () => {
  const h = load();
  assert.equal(h.ctx.I18n.t('app.close'), '关闭');
  assert.equal(h.ctx.I18n.t('app.cancel'), '取消');
  assert.equal(h.ctx.I18n.t('app.confirmDiscardClose'), '放弃修改并关闭');

  h.ctx.I18n.setLanguage('en');
  assert.equal(h.ctx.I18n.t('app.close'), 'Close');
  assert.equal(h.ctx.I18n.t('app.cancel'), 'Cancel');
  assert.equal(h.ctx.I18n.t('app.confirmDiscardClose'), 'Discard changes and close');
});

test('commandLabel 按活动语言取词，未收录命令回退注册 label', () => {
  const h = load();
  assert.equal(h.ctx.I18n.commandLabel('file.open', '打开文件…'), '打开文件…');
  h.ctx.I18n.setLanguage('en');
  assert.equal(h.ctx.I18n.commandLabel('file.open', '打开文件…'), 'Open File…');
  // 未收录：回退 fallback
  assert.equal(h.ctx.I18n.commandLabel('some.unlisted', '回退文案'), '回退文案');
  assert.equal(h.ctx.I18n.commandLabel('some.unlisted'), 'some.unlisted');
});
