/* help-menu.js — 顶栏「应用菜单」下拉（window.HelpMenu）
 * 契约与规范：
 * 1. ☰ 按钮位于 titlebar-actions 首位（#btn-menu），参考 Chrome/VS Code 的
 *    应用菜单形态：文件操作 / 查找导航 / 扩展 / 工具 / 关于 五组；
 * 2. 菜单项只引用命令 ID（Commands.run），不内联行为；标签经 Commands.get()
 *    动态解析（i18n.js 的 command.* 集中翻译表），快捷键提示从
 *    Keybindings.effective() 动态取，语言/键位变更时自动刷新；
 * 3. 「扩展」为二级子菜单（MENU_DEFS 中 children 项）：hover 150ms 或点击或
 *    → 键展开，子菜单锚定父项右侧、越界翻转；← / Esc / hover 离开收起；
 * 4. 视觉复用 project-tree.css 的 .ctx-menu/.ctx-item/.ctx-sep/.kbd（全局注入），
 *    子菜单与 chevron 样式见 help-menu.css；
 * 5. 打开后焦点进菜单，↑/↓ 跨主/子菜单移动、Enter 触发、Esc 关闭并焦点还原按钮；
 *    document 级 click/contextmenu/Esc 以开合状态门控（同 tabs.js 菜单模式）；
 * 6. 零依赖，暗色/亮色双主题随既有 token 自适配。
 */

(function (root) {
  'use strict';

  var SUB_OPEN_DELAY = 150; /* hover 展开二级的延迟 ms */
  var SUB_CLOSE_DELAY = 220; /* hover 离开收起二级的延迟 ms（给斜向移动留时间） */

  /* 菜单定义：labelKey 走 help.menu.* 词条（比 command.* 更口语化），
   * 带 children 的项为二级子菜单父项（不直接执行命令） */
  var MENU_DEFS = [
    { commandId: 'file.new', labelKey: 'help.menu.newFile' },
    { commandId: 'file.open', labelKey: 'help.menu.openFile' },
    { commandId: 'workspace.open', labelKey: 'help.menu.openFolder' },
    { commandId: 'file.save', labelKey: 'help.menu.save' },
    { commandId: 'file.saveAs', labelKey: 'help.menu.saveAs' },
    { commandId: 'file.saveAll', labelKey: 'help.menu.saveAll' },
    { sep: true },
    { commandId: 'resource.open', labelKey: 'help.menu.quickOpen' },
    { commandId: 'search.toggle', labelKey: 'help.menu.search' },
    { commandId: 'outline.toggle', labelKey: 'help.menu.outline' },
    { sep: true },
    {
      labelKey: 'help.menu.extensions',
      children: [
        { commandId: 'translate.popup', labelKey: 'help.menu.translate' },
        { commandId: 'export.menu', labelKey: 'help.menu.export' }
      ]
    },
    { sep: true },
    { commandId: 'palette.toggle', labelKey: 'help.menu.palette' },
    { commandId: 'keyassist.toggle', labelKey: 'help.menu.keyassist' },
    { commandId: 'settings.toggle', labelKey: 'help.menu.settings' }
  ];

  var state = {
    menuEl: null,
    subMenuEl: null,
    open: false,
    subOpenFor: null, /* 当前展开二级的父项元素 */
    subTimer: null,
    closeTimer: null,
    btn: null
  };

  function t(key, fallback) {
    if (root.I18n && typeof root.I18n.t === 'function') {
      var v = root.I18n.t(key);
      if (typeof v === 'string' && v && v !== key) return v;
    }
    return fallback || key;
  }

  function commands() {
    return root.Commands;
  }

  function itemLabel(def) {
    var fallback = '';
    if (commands() && typeof commands().get === 'function' && def.commandId) {
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

  function runCommand(commandId) {
    if (!commands() || typeof commands().run !== 'function') return;
    try {
      commands().run(commandId);
    } catch (e) {
      if (root.console && root.console.error) root.console.error('[HelpMenu] 命令执行失败: ' + commandId, e);
    }
  }

  function makeItem(def) {
    var item = document.createElement('div');
    item.className = 'ctx-item';
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '-1');

    var label = document.createElement('span');
    label.className = 'help-menu-label';
    item.appendChild(label);

    if (def.children) {
      item.classList.add('ctx-item-sub');
      item.dataset.hasSub = '1';
      var chevron = document.createElement('span');
      chevron.className = 'help-menu-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.innerHTML = '<svg viewBox="0 0 16 16" fill="none"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      item.appendChild(chevron);
    } else {
      item.dataset.commandId = def.commandId || '';
      var kbd = document.createElement('span');
      kbd.className = 'kbd';
      item.appendChild(kbd);
    }
    return item;
  }

  function refreshItemContent(item) {
    var def = item.__def;
    if (!def) return;
    var label = item.querySelector('.help-menu-label');
    if (label) label.textContent = itemLabel(def);
    var kbd = item.querySelector('.kbd');
    if (kbd) {
      var seq = def.commandId ? shortcutFor(def.commandId) : '';
      kbd.textContent = seq;
      kbd.style.display = seq ? '' : 'none';
    }
  }

  function buildMenuItem(menuEl, def) {
    var item = makeItem(def);
    item.__def = def;

    item.addEventListener('click', function (e) {
      /* 不冒泡到 document 关闭逻辑（同 tabs.js / project-tree 菜单项） */
      if (e.stopPropagation) e.stopPropagation();
      if (def.children) {
        toggleSubMenu(item, def);
        return;
      }
      runCommand(def.commandId);
      closeMenu();
    });
    item.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        if (e.preventDefault) e.preventDefault();
        if (def.children) {
          toggleSubMenu(item, def);
        } else {
          runCommand(def.commandId);
          closeMenu();
        }
      }
    });
    if (def.children) {
      item.addEventListener('mouseenter', function () {
        scheduleSubMenuOpen(item, def);
      });
      item.addEventListener('mouseleave', function () {
        scheduleSubMenuClose(item);
      });
    }
    menuEl.appendChild(item);
    return item;
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
      buildMenuItem(menu, def);
    });
    state.menuEl = menu;
    refreshMenu();
    return menu;
  }

  function mainItems() {
    if (!state.menuEl) return [];
    return Array.prototype.slice.call(state.menuEl.querySelectorAll('.ctx-item'));
  }

  function subItems() {
    if (!state.subMenuEl) return [];
    return Array.prototype.slice.call(state.subMenuEl.querySelectorAll('.ctx-item'));
  }

  /* ── 二级子菜单 ── */

  function buildSubMenu(def) {
    var sub = document.createElement('div');
    sub.className = 'ctx-menu ctx-submenu';
    sub.setAttribute('role', 'menu');
    sub.setAttribute('aria-label', itemLabel(def));
    def.children.forEach(function (childDef) {
      var item = buildMenuItem(sub, childDef);
      refreshItemContent(item); /* 构建即按当前语言/键位填标签与快捷键 */
    });
    return sub;
  }

  function positionSubMenu(parentItem, sub) {
    var rect = parentItem.getBoundingClientRect
      ? parentItem.getBoundingClientRect()
      : { left: 0, right: 0, top: 0, bottom: 0 };
    var vw = root.innerWidth || 1024;
    var vh = root.innerHeight || 768;
    var mRect = sub.getBoundingClientRect ? sub.getBoundingClientRect() : { width: 180, height: 40 };
    var px = rect.right;
    var py = rect.top - 4;
    var width = mRect.width || 180;
    var height = mRect.height || 40;
    if (px + width > vw) px = Math.max(0, rect.left - width);
    if (py + height > vh) py = Math.max(0, vh - height - 4);
    sub.style.left = px + 'px';
    sub.style.top = py + 'px';
  }

  function openSubMenu(parentItem, def) {
    cancelSubTimers();
    closeSubMenu();
    var sub = buildSubMenu(def);
    document.body.appendChild(sub);
    positionSubMenu(parentItem, sub);
    state.subMenuEl = sub;
    state.subOpenFor = parentItem;
    parentItem.classList.add('expanded');
    parentItem.setAttribute('aria-expanded', 'true');

    var items = subItems();
    if (items.length && typeof items[0].focus === 'function') {
      try { items[0].focus(); } catch (e) {}
    }
  }

  function closeSubMenu() {
    cancelSubTimers();
    if (state.subOpenFor) {
      state.subOpenFor.classList.remove('expanded');
      state.subOpenFor.setAttribute('aria-expanded', 'false');
    }
    if (state.subMenuEl && state.subMenuEl.parentNode) {
      state.subMenuEl.parentNode.removeChild(state.subMenuEl);
    }
    state.subMenuEl = null;
    state.subOpenFor = null;
  }

  function toggleSubMenu(parentItem, def) {
    if (state.subOpenFor === parentItem) {
      closeSubMenu();
      try { parentItem.focus(); } catch (e) {}
    } else {
      openSubMenu(parentItem, def);
    }
  }

  function scheduleSubMenuOpen(parentItem, def) {
    cancelSubTimers();
    if (state.subOpenFor === parentItem) return;
    state.subTimer = root.setTimeout(function () {
      state.subTimer = null;
      openSubMenu(parentItem, def);
    }, SUB_OPEN_DELAY);
  }

  function scheduleSubMenuClose(parentItem) {
    cancelSubTimers();
    state.closeTimer = root.setTimeout(function () {
      state.closeTimer = null;
      /* 焦点/指针已移入子菜单则不收起（子菜单贴着父项，视觉上是连续区域） */
      var active = document.activeElement;
      if (state.subMenuEl && active && state.subMenuEl.contains(active)) return;
      if (state.subOpenFor === parentItem) closeSubMenu();
    }, SUB_CLOSE_DELAY);
  }

  function cancelSubTimers() {
    if (state.subTimer) { root.clearTimeout(state.subTimer); state.subTimer = null; }
    if (state.closeTimer) { root.clearTimeout(state.closeTimer); state.closeTimer = null; }
  }

  /* ── 刷新（语言/键位变更） ── */

  function refreshMenu() {
    if (!state.menuEl) return;
    state.menuEl.setAttribute('aria-label', t('help.menuAria', '应用菜单'));
    mainItems().forEach(refreshItemContent);
    if (state.subMenuEl) {
      subItems().forEach(refreshItemContent);
    }
  }

  /* ── 开合 ── */

  function openMenu() {
    closeMenu(); /* 防叠加 */
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

    var items = mainItems();
    if (items.length && typeof items[0].focus === 'function') {
      try { items[0].focus(); } catch (e) {}
    }
  }

  function closeMenu() {
    if (!state.open && !state.menuEl) return;
    closeSubMenu();
    state.open = false;
    if (state.menuEl && state.menuEl.parentNode) {
      state.menuEl.parentNode.removeChild(state.menuEl);
    }
    if (state.btn) state.btn.setAttribute('aria-expanded', 'false');
  }

  function isOpen() {
    return state.open;
  }

  /* ── 初始化与全局监听 ── */

  function init() {
    var btn = document.getElementById('btn-menu');
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
        var items = mainItems();
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
      if (e.target && state.subMenuEl && state.subMenuEl.contains && state.subMenuEl.contains(e.target)) return;
      if (e.target === btn || (btn.contains && btn.contains(e.target))) return; /* 按钮自身点击走 toggle */
      closeMenu();
    });
    document.addEventListener('contextmenu', function (e) {
      if (!state.open) return;
      if (e.target && ((state.menuEl && state.menuEl.contains(e.target)) || (state.subMenuEl && state.subMenuEl.contains(e.target)))) return;
      closeMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (!state.open) return;
      if (e.key === 'Escape') {
        if (e.preventDefault) e.preventDefault();
        /* 先收二级（焦点回父项），再按一次才整体关闭 */
        if (state.subMenuEl) {
          var parent = state.subOpenFor;
          closeSubMenu();
          if (parent && typeof parent.focus === 'function') { try { parent.focus(); } catch (err) {} }
          return;
        }
        closeMenu();
        if (typeof btn.focus === 'function') { try { btn.focus(); } catch (err) {} }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        var active = document.activeElement;
        var inSub = !!(state.subMenuEl && active && state.subMenuEl.contains(active));
        var inMain = !!(state.menuEl && active && state.menuEl.contains(active));
        if (!inSub && !inMain) return;

        if (e.key === 'ArrowLeft') {
          if (inSub) {
            if (e.preventDefault) e.preventDefault();
            var parent2 = state.subOpenFor;
            closeSubMenu();
            if (parent2 && typeof parent2.focus === 'function') { try { parent2.focus(); } catch (err) {} }
          }
          return;
        }
        if (e.key === 'ArrowRight') {
          if (inMain && active && active.dataset && active.dataset.hasSub && active.__def) {
            if (e.preventDefault) e.preventDefault();
            openSubMenu(active, active.__def);
          }
          return;
        }
        /* ↑/↓：在当前所在菜单内循环 */
        if (e.preventDefault) e.preventDefault();
        var list = inSub ? subItems() : mainItems();
        if (!list.length) return;
        var idx = list.indexOf(active);
        var next;
        if (idx === -1) {
          next = list[0];
        } else {
          var step = e.key === 'ArrowDown' ? 1 : -1;
          next = list[(idx + step + list.length) % list.length];
        }
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
