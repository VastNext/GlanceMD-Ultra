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
      empty.textContent = '暂无大纲';
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
        scrollToHeading(index);
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
      if (heading.el && typeof heading.el.scrollIntoView === 'function') {
        heading.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    var root = document.getElementById('preview-container');
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
    clearNode(container); // 摘掉 index.html 自带的空态 <p class="panel-empty">
    container.appendChild(listEl);
    return true;
  }

  if (mount()) {
    watchPreview();
    rebuild(); // 首次构建（预览为空 → 空态）
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
    /** 200ms 防抖重建（模拟预览变化后由测试/集成方触发） */
    scheduleRefresh: scheduleRebuild,
    /** 模块是否成功挂载（#outline-root 存在） */
    isMounted: function() {
      return !!(listEl && listEl.parentNode === container);
    }
  };
})();
