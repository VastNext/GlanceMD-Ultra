// Vim Mode UI & Visual Adaptation Component —— window.VimUI
// 契约与规范：
// 1. 状态栏模式展示组件：支持在状态栏或独立容器显示 -- NORMAL --, -- INSERT --, -- VISUAL --, -- VISUAL LINE --, -- COMMAND -- 等，
//    以及 pending count / operator / macro recording / key buffer 徽章。
// 2. 光标与选区样式联动：在关联的宿主容器/编辑器上应用 .vim-mode-active, .vim-normal-mode, .vim-visual-mode 等类，支持方块光标指示与紫粉高亮选区。
// 3. 命令行输入浮层：支持 showCommandLine(options) 弹出 Ex 命令行 / 搜索栏，支持 prompt (:, /, ?)、历史记录与补全建议、Enter 提交、Esc 取消。
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

      'vim.status.recording': '录制中 @{reg}',
      'vim.status.count': '计数: {count}',
      'vim.status.operator': '操作符: {op}',
      'vim.status.keyBuffer': '待决按键: {keys}',

      'vim.command.placeholder': '输入 Ex 命令 (:w, :q, :s/...)...',
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

      'vim.status.recording': 'recording @{reg}',
      'vim.status.count': 'Count: {count}',
      'vim.status.operator': 'Operator: {op}',
      'vim.status.keyBuffer': 'Pending keys: {keys}',

      'vim.command.placeholder': 'Type Ex command (:w, :q, :s/...)...',
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
    if (m === 'c' || m === ':' || m === 'cmd' || m === 'command') return 'command';
    return 'normal';
  }

  // 获取模式标准展示文本与样式类
  var MODE_CONFIG = {
    'normal': {
      labelKey: 'vim.modeLabel.normal',
      nameKey: 'vim.mode.normal',
      cssClass: 'mode-normal',
      editorClass: 'vim-normal-mode',
      fallbackText: '-- NORMAL --'
    },
    'insert': {
      labelKey: 'vim.modeLabel.insert',
      nameKey: 'vim.mode.insert',
      cssClass: 'mode-insert',
      editorClass: 'vim-insert-mode',
      fallbackText: '-- INSERT --'
    },
    'visual': {
      labelKey: 'vim.modeLabel.visual',
      nameKey: 'vim.mode.visual',
      cssClass: 'mode-visual',
      editorClass: 'vim-visual-mode',
      fallbackText: '-- VISUAL --'
    },
    'visual-line': {
      labelKey: 'vim.modeLabel.visualLine',
      nameKey: 'vim.mode.visualLine',
      cssClass: 'mode-visual-line',
      editorClass: 'vim-visual-line-mode',
      fallbackText: '-- VISUAL LINE --'
    },
    'visual-block': {
      labelKey: 'vim.modeLabel.visualBlock',
      nameKey: 'vim.mode.visualBlock',
      cssClass: 'mode-visual-block',
      editorClass: 'vim-visual-block-mode',
      fallbackText: '-- VISUAL BLOCK --'
    },
    'replace': {
      labelKey: 'vim.modeLabel.replace',
      nameKey: 'vim.mode.replace',
      cssClass: 'mode-replace',
      editorClass: 'vim-replace-mode',
      fallbackText: '-- REPLACE --'
    },
    'command': {
      labelKey: 'vim.modeLabel.command',
      nameKey: 'vim.mode.command',
      cssClass: 'mode-command',
      editorClass: 'vim-command-mode',
      fallbackText: '-- COMMAND --'
    }
  };

  var state = {
    mounted: false,
    enabled: true,
    mode: 'normal',
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
      statusWidget: null,
      modeBadge: null,
      badgesGroup: null,
      countBadge: null,
      operatorBadge: null,
      recordingBadge: null,
      keyBufferBadge: null,
      statusMessageEl: null,
      commandOverlay: null,
      cmdPromptEl: null,
      cmdInputEl: null,
      cmdSuggestionsEl: null
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

    // 7. 同步 Editor 容器的模式 CSS 类
    syncEditorClasses();
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
      container = doc.getElementById('status-bar') || doc.body;
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

    // 保存 DOM 引用
    state.dom.container = container;
    state.dom.editorTarget = editorTarget;
    state.dom.commandContainer = commandContainer;
    state.dom.statusWidget = widget;
    state.dom.modeBadge = modeBadge;
    state.dom.badgesGroup = badgesGroup;
    state.dom.countBadge = countBadge;
    state.dom.operatorBadge = operatorBadge;
    state.dom.recordingBadge = recordingBadge;
    state.dom.keyBufferBadge = keyBufferBadge;
    state.dom.statusMessageEl = statusMessageEl;
    state.dom.commandOverlay = cmdOverlay;
    state.dom.cmdPromptEl = cmdPrompt;
    state.dom.cmdInputEl = cmdInput;
    state.dom.cmdSuggestionsEl = cmdSuggestions;

    state.mounted = true;
    state.enabled = options.enabled !== undefined ? !!options.enabled : true;

    // 绑定命令行事件
    setupCommandLineEvents();

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
    update({ mode: 'command' });

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

    if (state.mode === 'command') {
      update({ mode: 'normal' });
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
  function unmount() {
    removeAllListeners();

    if (state.dom.statusWidget && state.dom.statusWidget.parentNode) {
      state.dom.statusWidget.parentNode.removeChild(state.dom.statusWidget);
    }

    if (state.dom.commandOverlay && state.dom.commandOverlay.parentNode) {
      state.dom.commandOverlay.parentNode.removeChild(state.dom.commandOverlay);
    }

    if (state.dom.editorTarget && state.dom.editorTarget.classList) {
      state.dom.editorTarget.classList.remove('vim-mode-active');
      Object.keys(MODE_CONFIG).forEach(function (k) {
        state.dom.editorTarget.classList.remove(MODE_CONFIG[k].editorClass);
      });
    }

    state.mounted = false;
    state.commandLineOpen = false;
    state.dom = {
      container: null,
      editorTarget: null,
      commandContainer: null,
      statusWidget: null,
      modeBadge: null,
      badgesGroup: null,
      countBadge: null,
      operatorBadge: null,
      recordingBadge: null,
      keyBufferBadge: null,
      statusMessageEl: null,
      commandOverlay: null,
      cmdPromptEl: null,
      cmdInputEl: null,
      cmdSuggestionsEl: null
    };

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
      pendingCount: state.pendingCount,
      pendingOperator: state.pendingOperator,
      keyBuffer: state.keyBuffer,
      recordingRegister: state.recordingRegister,
      statusMessage: state.statusMessage,
      statusMessageType: state.statusMessageType,
      commandLineOpen: state.commandLineOpen,
      commandPrompt: state.commandPrompt
    };
  }

  var VimUI = {
    mount: mount,
    update: update,
    unmount: unmount,
    showCommandLine: showCommandLine,
    hideCommandLine: hideCommandLine,
    setMode: setMode,
    setMessage: setMessage,
    clearMessage: clearMessage,
    getState: getState,
    normalizeMode: normalizeMode,
    MODE_CONFIG: MODE_CONFIG,
    FALLBACK_LOCALES: FALLBACK_LOCALES
  };

  root.VimUI = VimUI;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = VimUI;
  }
})(typeof window !== 'undefined' ? window : globalThis);
