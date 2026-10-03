// 文档导出（Pandoc）前端模块（FEAT-006）—— window.ExportUI
// 架构角色（提案 docs/proposals/2026-10-04-文档导出Pandoc扩展提案.md）：
// 1. 顶栏导出图标按钮（#btn-export）→ 下拉菜单（复用 .ctx-menu 全局样式）：
//    - 五个格式项（Word / EPUB / HTML / PDF / ODT，二级按类型分项）+ 导出设置…；
//    - 顶部状态行：pandoc 版本与命中来源；未检测到时给安装指引（设置 · 导出）；
//    - PDF 项由 PDF 引擎检测驱动（无引擎禁用 + 原因 tooltip）；
// 2. 导出流程：格式项 → Rust 侧弹另存为对话框 → 后台线程执行导出（编辑器内存
//    buffer 经 stdin，未保存改动可导）→ workspace:pandoc-export-result 回执 →
//    toast 结果；成功后菜单状态区保留「打开所在文件夹」动作（pandoc.reveal）；
// 3. 检测懒触发：首次打开菜单时发 pandoc.detect，回执缓存至本会话；菜单内
//    「重新检测」可手动刷新——装完 pandoc 免重启立即可用（提案 D5）；
// 4. 命令注册：export.menu + 每格式一条（命令面板可见、可改键）；
//    默认键 Ctrl+Shift+E 呼出菜单（default-keybindings.js）。
// 模块以 IIFE 组织并挂载 window.ExportUI 供 Node/e2e 测试调用。

(function(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ExportUI = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function() {
  'use strict';

  var state = {
    btn: null,
    menuEl: null,
    isOpen: false,
    seq: 0,
    detect: null,           // 最近一次检测回执 { found, version, path, source, pdfEngine }
    detectRequested: false, // 本会话已发过检测（懒触发去重）
    detecting: false,
    exportingFormat: null,  // 正在导出的格式（回执前菜单项禁用）
    exportingRequestId: null,
    lastExport: null        // 成功产物 { path }（状态区「打开所在文件夹」用）
  };

  var FORMATS = [
    { format: 'docx', labelKey: 'export.format.docx' },
    { format: 'epub', labelKey: 'export.format.epub' },
    { format: 'html', labelKey: 'export.format.html' },
    { format: 'pdf', labelKey: 'export.format.pdf' },
    { format: 'odt', labelKey: 'export.format.odt' }
  ];

  function t(k, params) {
    return window.I18n && typeof window.I18n.t === 'function' ? window.I18n.t(k, params) : k;
  }

  function sendToRust(command, data) {
    if (window.ipc && typeof window.ipc.postMessage === 'function') {
      window.ipc.postMessage(JSON.stringify(Object.assign({ command: command }, data || {})));
    }
  }

  function toast(text, opts) {
    if (window.AppToast && typeof window.AppToast.show === 'function') {
      window.AppToast.show(text, opts);
    }
  }

  // ── 导出目标：活动标签的内存 buffer（与保存流同源：#editor.value 优先）──
  function getExportTarget() {
    var tm = (typeof window !== 'undefined') ? window.TabManager : null;
    var tab = tm && typeof tm.getActiveTab === 'function' ? tm.getActiveTab() : null;
    if (!tab || tab.isImage) return null;
    var editor = (typeof document !== 'undefined') ? document.getElementById('editor') : null;
    var content = editor && typeof editor.value === 'string' ? editor.value : (tab.content || '');
    return { content: content, path: tab.path || null, filename: tab.filename || '' };
  }

  function suggestName(target, format) {
    var base = (target && target.filename ? target.filename : 'untitled')
      .replace(/\.(md|markdown|txt)$/i, '');
    return base + '.' + format;
  }

  // 源文件目录：--resource-path 用（相对图片按此解析）；未保存新文件回退工作区根
  function sourceDir(target) {
    if (target && target.path) {
      var normalized = String(target.path).replace(/\\/g, '/');
      var idx = normalized.lastIndexOf('/');
      if (idx > 0) return normalized.slice(0, idx);
      return '';
    }
    var ws = (typeof window !== 'undefined') ? window.Workspace : null;
    if (ws && typeof ws.getState === 'function') {
      var s = ws.getState();
      return (s && s.root) || '';
    }
    return '';
  }

  // ── 检测 ──
  function requestDetect() {
    state.detectRequested = true;
    state.detecting = true;
    var requestId = 'detect-' + (++state.seq);
    sendToRust('pandoc.detect', { requestId: requestId });
  }

  function onDetectResult(data) {
    if (!data || typeof data.requestId !== 'string') return;
    // 接收自身请求（detect-N）与设置页请求（settings-detect）：任一来源的
    // 最新检测结果都刷新本模块缓存，避免"设置页已配好、菜单仍禁用"的漂移
    if (data.requestId.indexOf('detect-') !== 0 && data.requestId !== 'settings-detect') return;
    state.detecting = false;
    state.detect = data;
    if (state.isOpen) renderMenuContent();
  }

  function detectLabel() {
    var d = state.detect;
    if (state.detecting) return t('export.status.checking');
    if (!d) return '';
    if (d.found) {
      var source = t('export.source.' + (d.source || 'path'));
      return 'pandoc ' + (d.version || '') + ' · ' + source;
    }
    return t('export.status.missing');
  }

  // ── 菜单 ──
  function ensureMenu() {
    if (state.menuEl && state.menuEl.parentNode) return state.menuEl;
    if (typeof document === 'undefined') return null;
    var menu = document.createElement('div');
    menu.id = 'export-menu';
    menu.className = 'ctx-menu export-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    menu.addEventListener('click', onMenuClick);
    document.body.appendChild(menu);
    state.menuEl = menu;
    return menu;
  }

  function positionMenu() {
    var menu = ensureMenu();
    var btn = state.btn || (typeof document !== 'undefined' ? document.getElementById('btn-export') : null);
    if (!menu || !btn) return;
    var rect = btn.getBoundingClientRect ? btn.getBoundingClientRect() : { left: 0, bottom: 0, right: 0 };
    var width = menu.offsetWidth || 260;
    var vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
    var px = rect.left;
    var py = (rect.bottom || 0) + 8;
    if (px + width > vw) px = Math.max(0, (rect.right || px) - width);
    menu.style.left = px + 'px';
    menu.style.top = py + 'px';
  }

  function itemDisabledReason(format) {
    if (!getExportTarget()) return t('export.noDocument');
    var d = state.detect;
    if (state.detecting || !d) return t('export.status.checking');
    if (!d.found) return t('export.status.missing');
    if (format === 'pdf' && !d.pdfEngine) return t('export.pdfNoEngine');
    return '';
  }

  function renderMenuContent() {
    var menu = ensureMenu();
    if (!menu) return;
    var html = '';

    // 状态行：版本与来源 / 未检测到 → 安装指引 + 重新检测；检测中显示进行时
    // （missing 态也提供重新检测：装完 pandoc 免重启就地刷新，提案 D5）
    html += '<div class="export-menu-status">'
      + '<span class="export-menu-status-text">' + escapeHtml(detectLabel()) + '</span>';
    if (state.detect && state.detect.found) {
      html += '<button type="button" class="export-menu-link" data-export-action="redetect">' + escapeHtml(t('export.redetect')) + '</button>';
    } else if (!state.detecting) {
      html += '<button type="button" class="export-menu-link" data-export-action="guide">' + escapeHtml(t('export.guide')) + '</button>'
        + '<button type="button" class="export-menu-link" data-export-action="redetect">' + escapeHtml(t('export.redetect')) + '</button>';
    }
    html += '</div>';

    // 格式项（二级按类型分项，提案 D3）
    FORMATS.forEach(function(item) {
      var reason = itemDisabledReason(item.format);
      var exporting = state.exportingFormat === item.format;
      var disabled = Boolean(reason) || exporting;
      var pdfBadge = '';
      if (item.format === 'pdf' && state.detect && state.detect.found && state.detect.pdfEngine) {
        pdfBadge = ' (' + state.detect.pdfEngine + ')';
      }
      html += '<div class="ctx-item' + (disabled ? ' disabled' : '') + '" role="menuitem"'
        + ' data-export-format="' + item.format + '"'
        + (disabled ? ' title="' + escapeHtml(exporting ? t('export.exporting') : reason) + '"' : '')
        + ' aria-disabled="' + (disabled ? 'true' : 'false') + '">'
        + '<span class="help-menu-label">' + escapeHtml(t(item.labelKey)) + escapeHtml(pdfBadge) + '</span>'
        + '<span class="kbd">.' + item.format + '</span>'
        + '</div>';
    });

    html += '<div class="ctx-sep"></div>';
    html += '<div class="ctx-item" role="menuitem" data-export-action="settings">'
      + '<span class="help-menu-label">' + escapeHtml(t('export.menu.settings')) + '</span>'
      + '</div>';

    if (state.lastExport) {
      var name = String(state.lastExport.path || '').split(/[/\\]/).pop();
      html += '<div class="export-menu-lastexport">'
        + '<span class="export-menu-lastexport-path" title="' + escapeHtml(state.lastExport.path || '') + '">'
        + escapeHtml(t('export.lastExport')) + escapeHtml(name)
        + '</span>'
        + '<button type="button" class="export-menu-link" data-export-action="reveal">' + escapeHtml(t('export.openFolder')) + '</button>'
        + '</div>';
    }

    menu.innerHTML = html;
    positionMenu();
  }

  function onMenuClick(e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var actionEl = target.closest('[data-export-action]');
    if (actionEl) {
      e.preventDefault();
      e.stopPropagation();
      handleAction(actionEl.getAttribute('data-export-action'));
      return;
    }
    var itemEl = target.closest('[data-export-format]');
    if (itemEl && !itemEl.classList.contains('disabled')) {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      startExport(itemEl.getAttribute('data-export-format'));
    }
  }

  function handleAction(action) {
    if (action === 'redetect') {
      state.detecting = true;
      if (state.isOpen) renderMenuContent();
      requestDetect();
      return;
    }
    if (action === 'guide' || action === 'settings') {
      closeMenu();
      openExportSettings();
      return;
    }
    if (action === 'reveal') {
      if (state.lastExport && state.lastExport.path) {
        sendToRust('pandoc.reveal', { path: state.lastExport.path });
      }
      closeMenu();
    }
  }

  function openExportSettings() {
    if (window.SettingsUI && typeof window.SettingsUI.open === 'function') {
      window.SettingsUI.open();
      if (typeof window.SettingsUI.setCategory === 'function') {
        window.SettingsUI.setCategory('pandoc');
      }
      if (window.SettingsUI.refresh && typeof window.SettingsUI.refresh === 'function') {
        window.SettingsUI.refresh();
      }
    }
  }

  function openMenu() {
    var menu = ensureMenu();
    if (!menu) return;
    if (!state.detect && !state.detectRequested) requestDetect();
    state.isOpen = true;
    menu.hidden = false;
    renderMenuContent();
  }

  function closeMenu() {
    if (!state.isOpen) return;
    state.isOpen = false;
    if (state.menuEl) state.menuEl.hidden = true;
  }

  function toggleMenu() {
    if (state.isOpen) closeMenu();
    else openMenu();
  }

  function onGlobalClick(e) {
    if (!state.isOpen) return;
    var target = e.target;
    if (state.menuEl && target && state.menuEl.contains(target)) return;
    if (state.btn && target && state.btn.contains(target)) return;
    closeMenu();
  }

  function onGlobalKeyDown(e) {
    if (!state.isOpen) return;
    if (e && (e.key === 'Escape' || e.key === 'Esc')) {
      e.stopPropagation();
      closeMenu();
    }
  }

  // ── 导出流程 ──
  function startExport(format) {
    var target = getExportTarget();
    if (!target) {
      toast(t('export.noDocument'));
      return;
    }
    if (state.exportingFormat) {
      toast(t('export.exporting'), { sticky: true });
      return;
    }
    var requestId = 'export-' + (++state.seq);
    state.exportingFormat = format;
    state.exportingRequestId = requestId;
    toast(t('export.exporting'), { sticky: true });
    sendToRust('pandoc.export', {
      requestId: requestId,
      format: format,
      markdown: target.content,
      sourceDir: sourceDir(target),
      suggestName: suggestName(target, format)
    });
  }

  function onExportResult(data) {
    if (!data || typeof data.requestId !== 'string' || data.requestId !== state.exportingRequestId) return;
    state.exportingFormat = null;
    state.exportingRequestId = null;
    if (window.AppToast && typeof window.AppToast.hide === 'function') window.AppToast.hide();
    // 另存为对话框取消：静默复位，不弹错误
    if (data.cancelled) return;
    if (data.ok) {
      state.lastExport = { path: data.outPath || '' };
      toast(t('export.success', { path: data.outPath || '' }));
    } else {
      toast((data.message || t('export.failed')), { sticky: true });
    }
    if (state.isOpen) renderMenuContent();
  }

  // ── 命令注册 ──
  function registerCommands() {
    if (!window.Commands || typeof window.Commands.register !== 'function') return;
    try {
      window.Commands.register('export.menu', {
        label: t('command.export.menu'),
        category: 'Export',
        description: t('commandDesc.export.menu'),
        run: toggleMenu
      });
      FORMATS.forEach(function(item) {
        window.Commands.register('export.' + item.format, {
          label: t('command.export.' + item.format),
          category: 'Export',
          description: t('commandDesc.export.' + item.format),
          run: function() { startExport(item.format); }
        });
      });
    } catch (e) { /* 重复注册等异常不阻断装载 */ }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function init() {
    if (typeof document === 'undefined') return;
    var btn = document.getElementById('btn-export');
    if (btn && !state.btn) {
      state.btn = btn;
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        toggleMenu();
      });
    }
    document.addEventListener('click', onGlobalClick, true);
    document.addEventListener('keydown', onGlobalKeyDown, true);
    if (window.Workspace && typeof window.Workspace.on === 'function') {
      window.Workspace.on('workspace:pandoc-detect-result', onDetectResult);
      window.Workspace.on('workspace:pandoc-export-result', onExportResult);
    }
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('i18n-changed', function() {
        var b = document.getElementById('btn-export');
        if (b) {
          b.setAttribute('title', t('toolbar.export'));
          b.setAttribute('aria-label', t('toolbar.export'));
        }
        if (state.isOpen) renderMenuContent();
      });
    }
    registerCommands();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  return {
    init: init,
    openMenu: openMenu,
    closeMenu: closeMenu,
    toggleMenu: toggleMenu,
    startExport: startExport,
    requestDetect: requestDetect,
    onDetectResult: onDetectResult,
    onExportResult: onExportResult,
    getExportTarget: getExportTarget,
    itemDisabledReason: itemDisabledReason,
    detectLabel: detectLabel,
    getState: function() { return Object.assign({}, state); }
  };
});
