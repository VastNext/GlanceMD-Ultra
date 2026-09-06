// 运行时快捷键分派单例 —— window.Keybindings 与 window.BindingService 实例集成
(function (root) {
  'use strict';

  var KEY = 'glancemd-ultra-keybindings';
  var SCHEME_KEY = 'glancemd-ultra-keyboard-scheme';

  // 确保全局 ContextKeyService 存在
  if (!root.contextKeys && root.ContextKeyService) {
    root.contextKeys = new root.ContextKeyService();
  }

  // 命令桥接：BindingService 调用 commandId 时转调 window.Commands
  var commandBridge = new Proxy({}, {
    get: function(_, prop) {
      return function(binding) {
        if (root.Commands && typeof root.Commands.run === 'function') {
          return root.Commands.run(prop, binding && binding.args);
        }
      };
    },
    has: function(_, prop) {
      return Boolean(root.Commands && typeof root.Commands.has === 'function' && root.Commands.has(prop));
    }
  });

  // 实例化全局 BindingService
  var platformName = (typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '')) ? 'Mac' : 'Windows';
  var service = root.BindingService && typeof root.BindingService === 'function'
    ? new root.BindingService({
        commands: commandBridge,
        context: root.contextKeys,
        platform: platformName,
        scheme: loadSavedScheme()
      })
    : null;

  function loadSavedScheme() {
    try {
      return localStorage.getItem(SCHEME_KEY) || 'ultra.eclipse';
    } catch (e) {
      return 'ultra.eclipse';
    }
  }

  function loadOverrides() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function syncOverrides() {
    if (!service) return;
    var raw = loadOverrides();
    service.setOverrides(raw);
  }

  syncOverrides();

  // 统一的全局 Keydown 分派
  function dispatch(e) {
    if (!service) return null;
    // 快捷键录制器激活时不分发
    if (root.contextKeys && root.contextKeys.get('keybindingRecording')) {
      return null;
    }
    // 文本输入控件保护：仅放行显式声明了允许在输入框中触发的命令
    var inInput = e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
    if (inInput) {
      if (root.contextKeys) root.contextKeys.set('inputFocus', true);
    } else {
      if (root.contextKeys) root.contextKeys.remove('inputFocus');
    }

    var result = service.dispatch(e);
    if (result && result.status === 'matched') {
      return result.binding ? result.binding.commandId : null;
    }
    return null;
  }

  document.addEventListener('keydown', dispatch);

  // 向后兼容接口，供旧设置页与现有单元测试平滑调用
  var facade = {
    service: service,
    get defaults() {
      var scheme = service ? service.getScheme() : 'ultra.eclipse';
      var rows = (root.DefaultKeybindings && root.DefaultKeybindings.schemes && root.DefaultKeybindings.schemes[scheme]) || [];
      var map = {};
      rows.forEach(function(b) { if (b.commandId && b.sequence) map[b.commandId] = b.sequence; });
      return map;
    },
    load: loadOverrides,
    effective: function() {
      if (!service) return {};
      var bindings = service.getBindings();
      var out = {};
      bindings.forEach(function(b) {
        if (b.commandId && b.sequence) out[b.commandId] = b.sequence;
      });
      return out;
    },
    overrides: function() {
      if (!service) return {};
      var raw = service.getOverrides();
      var out = {};
      Object.keys(raw).forEach(function(id) {
        var list = raw[id];
        if (Array.isArray(list) && list.length && !list[0].removed) {
          out[id] = list[0].sequence;
        }
      });
      return out;
    },
    save: function(map) {
      if (!service) return false;
      service.saveOverrides(map || {});
      return true;
    },
    clear: function() {
      if (!service) return;
      service.clearOverrides();
    },
    setScheme: function(id) {
      if (!service) return;
      service.setScheme(id);
      try {
        localStorage.setItem(SCHEME_KEY, id);
      } catch (e) {}
      // 触发全局 scheme 变更事件
      try {
        window.dispatchEvent(new CustomEvent('scheme-changed', { detail: { schemeId: id } }));
      } catch (e) {}
    },
    getScheme: function() {
      return service ? service.getScheme() : 'ultra.eclipse';
    },
    normalize: function(e) {
      return root.KeybindingParser ? root.KeybindingParser.stroke(e) : '';
    },
    dispatch: dispatch
  };

  root.Keybindings = facade;
  if (service) {
    root.BindingServiceInstance = service;
    // 同时把已构造的单例赋值给全局 BindingService 供 UI 模块直接消费
    root.BindingService = service;
  }
})(typeof window !== 'undefined' ? window : globalThis);
