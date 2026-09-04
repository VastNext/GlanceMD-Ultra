const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function makeButtonNode(id) {
  const node = {
    id,
    listeners: {},
    parentNode: null,
    addEventListener(type, handler) {
      node.listeners[type] = handler;
    },
    cloneNode() {
      const clone = makeButtonNode(id);
      clone.parentNode = node.parentNode;
      return clone;
    },
  };
  return node;
}

// 装载 commands.js：document 提供可被克隆替换的 #btn-open（或不存在），
// window.ipc 捕获上行消息。返回 window.Commands 与捕获到的消息。
function loadCommands({ withButton = true } = {}) {
  const messages = [];
  const legacyClicks = [];
  const original = makeButtonNode('btn-open');
  let replacedBy = null;
  const replacements = [];
  if (withButton) {
    // 模拟 app.js 在启动时对 #btn-open 的既有绑定
    original.addEventListener('click', () => legacyClicks.push(true));
    original.parentNode = {
      replaceChild(child, old) {
        assert.equal(old, original);
        replacements.push(old);
        replacedBy = child;
        child.parentNode = original.parentNode;
      },
    };
  }
  const context = {
    window: {
      ipc: {
        postMessage(msg) {
          messages.push(JSON.parse(msg));
        },
      },
    },
    document: {
      getElementById(id) {
        if (id === 'btn-open') {
          return replacedBy || original;
        }
        return null;
      },
    },
  };

  const source = fs.readFileSync(__dirname + '/commands.js', 'utf8');
  vm.runInNewContext(source, context);
  return {
    commands: context.window.Commands,
    messages,
    original,
    replacedBy,
    legacyClicks,
  };
}

test('装载后暴露 window.Commands 并注册阶段 0 内置命令', () => {
  const { commands } = loadCommands();
  assert.ok(commands);
  // ids() 返回 vm 沙箱内的数组（原型与宿主不同），展开为宿主数组后比较
  assert.deepEqual([...commands.ids()], ['file.open', 'workspace.open']);
  assert.equal(commands.get('file.open').label, '打开文件…');
});

test('run(file.open) 发送与原按钮等效的 open_file 上行消息', () => {
  const { commands, messages } = loadCommands();
  commands.run('file.open');
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { command: 'open_file' });
});

test('run(workspace.open) 携带 path 参数', () => {
  const { commands, messages } = loadCommands();
  commands.run('workspace.open', { path: 'G:/proj' });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { command: 'workspace.open', path: 'G:/proj' });

  // 无 path 的调用不产生上行消息（目录选择对话框在阶段 1 提供）
  commands.run('workspace.open');
  commands.run('workspace.open', {});
  assert.equal(messages.length, 1);
});

test('未知命令与重复注册都报错', () => {
  const { commands } = loadCommands();
  assert.throws(() => commands.run('demo.missing'), /未知命令/);
  assert.throws(
    () => commands.register('file.open', { label: 'x', run() {} }),
    /重复注册/,
  );
});

test('register 后可 run，unregister 后不可再 run', () => {
  const { commands, messages } = loadCommands();
  let called = 0;
  commands.register('demo.ping', {
    label: '演示',
    run(arg) {
      called += arg;
    },
  });
  commands.run('demo.ping', 2);
  assert.equal(called, 2);
  assert.equal(commands.unregister('demo.ping'), true);
  assert.equal(commands.has('demo.ping'), false);
  assert.throws(() => commands.run('demo.ping'), /未知命令/);
  assert.equal(commands.unregister('demo.ping'), false);
  assert.deepEqual(messages, []);
});

test('接管打开文件按钮：克隆替换原节点并经命令表触发', () => {
  const { messages, original, replacedBy, legacyClicks } = loadCommands();
  // 原节点被无监听器的克隆替换（旧 app.js 绑定随之失效）
  assert.equal(replacedBy !== original, true);
  assert.equal(typeof original.listeners.click, 'function');
  assert.equal(typeof replacedBy.listeners.click, 'function');

  let prevented = false;
  replacedBy.listeners.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { command: 'open_file' });
  // 旧绑定未随克隆复制，不会被触发（无双重对话框）
  assert.equal(legacyClicks.length, 0);
});

test('按钮不存在时优雅跳过且命令表仍可用', () => {
  const { commands, messages } = loadCommands({ withButton: false });
  assert.doesNotThrow(() => commands.run('file.open'));
  assert.equal(messages.length, 1);
});
