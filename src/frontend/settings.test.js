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
  const classes = new Set();
  const el = {
    tagName: String(tag || '').toLowerCase(),
    children: [],
    attributes: {},
    dataset: {},
    listeners: {},
    hidden: false,
    id: '',
    value: '',
    checked: false,
    disabled: false,
    type: '',
    _text: '',
  };
  Object.defineProperty(el, 'className', {
    get() {
      return Array.from(classes).join(' ');
    },
    set(v) {
      classes.clear();
      String(v || '')
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classes.add(c));
    },
  });
  el.classList = {
    add(...names) { names.forEach((n) => classes.add(n)); },
    remove(...names) { names.forEach((n) => classes.delete(n)); },
    toggle(name, force) {
      const on = force === undefined ? !classes.has(name) : Boolean(force);
      if (on) classes.add(name);
      else classes.delete(name);
      return on;
    },
    contains(name) { return classes.has(name); },
  };
  el.appendChild = function (child) {
    child.parentNode = el;
    el.children.push(child);
    return child;
  };
  el.setAttribute = function (name, value) {
    el.attributes[name] = String(value);
  };
  el.getAttribute = function (name) {
    return el.attributes[name] != null ? String(el.attributes[name]) : null;
  };
  el.removeAttribute = function (name) {
    delete el.attributes[name];
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
      else if (name === 'disabled') el.disabled = true;
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
  // settings.js 的 chrome 文案走 I18n.t：先装载 i18n.js（默认 zh-CN，与旧文案一致）
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8'), ctx, { filename: 'i18n.js' });
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
    terminalPath: '',
    terminalArgs: '',
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
    ['workspace.settings.get-effective', 'workspace.settings.get-global', 'workspace.settings.load-project', 'workspace.terminal.scan'],
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
  const h = loadKb();
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
  // 快捷键分类 → 专用列表或组件
  nav.children[5].onclick(); // 快捷键
  const kbRoot = panel.querySelector('.keybindings-settings-root');
  const kbRows = panel.querySelectorAll('.settings-kb-row');
  assert.ok(kbRoot || kbRows.length > 0, '快捷键分类已渲染专用视图');
});

test('设置行结构：左标签+说明、右控件，项目覆盖键带徽标', () => {
  const h = load();
  const panel = openWith(h, GLOBAL_SETTINGS);
  h.ctx.SettingsUI.receive('workspace:settings-project', { patch: { files: { showHidden: true } } });
  panel.querySelector('#settings-categories').children[1].onclick(); // 文件
  const rows = panel.querySelectorAll('.setting-row');
  assert.equal(rows.length, 5, '文件类 5 行');
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
  assert.equal(panel.querySelectorAll('[data-setting]').length, 4, '清空后恢复全部（外观类 theme + sidebarFontSize + language + outlineSide）');
  panel.querySelector('#settings-categories').children[4].onclick(); // 编辑器
  filter.value = '字号';
  filter.oninput();
  // 搜索是全局的：同时命中 编辑器.fontSize 与 外观.sidebarFontSize（按分类先后排序）
  assert.deepEqual(
    panel.querySelectorAll('[data-setting]').map((el) => el.dataset.setting),
    ['sidebarFontSize', 'fontSize'],
  );
  filter.value = '不存在的关键字';
  filter.oninput();
  assert.match(panel.querySelector('#settings-body').textContent, /没有匹配的设置/);
});

test('搜索改全局：跨分类聚合、分组可点击跳转且保留过滤', () => {
  const h = load();
  const panel = openWith(h, GLOBAL_SETTINGS);
  const filter = panel.querySelector('#settings-filter');
  filter.value = '排除'; // 命中 文件.exclude / 文件.watcherExclude / 搜索.exclude
  filter.oninput();

  const groups = [...panel.querySelectorAll('[data-goto]')].map(
    (b) => ({ label: b.textContent.replace(/\d+$/, ''), goto: b.dataset.goto }),
  );
  assert.deepEqual(
    groups.map((g) => g.goto),
    ['files', 'search'],
    '按分类分组：文件与搜索',
  );
  const names = panel.querySelectorAll('[data-setting]').map((el) => el.dataset.setting);
  assert.deepEqual(names.sort(), ['exclude', 'exclude', 'watcherExclude']);

  // 点击分组标题跳转该分类，且保留过滤词（仅显示该类命中项）
  panel
    .querySelectorAll('[data-goto]')
    .find((b) => b.dataset.goto === 'search')
    .onclick();
  assert.equal(h.ctx.SettingsUI.getState().category, 'search');
  assert.deepEqual(
    panel.querySelectorAll('[data-setting]').map((el) => el.dataset.setting),
    ['exclude'],
  );

  // 清空查询恢复当前分类完整视图
  filter.value = '';
  filter.oninput();
  assert.equal(panel.querySelectorAll('[data-setting]').length, 3, '搜索类共 3 项');
});

test('settings.css 显式声明 [hidden] 关闭（防止 display:flex 覆盖）', () => {
  const css = fs.readFileSync(
    path.join(__dirname, 'settings.css'),
    'utf8',
  );
  assert.match(css, /\.settings-panel\[hidden\]\s*{\s*display:\s*none\s*!important/);
});

test('设置控件遵循明暗 token：原生 select 与输入件不写死白色/暗色表面', () => {
  const css = fs.readFileSync(path.join(__dirname, 'settings.css'), 'utf8');
  assert.match(css, /\.setting-control input\[type="text"\][\s\S]*background-color:\s*var\(--input-bg,\s*var\(--bg-overlay\)\)/);
  assert.match(css, /\.setting-control input\[type="number"\][\s\S]*background-color:\s*var\(--input-bg,\s*var\(--bg-overlay\)\)/);
  assert.match(css, /\.setting-control select[\s\S]*background-color:\s*var\(--input-bg,\s*var\(--bg-overlay\)\)/);
  assert.doesNotMatch(css, /\.setting-control select[^{]*{[^}]*background(?:-color)?:\s*#(?:fff|ffffff|000|000000)/i);
});

test('设置 modal 的动态宽度与窄视口下限由 CSS 契约声明', () => {
  const css = fs.readFileSync(path.join(__dirname, 'settings.css'), 'utf8');
  assert.match(css, /(?:width|max-width):\s*min\([^;]+(?:vw|calc\([^;]+vw)/);
  assert.match(css, /max-height:\s*min\([^;]+vh/);
  assert.match(css, /min-width:\s*0/);
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

test('theme 变更即时预览解析后的主题且不再写 localStorage', () => {
  const h = load();
  h.ctx.SettingsUI.receive('workspace:settings-global', { settings: GLOBAL_SETTINGS });
  const theme = findBySetting(h.els['settings-panel'], 'theme');
  theme.value = 'system';
  theme.onchange();
  assert.equal(h.docElement.dataset.theme, 'dark', '无 SettingsApply 时 system 安全回退暗色');
  assert.equal(h.storage.has('glancemd-ultra-theme'), false, '主题事实源迁移到 settings.json');
  theme.value = 'light';
  theme.onchange();
  assert.equal(h.docElement.dataset.theme, 'light');
  assert.equal(h.storage.has('glancemd-ultra-theme'), false);
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

/* ── 快捷键专用设置 UI ── */

const KEYBINDINGS_JS = path.join(__dirname, 'keybindings.js');

// 同一 vm 内先装载 keybindings.js（命令实际生效的一方）与 commands.js（命令
// 中文标签的数据源，kbLabel 用），再装载 settings.js。
function loadKb() {
  const h = load();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'context-keys.js'), 'utf8'), h.ctx, { filename: 'context-keys.js' });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'when-clause.js'), 'utf8'), h.ctx, { filename: 'when-clause.js' });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'keybinding-parser.js'), 'utf8'), h.ctx, { filename: 'keybinding-parser.js' });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'default-keybindings.js'), 'utf8'), h.ctx, { filename: 'default-keybindings.js' });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'keybinding-service.js'), 'utf8'), h.ctx, { filename: 'keybinding-service.js' });
  vm.runInNewContext(fs.readFileSync(KEYBINDINGS_JS, 'utf8'), h.ctx, { filename: 'keybindings.js' });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8'), h.ctx, { filename: 'commands.js' });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'keybindings-settings.js'), 'utf8'), h.ctx, { filename: 'keybindings-settings.js' });
  return h;
}

function openKb(h) {
  h.ctx.SettingsUI.open();
  const panel = h.els['settings-panel'];
  panel.querySelector('#settings-categories').children[5].onclick(); // 快捷键
  return panel;
}

function savedKb(h) {
  return JSON.parse(h.storage.get('glancemd-ultra-keybindings') || '{}');
}

function fireRecordKey(h, key, mods) {
  // startKbRecording 注册 capture keydown；harness 的 removeEventListener 是
  // no-op，监听会累积，但 state.kbRecording 门控保证只有活动录制生效——
  // 取最后注册的处理器触发即可。
  const hs = h.docHandlers.keydown;
  hs[hs.length - 1](Object.assign({ key, preventDefault() {}, stopPropagation() {} }, mods || {}));
}

test('快捷键列表：挂载 KeybindingsSettings 组件并渲染方案选择与表格', () => {
  const h = loadKb();
  const panel = openKb(h);
  assert.ok(panel.querySelector('.keybindings-settings-root'), '已挂载快捷键设置组件');
  assert.ok(panel.querySelector('#kb-scheme-select'), '有方案选择器');
  assert.ok(panel.querySelector('#kb-search-input'), '有搜索输入框');
  assert.ok(panel.querySelectorAll('.kb-row').length >= 10, '至少渲染 10 行命令');
});

test('修改录制：新组合键写入覆盖表并同步到 BindingService', () => {
  const h = loadKb();
  const panel = openKb(h);
  h.ctx.KeybindingsSettings.openRecorder('file.open');
  h.ctx.KeybindingsSettings.saveBinding('file.open', 'Ctrl+Alt+K', 'global');
  assert.equal(h.ctx.Keybindings.effective()['file.open'], 'Ctrl+Alt+K');
});

test('快捷键重置：单项 reset 与恢复方案默认', () => {
  const h = loadKb();
  const panel = openKb(h);
  h.ctx.KeybindingsSettings.saveBinding('file.open', 'Alt+O', 'global');
  assert.equal(h.ctx.Keybindings.effective()['file.open'], 'Alt+O');
  h.ctx.KeybindingsSettings.reset('file.open');
  assert.equal(h.ctx.Keybindings.effective()['file.open'], 'Ctrl+Alt+O');
});

/* ── 终端特例控件测试 ── */

test('终端特例控件：扫描中显示扫描态，扫描完成后渲染自动+自定义选项，打开面板触发 scan 命令', () => {
  const h = load();
  const msgs = [];
  h.ctx.ipc = { postMessage: (m) => msgs.push(JSON.parse(m)) };
  h.ctx.SettingsUI.open();
  const scanMsg = msgs.find((m) => m.command === 'workspace.terminal.scan');
  assert.ok(scanMsg, '打开面板应触发 workspace.terminal.scan');

  const panel = h.els['settings-panel'];
  panel.querySelector('#settings-categories').children[1].onclick(); // 文件
  const termSelect = panel.querySelector('#setting-terminal-select');
  assert.ok(termSelect, '终端选择器存在');
  assert.equal(termSelect.tagName, 'select');
  assert.equal(termSelect.disabled, true, '扫描中 select 应为禁用态');
  const scanningOpts = termSelect.children.filter((c) => c.tagName === 'option');
  assert.ok(scanningOpts.some((o) => o.textContent.includes('正在扫描')));

  // 扫描完成回执（空列表）
  h.ctx.SettingsUI.receive('workspace:terminal-list', { terminals: [] });
  const termSelectAfter = panel.querySelector('#setting-terminal-select');
  assert.equal(termSelectAfter.disabled, false);
  const opts = termSelectAfter.children.filter((c) => c.tagName === 'option');
  assert.ok(opts.some((o) => o.value === '' && o.textContent.includes('自动')));
  assert.ok(opts.some((o) => o.value === '__custom__' && o.textContent.includes('自定义')));
});

test('终端特例控件：workspace:terminal-list 回执原地刷新列表并保留当前值', () => {
  const h = load();
  h.ctx.SettingsUI.open();
  h.ctx.SettingsUI.receive('workspace:settings-global', {
    settings: Object.assign({}, GLOBAL_SETTINGS, {
      files: Object.assign({}, GLOBAL_SETTINGS.files, { terminalPath: 'C:/Git/bin/bash.exe' }),
    }),
  });
  const panel = h.els['settings-panel'];
  panel.querySelector('#settings-categories').children[1].onclick(); // 文件

  // 发送扫描结果（含当前选中的 bash.exe 与未选中的 powershell）
  h.ctx.SettingsUI.receive('workspace:terminal-list', {
    terminals: [
      { id: 'powershell', name: 'PowerShell', path: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' },
      { id: 'git-bash', name: 'Git Bash', path: 'C:/Git/bin/bash.exe' },
    ],
  });

  const termSelect = panel.querySelector('#setting-terminal-select');
  assert.equal(termSelect.value, 'C:/Git/bin/bash.exe', '应保留当前选中的 Git Bash');
  const opts = termSelect.children.filter((c) => c.tagName === 'option');
  assert.equal(opts.length, 4, '自动 + 2 个扫描终端 + 自定义');
  const bashOpt = opts.find((o) => o.value === 'C:/Git/bin/bash.exe');
  assert.ok(bashOpt);
  assert.equal(bashOpt.textContent, 'Git Bash');
  assert.equal(bashOpt.dataset.subtext, 'C:/Git/bin/bash.exe');
});

test('终端特例控件：选自定义出现输入框并正确提交 terminalPath 与 terminalArgs', () => {
  const h = load();
  const msgs = [];
  h.ctx.ipc = { postMessage: (m) => msgs.push(JSON.parse(m)) };
  h.ctx.SettingsUI.open();
  h.ctx.SettingsUI.receive('workspace:settings-global', { settings: GLOBAL_SETTINGS });
  const panel = h.els['settings-panel'];
  panel.querySelector('#settings-categories').children[1].onclick(); // 文件

  const termSelect = panel.querySelector('#setting-terminal-select');
  termSelect.value = '__custom__';
  termSelect.onchange();

  const customInput = panel.querySelector('#setting-terminal-custom-path');
  assert.ok(customInput, '选择自定义后应出现路径输入框');
  const argsInput = panel.querySelector('#setting-terminal-args');
  assert.ok(argsInput, '选择自定义后应出现参数输入框');

  customInput.value = 'D:/Tools/alacritty.exe';
  customInput.onchange();

  const lastMsg = msgs[msgs.length - 1];
  assert.equal(lastMsg.command, 'workspace.settings.set-global');
  const parsed = JSON.parse(lastMsg.data);
  assert.equal(parsed.files.terminalPath, 'D:/Tools/alacritty.exe');

  argsInput.value = '--working-directory {dir}';
  argsInput.onchange();

  const lastMsg2 = msgs[msgs.length - 1];
  const parsed2 = JSON.parse(lastMsg2.data);
  assert.equal(parsed2.files.terminalArgs, '--working-directory {dir}');
});

test('终端特例控件：当前值不在扫描列表中时自动追加“当前值”兜底', () => {
  const h = load();
  h.ctx.SettingsUI.open();
  h.ctx.SettingsUI.receive('workspace:settings-global', {
    settings: Object.assign({}, GLOBAL_SETTINGS, {
      files: Object.assign({}, GLOBAL_SETTINGS.files, { terminalPath: '/usr/local/bin/custom-term' }),
    }),
  });
  h.ctx.SettingsUI.receive('workspace:terminal-list', {
    terminals: [{ id: 'cmd', name: 'Command Prompt', path: 'cmd.exe' }],
  });
  const panel = h.els['settings-panel'];
  panel.querySelector('#settings-categories').children[1].onclick(); // 文件
  const termSelect = panel.querySelector('#setting-terminal-select');
  assert.equal(termSelect.value, '/usr/local/bin/custom-term');
  const opts = termSelect.children.filter((c) => c.tagName === 'option');
  const customCurrent = opts.find((o) => o.value === '/usr/local/bin/custom-term');
  assert.ok(customCurrent, '应包含当前值兜底项');
  assert.match(customCurrent.textContent, /当前值/);
});
