// 设置生效层（window.SettingsApply）——把 workspace:settings-effective 的有效设置
// 落到 CSS 变量与编辑器 DOM（阶段 5）。
//
// 数据流：
// - 模块装载时 init() 发一次 workspace.settings.get-effective（开机即生效，
//   不依赖用户打开设置面板），并订阅 workspace:settings-effective；
// - apply(effective) 把 editor.fontSize / editor.tabSize / editor.wordWrap /
//   editor.lineNumbers / appearance.sidebarFontSize 写入对应载体：
//   · 字号/Tab 宽度/侧栏字号 → documentElement CSS 变量（style.css 消费，
//     随 --zoom 缩放的规则保持在 CSS 侧）；
//   · wordWrap → #editor 的 wrap 属性 soft/off（改属性前保存 value 再恢复，
//     避免 textarea 语义切换丢失内容）+ .wrap-off 类切换 white-space；
//   · lineNumbers → #editor-container 的 .gutter-on 类显隐 #editor-gutter 行号槽；
// - get() 返回最近一次 effective（未收到事件时返回与 Rust schema v1 一致的
//   内置默认），供其他模块（如 editor.js 的 Tab 插入空格数）同步读取。
//
// 行号槽（#editor-gutter）：
// - 绝对定位覆盖 #editor 左侧 padding 区，与编辑器同字体/同行高，scrollTop
//   随编辑器同步；行数 = max(逻辑行数, 视口可容纳行数)；
// - 触发时机：编辑器 input/scroll 即时同步；tab 切换直接写 editor.value 不发
//   input 事件，故辅以低频轮询兜底（值长度与 scrollTop 都未变则跳过）；
// - wordWrap=true 时行号按逻辑行编号——软换行折出的视觉行不单独编号，
//   长行折行处行号会出现视觉跳变（契约已知偏差，见 settings.md §2.5）。
(function () {
  'use strict';

  if (window.SettingsApply) {
    return;
  }

  // 内置默认值：与 Rust settings.rs schema v1 的 Default 一致。
  var DEFAULTS = {
    appearance: { theme: 'light', sidebarFontSize: 14, language: 'zh-CN', outlineSide: 'right' },
    files: {
      visibleExts: ['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'toml', 'ini', 'csv'],
      showHidden: false,
      exclude: ['.git', 'node_modules', 'target', '.venv', 'dist', 'build', '.cache'],
      watcherExclude: ['.git', 'node_modules', 'target', '.venv', 'dist', 'build', '.cache']
    },
    watching: { enableWatcher: true, autoSave: 'off', autoSaveDelayMs: 1000 },
    search: {
      exclude: ['.git', 'node_modules', 'target', '.venv', 'dist', 'build', '.cache'],
      maxFileSizeMB: 5,
      maxResults: 2000
    },
    editor: { fontSize: 14, tabSize: 4, wordWrap: true, lineNumbers: true, largeFileMB: 5 },
    recovery: { confirmCloseDirty: true, crashRecovery: true, createProjectSettings: false }
  };

  // 最近一次 effective 设置（null = 尚未收到事件）。
  var latest = null;
  var systemThemeMedia = null;
  var systemThemeHandler = null;

  // 行号槽低频兜底轮询间隔（tab 切换等程序化写值无 input 事件时的同步兜底）。
  var POLL_INTERVAL_MS = 300;

  var editorBound = false;   // 编辑器 input/scroll 监听只绑一次
  var lastGutter = { count: -1, scrollTop: -1, value: null, width: -1, fontSize: -1, tabSize: -1 }; // 行号槽重建去重

  /* ── 工具 ── */

  function send(m) {
    if (window.ipc && window.ipc.postMessage) {
      window.ipc.postMessage(JSON.stringify(m));
    }
  }

  function numOr(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  function boolOr(v, fallback) {
    return typeof v === 'boolean' ? v : fallback;
  }

  function clampSidebarFontSize(v) {
    return Math.min(18, Math.max(12, numOr(v, DEFAULTS.appearance.sidebarFontSize)));
  }

  function applyTheme(theme) {
    var requested = theme === 'light' || theme === 'dark' || theme === 'system' ? theme : DEFAULTS.appearance.theme;
    var resolved = requested;
    if (requested === 'system') {
      if (typeof window.matchMedia === 'function') {
        try { resolved = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch (e) { resolved = 'dark'; }
      } else resolved = 'dark';
    }
    var root = document.documentElement;
    if (root) {
      if (root.setAttribute) root.setAttribute('data-theme', resolved);
      else if (root.dataset) root.dataset.theme = resolved;
    }
    if (requested === 'system' && typeof window.matchMedia === 'function') {
      var media;
      try { media = window.matchMedia('(prefers-color-scheme: light)'); } catch (e) { media = null; }
      if (media && media !== systemThemeMedia) {
        if (systemThemeMedia && systemThemeHandler) {
          if (systemThemeMedia.removeEventListener) systemThemeMedia.removeEventListener('change', systemThemeHandler);
          else if (systemThemeMedia.removeListener) systemThemeMedia.removeListener(systemThemeHandler);
        }
        systemThemeMedia = media;
        systemThemeHandler = function() { if (latest && latest.appearance && latest.appearance.theme === 'system') applyTheme('system'); };
        if (media.addEventListener) media.addEventListener('change', systemThemeHandler); else if (media.addListener) media.addListener(systemThemeHandler);
      }
    } else if (systemThemeMedia && systemThemeHandler) {
      if (systemThemeMedia.removeEventListener) systemThemeMedia.removeEventListener('change', systemThemeHandler);
      else if (systemThemeMedia.removeListener) systemThemeMedia.removeListener(systemThemeHandler);
      systemThemeMedia = null; systemThemeHandler = null;
    }
  }

  function requestEffective() { send({ command: 'workspace.settings.get-effective' }); }

  function setVar(name, value) {
    var root = document.documentElement;
    if (root && root.style && typeof root.style.setProperty === 'function') {
      root.style.setProperty(name, value);
    }
  }

  // 动态整数行高绑定：计算整数像素行高并写入 CSS 变量 --editor-line-height 与 --editor-font-size
  function applyEditorFontSize(fontSize) {
    var size = numOr(fontSize, DEFAULTS.editor.fontSize);
    var integerLineHeight = Math.round(size * 1.75);
    setVar('--editor-font-size', size + 'px');
    setVar('--editor-line-height', integerLineHeight + 'px');
    return integerLineHeight;
  }

  // 与 style.css #editor line-height: var(--editor-line-height, 25px) 保持一致；app.js 的 --zoom 缺省按 1。
  function editorLineHeightPx(fontSize) {
    var size = numOr(fontSize, DEFAULTS.editor.fontSize);
    var integerLineHeight = Math.round(size * 1.75);
    var zoom = 1;
    var root = document.documentElement;
    if (root && root.style && typeof root.style.getPropertyValue === 'function') {
      var z = parseFloat(root.style.getPropertyValue('--zoom'));
      if (isFinite(z) && z > 0) zoom = z;
    }
    return Math.round(integerLineHeight * zoom);
  }

  /* ── 各设置项落地 ── */

  // wordWrap：切 wrap 属性（soft/off）与 .wrap-off 类。
  // 注意：保留 selection 锚点，不重写 editor.value，防止光标丢失或跳回开头
  function applyWordWrap(on) {
    var editor = document.getElementById('editor');
    if (!editor) return;
    var wrap = on ? 'soft' : 'off';
    var selStart = typeof editor.selectionStart === 'number' ? editor.selectionStart : 0;
    var selEnd = typeof editor.selectionEnd === 'number' ? editor.selectionEnd : 0;
    if (typeof editor.getAttribute === 'function' && editor.getAttribute('wrap') !== wrap) {
      editor.setAttribute('wrap', wrap);
    }
    if (editor.classList && typeof editor.classList.toggle === 'function') {
      editor.classList.toggle('wrap-off', !on);
    }
    if (typeof editor.setSelectionRange === 'function') {
      editor.setSelectionRange(selStart, selEnd);
    }
    syncGutter();
  }

  // lineNumbers：行号槽显隐 + 立即同步一次内容。
  function applyLineNumbers(on) {
    var container = document.getElementById('editor-container');
    var gutter = document.getElementById('editor-gutter');
    if (container && container.classList && typeof container.classList.toggle === 'function') {
      container.classList.toggle('gutter-on', !!on);
    }
    if (gutter && gutter.style) {
      gutter.style.display = on ? '' : 'none';
    }
    if (on) {
      syncGutter();
    }
  }

  /* ── 行号槽同步 ── */

  // 行数 = max(逻辑行数, 视口可容纳行数)；只有行数变化才重建文本，
  // scrollTop 每次都同步（编辑器滚动时行号跟随）。
  function syncGutter() {
    var gutter = document.getElementById('editor-gutter');
    var editor = document.getElementById('editor');
    if (!gutter || !editor) return;
    var eff = get();
    if (!eff.editor.lineNumbers) return; // 关闭态由 applyLineNumbers 隐藏，无需渲染

    var value = typeof editor.value === 'string' ? editor.value : '';
    var logicalLines = value.split('\n');
    var doc = editor.ownerDocument || document;
    var fontSize = numOr(eff.editor.fontSize, DEFAULTS.editor.fontSize);
    var tabSize = numOr(eff.editor.tabSize, DEFAULTS.editor.tabSize);
    var cs = window.getComputedStyle ? window.getComputedStyle(editor) : null;
    var lineHeight = cs && parseFloat(cs.lineHeight);
    if (!isFinite(lineHeight) || lineHeight <= 0) lineHeight = editorLineHeightPx(fontSize);
    lineHeight = Math.round(lineHeight);
    var width = editor.clientWidth || (cs && parseFloat(cs.width)) || 0;

    // 读取编辑器实时换行状态：wrap 属性不为 off 且未包含 wrap-off 类
    var isWrapping = typeof editor.getAttribute === 'function'
      ? (editor.getAttribute('wrap') !== 'off' && (!editor.classList || !editor.classList.contains('wrap-off')))
      : boolOr(eff.editor.wordWrap, DEFAULTS.editor.wordWrap);

    var padL = cs ? parseFloat(cs.paddingLeft) || 0 : 0;
    var padR = cs ? parseFloat(cs.paddingRight) || 0 : 0;
    var contentWidth = Math.max(1, width - padL - padR);

    var measured = [];
    var mirror = null;
    // 仅在 isWrapping 开启时才创建 mirror 测量膨胀高度；!isWrapping 时严禁调用 mirror 测量
    if (isWrapping && doc && doc.createElement && contentWidth > 0 && editor.parentNode) {
      mirror = doc.createElement('div');
      mirror.style.position = 'absolute'; mirror.style.visibility = 'hidden';
      mirror.style.pointerEvents = 'none'; mirror.style.whiteSpace = 'pre-wrap';
      mirror.style.overflowWrap = 'break-word'; mirror.style.wordBreak = 'normal';
      mirror.style.tabSize = String(tabSize); mirror.style.font = cs && cs.font || '';
      mirror.style.fontFamily = cs && cs.fontFamily || ''; mirror.style.fontSize = cs && cs.fontSize || fontSize + 'px';
      mirror.style.lineHeight = cs && cs.lineHeight || lineHeight + 'px'; mirror.style.letterSpacing = cs && cs.letterSpacing || '';
      mirror.style.boxSizing = 'content-box';
      mirror.style.padding = '0'; mirror.style.border = '0'; mirror.style.width = contentWidth + 'px';
      editor.parentNode.appendChild(mirror);
    }
    logicalLines.forEach(function(line) {
      var height = lineHeight;
      if (isWrapping && mirror) {
        mirror.textContent = line || ' ';
        height = Math.max(lineHeight, mirror.getBoundingClientRect().height || lineHeight);
      }
      measured.push(height);
    });
    if (mirror) editor.parentNode.removeChild(mirror);
    var viewportLines = lineHeight > 0 && gutter.clientHeight > 0 ? Math.ceil(gutter.clientHeight / lineHeight) : 0;
    // gutter 容器自身高度必须始终与编辑器视口高度一致（height: 100%），绝对不能将自身设为内容总高度，
    // 否则 clientHeight 等于 scrollHeight 导致无法滚动，出现行号固定卡在首屏数字的严重 bug。
    gutter.style.height = '100%';
    gutter.style.maxHeight = '100%';
    gutter.style.overflowY = 'hidden';
    gutter.style.lineHeight = lineHeight + 'px';
    gutter.textContent = '';
    if (!doc || !doc.createElement) {
      var fallbackTotal = Math.max(logicalLines.length, viewportLines);
      gutter.textContent = new Array(fallbackTotal).fill(0).map(function(_, i) { return i + 1; }).join('\n');
      lastGutter.count = fallbackTotal; lastGutter.value = value; lastGutter.width = width; lastGutter.isWrapping = isWrapping;
      var fallbackTop = typeof editor.scrollTop === 'number' ? editor.scrollTop : 0;
      gutter.scrollTop = fallbackTop; lastGutter.scrollTop = fallbackTop;
      return;
    }
    var frag = doc.createDocumentFragment ? doc.createDocumentFragment() : null;
    var totalRows = Math.max(logicalLines.length, viewportLines);
    for (var i = 0; i < totalRows; i++) {
      var row = doc.createElement('div');
      row.textContent = String(i + 1);
      row.style.height = (i < logicalLines.length ? measured[i] : lineHeight) + 'px';
      row.style.lineHeight = lineHeight + 'px';
      row.style.boxSizing = 'border-box';
      row.style.textAlign = 'right';
      if (frag) frag.appendChild(row); else gutter.appendChild(row);
    }
    if (frag) gutter.appendChild(frag);
    lastGutter.count = totalRows;
    lastGutter.value = value; lastGutter.width = width; lastGutter.fontSize = fontSize; lastGutter.tabSize = tabSize; lastGutter.isWrapping = isWrapping;
    var top = typeof editor.scrollTop === 'number' ? editor.scrollTop : 0;
    if (top !== lastGutter.scrollTop) {
      gutter.scrollTop = top;
      lastGutter.scrollTop = top;
    }
  }

  function bindEditor() {
    if (editorBound) return;
    var editor = document.getElementById('editor');
    if (!editor || typeof editor.addEventListener !== 'function') return;
    editor.addEventListener('input', syncGutter);
    editor.addEventListener('scroll', syncGutter);
    if (typeof window.ResizeObserver === 'function') {
      try {
        var ro = new window.ResizeObserver(function () {
          syncGutter();
        });
        ro.observe(editor);
      } catch (e) {}
    }
    editorBound = true;
  }

  /* ── 对外 API ── */

  // 应用一份有效设置（workspace:settings-effective 的 d.settings）。
  function apply(effective) {
    var s = effective || {};
    var ed = s.editor || {};
    var ap = s.appearance || {};

    var fontSize = numOr(ed.fontSize, DEFAULTS.editor.fontSize);
    applyEditorFontSize(fontSize);
    setVar('--editor-tab-size', String(numOr(ed.tabSize, DEFAULTS.editor.tabSize)));
    var sidebarFontSize = clampSidebarFontSize(ap.sidebarFontSize);
    setVar('--panel-font-size', sidebarFontSize + 'px');
    setVar('--tree-font-size', sidebarFontSize + 'px');
    setVar('--tree-icon-size', Math.round(sidebarFontSize * 1.42) + 'px');
    setVar('--tree-caret-size', Math.round(sidebarFontSize * 1.0) + 'px');
    setVar('--tree-row-height', Math.round(sidebarFontSize * 2.2) + 'px');
    setVar('--tree-gap', Math.round(sidebarFontSize * 0.6) + 'px');
    setVar('--tree-indent', Math.round(sidebarFontSize * 1.14) + 'px');
    applyTheme(ap.theme);
    var outlineSide = ap.outlineSide === 'left' || ap.outlineSide === 'right' ? ap.outlineSide : DEFAULTS.appearance.outlineSide;
    if (window.LayoutUI && typeof window.LayoutUI.setOutlineSide === 'function') window.LayoutUI.setOutlineSide(outlineSide);

    applyWordWrap(boolOr(ed.wordWrap, DEFAULTS.editor.wordWrap));
    applyLineNumbers(boolOr(ed.lineNumbers, DEFAULTS.editor.lineNumbers));

    // 界面语言：设置里的选择同步到 I18n（I18n.setLanguage 内部做同值去重）
    if (ap.language && window.I18n && typeof window.I18n.setLanguage === 'function') {
      window.I18n.setLanguage(ap.language);
    }

    latest = s;
    bindEditor();
    syncGutter();
  }

  // 最近一次 effective（深拷贝防外部改写缓存）；未收到事件时返回内置默认。
  function get() {
    var s = latest || {};
    return {
      version: Number(s.version) || 1,
      appearance: Object.assign({}, DEFAULTS.appearance, s.appearance),
      files: Object.assign({}, DEFAULTS.files, s.files),
      watching: Object.assign({}, DEFAULTS.watching, s.watching),
      search: Object.assign({}, DEFAULTS.search, s.search),
      editor: Object.assign({}, DEFAULTS.editor, s.editor),
      keybindings: Object.assign({ overrides: {} }, s.keybindings),
      recovery: Object.assign({}, DEFAULTS.recovery, s.recovery)
    };
  }

  // 开机即生效：先用内置默认值立即生效一次（避免等待回执期间行号槽隐藏），再拉一次有效设置并订阅后续变更。
  function init() {
    apply(DEFAULTS);
    requestEffective();
    if (window.Workspace && typeof window.Workspace.on === 'function') {
      window.Workspace.on('workspace:settings-effective', function (d) {
        apply(d && d.settings);
      });
      window.Workspace.on('workspace:settings-changed', requestEffective);
      window.Workspace.on('workspace:opened', requestEffective);
    }
    if (typeof window.setInterval === 'function') {
      window.setInterval(function () {
        var editor = document.getElementById('editor');
        if (!editor) return;
        // 廉价哨兵：值长度、scrollTop 与换行状态均未变时跳过重算（用户编辑已由 input 即时同步）
        var len = typeof editor.value === 'string' ? editor.value.length : 0;
        var top = typeof editor.scrollTop === 'number' ? editor.scrollTop : 0;
        var width = editor.clientWidth || 0;
        var isWrapping = typeof editor.getAttribute === 'function'
          ? (editor.getAttribute('wrap') !== 'off' && (!editor.classList || !editor.classList.contains('wrap-off')))
          : true;
        if (len !== lastGutter.valueLen || top !== lastGutter.scrollTop || width !== lastGutter.width || isWrapping !== lastGutter.isWrapping) {
          lastGutter.valueLen = len;
          syncGutter();
        }
      }, POLL_INTERVAL_MS);
    }
    bindEditor();
    syncGutter();
  }

  window.SettingsApply = {
    apply: apply,
    applyTheme: applyTheme,
    applyEditorFontSize: applyEditorFontSize,
    editorLineHeightPx: editorLineHeightPx,
    applyWordWrap: applyWordWrap,
    applyLineNumbers: applyLineNumbers,
    get: get,
    init: init,
    requestEffective: requestEffective,
    syncGutter: syncGutter
  };

  init();
})();
