/* quick-outline.js — 快速大纲跳转弹出层 (Quick Outline)
 * 契约与规范：
 * 1. 快捷键 Ctrl+O 触发，支持在 Editor（单栏）、Preview（单栏）、Split（双栏）模式下调用。
 * 2. 居中悬浮弹窗，UI 继承 Key Assist 设计系统（半透明磨砂背景、品牌紫粉渐变色系、明暗主题高对比度）。
 * 3. 实时从文档提取所有标题 (H1~H6)，跳过 YAML frontmatter 与代码块内伪标题（复用 EditorNavigation.getHeadingDescriptors / parseHeadings）。
 * 4. 支持输入模糊搜索、ArrowUp / ArrowDown 键盘循环导航、Enter 确认跳转、Escape/点击外部关闭。
 * 5. 跳转行为：
 *    - Edit 模式：Editor 精准跳转到标题源行并聚焦；
 *    - Preview 模式：Preview 平滑居中滚动到对应渲染标题元素并呈现 1.5s 柔和发光动画；
 *    - Split 分屏模式：双栏协同跳转（Editor 准确定位到源行首，Preview 同步滚动居中并高亮，焦点停留在 Editor）。
 */

(function (root) {
  'use strict';

  var state = {
    isOpen: false,
    headings: [],
    filtered: [],
    selectedIndex: 0,
    dom: null,
    previousActiveElement: null
  };

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // 提取当前文档的大纲条目
  function extractHeadings() {
    var list = [];
    if (window.EditorNavigation && typeof window.EditorNavigation.getHeadingDescriptors === 'function') {
      try {
        var raw = window.EditorNavigation.getHeadingDescriptors();
        if (Array.isArray(raw)) {
          list = raw.map(function (h, idx) {
            return {
              index: idx,
              line: h.line,
              level: h.level || 1,
              text: (h.text || '').trim() || ('Untitled Heading ' + (idx + 1))
            };
          });
        }
      } catch (e) {}
    }

    // 若从 EditorNavigation 提取为空（如在某些纯预览场景），从 editor.value 兜底解析
    if (list.length === 0) {
      var editor = document.getElementById('editor');
      var val = editor ? editor.value : '';
      if (val) {
        var lines = val.split('\n');
        var inFence = false;
        var fenceChar = null;
        var fenceLen = 0;
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          var fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
          if (inFence) {
            if (fence && fence[1].charAt(0) === fenceChar && fence[1].length >= fenceLen) {
              inFence = false;
            }
            continue;
          }
          if (fence) {
            inFence = true;
            fenceChar = fence[1].charAt(0);
            fenceLen = fence[1].length;
            continue;
          }
          var m = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
          if (m) {
            list.push({
              index: list.length,
              line: i,
              level: m[1].length,
              text: m[2].replace(/\s+#+\s*$/, '').trim()
            });
          }
        }
      }
    }
    return list;
  }

  function ensureDom() {
    if (state.dom) return state.dom;

    var overlay = document.createElement('div');
    overlay.id = 'quick-outline-overlay';
    overlay.className = 'quick-outline-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    var dialog = document.createElement('div');
    dialog.className = 'quick-outline-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '大纲');
    dialog.setAttribute('tabindex', '-1');

    dialog.innerHTML = [
      '<div class="quick-outline-header">',
      '  <div class="quick-outline-title-wrap">',
      '    <h2 class="quick-outline-title">大纲</h2>',
      '    <span id="quick-outline-count-badge" class="quick-outline-badge">0 个标题</span>',
      '  </div>',
      '  <button id="quick-outline-btn-close" class="quick-outline-close-btn" aria-label="关闭">✕</button>',
      '</div>',
      '<div class="quick-outline-search-box">',
      '  <input id="quick-outline-search-input" class="quick-outline-input" type="text"',
      '    role="combobox" aria-autocomplete="list" aria-expanded="true"',
      '    placeholder="按标题快速过滤 (↑↓ 导航, Enter 跳转)..." />',
      '</div>',
      '<ul id="quick-outline-list" class="quick-outline-list" role="listbox"></ul>',
      '<div class="quick-outline-footer">',
      '  <div class="quick-outline-hints">',
      '    <span class="quick-outline-hint-item"><kbd>↑↓</kbd> 导航</span>',
      '    <span class="quick-outline-hint-item"><kbd>Enter</kbd> 跳转</span>',
      '    <span class="quick-outline-hint-item"><kbd>Esc</kbd> 关闭</span>',
      '  </div>',
      '</div>'
    ].join('');

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    var dom = {
      overlay: overlay,
      dialog: dialog,
      badge: dialog.querySelector('#quick-outline-count-badge'),
      btnClose: dialog.querySelector('#quick-outline-btn-close'),
      input: dialog.querySelector('#quick-outline-search-input'),
      list: dialog.querySelector('#quick-outline-list')
    };

    dom.btnClose.addEventListener('click', function () {
      close();
    });

    overlay.addEventListener('pointerdown', function (e) {
      if (e.target === overlay) {
        close();
      }
    });

    dom.input.addEventListener('input', function (e) {
      filter(e.target.value || '');
    });

    dom.input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectNext();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectPrev();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        confirmSelection();
      }
    });

    document.addEventListener('keydown', function (e) {
      if (state.isOpen && e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });

    state.dom = dom;
    return dom;
  }

  function filter(query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) {
      state.filtered = state.headings.slice();
    } else {
      state.filtered = state.headings.filter(function (h) {
        return h.text.toLowerCase().indexOf(q) !== -1;
      });
    }
    state.selectedIndex = 0;
    renderList();
  }

  function selectNext() {
    if (state.filtered.length <= 1) return;
    state.selectedIndex = (state.selectedIndex + 1) % state.filtered.length;
    updateSelection();
  }

  function selectPrev() {
    if (state.filtered.length <= 1) return;
    state.selectedIndex = (state.selectedIndex - 1 + state.filtered.length) % state.filtered.length;
    updateSelection();
  }

  function updateSelection() {
    if (!state.dom || !state.dom.list) return;
    var items = state.dom.list.querySelectorAll('.quick-outline-item');
    for (var i = 0; i < items.length; i++) {
      if (i === state.selectedIndex) {
        items[i].classList.add('selected');
        items[i].setAttribute('aria-selected', 'true');
        if (typeof items[i].scrollIntoView === 'function') {
          items[i].scrollIntoView({ block: 'nearest' });
        }
      } else {
        items[i].classList.remove('selected');
        items[i].removeAttribute('aria-selected');
      }
    }
  }

  function renderList() {
    var dom = state.dom;
    if (!dom) return;

    dom.badge.textContent = state.filtered.length + ' 个标题';
    dom.list.innerHTML = '';

    if (state.filtered.length === 0) {
      var emptyLi = document.createElement('li');
      emptyLi.className = 'quick-outline-empty';
      emptyLi.textContent = state.headings.length === 0 ? '当前文档无标题' : '无匹配标题';
      dom.list.appendChild(emptyLi);
      return;
    }

    var frag = document.createDocumentFragment();
    for (var i = 0; i < state.filtered.length; i++) {
      var h = state.filtered[i];
      var li = document.createElement('li');
      li.className = 'quick-outline-item' + (i === state.selectedIndex ? ' selected' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('data-index', String(i));
      li.style.paddingLeft = (12 + (h.level - 1) * 16) + 'px';

      var badge = document.createElement('span');
      badge.className = 'quick-outline-level-tag level-' + h.level;
      badge.textContent = 'H' + h.level;

      var textSpan = document.createElement('span');
      textSpan.className = 'quick-outline-text';
      textSpan.textContent = h.text;

      var lineSpan = document.createElement('span');
      lineSpan.className = 'quick-outline-line-hint';
      lineSpan.textContent = '行 ' + (h.line + 1);

      li.appendChild(badge);
      li.appendChild(textSpan);
      li.appendChild(lineSpan);

      (function (targetIdx) {
        li.addEventListener('click', function () {
          state.selectedIndex = targetIdx;
          confirmSelection();
        });
        li.addEventListener('mouseenter', function () {
          state.selectedIndex = targetIdx;
          updateSelection();
        });
      })(i);

      frag.appendChild(li);
    }
    dom.list.appendChild(frag);
    updateSelection();
  }

  // 核心跳转调度：精准执行 Editor、Preview 或 Split 双栏联动跳转
  function jumpToHeading(item) {
    if (!item) return;

    var isSplit = Boolean(window.splitMode || (document.body && document.body.classList.contains('split-mode')));
    var mode = typeof window.currentMode === 'string' ? window.currentMode : 'edit';
    var editor = document.getElementById('editor');

    // 1. 寻找 Preview 中对应的 DOM 标题元素
    var previewEl = document.getElementById('preview');
    var targetPreviewHeading = null;
    if (previewEl) {
      var tags = previewEl.querySelectorAll('h1, h2, h3, h4, h5, h6');
      var candidateIndex = 0;
      for (var p = 0; p < tags.length; p++) {
        var el = tags[p];
        var elLevel = parseInt(el.tagName.replace('H', ''), 10) || 1;
        var elText = (el.textContent || '').trim();
        if (elLevel === item.level && elText === item.text) {
          targetPreviewHeading = el;
          break;
        }
      }
      if (!targetPreviewHeading && tags[item.index]) {
        targetPreviewHeading = tags[item.index];
      }
    }

    // 2. 按照运行模式执行针对性跳转
    if (isSplit) {
      // ══════ 分屏模式：双栏都要做！Editor 精准滚动，Preview 同步滚动高亮，最终聚焦留在 Editor ══════
      if (editor && window.EditorNavigation && typeof window.EditorNavigation.scrollToLine === 'function') {
        window.EditorNavigation.scrollToLine(item.line);
        editor.focus();
      }
      if (targetPreviewHeading && window.PreviewNavigation && typeof window.PreviewNavigation.scrollToElement === 'function') {
        window.PreviewNavigation.scrollToElement(targetPreviewHeading, { behavior: 'smooth', block: 'center' });
        triggerPreviewHeadingFlash(targetPreviewHeading);
      }
      if (editor) {
        editor.focus();
      }
    } else if (mode === 'preview') {
      // ══════ 纯 Preview 预览模式：平滑居中滚动 Preview 并柔和发光高亮 ══════
      if (targetPreviewHeading && window.PreviewNavigation && typeof window.PreviewNavigation.scrollToElement === 'function') {
        window.PreviewNavigation.scrollToElement(targetPreviewHeading, { behavior: 'smooth', block: 'center' });
        triggerPreviewHeadingFlash(targetPreviewHeading);
      }
      // 同步记忆当前行，确保切回编辑区时光标停留在该行
      if (editor && typeof editor.setSelectionRange === 'function') {
        var lines = (editor.value || '').split('\n');
        var offset = 0;
        for (var l = 0; l < item.line && l < lines.length; l++) {
          offset += lines[l].length + 1;
        }
        editor.selectionStart = editor.selectionEnd = offset;
      }
      if (window.PreviewNavigation && typeof window.PreviewNavigation.focus === 'function') {
        window.PreviewNavigation.focus();
      }
    } else {
      // ══════ 纯 Editor 编辑模式：精准滚动到该标题源行首并聚焦 ══════
      if (editor && window.EditorNavigation && typeof window.EditorNavigation.scrollToLine === 'function') {
        window.EditorNavigation.scrollToLine(item.line);
        editor.focus();
      }
    }
  }

  function triggerPreviewHeadingFlash(el) {
    if (!el || !el.classList) return;
    el.classList.remove('quick-outline-target-flash');
    void el.offsetWidth;
    el.classList.add('quick-outline-target-flash');
    setTimeout(function () {
      el.classList.remove('quick-outline-target-flash');
    }, 1600);
  }

  function confirmSelection() {
    var selected = state.filtered[state.selectedIndex];
    close();
    if (selected) {
      jumpToHeading(selected);
    }
  }

  function open() {
    if (state.isOpen) return;
    state.previousActiveElement = document.activeElement;
    state.headings = extractHeadings();
    state.filtered = state.headings.slice();
    state.selectedIndex = 0;

    var dom = ensureDom();
    dom.input.value = '';
    renderList();

    dom.overlay.classList.add('open');
    state.isOpen = true;

    // 显示后同步聚焦，避免立即 Escape 丢失以及关闭后延迟回调抢焦点。
    dom.input.focus();
    dom.input.select();
  }

  function close() {
    if (!state.isOpen) return;
    var dom = state.dom;
    if (dom) {
      dom.overlay.classList.remove('open');
    }
    state.isOpen = false;

    // 恢复先前焦点
    if (state.previousActiveElement && typeof state.previousActiveElement.focus === 'function') {
      try {
        state.previousActiveElement.focus();
      } catch (e) {}
    }
  }

  function toggle() {
    if (state.isOpen) {
      close();
      return false;
    } else {
      open();
      return true;
    }
  }

  root.QuickOutline = {
    open: open,
    close: close,
    toggle: toggle,
    isOpen: function () { return state.isOpen; },
    getState: function () {
      return {
        isOpen: state.isOpen,
        selectedIndex: state.selectedIndex,
        headingsCount: state.headings.length,
        filteredCount: state.filtered.length
      };
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);
