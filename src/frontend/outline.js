// Outline 面板（前端，Wave 2b）—— window.Outline
// 从预览 DOM（#preview 内 h1–h6）提取大纲，MutationObserver 监听预览变化
// （200ms 防抖）重建层级列表；点击项滚动预览到对应标题；空文档/无标题显示空态。
// 视觉对照：docs/design/01-project-tree.html 的 Outline 竖栏（激活项渐变文字）。
// DOM 契约：接管 #outline-root（.panel-body，index.html 自带的"暂无大纲"空态由本模块重建）；
// 样式见 outline.css（须在 style.css 之后装载，见 docs/dev/contracts/recovery-outline.md §6）。
(function() {
  'use strict';

  if (window.Outline) {
    return;
  }

  var DEBOUNCE_MS = 200;

  var container = null;       // #outline-root（面板主体，接管点）
  var listEl = null;          // #outline-list（本模块创建）
  var previewEl = null;       // #preview
  var headings = [];          // [{ level, text, el }]
  var activeIndex = -1;
  var debounceTimer = null;
  var mutationObserver = null;
  var intersectionObserver = null;

  function t(key, params) {
    return window.I18n && typeof window.I18n.t === 'function' ? window.I18n.t(key, params) : key;
  }

  /* ══════════ 提取与渲染 ══════════ */

  function largeFileAllowed() {
    var sa = window.SettingsApply;
    try {
      var settings = sa && typeof sa.get === 'function' ? (sa.get() || {}) : {};
      var mb = Number(settings.editor && settings.editor.largeFileMB);
      var editor = document.getElementById('editor');
      var size = editor && typeof editor.value === 'string' ? editor.value.length : 0;
      return size <= (isFinite(mb) && mb > 0 ? mb : 5) * 1024 * 1024;
    } catch (e) { return true; }
  }

  function extractHeadings() {
    if (!largeFileAllowed()) return [];
    if (!previewEl || typeof previewEl.querySelectorAll !== 'function') {
      return [];
    }
    var nodes = previewEl.querySelectorAll('h1, h2, h3, h4, h5, h6');
    var result = [];
    Array.prototype.slice.call(nodes || []).forEach(function(node) {
      var level = Number(String(node.tagName || '').charAt(1));
      if (!(level >= 1 && level <= 6)) {
        return;
      }
      result.push({
        level: level,
        text: String(node.textContent || '').replace(/\s+/g, ' ').trim(),
        el: node
      });
    });
    return result;
  }

  function clearNode(el) {
    if (!el) {
      return;
    }
    el.innerHTML = '';
  }

  function render() {
    if (!listEl) {
      return;
    }
    clearNode(listEl);
    if (!headings.length) {
      var empty = document.createElement('p');
      empty.className = 'panel-empty outline-empty';
      empty.textContent = t('outline.empty');
      listEl.appendChild(empty);
      activeIndex = -1;
      return;
    }
    headings.forEach(function(heading, index) {
      var item = document.createElement('div');
      item.className = 'outline-item outline-h' + heading.level;
      item.setAttribute('data-outline-index', String(index));
      item.setAttribute('title', heading.text);

      var lv = document.createElement('span');
      lv.className = 'outline-lv';
      lv.textContent = 'H' + heading.level;
      item.appendChild(lv);

      var line = document.createElement('span');
      line.className = 'outline-line';
      line.textContent = heading.text || '（无标题文本）';
      item.appendChild(line);

      item.addEventListener('click', function() {
        if (window.Commands && typeof window.Commands.run === 'function') {
          window.Commands.run('outline.goTo', { index: index });
        } else {
          scrollToHeading(index);
        }
      });
      listEl.appendChild(item);
    });
    applyActive();
  }

  function rebuild() {
    headings = extractHeadings();
    if (activeIndex >= headings.length) {
      activeIndex = -1; // 内容变化后旧高亮越界即清除
    }
    render();
    setupIntersectionObserver();
  }

  function scheduleRebuild() {
    if (typeof window.clearTimeout === 'function' && debounceTimer != null) {
      window.clearTimeout(debounceTimer);
    }
    if (typeof window.setTimeout !== 'function') {
      rebuild();
      return;
    }
    debounceTimer = window.setTimeout(function() {
      debounceTimer = null;
      rebuild();
    }, DEBOUNCE_MS);
  }

  /* ══════════ 面板显隐与停靠（与 LayoutUI 同步） ══════════ */

  var previousFocus = null;
  function toggle() {
    var wasOpen = window.Outline && typeof window.Outline.isOpen === 'function' ? window.Outline.isOpen() : false;
    if (window.LayoutUI && typeof window.LayoutUI.toggle === 'function') {
      window.LayoutUI.toggle('outline');
    } else {
      var panel = document.getElementById('panel-outline');
      if (panel && panel.classList) panel.classList.toggle('open');
    }
    if (wasOpen) {
      if (previousFocus && typeof previousFocus.focus === 'function') {
        try { previousFocus.focus(); } catch (e) {}
      } else {
        var editor = document.getElementById('editor');
        if (editor && typeof editor.focus === 'function') editor.focus();
      }
      previousFocus = null;
    } else {
      previousFocus = document.activeElement;
      var target = listEl || container || document.getElementById('panel-outline');
      if (target && typeof target.focus === 'function') target.focus();
    }
  }

  function show() {
    if (window.LayoutUI && typeof window.LayoutUI.expand === 'function') {
      window.LayoutUI.expand('outline');
    } else {
      var panel = document.getElementById('panel-outline');
      if (panel && panel.classList) {
        panel.classList.add('open');
      }
    }
  }

  function hide() {
    if (window.LayoutUI && typeof window.LayoutUI.collapse === 'function') {
      window.LayoutUI.collapse('outline');
    } else {
      var panel = document.getElementById('panel-outline');
      if (panel && panel.classList) {
        panel.classList.remove('open');
      }
    }
  }

  function resetWidth() {
    if (window.LayoutUI && typeof window.LayoutUI.resetWidth === 'function') {
      window.LayoutUI.resetWidth('outline');
    } else if (window.LayoutUI && typeof window.LayoutUI.resetPanel === 'function') {
      window.LayoutUI.resetPanel('outline');
    }
  }

  function setSide(side) {
    var next = side === 'left' || side === 'right' ? side : 'right';
    if (window.LayoutUI && typeof window.LayoutUI.setOutlineSide === 'function') {
      window.LayoutUI.setOutlineSide(next);
    }
  }

  /* ══════════ 激活、键盘导航与滚动 ══════════ */

  function scrollActiveIntoList() {
    if (!listEl || typeof listEl.querySelectorAll !== 'function') {
      return;
    }
    var items = listEl.querySelectorAll('.outline-item');
    if (items && items[activeIndex]) {
      var item = items[activeIndex];
      if (item && typeof item.scrollIntoView === 'function') {
        try {
          item.scrollIntoView({ block: 'nearest' });
        } catch (e) {}
      }
    }
  }

  function selectNext() {
    if (!headings.length) return -1;
    var nextIndex;
    if (activeIndex === -1) {
      nextIndex = 0;
    } else {
      nextIndex = Math.min(headings.length - 1, activeIndex + 1);
    }
    setActive(nextIndex);
    scrollActiveIntoList();
    return nextIndex;
  }

  function selectPrevious() {
    if (!headings.length) return -1;
    var prevIndex;
    if (activeIndex === -1) {
      prevIndex = headings.length - 1;
    } else {
      prevIndex = Math.max(0, activeIndex - 1);
    }
    setActive(prevIndex);
    scrollActiveIntoList();
    return prevIndex;
  }

  function openSelection() {
    if (!headings.length) return;
    var targetIndex = activeIndex;
    if (targetIndex < 0 || targetIndex >= headings.length) {
      targetIndex = 0;
      setActive(0);
    }
    scrollToHeading(targetIndex);
    var editor = document.getElementById('editor');
    if (editor && typeof editor.focus === 'function') {
      try {
        editor.focus();
      } catch (e) {}
    }
  }

  function focus() {
    show();
    var target = listEl || container || document.getElementById('panel-outline');
    if (target && typeof target.focus === 'function') {
      try {
        target.focus();
      } catch (e) {}
    }
  }

  function onKeyDown(e) {
    if (!e || !e.key) return;
    if (e._outlineHandled) return;
    e._outlineHandled = true;

    if (e.key === 'ArrowDown' || e.key === 'Down') {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      selectNext();
    } else if (e.key === 'ArrowUp' || e.key === 'Up') {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      selectPrevious();
    } else if (e.key === 'Enter') {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        var target = activeIndex >= 0 && activeIndex < headings.length ? activeIndex : (headings.length ? 0 : -1);
        if (target >= 0) {
          if (activeIndex !== target) setActive(target);
          scrollToHeading(target);
        }
      } else {
        openSelection();
      }
    } else if (e.key === 'F5') {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      rebuild();
    }
  }

  /* ══════════ 激活与滚动 ══════════ */

  function applyActive() {
    if (!listEl || typeof listEl.querySelectorAll !== 'function') {
      return;
    }
    var items = listEl.querySelectorAll('.outline-item');
    Array.prototype.slice.call(items || []).forEach(function(item, index) {
      if (item.classList && typeof item.classList.toggle === 'function') {
        item.classList.toggle('active', index === activeIndex);
      }
    });
  }

  function setActive(index) {
    if (!(index >= 0 && index < headings.length)) {
      return;
    }
    activeIndex = index;
    applyActive();
  }

  function scrollToHeading(index) {
    var heading = headings[index];
    if (!heading) {
      return;
    }
    // These are independent surfaces: a failure in one must not suppress the
    // editor navigation or active-state update for the others.
    try {
      if (heading.el && window.PreviewNavigation && typeof window.PreviewNavigation.scrollToElement === 'function') {
        window.PreviewNavigation.scrollToElement(heading.el, { behavior: 'smooth', block: 'start' });
      }
    } catch (e) {
      /* 预览滚动失败静默（如预览隐藏） */
    }
    try {
      if (window.EditorNavigation && typeof window.EditorNavigation.scrollToHeading === 'function') {
        window.EditorNavigation.scrollToHeading(index, { level: heading.level, text: heading.text });
      }
    } catch (e) {
      /* 编辑器定位失败不影响预览与高亮 */
    }
    try {
      setActive(index); // 点击即时反馈； IntersectionObserver 可用时会接管后续高亮
    } catch (e) {
      /* 高亮失败不影响两侧滚动 */
    }
  }

  // 当前可视标题高亮：可选增强，构造失败（环境不支持）即静默跳过。
  function setupIntersectionObserver() {
    if (typeof IntersectionObserver !== 'function' || !headings.length) {
      return;
    }
    if (intersectionObserver) {
      try { intersectionObserver.disconnect(); } catch (e) { /* 忽略 */ }
      intersectionObserver = null;
    }
    var root = window.PreviewNavigation && typeof window.PreviewNavigation.getScroller === 'function'
      ? window.PreviewNavigation.getScroller()
      : document.getElementById('preview-wrapper');
    try {
      intersectionObserver = new IntersectionObserver(function(entries) {
        var topIndex = -1;
        (entries || []).forEach(function(entry) {
          if (!entry || !entry.isIntersecting) {
            return;
          }
          for (var i = 0; i < headings.length; i++) {
            if (headings[i].el === entry.target) {
              if (topIndex === -1 || i < topIndex) {
                topIndex = i;
              }
              break;
            }
          }
        });
        if (topIndex !== -1) {
          setActive(topIndex);
        }
      }, { root: root || null, rootMargin: '0px 0px -80% 0px', threshold: 0 });
      headings.forEach(function(heading) {
        intersectionObserver.observe(heading.el);
      });
    } catch (e) {
      intersectionObserver = null; // 失败静默：仅失去滚动跟随高亮
    }
  }

  /* ══════════ 预览变化监听 ══════════ */

  function watchPreview() {
    if (typeof MutationObserver !== 'function' || !previewEl) {
      return;
    }
    try {
      mutationObserver = new MutationObserver(function() {
        scheduleRebuild();
      });
      mutationObserver.observe(previewEl, {
        childList: true,
        subtree: true,
        characterData: true
      });
    } catch (e) {
      mutationObserver = null; // 监听失败静默：可用 Outline.refresh() 手动重建
    }
  }

  /* ══════════ 挂载 ══════════ */

  function mount() {
    container = document.getElementById('outline-root');
    previewEl = document.getElementById('preview');
    if (!container) {
      return false;
    }
    listEl = document.createElement('div');
    listEl.id = 'outline-list';
    listEl.className = 'outline-list';
    if (typeof listEl.setAttribute === 'function') {
      listEl.setAttribute('tabindex', '0');
    }
    clearNode(container); // 摘掉 index.html 自带的空态 <p class="panel-empty">
    container.appendChild(listEl);
    if (typeof container.setAttribute === 'function') {
      container.setAttribute('tabindex', '0');
    }
    if (typeof container.addEventListener === 'function') {
      container.addEventListener('keydown', onKeyDown);
      container.addEventListener('focus', function() {
        if (window.contextKeys) window.contextKeys.set('outlineFocus', true);
      });
      container.addEventListener('blur', function() {
        if (window.contextKeys) window.contextKeys.remove('outlineFocus');
      });
    }
    if (typeof listEl.addEventListener === 'function') {
      listEl.addEventListener('keydown', onKeyDown);
    }
    return true;
  }

  function registerCommands() {
    if (!window.Commands || typeof window.Commands.register !== 'function') {
      return;
    }
    var reg = window.Commands.register;
    if (!window.Commands.has('outline.toggle')) {
      reg('outline.toggle', {
        label: '切换大纲',
        category: 'View',
        run: function() { toggle(); }
      });
    }
    if (!window.Commands.has('outline.show')) {
      reg('outline.show', {
        label: '显示大纲',
        category: 'View',
        run: function() { show(); }
      });
    }
    if (!window.Commands.has('outline.hide')) {
      reg('outline.hide', {
        label: '隐藏大纲',
        category: 'View',
        run: function() { hide(); }
      });
    }
    if (!window.Commands.has('outline.resetWidth')) {
      reg('outline.resetWidth', {
        label: '重置大纲宽度',
        category: 'View',
        run: function() { resetWidth(); }
      });
    }
    if (!window.Commands.has('outline.setSide')) {
      reg('outline.setSide', {
        label: '设置大纲位置',
        category: 'View',
        run: function(arg) {
          var side = (arg && typeof arg === 'object' ? arg.side : arg) || 'right';
          setSide(side);
        }
      });
    }
    if (!window.Commands.has('outline.refresh')) {
      reg('outline.refresh', {
        label: '刷新大纲',
        category: 'View',
        run: function() { rebuild(); }
      });
    }
    if (!window.Commands.has('outline.goTo')) {
      reg('outline.goTo', {
        label: '跳转到大纲项',
        category: 'Navigation',
        run: function(arg) {
          var idx = arg && typeof arg === 'object' ? arg.index : arg;
          scrollToHeading(Number(idx));
        }
      });
    }
    if (!window.Commands.has('outline.openSelection')) {
      reg('outline.openSelection', {
        label: '打开选中大纲项',
        category: 'Navigation',
        run: function() { openSelection(); }
      });
    }
    if (!window.Commands.has('outline.selectNext')) {
      reg('outline.selectNext', {
        label: '选择下一项大纲',
        category: 'Navigation',
        run: function() { selectNext(); }
      });
    }
    if (!window.Commands.has('outline.selectPrevious')) {
      reg('outline.selectPrevious', {
        label: '选择上一项大纲',
        category: 'Navigation',
        run: function() { selectPrevious(); }
      });
    }
    if (!window.Commands.has('outline.focus')) {
      reg('outline.focus', {
        label: '聚焦大纲',
        category: 'Navigation',
        run: function() { focus(); }
      });
    }
  }

  if (mount()) {
    watchPreview();
    rebuild(); // 首次构建（预览为空 → 空态）
    registerCommands();
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('i18n-changed', function() {
        if (!headings.length) {
          render();
        }
      });
    }
  }

  window.Outline = {
    /** 手动重建（预览 MutationObserver 不可用时兜底） */
    refresh: rebuild,
    /** 当前大纲 [{level, text}]（不含 DOM 引用） */
    getHeadings: function() {
      return headings.map(function(h) {
        return { level: h.level, text: h.text };
      });
    },
    /** 当前高亮项下标（无则 -1） */
    getActiveIndex: function() {
      return activeIndex;
    },
    /** 手动设置高亮项 */
    setActive: setActive,
    /** 滚动到指定下标的标题 */
    scrollTo: scrollToHeading,
    /** 跳转到指定下标的标题 */
    goTo: function(index) {
      scrollToHeading(Number(index));
    },
    /** 200ms 防抖重建（模拟预览变化后由测试/集成方触发） */
    scheduleRefresh: scheduleRebuild,
    /** 模块是否成功挂载（#outline-root 存在） */
    isMounted: function() {
      return !!(listEl && listEl.parentNode === container);
    },
    /** 切换 Outline 面板显隐 */
    toggle: toggle,
    /** 显示 Outline 面板 */
    show: show,
    /** 隐藏 Outline 面板 */
    hide: hide,
    /** 显示 Outline 面板（别名） */
    open: show,
    /** 隐藏 Outline 面板（别名） */
    close: hide,
    /** Outline 是否展开显示 */
    isOpen: function() {
      if (window.LayoutUI && typeof window.LayoutUI.isCollapsed === 'function') {
        return !window.LayoutUI.isCollapsed('outline');
      }
      var panel = document.getElementById('panel-outline');
      return !!(panel && panel.classList && panel.classList.contains('open'));
    },
    /** 重置 Outline 宽度 */
    resetWidth: resetWidth,
    /** 设置停靠侧 */
    setSide: setSide,
    /** 选中下一项 */
    selectNext: selectNext,
    /** 选中上一项 */
    selectPrevious: selectPrevious,
    /** 打开选中项（滚动并聚焦编辑器） */
    openSelection: openSelection,
    /** 聚焦 Outline */
    focus: focus,
    /** 注册 Commands 命令 */
    registerCommands: registerCommands
  };
})();
