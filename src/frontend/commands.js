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
    registry[id] = { label: String(definition.label || id), run: definition.run };
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

  // 与原 #btn-open 点击行为完全等效：无 path 的 open_file 由 Rust 弹出打开对话框。
  register('file.open', {
    label: '打开文件…',
    run: function() {
      sendToRust('open_file');
    }
  });

  // 打开可信项目根：有 path 时直接打开，无 path 时由 Rust 弹原生目录选择器。
  register('workspace.open', {
    label: '打开项目文件夹…',
    run: function(arg) {
      var path = arg && typeof arg === 'object' ? arg.path : arg;
      if (typeof path === 'string' && path) {
        sendToRust('workspace.open', { path: path });
      } else {
        sendToRust('workspace.open');
      }
    }
  });

  // ---- 接管既有"打开文件"按钮 ----
  // app.js 启动时已给 #btn-open 绑定过 click（匿名监听器无法摘除），这里用克隆
  // 节点替换原节点：addEventListener 监听器不随克隆复制，旧绑定随之失效，
  // 再由命令注册表重新绑定。不改 app.js / index.html。
  function takeoverOpenButton() {
    var btn = document.getElementById('btn-open');
    if (!btn || !btn.parentNode) {
      return;
    }
    var clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);
    clone.title = 'Open Folder';
    clone.setAttribute && clone.setAttribute('aria-label', 'Open Folder');
    clone.addEventListener('click', function(event) {
      event.preventDefault();
      run('workspace.open');
    });
  }

  takeoverOpenButton();

  window.Commands = {
    register: register,
    unregister: unregister,
    has: has,
    get: get,
    ids: ids,
    run: run
  };
})();
