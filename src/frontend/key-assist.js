// Key Assist（快捷键助手）独立 UI 模块原型 —— window.KeyAssist
// 契约与规范：
// 1. 动态按需创建 DOM，自包含样式与 ARIA 属性（role=dialog, listbox, combobox, aria-live）。
// 2. 交互支持：方向键上下导航、Enter 执行命令、F2 编辑快捷键、Delete 清除绑定、Escape 关闭、焦点保存与恢复。
// 3. 安全降级：优先使用 window.BindingService、window.ContextKeys、window.Commands、window.I18n，缺失时平滑回退。
// 4. 所有可见文案使用 I18n key 查询，并内建中英文字典回退。

(function () {
  'use strict';

  var FALLBACK_LOCALES = {
    'zh-CN': {
      'keyAssist.title': '快捷键助手',
      'keyAssist.allContexts': '全部上下文',
      'keyAssist.searchPlaceholder': '搜索命令名称、ID 或快捷键 (↑↓ 导航)...',
      'keyAssist.empty': '无匹配的命令或快捷键',
      'keyAssist.closeAria': '关闭快捷键助手',
      'keyAssist.listAria': '当前可用命令列表',
      'keyAssist.hintNavigate': '导航',
      'keyAssist.hintRun': '执行',
      'keyAssist.hintEdit': '编辑快捷键',
      'keyAssist.hintDelete': '清除绑定',
      'keyAssist.hintClose': '关闭',
      'keyAssist.countStatus': '找到 {n} 项命令',
      'keyAssist.sourceUser': '用户',
      'keyAssist.sourceScheme': '方案',
      'keyAssist.sourceDefault': '默认',
      'keyAssist.sourceExtension': '插件',
      'keyAssist.conflict': '存在冲突',
      'keyAssist.unbound': '未绑定',
      'keyAssist.unboundNotice': '已清除命令 {id} 的快捷键绑定'
    },
    'en': {
      'keyAssist.title': 'Key Assist',
      'keyAssist.allContexts': 'All Contexts',
      'keyAssist.searchPlaceholder': 'Search commands, IDs, or shortcuts (↑↓ to navigate)...',
      'keyAssist.empty': 'No matching commands or shortcuts found',
      'keyAssist.closeAria': 'Close Key Assist',
      'keyAssist.listAria': 'Available commands list',
      'keyAssist.hintNavigate': 'Navigate',
      'keyAssist.hintRun': 'Run',
      'keyAssist.hintEdit': 'Edit Key',
      'keyAssist.hintDelete': 'Unbind',
      'keyAssist.hintClose': 'Close',
      'keyAssist.countStatus': '{n} commands found',
      'keyAssist.sourceUser': 'User',
      'keyAssist.sourceScheme': 'Scheme',
      'keyAssist.sourceDefault': 'Default',
      'keyAssist.sourceExtension': 'Extension',
      'keyAssist.conflict': 'Conflict',
      'keyAssist.unbound': 'Unbound',
      'keyAssist.unboundNotice': 'Cleared keybinding for command {id}'
    }
  };

  function interpolate(text, params) {
    if (!params || typeof params !== 'object') return text;
    return String(text).replace(/\{(\w+)\}/g, function (whole, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole;
    });
  }

  function t(key, params) {
    if (window.I18n && typeof window.I18n.t === 'function') {
      var res = window.I18n.t(key, params);
      if (res && res !== key) return res;
    }
    var lang = 'zh-CN';
    if (window.I18n && typeof window.I18n.getLanguage === 'function') {
      lang = window.I18n.getLanguage() || 'zh-CN';
    }
    var dict = FALLBACK_LOCALES[lang] || FALLBACK_LOCALES['zh-CN'];
    var raw = (dict && dict[key]) || (FALLBACK_LOCALES['zh-CN'] && FALLBACK_LOCALES['zh-CN'][key]) || key;
    return interpolate(raw, params);
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  var state = {
    isOpen: false,
    selectedIndex: 0,
    searchQuery: '',
    previousActiveElement: null,
    filteredItems: [],
    dom: null,
    options: {}
  };

  // 获取当前活动上下文标识
  function getActiveContextId() {
    if (window.ContextKeys) {
      if (typeof window.ContextKeys.getActiveContextId === 'function') {
        return window.ContextKeys.getActiveContextId();
      }
      if (typeof window.ContextKeys.getContext === 'function') {
        var ctx = window.ContextKeys.getContext();
        if (ctx && ctx.id) return ctx.id;
      }
    }
    // 根据焦点元素启发式推导上下文
    var el = document.activeElement;
    if (el) {
      if (el.closest && el.closest('.editor-area, #editor, textarea')) return 'editorTextFocus';
      if (el.closest && el.closest('.project-tree, #tree-panel')) return 'projectTreeFocus';
      if (el.closest && el.closest('.search-panel, #search-panel')) return 'searchPanelFocus';
      if (el.closest && el.closest('.outline-panel, #outline-panel')) return 'outlineFocus';
      if (el.closest && el.closest('.settings-modal, #settings-container')) return 'settingsFocus';
    }
    return 'global';
  }

  // 获取全量或上下文相关的命令绑定集合
  function getCommandEntries(contextId) {
    var items = [];
    var conflictMap = {};

    // BindingService 是唯一事实源；缺失时安全显示空态。
    var service = window.BindingService;
    if (!service || typeof service !== 'object' || typeof service.getBindings !== 'function') return [];
    var bindings = service.getBindings({ context: contextId });
    if (Array.isArray(bindings)) {
      return bindings.map(function (b) {
        var id = b.commandId || b.id;
        var cmd = window.Commands && typeof window.Commands.get === 'function' ? window.Commands.get(id) : null;
        var title = (cmd && (cmd.label || cmd.title)) || b.title || b.label || id;
        var category = (cmd && cmd.category) || b.category || '';
        var description = (cmd && cmd.description) || b.description || '';
        return {
          id: id,
          title: title,
          category: category,
          key: b.sequence || b.key || '',
          keys: b.keys || (b.sequence ? [b.sequence] : []),
          when: b.when || '',
          source: b.source || 'default',
          enabled: b.enabled !== false,
          conflicted: Boolean(b.conflicted || b.conflict),
          description: description
        };
      });
    }
    return [];

    /* Legacy data sources intentionally disabled. */
    var commandIds = [];

    var effectiveMap = {};
    var defaultMap = {};
    var overrideMap = {};

    if (window.Keybindings) {
      if (typeof window.Keybindings.effective === 'function') effectiveMap = window.Keybindings.effective() || {};
      if (typeof window.Keybindings.overrides === 'function') overrideMap = window.Keybindings.overrides() || {};
      if (window.Keybindings.defaults) defaultMap = window.Keybindings.defaults || {};
    }

    // 计算冲突统计
    var keyUsage = {};
    for (var cid in effectiveMap) {
      var k = effectiveMap[cid];
      if (k) {
        keyUsage[k] = (keyUsage[k] || 0) + 1;
        if (keyUsage[k] > 1) conflictMap[k] = true;
      }
    }

    for (var i = 0; i < commandIds.length; i++) {
      var id = commandIds[i];
      var def = (window.Commands && typeof window.Commands.get === 'function') ? window.Commands.get(id) : null;
      var title = (def && (def.label || def.title)) || id;
      var key = effectiveMap[id] || defaultMap[id] || '';
      var isUser = Boolean(overrideMap[id]);
      var isConflicted = Boolean(key && conflictMap[key]);

      // 提取分类（如 file.open -> File, settings.toggle -> Settings）
      var parts = id.split('.');
      var category = parts.length > 1 ? parts[0].charAt(0).toUpperCase() + parts[0].slice(1) : 'General';

      items.push({
        id: id,
        title: title,
        category: category,
        key: key,
        keys: key ? [key] : [],
        when: 'global',
        source: isUser ? 'user' : 'default',
        enabled: true,
        conflicted: isConflicted,
        description: (def && def.description) || ''
      });
    }

    return items;
  }

  // 格式化按键展示
  function renderKeySequence(keyStr) {
    if (!keyStr) {
      return '<span class="key-assist-unbound">' + escapeHtml(t('keyAssist.unbound')) + '</span>';
    }
    // 支持 chord 如 "Ctrl+K Ctrl+S" 或单段 "Ctrl+Shift+L"
    var strokes = String(keyStr).trim().split(/\s+/);
    return strokes.map(function (stroke) {
      var parts = stroke.split('+');
      var badges = parts.map(function (p) {
        return '<kbd class="key-assist-kbd-badge">' + escapeHtml(p) + '</kbd>';
      }).join('<span class="key-assist-plus">+</span>');
      return '<span class="key-assist-stroke">' + badges + '</span>';
    }).join(' ');
  }

  function ensureDom() {
    if (state.dom && ((typeof document.body.contains === 'function' && document.body.contains(state.dom.overlay)) || (state.dom.overlay && state.dom.overlay.parentNode))) {
      return state.dom;
    }

    var overlay = document.createElement('div');
    overlay.className = 'key-assist-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    var dialog = document.createElement('div');
    dialog.className = 'key-assist-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'key-assist-title');
    dialog.setAttribute('tabindex', '-1');

    dialog.innerHTML = [
      '<div class="key-assist-header">',
      '  <div class="key-assist-title-wrap">',
      '    <h2 id="key-assist-title" class="key-assist-title">' + escapeHtml(t('keyAssist.title')) + '</h2>',
      '    <span id="key-assist-context-badge" class="key-assist-context-badge"></span>',
      '  </div>',
      '  <button id="key-assist-btn-close" class="key-assist-close-btn" aria-label="' + escapeHtml(t('keyAssist.closeAria')) + '">✕</button>',
      '</div>',
      '<div class="key-assist-search-box">',
      '  <input id="key-assist-search-input" class="key-assist-input" type="text"',
      '    role="combobox" aria-autocomplete="list" aria-expanded="true"',
      '    aria-controls="key-assist-list" aria-activedescendant=""',
      '    placeholder="' + escapeHtml(t('keyAssist.searchPlaceholder')) + '" />',
      '</div>',
      '<ul id="key-assist-list" class="key-assist-list" role="listbox" aria-label="' + escapeHtml(t('keyAssist.listAria')) + '"></ul>',
      '<div class="key-assist-footer">',
      '  <div class="key-assist-hints">',
      '    <span class="key-assist-hint-item"><kbd>↑↓</kbd> ' + escapeHtml(t('keyAssist.hintNavigate')) + '</span>',
      '    <span class="key-assist-hint-item"><kbd>Enter</kbd> ' + escapeHtml(t('keyAssist.hintRun')) + '</span>',
      '    <span class="key-assist-hint-item"><kbd>F2</kbd> ' + escapeHtml(t('keyAssist.hintEdit')) + '</span>',
      '    <span class="key-assist-hint-item"><kbd>Del</kbd> ' + escapeHtml(t('keyAssist.hintDelete')) + '</span>',
      '    <span class="key-assist-hint-item"><kbd>Esc</kbd> ' + escapeHtml(t('keyAssist.hintClose')) + '</span>',
      '  </div>',
      '  <div id="key-assist-count" class="key-assist-count"></div>',
      '</div>',
      '<div id="key-assist-live-region" class="key-assist-sr-only" role="status" aria-live="polite"></div>'
    ].join('');

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    var dom = {
      overlay: overlay,
      dialog: dialog,
      title: dialog.querySelector('#key-assist-title'),
      contextBadge: dialog.querySelector('#key-assist-context-badge'),
      btnClose: dialog.querySelector('#key-assist-btn-close'),
      searchInput: dialog.querySelector('#key-assist-search-input'),
      list: dialog.querySelector('#key-assist-list'),
      countText: dialog.querySelector('#key-assist-count'),
      liveRegion: dialog.querySelector('#key-assist-live-region')
    };

    // 事件绑定
    dom.btnClose.addEventListener('click', function () {
      close();
    });

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        close();
      }
    });

    dom.searchInput.addEventListener('input', function (e) {
      state.searchQuery = e.target.value || '';
      state.selectedIndex = 0;
      render();
    });

    dom.dialog.addEventListener('keydown', handleDialogKeyDown);

    state.dom = dom;
    return dom;
  }

  function handleDialogKeyDown(e) {
    var key = e.key;

    if (key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }

    if (key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
      return;
    }

    if (key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
      return;
    }

    if (key === 'PageDown') {
      e.preventDefault();
      moveSelection(10);
      return;
    }

    if (key === 'PageUp') {
      e.preventDefault();
      moveSelection(-10);
      return;
    }

    if (key === 'Home' && e.target !== state.dom.searchInput) {
      e.preventDefault();
      state.selectedIndex = 0;
      renderListSelectionOnly();
      return;
    }

    if (key === 'End' && e.target !== state.dom.searchInput) {
      e.preventDefault();
      state.selectedIndex = Math.max(0, state.filteredItems.length - 1);
      renderListSelectionOnly();
      return;
    }

    if (key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      executeCurrentSelection();
      return;
    }

    if (key === 'F2') {
      e.preventDefault();
      e.stopPropagation();
      editCurrentSelection();
      return;
    }

    if (key === 'Delete') {
      e.preventDefault();
      e.stopPropagation();
      unbindCurrentSelection();
      return;
    }
  }

  function moveSelection(delta) {
    var len = state.filteredItems.length;
    if (len === 0) return;
    var next = state.selectedIndex + delta;
    if (next < 0) next = 0;
    if (next >= len) next = len - 1;
    state.selectedIndex = next;
    renderListSelectionOnly();
  }

  function filterItems(items, query) {
    if (!query || !query.trim()) return items;
    var q = query.trim().toLowerCase();
    return items.filter(function (item) {
      var idMatch = (item.id || '').toLowerCase().indexOf(q) !== -1;
      var titleMatch = (item.title || '').toLowerCase().indexOf(q) !== -1;
      var catMatch = (item.category || '').toLowerCase().indexOf(q) !== -1;
      var keyMatch = (item.key || '').toLowerCase().indexOf(q) !== -1;
      return idMatch || titleMatch || catMatch || keyMatch;
    });
  }

  function render() {
    var dom = ensureDom();
    var contextId = state.options.context || getActiveContextId();
    dom.contextBadge.textContent = contextId;

    var allItems = getCommandEntries(contextId);
    state.filteredItems = filterItems(allItems, state.searchQuery);

    if (state.selectedIndex >= state.filteredItems.length) {
      state.selectedIndex = Math.max(0, state.filteredItems.length - 1);
    }

    // 渲染列表项
    if (state.filteredItems.length === 0) {
      dom.list.innerHTML = '<li class="key-assist-empty">' + escapeHtml(t('keyAssist.empty')) + '</li>';
      dom.searchInput.setAttribute('aria-activedescendant', '');
    } else {
      var html = state.filteredItems.map(function (item, index) {
        var isSelected = index === state.selectedIndex;
        var itemId = 'key-assist-opt-' + index;
        var sourceLabel = t('keyAssist.source' + (item.source ? item.source.charAt(0).toUpperCase() + item.source.slice(1) : 'Default'));
        var sourceClass = 'source-' + (item.source || 'default');

        return [
          '<li id="' + itemId + '" class="key-assist-item ' + (isSelected ? 'selected' : '') + (!item.enabled ? ' disabled' : '') + '"',
          '    role="option" aria-selected="' + (isSelected ? 'true' : 'false') + '" data-index="' + index + '" data-id="' + escapeHtml(item.id) + '">',
          '  <div class="key-assist-item-left">',
          '    <div class="key-assist-item-title-row">',
          '      <span class="key-assist-item-title">' + escapeHtml(item.title) + '</span>',
          item.category ? '      <span class="key-assist-category-badge">' + escapeHtml(item.category) + '</span>' : '',
          '      <span class="key-assist-source-badge ' + sourceClass + '">' + escapeHtml(sourceLabel) + '</span>',
          item.conflicted ? '      <span class="key-assist-conflict-badge">⚠️ ' + escapeHtml(t('keyAssist.conflict')) + '</span>' : '',
          '    </div>',
          '    <div class="key-assist-item-id">' + escapeHtml(item.id) + (item.when && item.when !== 'global' ? ' (' + escapeHtml(item.when) + ')' : '') + '</div>',
          '  </div>',
          '  <div class="key-assist-item-right">',
          '    <div class="key-assist-keys">' + renderKeySequence(item.key) + '</div>',
          '  </div>',
          '</li>'
        ].join('');
      }).join('');

      dom.list.innerHTML = html;

      // 绑定鼠标点击事件
      var itemEls = dom.list.querySelectorAll('.key-assist-item');
      Array.prototype.forEach.call(itemEls, function (el) {
        el.addEventListener('click', function () {
          var idx = parseInt(el.getAttribute('data-index'), 10);
          if (!isNaN(idx)) {
            state.selectedIndex = idx;
            renderListSelectionOnly();
            executeCurrentSelection();
          }
        });
      });

      var activeOptId = 'key-assist-opt-' + state.selectedIndex;
      dom.searchInput.setAttribute('aria-activedescendant', activeOptId);
      scrollToActive();
    }

    // 状态更新
    var countMsg = t('keyAssist.countStatus', { n: state.filteredItems.length });
    dom.countText.textContent = countMsg;
    dom.liveRegion.textContent = countMsg;
  }

  function renderListSelectionOnly() {
    var dom = state.dom;
    if (!dom) return;
    var itemEls = dom.list.querySelectorAll('.key-assist-item');
    Array.prototype.forEach.call(itemEls, function (el, idx) {
      var isSelected = idx === state.selectedIndex;
      el.classList.toggle('selected', isSelected);
      el.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });

    if (state.filteredItems.length > 0) {
      var activeOptId = 'key-assist-opt-' + state.selectedIndex;
      dom.searchInput.setAttribute('aria-activedescendant', activeOptId);
      scrollToActive();
    } else {
      dom.searchInput.setAttribute('aria-activedescendant', '');
    }
  }

  function scrollToActive() {
    if (!state.dom) return;
    var selectedEl = state.dom.list.querySelector('.key-assist-item.selected');
    if (selectedEl && typeof selectedEl.scrollIntoView === 'function') {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function executeCurrentSelection() {
    if (state.filteredItems.length === 0) return;
    var item = state.filteredItems[state.selectedIndex];
    if (!item) return;

    if (!item.enabled) {
      return;
    }

    close();

    // 优先通过 BindingService 执行，其次 Commands.run
    var service = window.BindingService;
    if (typeof service === 'function') {
      try { service = new service(); window.BindingService = service; } catch (e) { service = null; }
    }
    if (service && typeof service.execute === 'function') {
      service.execute(item.id);
    }
  }

  function editCurrentSelection() {
    if (state.filteredItems.length === 0) return;
    var item = state.filteredItems[state.selectedIndex];
    if (!item) return;

    // 分发自定义编辑事件
    var detail = { commandId: item.id, command: item };
    try {
      if (typeof window.CustomEvent === 'function') {
        window.dispatchEvent(new window.CustomEvent('key-assist-edit-binding', { detail: detail }));
      }
    } catch (e) {}

    // 若 options 提供回调
    if (typeof state.options.onEdit === 'function') {
      state.options.onEdit(item);
    }

    // 若 BindingService 提供 editBinding
    if (window.BindingService && typeof window.BindingService.openEditor === 'function') {
      window.BindingService.openEditor(item.id);
      close();
    }
  }

  function unbindCurrentSelection() {
    if (state.filteredItems.length === 0) return;
    var item = state.filteredItems[state.selectedIndex];
    if (!item || !item.key) return;

    var service = window.BindingService;
    if (typeof service === 'function') {
      try { service = new service(); window.BindingService = service; } catch (e) { service = null; }
    }
    if (service && typeof service.unbind === 'function') {
      service.unbind(item.id);
    }

    // 重新渲染当前列表
    render();

    var unbindMsg = t('keyAssist.unboundNotice', { id: item.id });
    if (state.dom && state.dom.liveRegion) {
      state.dom.liveRegion.textContent = unbindMsg;
    }
  }

  function open(options) {
    state.options = options || {};
    state.previousActiveElement = document.activeElement;
    state.isOpen = true;
    state.selectedIndex = 0;
    state.searchQuery = '';

    var dom = ensureDom();
    dom.overlay.classList.add('open');
    dom.overlay.setAttribute('aria-hidden', 'false');
    dom.overlay.style.display = 'flex';
    dom.searchInput.value = '';

    render();

    // 聚焦输入框
    if (typeof setTimeout === 'function') {
      setTimeout(function () {
        if (dom.searchInput && typeof dom.searchInput.focus === 'function') {
          dom.searchInput.focus();
        }
      }, 10);
    } else if (dom.searchInput && typeof dom.searchInput.focus === 'function') {
      dom.searchInput.focus();
    }

    return true;
  }

  function close() {
    if (!state.isOpen && (!state.dom || !state.dom.overlay.classList.contains('open'))) {
      return false;
    }
    state.isOpen = false;

    if (state.dom) {
      state.dom.overlay.classList.remove('open');
      state.dom.overlay.setAttribute('aria-hidden', 'true');
      state.dom.overlay.style.display = 'none';
    }

    // 恢复焦点
    if (state.previousActiveElement && typeof state.previousActiveElement.focus === 'function') {
      try {
        state.previousActiveElement.focus();
      } catch (e) {}
    }
    state.previousActiveElement = null;
    return true;
  }

  function toggle(options) {
    if (state.isOpen) {
      return close();
    } else {
      return open(options);
    }
  }

  function isOpen() {
    return Boolean(state.isOpen);
  }

  function refresh() {
    if (state.isOpen) {
      render();
    }
  }

  function initCommands() {
    if (!window.Commands || typeof window.Commands.register !== 'function') return;
    if (!window.Commands.has('keyassist.toggle')) {
      window.Commands.register('keyassist.toggle', {
        label: '快捷键助手',
        category: 'Help',
        run: function(opts) { toggle(opts); }
      });
    }
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', initCommands);
  } else {
    initCommands();
  }

  window.KeyAssist = {
    open: open,
    close: close,
    toggle: toggle,
    isOpen: isOpen,
    refresh: refresh,
    _state: state
  };
})();
