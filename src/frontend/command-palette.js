(function () {
  'use strict';

  function t(key, params) { return window.I18n ? window.I18n.t(key, params) : key; }
  var KEY = 'glancemd-ultra-palette-recent';
  var state = { open: false, selected: 0, recent: [], previousActiveElement: null };

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
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function runCommand(id, arg) {
    if (window.Commands && typeof window.Commands.run === 'function') return window.Commands.run(id, arg);
  }

  function score(q, s) {
    q = q.toLowerCase();
    s = s.toLowerCase();
    var i = 0, n = 0, last = -2;
    for (var c = 0; c < q.length; c++) {
      var p = s.indexOf(q[c], i);
      if (p < 0) return -1;
      n += 1 + (p === last + 1 ? 3 : 0);
      last = p;
      i = p + 1;
    }
    return n;
  }

  function ensure() {
    var p = document.getElementById('command-palette');
    if (p) return p;
    p = document.createElement('section');
    p.id = 'command-palette';
    p.className = 'command-palette';
    p.hidden = true;
    p.innerHTML = '<input id="palette-input" placeholder="' + t('palette.placeholder') + '"><div id="palette-list" role="listbox"></div>';
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
        runCommand('palette.close');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        runCommand('palette.selectNext');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        runCommand('palette.selectPrevious');
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
        runCommand('palette.executeSelected');
      }
    });

    return p;
  }

  function definitions() {
    var ids = window.Commands && Commands.ids ? Commands.ids() : [];
    return ids.map(function (id) {
      return window.Commands.get ? window.Commands.get(id) : { id: id, label: id };
    }).filter(function (d) {
      return d && d.visibleInPalette !== false && (!d.isEnabled || typeof d.isEnabled !== 'function' || d.isEnabled()) && d.category !== 'internal' && d.category !== 'Internal' && String(d.id || '').indexOf('internal.') !== 0;
    });
  }

  function currentItems() {
    var p = ensure(), input = p.querySelector('input');
    var q = input ? (input.value || '') : '';
    return definitions().map(function (d) {
      var text = [d.label, d.category, d.description, d.id].join(' ');
      return { d: d, s: score(q, text) };
    }).filter(function (x) {
      return x.s >= 0;
    }).sort(function (a, b) {
      return b.s - a.s || a.d.label.localeCompare(b.d.label);
    });
  }

  function scrollToActive() {
    var p = ensure();
    var activeEl = p.querySelector('.palette-item.active');
    if (activeEl) {
      getOverlayHelper().scrollIntoView(activeEl, { block: 'nearest', inline: 'nearest' });
    }
  }

  function render() {
    var p = ensure(), items = currentItems();
    if (state.selected >= items.length) state.selected = Math.max(0, items.length - 1);
    var listEl = p.querySelector('#palette-list');
    if (!listEl) return;

    listEl.innerHTML = items.map(function (x, i) {
      return '<button class="palette-item ' + (i === state.selected ? 'active' : '') + '" data-id="' + esc(x.d.id) + '" role="option" aria-selected="' + (i === state.selected ? 'true' : 'false') + '"><strong>' + esc(x.d.label) + '</strong><small>' + esc(x.d.category || '') + (x.d.description ? ' — ' + esc(x.d.description) : '') + '</small></button>';
    }).join('');

    Array.prototype.forEach.call(listEl.querySelectorAll('.palette-item'), function (b, idx) {
      b.onclick = function () {
        state.selected = idx;
        runCommand('palette.executeSelected');
      };
    });

    scrollToActive();
  }

  function executeSelected() {
    var items = currentItems(), item = items[state.selected];
    if (!item) return;
    state.recent.unshift(item.d.id);
    state.recent = state.recent.filter(function (x, i, a) { return a.indexOf(x) === i; }).slice(0, 5);
    try { localStorage.setItem(KEY, JSON.stringify(state.recent)); } catch (e) {}
    close();
    runCommand(item.d.id);
  }

  function open() {
    var p = ensure();
    state.open = true;
    p.hidden = false;
    state.selected = 0;

    var input = p.querySelector('input');
    if (input) {
      input.value = '';
      if (typeof input.focus === 'function') input.focus();
    }

    getOverlayHelper().open('command-palette', p, close);
    render();
  }

  function close() {
    if (!state.open && (!document.getElementById('command-palette') || document.getElementById('command-palette').hidden)) {
      return;
    }
    state.open = false;
    var p = document.getElementById('command-palette');
    if (p) p.hidden = true;
    getOverlayHelper().close('command-palette');
  }

  function toggle() {
    state.open ? close() : open();
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

  try { state.recent = JSON.parse(localStorage.getItem(KEY) || '[]') || []; } catch (e) {}

  function registerCommands() {
    if (!window.Commands || typeof window.Commands.register !== 'function') return;
    var reg = window.Commands.register;
    reg('palette.toggle', { label: '切换命令面板', category: 'Navigation', run: toggle });
    reg('palette.open', { label: '打开命令面板', category: 'Navigation', run: open });
    reg('palette.close', { label: '关闭命令面板', category: 'Navigation', run: close });
    reg('palette.selectNext', { label: '命令面板下一项', category: 'Navigation', run: selectNext });
    reg('palette.selectPrevious', { label: '命令面板上一项', category: 'Navigation', run: selectPrevious });
    reg('palette.executeSelected', { label: '执行选中命令', category: 'Navigation', run: executeSelected });
  }

  registerCommands();
  window.CommandPalette = {
    open: open,
    close: close,
    toggle: toggle,
    selectNext: selectNext,
    selectPrevious: selectPrevious,
    executeSelected: executeSelected,
    run: function (id) { runCommand(id); },
    score: score,
    getState: function () { return { open: state.open, selected: state.selected, recent: state.recent.slice() }; }
  };
})();
