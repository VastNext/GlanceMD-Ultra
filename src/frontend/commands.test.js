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

// 装载 commands.js：document 提供入口按钮，window.ipc 捕获上行消息。
function loadCommands({ withButton = true, withSettings = false } = {}) {
  const messages = [];
  const legacyClicks = [];
  const original = makeButtonNode('btn-open');
  const openFile = makeButtonNode('btn-open-file');
  const settings = makeButtonNode('btn-settings');
  let replacedBy = null;
  if (withButton) {
    original.addEventListener('click', () => legacyClicks.push(true));
    original.parentNode = {
      replaceChild(child, old) {
        assert.equal(old, original);
        replacedBy = child;
        child.parentNode = original.parentNode;
      },
    };
  }
  const context = {
    window: {
      ipc: { postMessage(msg) { messages.push(JSON.parse(msg)); } },
      SettingsUI: withSettings ? { toggle() { messages.push({ settingsToggled: true }); } } : undefined,
    },
    document: {
      getElementById(id) {
        if (id === 'btn-open') return replacedBy || (withButton ? original : null);
        if (id === 'btn-open-file') return openFile;
        if (id === 'btn-settings') return withSettings ? settings : null;
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
    openFile,
    settings,
  };
}

test('装载后暴露 window.Commands 并注册阶段 0 内置命令', () => {
  const { commands } = loadCommands();
  assert.ok(commands);
  // ids() 返回 vm 沙箱内的数组（原型与宿主不同），展开为宿主数组后比较
  assert.deepEqual([...commands.ids()], ['file.open', 'workspace.open', 'settings.toggle', 'settings.keybindings', 'outline.focus', 'resource.open', 'editor.focus', 'focus.next', 'focus.previous']);
  assert.equal(commands.get('file.open').label, '打开文件…');
});

test('run(file.open) 发送与原按钮等效的 open_file 上行消息', () => {
  const { commands, messages } = loadCommands();
  commands.run('file.open');
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { command: 'open_file' });
  commands.run('file.open', { path: 'D:/doc.md' });
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1], { command: 'open_file', path: 'D:/doc.md' });
});

test('导航命令注册并可在模块延迟加载后执行', () => {
  const calls = [];
  const h = loadCommands();
  h.commands.register('demo', { run() {} });
  h.commands.run('outline.focus');
  h.commands.run('resource.open');
  assert.equal(h.commands.has('focus.next'), true);
  assert.equal(h.commands.has('focus.previous'), true);
});

test('register 保存 category, description, visibleInPalette 与 isEnabled 元数据', () => {
  const { commands } = loadCommands();
  commands.register('demo.meta', {
    label: '元数据命令',
    category: 'Demo',
    description: '说明文字',
    visibleInPalette: false,
    requiresArgs: true,
    isEnabled: () => false,
    run() {},
  });
  const def = commands.get('demo.meta');
  assert.equal(def.category, 'Demo');
  assert.equal(def.description, '说明文字');
  assert.equal(def.visibleInPalette, false);
  assert.equal(def.requiresArgs, true);
  assert.equal(def.isEnabled(), false);
});

test('run(workspace.open) 有路径时直接打开，无路径时请求原生目录选择器', () => {
  const { commands, messages } = loadCommands();
  commands.run('workspace.open', { path: 'G:/proj' });
  assert.deepEqual(messages[0], { command: 'workspace.open', path: 'G:/proj' });

  commands.run('workspace.open');
  commands.run('workspace.open', {});
  assert.deepEqual(messages[1], { command: 'workspace.open' });
  assert.deepEqual(messages[2], { command: 'workspace.open' });
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

test('上方文件夹按钮经命令表请求打开项目目录', () => {
  const { messages, replacedBy } = loadCommands();
  replacedBy.listeners.click({ preventDefault() {} });
  assert.deepEqual(messages, [{ command: 'workspace.open' }]);
});

test('接管打开按钮：克隆替换原节点，旧 app.js 绑定不再触发', () => {
  const { messages, original, replacedBy, legacyClicks } = loadCommands();
  // 原节点被无监听器的克隆替换（旧 app.js 绑定随之失效）
  assert.equal(replacedBy !== original, true);
  assert.equal(typeof original.listeners.click, 'function');
  assert.equal(typeof replacedBy.listeners.click, 'function');

  let prevented = false;
  replacedBy.listeners.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { command: 'workspace.open' });
  // 旧绑定未随克隆复制，不会被触发（无双重对话框）
  assert.equal(legacyClicks.length, 0);
});

test('独立打开文件按钮经 file.open 命令工作', () => {
  const h = loadCommands();
  assert.equal(h.commands.has('file.open'), true);
  h.openFile.listeners.click({ preventDefault() {} });
  assert.deepEqual(h.messages, [{ command: 'open_file' }]);
});

test('settings.toggle 可执行并由按钮触发 SettingsUI.toggle', () => {
  const h = loadCommands({ withSettings: true });
  assert.equal(h.commands.has('settings.toggle'), true);
  h.settings.listeners.click({ preventDefault() {} });
  assert.equal(h.messages.filter((x) => x.settingsToggled).length, 1);
});

test('按钮不存在时优雅跳过且命令表仍可用', () => {
  const { commands, messages } = loadCommands({ withButton: false });
  assert.doesNotThrow(() => commands.run('file.open'));
  assert.equal(messages.length, 1);
});

// i18n 集成：Commands.get 的 label 经 I18n.commandLabel 按活动语言动态解析
//（命令面板 Ctrl+3 与快捷键助手 Ctrl+Shift+L 的命令名都走这条路径）
test('Commands.get 的 label 随界面语言切换（i18n command.* 集中翻译表）', () => {
  const context = {
    window: { ipc: { postMessage() {} } },
    document: { getElementById: () => null },
  };
  vm.runInNewContext(fs.readFileSync(__dirname + '/i18n.js', 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(__dirname + '/commands.js', 'utf8'), context);
  const i18n = context.window.I18n;
  const commands = context.window.Commands;

  // 默认 zh-CN：字典值与注册 label 一致
  assert.equal(commands.get('file.open').label, '打开文件…');
  assert.equal(commands.get('settings.keybindings').label, '快捷键设置');

  // 切英文：字典收录的命令跟随活动语言
  assert.equal(i18n.setLanguage('en'), true);
  assert.equal(commands.get('file.open').label, 'Open File…');
  assert.equal(commands.get('settings.keybindings').label, 'Keyboard Shortcuts');
  assert.equal(commands.get('editor.focus').label, 'Focus Editor');

  // 切回中文
  assert.equal(i18n.setLanguage('zh-CN'), true);
  assert.equal(commands.get('file.open').label, '打开文件…');

  // 未收录命令回退注册 label；get 返回副本，不污染注册表
  commands.register('test.unlisted', { label: '元数据命令', run() {} });
  assert.equal(commands.get('test.unlisted').label, '元数据命令');
  const entry = commands.get('test.unlisted');
  entry.label = '污染';
  assert.equal(commands.get('test.unlisted').label, '元数据命令');
});
