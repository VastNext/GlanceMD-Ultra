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
  register('settings.keybindings', {
    label: '打开快捷键设置', category: 'Settings',
    run: function() {
      if (window.SettingsUI && typeof window.SettingsUI.open === 'function') {
        window.SettingsUI.open();
        if (typeof window.SettingsUI.setCategory === 'function') {
          window.SettingsUI.setCategory('keybindings');
        }
        if (window.SettingsUI.refresh && typeof window.SettingsUI.refresh === 'function') window.SettingsUI.refresh();
      }
    }
  });

  // 这些导航命令在模块装载前注册，执行时再解析模块，避免初始化时序丢失快捷键。
  register('outline.focus', {
    label: '切换并聚焦大纲', category: 'Navigation',
    run: function() {
      if (!window.Outline) return undefined;
      if (typeof window.Outline.isOpen === 'function' && window.Outline.isOpen()) {
        return typeof window.Outline.hide === 'function' ? window.Outline.hide() : undefined;
      }
      return typeof window.Outline.focus === 'function' ? window.Outline.focus() : undefined;
    }
  });
  register('resource.open', {
    label: '打开资源/文件…', category: 'Navigation',
    run: function() {
      if (window.QuickOpen && typeof window.QuickOpen.toggle === 'function') return window.QuickOpen.toggle('file');
      if (window.QuickOpen && typeof window.QuickOpen.open === 'function') return window.QuickOpen.open('file');
    }
  });
  register('editor.focus', {
    label: '聚焦编辑器', category: 'Navigation',
    run: function() {
      var editor = document.getElementById('editor');
      if (editor && typeof editor.focus === 'function') {
        editor.focus();
        editor.classList.remove('vim-focus-flash');
        void editor.offsetWidth;
        editor.classList.add('vim-focus-flash');
        setTimeout(function() { editor.classList.remove('vim-focus-flash'); }, 700);
        return editor;
      }
    }
  });
  register('focus.next', {
    label: '聚焦下一个区域', category: 'Navigation',
    run: function() { return focusWorkspace(1); }
  });
  register('focus.previous', {
    label: '聚焦上一个区域', category: 'Navigation',
    run: function() { return focusWorkspace(-1); }
  });

  function focusableElement(id) {
    var e = document.getElementById(id);
    if (!e || typeof e.focus !== 'function') return null;
    if (e.hidden || (e.closest && e.closest('[hidden]'))) return null;
    var node = e;
    while (node && node !== document.body) {
      if (typeof window.getComputedStyle === 'function') {
        var style = window.getComputedStyle(node);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return null;
      }
      node = node.parentElement;
    }
    if (typeof e.getBoundingClientRect === 'function') {
      var rect = e.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    }
    return e;
  }
  var focusTargets = [
    { key: 'projectTreeFocus', get: function() { var e=focusableElement('project-tree-root'); return e ? function(){ if(!e.hasAttribute('tabindex'))e.setAttribute('tabindex','0'); e.focus(); } : null; } },
    { key: 'outlineFocus', get: function() { var e=focusableElement('outline-list')||focusableElement('outline-root'); return e && window.Outline && window.Outline.isOpen && window.Outline.isOpen() ? function(){e.focus();} : null; } },
    { key: 'editorTextFocus', get: function() { var e = focusableElement('editor'); return e ? function() { e.focus(); } : null; } },
    { key: 'previewFocus', get: function() { var e = focusableElement('preview'); return e ? function() { if(!e.hasAttribute('tabindex'))e.setAttribute('tabindex','0'); e.focus(); } : null; } },
    { key: 'settingsFocus', get: function() { var e=focusableElement('settings-filter'); return e ? function(){e.focus();} : null; } }
  ];
  function focusWorkspace(direction) {
    var current = -1;
    for (var i = 0; i < focusTargets.length; i++) {
      if (window.contextKeys && window.contextKeys.get(focusTargets[i].key)) { current = i; break; }
    }
    for (var step = 1; step <= focusTargets.length; step++) {
      var index = (current + direction * step + focusTargets.length * 2) % focusTargets.length;
      var focus = focusTargets[index].get();
      if (typeof focus === 'function') {
        focus();
        var targetEl = document.activeElement;
        if (targetEl && targetEl.classList) {
          targetEl.classList.remove('vim-focus-flash');
          void targetEl.offsetWidth;
          targetEl.classList.add('vim-focus-flash');
          setTimeout(function() { targetEl.classList.remove('vim-focus-flash'); }, 700);
        }
        if (window.contextKeys) {
          focusTargets.forEach(function(target, n) { window.contextKeys.set(target.key, n === index); });
        }
        return index;
      }
    }
    return -1;
  }

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
