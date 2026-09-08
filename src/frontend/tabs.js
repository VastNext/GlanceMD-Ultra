var TabManager = (function() {
  var tabs = [];
  var activeTabId = null;
  var tabIdCounter = 0;
  // i18n：I18n 未装载时回退 key（实际装载顺序 i18n.js 最前，不会发生）
  function t(key, params) { return window.I18n ? window.I18n.t(key, params) : key; }

  /* ── 拖拽重排状态 ──
     activeDrag 持有当前拖拽上下文；dragJustEnded 用于抑制拖拽结束后的 click 误触发 */
  var activeDrag = null;
  var dragJustEnded = false;
  var DRAG_THRESHOLD = 5; /* 位移超过该像素数才视为拖拽，否则仍是普通点击 */

  function normalizePath(p) {
    return p.replace(/\\/g, '/');
  }

  function effectiveSettings() {
    var sa = window.SettingsApply;
    try { return sa && typeof sa.get === 'function' ? (sa.get() || {}) : {}; } catch (e) { return {}; }
  }

  function shouldConfirmCloseDirty() {
    var recovery = effectiveSettings().recovery || {};
    return recovery.confirmCloseDirty !== false;
  }

  function largeFileLimitBytes() {
    var ed = effectiveSettings().editor || {};
    var mb = Number(ed.largeFileMB);
    return isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 5 * 1024 * 1024;
  }

  function canRenderLive(content) {
    return String(content || '').length <= largeFileLimitBytes();
  }

  function createTab(path, content, forceMode, forceFilename) {
    if (path) {
      var existing = findTabByPath(path);
      if (existing) {
        switchTab(existing.id);
        return existing;
      }
    }

    var active = getActiveTab();
    if (active && !active.path && !active.dirty && active.content === '' && path) {
      active.path = normalizePath(path);
      active.filename = path.split(/[/\\]/).pop();
      active.content = content != null ? content : '';
      active.dirty = false;
      active.mode = 'preview';
      restoreTabState(active);
      renderTabBar();
      updateWindowTitle();
      return active;
    }

    var id = ++tabIdCounter;
    var tab = {
      id: id,
      path: path ? normalizePath(path) : null,
      filename: forceFilename || (path ? path.split(/[/\\]/).pop() : t('tabs.untitled')),
      content: content != null ? content : '',
      dirty: false,
      mode: forceMode || (path ? 'preview' : 'edit'),
      scrollTop: 0,
      cursorStart: 0,
      cursorEnd: 0,
      parsedHtml: null
    };
    tabs.push(tab);
    switchTab(id);
    return tab;
  }

  function syncProjectTree(tab) {
    if (!window.ProjectTree || typeof window.ProjectTree.setActiveFile !== 'function') return;
    window.ProjectTree.setActiveFile(tab && tab.path ? tab.path : null);
    if (tab && tab.path && typeof window.ProjectTree.revealCurrent === 'function') {
      window.ProjectTree.revealCurrent(true);
    }
  }

  function executeCloseTab(id) {
    var idx = tabs.findIndex(function(t) { return t.id === id; });
    if (idx === -1) return;
    tabs.splice(idx, 1);
    syncDirtyState();
    if (tabs.length === 0) {
      activeTabId = null;
      var editor = document.getElementById('editor');
      if (editor) editor.value = '';
      renderTabBar();
      updateWindowTitle();
      var statusFile = document.getElementById('status-file');
      if (statusFile) statusFile.textContent = '';
      if (typeof updateWordCount === 'function') updateWordCount();
      if (typeof resetToWelcomeState === 'function') resetToWelcomeState();
      else if (typeof updateWelcome === 'function') updateWelcome();
      else if (typeof showRecentPanel === 'function') showRecentPanel();
      syncProjectTree(null);
      if (window.SettingsApply && typeof window.SettingsApply.syncGutter === 'function') window.SettingsApply.syncGutter();
      return;
    }
    if (activeTabId === id) {
      var newIdx = Math.min(idx, tabs.length - 1);
      switchTab(tabs[newIdx].id);
    } else {
      renderTabBar();
    }
  }

  function closeTab(id) {
    var idx = tabs.findIndex(function(t) { return t.id === id; });
    if (idx === -1) return;
    var tab = tabs[idx];
    if (tab.dirty && shouldConfirmCloseDirty()) {
      if (window.ConfirmDialog && typeof window.ConfirmDialog.show === 'function') {
        window.ConfirmDialog.show({
          title: t('app.unsavedCloseTitle') || '未保存的修改',
          message: t('tabs.closeConfirm', { name: tab.filename }),
          confirmText: '放弃修改并关闭',
          cancelText: '取消',
          danger: true
        }).then(function(confirmed) {
          if (confirmed) executeCloseTab(id);
        });
        return;
      } else if (typeof confirm === 'function' && !confirm(t('tabs.closeConfirm', { name: tab.filename }))) {
        return;
      }
    }
    executeCloseTab(id);
  }

  /* ── 批量关闭 ──
     整批只做一次 dirty 确认（文案含数量），不走逐个 closeTab 的确认；
     关闭后活动 tab 沿用 closeTab 的相邻规则：以被移除的最左下标为锚，
     取移除后占据该位置的 tab（min(锚下标, 末位)）；全部关完进入欢迎态 */
  function executeCloseTabs(ids) {
    var idSet = {};
    (ids || []).forEach(function(id) { idSet[id] = true; });
    var targets = tabs.filter(function(t) { return idSet[t.id]; });
    if (targets.length === 0) return;
    var anchorIdx = tabs.indexOf(targets[0]);
    tabs = tabs.filter(function(t) { return !idSet[t.id]; });
    syncDirtyState();
    if (tabs.length === 0) {
      activeTabId = null;
      var editor = document.getElementById('editor');
      if (editor) editor.value = '';
      renderTabBar();
      updateWindowTitle();
      var statusFile = document.getElementById('status-file');
      if (statusFile) statusFile.textContent = '';
      if (typeof updateWordCount === 'function') updateWordCount();
      if (typeof resetToWelcomeState === 'function') resetToWelcomeState();
      else if (typeof updateWelcome === 'function') updateWelcome();
      else if (typeof showRecentPanel === 'function') showRecentPanel();
      syncProjectTree(null);
      return;
    }
    if (!getActiveTab() || idSet[activeTabId]) {
      switchTab(tabs[Math.min(anchorIdx, tabs.length - 1)].id);
    } else {
      renderTabBar();
    }
  }

  function closeTabs(ids) {
    var idSet = {};
    (ids || []).forEach(function(id) { idSet[id] = true; });
    var targets = tabs.filter(function(t) { return idSet[t.id]; });
    if (targets.length === 0) return;
    var dirtyCount = targets.filter(function(t) { return t.dirty; }).length;
    if (dirtyCount > 0 && shouldConfirmCloseDirty()) {
      if (window.ConfirmDialog && typeof window.ConfirmDialog.show === 'function') {
        window.ConfirmDialog.show({
          title: t('app.unsavedCloseTitle') || '未保存的修改',
          message: t('tabs.closeBatchConfirm', { n: dirtyCount }),
          confirmText: '放弃修改并关闭',
          cancelText: '取消',
          danger: true
        }).then(function(confirmed) {
          if (confirmed) executeCloseTabs(ids);
        });
        return;
      } else if (typeof confirm === 'function' && !confirm(t('tabs.closeBatchConfirm', { n: dirtyCount }))) {
        return;
      }
    }
    executeCloseTabs(ids);
  }

  function switchTab(id) {
    var outgoing = getActiveTab();
    if (outgoing && outgoing.id === id) {
      renderTabBar();
      return;
    }
    if (outgoing) {
      saveTabState(outgoing);
    }
    activeTabId = id;
    var tab = getActiveTab();
    if (!tab) return;
    restoreTabState(tab);
    renderTabBar();
    ensureActiveTabVisible();
    updateWindowTitle();
  }

  function saveTabState(tab) {
    var editor = document.getElementById('editor');
    tab.content = editor.value;
    tab.cursorStart = editor.selectionStart;
    tab.cursorEnd = editor.selectionEnd;
    tab.mode = currentMode;
    if (currentMode === 'edit') {
      tab.scrollTop = editor.scrollTop;
    } else {
      tab.scrollTop = window.PreviewNavigation && typeof window.PreviewNavigation.getScrollTop === 'function'
        ? window.PreviewNavigation.getScrollTop()
        : 0;
    }
  }

  function restoreTabState(tab) {
    syncProjectTree(tab);
    var editor = document.getElementById('editor');
    editor.value = tab.content;

    if (typeof splitMode !== 'undefined' && splitMode) {
      editor.scrollTop = tab.scrollTop;
      editor.selectionStart = tab.cursorStart;
      editor.selectionEnd = tab.cursorEnd;
      editor.focus();
      if (!canRenderLive(tab.content)) {
        document.getElementById('preview').textContent = t('tabs.largeFilePreviewDisabled');
        tab.parsedHtml = null;
      } else if (tab.parsedHtml) {
        document.getElementById('preview').innerHTML = tab.parsedHtml;
      } else {
        var html = marked.parse(tab.content);
        document.getElementById('preview').innerHTML = html;
        tab.parsedHtml = html;
      }
      if (typeof resolveLocalImages === 'function') resolveLocalImages();
    } else {
      if (tab.mode !== currentMode) {
        toggleMode();
      }
      if (currentMode === 'edit') {
        editor.scrollTop = tab.scrollTop;
        editor.selectionStart = tab.cursorStart;
        editor.selectionEnd = tab.cursorEnd;
        editor.focus();
      } else {
        if (!canRenderLive(tab.content)) {
          document.getElementById('preview').textContent = t('tabs.largeFilePreviewDisabled');
          tab.parsedHtml = null;
        } else if (tab.parsedHtml) {
          document.getElementById('preview').innerHTML = tab.parsedHtml;
        } else {
          var html = marked.parse(tab.content);
          document.getElementById('preview').innerHTML = html;
          tab.parsedHtml = html;
        }
        if (typeof resolveLocalImages === 'function' && canRenderLive(tab.content)) resolveLocalImages();
        setTimeout(function() {
          if (window.PreviewNavigation && typeof window.PreviewNavigation.setScrollTop === 'function') {
            window.PreviewNavigation.setScrollTop(tab.scrollTop);
          }
        }, 0);
      }
    }

    var statusFile = document.getElementById('status-file');
    if (statusFile) statusFile.textContent = tab.filename;
    if (typeof updateWordCount === 'function') updateWordCount();
    if (typeof updateWelcome === 'function') updateWelcome();
    else if (typeof showRecentPanel === 'function') showRecentPanel();
    if (typeof tocOpen !== 'undefined' && tocOpen && typeof updateTOC === 'function') updateTOC();
    if (window.SettingsApply && typeof window.SettingsApply.syncGutter === 'function') {
      window.SettingsApply.syncGutter();
    }
  }

  function markDirty(id) {
    var tab = tabs.find(function(t) { return t.id === (id || activeTabId); });
    if (tab && !tab.dirty) {
      tab.dirty = true;
      renderTabBar();
      updateWindowTitle();
      syncDirtyState();
    }
  }

  function markClean(id) {
    var tab = tabs.find(function(t) { return t.id === (id || activeTabId); });
    if (tab) {
      tab.dirty = false;
      renderTabBar();
      updateWindowTitle();
      syncDirtyState();
    }
  }

  function updateWindowTitle() {
    var tab = getActiveTab();
    if (!tab) {
      sendToRust('set_title', { title: 'GlanceMD Ultra' });
      if (typeof setTitle === 'function') setTitle('GlanceMD Ultra');
      return;
    }
    var title = 'GlanceMD Ultra - ' + tab.filename;
    if (tab.dirty) title += ' *';
    sendToRust('set_title', { title: title });
    if (typeof setTitle === 'function') setTitle(tab.filename + (tab.dirty ? ' *' : ''));
  }

  function renderTabBar() {
    var bar = document.getElementById('tab-bar');
    var wrap = document.getElementById('tab-bar-wrap');
    var show = tabs.length > 0;
    if (wrap) wrap.style.display = show ? '' : 'none';
    document.body.classList.toggle('has-tabs', show);
    if (!bar) return;
    bar.innerHTML = '';
    if (!show) return;
    tabs.forEach(function(tab) {
      bar.appendChild(createTabElement(tab));
    });
    updateTabNav();
    ensureActiveTabVisible();
  }

  function ensureActiveTabVisible() {
    var bar = document.getElementById('tab-bar');
    if (!bar) return;
    var active = bar.querySelector('.tab.active');
    if (!active) return;
    var left = active.offsetLeft;
    var right = left + active.offsetWidth;
    if (left < bar.scrollLeft) bar.scrollLeft = left;
    else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right - bar.clientWidth;
    updateTabNav();
  }

  function createTabElement(tab) {
    var el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
    el.dataset.tabId = tab.id;

    var label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = tab.filename;
    el.appendChild(label);

    if (tab.dirty) {
      var dot = document.createElement('span');
      dot.className = 'tab-dirty';
      dot.textContent = '\u2022';
      el.appendChild(dot);
    }

    var close = document.createElement('span');
    close.className = 'tab-close';
    close.innerHTML = '&times;';
    close.addEventListener('click', function(e) {
      e.stopPropagation();
      closeTab(tab.id);
    });
    el.appendChild(close);

    el.addEventListener('click', function() {
      /* 拖拽结束时浏览器会补发一次 click，忽略以免误切换 */
      if (dragJustEnded) {
        dragJustEnded = false;
        return;
      }
      switchTab(tab.id);
    });
    el.addEventListener('mousedown', function(e) {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tab.id);
      } else if (e.button === 0) {
        beginDragWatch(el, e);
      }
    });
    el.addEventListener('contextmenu', function(e) {
      if (e.preventDefault) e.preventDefault();
      /* 不冒泡到 document 关闭逻辑，避免菜单刚打开就被关闭（同 project-tree） */
      if (e.stopPropagation) e.stopPropagation();
      openTabMenu(
        typeof e.clientX === 'number' ? e.clientX : 0,
        typeof e.clientY === 'number' ? e.clientY : 0,
        tab.id
      );
    });
    return el;
  }

  /* ── 拖拽重排 ──
     mousedown 记录起点，位移超阈值进入拖拽；拖拽期间直接移动 DOM 元素
     实时预览顺序，mouseup 后按 DOM 顺序同步 tabs 数组 */

  function beginDragWatch(el, e) {
    if (tabs.length < 2) return;
    activeDrag = {
      el: el,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false
    };
  }

  function onDragMove(e) {
    if (!activeDrag) return;
    if (!activeDrag.dragging) {
      var dx = e.clientX - activeDrag.startX;
      var dy = e.clientY - activeDrag.startY;
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      activeDrag.dragging = true;
      dragJustEnded = true;
      activeDrag.el.classList.add('dragging');
      document.body.classList.add('tab-drag-active');
    }
    e.preventDefault();

    var el = activeDrag.el;
    var bar = document.getElementById('tab-bar');
    var barRect = bar.getBoundingClientRect();

    /* 接近 tab 栏左右边缘时自动横向滚动 */
    var edge = 28;
    if (e.clientX < barRect.left + edge) {
      bar.scrollLeft -= 8;
    } else if (e.clientX > barRect.right - edge) {
      bar.scrollLeft += 8;
    }

    /* 依据鼠标相对各 tab 中点的位置实时移动元素 */
    var siblings = Array.prototype.slice.call(bar.querySelectorAll('.tab'));
    var placed = false;
    for (var i = 0; i < siblings.length; i++) {
      var s = siblings[i];
      if (s === el) continue;
      var r = s.getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) {
        if (s.previousElementSibling !== el) bar.insertBefore(el, s);
        placed = true;
        break;
      }
    }
    if (!placed) {
      var last = siblings[siblings.length - 1];
      if (last && last !== el && el.previousElementSibling !== last) {
        bar.insertBefore(el, last.nextSibling);
      }
    }
  }

  function onDragEnd() {
    if (!activeDrag) return;
    var el = activeDrag.el;
    var wasDragging = activeDrag.dragging;
    activeDrag = null;
    if (!wasDragging) return;

    el.classList.remove('dragging');
    document.body.classList.remove('tab-drag-active');

    /* 按 DOM 顺序重排 tabs 数组 */
    var order = Array.prototype.map.call(
      document.getElementById('tab-bar').querySelectorAll('.tab'),
      function(n) { return Number(n.dataset.tabId); }
    );
    tabs.sort(function(a, b) {
      return order.indexOf(a.id) - order.indexOf(b.id);
    });
    renderTabBar();
    /* renderTabBar 已重建 DOM，旧元素上的 click 不会再触发，重置抑制标志 */
    dragJustEnded = false;
  }

  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);

  /* ── tab 右键菜单 ──
     视觉复用 project-tree.css 的 .ctx-menu/.ctx-item（该 CSS 全局注入，无需新样式）。
     与项目树菜单共存：两边的 document 级 contextmenu/click 监听都以各自菜单的
     开合状态门控（tree 侧见 project-tree.js bindDocumentHandlers），菜单关闭时互为
     no-op、不抢占；本菜单的开启（tab 元素 contextmenu）与菜单项点击均
     stopPropagation，避免事件冒泡到 document 关闭逻辑把刚打开的菜单立即关闭；
     菜单开着时的"外部关闭"由下方 document 级监听负责。 */

  var tabMenuEl = null;
  var tabMenuOpen = false;
  var tabMenuTargetId = null;
  var TAB_MENU_DEFS = [
    { action: 'close', label: t('tabs.menuClose') },
    { action: 'left', label: t('tabs.menuCloseLeft') },
    { action: 'right', label: t('tabs.menuCloseRight') },
    { action: 'all', label: t('tabs.menuCloseAll') }
  ];

  function tabMenuItems() {
    if (!tabMenuEl) return [];
    return Array.prototype.filter.call(tabMenuEl.children || [], function(el) {
      return el.dataset && el.dataset.action;
    });
  }

  function buildTabMenu() {
    if (tabMenuEl) return tabMenuEl;
    tabMenuEl = document.createElement('div');
    tabMenuEl.className = 'ctx-menu';
    tabMenuEl.setAttribute('role', 'menu');
    tabMenuEl.setAttribute('aria-label', t('tabs.menuAria'));
    TAB_MENU_DEFS.forEach(function(def) {
      var item = document.createElement('div');
      item.className = 'ctx-item';
      item.dataset.action = def.action;
      item.setAttribute('role', 'menuitem');
      item.setAttribute('tabindex', '-1');
      item.textContent = def.label;
      item.addEventListener('click', function(e) {
        /* 不冒泡到 document 关闭逻辑（同 project-tree 菜单项） */
        if (e.stopPropagation) e.stopPropagation();
        if (item.classList.contains('disabled')) return;
        var id = tabMenuTargetId;
        runTabMenuAction(item.dataset.action, id);
        closeTabMenu();
      });
      tabMenuEl.appendChild(item);
    });
    return tabMenuEl;
  }

  /* 可用态：以右键目标 tab 为锚，对应侧没有 tab 时置灰 */
  function refreshTabMenuState() {
    if (!tabMenuEl) return;
    var idx = tabs.findIndex(function(t) { return t.id === tabMenuTargetId; });
    var state = {
      'close': idx !== -1,
      'left': idx > 0,
      'right': idx !== -1 && idx < tabs.length - 1,
      'all': tabs.length > 0
    };
    tabMenuItems().forEach(function(item) {
      var disabled = !state[item.dataset.action];
      item.classList.toggle('disabled', disabled);
      item.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    });
  }

  function runTabMenuAction(action, id) {
    var idx = tabs.findIndex(function(t) { return t.id === id; });
    if (action === 'close') {
      closeTab(id); /* 保留单 tab 的 dirty 确认语义 */
    } else if (action === 'left') {
      if (idx <= 0) return;
      closeTabs(tabs.slice(0, idx).map(function(t) { return t.id; }));
    } else if (action === 'right') {
      if (idx === -1 || idx >= tabs.length - 1) return;
      closeTabs(tabs.slice(idx + 1).map(function(t) { return t.id; }));
    } else if (action === 'all') {
      closeTabs(tabs.map(function(t) { return t.id; }));
    }
  }

  function openTabMenu(x, y, id) {
    closeTabMenu(); /* 重复右键另一 tab 时换目标重开而非叠加 */
    tabMenuTargetId = id;
    var menu = buildTabMenu();
    refreshTabMenuState();
    document.body.appendChild(menu);
    /* 先挂载测量再夹紧，空间不足时向内翻转，确保不越出 viewport（同 project-tree） */
    var px = typeof x === 'number' ? x : 0;
    var py = typeof y === 'number' ? y : 0;
    var rect = menu.getBoundingClientRect ? menu.getBoundingClientRect() : { width: 212, height: 26 * 4 + 8 };
    var vw = typeof window.innerWidth === 'number' && window.innerWidth > 0 ? window.innerWidth : 1024;
    var vh = typeof window.innerHeight === 'number' && window.innerHeight > 0 ? window.innerHeight : 768;
    var width = rect.width || 212;
    var height = rect.height || (26 * 4 + 8);
    if (px + width > vw) px = Math.max(0, px - width);
    if (py + height > vh) py = Math.max(0, py - height);
    px = Math.max(0, Math.min(px, Math.max(0, vw - width)));
    py = Math.max(0, Math.min(py, Math.max(0, vh - height)));
    menu.style.left = px + 'px';
    menu.style.top = py + 'px';
    tabMenuOpen = true;
  }

  function closeTabMenu() {
    tabMenuOpen = false;
    tabMenuTargetId = null;
    if (tabMenuEl && tabMenuEl.parentNode && tabMenuEl.parentNode.removeChild) {
      tabMenuEl.parentNode.removeChild(tabMenuEl);
    }
  }

  /* 菜单开着期间：菜单外点击 / 右键 / Esc 均关闭（document 级，开合状态门控） */
  document.addEventListener('click', function(e) {
    if (!tabMenuOpen) return;
    if (e.target && tabMenuEl && tabMenuEl.contains && tabMenuEl.contains(e.target)) return;
    closeTabMenu();
  });
  document.addEventListener('keydown', function(e) {
    if (tabMenuOpen && e.key === 'Escape') {
      if (e.preventDefault) e.preventDefault();
      closeTabMenu();
    }
  });
  document.addEventListener('contextmenu', function(e) {
    if (!tabMenuOpen) return;
    if (e.target && tabMenuEl && tabMenuEl.contains && tabMenuEl.contains(e.target)) return;
    closeTabMenu();
  });

  /* ── tab 溢出导航 ──
     tab 过多超出栏宽时显示左右按钮；同时在滚动区内支持滚轮横向滚动 */

  var TAB_NAV_STEP = 240; /* 每次点击滚动的像素距离 */

  function updateTabNav() {
    var bar = document.getElementById('tab-bar');
    var left = document.getElementById('tab-nav-left');
    var right = document.getElementById('tab-nav-right');
    if (!bar || !left || !right) return;
    var overflow = bar.scrollWidth > bar.clientWidth + 1;
    left.classList.toggle('visible', overflow);
    right.classList.toggle('visible', overflow);
    left.classList.toggle('disabled', bar.scrollLeft <= 1);
    right.classList.toggle('disabled', bar.scrollLeft >= bar.scrollWidth - bar.clientWidth - 1);
  }

  function initTabNav() {
    var bar = document.getElementById('tab-bar');
    var left = document.getElementById('tab-nav-left');
    var right = document.getElementById('tab-nav-right');
    if (!bar || !left || !right) return;
    left.addEventListener('click', function() {
      bar.scrollLeft -= TAB_NAV_STEP;
    });
    right.addEventListener('click', function() {
      bar.scrollLeft += TAB_NAV_STEP;
    });
    bar.addEventListener('scroll', updateTabNav);
    /* 垂直滚轮转为 tab 栏横向滚动 */
    bar.addEventListener('wheel', function(e) {
      if (bar.scrollWidth <= bar.clientWidth) return;
      e.preventDefault();
      bar.scrollLeft += e.deltaY;
    });
    window.addEventListener('resize', updateTabNav);
  }
  initTabNav();

  function nextTab() {
    if (tabs.length < 2) return;
    var idx = tabs.findIndex(function(t) { return t.id === activeTabId; });
    switchTab(tabs[(idx + 1) % tabs.length].id);
  }

  function prevTab() {
    if (tabs.length < 2) return;
    var idx = tabs.findIndex(function(t) { return t.id === activeTabId; });
    switchTab(tabs[(idx - 1 + tabs.length) % tabs.length].id);
  }

  function findTabByPath(path) {
    if (!path) return null;
    var norm = normalizePath(path).toLowerCase();
    return tabs.find(function(t) { return t.path && t.path.toLowerCase() === norm; }) || null;
  }

  function getActiveTab() {
    return tabs.find(function(t) { return t.id === activeTabId; }) || null;
  }

  function hasAnyDirty() {
    return tabs.some(function(t) { return t.dirty; });
  }

  function syncDirtyState() {
    sendToRust('set_dirty_state', { dirty: hasAnyDirty() });
  }

  function updateTabPath(id, path) {
    var tab = tabs.find(function(t) { return t.id === (id || activeTabId); });
    if (tab) {
      tab.path = path ? normalizePath(path) : null;
      tab.filename = path ? path.split(/[/\\]/).pop() : t('tabs.untitled');
      syncProjectTree(tab);
      renderTabBar();
      updateWindowTitle();
      document.getElementById('status-file').textContent = tab.filename;
    }
  }

  var tabSwitcher = { open: false, selected: 0, previousFocus: null };

  function switcherItems() { return tabs.slice(); }
  function renderTabSwitcher() {
    var panel = document.getElementById('tab-switcher');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'tab-switcher';
      panel.setAttribute('role', 'dialog');
      panel.tabIndex = -1;
      document.body.appendChild(panel);
    }
    var items = switcherItems();
    if (tabSwitcher.selected >= items.length) tabSwitcher.selected = Math.max(0, items.length - 1);
    panel.innerHTML = items.map(function(tab, index) {
      return '<button type="button" data-tab-id="' + tab.id + '" class="tab-switcher-item' + (index === tabSwitcher.selected ? ' active' : '') + '">' +
        String(tab.filename).replace(/[&<>\"]/g, function(ch) { return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;' })[ch]; }) + (tab.dirty ? ' •' : '') + '</button>';
    }).join('') || '<p>暂无已打开标签页</p>';
    Array.prototype.forEach.call(panel.querySelectorAll('button'), function(button, index) {
      button.addEventListener('click', function() { switchTab(Number(button.dataset.tabId)); closeTabSwitcher(); });
      if (index === tabSwitcher.selected && button.scrollIntoView) button.scrollIntoView({ block: 'nearest' });
    });
    panel.hidden = !tabSwitcher.open;
  }
  function openTabSwitcher() {
    if (!tabs.length) return;
    tabSwitcher.open = true;
    tabSwitcher.selected = Math.max(0, tabs.findIndex(function(t) { return t.id === activeTabId; }));
    tabSwitcher.previousFocus = document.activeElement;
    renderTabSwitcher();
    var panel = document.getElementById('tab-switcher');
    if (panel && panel.focus) panel.focus();
  }
  function closeTabSwitcher() {
    tabSwitcher.open = false;
    renderTabSwitcher();
    if (tabSwitcher.previousFocus && tabSwitcher.previousFocus.focus) tabSwitcher.previousFocus.focus();
    tabSwitcher.previousFocus = null;
  }
  function toggleTabSwitcher() { tabSwitcher.open ? closeTabSwitcher() : openTabSwitcher(); }
  function moveTabSwitcher(delta) {
    if (!tabSwitcher.open) return;
    tabSwitcher.selected = Math.max(0, Math.min(tabs.length - 1, tabSwitcher.selected + delta));
    renderTabSwitcher();
  }
  document.addEventListener('keydown', function(e) {
    if (!tabSwitcher.open) return;
    if (e.key === 'Escape') { e.preventDefault(); closeTabSwitcher(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveTabSwitcher(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveTabSwitcher(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (tabs[tabSwitcher.selected]) { switchTab(tabs[tabSwitcher.selected].id); closeTabSwitcher(); } }
  });

  function initCommands() {
    if (!window.Commands || typeof window.Commands.register !== 'function') return;
    var reg = window.Commands.register;
    function safeReg(id, def) {
      if (!window.Commands.has(id)) reg(id, def);
    }
    var nextDef = { label: '下一个标签页', category: 'View', run: function() { nextTab(); } };
    var prevDef = { label: '上一个标签页', category: 'View', run: function() { prevTab(); } };
    safeReg('tabs.next', nextDef);
    safeReg('tabs.previous', prevDef);
    // Ex 与旧调用保留安全别名，逻辑只有一份。
    safeReg('tab.next', { label: nextDef.label, category: nextDef.category, run: nextDef.run });
    safeReg('tab.previous', { label: prevDef.label, category: prevDef.category, run: prevDef.run });
    safeReg('tab.close', {
      label: '关闭标签页',
      category: 'File',
      run: function(arg) {
        var id = arg && typeof arg === 'object' ? arg.tabId : arg;
        closeTab(id || activeTabId);
      }
    });
    safeReg('tab.closeAll', {
      label: '关闭所有标签页',
      category: 'File',
      run: function() {
        closeTabs(tabs.map(function(t) { return t.id; }));
      }
    });
    safeReg('tab.closeLeft', {
      label: '关闭左侧标签页',
      category: 'File',
      run: function(arg) {
        var id = (arg && typeof arg === 'object' ? arg.tabId : arg) || activeTabId;
        var idx = tabs.findIndex(function(t) { return t.id === id; });
        if (idx > 0) closeTabs(tabs.slice(0, idx).map(function(t) { return t.id; }));
      }
    });
    safeReg('tab.closeRight', {
      label: '关闭右侧标签页',
      category: 'File',
      run: function(arg) {
        var id = (arg && typeof arg === 'object' ? arg.tabId : arg) || activeTabId;
        var idx = tabs.findIndex(function(t) { return t.id === id; });
        if (idx !== -1 && idx < tabs.length - 1) closeTabs(tabs.slice(idx + 1).map(function(t) { return t.id; }));
      }
    });
    safeReg('tabs.quickSwitch', {
      label: '快速切换标签页',
      category: 'View',
      run: function() { toggleTabSwitcher(); }
    });
  }

  // commands.js 晚于 tabs.js 加载，由 DOMContentLoaded 统一补挂
  document.addEventListener('DOMContentLoaded', initCommands);

  return {
    createTab: createTab,
    closeTab: closeTab,
    closeTabs: closeTabs,
    switchTab: switchTab,
    markDirty: markDirty,
    markClean: markClean,
    nextTab: nextTab,
    prevTab: prevTab,
    findTabByPath: findTabByPath,
    getActiveTab: getActiveTab,
    hasAnyDirty: hasAnyDirty,
    updateTabPath: updateTabPath,
    updateWindowTitle: updateWindowTitle,
    ensureActiveTabVisible: ensureActiveTabVisible,
    initCommands: initCommands,
    openSwitcher: openTabSwitcher,
    closeSwitcher: closeTabSwitcher,
    toggleSwitcher: toggleTabSwitcher,
    getTabs: function() { return tabs.slice(); },
    getState: function() { return { tabs: tabs.slice(), activeTabId: activeTabId }; }
  };
})();
