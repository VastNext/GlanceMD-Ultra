// Workspace 事件分发器（前端，阶段 0）—— window.Workspace
// 契约唯一事实源：docs/dev/interfaces.md。
// Rust → JS 下行统一走 window.__fromRust(event, data)：app.js 定义了既有 handler，
// 本模块在其后加载，先保存既有 handler 再重写 __fromRust —— workspace:* 事件走
// 内部分发器（供项目树/搜索等后续模块订阅），其余事件透传既有 handler；
// 若 __fromRust 尚不存在（异常装载顺序）则兜底自建。
(function() {
  'use strict';

  var subscribers = {};
  var state = { root: null, fileCount: null, error: null };
  var statusEl = null;

  function on(event, handler) {
    if (typeof handler !== 'function') {
      return function() {};
    }
    if (!subscribers[event]) {
      subscribers[event] = [];
    }
    subscribers[event].push(handler);
    return function() {
      off(event, handler);
    };
  }

  function off(event, handler) {
    var list = subscribers[event];
    if (!list) {
      return;
    }
    var index = list.indexOf(handler);
    if (index !== -1) {
      list.splice(index, 1);
    }
  }

  function dispatch(event, data) {
    var handler = handlers[event];
    if (handler) {
      handler(data);
    }
    var list = subscribers[event] || [];
    // 拷贝后再遍历，允许订阅者在回调里退订
    list.slice().forEach(function(fn) {
      fn(data);
    });
  }

  function getState() {
    return {
      root: state.root,
      fileCount: state.fileCount,
      error: state.error
    };
  }

  // ---- 状态栏呈现 ----
  // index.html 的 #statusbar 内 #status-info 被 "Saved"/"Error" 短暂占用并定时清空，
  // workspace 信息使用独立的 #status-workspace span，避免互相覆盖（不改 index.html）。
  function ensureStatusElement() {
    if (statusEl) {
      return statusEl;
    }
    var bar = document.getElementById('statusbar');
    if (!bar) {
      return null;
    }
    statusEl = document.getElementById('status-workspace');
    if (!statusEl) {
      statusEl = document.createElement('span');
      statusEl.id = 'status-workspace';
      bar.appendChild(statusEl);
    }
    return statusEl;
  }

  function render() {
    var el = ensureStatusElement();
    if (!el) {
      return;
    }
    if (state.error) {
      el.textContent = 'Workspace 错误：' + state.error;
      el.style.color = '#c15050';
      return;
    }
    if (state.root === null) {
      return;
    }
    var text = '项目：' + state.root;
    if (state.fileCount !== null && state.fileCount !== undefined) {
      text += '（' + state.fileCount + ' 个文件）';
    }
    el.style.color = '';
    el.textContent = text;
  }

  var handlers = {
    'workspace:opened': function(data) {
      state.root = (data && data.root) || '';
      state.fileCount = data && typeof data.file_count === 'number' ? data.file_count : null;
      state.error = null;
      render();
    },
    'workspace:scan-progress': function(data) {
      if (data && typeof data.scanned === 'number') {
        state.fileCount = data.scanned;
        render();
      }
    },
    'workspace:error': function(data) {
      state.error = (data && data.message) || '未知错误';
      render();
    }
  };

  // ---- __fromRust 包装 ----
  var previousHandler = typeof window.__fromRust === 'function' ? window.__fromRust : null;

  function fromRust(event, data) {
    if (typeof event === 'string' && event.indexOf('workspace:') === 0) {
      dispatch(event, data);
      return;
    }
    if (previousHandler) {
      previousHandler(event, data);
    }
  }

  window.__fromRust = fromRust;

  window.Workspace = {
    on: on,
    off: off,
    dispatch: dispatch,
    getState: getState
  };
})();
