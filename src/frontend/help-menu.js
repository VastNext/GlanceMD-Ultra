/* help-menu.js — 顶栏「更多」下拉菜单（window.HelpMenu）
 * 契约与规范：
 * 1. 参考 VS Code / Chrome 的标题栏 ⋯ 菜单：聚合顶栏没有直接入口的全局功能
 *    （命令面板 / 快速打开 / 全文搜索 / 快捷键速查）与「关于」对话框入口；
 * 2. 菜单项只引用命令 ID（Commands.run），不内联行为；标签经 Commands.get()
 *    动态解析（i18n.js 的 command.* 集中翻译表），快捷键提示从
 *    Keybindings.effective() 动态取，语言/键位变更时自动刷新；
 * 3. 视觉复用 project-tree.css 的 .ctx-menu/.ctx-item/.ctx-sep/.kbd（全局注入），
 *    锚定 #btn-more 按钮下缘、左对齐，越界时夹紧 viewport；
 * 4. 打开后焦点进菜单，↑/↓ 在项间移动、Enter 触发、Esc 关闭并焦点还原按钮；
 *    document 级 click/contextmenu/Esc 以开合状态门控（同 tabs.js 菜单模式）；
 * 5. 零依赖，暗色/亮色双主题随既有 token 自适配。
 */

(function (root) {
  'use strict';

  function t(key, fallback) {
    if (root.I18n && typeof root.I18n.t === 'function') {
      var v = root.I18n.t(key);
      if (typeof v === 'string' && v && v !== key) return v;
    }
    return fallback || key;
  }

  /* 菜单定义：labelKey 走 help.menu.* 词条（比 command.* 更口语化），fallback 用命令默认标签 */
  var MENU_DEFS = [
    { commandId: 'palette.toggle', labelKey: 'help.menu.palette' },
    { commandId: 'resource.open', labelKey: 'help.menu.quickOpen' },
    { commandId: 'search.toggle', labelKey: 'help.menu.search' },
    { sep: true },
    { commandId: 'settings.toggle', labelKey: 'help.menu.settings' },
    { commandId: 'keyassist.toggle', labelKey: 'help.menu.keyassist' },
    { sep: true },
    { commandId: 'help.about', labelKey: 'help.menu.about' }
  ];

  var state = {
    menuEl: null,
    open: false,
    btn: null
  };

  function commands() {
    return root.Commands;
  }

  function itemLabel(def) {
    var fallback = '';
    if (commands() && typeof commands().get === 'function') {
      var entry = commands().get(def.commandId);
      if (entry && entry.label) fallback = entry.label;
    }
    return t(def.labelKey, fallback);
  }

  function shortcutFor(commandId) {
    if (!root.Keybindings || typeof root.Keybindings.effective !== 'function') return '';
    var map = root.Keybindings.effective();
    return (map && map[commandId]) || '';
  }

  function menuItems() {
    if (!state.menuEl) return [];
    return Array.prototype.filter.call(state.menuEl.querySelectorAll('.ctx-item'), function (el) {
      return el.dataset && el.dataset.commandId;
    });
  }

  function buildMenu() {
    if (state.menuEl) {
      refreshMenu();
      return state.menuEl;
    }
    var menu = document.createElement('div');
    menu.className = 'ctx-menu help-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('help.menuAria', '应用菜单'));

    MENU_DEFS.forEach(function (def) {
      if (def.sep) {
        var sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);
        return;
      }
      var item = document.createElement('div');
      item.className = 'ctx-item';
      item.dataset.commandId = def.commandId;
      item.setAttribute('role', 'menuitem');
      item.setAttribute('tabindex', '-1');

      var label = document.createElement('span');
      label.className = 'help-menu-label';
      item.appendChild(label);

      var kbd = document.createElement('span');
      kbd.className = 'kbd';
      item.appendChild(kbd);

      item.addEventListener('click', function (e) {
        /* 不冒泡到 document 关闭逻辑（同 tabs.js / project-tree 菜单项） */
        if (e.stopPropagation) e.stopPropagation();
        runItem(def.commandId);
        closeMenu();
      });
      item.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          if (e.preventDefault) e.preventDefault();
          runItem(def.commandId);
          closeMenu();
        }
      });
      menu.appendChild(item);
    });
    state.menuEl = menu;
    refreshMenu();
    return menu;
  }

  function runItem(commandId) {
    if (!commands() || typeof commands().run !== 'function') return;
    try {
      commands().run(commandId);
    } catch (e) {
      if (root.console && root.console.error) root.console.error('[HelpMenu] 命令执行失败: ' + commandId, e);
    }
  }

  function refreshMenu() {
    if (!state.menuEl) return;
    state.menuEl.setAttribute('aria-label', t('help.menuAria', '应用菜单'));
    menuItems().forEach(function (item) {
      var id = item.dataset.commandId;
      var def = null;
      for (var i = 0; i < MENU_DEFS.length; i++) {
        if (MENU_DEFS[i].commandId === id) { def = MENU_DEFS[i]; break; }
      }
      if (!def) return;
      var label = item.querySelector('.help-menu-label');
      var kbd = item.querySelector('.kbd');
      if (label) label.textContent = itemLabel(def);
      if (kbd) {
        var seq = shortcutFor(id);
        kbd.textContent = seq;
        kbd.style.display = seq ? '' : 'none';
      }
    });
  }

  function openMenu() {
    closeMenu(); /* 重复点击时翻转语义由 toggle 处理，这里防叠加 */
    var btn = state.btn;
    if (!btn) return;
    var menu = buildMenu();
    refreshMenu();
    document.body.appendChild(menu);

    /* 先挂载测量再定位：按钮下缘 + 8px，左对齐按钮左缘，越界夹紧 viewport（同 tabs.js） */
    var rect = btn.getBoundingClientRect ? btn.getBoundingClientRect() : { left: 0, bottom: 0 };
    var vw = root.innerWidth || 1024;
    var vh = root.innerHeight || 768;
    var mRect = menu.getBoundingClientRect ? menu.getBoundingClientRect() : { width: 212, height: 200 };
    var px = rect.left;
    var py = (rect.bottom || 0) + 8;
    var width = mRect.width || 212;
    var height = mRect.height || 200;
    if (px + width > vw) px = Math.max(0, (rect.right || px) - width);
    if (py + height > vh) py = Math.max(0, (rect.top || py) - height - 8);
    px = Math.max(0, Math.min(px, Math.max(0, vw - width)));
    py = Math.max(0, Math.min(py, Math.max(0, vh - height)));
    menu.style.left = px + 'px';
    menu.style.top = py + 'px';

    state.open = true;
    btn.setAttribute('aria-expanded', 'true');

    /* 焦点进菜单首项，↑/↓ 可移动 */
    var items = menuItems();
    if (items.length && typeof items[0].focus === 'function') {
      try { items[0].focus(); } catch (e) {}
    }
  }

  function closeMenu() {
    if (!state.open && !state.menuEl) return;
    state.open = false;
    if (state.menuEl && state.menuEl.parentNode) {
      state.menuEl.parentNode.removeChild(state.menuEl);
    }
    if (state.btn) state.btn.setAttribute('aria-expanded', 'false');
  }

  function isOpen() {
    return state.open;
  }

  function init() {
    var btn = document.getElementById('btn-more');
    if (!btn) return;
    state.btn = btn;
    btn.addEventListener('click', function (e) {
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      if (state.open) { closeMenu(); } else { openMenu(); }
    });
    btn.addEventListener('keydown', function (e) {
      if (state.open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        if (e.preventDefault) e.preventDefault();
        var items = menuItems();
        var target = e.key === 'ArrowDown' ? items[0] : items[items.length - 1];
        if (target && typeof target.focus === 'function') {
          try { target.focus(); } catch (err) {}
        }
      }
    });

    /* 菜单开着期间：菜单外点击 / 右键 / Esc 均关闭（document 级，开合状态门控） */
    document.addEventListener('click', function (e) {
      if (!state.open) return;
      if (e.target && state.menuEl && state.menuEl.contains && state.menuEl.contains(e.target)) return;
      if (e.target === btn || (btn.contains && btn.contains(e.target))) return; /* 按钮自身点击走 toggle */
      closeMenu();
    });
    document.addEventListener('contextmenu', function (e) {
      if (!state.open) return;
      if (e.target && state.menuEl && state.menuEl.contains && state.menuEl.contains(e.target)) return;
      closeMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (!state.open) return;
      if (e.key === 'Escape') {
        if (e.preventDefault) e.preventDefault();
        closeMenu();
        if (typeof btn.focus === 'function') { try { btn.focus(); } catch (err) {} }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        var items = menuItems();
        if (!items.length) return;
        var idx = items.indexOf(document.activeElement);
        var next;
        if (idx === -1) {
          next = items[0];
        } else {
          var step = e.key === 'ArrowDown' ? 1 : -1;
          next = items[(idx + step + items.length) % items.length];
        }
        if (e.preventDefault) e.preventDefault();
        if (next && typeof next.focus === 'function') { try { next.focus(); } catch (err) {} }
      }
    });

    /* 语言 / 键位方案变更时刷新标签与快捷键提示 */
    root.addEventListener('i18n-changed', refreshMenu);
    root.addEventListener('keybindings-changed', refreshMenu);
    root.addEventListener('scheme-changed', refreshMenu);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  root.HelpMenu = {
    open: function () { if (!state.open) openMenu(); },
    close: closeMenu,
    toggle: function () { if (state.open) { closeMenu(); } else { openMenu(); } },
    isOpen: isOpen,
    refresh: refreshMenu
  };

})(typeof window !== 'undefined' ? window : globalThis);
