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
  var lastGutter = { count: -1, scrollTop: -1 }; // 行号槽重建去重

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

  // 与 style.css #editor line-height: 1.8 保持一致；app.js 的 --zoom 缺省按 1。
  function editorLineHeightPx(fontSize) {
    var zoom = 1;
    var root = document.documentElement;
    if (root && root.style && typeof root.style.getPropertyValue === 'function') {
      var z = parseFloat(root.style.getPropertyValue('--zoom'));
      if (isFinite(z) && z > 0) zoom = z;
    }
    return fontSize * 1.8 * zoom;
  }

  /* ── 各设置项落地 ── */

  // wordWrap：切 wrap 属性（soft/off）。textarea 改 wrap 属性会触发语义重置，
  // 先保存 value 再恢复，避免丢内容；white-space 由 .wrap-off 类在 CSS 侧切换。
  function applyWordWrap(on) {
    var editor = document.getElementById('editor');
    if (!editor) return;
    var wrap = on ? 'soft' : 'off';
    if (typeof editor.getAttribute === 'function' && editor.getAttribute('wrap') !== wrap) {
      var value = editor.value;
      editor.setAttribute('wrap', wrap);
      editor.value = value;
    }
    if (editor.classList && typeof editor.classList.toggle === 'function') {
      editor.classList.toggle('wrap-off', !on);
    }
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
    var lines = value.split('\n').length;
    var lineH = editorLineHeightPx(numOr(eff.editor.fontSize, DEFAULTS.editor.fontSize));
    var viewportLines = lineH > 0 && gutter.clientHeight > 0
      ? Math.ceil(gutter.clientHeight / lineH)
      : 0;
    var total = Math.max(lines, viewportLines);

    if (total !== lastGutter.count) {
      var buf = new Array(total);
      for (var i = 0; i < total; i++) buf[i] = i + 1;
      gutter.textContent = buf.join('\n');
      lastGutter.count = total;
    }
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
    editorBound = true;
  }

  /* ── 对外 API ── */

  // 应用一份有效设置（workspace:settings-effective 的 d.settings）。
  function apply(effective) {
    var s = effective || {};
    var ed = s.editor || {};
    var ap = s.appearance || {};

    var fontSize = numOr(ed.fontSize, DEFAULTS.editor.fontSize);
    setVar('--editor-font-size', fontSize + 'px');
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

  // 开机即生效：拉一次有效设置并订阅后续变更。
  function init() {
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
        // 廉价哨兵：值长度与 scrollTop 均未变时跳过重算（用户编辑已由 input 即时同步）
        var len = typeof editor.value === 'string' ? editor.value.length : 0;
        var top = typeof editor.scrollTop === 'number' ? editor.scrollTop : 0;
        if (len !== lastGutter.valueLen || top !== lastGutter.scrollTop) {
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
    get: get,
    init: init,
    requestEffective: requestEffective,
    syncGutter: syncGutter
  };

  init();
})();
