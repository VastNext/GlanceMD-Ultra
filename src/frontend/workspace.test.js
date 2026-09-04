const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

// 最小 DOM stub：支持 #statusbar 内动态创建 #status-workspace span。
function makeDocument() {
  const byId = {
    statusbar: { id: 'statusbar', children: [], appendChild(child) {
      byId.statusbar.children.push(child);
      if (child.id && !byId[child.id]) {
        byId[child.id] = child;
      }
    } },
  };
  return {
    byId,
    getElementById(id) {
      return byId[id] || null;
    },
    createElement(tag) {
      return { tag, id: '', style: {}, textContent: '' };
    },
  };
}

// 装载 workspace.js：可注入既有 __fromRust（模拟 app.js 已装载）。
function loadWorkspace({ existingHandler } = {}) {
  const passthrough = [];
  const context = {
    window: {},
    document: makeDocument(),
  };
  if (existingHandler) {
    context.window.__fromRust = function(event, data) {
      passthrough.push({ event, data });
    };
  }

  const source = fs.readFileSync(__dirname + '/workspace.js', 'utf8');
  vm.runInNewContext(source, context);
  return {
    workspace: context.window.Workspace,
    fromRust: context.window.__fromRust,
    passthrough,
    document: context.document,
  };
}

test('__fromRust 存在时被包装：非 workspace 事件透传既有 handler', () => {
  const loaded = loadWorkspace({ existingHandler: true });
  assert.notEqual(loaded.fromRust, undefined);

  loaded.fromRust('file_opened', { content: '# hi', path: 'D:/a.md' });
  assert.equal(loaded.passthrough.length, 1);
  assert.deepEqual(loaded.passthrough[0], {
    event: 'file_opened',
    data: { content: '# hi', path: 'D:/a.md' },
  });

  // workspace:* 事件不透传给既有 handler（走内部分发器）
  loaded.fromRust('workspace:opened', { root: 'G:/proj', file_count: 0 });
  assert.equal(loaded.passthrough.length, 1);
});

test('__fromRust 不存在时兜底自建且不抛异常', () => {
  const loaded = loadWorkspace();
  assert.equal(typeof loaded.fromRust, 'function');
  assert.doesNotThrow(() => {
    loaded.fromRust('file_saved', { path: 'D:/a.md' });
  });
  assert.doesNotThrow(() => {
    loaded.fromRust('workspace:scan-progress', { scanned: 1 });
  });
});

test('workspace:opened 在状态栏显示项目与文件数', () => {
  const loaded = loadWorkspace();
  loaded.fromRust('workspace:opened', { root: 'G:/proj', file_count: 0 });

  const el = loaded.document.byId['status-workspace'];
  assert.ok(el, '状态栏内应创建 #status-workspace');
  assert.equal(el.textContent, '项目：G:/proj（0 个文件）');
  // getState() 是 vm 沙箱内创建的对象（原型与宿主不同），逐字段断言
  const state = loaded.workspace.getState();
  assert.equal(state.root, 'G:/proj');
  assert.equal(state.fileCount, 0);
  assert.equal(state.error, null);
});

test('workspace:scan-progress 更新计数', () => {
  const loaded = loadWorkspace();
  loaded.fromRust('workspace:opened', { root: 'G:/proj', file_count: 0 });
  loaded.fromRust('workspace:scan-progress', { scanned: 200 });
  loaded.fromRust('workspace:scan-progress', { scanned: 347 });

  const el = loaded.document.byId['status-workspace'];
  assert.equal(el.textContent, '项目：G:/proj（347 个文件）');
  assert.equal(loaded.workspace.getState().fileCount, 347);
});

test('workspace:error 显示错误消息', () => {
  const loaded = loadWorkspace();
  loaded.fromRust('workspace:error', { message: '项目目录不存在：G:/nope' });

  const el = loaded.document.byId['status-workspace'];
  assert.equal(el.textContent, 'Workspace 错误：项目目录不存在：G:/nope');
  assert.equal(loaded.workspace.getState().error, '项目目录不存在：G:/nope');

  // 下一次成功事件清除错误态
  loaded.fromRust('workspace:opened', { root: 'G:/proj', file_count: 0 });
  assert.equal(el.textContent, '项目：G:/proj（0 个文件）');
  assert.equal(loaded.workspace.getState().error, null);
});

test('订阅者经 on() 收到事件，off() 后退订', () => {
  const loaded = loadWorkspace();
  const seen = [];
  const handler = (data) => seen.push(data);
  loaded.workspace.on('workspace:opened', handler);

  loaded.fromRust('workspace:opened', { root: 'G:/p1', file_count: 0 });
  assert.equal(seen.length, 1);

  loaded.workspace.off('workspace:opened', handler);
  loaded.fromRust('workspace:opened', { root: 'G:/p2', file_count: 3 });
  assert.equal(seen.length, 1);

  // on() 返回的退订函数同样可用
  const cancel = loaded.workspace.on('workspace:scan-progress', (d) => seen.push(d));
  cancel();
  loaded.fromRust('workspace:scan-progress', { scanned: 1 });
  assert.equal(seen.length, 1);
});

test('未知 workspace:* 事件仍分发给订阅者（前向兼容）', () => {
  const loaded = loadWorkspace();
  const seen = [];
  loaded.workspace.on('workspace:file-changed', (data) => seen.push(data));
  assert.doesNotThrow(() => {
    loaded.fromRust('workspace:file-changed', { path: 'D:/a.md' });
  });
  assert.deepEqual(seen, [{ path: 'D:/a.md' }]);
});

test('状态栏缺失时不抛异常，状态仍可查询', () => {
  const context = { window: {}, document: { getElementById: () => null, createElement: () => ({ style: {} }) } };
  const source = fs.readFileSync(__dirname + '/workspace.js', 'utf8');
  vm.runInNewContext(source, context);
  assert.doesNotThrow(() => {
    context.window.__fromRust('workspace:opened', { root: 'G:/proj', file_count: 0 });
  });
  const state = context.window.Workspace.getState();
  assert.equal(state.root, 'G:/proj');
  assert.equal(state.fileCount, 0);
  assert.equal(state.error, null);
});
