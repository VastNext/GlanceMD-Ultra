// 工作区三栏骨架：面板折叠 / 拖宽 / 持久化 —— window.LayoutUI
// 阶段 1，布局与视觉对照 docs/design/01-project-tree.html（样式见 style.css
// 的 WORKSPACE LAYOUT section）；DOM 契约：#panel-tree / #panel-outline /
// .panel-resizer，持久化键 glancemd-ultra-layout-*（阶段 0 身份前缀约定）。
// 面板内容本身由后续模块挂载（#project-tree-root ← project-tree.js）。
(function() {
  'use strict';

  var PANELS = ['tree', 'outline'];

  /* ── 布局规格（与 style.css WORKSPACE LAYOUT section 保持一致）── */
  var DEFAULT_WIDTH = 240;
  var MIN_WIDTH = 200;
  var MAX_WIDTH = 400;
  // 与 style.css 的窄视口媒体查询同一条件：≤1024px 时 Outline 自动折叠
  var NARROW_QUERY = '(max-width: 1024px)';

  /* ── 持久化键（glancemd-ultra- 前缀）── */
  var KEYS = {
    tree: {
      width: 'glancemd-ultra-layout-tree-width',
      collapsed: 'glancemd-ultra-layout-tree-collapsed',
    },
    outline: {
      width: 'glancemd-ultra-layout-outline-width',
      collapsed: 'glancemd-ultra-layout-outline-collapsed',
    },
  };

  var els = {
    tree: null,
    outline: null,
    treeResizer: null,
    outlineResizer: null,
    content: null,
  };

  var widths = { tree: DEFAULT_WIDTH, outline: DEFAULT_WIDTH };
  var collapsed = { tree: false, outline: false };
  // 窄视口下的自动折叠标记：持久化只记用户手动操作，宽视口仅恢复"自动"折叠
  var autoCollapsed = { tree: false, outline: false };
  var dragPanel = null;
  var media = null;

  /* ── localStorage 包装：file:// / 隐私模式下可能抛错，与既有模块一致吞掉 ── */
  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) {}
  }
  function storageRemove(key) {
    try { window.localStorage.removeItem(key); } catch (e) {}
  }

  function clampWidth(w) {
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));
  }

  function parseWidth(raw) {
    var w = parseInt(raw, 10);
    if (isNaN(w)) return DEFAULT_WIDTH;
    return clampWidth(w);
  }

  function resizerFor(panel) {
    return panel === 'tree' ? els.treeResizer : els.outlineResizer;
  }

  function applyWidth(panel) {
    if (els[panel]) els[panel].style.width = Math.round(widths[panel]) + 'px';
  }

  function applyCollapsed(panel) {
    if (els[panel]) els[panel].classList.toggle('collapsed', collapsed[panel]);
    // 折叠后手柄失去意义，同步隐藏；展开恢复由 CSS（媒体查询）兜底窄视口
    var resizer = resizerFor(panel);
    if (resizer) resizer.style.display = collapsed[panel] ? 'none' : '';
  }

  /* persist=false 用于窄视口自动折叠：不写持久化，宽视口可精确还原 */
  function setPanelCollapsed(panel, value, persist) {
    if (collapsed[panel] === value) return;
    collapsed[panel] = value;
    applyCollapsed(panel);
    if (persist) storageSet(KEYS[panel].collapsed, value ? '1' : '0');
  }

  function isCollapsed(panel) {
    return collapsed[panel];
  }

  function toggle(panel) {
    setPanelCollapsed(panel, !collapsed[panel], true);
  }

  function collapse(panel) {
    setPanelCollapsed(panel, true, true);
  }

  function expand(panel) {
    // 用户显式展开：撤销窄视口自动折叠标记，切回宽视口时不反向折叠
    autoCollapsed[panel] = false;
    setPanelCollapsed(panel, false, true);
  }

  function restore() {
    PANELS.forEach(function(panel) {
      widths[panel] = parseWidth(storageGet(KEYS[panel].width));
      collapsed[panel] = storageGet(KEYS[panel].collapsed) === '1';
      applyWidth(panel);
      applyCollapsed(panel);
    });
  }

  function reset() {
    PANELS.forEach(function(panel) {
      storageRemove(KEYS[panel].width);
      storageRemove(KEYS[panel].collapsed);
      widths[panel] = DEFAULT_WIDTH;
      collapsed[panel] = false;
      applyWidth(panel);
      applyCollapsed(panel);
    });
    autoCollapsed.tree = false;
    autoCollapsed.outline = false;
  }

  /* ── 拖宽：pointer 事件 + 边界钳制（200–400px），pointerup 持久化 ── */
  function onResizerPointerDown(panel) {
    return function(e) {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.preventDefault) e.preventDefault();
      dragPanel = panel;
      document.body.classList.add('panel-resizing');
      var resizer = resizerFor(panel);
      if (resizer) resizer.classList.add('dragging');
    };
  }

  function onDocumentPointerMove(e) {
    if (!dragPanel) return;
    var rect = els.content
      ? els.content.getBoundingClientRect()
      : { left: 0, right: 0 };
    // tree 手柄在面板右侧：向右拖增宽；outline 手柄在面板左侧：向左拖增宽
    var raw = dragPanel === 'tree'
      ? e.clientX - rect.left
      : rect.right - e.clientX;
    widths[dragPanel] = clampWidth(raw);
    applyWidth(dragPanel);
  }

  function onDocumentPointerUp() {
    if (!dragPanel) return;
    var panel = dragPanel;
    dragPanel = null;
    document.body.classList.remove('panel-resizing');
    var resizer = resizerFor(panel);
    if (resizer) resizer.classList.remove('dragging');
    storageSet(KEYS[panel].width, String(Math.round(widths[panel])));
  }

  /* ── 窄视口（≤1024px）：Outline 自动折叠；切回宽视口恢复（设计稿 01 窄屏变体）── */
  function applyNarrowMode() {
    if (!media) return;
    if (media.matches) {
      if (!collapsed.outline) {
        autoCollapsed.outline = true;
        setPanelCollapsed('outline', true, false);
      }
    } else if (autoCollapsed.outline) {
      autoCollapsed.outline = false;
      setPanelCollapsed('outline', false, false);
    }
  }

  function setupNarrowWatcher() {
    if (typeof window.matchMedia !== 'function') return;
    try { media = window.matchMedia(NARROW_QUERY); } catch (e) { return; }
    if (!media) return;
    var handler = function() { applyNarrowMode(); };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', handler);
    } else if (typeof media.addListener === 'function') {
      media.addListener(handler);
    }
    applyNarrowMode();
  }

  function bindPanel(panel) {
    var collapseBtn = document.getElementById('panel-' + panel + '-collapse');
    var expandBtn = document.getElementById('panel-' + panel + '-expand');
    var resizer = resizerFor(panel);
    if (collapseBtn) collapseBtn.addEventListener('click', function() { collapse(panel); });
    if (expandBtn) expandBtn.addEventListener('click', function() { expand(panel); });
    if (resizer) resizer.addEventListener('pointerdown', onResizerPointerDown(panel));
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
    setupNarrowWatcher();
  }

  window.LayoutUI = {
    collapse: collapse,
    expand: expand,
    toggle: toggle,
    isCollapsed: isCollapsed,
    restore: restore,
    reset: reset,
  };

  init();
})();
