/* 零依赖冒烟套件：node:test + node:vm，stub 风格照 src/frontend/preview.test.js。
 *
 * 覆盖三组内容（全部不依赖真实浏览器）：
 * 1. tabs.js：tab 创建/激活切换/dirty 标记/关闭/同路径复用；
 *    为贴近真实加载顺序，tabs.js 与 app.js 在同一 vm 上下文中按页面顺序加载，
 *    由 app.js 提供 sendToRust/toggleMode/setTitle 等全局（与浏览器一致）。
 * 2. app.js：主题切换函数（light/dark 往返 + localStorage 键名）与 IPC 事件桥。
 * 3. 组装页完整性：tools/build_test_page.py 产出的 tests/.tmp/index.html
 *    包含全部 6 个产品脚本与 CSS、mock 引导脚本先于产品脚本、无残留占位符
 *    （纯字符串断言）。
 *
 * 运行：node --test tests/smoke.test.js
 *
 * 已知裁剪：editor.js/preview.js/highlight/marked 未装入 vm（marked 以 stub 代替，
 * resolveLocalImages 以空函数代替）；因此不覆盖预览渲染与编辑器输入细节，
 * 这些路径由 Playwright 端到端冒烟（tests/e2e/）兜底。
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND = path.join(ROOT, 'src', 'frontend');

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
      element.children.push(child);
      return child;
    },
    insertBefore(node, ref) {
      const current = element.children.indexOf(node);
      if (current !== -1) element.children.splice(current, 1);
      const idx = ref ? element.children.indexOf(ref) : -1;
      element.children.splice(idx === -1 ? element.children.length : idx, 0, node);
      return node;
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
    getBoundingClientRect() {
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    },
    closest() {
      return null;
    },
    focus() {},
  };
  // innerHTML 赋值在真实 DOM 中会重建子节点：至少要清空 children，
  // 否则 renderTabBar() 每次 `bar.innerHTML = ''` 后元素会无限累积
  let innerHTMLValue = '';
  Object.defineProperty(element, 'innerHTML', {
    get: () => innerHTMLValue,
    set: (value) => {
      innerHTMLValue = String(value);
      element.children.length = 0;
    },
  });
  return element;
}

function createHarness() {
  const ids = {};
  const docHandlers = {};
  const ipcMessages = [];
  const storage = new Map();
  const byId = (id) => (ids[id] = ids[id] || createElement('div'));

  const documentElement = createElement('html');
  documentElement.style.setProperty = (name, value) => {
    documentElement.style[name] = String(value);
  };
  documentElement.style.getPropertyValue = (name) => documentElement.style[name] || '';
  const body = createElement('body');
  body.dataset.platform = 'windows';

  const context = {
    console,
    confirm: () => true,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    marked: { parse: (md) => '<p>' + md + '</p>', use() {}, setOptions() {} },
    hljs: {},
    resolveLocalImages() {},
    setTimeout() {
      return 0;
    },
    clearTimeout() {},
    document: {
      createElement,
      body,
      documentElement,
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
    navigator: { platform: 'win32' },
  };
  context.window = {
    addEventListener() {},
    getSelection() {
      return { toString: () => '' };
    },
    ipc: {
      postMessage(msg) {
        ipcMessages.push(msg);
      },
    },
  };
  context.window.window = context.window;

  // 与组装页一致的加载顺序（略过 highlight/marked/preview：marked 以 stub 代替）
  vm.runInNewContext(fs.readFileSync(path.join(FRONTEND, 'tabs.js'), 'utf8'), context, { filename: 'tabs.js' });
  vm.runInNewContext(fs.readFileSync(path.join(FRONTEND, 'app.js'), 'utf8'), context, { filename: 'app.js' });

  return {
    context,
    ipcMessages,
    storage,
    byId,
    documentElement,
    parseIpc() {
      return ipcMessages.map((m) => JSON.parse(m));
    },
    fireDOMContentLoaded() {
      (docHandlers.DOMContentLoaded || []).forEach((handler) => handler({ type: 'DOMContentLoaded' }));
    },
    clickButton(id) {
      const el = byId(id);
      assert.ok(el.listeners.click, '按钮 #' + id + ' 未绑定 click 监听');
      el.listeners.click.forEach((handler) => handler({ stopPropagation() {}, preventDefault() {}, button: 0 }));
    },
  };
}

/* ── 组装页完整性 ── */

function escapeForScriptTag(js) {
  // 与 main.rs::escape_for_script_tag / build_test_page.py 同规则
  return js.replace(/<\/script/g, '<\\/script');
}

function loadAssembledPage() {
  const pagePath = path.join(ROOT, 'tests', '.tmp', 'index.html');
  for (const python of ['python', 'py']) {
    try {
      execFileSync(python, [path.join(ROOT, 'tools', 'build_test_page.py')], { cwd: ROOT, stdio: 'pipe' });
      break;
    } catch {
      /* python 不可用时退回既有产物；产物也不存在则由用例自行 skip */
    }
  }
  return fs.existsSync(pagePath) ? fs.readFileSync(pagePath, 'utf8') : null;
}

const assembledPage = loadAssembledPage();

test('组装页包含全部 8 个产品脚本且顺序与 build_html 一致', (t) => {
  if (!assembledPage) return t.skip('tests/.tmp/index.html 不存在且无法生成（需 Python）');
  const names = ['highlight.min.js', 'marked.min.js', 'preview.js', 'tabs.js', 'editor.js', 'app.js', 'commands.js', 'workspace.js'];
  const positions = names.map((name) => {
    const source = fs.readFileSync(path.join(FRONTEND, name), 'utf8');
    const pos = assembledPage.indexOf(escapeForScriptTag(source));
    assert.ok(pos !== -1, '组装页缺少脚本：' + name);
    return pos;
  });
  const sorted = [...positions].sort((a, b) => a - b);
  assert.deepEqual(positions, sorted, '产品脚本顺序与 build_html 不一致');
});

test('组装页 CSS 注入完整、平台标记正确且无残留占位符', (t) => {
  if (!assembledPage) return t.skip('tests/.tmp/index.html 不存在且无法生成（需 Python）');
  const styleCss = fs.readFileSync(path.join(FRONTEND, 'style.css'), 'utf8');
  assert.ok(assembledPage.includes(styleCss), 'style.css 未完整注入');
  assert.ok(assembledPage.includes('<body data-platform="windows">'), '缺少平台标记');
  assert.equal(assembledPage.includes('/* __CSS__ */'), false, 'CSS 占位符未被替换');
  assert.equal(assembledPage.includes('<!-- __SCRIPTS__ -->'), false, '脚本占位符未被替换');
});

test('mock 引导脚本先于全部产品脚本注入', (t) => {
  if (!assembledPage) return t.skip('tests/.tmp/index.html 不存在且无法生成（需 Python）');
  const mock = fs.readFileSync(path.join(ROOT, 'tests', 'mock-bootstrap.js'), 'utf8');
  const mockPos = assembledPage.indexOf(escapeForScriptTag(mock));
  assert.ok(mockPos !== -1, 'mock 引导脚本未注入');
  const firstProduct = assembledPage.indexOf(
    escapeForScriptTag(fs.readFileSync(path.join(FRONTEND, 'highlight.min.js'), 'utf8')),
  );
  assert.ok(mockPos < firstProduct, 'mock 引导脚本必须先于产品脚本执行');
  // 至少 7 个内联脚本：1 mock + 6 产品（minified 库内部可能自带 <script> 字符串）
  assert.ok(assembledPage.split('<script>').length - 1 >= 7);
  // 转义规则生效：JS 源里的 </script 不会提前闭合标签
  assert.equal(assembledPage.includes('</script>\n<script>'), true); // 标签边界正常
});

/* ── tabs.js 冒烟 ── */

test('初始化：创建 Untitled tab 并向 Rust 发送 ready', () => {
  const h = createHarness();
  h.fireDOMContentLoaded();
  const active = h.context.TabManager.getActiveTab();
  assert.ok(active, '初始化后应有活动 tab');
  assert.equal(active.filename, 'Untitled');
  assert.equal(active.mode, 'edit');
  assert.equal(active.dirty, false);
  const commands = h.parseIpc().map((m) => m.command);
  assert.ok(commands.includes('ready'), '应发送 ready 命令');
  assert.ok(commands.includes('set_title'), '应同步窗口标题');
});

test('创建路径 tab：空 Untitled 被复用、路径归一、进入预览模式', () => {
  const h = createHarness();
  h.fireDOMContentLoaded();
  const initial = h.context.TabManager.getActiveTab();
  const tab = h.context.TabManager.createTab('D:\\docs\\readme.md', '# Hello');
  assert.equal(tab, initial, '打开文件应复用空 Untitled tab');
  assert.equal(tab.path, 'D:/docs/readme.md', '路径反斜杠应归一为斜杠');
  assert.equal(tab.filename, 'readme.md');
  assert.equal(tab.mode, 'preview');
  assert.equal(h.context.TabManager.getActiveTab(), tab);

  // 再打开另一个路径：新建第二个 tab
  const second = h.context.TabManager.createTab('D:/docs/other.md', 'Other');
  assert.notEqual(second.id, tab.id);
  assert.equal(h.context.TabManager.getActiveTab(), second);

  // toggleMode 生效：状态栏切到 PREVIEW，容器 active 类随模式移动
  assert.equal(h.byId('status-mode').textContent, 'PREVIEW');
  assert.equal(h.byId('editor-container').classList.contains('active'), false);
  assert.equal(h.byId('preview-container').classList.contains('active'), true);
});

test('tab 激活切换：编辑内容随 tab 保存与恢复', () => {
  const h = createHarness();
  h.fireDOMContentLoaded();
  const first = h.context.TabManager.createTab(null, 'first content');
  const second = h.context.TabManager.createTab(null, 'second content');
  assert.equal(h.context.TabManager.getActiveTab(), second);
  assert.equal(h.byId('editor').value, 'second content');

  h.context.TabManager.switchTab(first.id);
  assert.equal(h.context.TabManager.getActiveTab(), first);
  assert.equal(h.byId('editor').value, 'first content', '切回应恢复该 tab 内容');

  // 渲染出的 tab 元素：Untitled + 2 个 tab，active 类在当前 tab 上；
  // 点击 second 的元素可切换回它并恢复其内容
  const bar = h.byId('tab-bar');
  assert.equal(bar.children.length, 3, 'Untitled + 2 个 tab');
  const firstElement = bar.children.find((el) => Number(el.dataset.tabId) === first.id);
  assert.equal(firstElement.className.includes('active'), true);
  const secondElement = bar.children.find((el) => Number(el.dataset.tabId) === second.id);
  secondElement.listeners.click.forEach((handler) => handler({}));
  assert.equal(h.context.TabManager.getActiveTab(), second);
  assert.equal(h.byId('editor').value, 'second content', '点击 tab 元素切回后内容恢复');
});

test('dirty 标记：驱动 set_dirty_state、标题星号与 tab 圆点', () => {
  const h = createHarness();
  h.fireDOMContentLoaded();
  h.context.TabManager.markDirty();
  const active = h.context.TabManager.getActiveTab();
  assert.equal(active.dirty, true);
  assert.equal(h.context.TabManager.hasAnyDirty(), true);

  const dirtyMsg = h.parseIpc().filter((m) => m.command === 'set_dirty_state').pop();
  assert.deepEqual(dirtyMsg, { command: 'set_dirty_state', dirty: true });
  const titleMsg = h.parseIpc().filter((m) => m.command === 'set_title').pop();
  assert.match(titleMsg.title, /\*$/, 'dirty 标题应以 * 结尾');

  const bar = h.byId('tab-bar');
  assert.ok(
    bar.children[0].children.some((c) => c.className === 'tab-dirty'),
    'dirty tab 应渲染圆点标记',
  );

  h.context.TabManager.markClean();
  assert.equal(h.context.TabManager.hasAnyDirty(), false);
  const cleanMsg = h.parseIpc().filter((m) => m.command === 'set_dirty_state').pop();
  assert.deepEqual(cleanMsg, { command: 'set_dirty_state', dirty: false });
});

test('同一路径重复打开复用既有 tab（分隔符与大小写归一）', () => {
  const h = createHarness();
  h.fireDOMContentLoaded();
  h.context.TabManager.createTab(null, '占位'); // 让空 Untitled 不拦截
  const a = h.context.TabManager.createTab('D:/docs/a.md', 'A');
  const again = h.context.TabManager.createTab('D:\\DOCS\\a.md', 'A2');
  assert.equal(again, a, '同一路径应复用既有 tab');
  assert.equal(a.content, 'A', '复用不应覆盖原内容');
});

test('关闭当前 tab 自动切换相邻 tab；关闭未保存 tab 需确认', () => {
  const h = createHarness();
  h.fireDOMContentLoaded();
  const a = h.context.TabManager.createTab(null, 'A');
  const b = h.context.TabManager.createTab(null, 'B');
  h.context.TabManager.closeTab(b.id);
  assert.equal(h.context.TabManager.getActiveTab().id, a.id, '应自动切到相邻 tab');

  h.context.TabManager.markDirty(a.id);
  h.context.confirm = () => false;
  h.context.TabManager.closeTab(a.id);
  assert.equal(h.context.TabManager.getActiveTab().id, a.id, '取消确认则 tab 保留');

  h.context.confirm = () => true;
  h.context.TabManager.closeTab(a.id);
  const active = h.context.TabManager.getActiveTab();
  assert.equal(active.filename, 'Untitled', '最后一个 tab 关闭后回到 Untitled');
  assert.equal(active.mode, 'edit');
});

/* ── app.js 冒烟 ── */

test('主题切换：light/dark 往返并写入 localStorage', () => {
  const h = createHarness();
  h.fireDOMContentLoaded();
  assert.equal(h.documentElement.getAttribute('data-theme'), 'light', '默认 light');

  h.clickButton('btn-theme');
  assert.equal(h.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(h.byId('icon-sun').style.display, 'none');
  assert.equal(h.byId('icon-moon').style.display, '');

  h.clickButton('btn-theme');
  assert.equal(h.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(h.byId('icon-sun').style.display, '');
  assert.equal(h.byId('icon-moon').style.display, 'none');

  // localStorage 键名：兼容当前 'glancemd-theme' 与阶段 0 身份重命名后的
  // 'glancemd-ultra-theme'（前缀由 A1 流统一替换，避免本套件误报）
  const themeKeys = [...h.storage.keys()].filter((k) => /^glancemd(-ultra)?-theme$/.test(k));
  assert.equal(themeKeys.length, 1, '主题键应恰好写入一个');
  assert.equal(h.storage.get(themeKeys[0]), 'light');
});

test('初始化恢复已保存的主题偏好', () => {
  const h = createHarness();
  // 预置新旧两种键名，无论产品当前使用哪种前缀都能命中
  h.storage.set('glancemd-theme', 'dark');
  h.storage.set('glancemd-ultra-theme', 'dark');
  h.fireDOMContentLoaded();
  assert.equal(h.documentElement.getAttribute('data-theme'), 'dark');
});

test('IPC 事件桥：file_opened 建 tab 并记录最近文件，error 显示状态栏', () => {
  const h = createHarness();
  h.fireDOMContentLoaded();
  h.context.window.__fromRust('file_opened', { path: 'D:/docs/guide.md', content: '# Guide' });
  const active = h.context.TabManager.getActiveTab();
  assert.equal(active.filename, 'guide.md');
  assert.equal(active.mode, 'preview');

  const recentKey = [...h.storage.keys()].find((k) => /^glancemd(-ultra)?-recent$/.test(k));
  assert.ok(recentKey, '应写入最近文件记录');
  const recent = JSON.parse(h.storage.get(recentKey));
  assert.equal(recent[0].path, 'D:/docs/guide.md');

  h.context.window.__fromRust('error', { message: '磁盘已满' });
  assert.equal(h.byId('status-info').textContent, 'Error: 磁盘已满');
});
