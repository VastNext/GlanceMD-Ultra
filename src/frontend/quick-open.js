(function () {
  'use strict';

  function t(key, params) {
    if (window.I18n && typeof window.I18n.t === 'function') {
      var res = window.I18n.t(key, params);
      if (res && res !== key) return res;
    }
    if (key === 'quickopen.tabPlaceholder') return '快速切换标签页 (↑↓ 导航)...';
    if (key === 'quickopen.noTabs') return '当前无已打开的标签页';
    return key;
  }

  var state = {
    open: false,
    mode: 'file', // 'file' | 'tabs'
    root: '',
    files: [],
    selected: 0,
    previousActiveElement: null
  };

  function getOverlayHelper() {
    if (typeof window !== 'undefined' && window.OverlayHelper) {
      return window.OverlayHelper;
    }
    return {
      open: function (id, getEl, closeFn) {
        var el = typeof getEl === 'function' ? getEl() : getEl;
        state.previousActiveElement = document.activeElement;
        function onDoc(e) {
          if (!state.open) return;
          var target = e.target;
          if (el && target && (el === target || (el.contains && el.contains(target)))) return;
          close();
        }
        document.addEventListener('pointerdown', onDoc, true);
        document.addEventListener('focusin', onDoc, true);
      },
      close: function (id) {
        if (state.previousActiveElement && typeof state.previousActiveElement.focus === 'function') {
          try { state.previousActiveElement.focus(); } catch (e) {}
        }
      },
      scrollIntoView: function (el) {
        if (el && typeof el.scrollIntoView === 'function') {
          try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
        }
      }
    };
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function send(m) {
    if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(JSON.stringify(m));
  }

  function runCommand(id, arg) {
    if (window.Commands && typeof window.Commands.run === 'function') return window.Commands.run(id, arg);
  }

  function score(query, target) {
    if (!target) return -1;
    var q = query.toLowerCase(), s = target.toLowerCase();
    if (!q) return 0;
    var i = 0, total = 0, last = -2;
    for (var c = 0; c < q.length; c++) {
      var at = s.indexOf(q[c], i);
      if (at < 0) return -1;
      total += 1 + (at === last + 1 ? 3 : 0) + (at === 0 || '/\\_- .'.indexOf(s[at - 1]) >= 0 ? 2 : 0);
      last = at;
      i = at + 1;
    }
    var baseName = s.split(/[\\/]/).pop() || '';
    if (baseName.indexOf(q) >= 0) total += 5;
    return total;
  }

  function ensure() {
    var p = document.getElementById('quick-open');
    if (p) return p;
    p = document.createElement('section');
    p.id = 'quick-open';
    p.className = 'quick-open';
    p.hidden = true;
    p.innerHTML = '<input id="quick-open-input" placeholder="' + t('quickopen.placeholder') + '"><div id="quick-open-list" role="listbox"></div>';
    document.body.appendChild(p);

    var input = p.querySelector('input');
    input.addEventListener('input', function () {
      state.selected = 0;
      render();
    });

    p.addEventListener('keydown', function (e) {
      if (!state.open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        runCommand('quickopen.close');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        runCommand('quickopen.selectNext');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        runCommand('quickopen.selectPrevious');
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        moveSelection(5);
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        moveSelection(-5);
      } else if (e.key === 'Home' && e.target !== input) {
        e.preventDefault();
        state.selected = 0;
        render();
      } else if (e.key === 'End' && e.target !== input) {
        e.preventDefault();
        var items = currentItems();
        state.selected = Math.max(0, items.length - 1);
        render();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        runCommand('quickopen.openSelected');
      }
    });

    return p;
  }

  function getOpenTabs() {
    if (window.TabManager) {
      if (typeof window.TabManager.getTabs === 'function') {
        return window.TabManager.getTabs();
      }
      if (Array.isArray(window.TabManager.tabs)) {
        return window.TabManager.tabs;
      }
    }
    return [];
  }

  function currentItems() {
    var p = ensure(), input = p.querySelector('input');
    var q = input ? (input.value || '').trim() : '';

    if (state.mode === 'tabs') {
      var tabs = getOpenTabs();
      return tabs.map(function (tab, index) {
        var title = tab.title || tab.name || (tab.path ? tab.path.split(/[\\/]/).pop() : '') || ('Tab ' + tab.id);
        var path = tab.path || '';
        var searchStr = [title, path, tab.id].join(' ');
        return {
          type: 'tab',
          tab: tab,
          title: title,
          path: path,
          index: index,
          isDirty: !!(tab.isDirty || tab.dirty),
          isActive: !!(tab.active || tab.isActive),
          s: q ? score(q, searchStr) : 0
        };
      }).filter(function (x) {
        return x.s >= 0;
      }).sort(function (a, b) {
        if (q) {
          return b.s - a.s || a.title.localeCompare(b.title);
        }
        return a.index - b.index;
      });
    }

    // Default 'file' mode
    return state.files.map(function (f) {
      return {
        type: 'file',
        f: f,
        s: q ? score(q, f) : 0
      };
    }).filter(function (x) {
      return x.s >= 0;
    }).sort(function (a, b) {
      return b.s - a.s || a.f.localeCompare(b.f);
    }).slice(0, 50);
  }

  function scrollToActive() {
    var p = ensure();
    var activeEl = p.querySelector('.quick-open-item.active');
    if (activeEl) {
      getOverlayHelper().scrollIntoView(activeEl, { block: 'nearest', inline: 'nearest' });
    }
  }

  function render() {
    var p = ensure(), input = p.querySelector('input');
    if (input) {
      if (state.mode === 'tabs') {
        input.placeholder = t('quickopen.tabPlaceholder');
      } else {
        input.placeholder = t('quickopen.placeholder');
      }
    }

    var items = currentItems();
    if (state.selected >= items.length) state.selected = Math.max(0, items.length - 1);

    var listEl = p.querySelector('#quick-open-list');
    if (!listEl) return;

    if (items.length === 0) {
      var emptyMsg = state.mode === 'tabs' ? t('quickopen.noTabs') : t('quickopen.noMatches');
      listEl.innerHTML = '<p class="quick-open-empty">' + esc(emptyMsg) + '</p>';
      return;
    }

    if (state.mode === 'tabs') {
      listEl.innerHTML = items.map(function (x, i) {
        var isActive = i === state.selected;
        return [
          '<button class="quick-open-item quick-open-tab-item ' + (isActive ? 'active' : '') + '" data-tab-id="' + esc(x.tab.id) + '" role="option" aria-selected="' + (isActive ? 'true' : 'false') + '">',
          '  <div class="quick-open-item-main">',
          '    <span class="quick-open-tab-title">' + esc(x.title) + '</span>',
          x.path ? '    <span class="quick-open-tab-path">' + esc(x.path) + '</span>' : '',
          '  </div>',
          x.isDirty ? '  <span class="quick-open-dirty-badge" title="Unsaved">●</span>' : '',
          '</button>'
        ].join('');
      }).join('');

      Array.prototype.forEach.call(listEl.querySelectorAll('.quick-open-item'), function (b, idx) {
        b.addEventListener('click', function () {
          var tabId = b.getAttribute('data-tab-id');
          if (tabId) {
            switchTab(tabId);
          }
          close();
        });
      });
    } else {
      listEl.innerHTML = items.map(function (x, i) {
        var isActive = i === state.selected;
        return '<button class="quick-open-item ' + (isActive ? 'active' : '') + '" data-file="' + esc(x.f) + '" role="option" aria-selected="' + (isActive ? 'true' : 'false') + '"><span>' + esc(x.f) + '</span></button>';
      }).join('');

      Array.prototype.forEach.call(listEl.querySelectorAll('.quick-open-item'), function (b) {
        b.addEventListener('click', function () {
          var file = b.getAttribute('data-file');
          if (file) {
            runCommand('file.open', { path: (state.root ? state.root + '/' : '') + file });
          }
          close();
        });
      });
    }

    scrollToActive();
  }

  function switchTab(tabId) {
    if (window.TabManager && typeof window.TabManager.switchTab === 'function') {
      window.TabManager.switchTab(tabId);
      return;
    }
    runCommand('tabs.switch', { tabId: tabId });
  }

  function openSelected() {
    var items = currentItems(), item = items[state.selected];
    if (!item) return;

    if (item.type === 'tab' && item.tab) {
      switchTab(item.tab.id);
    } else if (item.type === 'file' && item.f) {
      runCommand('file.open', { path: (state.root ? state.root + '/' : '') + item.f });
    }
    close();
  }

  function open(mode) {
    state.mode = (mode === 'tabs') ? 'tabs' : 'file';
    state.open = true;
    state.selected = 0;

    var p = ensure();
    p.hidden = false;

    var input = p.querySelector('input');
    if (input) {
      input.value = '';
      if (typeof input.focus === 'function') input.focus();
    }

    getOverlayHelper().open('quick-open', p, close);
    render();
  }

  function openFiles() {
    open('file');
  }

  function openTabs() {
    open('tabs');
  }

  function openResource() {
    open('file');
  }

  function close() {
    if (!state.open && (!document.getElementById('quick-open') || document.getElementById('quick-open').hidden)) {
      return;
    }
    state.open = false;
    var p = document.getElementById('quick-open');
    if (p) p.hidden = true;
    getOverlayHelper().close('quick-open');
  }

  function toggle(mode) {
    var targetMode = (mode === 'tabs') ? 'tabs' : 'file';
    if (state.open && state.mode === targetMode) {
      close();
    } else {
      open(targetMode);
    }
  }

  function toggleFiles() {
    toggle('file');
  }

  function toggleTabs() {
    toggle('tabs');
  }

  function selectNext() {
    var items = currentItems();
    state.selected = Math.min(Math.max(0, items.length - 1), state.selected + 1);
    render();
  }

  function selectPrevious() {
    state.selected = Math.max(0, state.selected - 1);
    render();
  }

  function moveSelection(delta) {
    var items = currentItems();
    if (items.length === 0) return;
    state.selected = Math.max(0, Math.min(items.length - 1, state.selected + delta));
    render();
  }

  function setFiles(files) {
    // 去重保存
    var unique = [];
    var seen = {};
    (files || []).forEach(function (f) {
      if (f && !seen[f]) {
        seen[f] = true;
        unique.push(f);
      }
    });
    state.files = unique;
    if (state.open && state.mode === 'file') render();
  }

  function rebuild() {
    state.files = [];
    send({ command: 'workspace.tree.list', path: '' });
  }

  function receive(e, d) {
    if (e === 'workspace:opened') {
      state.root = d.root || '';
      rebuild();
    }
    if (e === 'workspace:tree-listed') {
      (d.entries || []).forEach(function (x) {
        var rel = x.relPath || x.rel_path;
        if (!rel) return;
        if (x.kind === 'dir' || x.kind === 'Dir') {
          send({ command: 'workspace.tree.list', path: rel });
        } else {
          // 避免重复追加
          if (state.files.indexOf(rel) === -1) {
            state.files.push(rel);
          }
        }
      });
      if (state.open && state.mode === 'file') render();
    }
  }

  if (window.Workspace && typeof window.Workspace.on === 'function') {
    window.Workspace.on('workspace:opened', function (d) { receive('workspace:opened', d); });
    window.Workspace.on('workspace:tree-listed', function (d) { receive('workspace:tree-listed', d); });
  }

  function registerCommands() {
    if (!window.Commands || typeof window.Commands.register !== 'function') return;
    var reg = window.Commands.register;
    function safeReg(id, definition) {
      if (!window.Commands.has || !window.Commands.has(id)) reg(id, definition);
    }
    safeReg('quickopen.toggle', { label: '切换快速打开', category: 'Navigation', run: function () { toggle('file'); } });
    safeReg('quickopen.open', { label: '打开快速打开', category: 'Navigation', run: function () { open('file'); } });
    safeReg('quickopen.close', { label: '关闭快速打开', category: 'Navigation', run: close });
    safeReg('quickopen.selectNext', { label: '快速打开下一项', category: 'Navigation', run: selectNext });
    safeReg('quickopen.selectPrevious', { label: '快速打开上一项', category: 'Navigation', run: selectPrevious });
    safeReg('quickopen.openSelected', { label: '打开选中项', category: 'Navigation', run: openSelected });
    // resource.open is the canonical public command; commands.js owns its registration.
    safeReg('quickopen.tabs', { label: '快速切换标签页', category: 'View', run: function () { open('tabs'); } });
    safeReg('tabs.quickSwitch', { label: '快速切换标签页', category: 'View', run: function () { toggle('tabs'); } });
  }

  registerCommands();

  // 语言切换：面板打开时重渲染（render 会按当前 mode 刷新占位符与空态文案）
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('i18n-changed', function () {
      if (state.open) render();
    });
  }

  window.QuickOpen = {
    open: open,
    close: close,
    toggle: toggle,
    openFiles: openFiles,
    openTabs: openTabs,
    openResource: openResource,
    toggleFiles: toggleFiles,
    toggleTabs: toggleTabs,
    selectNext: selectNext,
    selectPrevious: selectPrevious,
    openSelected: openSelected,
    setFiles: setFiles,
    getTabs: getOpenTabs,
    score: score,
    getState: function () {
      return {
        open: state.open,
        mode: state.mode,
        files: state.files.slice(),
        selected: state.selected
      };
    }
  };
})();
