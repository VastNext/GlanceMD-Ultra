const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

/* ════════════════════ 最小 DOM stub ════════════════════
   比 smoke.test.js 的 createElement 更完整：需要 children 树、
   parentNode/nextSibling 遍历、classList 与 className 双向同步、
   innerHTML 赋值清空子节点（renderTabBar/树重建依赖）。 */

function detach(el) {
  if (el.parentNode) {
    const i = el.parentNode.children.indexOf(el);
    if (i !== -1) el.parentNode.children.splice(i, 1);
    el.parentNode = null;
  }
}

function makeEl(tag, id) {
  const el = {
    tagName: tag,
    id: id || '',
    children: [],
    parentNode: null,
    listeners: {},
    dataset: {},
    attributes: {},
    style: {},
    textContent: '',
    value: '',
    title: '',
    type: '',
    focused: false,
    scrolled: null,
    appendChild(child) {
      detach(child);
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    insertBefore(node, ref) {
      detach(node);
      const idx = ref ? el.children.indexOf(ref) : -1;
      if (idx === -1) el.children.push(node);
      else el.children.splice(idx, 0, node);
      node.parentNode = el;
      return node;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i !== -1) el.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, handler) {
      (el.listeners[type] = el.listeners[type] || []).push(handler);
    },
    removeEventListener() {},
    setAttribute(name, value) {
      el.attributes[name] = String(value);
    },
    getAttribute(name) {
      return name in el.attributes ? el.attributes[name] : null;
    },
    contains(other) {
      let n = other;
      while (n) {
        if (n === el) return true;
        n = n.parentNode;
      }
      return false;
    },
    focus() { el.focused = true; },
    select() { el.selected = true; },
    scrollIntoView(opts) { el.scrolled = opts || true; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() {
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    },
  };
  // className ↔ classList 双向（模块用属性赋值设类、用 classList 判定/切换）
  const classes = new Set();
  Object.defineProperty(el, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => {
      classes.clear();
      String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
  });
  el.classList = {
    add: (...cs) => cs.forEach((c) => classes.add(c)),
    remove: (...cs) => cs.forEach((c) => classes.delete(c)),
    toggle(name, force) {
      const on = force === undefined ? !classes.has(name) : Boolean(force);
      if (on) classes.add(name);
      else classes.delete(name);
      return on;
    },
    contains: (name) => classes.has(name),
  };
  // innerHTML 赋值 = 重建子节点（至少清空；svg 字符串仅存取不断言内容）
  let innerHTMLValue = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => innerHTMLValue,
    set: (v) => {
      innerHTMLValue = String(v);
      el.children.length = 0;
    },
  });
  return el;
}

/* ════════════════════ 装载工具 ════════════════════ */

function makeCommands() {
  const registry = {};
  return {
    registry,
    register(id, def) {
      if (Object.prototype.hasOwnProperty.call(registry, id)) {
        throw new Error('[Commands] 命令重复注册: ' + id);
      }
      registry[id] = def;
      return id;
    },
    has: (id) => Object.prototype.hasOwnProperty.call(registry, id),
    get: (id) => registry[id] || null,
    ids: () => Object.keys(registry),
    run(id, arg) {
      const cmd = registry[id];
      if (!cmd) throw new Error('[Commands] 未知命令: ' + id);
      return cmd.run(arg);
    },
  };
}

function loadTree({ rootPath = null, lsExpanded = null, withClipboard = true } = {}) {
  const ids = {};
  const docHandlers = {};
  const ipcMessages = [];
  const storage = new Map();
  const dispatched = [];
  const observers = [];
  const clipboardWrites = [];
  const confirmCalls = [];
  let confirmResult = true;
  const execCalls = [];

  const commands = makeCommands();

  if (lsExpanded !== null) storage.set('glancemd-ultra-tree-expanded', JSON.stringify(lsExpanded));

  // 面板骨架（index.html 静态结构的最小复刻）
  const head = makeEl('div', null);
  head.className = 'panel-head';
  const title = makeEl('span', null);
  title.className = 'panel-title';
  head.appendChild(title);
  const collapseBtn = makeEl('button', 'panel-tree-collapse');
  collapseBtn.className = 'panel-btn';
  head.appendChild(collapseBtn);

  const panel = makeEl('aside', 'panel-tree');
  panel.className = 'workspace-panel';
  panel.appendChild(head);

  const rootEl = makeEl('div', 'project-tree-root');
  rootEl.className = 'panel-body';
  const placeholder = makeEl('p', null);
  placeholder.className = 'panel-empty';
  placeholder.textContent = '尚未打开项目';
  rootEl.appendChild(placeholder);

  const tabBar = makeEl('div', 'tab-bar');

  ids['panel-tree'] = panel;
  ids['panel-tree-collapse'] = collapseBtn;
  ids['project-tree-root'] = rootEl;
  ids['tab-bar'] = tabBar;

  const body = makeEl('body', null);

  const wsHandlers = {};
  const localStorageMock = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  const context = {
    console,
    navigator: withClipboard
      ? { clipboard: { writeText(text) { clipboardWrites.push(text); return Promise.resolve(); } } }
      : {},
    confirm(msg) {
      confirmCalls.push(msg);
      return confirmResult;
    },
    localStorage: localStorageMock,
    document: {
      body,
      createElement: (tag) => makeEl(tag),
      getElementById: (id) => (id in ids ? ids[id] : null),
      addEventListener(type, handler) {
        (docHandlers[type] = docHandlers[type] || []).push(handler);
      },
      removeEventListener() {},
      execCommand(cmd) {
        execCalls.push(cmd);
        return true;
      },
    },
    MutationObserver: function(cb) {
      this._cb = cb;
      this._target = null;
      observers.push(this);
      this.observe = (target) => { this._target = target; };
      this.disconnect = () => {};
    },
  };
  context.window = {
    innerWidth: 400,
    innerHeight: 300,
    ipc: {
      postMessage(msg) {
        ipcMessages.push(JSON.parse(msg));
      },
    },
    Commands: commands,
    // 模块只经 window.* 访问：localStorage / confirm 必须挂 window
    localStorage: localStorageMock,
    confirm(msg) {
      confirmCalls.push(msg);
      return confirmResult;
    },
    CustomEvent: function(type, opts) {
      this.type = type;
      this.detail = opts && opts.detail;
    },
    dispatchEvent(ev) {
      dispatched.push(ev);
    },
    Workspace: {
      on(event, handler) {
        (wsHandlers[event] = wsHandlers[event] || []).push(handler);
        return function() {};
      },
      off() {},
      dispatch(event, data) {
        (wsHandlers[event] || []).forEach((fn) => fn(data));
      },
      getState() {
        return { root: rootPath, fileCount: null, error: null };
      },
    },
  };
  context.window.window = context.window;

  const source = fs.readFileSync(path.join(__dirname, 'project-tree.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'project-tree.js' });

  const projectTree = context.window.ProjectTree;
  const tree = rootEl.children.find((el) => el.classList && el.classList.contains('tree'));

  const h = {
    context,
    commands,
    projectTree,
    tree,
    rootEl,
    body,
    head,
    ipcMessages,
    storage,
    dispatched,
    observers,
    clipboardWrites,
    confirmCalls,
    execCalls,
    docHandlers,
    tabBar,
    commandsIds: () => [...commands.ids()],
    setConfirm(result) { confirmResult = result; },

    fire(event, data) {
      (wsHandlers[event] || []).forEach((fn) => fn(data));
    },
    open(root) {
      h.fire('workspace:opened', { root: root || 'G:/proj', file_count: 0 });
    },
    // entries: [{name, rel, kind}]；kind 可传原始大小写形式验证归一
    listed(relDir, entries, useRelPath) {
      h.fire('workspace:tree-listed', {
        relDir,
        entries: entries.map((e) =>
          useRelPath
            ? { name: e.name, relPath: e.rel, kind: e.kind }
            : { name: e.name, rel_path: e.rel, kind: e.kind }
        ),
      });
    },
    findRow(rel) {
      return tree.children.find((el) => el.dataset && el.dataset.rel === rel) || null;
    },
    rows() {
      return tree.children.filter(
        (el) => el.classList && el.classList.contains('tree-row') && !el.classList.contains('tree-create-row')
      );
    },
    clickRow(rel, opts) {
      const row = h.findRow(rel);
      assert.ok(row, '点击目标行不存在: ' + rel);
      h.fireTree('click', Object.assign({ target: row }, opts || {}));
    },
    fireTree(type, ev) {
      assert.ok(tree.listeners[type], '树容器未绑定 ' + type + ' 监听');
      const event = Object.assign(
        { preventDefault() {}, stopPropagation() {} },
        ev
      );
      tree.listeners[type].forEach((fn) => fn(event));
    },
    key(key, opts) {
      h.fireTree('keydown', Object.assign({ key }, opts || {}));
    },
    contextOn(rel, pos) {
      const row = rel === null ? null : h.findRow(rel);
      h.fireTree('contextmenu', Object.assign({ target: row, clientX: 10, clientY: 10 }, pos || {}));
    },
    menu() {
      return body.children.find((el) => el.classList && el.classList.contains('ctx-menu')) || null;
    },
    menuItem(action) {
      const menu = h.menu();
      if (!menu) return null;
      return menu.children.find((el) => el.dataset && el.dataset.action === action) || null;
    },
    clickItem(action) {
      const item = h.menuItem(action);
      assert.ok(item, '菜单项不存在: ' + action);
      item.listeners.click.forEach((fn) => fn({ preventDefault() {}, stopPropagation() {} }));
    },
    byCommand(cmd) {
      return ipcMessages.filter((m) => m.command === cmd);
    },
    setTabs(path) {
      context.window.TabManager = { getActiveTab: () => (path ? { path, filename: 'x' } : { path: null }) };
      h.observers.forEach((o) => o._cb());
    },
  };

  if (rootPath !== null) h.open(rootPath);
  return h;
}

/* ════════════════════ 用例 ════════════════════ */

test('挂载接管面板主体：清空占位并创建可聚焦树容器', () => {
  const h = loadTree();
  assert.equal(h.rootEl.children[0].className, 'panel-empty');
  assert.equal(h.rootEl.children[0].textContent, '尚未打开项目');
  assert.ok(h.tree, '应创建 .tree 容器');
  assert.equal(h.tree.getAttribute('tabindex'), '0');
  assert.equal(h.tree.getAttribute('role'), 'tree');
  assert.equal(h.tree.children.length, 0, '未打开项目时无行');
});

test('workspace:opened 渲染根节点并请求根目录列表', () => {
  const h = loadTree();
  h.open('G:/proj/我的笔记库');
  const rootRow = h.findRow('');
  assert.ok(rootRow, '根行应渲染');
  assert.equal(rootRow.dataset.kind, 'dir');
  const nm = rootRow.children.find((c) => c.classList.contains('nm'));
  assert.equal(nm.textContent, '我的笔记库');
  assert.equal(rootRow.children.find((c) => c.classList.contains('chev')).className, 'chev open');
  const lists = h.byCommand('workspace.tree.list');
  assert.deepEqual(lists, [{ command: 'workspace.tree.list', path: '' }]);
  // 空态提示已移除
  assert.ok(!h.rootEl.children.some((c) => c.classList.contains('panel-empty')));
});

test('tree-listed 渲染条目：图标语义、chev 状态、顺序保持，兼容 relPath/SymLinkFile 拼写', () => {
  const h = loadTree();
  h.open();
  h.listed('', [
    { name: 'docs', rel: 'docs', kind: 'dir' },
    { name: 'a.md', rel: 'a.md', kind: 'File' },
    { name: 'link.md', rel: 'link.md', kind: 'SymLinkFile' },
  ], true);
  const rows = h.rows();
  assert.deepEqual(rows.map((r) => r.dataset.rel), ['', 'docs', 'a.md', 'link.md']);
  assert.deepEqual(rows.map((r) => r.dataset.kind), ['dir', 'dir', 'file', 'symlink-file']);
  const icoOf = (rel) => h.findRow(rel).children.find((c) => c.classList.contains('f-ico')).className;
  assert.equal(icoOf('docs'), 'f-ico f-dir');
  assert.equal(icoOf('a.md'), 'f-ico f-file dim');
  assert.equal(icoOf('link.md'), 'f-ico f-symlink-file dim');
  const chevOf = (rel) => h.findRow(rel).children.find((c) => c.classList.contains('chev')).className;
  assert.equal(chevOf('docs'), 'chev closed');
  assert.equal(chevOf('a.md'), 'chev ghost');
  // 缩进走 token：depth1 = calc(8px + var(--tree-indent) * 1)
  assert.equal(h.findRow('docs').style.paddingLeft, 'calc(8px + var(--tree-indent) * 1)');
});

test('目录行点击展开：未加载时懒加载请求 tree.list', () => {
  const h = loadTree();
  h.open();
  h.listed('', [{ name: 'docs', rel: 'docs', kind: 'dir' }]);
  h.clickRow('docs');
  assert.ok([...h.projectTree.getState().expanded].includes('docs'), '展开集合应含 docs');
  assert.deepEqual(h.byCommand('workspace.tree.list'), [
    { command: 'workspace.tree.list', path: '' },
    { command: 'workspace.tree.list', path: 'docs' },
  ]);
});

test('懒加载去重：在途与已加载目录不重复请求', () => {
  const h = loadTree();
  h.open();
  h.listed('', [{ name: 'docs', rel: 'docs', kind: 'dir' }]);
  h.clickRow('docs'); // 展开并在途
  h.fire('workspace:file-changed', { path: 'G:/proj/docs/x.md', kind: 'content' }); // 强制刷新同目录
  const docsLists = h.byCommand('workspace.tree.list').filter((m) => m.path === 'docs');
  assert.equal(docsLists.length, 1, '在途请求期间不应重复上行');
  h.listed('docs', [{ name: 'x.md', rel: 'docs/x.md', kind: 'file' }]);
  h.clickRow('docs'); // 收起
  h.clickRow('docs'); // 再展开：已加载，走缓存
  const docsLists2 = h.byCommand('workspace.tree.list').filter((m) => m.path === 'docs');
  assert.equal(docsLists2.length, 1, '已加载目录再展开不应重新请求');
  assert.ok(h.findRow('docs/x.md'), '缓存渲染应重建子行');
});

test('收起移除子行、再展开恢复', () => {
  const h = loadTree();
  h.open();
  h.listed('', [{ name: 'docs', rel: 'docs', kind: 'dir' }]);
  h.clickRow('docs');
  h.listed('docs', [{ name: 'x.md', rel: 'docs/x.md', kind: 'file' }]);
  assert.ok(h.findRow('docs/x.md'));
  h.clickRow('docs'); // 收起
  assert.ok(!h.findRow('docs/x.md'), '收起后子行应移除');
  assert.equal(h.findRow('docs').children.find((c) => c.classList.contains('chev')).className, 'chev closed');
  h.clickRow('docs'); // 再展开
  assert.ok(h.findRow('docs/x.md'));
});

test('单击文件行：选中激活并经命令表发 open_file 绝对路径（Windows 反斜杠根归一）', () => {
  const h = loadTree({ rootPath: 'D:\\笔记库' });
  h.listed('', [
    { name: 'a.md', rel: 'a.md', kind: 'file' },
    { name: 'b.md', rel: 'b.md', kind: 'file' },
  ]);
  h.clickRow('a.md');
  assert.deepEqual([...h.projectTree.getState().selected], ['a.md']);
  assert.equal(h.projectTree.getState().active, 'a.md');
  assert.equal(h.findRow('a.md').classList.contains('st-active'), true);
  const opens = h.byCommand('open_file');
  assert.deepEqual(opens, [{ command: 'open_file', path: 'D:/笔记库/a.md' }]);
});

test('Ctrl+点击切换多选：st-selected 且多选时不渲染激活态', () => {
  const h = loadTree();
  h.open();
  h.listed('', [
    { name: 'a.md', rel: 'a.md', kind: 'file' },
    { name: 'b.md', rel: 'b.md', kind: 'file' },
  ]);
  h.clickRow('a.md');
  h.clickRow('b.md', { ctrlKey: true });
  assert.deepEqual([...h.projectTree.getState().selected].sort(), ['a.md', 'b.md']);
  assert.equal(h.findRow('a.md').classList.contains('st-selected'), true);
  assert.equal(h.findRow('b.md').classList.contains('st-selected'), true);
  assert.equal(h.findRow('a.md').classList.contains('st-active'), false, '多选时激活语义禁用');
  // 再次 Ctrl+点击取消
  h.clickRow('a.md', { ctrlKey: true });
  assert.deepEqual([...h.projectTree.getState().selected], ['b.md']);
});

test('Shift+点击范围多选', () => {
  const h = loadTree();
  h.open();
  h.listed('', [
    { name: 'a.md', rel: 'a.md', kind: 'file' },
    { name: 'b.md', rel: 'b.md', kind: 'file' },
    { name: 'c.md', rel: 'c.md', kind: 'file' },
  ]);
  h.clickRow('a.md');
  h.clickRow('c.md', { shiftKey: true });
  assert.deepEqual([...h.projectTree.getState().selected], ['a.md', 'b.md', 'c.md']);
});

test('键盘 ↑↓ 在可见行间移动高亮', () => {
  const h = loadTree();
  h.open();
  h.listed('', [{ name: 'docs', rel: 'docs', kind: 'dir' }]);
  h.listed('docs', [{ name: 'a.md', rel: 'docs/a.md', kind: 'file' }]);
  h.clickRow('docs'); // 展开并选中 docs
  h.key('ArrowDown');
  assert.equal(h.projectTree.getState().active, 'docs/a.md');
  h.key('ArrowUp');
  assert.equal(h.projectTree.getState().active, 'docs');
  h.key('ArrowUp');
  assert.equal(h.projectTree.getState().active, '');
  h.key('ArrowUp'); // 顶部钳制
  assert.equal(h.projectTree.getState().active, '');
  // 键盘移动不触发打开
  assert.equal(h.byCommand('open_file').length, 0);
});

test('键盘 → 展开未加载目录、← 收起并回落父行', () => {
  const h = loadTree();
  h.open();
  h.listed('', [{ name: 'docs', rel: 'docs', kind: 'dir' }]);
  h.key('ArrowDown'); // → 根
  h.key('ArrowDown'); // → docs
  assert.equal(h.projectTree.getState().active, 'docs');
  h.key('ArrowRight');
  assert.deepEqual(h.byCommand('workspace.tree.list').map((m) => m.path), ['', 'docs']);
  h.listed('docs', [{ name: 'a.md', rel: 'docs/a.md', kind: 'file' }]);
  h.key('ArrowDown'); // → docs/a.md
  h.key('ArrowLeft'); // 文件行回落父行
  assert.equal(h.projectTree.getState().active, 'docs');
  h.key('ArrowLeft'); // 展开中的目录收起
  assert.ok(!h.findRow('docs/a.md'));
});

test('Enter：目录切换展开，文件发打开命令', () => {
  const h = loadTree();
  h.open();
  h.listed('', [
    { name: 'docs', rel: 'docs', kind: 'dir' },
    { name: 'a.md', rel: 'a.md', kind: 'file' },
  ]);
  h.clickRow('docs'); // 选中 docs
  h.clickRow('docs'); // 再点收起（Enter 语义在键盘路径验证）
  h.key('ArrowDown');
  h.key('ArrowDown'); // 移到 a.md？可见行 = root, docs, a.md → 两次 ArrowDown 到 a.md
  assert.equal(h.projectTree.getState().active, 'a.md');
  h.key('Enter');
  assert.equal(h.byCommand('open_file').length, 1);
  h.key('ArrowUp');
  h.key('ArrowUp');
  h.key('ArrowDown'); // docs
  h.key('Enter'); // 展开
  assert.ok(h.byCommand('workspace.tree.list').some((m) => m.path === 'docs'));
});

test('F2 内联重命名：Enter 提交发 workspace.fs.rename，Esc/失焦取消', () => {
  const h = loadTree();
  h.open();
  h.listed('', [{ name: 'docs', rel: 'docs', kind: 'dir' }]);
  h.clickRow('docs');
  h.listed('docs', [{ name: 'a.md', rel: 'docs/a.md', kind: 'file' }]);
  h.clickRow('docs/a.md');
  h.key('F2');
  const row = h.findRow('docs/a.md');
  const input = row.children.find((c) => c.classList && c.classList.contains('tree-rename-input'));
  assert.ok(input, 'F2 后应出现行内输入框');
  input.value = 'b.md';
  input.listeners.keydown.forEach((fn) => fn({ key: 'Enter', preventDefault() {}, stopPropagation() {} }));
  assert.deepEqual(h.byCommand('workspace.fs.rename'), [
    { command: 'workspace.fs.rename', path: 'docs/a.md', new_name: 'b.md' },
  ]);
  assert.ok(!row.children.some((c) => c.classList && c.classList.contains('tree-rename-input')), '提交后输入框移除');

  // Esc 取消
  h.clickRow('docs/a.md');
  h.key('F2');
  const input2 = h.findRow('docs/a.md').children.find((c) => c.classList.contains('tree-rename-input'));
  input2.value = 'x.md';
  input2.listeners.keydown.forEach((fn) => fn({ key: 'Escape', preventDefault() {}, stopPropagation() {} }));
  assert.equal(h.byCommand('workspace.fs.rename').length, 1, 'Esc 取消不应发送');

  // 失焦取消
  h.clickRow('docs/a.md');
  h.key('F2');
  const input3 = h.findRow('docs/a.md').children.find((c) => c.classList.contains('tree-rename-input'));
  input3.value = 'y.md';
  input3.listeners.blur.forEach((fn) => fn({}));
  assert.equal(h.byCommand('workspace.fs.rename').length, 1, '失焦取消不应发送');
});

test('F2 在多选与根行上禁用', () => {
  const h = loadTree();
  h.open();
  h.listed('', [
    { name: 'a.md', rel: 'a.md', kind: 'file' },
    { name: 'b.md', rel: 'b.md', kind: 'file' },
  ]);
  h.clickRow('a.md');
  h.clickRow('b.md', { ctrlKey: true });
  h.key('F2');
  assert.ok(!h.findRow('a.md').children.some((c) => c.classList.contains('tree-rename-input')));
  // 根行
  h.clickRow(''); // 目录行点击会触发展开请求，但根已展开且未加载——只选中
  h.key('F2');
  const rootRow = h.findRow('');
  assert.ok(!rootRow.children.some((c) => c.classList.contains('tree-rename-input')));
});

test('Delete 发回收站删除；Shift+Delete 二次确认后永久删除', () => {
  const h = loadTree();
  h.open();
  h.listed('', [
    { name: 'a.md', rel: 'a.md', kind: 'file' },
    { name: 'b.md', rel: 'b.md', kind: 'file' },
  ]);
  h.clickRow('a.md');
  h.clickRow('b.md', { ctrlKey: true });
  h.key('Delete');
  assert.deepEqual(h.byCommand('workspace.fs.delete'), [
    { command: 'workspace.fs.delete', paths: ['a.md', 'b.md'], permanent: false },
  ]);

  h.key('Delete', { shiftKey: true });
  assert.equal(h.confirmCalls.length, 1, '永久删除前应二次确认');
  assert.deepEqual(h.byCommand('workspace.fs.delete')[1], {
    command: 'workspace.fs.delete',
    paths: ['a.md', 'b.md'],
    permanent: true,
  });

  // 确认取消：不发送
  h.setConfirm(false);
  h.key('Delete', { shiftKey: true });
  assert.equal(h.byCommand('workspace.fs.delete').length, 2);
});

test('右键打开上下文菜单：未选中行先选中，Esc/外点击关闭', () => {
  const h = loadTree();
  h.open();
  h.listed('', [{ name: 'a.md', rel: 'a.md', kind: 'file' }]);
  assert.equal(h.menu(), null);
  h.contextOn('a.md');
  assert.ok(h.menu(), '右键后菜单出现');
  assert.equal(h.projectTree.getState().active, 'a.md', '右键未选中项先选中');
  assert.equal(h.menu().style.left, '10px');
  // Esc 关闭
  h.docHandlers.keydown.forEach((fn) => fn({ key: 'Escape' }));
  assert.equal(h.menu(), null);
  // 外点击关闭
  h.contextOn('a.md');
  h.docHandlers.click.forEach((fn) => fn({ target: h.body }));
  assert.equal(h.menu(), null);
  // 菜单内点击不关闭（由菜单项自身处理）
  h.contextOn('a.md');
  const item = h.menuItem('copy-abs');
  assert.ok(item);
  h.docHandlers.click.forEach((fn) => fn({ target: item }));
  assert.ok(h.menu(), '菜单内点击不触发外点关闭');
});

test('上下文菜单无障碍语义与键盘导航：aria-disabled、方向键、Enter、Escape', () => {
  const h = loadTree({ rootPath: 'G:/proj' });
  h.listed('', [{ name: 'a.md', rel: 'a.md', kind: 'file' }, { name: 'docs', rel: 'docs', kind: 'dir' }]);
  h.contextOn('a.md');
  const menu = h.menu();
  assert.equal(menu.getAttribute('role'), 'menu');
  assert.equal(menu.getAttribute('aria-label'), '项目树操作');
  const rename = h.menuItem('rename');
  assert.equal(rename.getAttribute('role'), 'menuitem');
  assert.equal(rename.getAttribute('tabindex'), '-1');
  assert.equal(rename.getAttribute('aria-disabled'), 'false');
  const paste = h.menuItem('paste');
  assert.equal(paste.getAttribute('aria-disabled'), 'true');
  assert.equal(rename.focused, false);
  const down = { key: 'ArrowDown', preventDefault() { this.prevented = true; } };
  menu.listeners.keydown.forEach((fn) => fn(down));
  assert.equal(down.prevented, true);
  assert.equal(h.menuItem('create-dir').classList.contains('is-active'), true);
  const enter = { key: 'Enter', preventDefault() { this.prevented = true; } };
  menu.listeners.keydown.forEach((fn) => fn(enter));
  assert.equal(enter.prevented, true);
  assert.equal(h.menu(), null, 'Enter 执行菜单项后关闭');

  h.contextOn('a.md');
  const menu2 = h.menu();
  const up = { key: 'ArrowUp', preventDefault() {} };
  menu2.listeners.keydown.forEach((fn) => fn(up));
  assert.equal(h.menuItem('copy-rel').classList.contains('is-active'), true, '向上从首项环回末项');
  const esc = { key: 'Escape', preventDefault() { this.prevented = true; } };
  menu2.listeners.keydown.forEach((fn) => fn(esc));
  assert.equal(esc.prevented, true);
  assert.equal(h.menu(), null);
});

test('上下文菜单边界定位：右下角翻转并夹紧到 viewport', () => {
  const h = loadTree({ rootPath: 'G:/proj' });
  h.listed('', [{ name: 'a.md', rel: 'a.md', kind: 'file' }]);
  h.contextOn('a.md', { clientX: 390, clientY: 290 });
  const menu = h.menu();
  // mock DOM 的默认 rect 为 0，运行时 fallback 使用 212px 宽、320px 高。
  // 400×300 viewport 下，右下角坐标应翻转/夹紧为 (178px, 0px)。
  assert.equal(menu.style.left, '178px');
  assert.equal(menu.style.top, '0px');
});

test('菜单样式包含明暗主题 token、raised overlay、hover/危险态与 focus-visible', () => {
  const css = fs.readFileSync(path.join(__dirname, 'project-tree.css'), 'utf8');
  for (const token of ['--tree-menu-bg', '--tree-menu-border', '--tree-menu-shadow', '--tree-menu-hover', '--tree-menu-danger-hover']) {
    assert.match(css, new RegExp(token));
  }
  assert.match(css, /\[data-theme="light"\]/);
  assert.match(css, /\.ctx-item:focus-visible/);
  assert.match(css, /\.ctx-item\.danger:hover/);
  assert.match(css, /min-width:\s*212px/);
  assert.match(css, /height:\s*26px/);
});

test('菜单项→命令映射：新建文件按目标目录、终端、reveal、删除', () => {
  const h = loadTree();
  h.open();
  h.listed('', [
    { name: 'docs', rel: 'docs', kind: 'dir' },
    { name: 'a.md', rel: 'a.md', kind: 'file' },
  ]);

  // 目录行新建文件 → 目录内
  h.contextOn('docs');
  h.clickItem('create-file');
  const holder = h.tree.children.find((el) => el.classList && el.classList.contains('tree-create-row'));
  assert.ok(holder, '应出现新建输入行');
  const input = holder.children[0];
  input.value = 'new.md';
  input.listeners.keydown.forEach((fn) => fn({ key: 'Enter', preventDefault() {}, stopPropagation() {} }));
  assert.deepEqual(h.byCommand('workspace.fs.create-file'), [
    { command: 'workspace.fs.create-file', path: 'docs/new.md' },
  ]);
  assert.ok(!h.tree.children.some((el) => el.classList && el.classList.contains('tree-create-row')), '提交后输入行移除');

  // 文件行新建文件 → 父目录（根）
  h.contextOn('a.md');
  h.clickItem('create-file');
  const input2 = h.tree.children.find((el) => el.classList && el.classList.contains('tree-create-row')).children[0];
  input2.value = '根下.md';
  input2.listeners.keydown.forEach((fn) => fn({ key: 'Enter', preventDefault() {}, stopPropagation() {} }));
  assert.deepEqual(h.byCommand('workspace.fs.create-file')[1], {
    command: 'workspace.fs.create-file',
    path: '根下.md',
  });

  // 终端：目录行 → 目录自身（每次操作前重新打开菜单：菜单项点击即收起）
  h.contextOn('docs');
  h.clickItem('terminal');
  assert.deepEqual(h.byCommand('workspace.fs.terminal'), [
    { command: 'workspace.fs.terminal', path: 'docs' },
  ]);

  // reveal：文件行 → 单选自身
  h.contextOn('a.md');
  h.clickItem('reveal');
  assert.deepEqual(h.byCommand('workspace.fs.reveal'), [
    { command: 'workspace.fs.reveal', path: 'a.md' },
  ]);

  // 删除
  h.contextOn('a.md');
  h.clickItem('delete');
  assert.deepEqual(h.byCommand('workspace.fs.delete'), [
    { command: 'workspace.fs.delete', paths: ['a.md'], permanent: false },
  ]);
});

test('多选时菜单的 reveal 与重命名项禁用', () => {
  const h = loadTree();
  h.open();
  h.listed('', [
    { name: 'a.md', rel: 'a.md', kind: 'file' },
    { name: 'b.md', rel: 'b.md', kind: 'file' },
  ]);
  h.clickRow('a.md');
  h.clickRow('b.md', { ctrlKey: true });
  h.contextOn('a.md');
  assert.equal(h.menuItem('reveal').classList.contains('disabled'), true);
  assert.equal(h.menuItem('rename').classList.contains('disabled'), true);
  assert.equal(h.menuItem('delete').classList.contains('disabled'), false);
  assert.equal(h.menuItem('create-file').classList.contains('disabled'), false);
});

test('复制路径：系统剪贴板优先，缺失时降级 execCommand', () => {
  const h = loadTree();
  h.open();
  h.listed('', [{ name: 'a.md', rel: 'docs/a.md', kind: 'file' }]);
  h.clickRow('docs/a.md');
  h.contextOn('docs/a.md');
  h.clickItem('copy-abs');
  h.contextOn('docs/a.md'); // 菜单项点击即收起，重开后再点下一项
  h.clickItem('copy-rel');
  assert.deepEqual(h.clipboardWrites, ['G:/proj/docs/a.md', 'docs/a.md']);

  // 无 navigator.clipboard：降级 execCommand
  const h2 = loadTree({ withClipboard: false });
  h2.open();
  h2.listed('', [{ name: 'a.md', rel: 'a.md', kind: 'file' }]);
  h2.clickRow('a.md');
  h2.contextOn('a.md');
  h2.clickItem('copy-abs');
  assert.deepEqual(h2.execCalls, ['copy']);
});

test('剪切/复制/粘贴：内部剪贴板状态与 move/copy 命令', () => {
  const h = loadTree();
  h.open();
  h.listed('', [
    { name: 'docs', rel: 'docs', kind: 'dir' },
    { name: 'a.md', rel: 'a.md', kind: 'file' },
  ]);
  // 复制 a.md → 粘贴到 docs
  h.clickRow('a.md');
  h.key('c', { ctrlKey: true });
  h.clickRow('docs'); // 选中并展开 docs（dest 取激活行）
  h.key('v', { ctrlKey: true });
  assert.deepEqual(h.byCommand('workspace.fs.copy'), [
    { command: 'workspace.fs.copy', paths: ['a.md'], dest_dir: 'docs' },
  ]);

  // 剪切 a.md → 粘贴到根：行出现 st-cut，move 完成后清除
  h.clickRow('a.md');
  h.key('x', { ctrlKey: true });
  assert.equal(h.findRow('a.md').classList.contains('st-cut'), true);
  h.clickRow(''); // 选中根
  h.key('v', { ctrlKey: true });
  assert.deepEqual(h.byCommand('workspace.fs.move'), [
    { command: 'workspace.fs.move', paths: ['a.md'], dest_dir: '' },
  ]);
  h.fire('workspace:fs-op-done', { op: 'move', paths: ['G:/proj/a.md', 'G:/proj/docs/a.md'], undo_id: 1 });
  assert.equal(h.findRow('docs/a.md') ? h.findRow('docs/a.md').classList.contains('st-cut') : false, false, 'move 完成后剪切态清除');
});

test('workspace:file-changed 强制刷新父目录；项目外路径忽略', () => {
  const h = loadTree();
  h.open();
  h.listed('', [{ name: 'docs', rel: 'docs', kind: 'dir' }]);
  h.clickRow('docs');
  h.listed('docs', [{ name: 'a.md', rel: 'docs/a.md', kind: 'file' }]);
  const before = h.byCommand('workspace.tree.list').length;
  h.fire('workspace:file-changed', { path: 'G:\\proj\\docs\\a.md', kind: 'content' });
  const lists = h.byCommand('workspace.tree.list').slice(before);
  assert.deepEqual(lists.map((m) => m.path), ['docs'], '应强制刷新父目录');
  // 项目外
  h.fire('workspace:file-changed', { path: 'C:/elsewhere/x.md', kind: 'content' });
  assert.equal(h.byCommand('workspace.tree.list').length, before + 1, '越根路径不触发刷新');
});

test('fs-op-done rename：刷新新旧父目录、活动文件重映射并发 projecttree:file-moved', () => {
  const h = loadTree();
  h.open();
  h.listed('', [{ name: 'docs', rel: 'docs', kind: 'dir' }]);
  h.clickRow('docs');
  h.listed('docs', [{ name: 'a.md', rel: 'docs/a.md', kind: 'file' }]);
  h.setTabs('G:/proj/docs/a.md');
  assert.equal(h.projectTree.getState().activeFile, 'docs/a.md');

  const before = h.byCommand('workspace.tree.list').length;
  h.fire('workspace:fs-op-done', {
    op: 'rename',
    paths: ['G:/proj/docs/a.md', 'G:/proj/docs/b.md'],
    undo_id: 3,
  });
  assert.equal(h.projectTree.getState().activeFile, 'docs/b.md', '活动文件应随重命名迁移');
  assert.equal(
    h.findRow('docs/a.md') ? h.findRow('docs/a.md').classList.contains('st-reveal') : false,
    false
  );
  const refreshed = h.byCommand('workspace.tree.list').slice(before).map((m) => m.path);
  assert.deepEqual(refreshed, ['docs'], '新旧父目录相同则去重刷新一次');
  const moved = h.dispatched.filter((e) => e.type === 'projecttree:file-moved');
  assert.equal(moved.length, 1);
  // vm 沙箱对象与宿主原型不同：展开为宿主对象后逐字段比较
  assert.deepEqual({ ...moved[0].detail }, { from: 'docs/a.md', to: 'docs/b.md', op: 'rename' });
});

test('fs-op-done move 目录：展开状态随路径重映射并持久化', () => {
  const h = loadTree();
  h.open();
  h.listed('', [{ name: 'docs', rel: 'docs', kind: 'dir' }]);
  h.clickRow('docs'); // 展开 docs
  h.fire('workspace:fs-op-done', {
    op: 'move',
    paths: ['G:/proj/docs', 'G:/proj/archived/docs'],
    undo_id: 4,
  });
  const state = h.projectTree.getState();
  assert.deepEqual([...state.expanded].sort(), ['', 'archived/docs']);
  assert.equal(h.storage.get('glancemd-ultra-tree-expanded'), JSON.stringify(['', 'archived/docs']));
});

test('展开状态持久化：写入 localStorage，重开项目后级联恢复', () => {
  const h = loadTree();
  h.open();
  h.listed('', [{ name: 'docs', rel: 'docs', kind: 'dir' }]);
  h.clickRow('docs');
  assert.equal(h.storage.get('glancemd-ultra-tree-expanded'), JSON.stringify(['', 'docs']));

  // 新会话：预置持久化并重开 → 根列表返回后自动级联请求 docs
  const h2 = loadTree({ lsExpanded: ['', 'docs'] });
  h2.open();
  h2.listed('', [{ name: 'docs', rel: 'docs', kind: 'dir' }]);
  assert.deepEqual(h2.byCommand('workspace.tree.list').map((m) => m.path), ['', 'docs']);
  assert.equal(h2.findRow('docs').children.find((c) => c.classList.contains('chev')).className, 'chev open');
});

test('定位当前文件：tab 同步高亮不滚动，命令展开祖先选中并滚动', () => {
  const h = loadTree();
  h.open();
  h.listed('', [{ name: 'docs', rel: 'docs', kind: 'dir' }]);

  // 面板头按钮已注入且无活动文件时置灰
  const btn = h.head.children.find((el) => el.id === 'project-tree-reveal');
  assert.ok(btn, '面板头应注入定位按钮');
  assert.equal(btn.classList.contains('disabled'), true);

  h.setTabs('G:/proj/docs/guide.md');
  assert.equal(h.projectTree.getState().activeFile, 'docs/guide.md');
  assert.equal(btn.classList.contains('disabled'), false);
  assert.ok(!h.findRow('docs') || !h.findRow('docs').classList.contains('st-reveal'), '行不存在时无高亮副作用');

  h.commands.run('project.reveal-current');
  // 祖先 docs、docs/guide.md 的父 docs/sub…：本例祖先只有 docs
  assert.deepEqual(
    h.byCommand('workspace.tree.list').map((m) => m.path),
    ['', 'docs']
  );
  h.listed('docs', [{ name: 'sub', rel: 'docs/sub', kind: 'dir' }]);
  // docs 尚无 guide.md 行：挂 pendingReveal，等子层就位
  h.commands.run('project.reveal-current');
  h.listed('docs', [{ name: 'guide.md', rel: 'docs/guide.md', kind: 'file' }]);
  const row = h.findRow('docs/guide.md');
  assert.ok(row, '定位目标行已渲染');
  assert.equal(row.classList.contains('st-active'), true);
  assert.equal(row.classList.contains('st-reveal'), true);
  assert.equal(row.scrolled !== null, true, '命令定位应滚动');

  // 切换 tab：只同步高亮，不滚动
  h.setTabs('G:/proj/other.md'); // 项目外文件：高亮清除
  assert.equal(row.classList.contains('st-reveal'), false);
  h.setTabs('G:/proj/docs/guide.md');
  assert.equal(row.classList.contains('st-reveal'), true);
  assert.equal(row.scrolled !== null, true, 'tab 切换不新增滚动（仍为定位时的记录）');
});

test('命令注册：project.* 进入 window.Commands 且 open-file 拼接绝对路径', () => {
  const h = loadTree();
  h.open();
  ['project.open-file', 'project.reveal-current', 'project.refresh', 'project.create-file',
    'project.create-dir', 'project.rename', 'project.delete', 'project.move', 'project.copy',
    'project.undo', 'project.reveal', 'project.terminal', 'project.copy-path',
  ].forEach((id) => assert.equal(h.commands.has(id), true, '缺少命令: ' + id));

  h.commands.run('project.open-file', { rel: 'docs/a.md' });
  assert.deepEqual(h.byCommand('open_file'), [{ command: 'open_file', path: 'G:/proj/docs/a.md' }]);

  // 项目未打开时命令为空操作
  const h2 = loadTree({ rootPath: null });
  h2.commands.run('project.open-file', { rel: 'a.md' });
  assert.equal(h2.byCommand('open_file').length, 0);
});

test('undo 命令与空白点击清空选择', () => {
  const h = loadTree();
  h.open();
  h.listed('', [{ name: 'a.md', rel: 'a.md', kind: 'file' }]);
  h.clickRow('a.md');
  assert.deepEqual([...h.projectTree.getState().selected], ['a.md']);
  h.fireTree('click', { target: h.tree }); // 空白处
  assert.deepEqual([...h.projectTree.getState().selected], []);
  h.commands.run('project.undo');
  assert.deepEqual(h.byCommand('workspace.fs.undo'), [{ command: 'workspace.fs.undo' }]);
});

test('workspace:error 释放在途请求，允许重试展开', () => {
  const h = loadTree();
  h.open();
  h.listed('', [{ name: 'docs', rel: 'docs', kind: 'dir' }]);
  h.clickRow('docs'); // 在途
  h.fire('workspace:error', { message: '目录不可读' });
  h.fire('workspace:file-changed', { path: 'G:/proj/docs/x.md', kind: 'content' });
  const docsLists = h.byCommand('workspace.tree.list').filter((m) => m.path === 'docs');
  assert.equal(docsLists.length, 2, '出错释放后应允许重新请求');
});

test('fs-op-done copy/trash-delete：按 paths 刷新受影响目录', () => {
  const h = loadTree();
  h.open();
  h.listed('', [{ name: 'docs', rel: 'docs', kind: 'dir' }]);
  h.clickRow('docs');
  h.listed('docs', [{ name: 'a.md', rel: 'docs/a.md', kind: 'file' }]);
  const before = h.byCommand('workspace.tree.list').length;
  h.fire('workspace:fs-op-done', { op: 'trash-delete', paths: ['G:/proj/docs/a.md'], undo_id: 7 });
  assert.deepEqual(
    h.byCommand('workspace.tree.list').slice(before).map((m) => m.path),
    ['docs']
  );
  assert.equal(h.dispatched.some((e) => e.type === 'projecttree:file-moved'), false, '删除不发搬移通知');
});
