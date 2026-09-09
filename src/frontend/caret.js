// Custom Caret Module — window.CustomCaret
// 规范与契约：
// 1. 3 CSS px 竖线光标（普通编辑模式与 Vim Insert 模式共用）。
// 2. 主题适配：Light 主题深紫（#7c3aed），Dark 主题亮紫（#c084fc）。
// 3. 动态跟随：随字符输入、换行、textarea 滚动、字号/行高变更、zoom、窗口 resize、softwrap 准确跟随。
// 4. 动画与交互状态机：
//    - 连续输入中：保持常亮无闪烁（输入常亮）；
//    - 输入停止：防抖后恢复平滑呼吸闪烁（停止闪烁）；
//    - 光标重定位（点击/方向键/程序跳转）：保持常亮 1 秒后恢复闪烁（定位常亮 1s）；
//    - 编辑器失焦（blur）或存在非折叠选区（selectionStart !== selectionEnd）：隐藏自定义光标；
//    - 中文/日文 IME 输入法 Composition 期间：回退原生光标，隐藏自定义光标，不干扰输入法候选框定位；
//    - 测量异常/失败：优雅降级回退原生光标，绝不隐藏全部光标。

(function(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CustomCaret = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function() {
  'use strict';

  var state = {
    mounted: false,
    enabled: true,
    visible: false,
    isComposing: false,
    isTyping: false,
    typingTimer: null,
    relocateTimer: null,
    dom: {
      editor: null,
      container: null,
      caretEl: null,
      mirrorEl: null,
      markerSpan: null
    },
    listeners: [],
    lastOffset: 0
  };

  function addListener(target, event, handler, options) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(event, handler, options);
    state.listeners.push({ target: target, event: event, handler: handler });
  }

  function removeAllListeners() {
    state.listeners.forEach(function(item) {
      try {
        item.target.removeEventListener(item.event, item.handler);
      } catch (e) {}
    });
    state.listeners = [];
  }

  // 高精度计算 Textarea 指定 offset 的 2D 坐标（相对于容器及视口）
  function measureCoordinates(editor, offset, mirrorEl, markerSpan) {
    if (!editor || !editor.ownerDocument) return null;
    var doc = editor.ownerDocument;
    var win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    if (!win || typeof win.getComputedStyle !== 'function') return null;

    try {
      var cs = win.getComputedStyle(editor);
      var width = editor.clientWidth || parseFloat(cs.width) || 0;
      if (width <= 0) return null;

      // 同步排版与盒模型样式
      mirrorEl.style.position = 'absolute';
      mirrorEl.style.top = '0';
      mirrorEl.style.left = '0';
      mirrorEl.style.visibility = 'hidden';
      mirrorEl.style.pointerEvents = 'none';
      mirrorEl.style.zIndex = '-999';
      mirrorEl.style.fontFamily = cs.fontFamily;
      mirrorEl.style.fontSize = cs.fontSize;
      mirrorEl.style.fontWeight = cs.fontWeight;
      mirrorEl.style.fontStyle = cs.fontStyle;
      mirrorEl.style.fontStretch = cs.fontStretch || 'normal';
      mirrorEl.style.letterSpacing = cs.letterSpacing;
      mirrorEl.style.lineHeight = cs.lineHeight;
      mirrorEl.style.tabSize = cs.tabSize || cs.MozTabSize || '4';
      mirrorEl.style.whiteSpace = cs.whiteSpace || 'pre-wrap';
      mirrorEl.style.overflowWrap = cs.overflowWrap || 'break-word';
      mirrorEl.style.wordBreak = cs.wordBreak || 'break-word';
      mirrorEl.style.boxSizing = cs.boxSizing || 'border-box';
      mirrorEl.style.paddingTop = cs.paddingTop;
      mirrorEl.style.paddingRight = cs.paddingRight;
      mirrorEl.style.paddingBottom = cs.paddingBottom;
      mirrorEl.style.paddingLeft = cs.paddingLeft;
      mirrorEl.style.borderTopWidth = cs.borderTopWidth;
      mirrorEl.style.borderRightWidth = cs.borderRightWidth;
      mirrorEl.style.borderBottomWidth = cs.borderBottomWidth;
      mirrorEl.style.borderLeftWidth = cs.borderLeftWidth;
      mirrorEl.style.borderStyle = 'solid';
      mirrorEl.style.width = width + 'px';

      var text = String(editor.value || '');
      var pos = Math.max(0, Math.min(Number(offset) || 0, text.length));
      var before = text.slice(0, pos);
      var charUnder = text.charAt(pos);
      var after = text.slice(pos + 1);

      mirrorEl.textContent = '';
      mirrorEl.appendChild(doc.createTextNode(before));

      markerSpan.textContent = (!charUnder || charUnder === '\n') ? '\u200b' : charUnder;
      mirrorEl.appendChild(markerSpan);

      if (after) {
        mirrorEl.appendChild(doc.createTextNode(after));
      }

      var markerLeft = markerSpan.offsetLeft || 0;
      var markerTop = markerSpan.offsetTop || 0;
      var markerW = markerSpan.offsetWidth || 8.5;
      var markerH = markerSpan.offsetHeight || parseFloat(cs.lineHeight) || 20;

      var edOffsetLeft = editor.offsetLeft || 0;
      var edOffsetTop = editor.offsetTop || 0;
      var sLeft = editor.scrollLeft || 0;
      var sTop = editor.scrollTop || 0;

      var posX = edOffsetLeft + markerLeft - sLeft;
      var posY = edOffsetTop + markerTop - sTop;

      return {
        left: posX,
        top: posY,
        markerLeft: markerLeft,
        markerTop: markerTop,
        width: markerW,
        height: markerH,
        charUnder: charUnder,
        lineHeight: parseFloat(cs.lineHeight) || markerH
      };
    } catch (err) {
      return null;
    }
  }

  function setNativeCaretVisible(visible) {
    var ed = state.dom.editor;
    if (!ed) return;
    if (visible) {
      ed.classList.remove('custom-caret-active');
      ed.style.caretColor = '';
    } else {
      ed.classList.add('custom-caret-active');
      ed.style.caretColor = 'transparent';
    }
  }

  // 状态机更新与渲染
  function update() {
    if (!state.mounted || !state.dom.editor || !state.dom.caretEl) return;
    var ed = state.dom.editor;
    var caretEl = state.dom.caretEl;

    // 1. 禁用或失焦或 IME composition 期间隐藏
    var doc = ed.ownerDocument || document;
    var isFocused = doc.activeElement === ed;
    var selStart = ed.selectionStart;
    var selEnd = ed.selectionEnd;
    var hasRangeSelection = (selStart !== selEnd);

    if (!state.enabled || !isFocused || hasRangeSelection || state.isComposing) {
      caretEl.style.display = 'none';
      if (state.isComposing) {
        // IME 组合中恢复原生光标，确保候选框准确定位
        setNativeCaretVisible(true);
      }
      return;
    }

    var pos = selStart || 0;
    state.lastOffset = pos;

    var coords = measureCoordinates(ed, pos, state.dom.mirrorEl, state.dom.markerSpan);
    if (!coords) {
      // 测量失败兜底恢复原生光标
      caretEl.style.display = 'none';
      setNativeCaretVisible(true);
      return;
    }

    // 测量成功，隐藏原生光标
    setNativeCaretVisible(false);

    // 检查视口裁剪
    var edLeft = ed.offsetLeft || 0;
    var edTop = ed.offsetTop || 0;
    var edW = ed.clientWidth || 0;
    var edH = ed.clientHeight || 0;

    if (coords.left < edLeft - 5 || coords.left > edLeft + edW + 5 ||
        coords.top < edTop - coords.height || coords.top > edTop + edH + coords.height) {
      caretEl.style.display = 'none';
      return;
    }

    caretEl.style.display = 'block';
    caretEl.style.left = coords.left + 'px';
    caretEl.style.top = coords.top + 'px';
    caretEl.style.height = coords.height + 'px';
  }

  // 输入常亮交互（输入时不闪烁，停止后恢复闪烁）
  function triggerTyping() {
    if (!state.dom.caretEl) return;
    var caretEl = state.dom.caretEl;
    caretEl.classList.add('custom-caret-solid');
    caretEl.classList.remove('custom-caret-blink');

    clearTimeout(state.typingTimer);
    clearTimeout(state.relocateTimer);

    state.isTyping = true;
    update();

    state.typingTimer = setTimeout(function() {
      state.isTyping = false;
      if (caretEl) {
        caretEl.classList.remove('custom-caret-solid');
        caretEl.classList.add('custom-caret-blink');
      }
    }, 500);
  }

  // 定位常亮交互（点击/方向键/选区改变后常亮 1 秒，再恢复闪烁）
  function triggerRelocated() {
    if (!state.dom.caretEl) return;
    var caretEl = state.dom.caretEl;
    caretEl.classList.add('custom-caret-solid');
    caretEl.classList.remove('custom-caret-blink');

    clearTimeout(state.typingTimer);
    clearTimeout(state.relocateTimer);

    update();

    state.relocateTimer = setTimeout(function() {
      if (caretEl) {
        caretEl.classList.remove('custom-caret-solid');
        caretEl.classList.add('custom-caret-blink');
      }
    }, 1000);
  }

  function mount(options) {
    options = options || {};
    if (state.mounted) {
      unmount();
    }

    var editor = options.editor;
    if (typeof editor === 'string') {
      editor = document.querySelector(editor);
    }
    if (!editor) {
      editor = document.getElementById('editor');
    }
    if (!editor) return CustomCaret;

    var container = options.container;
    if (typeof container === 'string') {
      container = document.querySelector(container);
    }
    if (!container) {
      container = editor.parentNode || document.getElementById('editor-container') || document.body;
    }

    var doc = editor.ownerDocument || document;

    // 1. 创建 3px 竖线光标 DOM
    var caretEl = doc.createElement('div');
    caretEl.id = 'custom-caret';
    caretEl.className = 'custom-caret custom-caret-blink';
    caretEl.setAttribute('aria-hidden', 'true');
    caretEl.style.display = 'none';
    container.appendChild(caretEl);

    // 2. 创建测量镜像 DOM
    var mirrorEl = doc.createElement('div');
    mirrorEl.className = 'custom-caret-mirror';
    mirrorEl.setAttribute('aria-hidden', 'true');
    container.appendChild(mirrorEl);

    var markerSpan = doc.createElement('span');
    markerSpan.className = 'custom-caret-marker';

    state.dom.editor = editor;
    state.dom.container = container;
    state.dom.caretEl = caretEl;
    state.dom.mirrorEl = mirrorEl;
    state.dom.markerSpan = markerSpan;
    state.mounted = true;
    state.enabled = options.enabled !== undefined ? !!options.enabled : true;

    // 3. 事件绑定
    addListener(editor, 'input', function() {
      triggerTyping();
    });

    addListener(editor, 'keydown', function(e) {
      if (e.isComposing) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
          e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') {
        setTimeout(triggerRelocated, 0);
      }
    });

    addListener(editor, 'click', function() {
      triggerRelocated();
    });

    addListener(editor, 'focus', function() {
      triggerRelocated();
    });

    addListener(editor, 'blur', function() {
      if (state.dom.caretEl) state.dom.caretEl.style.display = 'none';
      setNativeCaretVisible(true);
    });

    addListener(editor, 'scroll', function() {
      update();
    });

    addListener(editor, 'select', function() {
      update();
    });

    if (doc) {
      addListener(doc, 'selectionchange', function() {
        if (doc.activeElement === editor) {
          update();
        }
      });
    }

    var win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    if (win) {
      addListener(win, 'resize', function() {
        update();
      });
    }

    // IME Composition 处理：compositionstart / compositionupdate / compositionend
    addListener(editor, 'compositionstart', function() {
      state.isComposing = true;
      if (state.dom.caretEl) state.dom.caretEl.style.display = 'none';
      setNativeCaretVisible(true);
    });

    addListener(editor, 'compositionupdate', function() {
      state.isComposing = true;
      if (state.dom.caretEl) state.dom.caretEl.style.display = 'none';
      setNativeCaretVisible(true);
    });

    addListener(editor, 'compositionend', function() {
      state.isComposing = false;
      setNativeCaretVisible(false);
      triggerRelocated();
    });

    update();
    return CustomCaret;
  }

  function unmount() {
    removeAllListeners();
    clearTimeout(state.typingTimer);
    clearTimeout(state.relocateTimer);

    if (state.dom.caretEl && state.dom.caretEl.parentNode) {
      state.dom.caretEl.parentNode.removeChild(state.dom.caretEl);
    }
    if (state.dom.mirrorEl && state.dom.mirrorEl.parentNode) {
      state.dom.mirrorEl.parentNode.removeChild(state.dom.mirrorEl);
    }

    setNativeCaretVisible(true);

    state.mounted = false;
    state.isComposing = false;
    state.dom = {
      editor: null,
      container: null,
      caretEl: null,
      mirrorEl: null,
      markerSpan: null
    };
    return CustomCaret;
  }

  function setEnabled(val) {
    state.enabled = Boolean(val);
    if (!state.enabled) {
      if (state.dom.caretEl) state.dom.caretEl.style.display = 'none';
      setNativeCaretVisible(true);
    } else {
      update();
    }
    return CustomCaret;
  }

  var CustomCaret = {
    mount: mount,
    unmount: unmount,
    update: update,
    setEnabled: setEnabled,
    triggerTyping: triggerTyping,
    triggerRelocated: triggerRelocated,
    measureCoordinates: function(offset) {
      if (!state.dom.editor) return null;
      return measureCoordinates(state.dom.editor, offset, state.dom.mirrorEl, state.dom.markerSpan);
    },
    getState: function() {
      return {
        mounted: state.mounted,
        enabled: state.enabled,
        isComposing: state.isComposing,
        isTyping: state.isTyping,
        lastOffset: state.lastOffset
      };
    }
  };

  return CustomCaret;
});
