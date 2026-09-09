// Vim Mode UI & Visual Adaptation Component —— window.VimUI
// 契约与规范：
// 1. 状态栏模式展示组件：支持在状态栏 (#statusbar) 显示 -- NORMAL --, -- INSERT --, -- VISUAL --, -- VISUAL LINE --, -- COMMAND -- 等，
//    以及 pending count / operator / macro recording / key buffer 徽章。
// 2. 光标与选区样式联动：在关联的宿主容器/编辑器上应用 .vim-mode-active, .vim-normal-mode, .vim-visual-mode 等类，
//    支持精确测量的 .vim-block-cursor 方块光标指示与紫粉高亮选区，并随滚动/resize/字体设置同步。
// 3. 命令行输入底栏/浮层：支持 showCommandLine(options) 弹出 Ex 命令行 / 搜索栏，支持 prompt (:, /, ?)、实时按键显示、Enter 提交、Esc 取消。
// 4. 提供完整生命周期与控制 API：VimUI.mount(options), VimUI.update(state), VimUI.unmount(), VimUI.showCommandLine(options), VimUI.hideCommandLine()。
// 5. 国际化支持：优先从 window.I18n 获取文案，内建中英文双语字典回退，监听 'i18n-changed' 动态刷新。

(function (root) {
  'use strict';

  var FALLBACK_LOCALES = {
    'zh-CN': {
      'vim.mode.normal': '-- 普通 --',
      'vim.mode.insert': '-- 插入 --',
      'vim.mode.visual': '-- 可视 --',
      'vim.mode.visualLine': '-- 可视行 --',
      'vim.mode.visualBlock': '-- 可视块 --',
      'vim.mode.replace': '-- 替换 --',
      'vim.mode.command': '-- 命令 --',

      'vim.modeLabel.normal': '-- NORMAL --',
      'vim.modeLabel.insert': '-- INSERT --',
      'vim.modeLabel.visual': '-- VISUAL --',
      'vim.modeLabel.visualLine': '-- VISUAL LINE --',
      'vim.modeLabel.visualBlock': '-- VISUAL BLOCK --',
      'vim.modeLabel.replace': '-- REPLACE --',
      'vim.modeLabel.command': '-- COMMAND --',

      'vim.hint.normal': '[VIM] 普通模式（按 i 进入编辑）',
      'vim.hint.insert': '[VIM] 编辑模式（按 Esc 返回普通模式）',
      'vim.hint.visual': '[VIM] 可视模式（按 Esc 返回普通模式）',
      'vim.hint.visualLine': '[VIM] 可视行模式（按 Esc 返回普通模式）',
      'vim.hint.visualBlock': '[VIM] 可视块模式（按 Esc 返回普通模式）',
      'vim.hint.replace': '[VIM] 替换模式（按 Esc 返回普通模式）',
      'vim.hint.command': '[VIM] 命令行模式（按 Esc 取消）',

      'vim.toast.enter': '已进入 Vim 模式（普通模式）',
      'vim.toast.exit': '已退出 Vim 模式',

      'vim.status.recording': '录制中 @{reg}',
      'vim.status.count': '计数: {count}',
      'vim.status.operator': '操作符: {op}',
      'vim.status.keyBuffer': '待决按键: {keys}',

      'vim.command.placeholder': '输入 Ex 命令 (:w, :q, :wq)...',
      'vim.search.placeholder': '输入搜索模式 (Enter 查找, Esc 取消)...',

      'vim.aria.mode': 'Vim 模式指示器',
      'vim.aria.badges': 'Vim 待决状态徽章',
      'vim.aria.commandLine': 'Vim 命令行',
      'vim.aria.commandInput': 'Vim 命令行输入框',
      'vim.aria.completions': '命令补全建议列表'
    },
    'en': {
      'vim.mode.normal': '-- NORMAL --',
      'vim.mode.insert': '-- INSERT --',
      'vim.mode.visual': '-- VISUAL --',
      'vim.mode.visualLine': '-- VISUAL LINE --',
      'vim.mode.visualBlock': '-- VISUAL BLOCK --',
      'vim.mode.replace': '-- REPLACE --',
      'vim.mode.command': '-- COMMAND --',

      'vim.modeLabel.normal': '-- NORMAL --',
      'vim.modeLabel.insert': '-- INSERT --',
      'vim.modeLabel.visual': '-- VISUAL --',
      'vim.modeLabel.visualLine': '-- VISUAL LINE --',
      'vim.modeLabel.visualBlock': '-- VISUAL BLOCK --',
      'vim.modeLabel.replace': '-- REPLACE --',
      'vim.modeLabel.command': '-- COMMAND --',

      'vim.hint.normal': '[VIM] Normal mode (press i to edit)',
      'vim.hint.insert': '[VIM] Edit mode (press Esc for Normal)',
      'vim.hint.visual': '[VIM] Visual mode (press Esc for Normal)',
      'vim.hint.visualLine': '[VIM] Visual Line mode (press Esc for Normal)',
      'vim.hint.visualBlock': '[VIM] Visual Block mode (press Esc for Normal)',
      'vim.hint.replace': '[VIM] Replace mode (press Esc for Normal)',
      'vim.hint.command': '[VIM] Command mode (press Esc to cancel)',

      'vim.toast.enter': 'Entered Vim mode (Normal)',
      'vim.toast.exit': 'Exited Vim mode',

      'vim.status.recording': 'recording @{reg}',
      'vim.status.count': 'Count: {count}',
      'vim.status.operator': 'Operator: {op}',
      'vim.status.keyBuffer': 'Pending keys: {keys}',

      'vim.command.placeholder': 'Type Ex command (:w, :q, :wq)...',
      'vim.search.placeholder': 'Type search pattern (Enter to find, Esc to cancel)...',

      'vim.aria.mode': 'Vim Mode Indicator',
      'vim.aria.badges': 'Vim Pending Badges',
      'vim.aria.commandLine': 'Vim Command Line',
      'vim.aria.commandInput': 'Vim Command Input',
      'vim.aria.completions': 'Command Suggestions'
    }
  };

  function interpolate(text, params) {
    if (!params || typeof params !== 'object') return text;
    return String(text).replace(/\{(\w+)\}/g, function (whole, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole;
    });
  }

  function getLanguage() {
    if (root.I18n && typeof root.I18n.getLanguage === 'function') {
      return root.I18n.getLanguage() || 'zh-CN';
    }
    return 'zh-CN';
  }

  function t(key, params) {
    if (root.I18n && typeof root.I18n.t === 'function') {
      var res = root.I18n.t(key, params);
      if (res && res !== key) return res;
    }
    var lang = getLanguage();
    var dict = FALLBACK_LOCALES[lang] || FALLBACK_LOCALES['zh-CN'];
    var raw = (dict && dict[key]) || (FALLBACK_LOCALES['zh-CN'] && FALLBACK_LOCALES['zh-CN'][key]) || key;
    return interpolate(raw, params);
  }

  // 标准化模式名称
  function normalizeMode(mode) {
    if (!mode) return 'normal';
    var m = String(mode).toLowerCase().trim();
    if (m === 'visual-line' || m === 'visualline' || m === 'v-line' || m === 'v_line') return 'visual-line';
    if (m === 'visual-block' || m === 'visualblock' || m === 'v-block' || m === 'v_block') return 'visual-block';
    if (m === 'v' || m === 'visual') return 'visual';
    if (m === 'i' || m === 'insert') return 'insert';
    if (m === 'r' || m === 'replace') return 'replace';
    if (m === 'c' || m === ':' || m === 'cmd' || m === 'command' || m === 'commandline') return 'command';
    return 'normal';
  }

  // 获取模式标准展示文本与样式类
  var MODE_CONFIG = {
    'normal': {
      labelKey: 'vim.modeLabel.normal',
      nameKey: 'vim.mode.normal',
      hintKey: 'vim.hint.normal',
      cssClass: 'mode-normal',
      editorClass: 'vim-normal-mode',
      fallbackText: '-- NORMAL --',
      fallbackHint: '[VIM] 普通模式（按 i 进入编辑）'
    },
    'insert': {
      labelKey: 'vim.modeLabel.insert',
      nameKey: 'vim.mode.insert',
      hintKey: 'vim.hint.insert',
      cssClass: 'mode-insert',
      editorClass: 'vim-insert-mode',
      fallbackText: '-- INSERT --',
      fallbackHint: '[VIM] 编辑模式（按 Esc 返回普通模式）'
    },
    'visual': {
      labelKey: 'vim.modeLabel.visual',
      nameKey: 'vim.mode.visual',
      hintKey: 'vim.hint.visual',
      cssClass: 'mode-visual',
      editorClass: 'vim-visual-mode',
      fallbackText: '-- VISUAL --',
      fallbackHint: '[VIM] 可视模式（按 Esc 返回普通模式）'
    },
    'visual-line': {
      labelKey: 'vim.modeLabel.visualLine',
      nameKey: 'vim.mode.visualLine',
      hintKey: 'vim.hint.visualLine',
      cssClass: 'mode-visual-line',
      editorClass: 'vim-visual-line-mode',
      fallbackText: '-- VISUAL LINE --',
      fallbackHint: '[VIM] 可视行模式（按 Esc 返回普通模式）'
    },
    'visual-block': {
      labelKey: 'vim.modeLabel.visualBlock',
      nameKey: 'vim.mode.visualBlock',
      hintKey: 'vim.hint.visualBlock',
      cssClass: 'mode-visual-block',
      editorClass: 'vim-visual-block-mode',
      fallbackText: '-- VISUAL BLOCK --',
      fallbackHint: '[VIM] 可视块模式（按 Esc 返回普通模式）'
    },
    'replace': {
      labelKey: 'vim.modeLabel.replace',
      nameKey: 'vim.mode.replace',
      hintKey: 'vim.hint.replace',
      cssClass: 'mode-replace',
      editorClass: 'vim-replace-mode',
      fallbackText: '-- REPLACE --',
      fallbackHint: '[VIM] 替换模式（按 Esc 返回普通模式）'
    },
    'command': {
      labelKey: 'vim.modeLabel.command',
      nameKey: 'vim.mode.command',
      hintKey: 'vim.hint.command',
      cssClass: 'mode-command',
      editorClass: 'vim-command-mode',
      fallbackText: '-- COMMAND --',
      fallbackHint: '[VIM] 命令行模式（按 Esc 取消）'
    }
  };

  var state = {
    mounted: false,
    enabled: true,
    mode: 'normal',
    cursor: 0,
    commandLine: '',
    pendingCount: null,
    pendingOperator: null,
    keyBuffer: '',
    recordingRegister: null,
    statusMessage: '',
    statusMessageType: 'normal', // 'normal' | 'info' | 'error'
    commandLineOpen: false,
    commandPrompt: ':',
    commandValue: '',
    commandOptions: null,
    historyIndex: -1,
    selectedSuggestionIndex: -1,
    dom: {
      container: null,
      editorTarget: null,
      commandContainer: null,
      editorElement: null,
      statusWidget: null,
      modeBadge: null,
      badgesGroup: null,
      countBadge: null,
      operatorBadge: null,
      recordingBadge: null,
      keyBufferBadge: null,
      statusMessageEl: null,
      enabledHintEl: null,
      commandOverlay: null,
      cmdPromptEl: null,
      cmdInputEl: null,
      cmdSuggestionsEl: null,
      blockCursor: null,
      cursorMirror: null
    },
    previousActiveElement: null,
    listeners: []
  };

  function addEventListenerHelper(target, event, handler) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(event, handler);
    state.listeners.push({ target: target, event: event, handler: handler });
  }

  function removeAllListeners() {
    state.listeners.forEach(function (item) {
      try {
        item.target.removeEventListener(item.event, item.handler);
      } catch (e) {}
    });
    state.listeners = [];
  }

  // 渲染/刷新状态栏模式组件
  function renderStatusWidget() {
    if (!state.dom.statusWidget) return;

    var normalized = normalizeMode(state.mode);
    var conf = MODE_CONFIG[normalized] || MODE_CONFIG['normal'];

    // 1. 模式徽章
    if (state.dom.modeBadge) {
      state.dom.modeBadge.className = 'vim-mode-badge ' + conf.cssClass;
      var label = t(conf.labelKey) || conf.fallbackText;
      state.dom.modeBadge.textContent = label;
      state.dom.modeBadge.setAttribute('title', t(conf.nameKey) || label);
      state.dom.modeBadge.setAttribute('aria-label', t('vim.aria.mode') + ': ' + label);
    }

    // 2. Pending Count 徽章
    if (state.dom.countBadge) {
      if (state.pendingCount !== null && state.pendingCount !== undefined && state.pendingCount !== '') {
        state.dom.countBadge.textContent = String(state.pendingCount);
        state.dom.countBadge.style.display = 'inline-flex';
        state.dom.countBadge.setAttribute('title', t('vim.status.count', { count: state.pendingCount }));
      } else {
        state.dom.countBadge.style.display = 'none';
        state.dom.countBadge.textContent = '';
      }
    }

    // 3. Pending Operator 徽章
    if (state.dom.operatorBadge) {
      if (state.pendingOperator) {
        state.dom.operatorBadge.textContent = String(state.pendingOperator);
        state.dom.operatorBadge.style.display = 'inline-flex';
        state.dom.operatorBadge.setAttribute('title', t('vim.status.operator', { op: state.pendingOperator }));
      } else {
        state.dom.operatorBadge.style.display = 'none';
        state.dom.operatorBadge.textContent = '';
      }
    }

    // 4. Macro Recording 徽章
    if (state.dom.recordingBadge) {
      if (state.recordingRegister) {
        var recText = t('vim.status.recording', { reg: state.recordingRegister });
        state.dom.recordingBadge.innerHTML = '<span class="vim-recording-dot"></span><span class="vim-recording-text">' +
          escapeHtml(recText) + '</span>';
        state.dom.recordingBadge.style.display = 'inline-flex';
        state.dom.recordingBadge.setAttribute('title', recText);
      } else {
        state.dom.recordingBadge.style.display = 'none';
        state.dom.recordingBadge.innerHTML = '';
      }
    }

    // 5. Key Buffer 徽章
    if (state.dom.keyBufferBadge) {
      if (state.keyBuffer) {
        state.dom.keyBufferBadge.textContent = String(state.keyBuffer);
        state.dom.keyBufferBadge.style.display = 'inline-flex';
        state.dom.keyBufferBadge.setAttribute('title', t('vim.status.keyBuffer', { keys: state.keyBuffer }));
      } else {
        state.dom.keyBufferBadge.style.display = 'none';
        state.dom.keyBufferBadge.textContent = '';
      }
    }

    // 6. 状态消息
    if (state.dom.statusMessageEl) {
      if (state.statusMessage) {
        state.dom.statusMessageEl.textContent = state.statusMessage;
        state.dom.statusMessageEl.className = 'vim-status-message' +
          (state.statusMessageType === 'error' ? ' is-error' : '') +
          (state.statusMessageType === 'info' ? ' is-info' : '');
        state.dom.statusMessageEl.style.display = 'inline-block';
      } else {
        state.dom.statusMessageEl.textContent = '';
        state.dom.statusMessageEl.style.display = 'none';
      }
    }

    // 6.5 常驻提示文案联动当前模式
    if (state.dom.enabledHintEl) {
      var hintKey = conf.hintKey || 'vim.hint.normal';
      var hintText = t(hintKey) || conf.fallbackHint || '[VIM] 普通模式（按 i 进入编辑）';
      state.dom.enabledHintEl.textContent = hintText;
      state.dom.enabledHintEl.className = 'vim-enabled-hint vim-persistent-hint ' + (conf.cssClass || 'mode-normal');
    }

    // 7. 同步 Editor 容器的模式 CSS 类
    syncEditorClasses();

    // 8. 同步方块光标位置
    updateBlockCursorPosition();
  }

  // 同步 editorTarget 上的模式样式类
  function syncEditorClasses() {
    var el = state.dom.editorTarget;
    if (!el || !el.classList) return;

    if (!state.enabled) {
      el.classList.remove('vim-mode-active');
      Object.keys(MODE_CONFIG).forEach(function (k) {
        el.classList.remove(MODE_CONFIG[k].editorClass);
      });
      return;
    }

    el.classList.add('vim-mode-active');
    var normalized = normalizeMode(state.mode);

    Object.keys(MODE_CONFIG).forEach(function (k) {
      if (k === normalized) {
        el.classList.add(MODE_CONFIG[k].editorClass);
      } else {
        el.classList.remove(MODE_CONFIG[k].editorClass);
      }
    });
  }

  // 计算并同步方块光标位置
  function updateBlockCursorPosition() {
    var cursorEl = state.dom.blockCursor;
    var mirrorEl = state.dom.cursorMirror;
    var editorEl = state.dom.editorElement;
    if (!cursorEl || !editorEl) return;

    var normalized = normalizeMode(state.mode);
    if (!state.enabled || normalized === 'insert') {
      cursorEl.style.display = 'none';
      if (root.CustomCaret && typeof root.CustomCaret.update === 'function') {
        root.CustomCaret.update();
      }
      return;
    }

    var doc = editorEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc || !mirrorEl) return;

    var text = String(editorEl.value || '');
    var pos = typeof state.cursor === 'number' ? state.cursor : (editorEl.selectionStart || 0);
    pos = Math.max(0, Math.min(pos, text.length));

    // 同步 textarea 样式到 mirror 元素
    var win = doc.defaultView || root;
    if (win && typeof win.getComputedStyle === 'function') {
      try {
        var cs = win.getComputedStyle(editorEl);
        mirrorEl.style.fontFamily = cs.fontFamily;
        mirrorEl.style.fontSize = cs.fontSize;
        mirrorEl.style.fontWeight = cs.fontWeight;
        mirrorEl.style.fontStyle = cs.fontStyle;
        mirrorEl.style.letterSpacing = cs.letterSpacing;
        mirrorEl.style.lineHeight = cs.lineHeight;
        mirrorEl.style.paddingTop = cs.paddingTop;
        mirrorEl.style.paddingRight = cs.paddingRight;
        mirrorEl.style.paddingBottom = cs.paddingBottom;
        mirrorEl.style.paddingLeft = cs.paddingLeft;
        mirrorEl.style.borderTopWidth = cs.borderTopWidth;
        mirrorEl.style.borderLeftWidth = cs.borderLeftWidth;
        mirrorEl.style.borderRightWidth = cs.borderRightWidth;
        mirrorEl.style.borderBottomWidth = cs.borderBottomWidth;
        mirrorEl.style.boxSizing = cs.boxSizing;
        mirrorEl.style.whiteSpace = cs.whiteSpace || 'pre-wrap';
        mirrorEl.style.wordBreak = cs.wordBreak || 'break-word';
        mirrorEl.style.tabSize = cs.tabSize || cs.MozTabSize || '4';
        var w = editorEl.clientWidth || parseFloat(cs.width);
        if (w > 0) mirrorEl.style.width = w + 'px';
        mirrorEl.style.height = editorEl.clientHeight + 'px';
      } catch (e) {}
    }

    // 填充 mirror
    var before = text.slice(0, pos);
    var charUnder = text.charAt(pos);
    var after = text.slice(pos + 1);

    mirrorEl.innerHTML = '';
    var spanBefore = doc.createTextNode ? doc.createTextNode(before) : null;
    if (spanBefore) mirrorEl.appendChild(spanBefore);

    var markerSpan = doc.createElement('span');
    markerSpan.className = 'vim-cursor-marker';
    markerSpan.textContent = (!charUnder || charUnder === '\n') ? ' ' : charUnder;
    mirrorEl.appendChild(markerSpan);

    var spanAfter = doc.createTextNode ? doc.createTextNode(after) : null;
    if (spanAfter) mirrorEl.appendChild(spanAfter);

    // 测量 marker
    var markerLeft = markerSpan.offsetLeft || 0;
    var markerTop = markerSpan.offsetTop || 0;
    var markerW = markerSpan.offsetWidth || 8.5;
    var markerH = markerSpan.offsetHeight || 19;

    // Normal / Visual 下 j/k 移动边缘自动 scroll 留 2 行边距
    var lineHeight = markerH || 19;
    var margin = lineHeight * 2;
    var sTop = editorEl.scrollTop || 0;
    var cHeight = editorEl.clientHeight || 0;
    var sHeight = editorEl.scrollHeight || 0;
    var maxScroll = Math.max(0, sHeight - cHeight);

    if (cHeight > 0 && maxScroll > 0) {
      if (markerTop - margin < sTop) {
        editorEl.scrollTop = Math.max(0, markerTop - margin);
        sTop = editorEl.scrollTop;
      } else if (markerTop + lineHeight + margin > sTop + cHeight) {
        editorEl.scrollTop = Math.min(maxScroll, markerTop + lineHeight + margin - cHeight);
        sTop = editorEl.scrollTop;
      }
    }

    var edOffsetLeft = editorEl.offsetLeft || 0;
    var edOffsetTop = editorEl.offsetTop || 0;
    var sLeft = editorEl.scrollLeft || 0;

    var posX = edOffsetLeft + markerLeft - sLeft;
    var posY = edOffsetTop + markerTop - sTop;

    // 视口溢出检查
    var edClientW = editorEl.clientWidth;
    var edClientH = editorEl.clientHeight;
    if (edClientW > 0 && edClientH > 0) {
      if (posX + markerW < edOffsetLeft || posX > edOffsetLeft + edClientW ||
          posY + markerH < edOffsetTop || posY > edOffsetTop + edClientH) {
        cursorEl.style.display = 'none';
        return;
      }
    }

    cursorEl.style.display = 'block';
    cursorEl.textContent = (!charUnder || charUnder === '\n') ? '\u00A0' : charUnder;
    cursorEl.style.left = posX + 'px';
    cursorEl.style.top = posY + 'px';
    cursorEl.style.width = markerW + 'px';
    cursorEl.style.height = markerH + 'px';

    if (root.CustomCaret && typeof root.CustomCaret.update === 'function') {
      root.CustomCaret.update();
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  /* ── 挂载与 DOM 创建 ── */
  function mount(options) {
    options = options || {};

    if (state.mounted) {
      unmount();
    }

    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return VimUI;

    var container = options.container;
    if (typeof container === 'string') {
      container = doc.querySelector(container);
    }
    if (!container) {
      container = doc.getElementById('statusbar') || doc.getElementById('status-bar') || doc.body;
    }

    var editorTarget = options.editorTarget;
    if (typeof editorTarget === 'string') {
      editorTarget = doc.querySelector(editorTarget);
    }
    if (!editorTarget) {
      editorTarget = doc.getElementById('editor-container') || doc.querySelector('.editor-container') || doc.body;
    }

    var commandContainer = options.commandContainer;
    if (typeof commandContainer === 'string') {
      commandContainer = doc.querySelector(commandContainer);
    }
    if (!commandContainer) {
      commandContainer = editorTarget || doc.body;
    }

    var editorElement = options.editorElement || options.target;
    if (typeof editorElement === 'string') {
      editorElement = doc.querySelector(editorElement);
    }
    if (!editorElement) {
      editorElement = doc.getElementById('editor') || (editorTarget ? editorTarget.querySelector('textarea') : null);
    }

    // 1. 创建状态栏组件
    var widget = doc.createElement('div');
    widget.className = 'vim-status-widget';
    widget.setAttribute('role', 'status');
    widget.setAttribute('aria-live', 'polite');
    widget.setAttribute('aria-label', t('vim.aria.mode'));

    var modeBadge = doc.createElement('span');
    modeBadge.className = 'vim-mode-badge mode-normal';
    modeBadge.textContent = '-- NORMAL --';
    widget.appendChild(modeBadge);

    var badgesGroup = doc.createElement('div');
    badgesGroup.className = 'vim-badges-group';
    badgesGroup.setAttribute('aria-label', t('vim.aria.badges'));

    var countBadge = doc.createElement('span');
    countBadge.className = 'vim-badge vim-badge-count';
    countBadge.style.display = 'none';
    badgesGroup.appendChild(countBadge);

    var operatorBadge = doc.createElement('span');
    operatorBadge.className = 'vim-badge vim-badge-operator';
    operatorBadge.style.display = 'none';
    badgesGroup.appendChild(operatorBadge);

    var recordingBadge = doc.createElement('span');
    recordingBadge.className = 'vim-badge vim-badge-recording';
    recordingBadge.style.display = 'none';
    badgesGroup.appendChild(recordingBadge);

    var keyBufferBadge = doc.createElement('span');
    keyBufferBadge.className = 'vim-badge vim-badge-buffer';
    keyBufferBadge.style.display = 'none';
    badgesGroup.appendChild(keyBufferBadge);

    widget.appendChild(badgesGroup);

    var statusMessageEl = doc.createElement('span');
    statusMessageEl.className = 'vim-status-message';
    statusMessageEl.style.display = 'none';
    widget.appendChild(statusMessageEl);

    var enabledHint = doc.createElement('span');
    enabledHint.className = 'vim-enabled-hint vim-persistent-hint mode-normal';
    enabledHint.textContent = t('vim.hint.normal') || '[VIM] 普通模式（按 i 进入编辑）';
    enabledHint.setAttribute('title', 'Vim 模式');
    widget.appendChild(enabledHint);

    container.appendChild(widget);

    // 2. 创建命令行浮层
    var cmdOverlay = doc.createElement('div');
    cmdOverlay.className = 'vim-command-line-overlay';
    cmdOverlay.setAttribute('role', 'dialog');
    cmdOverlay.setAttribute('aria-label', t('vim.aria.commandLine'));

    if (options.floating) {
      cmdOverlay.classList.add('is-floating');
    }

    var cmdPrompt = doc.createElement('span');
    cmdPrompt.className = 'vim-cmd-prompt';
    cmdPrompt.textContent = ':';
    cmdOverlay.appendChild(cmdPrompt);

    var cmdInput = doc.createElement('input');
    cmdInput.type = 'text';
    cmdInput.className = 'vim-cmd-input';
    cmdInput.setAttribute('aria-label', t('vim.aria.commandInput'));
    cmdInput.setAttribute('autocomplete', 'off');
    cmdInput.setAttribute('spellcheck', 'false');
    cmdOverlay.appendChild(cmdInput);

    var cmdSuggestions = doc.createElement('ul');
    cmdSuggestions.className = 'vim-cmd-completion-list';
    cmdSuggestions.setAttribute('role', 'listbox');
    cmdSuggestions.setAttribute('aria-label', t('vim.aria.completions'));
    cmdSuggestions.style.display = 'none';
    cmdOverlay.appendChild(cmdSuggestions);

    commandContainer.appendChild(cmdOverlay);

    // 3. 创建方块光标与测量镜像
    var blockCursor = doc.createElement('div');
    blockCursor.className = 'vim-block-cursor';
    blockCursor.setAttribute('aria-hidden', 'true');
    blockCursor.style.display = 'none';
    editorTarget.appendChild(blockCursor);

    var cursorMirror = doc.createElement('div');
    cursorMirror.className = 'vim-cursor-mirror';
    cursorMirror.setAttribute('aria-hidden', 'true');
    cursorMirror.style.position = 'absolute';
    cursorMirror.style.top = '0';
    cursorMirror.style.left = '0';
    cursorMirror.style.visibility = 'hidden';
    cursorMirror.style.pointerEvents = 'none';
    cursorMirror.style.whiteSpace = 'pre-wrap';
    cursorMirror.style.wordBreak = 'break-word';
    cursorMirror.style.overflow = 'hidden';
    cursorMirror.style.zIndex = '-1';
    editorTarget.appendChild(cursorMirror);

    // 保存 DOM 引用
    state.dom.container = container;
    state.dom.editorTarget = editorTarget;
    state.dom.commandContainer = commandContainer;
    state.dom.editorElement = editorElement;
    state.dom.statusWidget = widget;
    state.dom.modeBadge = modeBadge;
    state.dom.badgesGroup = badgesGroup;
    state.dom.countBadge = countBadge;
    state.dom.operatorBadge = operatorBadge;
    state.dom.recordingBadge = recordingBadge;
    state.dom.keyBufferBadge = keyBufferBadge;
    state.dom.statusMessageEl = statusMessageEl;
    state.dom.enabledHintEl = enabledHint;
    state.dom.commandOverlay = cmdOverlay;
    state.dom.cmdPromptEl = cmdPrompt;
    state.dom.cmdInputEl = cmdInput;
    state.dom.cmdSuggestionsEl = cmdSuggestions;
    state.dom.blockCursor = blockCursor;
    state.dom.cursorMirror = cursorMirror;

    state.mounted = true;
    state.enabled = options.enabled !== undefined ? !!options.enabled : true;

    // 绑定命令行事件与光标同步监听
    setupCommandLineEvents();
    if (editorElement) {
      addEventListenerHelper(editorElement, 'scroll', updateBlockCursorPosition);
      addEventListenerHelper(editorElement, 'selectionchange', updateBlockCursorPosition);
    }
    if (typeof root.addEventListener === 'function') {
      addEventListenerHelper(root, 'resize', updateBlockCursorPosition);
    }

    // 监听 i18n 变更
    if (typeof root.addEventListener === 'function') {
      addEventListenerHelper(root, 'i18n-changed', function () {
        renderStatusWidget();
      });
    }

    if (options.initialState) {
      update(options.initialState);
    } else {
      renderStatusWidget();
    }

    return VimUI;
  }

  /* ── 命令行交互事件处理 ── */
  function setupCommandLineEvents() {
    var input = state.dom.cmdInputEl;
    if (!input) return;

    addEventListenerHelper(input, 'keydown', function (e) {
      var key = e.key;
      var opt = state.commandOptions || {};

      if (key === 'Enter') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        var val = input.value || '';
        hideCommandLine();
        if (typeof opt.onSubmit === 'function') {
          opt.onSubmit(val);
        }
      } else if (key === 'Escape' || (e.ctrlKey && (key === '[' || key === 'c' || key === 'C'))) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        hideCommandLine();
        if (typeof opt.onCancel === 'function') {
          opt.onCancel();
        }
      } else if (key === 'ArrowUp') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        handleHistoryNavigation(-1);
      } else if (key === 'ArrowDown') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        handleHistoryNavigation(1);
      } else if (key === 'Tab') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        handleTabCompletion();
      }
    });

    addEventListenerHelper(input, 'input', function () {
      var val = input.value || '';
      state.commandValue = val;
      var opt = state.commandOptions || {};
      if (typeof opt.onChange === 'function') {
        opt.onChange(val);
      }
      renderSuggestions(opt.suggestions, val);
    });
  }

  function handleHistoryNavigation(direction) {
    var opt = state.commandOptions || {};
    var hist = opt.history || [];
    if (!hist.length) return;

    if (state.historyIndex === -1) {
      state.historyIndex = direction < 0 ? hist.length - 1 : 0;
    } else {
      state.historyIndex += direction;
    }

    if (state.historyIndex < 0) {
      state.historyIndex = -1;
      state.dom.cmdInputEl.value = '';
    } else if (state.historyIndex >= hist.length) {
      state.historyIndex = hist.length - 1;
    } else {
      state.dom.cmdInputEl.value = hist[state.historyIndex] || '';
    }
  }

  function renderSuggestions(suggestions, currentVal) {
    var list = state.dom.cmdSuggestionsEl;
    if (!list) return;

    if (!suggestions || !suggestions.length || !currentVal) {
      list.style.display = 'none';
      list.innerHTML = '';
      return;
    }

    var filtered = suggestions.filter(function (item) {
      var label = typeof item === 'string' ? item : (item && item.label);
      return label && label.toLowerCase().indexOf(currentVal.toLowerCase()) === 0;
    });

    if (!filtered.length) {
      list.style.display = 'none';
      list.innerHTML = '';
      return;
    }

    list.innerHTML = '';
    filtered.slice(0, 8).forEach(function (item, index) {
      var doc = state.dom.container ? state.dom.container.ownerDocument || document : document;
      var li = doc.createElement('li');
      li.className = 'vim-cmd-completion-item' + (index === state.selectedSuggestionIndex ? ' selected' : '');
      li.setAttribute('role', 'option');

      var label = typeof item === 'string' ? item : item.label;
      var desc = typeof item === 'object' && item.description ? item.description : '';

      li.innerHTML = '<span class="vim-cmd-completion-label">' + escapeHtml(label) + '</span>' +
        (desc ? '<span class="vim-cmd-completion-desc">' + escapeHtml(desc) + '</span>' : '');

      li.addEventListener('click', function () {
        if (state.dom.cmdInputEl) {
          state.dom.cmdInputEl.value = label;
          state.dom.cmdInputEl.focus();
        }
        list.style.display = 'none';
      });

      list.appendChild(li);
    });

    list.style.display = 'block';
  }

  function handleTabCompletion() {
    var list = state.dom.cmdSuggestionsEl;
    if (!list || list.style.display === 'none') return;

    var items = list.querySelectorAll ? list.querySelectorAll('.vim-cmd-completion-item') : [];
    if (!items || !items.length) return;

    state.selectedSuggestionIndex = (state.selectedSuggestionIndex + 1) % items.length;
    for (var i = 0; i < items.length; i++) {
      if (i === state.selectedSuggestionIndex) {
        items[i].classList.add('selected');
        var labelEl = items[i].querySelector ? items[i].querySelector('.vim-cmd-completion-label') : null;
        if (labelEl && state.dom.cmdInputEl) {
          state.dom.cmdInputEl.value = labelEl.textContent || '';
        }
      } else {
        items[i].classList.remove('selected');
      }
    }
  }

  /* ── 状态更新 API ── */
  function update(next) {
    if (!next || typeof next !== 'object') return VimUI;

    if (next.enabled !== undefined) {
      state.enabled = !!next.enabled;
    }

    if (next.mode !== undefined) {
      state.mode = next.mode;
    }

    if (next.cursor !== undefined) {
      state.cursor = next.cursor;
    }

    if (next.commandLine !== undefined) {
      state.commandLine = next.commandLine;
    }

    if (next.pendingCount !== undefined) {
      state.pendingCount = next.pendingCount;
    } else if (next.count !== undefined) {
      state.pendingCount = next.count;
    }

    if (next.pendingOperator !== undefined) {
      state.pendingOperator = next.pendingOperator;
    } else if (next.operator !== undefined) {
      state.pendingOperator = next.operator;
    }

    if (next.keyBuffer !== undefined) {
      state.keyBuffer = next.keyBuffer;
    } else if (next.keys !== undefined) {
      state.keyBuffer = next.keys;
    }

    if (next.recordingRegister !== undefined) {
      state.recordingRegister = next.recordingRegister;
    } else if (next.recording !== undefined) {
      state.recordingRegister = next.recording;
    } else if (next.macro !== undefined) {
      state.recordingRegister = next.macro;
    }

    if (next.statusMessage !== undefined) {
      state.statusMessage = next.statusMessage;
      state.statusMessageType = next.statusMessageType || 'normal';
    } else if (next.message !== undefined) {
      state.statusMessage = next.message;
      state.statusMessageType = next.messageType || 'normal';
    } else if (next.error !== undefined) {
      state.statusMessage = next.error;
      state.statusMessageType = 'error';
    } else if (next.info !== undefined) {
      state.statusMessage = next.info;
      state.statusMessageType = 'info';
    }

    // 处理 CommandLine 模式的实时展示
    var normalizedMode = normalizeMode(state.mode);
    if (normalizedMode === 'command') {
      if (state.dom.commandOverlay) {
        state.dom.commandOverlay.classList.add('active');
      }
      state.commandLineOpen = true;
      var rawCmd = state.commandLine !== undefined ? String(state.commandLine) : ':';
      var promptChar = rawCmd.length > 0 ? rawCmd.charAt(0) : ':';
      var inputVal = rawCmd.length > 0 ? rawCmd.slice(1) : '';
      state.commandPrompt = promptChar;
      state.commandValue = inputVal;
      if (state.dom.cmdPromptEl) {
        state.dom.cmdPromptEl.textContent = promptChar;
      }
      if (state.dom.cmdInputEl && state.dom.cmdInputEl !== (state.dom.container ? state.dom.container.ownerDocument.activeElement : null)) {
        state.dom.cmdInputEl.value = inputVal;
      }
    } else if (state.commandLineOpen && !state.commandOptions) {
      // 非由 showCommandLine 显式弹出的 CommandLine 自动隐藏
      if (state.dom.commandOverlay) {
        state.dom.commandOverlay.classList.remove('active');
      }
      state.commandLineOpen = false;
      if (state.dom.cmdInputEl) {
        state.dom.cmdInputEl.value = '';
      }
    }

    renderStatusWidget();
    return VimUI;
  }

  /* ── 命令行浮层 API ── */
  function showCommandLine(options) {
    options = options || {};
    state.commandOptions = options;
    state.historyIndex = -1;
    state.selectedSuggestionIndex = -1;

    var overlay = state.dom.commandOverlay;
    var promptEl = state.dom.cmdPromptEl;
    var inputEl = state.dom.cmdInputEl;
    if (!overlay || !inputEl) return VimUI;

    try {
      state.previousActiveElement = typeof document !== 'undefined' ? document.activeElement : null;
    } catch (e) {}

    var prompt = options.prompt || ':';
    state.commandPrompt = prompt;
    if (promptEl) {
      promptEl.textContent = prompt;
    }

    var defaultPlaceholder = prompt === ':' ? t('vim.command.placeholder') : t('vim.search.placeholder');
    inputEl.placeholder = options.placeholder || defaultPlaceholder;
    inputEl.value = options.initialValue || '';
    state.commandValue = inputEl.value;

    overlay.classList.add('active');
    state.commandLineOpen = true;

    // 切换模式徽章到 command
    update({ mode: 'command', commandLine: prompt + (options.initialValue || '') });

    try {
      if (typeof inputEl.focus === 'function') {
        inputEl.focus();
        if (typeof inputEl.select === 'function' && options.selectInitial) {
          inputEl.select();
        }
      }
    } catch (e) {}

    if (options.suggestions && options.initialValue) {
      renderSuggestions(options.suggestions, options.initialValue);
    }

    return VimUI;
  }

  function hideCommandLine() {
    var overlay = state.dom.commandOverlay;
    var inputEl = state.dom.cmdInputEl;
    var suggestions = state.dom.cmdSuggestionsEl;

    if (overlay) {
      overlay.classList.remove('active');
    }
    if (suggestions) {
      suggestions.style.display = 'none';
      suggestions.innerHTML = '';
    }
    state.commandLineOpen = false;
    state.commandOptions = null;

    if (normalizeMode(state.mode) === 'command') {
      update({ mode: 'normal', commandLine: '' });
    }

    if (state.previousActiveElement && typeof state.previousActiveElement.focus === 'function') {
      try {
        state.previousActiveElement.focus();
      } catch (e) {}
    }
    state.previousActiveElement = null;

    return VimUI;
  }

  /* ── 卸载与清理 ── */
  function unmount(options) {
    removeAllListeners();

    if (state.dom.enabledHintEl) {
      state.dom.enabledHintEl.style.display = 'none';
      if (state.dom.enabledHintEl.parentNode) {
        state.dom.enabledHintEl.parentNode.removeChild(state.dom.enabledHintEl);
      }
    }

    if (state.dom.statusWidget) {
      state.dom.statusWidget.style.display = 'none';
      state.dom.statusWidget.setAttribute('hidden', '');
      if (state.dom.statusWidget.parentNode) {
        state.dom.statusWidget.parentNode.removeChild(state.dom.statusWidget);
      }
    }

    if (state.dom.commandOverlay) {
      state.dom.commandOverlay.classList.remove('active');
      state.dom.commandOverlay.style.display = 'none';
      state.dom.commandOverlay.setAttribute('hidden', '');
      if (state.dom.commandOverlay.parentNode) {
        state.dom.commandOverlay.parentNode.removeChild(state.dom.commandOverlay);
      }
    }

    if (state.dom.blockCursor) {
      state.dom.blockCursor.style.display = 'none';
      if (state.dom.blockCursor.parentNode) {
        state.dom.blockCursor.parentNode.removeChild(state.dom.blockCursor);
      }
    }

    if (state.dom.cursorMirror) {
      state.dom.cursorMirror.style.display = 'none';
      if (state.dom.cursorMirror.parentNode) {
        state.dom.cursorMirror.parentNode.removeChild(state.dom.cursorMirror);
      }
    }

    if (state.dom.editorTarget && state.dom.editorTarget.classList) {
      state.dom.editorTarget.classList.remove('vim-mode-active');
      Object.keys(MODE_CONFIG).forEach(function (k) {
        state.dom.editorTarget.classList.remove(MODE_CONFIG[k].editorClass);
      });
    }

    if (options && options.clearToast) {
      hideToast();
    }

    state.mounted = false;
    state.enabled = false;
    state.commandLineOpen = false;
    state.dom = {
      container: null,
      editorTarget: null,
      commandContainer: null,
      editorElement: null,
      statusWidget: null,
      modeBadge: null,
      badgesGroup: null,
      countBadge: null,
      operatorBadge: null,
      recordingBadge: null,
      keyBufferBadge: null,
      statusMessageEl: null,
      enabledHintEl: null,
      commandOverlay: null,
      cmdPromptEl: null,
      cmdInputEl: null,
      cmdSuggestionsEl: null,
      blockCursor: null,
      cursorMirror: null
    };

    return VimUI;
  }

  /* ── 轻量 Toast 提示机制 ── */
  var toastTimer = null;

  function safeSetTimeout(fn, ms) {
    if (typeof setTimeout === 'function') {
      return setTimeout(fn, ms);
    }
    if (root && typeof root.setTimeout === 'function') {
      return root.setTimeout(fn, ms);
    }
    if (typeof globalThis !== 'undefined' && typeof globalThis.setTimeout === 'function') {
      return globalThis.setTimeout(fn, ms);
    }
    return null;
  }

  function safeClearTimeout(id) {
    if (!id) return;
    if (typeof clearTimeout === 'function') {
      clearTimeout(id);
      return;
    }
    if (root && typeof root.clearTimeout === 'function') {
      root.clearTimeout(id);
      return;
    }
    if (typeof globalThis !== 'undefined' && typeof globalThis.clearTimeout === 'function') {
      globalThis.clearTimeout(id);
    }
  }

  function showToast(message, duration, key) {
    var doc = (state.dom.container && state.dom.container.ownerDocument) ||
      (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.createElement) return VimUI;

    var toastEl = doc.getElementById('vim-toast');
    if (!toastEl) {
      toastEl = doc.createElement('div');
      toastEl.id = 'vim-toast';
      toastEl.className = 'vim-toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      var host = doc.body || (state.dom.editorTarget && state.dom.editorTarget.parentNode) || state.dom.container;
      if (host) host.appendChild(toastEl);
    }

    // 优先按 i18n key 走模块双语回退字典；调用方显式传入的 message 仅作覆盖。
    // 直接使用全局 I18n.t 会因全局字典缺少 vim.* 条目而把裸 key 当文案显示。
    var text = (key && t(key)) || message || t('vim.toast.enter') || '已进入 Vim 模式（普通模式）';
    toastEl.textContent = text;
    toastEl.style.display = 'block';
    if (typeof toastEl.getBoundingClientRect === 'function') {
      try { toastEl.getBoundingClientRect(); } catch (e) {}
    }
    toastEl.classList.add('visible');

    if (toastTimer) {
      safeClearTimeout(toastTimer);
      toastTimer = null;
    }

    var dur = typeof duration === 'number' && duration > 0 ? duration : 1500;
    toastTimer = safeSetTimeout(function () {
      if (toastEl) {
        toastEl.classList.remove('visible');
        safeSetTimeout(function () {
          if (toastEl && !toastEl.classList.contains('visible')) {
            toastEl.style.display = 'none';
          }
        }, 200);
      }
      toastTimer = null;
    }, dur);

    return VimUI;
  }

  function hideToast() {
    if (toastTimer) {
      safeClearTimeout(toastTimer);
      toastTimer = null;
    }
    var doc = (state.dom.container && state.dom.container.ownerDocument) ||
      (typeof document !== 'undefined' ? document : null);
    if (!doc) return VimUI;
    var toastEl = doc.getElementById('vim-toast');
    if (toastEl) {
      toastEl.classList.remove('visible');
      toastEl.style.display = 'none';
      if (toastEl.parentNode) {
        toastEl.parentNode.removeChild(toastEl);
      }
    }
    return VimUI;
  }

  /* ── 辅助便捷方法 ── */
  function setMode(mode) {
    return update({ mode: mode });
  }

  function setMessage(msg, type) {
    return update({ statusMessage: msg, statusMessageType: type || 'normal' });
  }

  function clearMessage() {
    return update({ statusMessage: '', statusMessageType: 'normal' });
  }

  function getState() {
    return {
      mounted: state.mounted,
      enabled: state.enabled,
      mode: state.mode,
      cursor: state.cursor,
      pendingCount: state.pendingCount,
      pendingOperator: state.pendingOperator,
      keyBuffer: state.keyBuffer,
      recordingRegister: state.recordingRegister,
      statusMessage: state.statusMessage,
      statusMessageType: state.statusMessageType,
      commandLineOpen: state.commandLineOpen,
      commandPrompt: state.commandPrompt,
      commandValue: state.commandValue
    };
  }

  var VimUI = {
    mount: mount,
    update: update,
    unmount: unmount,
    showCommandLine: showCommandLine,
    hideCommandLine: hideCommandLine,
    showToast: showToast,
    hideToast: hideToast,
    setMode: setMode,
    setMessage: setMessage,
    clearMessage: clearMessage,
    getState: getState,
    normalizeMode: normalizeMode,
    updateBlockCursorPosition: updateBlockCursorPosition,
    MODE_CONFIG: MODE_CONFIG,
    FALLBACK_LOCALES: FALLBACK_LOCALES
  };

  root.VimUI = VimUI;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = VimUI;
  }
})(typeof window !== 'undefined' ? window : globalThis);
