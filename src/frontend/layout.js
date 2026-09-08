// 工作区三栏骨架：项目树与 Outline 折叠/拖宽/左右侧停靠与持久化 —— window.LayoutUI
(function() {
  'use strict';

  var PANELS = ['tree', 'outline'];
  var DEFAULTS = { tree: 264, outline: 264 };
  var MIN_WIDTH = { tree: 180, outline: 180 };
  var EDITOR_MIN = 80;
  var KEYS = {
    tree: { width: 'glancemd-ultra-layout-tree-width', collapsed: 'glancemd-ultra-layout-tree-collapsed' },
    outline: { width: 'glancemd-ultra-layout-outline-width' }
  };
  var KEY_OUTLINE_OPEN = 'glancemd-ultra-outline-open';
  var els = { tree: null, outline: null, treeResizer: null, outlineResizer: null, content: null };
  var widths = { tree: DEFAULTS.tree, outline: DEFAULTS.outline };
  var preferredWidths = { tree: DEFAULTS.tree, outline: DEFAULTS.outline };
  var collapsed = { tree: false };
  var autoCollapsed = { tree: false };
  var outlineOpen = false;
  var dragPanel = null;
  var outlineSide = 'right';

  function storageGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) { try { window.localStorage.setItem(key, value); } catch (e) {} }
  function storageRemove(key) { try { window.localStorage.removeItem(key); } catch (e) {} }

  function contentWidth() {
    if (!els.content || !els.content.getBoundingClientRect) return Infinity;
    var r = els.content.getBoundingClientRect();
    return Number(r.width) || Math.max(0, (r.right || 0) - (r.left || 0));
  }

  function clampWidth(panel, w) {
    var n = parseInt(w, 10);
    if (isNaN(n)) n = DEFAULTS[panel] || 264;
    var min = MIN_WIDTH[panel] || 180;
    var available = contentWidth();
    var other = 0;
    if (panel === 'tree') {
      other = outlineOpen ? widths.outline : 0;
    } else if (panel === 'outline') {
      other = collapsed.tree ? 36 : widths.tree;
    }
    var roomMax = isFinite(available) ? available - other - EDITOR_MIN : Infinity;
    if (roomMax < min) return min;
    return Math.min(roomMax, Math.max(min, n));
  }

  function resizerFor(panel) {
    return panel === 'tree' ? els.treeResizer : (panel === 'outline' ? els.outlineResizer : null);
  }

  function applyWidth(panel) {
    if (panel === 'tree' && els.tree) {
      els.tree.style.width = Math.round(widths.tree) + 'px';
    } else if (panel === 'outline' && els.outline) {
      els.outline.style.width = Math.round(widths.outline) + 'px';
    }
  }

  function applyCollapsed(panel) {
    if (panel === 'tree' && els.tree) {
      els.tree.classList.toggle('collapsed', collapsed.tree);
      if (els.treeResizer) els.treeResizer.style.display = collapsed.tree ? 'none' : '';
    } else if (panel === 'outline') {
      applyOutlineOpen();
    }
  }

  function applyOutlineOpen() {
    if (els.outline) {
      els.outline.classList.toggle('open', outlineOpen);
    }
    if (els.outlineResizer) {
      els.outlineResizer.style.display = outlineOpen ? '' : 'none';
    }
    var btnToc = document.getElementById('btn-toc');
    if (btnToc) {
      btnToc.classList.toggle('active', outlineOpen);
    }
  }

  function setOutlineOpen(open, persist) {
    outlineOpen = Boolean(open);
    applyOutlineOpen();
    if (persist !== false) {
      storageSet(KEY_OUTLINE_OPEN, outlineOpen ? '1' : '0');
    }
    constrainLayout();
  }

  function setPanelCollapsed(panel, value, persist) {
    if (panel === 'outline') {
      setOutlineOpen(!value, persist);
      return;
    }
    if (collapsed.tree === value) return;
    collapsed.tree = value;
    applyCollapsed('tree');
    if (persist) storageSet(KEYS.tree.collapsed, value ? '1' : '0');
    constrainLayout();
  }

  function isCollapsed(panel) {
    if (panel === 'outline') return !outlineOpen;
    return Boolean(collapsed[panel]);
  }

  function toggle(panel) {
    if (panel === 'outline') {
      setOutlineOpen(!outlineOpen, true);
      return;
    }
    setPanelCollapsed('tree', !collapsed.tree, true);
  }

  function collapse(panel) {
    if (panel === 'outline') {
      setOutlineOpen(false, true);
      return;
    }
    setPanelCollapsed('tree', true, true);
  }

  function expand(panel) {
    if (panel === 'outline') {
      setOutlineOpen(true, true);
      return;
    }
    autoCollapsed.tree = false;
    setPanelCollapsed('tree', false, true);
    constrainLayout();
  }

  function constrainLayout() {
    var available = contentWidth();
    // 窗口最小化、不可见或异常 0 尺寸时，坚决跳过重排，防止污染侧栏展开状态与尺寸
    if (!isFinite(available) || available <= 0) {
      return;
    }
    if (typeof document !== 'undefined' && (document.hidden || (document.visibilityState && document.visibilityState === 'hidden'))) {
      return;
    }

    // Preserve minimal editor width using preferredWidths as upper target
    var targetTreeW = clampWidth('tree', preferredWidths.tree || widths.tree);
    var targetOutlineW = outlineOpen ? clampWidth('outline', preferredWidths.outline || widths.outline) : 0;
    var treeW = collapsed.tree ? 36 : targetTreeW;
    var outlineW = outlineOpen ? targetOutlineW : 0;
    if (available - (treeW + outlineW) < EDITOR_MIN) {
      if (!collapsed.tree && available - (36 + outlineW) >= EDITOR_MIN) {
        // Can shrink tree temporarily
        widths.tree = clampWidth('tree', preferredWidths.tree || widths.tree);
        applyWidth('tree');
      } else if (!collapsed.tree) {
        autoCollapsed.tree = true;
        collapsed.tree = true;
        applyCollapsed('tree');
      }
      if (outlineOpen) {
        widths.outline = clampWidth('outline', preferredWidths.outline || widths.outline);
        applyWidth('outline');
      }
    } else {
      // 空间恢复充足时：如果此前是因为窗口缩窄触发的 autoCollapsed，自动恢复展开！
      if (autoCollapsed.tree && collapsed.tree) {
        autoCollapsed.tree = false;
        collapsed.tree = false;
        applyCollapsed('tree');
      }
      if (!collapsed.tree) {
        widths.tree = clampWidth('tree', preferredWidths.tree || widths.tree);
        applyWidth('tree');
      }
      if (outlineOpen) {
        widths.outline = clampWidth('outline', preferredWidths.outline || widths.outline);
        applyWidth('outline');
      }
    }
  }

  function parseWidth(panel, raw) { return clampWidth(panel, raw); }

  function restore() {
    preferredWidths.tree = parseWidth('tree', storageGet(KEYS.tree.width));
    preferredWidths.outline = parseWidth('outline', storageGet(KEYS.outline.width));
    widths.tree = preferredWidths.tree;
    widths.outline = preferredWidths.outline;
    collapsed.tree = storageGet(KEYS.tree.collapsed) === '1';
    applyWidth('tree');
    applyWidth('outline');
    applyCollapsed('tree');
    outlineOpen = storageGet(KEY_OUTLINE_OPEN) === '1';
    applyOutlineOpen();
    setOutlineSide(outlineSide || 'right');
    constrainLayout();
  }

  function resetPanel(panel) {
    if (panel === 'tree') {
      storageRemove(KEYS.tree.width);
      preferredWidths.tree = DEFAULTS.tree;
      widths.tree = DEFAULTS.tree;
      applyWidth('tree');
      constrainLayout();
    } else if (panel === 'outline') {
      storageRemove(KEYS.outline.width);
      preferredWidths.outline = DEFAULTS.outline;
      widths.outline = DEFAULTS.outline;
      applyWidth('outline');
      constrainLayout();
    }
  }

  function reset() {
    storageRemove(KEYS.tree.width);
    storageRemove(KEYS.tree.collapsed);
    storageRemove(KEYS.outline.width);
    storageRemove(KEY_OUTLINE_OPEN);
    preferredWidths.tree = DEFAULTS.tree;
    preferredWidths.outline = DEFAULTS.outline;
    widths.tree = DEFAULTS.tree;
    widths.outline = DEFAULTS.outline;
    collapsed.tree = false;
    autoCollapsed.tree = false;
    outlineOpen = false;
    applyWidth('tree');
    applyWidth('outline');
    applyCollapsed('tree');
    applyOutlineOpen();
    constrainLayout();
  }

  function onResizerPointerDown(panel) {
    return function(e) {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.preventDefault) e.preventDefault();
      dragPanel = panel;
      document.body.classList.add('panel-resizing');
      var r = resizerFor(panel);
      if (r) r.classList.add('dragging');
    };
  }

  function onDocumentPointerMove(e) {
    if (!dragPanel) return;
    var rect = els.content && els.content.getBoundingClientRect ? els.content.getBoundingClientRect() : { left: 0, right: 1000 };
    if (dragPanel === 'tree') {
      var treeRect = els.tree && els.tree.getBoundingClientRect ? els.tree.getBoundingClientRect() : null;
      var raw = e.clientX - (treeRect ? treeRect.left : (rect ? rect.left : 0));
      widths.tree = clampWidth('tree', raw);
      applyWidth('tree');
    } else if (dragPanel === 'outline') {
      var outlineRect = els.outline && els.outline.getBoundingClientRect ? els.outline.getBoundingClientRect() : null;
      var rawOutline;
      if (outlineSide === 'left') {
        var startX = outlineRect ? outlineRect.left : ((rect ? rect.left : 0) + (collapsed.tree ? 36 : widths.tree) + (collapsed.tree ? 0 : 5));
        rawOutline = e.clientX - startX;
      } else {
        var endX = outlineRect ? outlineRect.right : (rect ? rect.right : 1000);
        rawOutline = endX - e.clientX;
      }
      widths.outline = clampWidth('outline', rawOutline);
      applyWidth('outline');
    }
  }

  function onDocumentPointerUp() {
    if (!dragPanel) return;
    var panel = dragPanel;
    dragPanel = null;
    document.body.classList.remove('panel-resizing');
    var r = resizerFor(panel);
    if (r) r.classList.remove('dragging');
    if (panel === 'tree') {
      widths.tree = clampWidth('tree', widths.tree);
      preferredWidths.tree = widths.tree;
      applyWidth('tree');
      storageSet(KEYS.tree.width, String(Math.round(widths.tree)));
      constrainLayout();
    } else if (panel === 'outline') {
      widths.outline = clampWidth('outline', widths.outline);
      preferredWidths.outline = widths.outline;
      applyWidth('outline');
      storageSet(KEYS.outline.width, String(Math.round(widths.outline)));
      constrainLayout();
    }
  }

  function setOutlineSide(side) {
    var next = side === 'left' || side === 'right' ? side : 'right';
    var changed = outlineSide !== next;
    outlineSide = next;
    if (els.content && els.content.setAttribute) {
      els.content.setAttribute('data-outline-side', next);
    }
    if (document.documentElement && document.documentElement.setAttribute) {
      document.documentElement.setAttribute('data-outline-side', next);
    }
    if (changed) {
      constrainLayout();
    }
  }

  function bindPanel(panel) {
    var c = document.getElementById('panel-' + panel + '-collapse');
    var x = document.getElementById('panel-' + panel + '-expand');
    var r = resizerFor(panel);
    if (c) c.addEventListener('click', function() { collapse(panel); });
    if (x) x.addEventListener('click', function() { expand(panel); });
    if (r) {
      r.addEventListener('pointerdown', onResizerPointerDown(panel));
      r.addEventListener('dblclick', function() { resetPanel(panel); });
    }
  }

  function registerCommands() {
    if (!window.Commands || typeof window.Commands.register !== 'function') return;
    var reg = window.Commands.register;
    if (!window.Commands.has('layout.tree.toggle')) {
      reg('layout.tree.toggle', {
        label: '切换项目树',
        category: 'View',
        run: function() { toggle('tree'); }
      });
    }
    if (!window.Commands.has('layout.tree.collapse')) {
      reg('layout.tree.collapse', {
        label: '折叠项目树',
        category: 'View',
        run: function() { collapse('tree'); }
      });
    }
    if (!window.Commands.has('layout.tree.expand')) {
      reg('layout.tree.expand', {
        label: '展开项目树',
        category: 'View',
        run: function() { expand('tree'); }
      });
    }
    if (!window.Commands.has('layout.tree.resetWidth')) {
      reg('layout.tree.resetWidth', {
        label: '重置项目树宽度',
        category: 'View',
        run: function() { resetPanel('tree'); }
      });
    }
  }

  function init() {
    els.tree = document.getElementById('panel-tree');
    els.outline = document.getElementById('panel-outline');
    els.treeResizer = document.getElementById('panel-tree-resizer');
    els.outlineResizer = document.getElementById('panel-outline-resizer');
    els.content = document.getElementById('content');
    if (!els.tree || !els.outline) return;
    bindPanel('tree');
    bindPanel('outline');
    document.addEventListener('pointermove', onDocumentPointerMove);
    document.addEventListener('pointerup', onDocumentPointerUp);
    document.addEventListener('pointercancel', onDocumentPointerUp);
    restore();
    if (window.addEventListener) window.addEventListener('resize', constrainLayout);
    registerCommands();
  }

  window.LayoutUI = {
    collapse: collapse,
    expand: expand,
    toggle: toggle,
    isCollapsed: isCollapsed,
    restore: restore,
    reset: reset,
    resetWidth: resetPanel,
    resetPanel: resetPanel,
    resize: constrainLayout,
    setOutlineSide: setOutlineSide,
    registerCommands: registerCommands
  };
  init();
})();
