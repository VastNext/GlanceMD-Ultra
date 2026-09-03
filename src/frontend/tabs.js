var TabManager = (function() {
  var tabs = [];
  var activeTabId = null;
  var tabIdCounter = 0;

  /* ── 拖拽重排状态 ──
     activeDrag 持有当前拖拽上下文；dragJustEnded 用于抑制拖拽结束后的 click 误触发 */
  var activeDrag = null;
  var dragJustEnded = false;
  var DRAG_THRESHOLD = 5; /* 位移超过该像素数才视为拖拽，否则仍是普通点击 */

  function normalizePath(p) {
    return p.replace(/\\/g, '/');
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
      filename: forceFilename || (path ? path.split(/[/\\]/).pop() : 'Untitled'),
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

  function closeTab(id) {
    var idx = tabs.findIndex(function(t) { return t.id === id; });
    if (idx === -1) return;
    var tab = tabs[idx];
    if (tab.dirty) {
      if (!confirm('Unsaved changes in "' + tab.filename + '". Close anyway?')) return;
    }
    tabs.splice(idx, 1);
    syncDirtyState();
    if (tabs.length === 0) {
      createTab(null, '');
      return;
    }
    if (activeTabId === id) {
      var newIdx = Math.min(idx, tabs.length - 1);
      switchTab(tabs[newIdx].id);
    } else {
      renderTabBar();
    }
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
      tab.scrollTop = document.getElementById('preview-container').scrollTop;
    }
  }

  function restoreTabState(tab) {
    var editor = document.getElementById('editor');
    editor.value = tab.content;

    if (typeof splitMode !== 'undefined' && splitMode) {
      editor.scrollTop = tab.scrollTop;
      editor.selectionStart = tab.cursorStart;
      editor.selectionEnd = tab.cursorEnd;
      editor.focus();
      if (tab.parsedHtml) {
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
        if (tab.parsedHtml) {
          document.getElementById('preview').innerHTML = tab.parsedHtml;
        } else {
          var html = marked.parse(tab.content);
          document.getElementById('preview').innerHTML = html;
          tab.parsedHtml = html;
        }
        if (typeof resolveLocalImages === 'function') resolveLocalImages();
        setTimeout(function() {
          document.getElementById('preview-container').scrollTop = tab.scrollTop;
        }, 0);
      }
    }

    document.getElementById('status-file').textContent = tab.filename;
    if (typeof updateWordCount === 'function') updateWordCount();
    if (typeof showRecentPanel === 'function') showRecentPanel();
    if (typeof tocOpen !== 'undefined' && tocOpen && typeof updateTOC === 'function') updateTOC();
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
    if (!tab) return;
    var title = 'GlanceMD - ' + tab.filename;
    if (tab.dirty) title += ' *';
    sendToRust('set_title', { title: title });
    setTitle(tab.filename + (tab.dirty ? ' *' : ''));
  }

  function renderTabBar() {
    var bar = document.getElementById('tab-bar');
    var wrap = document.getElementById('tab-bar-wrap');
    var show = tabs.length > 1;
    wrap.style.display = show ? '' : 'none';
    document.body.classList.toggle('has-tabs', show);
    bar.innerHTML = '';
    tabs.forEach(function(tab) {
      bar.appendChild(createTabElement(tab));
    });
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
      tab.filename = path ? path.split(/[/\\]/).pop() : 'Untitled';
      renderTabBar();
      updateWindowTitle();
      document.getElementById('status-file').textContent = tab.filename;
    }
  }

  return {
    createTab: createTab,
    closeTab: closeTab,
    switchTab: switchTab,
    markDirty: markDirty,
    markClean: markClean,
    nextTab: nextTab,
    prevTab: prevTab,
    findTabByPath: findTabByPath,
    getActiveTab: getActiveTab,
    hasAnyDirty: hasAnyDirty,
    updateTabPath: updateTabPath
  };
})();
