// Keybindings Settings（快捷键设置组件）独立 UI 模块原型 —— window.KeybindingsSettings
// 契约与规范：
// 1. 支持 mount(container) / unmount() 挂载到任意设置页容器。
// 2. 具备方案选择 (Scheme)、搜索过滤、分类徽章、When 表达式、来源显示、冲突检测。
// 3. 支持 Chord 录制弹层 (如 Ctrl+K Ctrl+S)、Delete 清除 (unbind)、Backspace 重置为当前方案默认 (reset)、恢复方案默认。
// 4. 文本多语言通过 I18n key 查询，自带中英文双语完整 Fallback。
// 5. 与 window.BindingService / ContextKeys / Commands / Keybindings 平滑适配与降级。

(function () {
  'use strict';

  var BUILTIN_SCHEMES = [];


  var FALLBACK_LOCALES = {
    'zh-CN': {
      'kbSettings.schemeLabel': '键位方案：',
      'kbSettings.restoreDefaults': '恢复方案默认',
      'kbSettings.restoreDefaultsConfirm': '确定要将当前方案的所有自定义快捷键恢复为默认值吗？',
      'kbSettings.searchPlaceholder': '搜索命令名称、ID、分类或快捷键 (如 Ctrl+S)...',
      'kbSettings.filterAll': '全部快捷键',
      'kbSettings.filterModified': '仅自定义',
      'kbSettings.filterConflicts': '仅冲突项',
      'kbSettings.countStatus': '显示 {count} / {total} 项',
      'kbSettings.colCommand': '命令',
      'kbSettings.colKeys': '按键绑定',
      'kbSettings.colWhen': '生效上下文 (When)',
      'kbSettings.colSource': '来源',
      'kbSettings.colActions': '操作',
      'kbSettings.unbound': '未绑定',
      'kbSettings.sourceUser': '自定义',
      'kbSettings.sourceScheme': '方案',
      'kbSettings.sourceDefault': '默认',
      'kbSettings.sourceExtension': '插件',
      'kbSettings.conflictBadge': '冲突',
      'kbSettings.conflictTip': '快捷键与同上下文的其他命令冲突',
      'kbSettings.actionEdit': '编辑按键 (Enter/F2)',
      'kbSettings.actionAdd': '添加按键',
      'kbSettings.actionUnbind': '清除绑定 (Delete)',
      'kbSettings.actionReset': '恢复默认 (Backspace)',
      'kbSettings.empty': '无匹配的快捷键设置',
      'kbSettings.hintNavigate': '上下导航',
      'kbSettings.hintEdit': '编辑',
      'kbSettings.hintUnbind': '清除',
      'kbSettings.hintReset': '恢复默认',
      // 录制弹层文案
      'kbRecorder.title': '自定义快捷键',
      'kbRecorder.promptInitial': '按下所需的按键组合 (例如 Ctrl+S 或 Ctrl+K Ctrl+S)...',
      'kbRecorder.promptChord': '已捕获第 1 段组合 [{key}]，请按下第 2 段按键...',
      'kbRecorder.whenLabel': '生效条件 (When 表达式)：',
      'kbRecorder.btnSave': '保存',
      'kbRecorder.btnCancel': '取消',
      'kbRecorder.btnClear': '清除按键',
      'kbRecorder.btnResetStroke': '重新录制',
      'kbRecorder.conflictWarning': '⚠️ 警告：该按键与命令 "{name}" ({id}) 在当前上下文存在冲突'
    },
    'en': {
      'kbSettings.schemeLabel': 'Keymap Scheme:',
      'kbSettings.restoreDefaults': 'Restore Defaults',
      'kbSettings.restoreDefaultsConfirm': 'Are you sure you want to reset all customized keybindings to scheme defaults?',
      'kbSettings.searchPlaceholder': 'Search by command, ID, category, or keys (e.g. Ctrl+S)...',
      'kbSettings.filterAll': 'All Keybindings',
      'kbSettings.filterModified': 'Modified Only',
      'kbSettings.filterConflicts': 'Conflicts Only',
      'kbSettings.countStatus': 'Showing {count} of {total}',
      'kbSettings.colCommand': 'Command',
      'kbSettings.colKeys': 'Keybinding',
      'kbSettings.colWhen': 'When Expression',
      'kbSettings.colSource': 'Source',
      'kbSettings.colActions': 'Actions',
      'kbSettings.unbound': 'Unbound',
      'kbSettings.sourceUser': 'User',
      'kbSettings.sourceScheme': 'Scheme',
      'kbSettings.sourceDefault': 'Default',
      'kbSettings.sourceExtension': 'Extension',
      'kbSettings.conflictBadge': 'Conflict',
      'kbSettings.conflictTip': 'Keybinding conflicts with another command in the same context',
      'kbSettings.actionEdit': 'Edit Keybinding (Enter/F2)',
      'kbSettings.actionAdd': 'Add Keybinding',
      'kbSettings.actionUnbind': 'Unbind (Delete)',
      'kbSettings.actionReset': 'Reset to Default (Backspace)',
      'kbSettings.empty': 'No matching keybindings found',
      'kbSettings.hintNavigate': 'Navigate',
      'kbSettings.hintEdit': 'Edit',
      'kbSettings.hintUnbind': 'Unbind',
      'kbSettings.hintReset': 'Reset',
      // Recorder dialog
      'kbRecorder.title': 'Record Keybinding',
      'kbRecorder.promptInitial': 'Press desired key combination (e.g. Ctrl+S or Ctrl+K Ctrl+S)...',
      'kbRecorder.promptChord': 'First stroke captured [{key}], press second stroke...',
      'kbRecorder.whenLabel': 'When Expression:',
      'kbRecorder.btnSave': 'Save',
      'kbRecorder.btnCancel': 'Cancel',
      'kbRecorder.btnClear': 'Clear Key',
      'kbRecorder.btnResetStroke': 'Reset Stroke',
      'kbRecorder.conflictWarning': '⚠️ Warning: This key combination conflicts with "{name}" ({id}) in this context'
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

  // 格式化按键展示
  function renderKeyBadges(keyStr) {
    if (!keyStr) {
      return '<span class="kb-unbound-text">' + escapeHtml(t('kbSettings.unbound')) + '</span>';
    }
    var strokes = String(keyStr).trim().split(/\s+/);
    return strokes.map(function (stroke) {
      var parts = stroke.split('+');
      var badges = parts.map(function (p) {
        return '<kbd class="kb-kbd-badge">' + escapeHtml(p) + '</kbd>';
      }).join('<span class="kb-plus">+</span>');
      return '<span class="kb-badge-list">' + badges + '</span>';
    }).join(' ');
  }

  // 规范化单次按键
  function normalizeSingleStroke(e) {
    var a = [];
    if (e.ctrlKey) a.push('Ctrl');
    if (e.altKey) a.push('Alt');
    if (e.shiftKey) a.push('Shift');
    if (e.metaKey) a.push('Meta');

    var key = e.key;
    if (!key) return null;

    // 过滤纯修饰键
    if (/^(Control|Alt|Shift|Meta)$/i.test(key)) {
      return null;
    }

    var k = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;
    return (a.length ? a.join('+') + '+' : '') + k;
  }

  var state = {
    container: null,
    activeSchemeId: 'eclipse',
    searchQuery: '',
    filterType: 'all', // all | modified | conflicts
    selectedIndex: 0,
    items: [],
    filteredItems: [],
    overrides: {},
    recorder: {
      isOpen: false,
      commandId: null,
      command: null,
      firstStroke: null,
      recordedKey: '',
      whenExpr: 'global',
      isChordWaiting: false
    },
    dom: {}
  };

  function getService() {
    var service = window.BindingService;
    return service && typeof service === 'object' && typeof service.getBindings === 'function' ? service : null;
  }

  function loadActiveSchemeId() {
    var service = getService();
    return service && typeof service.getActiveSchemeId === 'function' ? service.getActiveSchemeId() : null;
  }

  function saveActiveSchemeId(id) {
    var service = getService();
    if (!service || typeof service.setScheme !== 'function') return false;
    state.activeSchemeId = service.setScheme(id);

    // 触发全局事件
    try {
      if (typeof window.CustomEvent === 'function') {
        window.dispatchEvent(new window.CustomEvent('scheme-changed', { detail: { schemeId: id } }));
      }
    } catch (e) {}
  }

  function loadOverrides() {
    var service = getService();
    return service && typeof service.getOverrides === 'function' ? service.getOverrides() || {} : null;
  }

  function saveOverrides(map) {
    var service = getService();
    if (!service || typeof service.saveOverrides !== 'function') return false;
    state.overrides = service.saveOverrides(map) || {};
    return true;
  }

  function getSchemeDefinition(schemeId) {
    var service = getService();
    if (!service || typeof service.getSchemes !== 'function') return null;
    return service.getSchemes().filter(function (scheme) { return scheme.id === schemeId; })[0] || null;
  }

  function getAllCommandIds() {
    var service = getService();
    if (!service) return [];
    return service.getBindings().map(function (binding) { return binding.commandId; }).filter(function (id, i, all) { return all.indexOf(id) === i; });
  }

  function computeItems() {
    var service = getService();
    if (!service || !state.activeSchemeId) {
      state.items = [];
      state.filteredItems = [];
      return [];
    }
    var allBindings = service.getBindings();
    var allIds = getAllCommandIds();
    var overrides = state.overrides || {};
    var items = [];

    // 计算按键占用表检测冲突
    var keyToCmds = {};

    allIds.forEach(function (id) {
      var base = allBindings.filter(function (binding) { return binding.commandId === id; })[0];
      var override = overrides[id] && (Array.isArray(overrides[id]) ? overrides[id][0] : overrides[id]);
      var key = override ? (override.sequence || override.key || '') : (base ? base.sequence : '');
      var when = override ? (override.when || '') : (base ? base.when : '');
      if (key) {
        var mapKey = key + '::' + when;
        if (!keyToCmds[mapKey]) keyToCmds[mapKey] = [];
        keyToCmds[mapKey].push(id);
      }
    });

    allIds.forEach(function (id) {
      var cmdDef = (window.Commands && typeof window.Commands.get === 'function') ? window.Commands.get(id) : null;
      var title = (cmdDef && (cmdDef.label || cmdDef.title)) || id;
      var base = allBindings.filter(function (binding) { return binding.commandId === id; })[0];
      var override = overrides[id] && overrides[id][0];
      var hasUserOverride = overrides[id] !== undefined;
      var key = override ? override.sequence : (base ? base.sequence : '');
      var when = override ? override.when : (base ? base.when : '');
      var source = hasUserOverride ? 'user' : (base ? base.source : 'default');

      var parts = id.split('.');
      var category = parts.length > 1 ? parts[0].charAt(0).toUpperCase() + parts[0].slice(1) : 'General';

      var isConflicted = false;
      if (key) {
        var mapKey = key + '::' + when;
        if (keyToCmds[mapKey] && keyToCmds[mapKey].length > 1) {
          isConflicted = true;
        }
      }

      items.push({
        id: id,
        title: title,
        category: category,
        key: key,
        keys: key ? [key] : [],
        when: when,
        source: source,
        hasOverride: hasUserOverride,
        conflicted: isConflicted,
        defaultKey: base ? base.sequence : ''
      });
    });

    state.items = items;
    return items;
  }

  function filterItems() {
    var q = state.searchQuery.trim().toLowerCase();
    var f = state.filterType;

    state.filteredItems = state.items.filter(function (item) {
      if (f === 'modified' && !item.hasOverride) return false;
      if (f === 'conflicts' && !item.conflicted) return false;

      if (!q) return true;
      var idM = (item.id || '').toLowerCase().indexOf(q) !== -1;
      var titleM = (item.title || '').toLowerCase().indexOf(q) !== -1;
      var catM = (item.category || '').toLowerCase().indexOf(q) !== -1;
      var keyM = (item.key || '').toLowerCase().indexOf(q) !== -1;
      var whenM = (item.when || '').toLowerCase().indexOf(q) !== -1;
      return idM || titleM || catM || keyM || whenM;
    });

    if (state.selectedIndex >= state.filteredItems.length) {
      state.selectedIndex = Math.max(0, state.filteredItems.length - 1);
    }
  }

  function render() {
    if (!state.container) return;
    computeItems();
    filterItems();

    var dom = state.dom;
    if (!dom.root) return;

    // 渲染方案下拉项
    var schemes = getService() ? getService().getSchemes() : [];

    dom.schemeSelect.innerHTML = schemes.map(function (s) {
      var isSel = s.id === state.activeSchemeId;
      return '<option value="' + escapeHtml(s.id) + '"' + (isSel ? ' selected' : '') + '>' + escapeHtml(s.label || s.id) + '</option>';
    }).join('');

    // 计数更新
    dom.counterBadge.textContent = t('kbSettings.countStatus', {
      count: state.filteredItems.length,
      total: state.items.length
    });

    // 渲染表格主体
    if (state.filteredItems.length === 0) {
      dom.tableBody.innerHTML = '<tr><td colspan="5" class="kb-empty-state">' + escapeHtml(t('kbSettings.empty')) + '</td></tr>';
      return;
    }

    var rowsHtml = state.filteredItems.map(function (item, index) {
      var isSelected = index === state.selectedIndex;
      var sourceLabel = t('kbSettings.source' + item.source.charAt(0).toUpperCase() + item.source.slice(1));
      var sourceClass = 'source-' + item.source;
      var rowClass = 'kb-row' + (isSelected ? ' selected' : '') + (item.conflicted ? ' has-conflict' : '');

      return [
        '<tr class="' + rowClass + '" data-index="' + index + '" data-id="' + escapeHtml(item.id) + '" tabindex="0">',
        '  <td class="kb-col-command">',
        '    <div class="kb-command-cell">',
        '      <div class="kb-command-title-wrap">',
        '        <span class="kb-command-title">' + escapeHtml(item.title) + '</span>',
        item.category ? '        <span class="kb-category-pill">' + escapeHtml(item.category) + '</span>' : '',
        '      </div>',
        '      <div class="kb-command-id">' + escapeHtml(item.id) + '</div>',
        '    </div>',
        '  </td>',
        '  <td class="kb-col-keys">',
        '    <div class="kb-keys-cell">' + renderKeyBadges(item.key) + '</div>',
        '  </td>',
        '  <td class="kb-col-when">',
        '    <span class="kb-when-badge">' + escapeHtml(item.when) + '</span>',
        '  </td>',
        '  <td class="kb-col-source">',
        '    <span class="kb-source-badge ' + sourceClass + '">' + escapeHtml(sourceLabel) + '</span>',
        item.conflicted ? '    <span class="kb-conflict-indicator" title="' + escapeHtml(t('kbSettings.conflictTip')) + '">⚠️ ' + escapeHtml(t('kbSettings.conflictBadge')) + '</span>' : '',
        '  </td>',
        '  <td class="kb-col-actions">',
        '    <div class="kb-row-actions">',
        '      <button class="kb-action-icon-btn kb-btn-edit" data-id="' + escapeHtml(item.id) + '" title="' + escapeHtml(t('kbSettings.actionEdit')) + '">✏️</button>',
        '      <button class="kb-action-icon-btn kb-btn-unbind" data-id="' + escapeHtml(item.id) + '" title="' + escapeHtml(t('kbSettings.actionUnbind')) + '">🗑️</button>',
        item.hasOverride ? '      <button class="kb-action-icon-btn kb-btn-reset" data-id="' + escapeHtml(item.id) + '" title="' + escapeHtml(t('kbSettings.actionReset')) + '">↺</button>' : '',
        '    </div>',
        '  </td>',
        '</tr>'
      ].join('');
    }).join('');

    dom.tableBody.innerHTML = rowsHtml;

    // 绑定行点击与按钮事件
    var rows = dom.tableBody.querySelectorAll('.kb-row');
    Array.prototype.forEach.call(rows, function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.closest('.kb-action-icon-btn')) return;
        var idx = parseInt(row.getAttribute('data-index'), 10);
        if (!isNaN(idx)) {
          state.selectedIndex = idx;
          updateRowSelectionOnly();
        }
      });

      row.addEventListener('dblclick', function () {
        var id = row.getAttribute('data-id');
        if (id) openRecorder(id);
      });
    });

    var editBtns = dom.tableBody.querySelectorAll('.kb-btn-edit');
    Array.prototype.forEach.call(editBtns, function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        openRecorder(btn.getAttribute('data-id'));
      });
    });

    var unbindBtns = dom.tableBody.querySelectorAll('.kb-btn-unbind');
    Array.prototype.forEach.call(unbindBtns, function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        unbind(btn.getAttribute('data-id'));
      });
    });

    var resetBtns = dom.tableBody.querySelectorAll('.kb-btn-reset');
    Array.prototype.forEach.call(resetBtns, function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        reset(btn.getAttribute('data-id'));
      });
    });
  }

  function updateRowSelectionOnly() {
    var dom = state.dom;
    if (!dom || !dom.tableBody) return;
    var rows = dom.tableBody.querySelectorAll('.kb-row');
    Array.prototype.forEach.call(rows, function (row, idx) {
      var isSel = idx === state.selectedIndex;
      row.classList.toggle('selected', isSel);
    });
  }

  function mount(container, options) {
    unmount();
    state.container = container;
    state.activeSchemeId = loadActiveSchemeId();
    state.overrides = loadOverrides() || {};
    if (!state.activeSchemeId) state.activeSchemeId = 'ultra.eclipse';
    state.selectedIndex = 0;
    state.searchQuery = '';
    state.filterType = 'all';

    var root = document.createElement('div');
    root.className = 'keybindings-settings-root';

    root.innerHTML = [
      '<div class="kb-toolbar">',
      '  <div class="kb-toolbar-row-top">',
      '    <div class="kb-scheme-control">',
      '      <label for="kb-scheme-select" class="kb-scheme-label">' + escapeHtml(t('kbSettings.schemeLabel')) + '</label>',
      '      <select id="kb-scheme-select" class="kb-scheme-select"></select>',
      '    </div>',
      '    <div class="kb-actions-right">',
      '      <button id="kb-btn-restore-defaults" class="kb-btn kb-btn-danger">↺ ' + escapeHtml(t('kbSettings.restoreDefaults')) + '</button>',
      '    </div>',
      '  </div>',
      '  <div class="kb-toolbar-row-bottom">',
      '    <div class="kb-search-wrap">',
      '      <input id="kb-search-input" class="kb-search-input" type="text" placeholder="' + escapeHtml(t('kbSettings.searchPlaceholder')) + '" />',
      '    </div>',
      '    <select id="kb-filter-select" class="kb-filter-select">',
      '      <option value="all">' + escapeHtml(t('kbSettings.filterAll')) + '</option>',
      '      <option value="modified">' + escapeHtml(t('kbSettings.filterModified')) + '</option>',
      '      <option value="conflicts">' + escapeHtml(t('kbSettings.filterConflicts')) + '</option>',
      '    </select>',
      '    <div id="kb-counter-badge" class="kb-counter-badge"></div>',
      '  </div>',
      '</div>',
      '<div class="kb-table-container">',
      '  <table class="kb-table">',
      '    <thead>',
      '      <tr>',
      '        <th class="kb-col-command">' + escapeHtml(t('kbSettings.colCommand')) + '</th>',
      '        <th class="kb-col-keys">' + escapeHtml(t('kbSettings.colKeys')) + '</th>',
      '        <th class="kb-col-when">' + escapeHtml(t('kbSettings.colWhen')) + '</th>',
      '        <th class="kb-col-source">' + escapeHtml(t('kbSettings.colSource')) + '</th>',
      '        <th class="kb-col-actions">' + escapeHtml(t('kbSettings.colActions')) + '</th>',
      '      </tr>',
      '    </thead>',
      '    <tbody id="kb-table-body"></tbody>',
      '  </table>',
      '</div>',
      '<div class="kb-footer-status">',
      '  <div class="kb-footer-keys-hint">',
      '    <span><kbd>↑↓</kbd> ' + escapeHtml(t('kbSettings.hintNavigate')) + '</span>',
      '    <span><kbd>Enter / F2</kbd> ' + escapeHtml(t('kbSettings.hintEdit')) + '</span>',
      '    <span><kbd>Del</kbd> ' + escapeHtml(t('kbSettings.hintUnbind')) + '</span>',
      '    <span><kbd>Backspace</kbd> ' + escapeHtml(t('kbSettings.hintReset')) + '</span>',
      '  </div>',
      '</div>'
    ].join('');

    container.appendChild(root);

    var dom = {
      root: root,
      schemeSelect: root.querySelector('#kb-scheme-select'),
      btnRestoreDefaults: root.querySelector('#kb-btn-restore-defaults'),
      searchInput: root.querySelector('#kb-search-input'),
      filterSelect: root.querySelector('#kb-filter-select'),
      counterBadge: root.querySelector('#kb-counter-badge'),
      tableBody: root.querySelector('#kb-table-body')
    };

    // 事件绑定
    dom.schemeSelect.addEventListener('change', function (e) {
      saveActiveSchemeId(e.target.value);
      render();
    });

    dom.btnRestoreDefaults.addEventListener('click', function () {
      restoreSchemeDefaults();
    });

    dom.searchInput.addEventListener('input', function (e) {
      state.searchQuery = e.target.value || '';
      state.selectedIndex = 0;
      render();
    });

    dom.filterSelect.addEventListener('change', function (e) {
      state.filterType = e.target.value || 'all';
      state.selectedIndex = 0;
      render();
    });

    root.addEventListener('keydown', handleRootKeyDown);

    state.dom = dom;
    render();
    return root;
  }

  function handleRootKeyDown(e) {
    if (state.recorder.isOpen) return;

    if (e.key === 'ArrowDown') {
      if (document.activeElement && document.activeElement === state.dom.searchInput) return;
      e.preventDefault();
      if (state.filteredItems.length === 0) return;
      state.selectedIndex = Math.min(state.filteredItems.length - 1, state.selectedIndex + 1);
      updateRowSelectionOnly();
      return;
    }

    if (e.key === 'ArrowUp') {
      if (document.activeElement && document.activeElement === state.dom.searchInput) return;
      e.preventDefault();
      if (state.filteredItems.length === 0) return;
      state.selectedIndex = Math.max(0, state.selectedIndex - 1);
      updateRowSelectionOnly();
      return;
    }

    if (e.key === 'Enter' || e.key === 'F2') {
      if (document.activeElement && document.activeElement === state.dom.searchInput) return;
      e.preventDefault();
      if (state.filteredItems.length > 0) {
        var item = state.filteredItems[state.selectedIndex];
        if (item) openRecorder(item.id);
      }
      return;
    }

    if (e.key === 'Delete') {
      if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT')) return;
      e.preventDefault();
      if (state.filteredItems.length > 0) {
        var item2 = state.filteredItems[state.selectedIndex];
        if (item2) unbind(item2.id);
      }
      return;
    }

    if (e.key === 'Backspace') {
      if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT')) return;
      e.preventDefault();
      if (state.filteredItems.length > 0) {
        var item3 = state.filteredItems[state.selectedIndex];
        if (item3 && item3.hasOverride) reset(item3.id);
      }
      return;
    }
  }

  function unmount() {
    if (state.container) {
      state.container.innerHTML = '';
      state.container = null;
    }
    if (state.recorder.isOpen) {
      closeRecorder();
    }
    state.dom = {};
  }

  function unbind(commandId) {
    if (!commandId) return;
    var overrides = Object.assign({}, state.overrides);
    overrides[commandId] = [{ commandId: commandId, sequence: '', when: '', platform: '*', source: 'user', removed: true }];
    saveOverrides(overrides);
    render();
  }

  function reset(commandId) {
    if (!commandId) return;
    var overrides = Object.assign({}, state.overrides);
    delete overrides[commandId];
    saveOverrides(overrides);
    render();
  }

  function restoreSchemeDefaults() {
    saveOverrides({});
    render();
  }

  function saveBinding(commandId, keySequence, when) {
    if (!commandId) return;
    var overrides = Object.assign({}, state.overrides);
    overrides[commandId] = [{ commandId: commandId, sequence: keySequence || '', when: when || '', platform: '*', source: 'user', removed: false }];
    saveOverrides(overrides);
    render();
  }

  // ── 快捷键录制弹层 (Recorder) ──
  function ensureRecorderDom() {
    var existing = document.getElementById('kb-recorder-overlay');
    if (existing) return existing;

    var overlay = document.createElement('div');
    overlay.id = 'kb-recorder-overlay';
    overlay.className = 'kb-recorder-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    overlay.innerHTML = [
      '<div class="kb-recorder-dialog" role="dialog" aria-modal="true" aria-labelledby="kb-recorder-title" tabindex="-1">',
      '  <div class="kb-recorder-header">',
      '    <h3 id="kb-recorder-title" class="kb-recorder-title">' + escapeHtml(t('kbRecorder.title')) + '</h3>',
      '    <div id="kb-recorder-cmd-id" class="kb-recorder-cmd-id"></div>',
      '  </div>',
      '  <div id="kb-recorder-capture-box" class="kb-recorder-capture-box">',
      '    <div id="kb-recorder-sequence-display" class="kb-recorder-sequence-display"></div>',
      '    <div id="kb-recorder-status-hint" class="kb-recorder-status-hint">' + escapeHtml(t('kbRecorder.promptInitial')) + '</div>',
      '  </div>',
      '  <div id="kb-recorder-conflict-warning" class="kb-recorder-conflict-warning"></div>',
      '  <div class="kb-recorder-when-group">',
      '    <label for="kb-recorder-when-input" class="kb-recorder-when-label">' + escapeHtml(t('kbRecorder.whenLabel')) + '</label>',
      '    <input id="kb-recorder-when-input" class="kb-recorder-when-input" type="text" value="global" />',
      '  </div>',
      '  <div class="kb-recorder-footer">',
      '    <button id="kb-recorder-btn-clear" class="kb-btn kb-btn-danger">' + escapeHtml(t('kbRecorder.btnClear')) + '</button>',
      '    <div class="kb-recorder-footer-actions">',
      '      <button id="kb-recorder-btn-cancel" class="kb-btn">' + escapeHtml(t('kbRecorder.btnCancel')) + '</button>',
      '      <button id="kb-recorder-btn-save" class="kb-btn kb-btn-primary">' + escapeHtml(t('kbRecorder.btnSave')) + '</button>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('');

    document.body.appendChild(overlay);

    var dialog = overlay.querySelector('.kb-recorder-dialog');
    var cmdIdText = overlay.querySelector('#kb-recorder-cmd-id');
    var captureBox = overlay.querySelector('#kb-recorder-capture-box');
    var seqDisplay = overlay.querySelector('#kb-recorder-sequence-display');
    var statusHint = overlay.querySelector('#kb-recorder-status-hint');
    var conflictWarning = overlay.querySelector('#kb-recorder-conflict-warning');
    var whenInput = overlay.querySelector('#kb-recorder-when-input');
    var btnClear = overlay.querySelector('#kb-recorder-btn-clear');
    var btnCancel = overlay.querySelector('#kb-recorder-btn-cancel');
    var btnSave = overlay.querySelector('#kb-recorder-btn-save');

    btnCancel.addEventListener('click', closeRecorder);

    btnSave.addEventListener('click', function () {
      saveBinding(state.recorder.commandId, state.recorder.recordedKey, whenInput.value || 'global');
      closeRecorder();
    });

    btnClear.addEventListener('click', function () {
      state.recorder.recordedKey = '';
      state.recorder.firstStroke = null;
      state.recorder.isChordWaiting = false;
      updateRecorderDisplay();
    });

    dialog.addEventListener('keydown', handleRecorderKeyDown);

    return overlay;
  }

  function openRecorder(commandId) {
    var item = null;
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === commandId) {
        item = state.items[i];
        break;
      }
    }
    if (!item) {
      item = { id: commandId, title: commandId, key: '', when: 'global' };
    }

    state.recorder.isOpen = true;
    state.recorder.commandId = commandId;
    state.recorder.command = item;
    state.recorder.firstStroke = null;
    state.recorder.recordedKey = item.key || '';
    state.recorder.whenExpr = item.when || 'global';
    state.recorder.isChordWaiting = false;

    var overlay = ensureRecorderDom();
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');

    overlay.querySelector('#kb-recorder-cmd-id').textContent = item.title + ' (' + item.id + ')';
    overlay.querySelector('#kb-recorder-when-input').value = state.recorder.whenExpr;

    updateRecorderDisplay();

    var dialog = overlay.querySelector('.kb-recorder-dialog');
    if (dialog && typeof dialog.focus === 'function') {
      dialog.focus();
    }
  }

  function closeRecorder() {
    state.recorder.isOpen = false;
    var overlay = document.getElementById('kb-recorder-overlay');
    if (overlay) {
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
    }
  }

  function handleRecorderKeyDown(e) {
    var key = e.key;

    // 当用户聚焦在 When 输入框时，放行输入
    if (e.target && e.target.id === 'kb-recorder-when-input') {
      if (key === 'Escape') {
        e.preventDefault();
        closeRecorder();
      } else if (key === 'Enter') {
        e.preventDefault();
        var whenInput = document.getElementById('kb-recorder-when-input');
        saveBinding(state.recorder.commandId, state.recorder.recordedKey, whenInput ? whenInput.value : 'global');
        closeRecorder();
      }
      return;
    }

    if (key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeRecorder();
      return;
    }

    if (key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      var whenInput2 = document.getElementById('kb-recorder-when-input');
      saveBinding(state.recorder.commandId, state.recorder.recordedKey, whenInput2 ? whenInput2.value : 'global');
      closeRecorder();
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    var stroke = normalizeSingleStroke(e);
    if (!stroke) return;

    // Chord 状态机：支持形如 "Ctrl+K Ctrl+S" 的双击段 Chord
    if (!state.recorder.firstStroke) {
      // 第一段按键捕获
      if (stroke.startsWith('Ctrl+') || stroke.startsWith('Alt+') || stroke.startsWith('Shift+')) {
        state.recorder.firstStroke = stroke;
        state.recorder.recordedKey = stroke;
        state.recorder.isChordWaiting = true;
      } else {
        // 单击按键 (如 F12)
        state.recorder.recordedKey = stroke;
        state.recorder.firstStroke = null;
        state.recorder.isChordWaiting = false;
      }
    } else {
      // 第二段按键捕获：拼装成完整 Chord
      state.recorder.recordedKey = state.recorder.firstStroke + ' ' + stroke;
      state.recorder.firstStroke = null;
      state.recorder.isChordWaiting = false;
    }

    updateRecorderDisplay();
  }

  function updateRecorderDisplay() {
    var overlay = document.getElementById('kb-recorder-overlay');
    if (!overlay) return;

    var seqDisplay = overlay.querySelector('#kb-recorder-sequence-display');
    var statusHint = overlay.querySelector('#kb-recorder-status-hint');
    var captureBox = overlay.querySelector('#kb-recorder-capture-box');
    var conflictEl = overlay.querySelector('#kb-recorder-conflict-warning');

    seqDisplay.innerHTML = renderKeyBadges(state.recorder.recordedKey);

    if (state.recorder.isChordWaiting && state.recorder.firstStroke) {
      statusHint.textContent = t('kbRecorder.promptChord', { key: state.recorder.firstStroke });
      captureBox.classList.add('active-recording');
    } else {
      statusHint.textContent = t('kbRecorder.promptInitial');
      captureBox.classList.remove('active-recording');
    }

    // 检测实时录制冲突
    var key = state.recorder.recordedKey;
    var when = overlay.querySelector('#kb-recorder-when-input').value || 'global';
    var conflictTarget = null;

    if (key) {
      for (var i = 0; i < state.items.length; i++) {
        var it = state.items[i];
        if (it.id !== state.recorder.commandId && it.key === key && it.when === when) {
          conflictTarget = it;
          break;
        }
      }
    }

    if (conflictTarget) {
      conflictEl.textContent = t('kbRecorder.conflictWarning', {
        name: conflictTarget.title,
        id: conflictTarget.id
      });
      conflictEl.classList.add('show');
    } else {
      conflictEl.classList.remove('show');
      conflictEl.textContent = '';
    }
  }

  window.KeybindingsSettings = {
    mount: mount,
    unmount: unmount,
    getSchemes: function () {
      var service = getService();
      return service ? service.getSchemes() : [];
    },
    getActiveSchemeId: loadActiveSchemeId,
    setScheme: function (id) { return saveActiveSchemeId(id); },
    restoreSchemeDefaults: restoreSchemeDefaults,
    openRecorder: openRecorder,
    closeRecorder: closeRecorder,
    unbind: unbind,
    reset: reset,
    saveBinding: saveBinding,
    refresh: render,
    normalizeSingleStroke: normalizeSingleStroke,
    _state: state
  };
})();
