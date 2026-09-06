// 命令注册表（前端，阶段 0）—— window.Commands
// 契约唯一事实源：docs/dev/interfaces.md。
// 约定：命令 ID 命名空间式（如 file.open、workspace.open）；按钮/菜单/快捷键只引用
// 命令 ID，不直接内联 ipc 调用。本模块在 app.js 之后加载，只通过 window 命名空间
// 与 DOM 与其他模块通信（不互相 require）。
(function() {
  'use strict';

  var registry = {};
  var order = [];

  function register(id, definition) {
    if (typeof id !== 'string' || !id) {
      throw new Error('[Commands] 命令 ID 必须为非空字符串');
    }
    if (Object.prototype.hasOwnProperty.call(registry, id)) {
      throw new Error('[Commands] 命令重复注册: ' + id);
    }
    if (!definition || typeof definition.run !== 'function') {
      throw new Error('[Commands] 命令缺少 run(): ' + id);
    }
    registry[id] = {
      id: id,
      label: String(definition.label || id),
      category: definition.category ? String(definition.category) : '',
      description: definition.description ? String(definition.description) : '',
      visibleInPalette: definition.visibleInPalette !== false,
      requiresArgs: Boolean(definition.requiresArgs),
      isEnabled: typeof definition.isEnabled === 'function' ? definition.isEnabled : function() { return true; },
      run: definition.run
    };
    order.push(id);
    return id;
  }

  function unregister(id) {
    if (!Object.prototype.hasOwnProperty.call(registry, id)) {
      return false;
    }
    delete registry[id];
    order.splice(order.indexOf(id), 1);
    return true;
  }

  function has(id) {
    return Object.prototype.hasOwnProperty.call(registry, id);
  }

  function get(id) {
    return registry[id] || null;
  }

  function ids() {
    return order.slice();
  }

  function run(id, arg) {
    var cmd = registry[id];
    if (!cmd) {
      throw new Error('[Commands] 未知命令: ' + id);
    }
    return cmd.run(arg);
  }

  // IPC 上行信封（与 app.js::sendToRust 等价，见 interfaces.md §1）。
  function sendToRust(command, data) {
    var msg = JSON.stringify(Object.assign({ command: command }, data || {}));
    window.ipc.postMessage(msg);
  }

  // ---- 阶段 0 内置命令 ----

  // 与原 #btn-open 点击行为完全等效：无 path 时由 Rust 弹选择框；有 path 时直接打开。
  register('file.open', {
    label: '打开文件…',
    category: 'File',
    run: function(arg) {
      var path = arg && typeof arg === 'object' ? arg.path : arg;
      if (typeof path === 'string' && path) {
        sendToRust('open_file', { path: path });
      } else {
        sendToRust('open_file');
      }
    }
  });

  // 打开可信项目根：有 path 时直接打开，无 path 时由 Rust 弹原生目录选择器。
  register('workspace.open', {
    label: '打开项目文件夹…',
    category: 'File',
    run: function(arg) {
      var path = arg && typeof arg === 'object' ? arg.path : arg;
      if (typeof path === 'string' && path) {
        sendToRust('workspace.open', { path: path });
      } else {
        sendToRust('workspace.open');
      }
    }
  });

  // ---- 绑定入口按钮 ----
  // #btn-open 在 app.js 中已有旧监听器，克隆替换以避免重复打开对话框。
  function bindButton(id, command, replaceExisting) {
    var btn = document.getElementById(id);
    if (!btn) return;
    if (replaceExisting && btn.parentNode && typeof btn.cloneNode === 'function') {
      var clone = btn.cloneNode(true);
      btn.parentNode.replaceChild(clone, btn);
      btn = clone;
    }
    btn.addEventListener('click', function(event) {
      event.preventDefault();
      run(command);
    });
  }

  register('settings.toggle', {
    label: '设置',
    run: function() {
      if (window.SettingsUI && typeof window.SettingsUI.toggle === 'function') {
        return window.SettingsUI.toggle();
      }
    }
  });

  bindButton('btn-open', 'workspace.open', true);
  bindButton('btn-open-file', 'file.open', false);
  bindButton('btn-settings', 'settings.toggle', false);

  window.Commands = {
    register: register,
    unregister: unregister,
    has: has,
    get: get,
    ids: ids,
    run: run
  };
})();
