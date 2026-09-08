// OverlayHelper — 轻量弹层行为基座
// 职责：
// 1. 弹层互斥管理（打开新弹层时自动关闭已打开的其他普通浮层）；
// 2. 焦点记忆与恢复（打开时记录 document.activeElement，关闭时恢复原焦点）；
// 3. 外部点击 / 失焦关闭（document 级 pointerdown 与 focusin 检测）；
// 4. 键盘导航列表项可视性（统一 scrollIntoView 封装）；
// 5. 零依赖，纯原生 JS，支持浏览器与 node:vm 测试环境。

(function () {
  'use strict';

  var activeOverlays = [];
  var registry = {};
  var isListenerAttached = false;

  function isDescendant(child, parent) {
    if (!child || !parent) return false;
    if (child === parent) return true;
    if (typeof parent.contains === 'function') {
      try {
        return parent.contains(child);
      } catch (e) {}
    }
    var curr = child.parentNode;
    while (curr) {
      if (curr === parent) return true;
      curr = curr.parentNode;
    }
    return false;
  }

  function handleDocumentPointer(e) {
    if (activeOverlays.length === 0) return;
    var top = activeOverlays[activeOverlays.length - 1];
    if (!top || typeof top.close !== 'function') return;

    var el = typeof top.getElement === 'function' ? top.getElement() : top.element;
    if (!el) return;

    var target = e.target;
    if (!target) return;

    // 如果点击目标在弹层内部，放行
    if (isDescendant(target, el)) {
      return;
    }

    // 如果点击在弹层外部，触发关闭
    try {
      top.close({ reason: 'outside-click', event: e });
    } catch (err) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('Error closing overlay on outside click:', err);
      }
    }
  }

  function handleDocumentFocus(e) {
    if (activeOverlays.length === 0) return;
    var top = activeOverlays[activeOverlays.length - 1];
    if (!top || typeof top.close !== 'function') return;

    var el = typeof top.getElement === 'function' ? top.getElement() : top.element;
    if (!el) return;

    var target = e.target;
    if (!target) return;

    // 如果焦点移至弹层内部，放行
    if (isDescendant(target, el)) {
      return;
    }

    // 焦点移出弹层外部，触发关闭
    try {
      top.close({ reason: 'focus-out', event: e });
    } catch (err) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('Error closing overlay on focus-out:', err);
      }
    }
  }

  function attachListeners() {
    if (isListenerAttached) return;
    if (typeof document === 'undefined' || !document.addEventListener) return;

    document.addEventListener('pointerdown', handleDocumentPointer, true);
    document.addEventListener('mousedown', handleDocumentPointer, true);
    document.addEventListener('focusin', handleDocumentFocus, true);
    isListenerAttached = true;
  }

  function register(id, descriptor) {
    if (!id || !descriptor) return;
    registry[id] = descriptor;
  }

  function unregister(id) {
    if (!id) return;
    delete registry[id];
  }

  function open(id, elementOrGetElement, closeFn, options) {
    attachListeners();
    options = options || {};

    // 互斥策略：如果不是嵌套/模态子弹层，先关闭其他已打开的浮层
    if (!options.allowMultiple) {
      var copy = activeOverlays.slice();
      for (var i = copy.length - 1; i >= 0; i--) {
        var item = copy[i];
        if (item && item.id !== id && typeof item.close === 'function') {
          try {
            item.close({ reason: 'mutual-exclusion', newOverlayId: id });
          } catch (e) {}
        }
      }
    }

    // 记录打开前的活动焦点元素
    var prevFocus = (typeof document !== 'undefined' && document.activeElement) ? document.activeElement : null;

    var getElement = typeof elementOrGetElement === 'function'
      ? elementOrGetElement
      : function () { return elementOrGetElement; };

    var entry = {
      id: id,
      getElement: getElement,
      close: closeFn,
      previousActiveElement: prevFocus,
      options: options
    };

    // 移除已有相同 ID 的条目
    activeOverlays = activeOverlays.filter(function (it) { return it.id !== id; });
    activeOverlays.push(entry);

    return entry;
  }

  function close(id, options) {
    options = options || {};
    var foundIndex = -1;
    for (var i = activeOverlays.length - 1; i >= 0; i--) {
      if (activeOverlays[i].id === id) {
        foundIndex = i;
        break;
      }
    }

    if (foundIndex === -1) return null;
    var entry = activeOverlays[foundIndex];
    activeOverlays.splice(foundIndex, 1);

    // 焦点恢复
    if (options.restoreFocus !== false && entry.previousActiveElement) {
      var elToFocus = entry.previousActiveElement;
      if (typeof elToFocus.focus === 'function') {
        try {
          elToFocus.focus();
        } catch (e) {}
      }
    }

    return entry;
  }

  function scrollIntoView(element, options) {
    if (!element) return;
    if (typeof element.scrollIntoView === 'function') {
      try {
        element.scrollIntoView(options || { block: 'nearest', inline: 'nearest' });
      } catch (e) {
        try {
          element.scrollIntoView(false);
        } catch (e2) {}
      }
    }
  }

  function getActiveOverlay() {
    return activeOverlays.length > 0 ? activeOverlays[activeOverlays.length - 1] : null;
  }

  function getActiveOverlays() {
    return activeOverlays.slice();
  }

  function reset() {
    activeOverlays = [];
    registry = {};
  }

  var OverlayHelper = {
    register: register,
    unregister: unregister,
    open: open,
    close: close,
    scrollIntoView: scrollIntoView,
    getActiveOverlay: getActiveOverlay,
    getActiveOverlays: getActiveOverlays,
    isDescendant: isDescendant,
    reset: reset,
    _handleDocumentPointer: handleDocumentPointer,
    _handleDocumentFocus: handleDocumentFocus
  };

  if (typeof window !== 'undefined') {
    window.OverlayHelper = OverlayHelper;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OverlayHelper;
  }
})();
