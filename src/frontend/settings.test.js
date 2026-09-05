/* settings.test.js —— settings.js 的零依赖单测（node:test + node:vm）。
 *
 * stub 说明：settings.js 对 DOM 的依赖集中在
 *   document.createElement / body.appendChild / getElementById / addEventListener /
 *   documentElement，元素的 innerHTML 赋值重建子树、querySelector('#id')、
 *   querySelectorAll('[data-setting]' / '.class')、children 遍历、dataset、
 *   onclick/oninput/onchange 直接赋值、hidden/value/checked/type 属性。
 * 因此这里实现一个覆盖上述查询路径的迷你 DOM：makeElement + 针对性 HTML 标签
 * 解析（带引号属性、布尔属性、select 按 selected 选项回填 value）。
 * CSS 不参与单测；明暗主题由 style.css token 保证（见 settings.css 注释）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SETTINGS_JS = path.join(__dirname, 'settings.js');

/* ── 迷你 DOM ── */

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);

function unescapeHTML(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function walkElements(el, fn) {
  el.children.forEach((child) => {
    fn(child);
    walkElements(child, fn);
  });
}

function dataKey(name) {
  return name.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
}

function matchesSel(el, sel) {
  sel = sel.trim();
  if (sel[0] === '#') return el.id === sel.slice(1);
  if (sel[0] === '.') return (' ' + el.className + ' ').indexOf(' ' + sel.slice(1) + ' ') >= 0;
  const attr = sel.match(/^\[([^\]~=]+)(?:="([^"]*)")?\]$/);
  if (attr) {
    const name = attr[1];
    const want = attr[2];
    if (name.indexOf('data-') === 0) {
      const got = el.dataset[dataKey(name)];
      return want === undefined ? got !== undefined : got === want;
    }
    const got = el.attributes[name];
    return want === undefined ? got !== undefined : got === want;
  }
  return false;
}

function makeElement(tag) {
  const el = {
    tagName: String(tag || '').toLowerCase(),
    children: [],
    attributes: {},
    dataset: {},
    listeners: {},
    hidden: false,
    className: '',
    id: '',
    value: '',
    checked: false,
    type: '',
    _text: '',
  };
  el.appendChild = function (child) {
    child.parentNode = el;
    el.children.push(child);
    return child;
  };
  el.addEventListener = function (type, handler) {
    (el.listeners[type] = el.listeners[type] || []).push(handler);
  };
  el.removeEventListener = function () {};
  el.focus = function () {};
  Object.defineProperty(el, 'textContent', {
    get() {
      return (el._text || '') + el.children.map((c) => c.textContent || '').join('');
    },
    set(v) {
      el._text = String(v);
    },
  });
  el.querySelectorAll = function (sel) {
    const out = [];
    walkElements(el, (n) => {
      if (matchesSel(n, sel)) out.push(n);
    });
    return out;
  };
  el.querySelector = function (sel) {
    const found = el.querySelectorAll(sel);
    return found.length ? found[0] : null;
  };
  // innerHTML 赋值重建子树（与真实 DOM 一致），随后回填 select.value
  let innerHTMLValue = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => innerHTMLValue,
    set(html) {
      innerHTMLValue = String(html);
      el.children.length = 0;
      el._text = '';
      parseInto(el, innerHTMLValue);
      syncSelectValues(el);
    },
  });
  return el;
}

// 覆盖 settings.js 自产 HTML 的极简解析：标签、带引号属性、布尔属性、闭合标签。
function parseInto(parent, html) {
  const stack = [parent];
  const re = /<([^>]+)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[2] !== undefined) {
      stack[stack.length - 1]._text += unescapeHTML(m[2]);
      continue;
    }
    const raw = m[1];
    if (raw[0] === '/') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClose = raw.slice(-1) === '/';
    const body = selfClose ? raw.slice(0, -1) : raw;
    const nameMatch = body.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
    const el = makeElement(nameMatch ? nameMatch[0] : 'span');
    const attrPart = body.replace(/^[a-zA-Z][a-zA-Z0-9-]*/, '');
    const attrRe = /([a-zA-Z_@:-]+)(?:\s*=\s*"([^"]*)")?/g;
    let am;
    while ((am = attrRe.exec(attrPart)) !== null) {
      const name = am[1];
      const value = am[2] === undefined ? '' : unescapeHTML(am[2]);
      el.attributes[name] = value;
      if (name === 'class') el.className = value;
      else if (name === 'id') el.id = value;
      else if (name === 'type') el.type = value;
      else if (name === 'value') el.value = value;
      else if (name === 'checked') el.checked = true;
      else if (name.indexOf('data-') === 0) el.dataset[dataKey(name)] = value;
    }
    stack[stack.length - 1].appendChild(el);
    if (!selfClose && !VOID_TAGS.has(el.tagName)) stack.push(el);
  }
}

function syncSelectValues(root) {
  walkElements(root, (el) => {
    if (el.tagName !== 'select') return;
    const options = el.children.filter((c) => c.tagName === 'option');
    const picked = options.find((o) => 'selected' in o.attributes);
    el.value = picked ? picked.value : (options[0] ? options[0].value : '');
  });
}

/* ── 装载与夹具 ── */

function load() {
  const els = {};
  const docHandlers = {};
  const storage = new Map();
  const docElement = makeElement('html');
  const body = makeElement('body');
  body.appendChild = function (e) {
    els[e.id] = e;
    body.children.push(e);
    return e;
  };
  const doc = {
    body,
    documentElement: docElement,
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => (id in els ? els[id] : null),
    addEventListener: (type, handler) => {
      (docHandlers[type] = docHandlers[type] || []).push(handler);
    },
    removeEventListener() {},
  };
  const ctx = { console, setTimeout, clearTimeout, document: doc };
  ctx.window = ctx;
  ctx.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  const subs = {};
  ctx.Workspace = {
    on(event, handler) {
      (subs[event] = subs[event] || []).push(handler);
    },
  };
  vm.runInNewContext(fs.readFileSync(SETTINGS_JS, 'utf8'), ctx, { filename: 'settings.js' });
  return { ctx, els, storage, subs, docHandlers, docElement };
}

// 与 Rust settings schema v1 序列化键一致的完整全局设置夹具。
const GLOBAL_SETTINGS = {
  version: 1,
  appearance: { theme: 'dark', sidebarFontSize: 14 },
  files: {
    visibleExts: ['md', 'markdown'],
    showHidden: false,
    exclude: ['.git'],
    watcherExclude: ['.git', 'node_modules'],
  },
  watching: { autoSave: 'off', autoSaveDelayMs: 1000, enableWatcher: true },
  search: { exclude: ['.git'], maxFileSizeMB: 5, maxResults: 2000 },
  editor: { fontSize: 14, tabSize: 4, wordWrap: true, lineNumbers: true, largeFileMB: 5 },
  keybindings: { overrides: { 'file.save': 'Ctrl+S' } },
  recovery: { confirmCloseDirty: true, crashRecovery: true, createProjectSettings: false },
};

function openWith(h, settings) {
  h.ctx.SettingsUI.receive('workspace:settings-effective', { settings });
  return h.els['settings-panel'];
}

function findBySetting(panel, name) {
  return panel.querySelectorAll('[data-setting]').find((el) => el.dataset.setting === name) || null;
}

/* ── 用例 ── */

test('SettingsUI 暴露 open/close/toggle/receive/getState', () => {
  const h = load();
  assert.equal(typeof h.ctx.SettingsUI.open, 'function');
  assert.equal(typeof h.ctx.SettingsUI.close, 'function');
  assert.equal(typeof h.ctx.SettingsUI.toggle, 'function');
  assert.equal(typeof h.ctx.SettingsUI.receive, 'function');
  assert.equal(typeof h.ctx.SettingsUI.getState, 'function');
});

test('open 创建面板并发送三条读命令，骨架含导航/主体/footer', () => {
  const h = load();
  const msgs = [];
  h.ctx.ipc = { postMessage: (m) => msgs.push(JSON.parse(m)) };
  h.ctx.SettingsUI.open();
  const panel = h.els['settings-panel'];
  assert.ok(panel, '面板已创建');
  assert.equal(panel.hidden, false);
  assert.deepEqual(
    msgs.map((x) => x.command),
    ['workspace.settings.get-effective', 'workspace.settings.get-global', 'workspace.settings.load-project'],
  );
  assert.ok(panel.querySelector('#settings-categories'), '分类导航存在');
  assert.ok(panel.querySelector('#settings-body'), '设置主体存在');
  assert.ok(panel.querySelector('#settings-filter'), '过滤输入存在');
  assert.ok(panel.querySelector('#settings-json'), '打开设置 JSON 入口存在');
});

test('receive 保存 effective 设置', () => {
  const h = load();
  h.ctx.SettingsUI.receive('workspace:settings-effective', { settings: { appearance: { theme: 'dark' } } });
  assert.equal(h.ctx.SettingsUI.getState().effective.appearance.theme, 'dark');
});

test('分类导航中文化：七个中文分类、每类一句描述、点击切换', () => {
  const h = load();
  h.ctx.SettingsUI.open();
  const panel = h.els['settings-panel'];
  const nav = panel.querySelector('#settings-categories');
  assert.deepEqual(
    nav.children.map((b) => b.textContent),
    ['外观', '文件', '监听', '搜索', '编辑器', '快捷键', '恢复'],
  );
  assert.equal(nav.children[0].dataset.category, 'appearance');
  const bodyText = () => panel.querySelector('#settings-body').textContent;
  assert.match(bodyText(), /外观/);
  assert.match(bodyText(), /主题与界面配色/, '每类一句中文描述');
  nav.children[2].onclick(); // 监听
  assert.match(bodyText(), /文件监听与自动保存行为/);
});

test('控件按值类型渲染：theme→select、bool→switch、number→number、array→逗号文本', () => {
  const h = load();
  const panel = openWith(h, GLOBAL_SETTINGS);
  const nav = panel.querySelector('#settings-categories');
  // 枚举 → select，选项含当前值
  const theme = findBySetting(panel, 'theme');
  assert.ok(theme, 'theme 控件存在');
  assert.equal(theme.tagName, 'select');
  assert.equal(theme.value, 'dark');
  const options = theme.children.filter((o) => o.tagName === 'option');
  assert.deepEqual(options.map((o) => o.value), ['dark', 'light', 'system']);
  // number → <input type=number>
  nav.children[4].onclick(); // 编辑器
  const fontSize = findBySetting(panel, 'fontSize');
  assert.equal(fontSize.tagName, 'input');
  assert.equal(fontSize.type, 'number');
  assert.equal(fontSize.value, '14');
  // bool → switch（label+checkbox 视觉：checkbox + 轨道 + 滑块）
  const wordWrap = findBySetting(panel, 'wordWrap');
  assert.equal(wordWrap.type, 'checkbox');
  assert.equal(wordWrap.checked, true);
  const wrap = wordWrap.parentNode;
  assert.equal(wrap.tagName, 'label');
  assert.equal(wrap.className, 'settings-switch');
  assert.equal(wrap.children[1].className, 'settings-switch-track');
  assert.equal(wrap.children[1].children[0].className, 'settings-switch-thumb');
  // array → 逗号分隔文本
  nav.children[1].onclick(); // 文件
  const exts = findBySetting(panel, 'visibleExts');
  assert.equal(exts.tagName, 'input');
  assert.equal(exts.type, 'text');
  assert.equal(exts.value, 'md, markdown');
  // 对象（overrides）→ JSON 文本
  nav.children[5].onclick(); // 快捷键
  const overrides = findBySetting(panel, 'overrides');
  assert.equal(overrides.value, JSON.stringify(GLOBAL_SETTINGS.keybindings.overrides));
});

test('设置行结构：左标签+说明、右控件，项目覆盖键带徽标', () => {
  const h = load();
  const panel = openWith(h, GLOBAL_SETTINGS);
  h.ctx.SettingsUI.receive('workspace:settings-project', { patch: { files: { showHidden: true } } });
  panel.querySelector('#settings-categories').children[1].onclick(); // 文件
  const rows = panel.querySelectorAll('.setting-row');
  assert.equal(rows.length, 4, '文件类 4 行');
  const hiddenRow = rows.find((r) => r.textContent.indexOf('显示隐藏文件') >= 0);
  assert.ok(hiddenRow, '有“显示隐藏文件”行');
  assert.match(hiddenRow.textContent, /在项目树中显示点开头的隐藏文件/, '行内含中文说明');
  assert.match(hiddenRow.textContent, /项目已覆盖/, '被项目覆盖的键带徽标');
  const extRow = rows.find((r) => r.textContent.indexOf('可见扩展名') >= 0);
  assert.doesNotMatch(extRow.textContent, /项目已覆盖/, '未覆盖的键无徽标');
  const info = hiddenRow.children[0];
  assert.equal(info.className, 'setting-info');
  assert.equal(info.children[0].className, 'setting-label');
  assert.equal(info.children[1].className, 'setting-desc');
  assert.equal(hiddenRow.children[1].className, 'setting-control');
});

test('#settings-filter 过滤：命中英文 key 与中文标签', () => {
  const h = load();
  const panel = openWith(h, GLOBAL_SETTINGS);
  const filter = panel.querySelector('#settings-filter');
  filter.value = 'theme';
  filter.oninput();
  assert.deepEqual(
    panel.querySelectorAll('[data-setting]').map((el) => el.dataset.setting),
    ['theme'],
  );
  filter.value = '';
  filter.oninput();
  assert.equal(panel.querySelectorAll('[data-setting]').length, 2, '清空后恢复全部（外观类 theme + sidebarFontSize）');
  panel.querySelector('#settings-categories').children[4].onclick(); // 编辑器
  filter.value = '字号';
  filter.oninput();
  assert.deepEqual(
    panel.querySelectorAll('[data-setting]').map((el) => el.dataset.setting),
    ['fontSize'],
  );
  filter.value = '不存在的关键字';
  filter.oninput();
  assert.match(panel.querySelector('#settings-body').textContent, /没有匹配的设置/);
});

test('onchange 发送 set-global：data 为合并后的完整 global JSON 字符串', () => {
  const h = load();
  const msgs = [];
  h.ctx.ipc = { postMessage: (m) => msgs.push(JSON.parse(m)) };
  h.ctx.SettingsUI.receive('workspace:settings-global', { settings: GLOBAL_SETTINGS });
  const theme = findBySetting(h.els['settings-panel'], 'theme');
  theme.value = 'light';
  theme.onchange();
  const msg = msgs[msgs.length - 1];
  assert.equal(msg.command, 'workspace.settings.set-global');
  assert.equal(typeof msg.data, 'string', 'data 是 JSON 字符串（与既有信封一致）');
  const parsed = JSON.parse(msg.data);
  assert.equal(parsed.appearance.theme, 'light', '被改的键已更新');
  assert.equal(parsed.editor.fontSize, 14, '其它类完整保留');
  assert.equal(parsed.files.watcherExclude.join('|'), '.git|node_modules', '同类兄弟键不丢');
  assert.equal(parsed.version, 1);
  assert.equal(
    h.ctx.SettingsUI.getState().global.appearance.theme,
    'dark',
    '不做乐观更新，等 Rust 回执刷新',
  );
});

test('onchange 值转换：number 发数字、bool 发布尔、array 按逗号拆分', () => {
  const h = load();
  const msgs = [];
  h.ctx.ipc = { postMessage: (m) => msgs.push(JSON.parse(m)) };
  h.ctx.SettingsUI.receive('workspace:settings-global', { settings: GLOBAL_SETTINGS });
  const panel = h.els['settings-panel'];
  const nav = panel.querySelector('#settings-categories');
  nav.children[1].onclick(); // 文件
  const exts = findBySetting(panel, 'visibleExts');
  exts.value = 'md, txt ，json,';
  exts.onchange();
  let parsed = JSON.parse(msgs[msgs.length - 1].data);
  assert.deepEqual(parsed.files.visibleExts, ['md', 'txt', 'json'], '全角/半角逗号拆分并去空');
  nav.children[4].onclick(); // 编辑器
  const fontSize = findBySetting(panel, 'fontSize');
  fontSize.value = '16';
  fontSize.onchange();
  parsed = JSON.parse(msgs[msgs.length - 1].data);
  assert.equal(parsed.editor.fontSize, 16);
  assert.equal(typeof parsed.editor.fontSize, 'number', 'number 发数字而非字符串');
  const wordWrap = findBySetting(panel, 'wordWrap');
  wordWrap.checked = false;
  wordWrap.onchange();
  parsed = JSON.parse(msgs[msgs.length - 1].data);
  assert.equal(parsed.editor.wordWrap, false, 'bool 发布尔');
});

test('theme 变更即时写 data-theme 与 localStorage[glancemd-ultra-theme]', () => {
  const h = load();
  h.ctx.SettingsUI.receive('workspace:settings-global', { settings: GLOBAL_SETTINGS });
  const theme = findBySetting(h.els['settings-panel'], 'theme');
  theme.value = 'system';
  theme.onchange();
  assert.equal(h.docElement.dataset.theme, 'system');
  assert.equal(h.storage.get('glancemd-ultra-theme'), 'system');
  theme.value = 'dark';
  theme.onchange();
  assert.equal(h.docElement.dataset.theme, 'dark');
  assert.equal(h.storage.get('glancemd-ultra-theme'), 'dark');
});

test('新增设置项渲染：watching.enableWatcher→switch、appearance.sidebarFontSize→number', () => {
  const h = load();
  const panel = openWith(h, GLOBAL_SETTINGS);
  const nav = panel.querySelector('#settings-categories');
  // 监听类：bool → switch（label+checkbox），含中文标签与说明
  nav.children[2].onclick();
  const enableWatcher = findBySetting(panel, 'enableWatcher');
  assert.ok(enableWatcher, 'enableWatcher 控件存在');
  assert.equal(enableWatcher.type, 'checkbox');
  assert.equal(enableWatcher.checked, true);
  const watcherBody = panel.querySelector('#settings-body').textContent;
  assert.match(watcherBody, /启用文件监听/);
  assert.match(watcherBody, /修改此设置后自动暂停或恢复监听/);
  // 外观类：number → <input type=number>
  nav.children[0].onclick();
  const sidebarFontSize = findBySetting(panel, 'sidebarFontSize');
  assert.ok(sidebarFontSize, 'sidebarFontSize 控件存在');
  assert.equal(sidebarFontSize.tagName, 'input');
  assert.equal(sidebarFontSize.type, 'number');
  assert.equal(sidebarFontSize.value, '14');
  assert.match(panel.querySelector('#settings-body').textContent, /侧栏字体大小/);
  assert.match(panel.querySelector('#settings-body').textContent, /资源管理器与大纲面板的基准字号/);
});

test('workspace:settings-changed 订阅生效：面板打开时重发读命令刷新', () => {
  const h = load();
  const msgs = [];
  h.ctx.ipc = { postMessage: (m) => msgs.push(JSON.parse(m)) };
  const handlers = h.subs['workspace:settings-changed'];
  assert.ok(handlers && handlers.length >= 1, '已订阅 workspace:settings-changed');
  handlers[0]({ scope: 'global' });
  assert.equal(msgs.length, 0, '面板未打开时不刷新');
  h.ctx.SettingsUI.open();
  msgs.length = 0;
  handlers[0]({ scope: 'global' });
  assert.deepEqual(
    msgs.map((m) => m.command),
    ['workspace.settings.get-effective', 'workspace.settings.get-global', 'workspace.settings.load-project'],
  );
});

test('close 隐藏面板，Escape 键同样可关闭', () => {
  const h = load();
  h.ctx.SettingsUI.open();
  h.ctx.SettingsUI.close();
  assert.equal(h.els['settings-panel'].hidden, true);
  h.ctx.SettingsUI.open();
  assert.equal(h.els['settings-panel'].hidden, false);
  assert.ok(h.docHandlers.keydown && h.docHandlers.keydown.length >= 1, '已监听 keydown');
  h.docHandlers.keydown.forEach((fn) => fn({ key: 'Escape' }));
  assert.equal(h.els['settings-panel'].hidden, true);
});
