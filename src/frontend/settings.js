// 设置面板（window.SettingsUI）—— workspace 设置 UI（阶段 5）。
//
// 数据流：
// - open() 时向 Rust 发三条读命令（get-effective / get-global / load-project），
//   由 workspace:settings-effective / -global / -project 事件回执驱动渲染；
// - 控件 onchange 时类内合并出完整 global，经 workspace.settings.set-global
//   落盘（data=JSON 字符串，信封与既有实现一致）；
// - Rust 广播 workspace:settings-changed（含其他来源的改动，如另一窗口或手动
//   编辑 settings.json）时，已打开的面板重发读命令刷新；
// - appearance.theme 变更即时切换 documentElement 的 data-theme 并写入
//   localStorage['glancemd-ultra-theme']；
// - appearance.language 变更即时调用 I18n.setLanguage 并触发全界面重刷；
// - 监听 'i18n-changed' 事件，在语言变化时重新渲染面板文本。
//
// 渲染层是元数据驱动的：七类分类（中文标签 + 一句描述）与每个键的中文
// 标签/说明集中在下方 CATEGORIES / META / ENUMS 表；控件按当前值类型选择
// （bool→switch、number→数字输入、枚举→自定义高精度下拉、数组→逗号分隔文本、
// 对象→JSON 文本、其余→文本输入）。
//
// 例外：keybindings 分类不走通用行渲染，而是专用快捷键列表（见 renderKbList）
// ——数据源是 window.Keybindings（localStorage 覆盖表，命令实际生效的一方）与
// window.Commands（命令中文标签），支持逐项录制修改、恢复默认与冲突提示；
// 全局搜索聚合同样跳过该分类。
(function () {
  'use strict';
  function t(key, params) { return window.I18n ? window.I18n.t(key, params) : key; }

  var state = { open: false, category: 'appearance', global: {}, effective: {}, project: {}, kbRecording: null, kbError: null, pendingTheme: null, warnings: [], overridden: [], terminals: null, terminalsScanning: false, terminalsScanned: false, customTerminalSelected: false, cliShim: { installed: false, dir: '', message: '' }, proxyTesting: false, proxyTestResult: null, proxyTestTimer: null };

  // 分类（与 Rust settings schema 一一对应）：中文标签 + 每类一句描述 + SVG 图标。
  var CATEGORIES = [
    {
      key: 'appearance',
      label: '外观',
      desc: '主题与界面配色',
      icon: '<svg class="svg-icon nav-icon" viewBox="0 0 24 24"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"></path></svg>'
    },
    {
      key: 'files',
      label: '文件',
      desc: '可见类型、隐藏文件与排除规则',
      icon: '<svg class="svg-icon nav-icon" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>'
    },
    {
      key: 'watching',
      label: '监听',
      desc: '文件监听与自动保存行为',
      icon: '<svg class="svg-icon nav-icon" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>'
    },
    {
      key: 'search',
      label: '搜索',
      desc: '搜索范围与结果数量上限',
      icon: '<svg class="svg-icon nav-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>'
    },
    {
      key: 'editor',
      label: '编辑器',
      desc: '字号、缩进、换行与大文件阈值',
      icon: '<svg class="svg-icon nav-icon" viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>'
    },
    {
      key: 'window',
      label: '窗口与命令行',
      desc: '窗口多开复用与命令行工具集成',
      labelKey: 'settings.windowCategory',
      descKey: 'settings.windowCategoryDesc',
      icon: '<svg class="svg-icon nav-icon" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="18" rx="2"></rect><line x1="2" y1="9" x2="22" y2="9"></line><polyline points="6 14 8 16 6 18"></polyline><line x1="11" y1="18" x2="15" y2="18"></line></svg>'
    },
    {
      key: 'http',
      label: '网络',
      desc: 'HTTP/HTTPS/SOCKS5 代理与连接测试',
      labelKey: 'settings.httpCategory',
      descKey: 'settings.httpCategoryDesc',
      icon: '<svg class="svg-icon nav-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>'
    },
    {
      key: 'keybindings',
      label: '快捷键',
      desc: '查看并修改命令快捷键',
      icon: '<svg class="svg-icon nav-icon" viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect><line x1="6" y1="8" x2="6.01" y2="8"></line><line x1="10" y1="8" x2="10.01" y2="8"></line><line x1="14" y1="8" x2="14.01" y2="8"></line><line x1="18" y1="8" x2="18.01" y2="8"></line><line x1="8" y1="12" x2="16" y2="12"></line><line x1="6" y1="16" x2="18" y2="16"></line></svg>'
    },
    {
      key: 'recovery',
      label: '恢复',
      desc: '未保存确认与崩溃恢复',
      icon: '<svg class="svg-icon nav-icon" viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>'
    }
  ];

  // 设置键元数据：key_path（类名.JSON 字段名，与序列化键一致）→ 中文标签 + 说明 + 约束。
  var META = {
    'appearance.theme': { label: '主题', desc: '界面配色：深色、浅色或跟随系统' },
    'appearance.language': { label: '界面语言', desc: '界面文案语言；切换后立即生效（个别面板重新打开后刷新）' },
    'appearance.sidebarFontSize': { label: '侧栏字体大小（px）', desc: '资源管理器与大纲面板的基准字号（12–18）', min: 12, max: 18, step: 1 },
    'appearance.outlineSide': { label: 'Outline 显示位置', desc: '大纲浮层显示在编辑区右侧或左侧，修改后立即生效' },
    'files.visibleExts': { label: '可见扩展名', desc: '项目树中显示的文件类型，逗号分隔' },
    'files.showHidden': { label: '显示隐藏文件', desc: '在项目树中显示点开头的隐藏文件' },
    'files.exclude': { label: '浏览排除', desc: '项目树不展示的目录或路径段，逗号分隔' },
    'files.watcherExclude': { label: '监听排除', desc: '文件监听忽略的目录或路径段，逗号分隔' },
    'files.terminalPath': { label: '终端程序', desc: '在终端中打开项目或目录时调用的程序' },
    'files.terminalArgs': { label: '终端参数', desc: '附加启动参数，支持 {dir} 作为目标目录占位符' },
    'watching.enableWatcher': { label: '启用文件监听', desc: '监听文件变更；修改此设置后自动暂停或恢复监听' },
    'watching.autoSave': { label: '自动保存', desc: '关闭、延时后自动保存，或失去焦点时保存' },
    'watching.autoSaveDelayMs': { label: '自动保存延时（毫秒）', desc: '“延时后自动保存”模式的触发延时', min: 100, max: 60000, step: 100 },
    'search.exclude': { label: '搜索排除', desc: '全文搜索跳过的目录或 glob，逗号分隔' },
    'search.maxFileSizeMB': { label: '文件大小上限（MB）', desc: '超过该大小的文件不参与搜索', min: 1, max: 100, step: 1 },
    'search.maxResults': { label: '结果数上限', desc: '单次搜索最多返回的结果数', min: 100, max: 10000, step: 100 },
    'editor.fontSize': { label: '字号（px）', desc: '编辑区字体大小', min: 10, max: 36, step: 1 },
    'editor.tabSize': { label: 'Tab 宽度', desc: '一个 Tab 对应的空格数', min: 1, max: 8, step: 1 },
    'editor.wordWrap': { label: '自动换行', desc: '超出编辑区宽度时自动折行' },
    'editor.lineNumbers': { label: '显示行号', desc: '编辑区左侧显示行号' },
    'editor.largeFileMB': { label: '大文件阈值（MB）', desc: '超过该大小进入大文件模式', min: 1, max: 100, step: 1 },
    'window.reuseWindowForFolder': {
      label: '命令行打开目录时复用已有窗口',
      desc: '关闭（默认）时每次打开新窗口；开启后切换已有窗口工作区',
      labelKey: 'settings.reuseWindowForFolder',
      descKey: 'settings.reuseWindowForFolderDesc'
    },
    'recovery.confirmCloseDirty': { label: '关闭未保存确认', desc: '关闭有未保存修改的标签时弹出确认' },
    'recovery.crashRecovery': { label: '崩溃恢复', desc: '定期把编辑内容写入恢复区' },
    'recovery.createProjectSettings': { label: '自动创建项目设置', desc: '打开工作区时自动创建 .glancemd/settings.json' },
    'http.proxySupport': {
      label: '代理模式',
      desc: '跟随系统代理、显式指定代理，或直连禁用',
      labelKey: 'settings.proxySupport',
      descKey: 'settings.proxySupportDesc'
    },
    'http.proxy': {
      label: '代理服务器',
      desc: '支持 http://、https://、socks5:// 地址，如 http://127.0.0.1:7890',
      labelKey: 'settings.proxyUrl',
      descKey: 'settings.proxyUrlDesc'
    },
    'http.proxyStrictSSL': {
      label: '严格校验 SSL 证书',
      desc: '关闭后跳过证书校验（仅用于自签证书/中间人代理等特殊场景）',
      labelKey: 'settings.proxyStrictSSL',
      descKey: 'settings.proxyStrictSSLDesc'
    }
  };

  // 默认设置值（重置分类兜底）
  var DEFAULT_EXCLUDES = ['.git', 'node_modules', 'target', '.venv', 'dist', 'build', '.cache'];
  var DEFAULT_SETTINGS = {
    appearance: { theme: 'light', sidebarFontSize: 14, outlineSide: 'right', language: 'zh-CN' },
    files: {
      visibleExts: ['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'toml', 'ini', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif'],
      showHidden: false,
      exclude: DEFAULT_EXCLUDES.slice(),
      watcherExclude: DEFAULT_EXCLUDES.slice(),
      terminalPath: '',
      terminalArgs: ''
    },
    watching: { autoSave: 'off', autoSaveDelayMs: 1000, enableWatcher: true },
    search: { exclude: DEFAULT_EXCLUDES.slice(), maxFileSizeMB: 5, maxResults: 2000 },
    editor: { fontSize: 14, tabSize: 4, wordWrap: true, lineNumbers: true, largeFileMB: 5 },
    window: { reuseWindowForFolder: false },
    recovery: { confirmCloseDirty: true, crashRecovery: true, createProjectSettings: false },
    http: { proxySupport: 'off', proxy: '', proxyStrictSSL: true }
  };

  // 枚举键：取值清单（渲染 <select>；当前值不在清单内时补一项兜底）。
  var ENUMS = {
    'appearance.theme': [
      { value: 'dark', label: '深色' },
      { value: 'light', label: '浅色' },
      { value: 'system', label: '跟随系统' }
    ],
    'appearance.language': [
      { value: 'zh-CN', label: '简体中文' },
      { value: 'en', label: 'English' }
    ],
    'appearance.outlineSide': [
      { value: 'right', label: '右侧' },
      { value: 'left', label: '左侧' }
    ],
    'watching.autoSave': [
      { value: 'off', label: '关闭' },
      { value: 'afterDelay', label: '延时后保存' },
      { value: 'onFocusLost', label: '失焦时保存' }
    ],
    'http.proxySupport': [
      { value: 'off', label: '直连（禁用代理）' },
      { value: 'system', label: '跟随系统代理' },
      { value: 'override', label: '使用下方指定代理' }
    ]
  };

  function send(m) { if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(JSON.stringify(m)); }


  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function categoryOf(key) {
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].key === key) return CATEGORIES[i];
    }
    return { key: key, label: key, desc: '', icon: '' };
  }

  function categoryLabel(c) {
    return c && c.labelKey ? t(c.labelKey) : ((c && c.label) || '');
  }

  function categoryDesc(c) {
    return c && c.descKey ? t(c.descKey) : ((c && c.desc) || '');
  }

  function metaOf(cat, key) {
    var m = META[cat + '.' + key] || { label: key, desc: '' };
    return {
      label: m.labelKey ? t(m.labelKey) : m.label,
      desc: m.descKey ? t(m.descKey) : m.desc,
      min: m.min,
      max: m.max,
      step: m.step
    };
  }

  // 渲染与回写共用的取值来源：优先 effective（与显示一致），缺键回退 global。
  function valueOf(cat, key) {
    var obj = state.effective[cat] || {};
    if (key in obj) return obj[key];
    return (state.global[cat] || {})[key];
  }

  // ── 面板骨架 ──
  var lastFocusedEl = null;

  function ensure() {
    var p = document.getElementById('settings-panel');
    if (p) return p;
    p = document.createElement('section');
    p.id = 'settings-panel';
    p.className = 'settings-panel settings-overlay';
    p.hidden = true;
    p.innerHTML = '<div class="settings-dialog" id="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title">'
      + '<header id="settings-header" class="dialog-header">'
      + '<div class="dialog-header-title">'
      + '<svg class="svg-icon title-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>'
      + '<strong id="settings-dialog-title">' + t('settings.title') + '</strong>'
      + '<span class="badge" id="current-category-badge">' + esc(categoryOf(state.category).label) + '</span>'
      + '</div>'
      + '<div class="dialog-header-actions">'
      + '<div class="search-input-box">'
      + '<svg class="svg-icon" width="13" height="13" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>'
      + '<input id="settings-filter" placeholder="' + t('settings.searchPlaceholder') + '（支持中文标签或键名）" aria-label="' + t('settings.searchPlaceholder') + '">'
      + '</div>'
      + '<button id="settings-close" class="modal-close-btn" title="' + t('settings.close') + '（Esc）" aria-label="' + t('settings.close') + '"><svg class="svg-icon" width="16" height="16" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>'
      + '</div>'
      + '</header>'
      + '<div class="settings-layout dialog-body">'
      + '<nav id="settings-categories" class="dialog-nav" aria-label="设置分类"></nav>'
      + '<main id="settings-body" class="dialog-content"></main>'
      + '</div>'
      + '<footer class="dialog-footer">'
      + '<button id="settings-json" class="btn" title="在内置编辑器中直接查看与编辑 JSON 配置文件"><svg class="svg-icon" width="13" height="13" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><polyline points="10 13 8 15 10 17"></polyline><polyline points="14 13 16 15 14 17"></polyline></svg> ' + t('settings.openJson') + '</button>'
      + '<div class="dialog-footer-actions">'
      + '<button type="button" class="btn" id="settings-reset-category">重置当前分类为默认</button>'
      + '<button type="button" class="btn btn-primary" id="settings-done">完成</button>'
      + '</div>'
      + '</footer>'
      + '<div id="settings-resize-handle" class="dialog-resize-grip settings-resize-handle" title="调整大小"></div>'
      + '</div>';
    document.body.appendChild(p);

    var closeBtn = p.querySelector('#settings-close');
    if (closeBtn) closeBtn.onclick = close;
    var doneBtn = p.querySelector('#settings-done');
    if (doneBtn) doneBtn.onclick = close;
    var resetCatBtn = p.querySelector('#settings-reset-category');
    if (resetCatBtn) resetCatBtn.onclick = resetCurrentCategory;
    var jsonBtn = p.querySelector('#settings-json');
    if (jsonBtn) jsonBtn.onclick = function () { send({ command: 'workspace.settings.open-settings-json' }); };
    var filterInput = p.querySelector('#settings-filter');
    if (filterInput) filterInput.oninput = render;

    p.addEventListener('click', function (e) {
      if (e.target === p) close();
    });

    wireDrag(p);
    wireResize(p);
    wireFocusTrap(p);
    renderCategories();
    render();
    return p;
  }

  // ── 拖动 / 缩放 / 位置记忆 ──
  var POS_KEY = 'glancemd-ultra-settings-pos';
  var SIZE_KEY = 'glancemd-ultra-settings-size';
  var GEO_KEY = 'glancemd-ultra-settings-geometry';

  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 无存储环境忽略 */ } }

  function viewport() {
    return { w: (typeof window !== 'undefined' && window.innerWidth) || 1024, h: (typeof window !== 'undefined' && window.innerHeight) || 768 };
  }

  function applyGeometry(p, left, top, width, height) {
    var dialog = p.querySelector ? p.querySelector('.settings-dialog') : null;
    var target = dialog || p;
    if (!target) return;
    if (!target.style) target.style = {};
    var vp = viewport();
    var minW = Math.min(760, vp.w - 32);
    var minH = Math.min(520, vp.h - 48);
    var maxW = Math.min(1080, Math.floor(vp.w * 0.95));
    var maxH = Math.min(800, Math.floor(vp.h * 0.92));

    var w = width ? Math.max(minW, Math.min(width, maxW)) : 880;
    var h = height ? Math.max(minH, Math.min(height, maxH)) : 640;

    target.style.width = w + 'px';
    target.style.height = h + 'px';

    if (left !== null && top !== null && left !== undefined && top !== undefined) {
      var maxLeft = Math.max(10, vp.w - w - 10);
      var maxTop = Math.max(10, vp.h - h - 10);
      var l = Math.max(10, Math.min(left, maxLeft));
      var t = Math.max(10, Math.min(top, maxTop));
      target.style.transform = 'none';
      target.style.left = l + 'px';
      target.style.top = t + 'px';
      target.style.margin = '0';
    } else {
      target.style.left = '';
      target.style.top = '';
      target.style.transform = '';
      target.style.margin = '';
    }
  }

  function restoreGeometry(p) {
    var geo = lsGet(GEO_KEY) || {};
    var pos = lsGet(POS_KEY), size = lsGet(SIZE_KEY);
    var left = geo.x !== undefined ? geo.x : (pos && pos.left);
    var top = geo.y !== undefined ? geo.y : (pos && pos.top);
    var width = geo.w || (size && size.width) || 880;
    var height = geo.h || (size && size.height) || 640;
    applyGeometry(p, left, top, width, height);
  }

  function saveGeometry(p) {
    var dialog = p.querySelector ? p.querySelector('.settings-dialog') : null;
    var target = dialog || p;
    if (!target || typeof target.getBoundingClientRect !== 'function') return;
    var r = target.getBoundingClientRect();
    var geo = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    lsSet(GEO_KEY, geo);
    lsSet(POS_KEY, { left: geo.x, top: geo.y });
    lsSet(SIZE_KEY, { width: geo.w, height: geo.h });
  }

  function wireDrag(p) {
    var header = p.querySelector('#settings-header');
    if (!header) return;
    header.addEventListener('pointerdown', function (e) {
      if (e.target.closest && e.target.closest('button, input')) return;
      var dialog = p.querySelector('.settings-dialog') || p;
      if (typeof dialog.getBoundingClientRect !== 'function') return;
      var rect = dialog.getBoundingClientRect();
      var offX = e.clientX - rect.left, offY = e.clientY - rect.top;
      p.classList.add('dragging');
      function onMove(ev) {
        applyGeometry(p, ev.clientX - offX, ev.clientY - offY, dialog.offsetWidth || rect.width, dialog.offsetHeight || rect.height);
      }
      function onUp() {
        p.classList.remove('dragging');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        saveGeometry(p);
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      if (e.preventDefault) e.preventDefault();
    });
  }

  function wireResize(p) {
    var handle = p.querySelector('#settings-resize-handle');
    if (!handle) return;
    handle.addEventListener('pointerdown', function (e) {
      if (e.stopPropagation) e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
      var dialog = p.querySelector('.settings-dialog') || p;
      if (typeof dialog.getBoundingClientRect !== 'function') return;
      var rect = dialog.getBoundingClientRect();
      var startX = e.clientX, startY = e.clientY;
      var startW = rect.width, startH = rect.height;
      p.classList.add('resizing');
      function onMove(ev) {
        applyGeometry(p, rect.left, rect.top, startW + (ev.clientX - startX), startH + (ev.clientY - startY));
      }
      function onUp() {
        p.classList.remove('resizing');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        saveGeometry(p);
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  function wireFocusTrap(p) {
    p.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var focusables = p.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (!focusables || !focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || !p.contains(document.activeElement)) {
          if (e.preventDefault) e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          if (e.preventDefault) e.preventDefault();
          first.focus();
        }
      }
    });
  }

  // ── 重置当前分类为默认 ──
  function resetCurrentCategory() {
    var cat = state.category;
    if (cat === 'keybindings') {
      kbResetAll();
      return;
    }
    if (!DEFAULT_SETTINGS[cat]) return;
    var next = Object.assign({}, state.global);
    next[cat] = Object.assign({}, DEFAULT_SETTINGS[cat]);
    send({ command: 'workspace.settings.set-global', data: JSON.stringify(next) });
    if (cat === 'appearance') {
      if (next.appearance.theme) applyTheme(next.appearance.theme);
      if (next.appearance.language && window.I18n) window.I18n.setLanguage(next.appearance.language);
    }
  }

  // ── 左侧分类导航（图标 + 中文标签 + active 项样式）──
  function renderCategories() {
    var p = ensure();
    var n = p.querySelector('#settings-categories');
    if (!n) return;
    n.innerHTML = CATEGORIES.map(function (c) {
      return '<button type="button" data-category="' + c.key + '" class="nav-item ' + (c.key === state.category ? 'active' : '') + '">'
        + (c.icon || '')
        + '<span>' + esc(categoryLabel(c)) + '</span>'
        + '</button>';
    }).join('');
    Array.prototype.forEach.call(n.children, function (b) {
      b.onclick = function () {
        state.category = b.dataset.category;
        if (state.category === 'window') {
          requestCliShimStatus();
        }
        renderCategories();
        render();
      };
    });
    var badge = p.querySelector('#current-category-badge');
    if (badge) badge.textContent = categoryOf(state.category).label;
  }

  // ── 控件渲染：按当前值类型选择控件 ──
  function optionsHTML(keyPath, v) {
    var opts = ENUMS[keyPath].slice();
    var hasCurrent = opts.some(function (o) { return o.value === v; });
    if (!hasCurrent) opts.unshift({ value: v, label: String(v) + '（当前值）' });
    return opts.map(function (o) {
      return '<option value="' + esc(o.value) + '"' + (o.value === v ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('');
  }

  function controlHTML(cat, key, v) {
    var attr = ' data-setting="' + esc(key) + '" data-category="' + esc(cat) + '"';
    var keyPath = cat + '.' + key;
    var m = META[keyPath] || {};
    if (typeof v === 'boolean') {
      return '<label class="settings-switch"><input type="checkbox"' + attr + (v ? ' checked' : '')
        + '><span class="settings-switch-track"><span class="settings-switch-thumb"></span></span></label>';
    }
    if (ENUMS[keyPath]) return '<select class="select-input"' + attr + '>' + optionsHTML(keyPath, v) + '</select>';
    if (typeof v === 'number') {
      var numAttrs = attr;
      if (m.min !== undefined) numAttrs += ' min="' + m.min + '"';
      if (m.max !== undefined) numAttrs += ' max="' + m.max + '"';
      if (m.step !== undefined) numAttrs += ' step="' + m.step + '"';
      return '<input type="number"' + numAttrs + ' value="' + esc(v) + '">';
    }
    if (Array.isArray(v)) return '<input type="text"' + attr + ' value="' + esc(v.join(', ')) + '">';
    if (v !== null && typeof v === 'object') return '<input type="text"' + attr + ' value="' + esc(JSON.stringify(v)) + '">';
    return '<input type="text"' + attr + ' value="' + esc(v) + '">';
  }

  function isOverridden(cat, key) {
    var keyPath = cat + '.' + key;
    if (state.overridden.indexOf(keyPath) >= 0) return true;
    return !!(state.project[cat] && Object.prototype.hasOwnProperty.call(state.project[cat], key));
  }

  function warningsHTML() {
    if (!state.warnings.length) return '';
    return '<div class="settings-warning-banner settings-load-warning">'
      + '<svg class="svg-icon" width="14" height="14" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>'
      + '<span>' + state.warnings.map(esc).join('<br>') + '</span></div>';
  }

  function renderTerminalRow(cat, key, v) {
    var m = metaOf('files', 'terminalPath');
    var overridden = isOverridden('files', 'terminalPath') || isOverridden('files', 'terminalArgs');
    var curPath = (v !== undefined && v !== null) ? String(v) : (valueOf('files', 'terminalPath') || '');
    var curArgs = valueOf('files', 'terminalArgs') || '';
    var termList = state.terminals || [];
    var isScanning = state.terminalsScanning;
    var foundInScanned = termList.some(function(t) { return t.path === curPath; });
    var isCustom = (curPath !== '' && !foundInScanned) || state.customTerminalSelected;
    var isAuto = curPath === '' && !state.customTerminalSelected;

    var optsHTML = '';
    if (isScanning && (!state.terminals || !state.terminals.length)) {
      optsHTML += '<option value="" disabled selected>' + esc(t('settings.terminalScanning')) + '</option>';
    } else {
      optsHTML += '<option value=""' + (isAuto ? ' selected' : '') + '>' + esc(t('settings.terminalAuto')) + '</option>';
      termList.forEach(function(term) {
        var sel = (!state.customTerminalSelected && curPath === term.path) ? ' selected' : '';
        optsHTML += '<option value="' + esc(term.path) + '"' + sel + ' data-subtext="' + esc(term.path) + '">' + esc(term.name) + '</option>';
      });
      if (curPath !== '' && !foundInScanned && !state.customTerminalSelected) {
        optsHTML += '<option value="' + esc(curPath) + '" selected data-subtext="' + esc(curPath) + '">' + esc(curPath) + '（当前值）' + '</option>';
      }
      optsHTML += '<option value="__custom__"' + (state.customTerminalSelected ? ' selected' : '') + '>' + esc(t('settings.terminalCustom')) + '</option>';
    }

    var showCustomInput = isCustom;
    var showArgsInput = !isAuto || state.customTerminalSelected;

    var extraHTML = '';
    if (showCustomInput) {
      extraHTML += '<div class="setting-terminal-field">'
        + '<input type="text" class="setting-terminal-input" id="setting-terminal-custom-path" data-setting="terminalPath" data-category="files" placeholder="' + esc(t('settings.terminalCustomPlaceholder')) + '" value="' + esc(curPath) + '">'
        + '</div>';
    }
    if (showArgsInput) {
      extraHTML += '<div class="setting-terminal-field">'
        + '<span class="setting-terminal-sublabel">' + esc(t('settings.terminalArgs')) + '</span>'
        + '<input type="text" class="setting-terminal-input" id="setting-terminal-args" data-setting="terminalArgs" data-category="files" placeholder="' + esc(t('settings.terminalArgsPlaceholder')) + '" value="' + esc(curArgs) + '">'
        + '</div>';
    }

    return '<div class="setting-row setting-row-terminal">'
      + '<div class="setting-info">'
      + '<span class="setting-label">' + esc(m.label) + (overridden ? '<em class="setting-badge">' + t('settings.projectOverridden') + '</em>' : '') + '</span>'
      + '<span class="setting-desc">' + esc(m.desc) + '</span>'
      + '</div>'
      + '<div class="setting-control setting-control-terminal">'
      + '<div class="setting-terminal-box">'
      + '<select class="select-input" data-setting="terminalPath" data-category="files" id="setting-terminal-select"' + (isScanning ? ' disabled' : '') + '>'
      + optsHTML
      + '</select>'
      + (extraHTML ? '<div class="setting-terminal-extra">' + extraHTML + '</div>' : '')
      + '</div>'
      + '</div>'
      + '</div>';
  }

  function renderCliShimRow() {
    var shim = state.cliShim || { installed: false, dir: '', message: '' };
    var btnText = shim.installed ? t('settings.cliRemove') : t('settings.cliInstall');
    var extraHTML = '';
    if (shim.dir) {
      extraHTML += '<span class="setting-desc">' + esc(t('settings.cliDirectory')) + '：' + esc(shim.dir) + '</span>';
    }
    if (shim.message) {
      extraHTML += '<span class="setting-desc">' + esc(shim.message) + '</span>';
    }

    return '<div class="setting-row setting-row-cli">'
      + '<div class="setting-info">'
      + '<span class="setting-label">' + esc(t('settings.cliTitle')) + '</span>'
      + '<span class="setting-desc">' + esc(t('settings.cliDesc')) + '</span>'
      + extraHTML
      + '</div>'
      + '<div class="setting-control">'
      + '<button type="button" class="btn setting-cli-btn' + (shim.installed ? ' btn-danger' : ' btn-primary') + '" id="setting-cli-shim-btn">'
      + esc(btnText)
      + '</button>'
      + '</div>'
      + '</div>';
  }

  function wireCliButton(container) {
    var scope = container || document;
    var btn = scope.querySelector('#setting-cli-shim-btn') || scope.querySelector('.setting-cli-btn');
    if (!btn) return;
    btn.onclick = function () {
      var isInstalled = state.cliShim && state.cliShim.installed;
      var cmdId = isInstalled ? 'cli.remove-shim' : 'cli.install-shim';
      if (window.Commands && typeof window.Commands.run === 'function' && (!window.Commands.has || window.Commands.has(cmdId))) {
        try {
          window.Commands.run(cmdId);
          return;
        } catch (e) {}
      }
      send({ command: cmdId });
    };
  }

  // ── 网络分类：代理地址输入行（随模式联动禁用）+ 测试连接按钮 ──
  function renderProxyRow(objHttp) {
    var enabled = objHttp.proxySupport === 'override';
    var m = metaOf('http', 'proxy');
    var overridden = isOverridden('http', 'proxy');
    var proxyValue = (objHttp.proxy !== undefined && objHttp.proxy !== null) ? String(objHttp.proxy) : '';
    var isTesting = Boolean(state.proxyTesting);
    var resClass = 'setting-proxy-result';
    var resText = '';
    if (isTesting) {
      resClass += ' setting-proxy-testing';
      resText = t('settings.proxyTesting');
    } else if (state.proxyTestResult) {
      resClass += state.proxyTestResult.ok ? ' setting-proxy-ok' : ' setting-proxy-fail';
      resText = state.proxyTestResult.message || '';
    }
    return '<div class="setting-row setting-row-proxy">'
      + '<div class="setting-info">'
      + '<span class="setting-label">' + esc(m.label) + (overridden ? '<em class="setting-badge">' + t('settings.projectOverridden') + '</em>' : '') + '</span>'
      + '<span class="setting-desc">' + esc(m.desc) + '</span>'
      + '</div>'
      + '<div class="setting-control setting-control-proxy">'
      + '<div class="setting-proxy-box">'
      + '<input type="text" id="setting-proxy-url" data-setting="proxy" data-category="http"' + (enabled ? '' : ' disabled') + ' value="' + esc(proxyValue) + '" placeholder="http://127.0.0.1:7890">'
      + '<button type="button" class="btn setting-proxy-test-btn" id="setting-proxy-test-btn"' + (enabled && !isTesting ? '' : ' disabled') + '>' + esc(t('settings.proxyTest')) + '</button>'
      + '</div>'
      + (enabled ? '' : '<span class="setting-hint setting-proxy-hint">' + esc(t('settings.proxyDisabledHint')) + '</span>')
      + '<div class="' + resClass + '" id="setting-proxy-result">' + esc(resText) + '</div>'
      + '</div>'
      + '</div>';
  }

  function wireProxyTest(container, objHttp) {
    var btn = container.querySelector('#setting-proxy-test-btn');
    if (!btn) return;
    btn.onclick = function () {
      if (state.proxyTesting) return;
      var input = container.querySelector('#setting-proxy-url');
      var proxy = ((input && input.value) || '').trim();
      if (!proxy) {
        state.proxyTesting = false;
        state.proxyTestResult = { ok: false, message: t('settings.proxyTestEmpty') };
        render();
        return;
      }
      var strictSsl = true;
      var sw = container.querySelector('[data-setting="proxyStrictSSL"]');
      if (sw && sw.type === 'checkbox') strictSsl = !!sw.checked;

      state.proxyTesting = true;
      state.proxyTestResult = null;
      if (state.proxyTestTimer) clearTimeout(state.proxyTestTimer);
      state.proxyTestTimer = setTimeout(function () {
        if (state.proxyTesting) {
          state.proxyTesting = false;
          state.proxyTestResult = { ok: false, message: t('settings.proxyTestTimeout') };
          if (state.open) render();
        }
      }, 10000);

      render();
      send({ command: 'net.testProxy', proxy: proxy, strictSsl: strictSsl });
    };
  }

  // ── 设置行：左（中文标签 + 说明 + 项目覆盖徽标）/ 右（控件）──
  function rowHTML(cat, key, v) {
    if (cat === 'files' && key === 'terminalPath') {
      return renderTerminalRow(cat, key, v);
    }
    var m = metaOf(cat, key);
    var overridden = isOverridden(cat, key);
    return '<div class="setting-row">'
      + '<div class="setting-info">'
      + '<span class="setting-label">' + esc(m.label) + (overridden ? '<em class="setting-badge">' + t('settings.projectOverridden') + '</em>' : '') + '</span>'
      + '<span class="setting-desc">' + esc(m.desc) + '</span>'
      + '</div>'
      + '<div class="setting-control">' + controlHTML(cat, key, v) + '</div>'
      + '</div>';
  }

  // ── 生产级自定义 Select 控件 (单例下拉菜单) ──
  var singletonMenu = null;
  var activeCustomTrigger = null;

  function ensureSingletonMenu() {
    if (singletonMenu) return singletonMenu;
    if (typeof document === 'undefined' || !document.createElement) return null;
    singletonMenu = document.createElement('div');
    singletonMenu.id = 'settings-custom-select-menu';
    singletonMenu.className = 'custom-select-menu';
    singletonMenu.setAttribute('role', 'listbox');
    singletonMenu.setAttribute('tabindex', '-1');
    singletonMenu.hidden = true;
    document.body.appendChild(singletonMenu);
    return singletonMenu;
  }

  function closeCustomSelect() {
    if (!singletonMenu) return;
    singletonMenu.hidden = true;
    singletonMenu.classList.remove('open');
    if (activeCustomTrigger) {
      activeCustomTrigger.classList.remove('active');
      activeCustomTrigger.setAttribute('aria-expanded', 'false');
      activeCustomTrigger = null;
    }
  }

  function enhanceSelects(container) {
    if (typeof document === 'undefined' || (!document.createRange && (!document.body || typeof document.body.getBoundingClientRect !== 'function'))) return;
    var selects = container.querySelectorAll('select[data-setting]');
    Array.prototype.forEach.call(selects, function (select) {
      if (select.dataset.customized || !select.parentNode || typeof select.getBoundingClientRect !== 'function' || typeof select.parentNode.insertBefore !== 'function') return;
      select.dataset.customized = '1';
      select.style.display = 'none';

      var wrapper = document.createElement('div');
      wrapper.className = 'custom-select-wrapper';

      var trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'custom-select-trigger';
      trigger.setAttribute('role', 'combobox');
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-controls', 'settings-custom-select-menu');

      var labelSpan = document.createElement('span');
      labelSpan.className = 'custom-select-label';
      var curOpt = select.options[select.selectedIndex] || select.options[0];
      labelSpan.textContent = curOpt ? curOpt.textContent : '';

      var arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      arrowSvg.setAttribute('class', 'custom-select-arrow svg-icon');
      arrowSvg.setAttribute('viewBox', '0 0 24 24');
      arrowSvg.innerHTML = '<polyline points="6 9 12 15 18 9"></polyline>';

      trigger.appendChild(labelSpan);
      trigger.appendChild(arrowSvg);
      wrapper.appendChild(trigger);
      select.parentNode.insertBefore(wrapper, select);

      function updateLabel() {
        var opt = select.options[select.selectedIndex] || select.options[0];
        if (opt) labelSpan.textContent = opt.textContent;
      }

      function openMenu() {
        var menu = ensureSingletonMenu();
        if (!menu) return;
        closeCustomSelect();
        activeCustomTrigger = trigger;
        trigger.classList.add('active');
        trigger.setAttribute('aria-expanded', 'true');

        var opts = Array.prototype.slice.call(select.options);
        var activeIdx = select.selectedIndex >= 0 ? select.selectedIndex : 0;
        menu.innerHTML = opts.map(function (opt, idx) {
          var isSelected = idx === activeIdx;
          var subtext = opt.getAttribute('data-subtext') || (opt.dataset && opt.dataset.subtext);
          var contentHTML = subtext
            ? '<div class="custom-select-opt-content"><span class="custom-select-opt-name">' + esc(opt.textContent) + '</span><span class="custom-select-subtext">' + esc(subtext) + '</span></div>'
            : '<span>' + esc(opt.textContent) + '</span>';
          return '<div class="custom-select-option' + (isSelected ? ' selected hovered' : '') + '" role="option" id="cs-opt-' + idx + '" aria-selected="' + isSelected + '" data-val="' + esc(opt.value) + '" data-idx="' + idx + '">'
            + contentHTML
            + '<svg class="check-icon svg-icon" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>'
            + '</div>';
        }).join('');

        // Viewport positioning with flip support
        var rect = trigger.getBoundingClientRect();
        var vpW = (typeof window !== 'undefined' && window.innerWidth) || 1024;
        var vpH = (typeof window !== 'undefined' && window.innerHeight) || 768;
        var menuW = Math.max(rect.width, 160);
        var left = Math.max(10, Math.min(rect.left, vpW - menuW - 10));
        menu.style.minWidth = menuW + 'px';
        menu.style.left = left + 'px';
        var spaceBelow = vpH - rect.bottom;
        var spaceAbove = rect.top;
        if (spaceBelow < 200 && spaceAbove > spaceBelow) {
          menu.style.top = 'auto';
          menu.style.bottom = (vpH - rect.top + 4) + 'px';
        } else {
          menu.style.bottom = 'auto';
          menu.style.top = (rect.bottom + 4) + 'px';
        }

        menu.hidden = false;
        menu.classList.add('open');

        var optionEls = menu.querySelectorAll('.custom-select-option');
        function setHovered(idx) {
          activeIdx = idx;
          Array.prototype.forEach.call(optionEls, function (el, i) {
            if (i === idx) {
              el.classList.add('hovered');
              if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
              trigger.setAttribute('aria-activedescendant', el.id);
            } else {
              el.classList.remove('hovered');
            }
          });
        }

        Array.prototype.forEach.call(optionEls, function (el) {
          el.onclick = function (e) {
            if (e.stopPropagation) e.stopPropagation();
            var val = el.dataset.val;
            select.value = val;
            updateLabel();
            closeCustomSelect();
            trigger.focus();
            if (select.onchange) select.onchange();
          };
          el.onmouseenter = function () {
            setHovered(parseInt(el.dataset.idx, 10));
          };
        });
      }

      trigger.onclick = function (e) {
        if (e.stopPropagation) e.stopPropagation();
        if (trigger.classList.contains('active')) {
          closeCustomSelect();
        } else {
          openMenu();
        }
      };

      trigger.onkeydown = function (e) {
        var menu = singletonMenu;
        var isOpen = menu && !menu.hidden && activeCustomTrigger === trigger;
        var opts = Array.prototype.slice.call(select.options);
        if (!isOpen) {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (e.preventDefault) e.preventDefault();
            openMenu();
          }
          return;
        }
        var curIdx = select.selectedIndex >= 0 ? select.selectedIndex : 0;
        var hoveredEl = menu.querySelector('.custom-select-option.hovered');
        if (hoveredEl) curIdx = parseInt(hoveredEl.dataset.idx, 10);

        if (e.key === 'ArrowDown') {
          if (e.preventDefault) e.preventDefault();
          curIdx = (curIdx + 1) % opts.length;
          setHighlight(curIdx);
        } else if (e.key === 'ArrowUp') {
          if (e.preventDefault) e.preventDefault();
          curIdx = (curIdx - 1 + opts.length) % opts.length;
          setHighlight(curIdx);
        } else if (e.key === 'Home') {
          if (e.preventDefault) e.preventDefault();
          setHighlight(0);
        } else if (e.key === 'End') {
          if (e.preventDefault) e.preventDefault();
          setHighlight(opts.length - 1);
        } else if (e.key === 'Enter' || e.key === ' ') {
          if (e.preventDefault) e.preventDefault();
          if (opts[curIdx]) {
            select.value = opts[curIdx].value;
            updateLabel();
            closeCustomSelect();
            trigger.focus();
            if (select.onchange) select.onchange();
          }
        } else if (e.key === 'Escape') {
          if (e.preventDefault) e.preventDefault();
          closeCustomSelect();
          trigger.focus();
        }

        function setHighlight(idx) {
          var items = menu.querySelectorAll('.custom-select-option');
          Array.prototype.forEach.call(items, function (item, i) {
            if (i === idx) {
              item.classList.add('hovered');
              if (item.scrollIntoView) item.scrollIntoView({ block: 'nearest' });
              trigger.setAttribute('aria-activedescendant', item.id);
            } else {
              item.classList.remove('hovered');
            }
          });
        }
      };
    });
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', function (e) {
      if (singletonMenu && !singletonMenu.hidden) {
        if (!singletonMenu.contains(e.target) && (!activeCustomTrigger || !activeCustomTrigger.contains(e.target))) {
          closeCustomSelect();
        }
      }
    });
  }

  // ── 主体渲染：无查询 = 当前分类视图；有查询 = 跨七类全局聚合 ──
  function render() {
    closeCustomSelect();
    var p = ensure();
    var filter = p.querySelector('#settings-filter');
    var q = ((filter && filter.value) || '').trim().toLowerCase();
    var badge = p.querySelector('#current-category-badge');
    if (badge) badge.textContent = categoryOf(state.category).label;

    if (!q) return renderCategory(state.category);

    var html = warningsHTML() + '<h2>搜索：“' + esc(q) + '”</h2>';
    var total = 0;
    CATEGORIES.forEach(function (c) {
      if (c.key === 'keybindings') return;
      var obj = Object.assign({}, DEFAULT_SETTINGS[c.key] || {}, state.effective[c.key] || {});
      var hits = Object.keys(obj).filter(function (k) {
        if (c.key === 'files' && k === 'terminalArgs') return false;
        if (c.key === 'files' && k === 'terminalPath') {
          var mPath = metaOf(c.key, 'terminalPath');
          var mArgs = metaOf(c.key, 'terminalArgs');
          return (k + ' terminalArgs ' + mPath.label + ' ' + mPath.desc + ' ' + mArgs.label + ' ' + mArgs.desc).toLowerCase().indexOf(q) >= 0;
        }
        var m = metaOf(c.key, k);
        return (k + ' ' + m.label + ' ' + m.desc).toLowerCase().indexOf(q) >= 0;
      });
      var cliHits = c.key === 'window' && ('cli gmdu 命令行 shim ' + t('settings.cliTitle') + ' ' + t('settings.cliDesc')).toLowerCase().indexOf(q) >= 0;
      if (!hits.length && !cliHits) return;
      var groupCount = hits.length + (cliHits ? 1 : 0);
      total += groupCount;
      html += '<div class="settings-search-group">'
        + '<button type="button" class="settings-search-cat" data-goto="' + esc(c.key) + '">'
        + esc(categoryLabel(c)) + '<span>' + groupCount + '</span></button>';
      hits.forEach(function (k) { html += rowHTML(c.key, k, obj[k]); });
      if (cliHits) {
        html += renderCliShimRow();
      }
      html += '</div>';
    });
    if (!total) html += '<p class="settings-empty">' + t('settings.noMatch') + '</p>';

    var body = p.querySelector('#settings-body');
    if (!body) return;
    body.innerHTML = html;
    Array.prototype.forEach.call(p.querySelectorAll('[data-setting]'), wire);
    wireCliButton(body);
    Array.prototype.forEach.call(p.querySelectorAll('[data-goto]'), function (b) {
      b.onclick = function () {
        state.category = b.dataset.goto;
        if (state.category === 'window') {
          requestCliShimStatus();
        }
        renderCategories();
        renderCategory(state.category);
      };
    });
    enhanceSelects(body);
  }

  // ── 分类视图：分类标题 + 描述 + 覆盖横幅 + 过滤后的设置行 ──
  function renderCategory(catKey) {
    closeCustomSelect();
    var p = ensure();
    var filter = p.querySelector('#settings-filter');
    var q = ((filter && filter.value) || '').trim().toLowerCase();
    var cat = categoryOf(catKey);
    var html = warningsHTML() + '<h2>' + esc(categoryLabel(cat)) + '</h2>'
      + '<p class="settings-category-desc">' + esc(categoryDesc(cat)) + '</p>';

    // 项目覆盖提示横幅
    var hasProjectOverride = state.project[catKey] && Object.keys(state.project[catKey]).length > 0;
    if (hasProjectOverride) {
      html += '<div class="settings-warning-banner">'
        + '<svg class="svg-icon" width="14" height="14" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>'
        + '<span>此分类下有设置项已被当前项目配置 (.glancemd/settings.json) 覆盖</span>'
        + '</div>';
    }

    var body = p.querySelector('#settings-body');
    if (!body) return;
    if (catKey === 'keybindings') { renderKbList(body, html, q); return; }
    if (catKey === 'window') {
      var obj = Object.assign({}, DEFAULT_SETTINGS.window || {}, state.effective.window || {});
      var keys = Object.keys(obj).filter(function (k) {
        if (!q) return true;
        var m = metaOf('window', k);
        return (k + ' ' + m.label + ' ' + m.desc).toLowerCase().indexOf(q) >= 0;
      });
      var cliMatches = !q || ('cli gmdu 命令行 shim ' + t('settings.cliTitle') + ' ' + t('settings.cliDesc')).toLowerCase().indexOf(q) >= 0;
      if (!keys.length && !cliMatches) {
        html += '<p class="settings-empty">' + (q ? t('settings.noMatch') : t('settings.categoryEmpty')) + '</p>';
      } else {
        keys.forEach(function (k) { html += rowHTML('window', k, obj[k]); });
        if (cliMatches) {
          html += renderCliShimRow();
        }
      }
      body.innerHTML = html;
      Array.prototype.forEach.call(p.querySelectorAll('[data-setting]'), wire);
      wireCliButton(body);
      enhanceSelects(body);
      return;
    }
    if (catKey === 'http') {
      // 网络分类专用渲染：proxy 输入框随模式联动禁用，附测试连接按钮
      var objHttp = Object.assign({}, DEFAULT_SETTINGS.http || {}, state.effective.http || {});
      var keysHttp = ['proxySupport', 'proxyStrictSSL'].filter(function (k) {
        if (!q) return true;
        var m = metaOf('http', k);
        return (k + ' ' + m.label + ' ' + m.desc).toLowerCase().indexOf(q) >= 0;
      });
      var proxyVisible = !q || ('proxy ' + metaOf('http', 'proxy').label + ' ' + metaOf('http', 'proxy').desc + ' 测试连接').toLowerCase().indexOf(q) >= 0;
      if (!keysHttp.length && !proxyVisible) {
        html += '<p class="settings-empty">' + (q ? t('settings.noMatch') : t('settings.categoryEmpty')) + '</p>';
      } else {
        keysHttp.forEach(function (k) { html += rowHTML('http', k, objHttp[k]); });
        if (proxyVisible) html += renderProxyRow(objHttp);
        html += '<p class="settings-note">' + esc(t('settings.proxyRestartHint')) + '</p>';
      }
      body.innerHTML = html;
      Array.prototype.forEach.call(p.querySelectorAll('[data-setting]'), wire);
      enhanceSelects(body);
      wireProxyTest(body, objHttp);
      return;
    }
    var obj = Object.assign({}, DEFAULT_SETTINGS[catKey] || {}, state.effective[catKey] || {});
    var keys = Object.keys(obj).filter(function (k) {
      if (catKey === 'files' && k === 'terminalArgs') return false;
      if (!q) return true;
      if (catKey === 'files' && k === 'terminalPath') {
        var mPath = metaOf(catKey, 'terminalPath');
        var mArgs = metaOf(catKey, 'terminalArgs');
        return (k + ' terminalArgs ' + mPath.label + ' ' + mPath.desc + ' ' + mArgs.label + ' ' + mArgs.desc).toLowerCase().indexOf(q) >= 0;
      }
      var m = metaOf(catKey, k);
      return (k + ' ' + m.label + ' ' + m.desc).toLowerCase().indexOf(q) >= 0;
    });
    if (!keys.length) {
      html += '<p class="settings-empty">' + (q ? t('settings.noMatch') : t('settings.categoryEmpty')) + '</p>';
    } else {
      keys.forEach(function (k) { html += rowHTML(catKey, k, obj[k]); });
    }
    body.innerHTML = html;
    Array.prototype.forEach.call(p.querySelectorAll('[data-setting]'), wire);
    enhanceSelects(body);
  }

  // ── 快捷键专用列表 ──
  function kbLabel(id) {
    var c = window.Commands && typeof window.Commands.get === 'function' ? window.Commands.get(id) : null;
    return c ? categoryLabel(c) : id;
  }

  function kbOverrides() {
    var kb = window.Keybindings;
    if (kb && typeof kb.overrides === 'function') {
      var m = kb.overrides();
      return m && typeof m === 'object' ? m : {};
    }
    return {};
  }

  function renderKbList(body, headerHTML, q) {
    if (window.KeybindingsSettings && typeof window.KeybindingsSettings.mount === 'function') {
      body.innerHTML = headerHTML + '<div id="settings-keybindings-mount"></div>';
      var mountPoint = body.querySelector('#settings-keybindings-mount');
      if (mountPoint) {
        window.KeybindingsSettings.mount(mountPoint, { query: q });
        return;
      }
    }
    var kb = window.Keybindings;
    if (!kb || typeof kb.effective !== 'function') {
      body.innerHTML = headerHTML + '<p class="settings-empty">快捷键模块未加载</p>';
      return;
    }
    var match = function (s) { return !q || String(s).toLowerCase().indexOf(q) >= 0; };
    var eff = kb.effective();
    var ovr = kbOverrides();
    var rows = '';
    var keys = Object.keys(eff);
    if (!keys.length && kb.defaults) keys = Object.keys(kb.defaults);
    keys.forEach(function (id) {
      var label = kbLabel(id);
      if (!match(label) && !match(id) && !match(eff[id] || '')) return;
      var recording = state.kbRecording === id;
      rows += '<div class="settings-kb-row"' + (recording ? ' data-kb-recording="1"' : '') + '>'
        + '<div class="settings-kb-info"><span class="settings-kb-label">' + esc(label) + '</span></div>'
        + '<div class="settings-kb-control">';
      if (recording) {
        rows += '<span class="settings-kb-recording">按下组合键…</span>'
          + '<span class="settings-kb-hint">Esc 取消 · Backspace 恢复默认</span>';
      } else {
        rows += '<kbd class="settings-kb-key">' + esc(eff[id] || '') + '</kbd>'
          + '<button type="button" class="settings-kb-btn" data-kb-edit="' + esc(id) + '">修改</button>'
          + (Object.prototype.hasOwnProperty.call(ovr, id)
            ? '<button type="button" class="settings-kb-btn" data-kb-reset="' + esc(id) + '">恢复默认</button>'
            : '');
      }
      if (state.kbError && state.kbError.id === id) {
        rows += '<span class="settings-kb-error">' + esc(state.kbError.message) + '</span>';
      }
      rows += '</div></div>';
    });
    if (window.Commands && typeof window.Commands.ids === 'function') {
      window.Commands.ids().forEach(function (cid) {
        if (Object.prototype.hasOwnProperty.call(eff, cid)) return;
        var label = kbLabel(cid);
        if (!match(label) && !match(cid)) return;
        rows += '<div class="settings-kb-row settings-kb-unbound">'
          + '<div class="settings-kb-info"><span class="settings-kb-label">' + esc(label) + '</span></div>'
          + '<div class="settings-kb-control"><span class="settings-kb-badge">未设快捷键</span></div>'
          + '</div>';
      });
    }
    var html = headerHTML
      + '<div class="settings-kb-toolbar"><button type="button" class="settings-kb-btn" data-kb-reset-all="1">全部恢复默认</button></div>'
      + rows;
    if (!rows) html += '<p class="settings-empty">' + (q ? t('settings.noMatch') : t('settings.categoryEmpty')) + '</p>';
    body.innerHTML = html;
    Array.prototype.forEach.call(body.querySelectorAll('[data-kb-edit]'), function (b) {
      b.onclick = function () { startKbRecording(b.dataset.kbEdit); };
    });
    Array.prototype.forEach.call(body.querySelectorAll('[data-kb-reset]'), function (b) {
      b.onclick = function () { kbResetOne(b.dataset.kbReset); };
    });
    var resetAll = body.querySelector('[data-kb-reset-all]');
    if (resetAll) resetAll.onclick = kbResetAll;
  }

  // 录制：document 级一次性 keydown
  function startKbRecording(id) {
    cancelKbRecording();
    state.kbError = null;
    state.kbRecording = id;
    document.addEventListener('keydown', onKbRecordKeydown, true);
    render();
  }

  function cancelKbRecording() {
    if (state.kbRecording == null) return;
    state.kbRecording = null;
    document.removeEventListener('keydown', onKbRecordKeydown);
  }

  function onKbRecordKeydown(e) {
    var id = state.kbRecording;
    if (id == null || !e) return;
    var swallow = function () {
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
    };
    if (e.key === 'Escape') { swallow(); cancelKbRecording(); render(); return; }
    if (e.key === 'Backspace') { swallow(); cancelKbRecording(); kbResetOne(id); return; }
    if (/^(Control|Shift|Alt|Meta)$/.test(e.key)) return;
    var kb = window.Keybindings;
    if (!kb || typeof kb.normalize !== 'function' || typeof kb.save !== 'function') { cancelKbRecording(); return; }
    swallow();
    var map = kbOverrides();
    map[id] = kb.normalize(e);
    try {
      kb.save(map);
      state.kbError = null;
    } catch (err) {
      state.kbError = { id: id, message: err && err.message ? err.message : String(err) };
    }
    cancelKbRecording();
    render();
  }

  function kbResetOne(id) {
    var kb = window.Keybindings;
    if (!kb || typeof kb.save !== 'function') return;
    var map = kbOverrides();
    delete map[id];
    try { kb.save(map); } catch (err) { return; }
    if (state.kbError && state.kbError.id === id) state.kbError = null;
    render();
  }

  function kbResetAll() {
    var kb = window.Keybindings;
    if (!kb || typeof kb.clear !== 'function') return;
    kb.clear();
    state.kbError = null;
    cancelKbRecording();
    render();
  }

  // 从控件读回值
  function readControl(i, cur) {
    if (typeof cur === 'boolean') return i.checked;
    if (typeof cur === 'number') {
      if (String(i.value).trim() === '') return undefined;
      var n = Number(i.value);
      return isFinite(n) ? n : undefined;
    }
    if (Array.isArray(cur)) {
      return i.value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
    }
    if (cur !== null && typeof cur === 'object') {
      try { return JSON.parse(i.value); } catch (e) { return undefined; }
    }
    return i.value;
  }

  // 提交：合并类内数据，保持完整 settings 结构
  function commit(cat, key, v) {
    var patch = {};
    patch[cat] = {};
    patch[cat][key] = v;
    var next = Object.assign({}, state.global);
    next[cat] = Object.assign({}, state.global[cat], patch[cat]);
    send({ command: 'workspace.settings.set-global', data: JSON.stringify(next) });
  }

  // appearance.theme：即时预览由统一设置生效层解析，持久化仍由 Rust settings 完成。
  function applyTheme(v) {
    if (window.SettingsApply && typeof window.SettingsApply.applyTheme === 'function') {
      window.SettingsApply.applyTheme(v);
      return;
    }
    document.documentElement.dataset.theme = v === 'light' ? 'light' : 'dark';
  }

  // 修复跨分类搜索 data-category 关联
  function wire(i) {
    var cat = i.dataset.category || state.category, key = i.dataset.setting;
    if (i.id === 'setting-terminal-select') {
      i.onchange = function () {
        var val = i.value;
        if (val === '__custom__') {
          state.customTerminalSelected = true;
          render();
          var p = ensure();
          var customInput = p.querySelector('#setting-terminal-custom-path');
          if (customInput && typeof customInput.focus === 'function') customInput.focus();
        } else if (val === '') {
          state.customTerminalSelected = false;
          commit('files', 'terminalPath', '');
          commit('files', 'terminalArgs', '');
          render();
        } else {
          state.customTerminalSelected = false;
          commit('files', 'terminalPath', val);
          var matchedTerm = (state.terminals || []).find(function (t) { return t.path === val; });
          if (matchedTerm && Array.isArray(matchedTerm.args)) {
            commit('files', 'terminalArgs', matchedTerm.args.join(' '));
          }
          render();
        }
      };
      return;
    }
    i.onchange = function () {
      var v = readControl(i, valueOf(cat, key));
      if (v === undefined) return;
      commit(cat, key, v);
      if (cat === 'appearance' && key === 'theme') applyTheme(v);
      if (cat === 'appearance' && key === 'language' && window.I18n) window.I18n.setLanguage(v);
    };
  }

  // ── 打开 / 关闭 / 刷新 ──
  function sendReads() {
    send({ command: 'workspace.settings.get-effective' });
    send({ command: 'workspace.settings.get-global' });
    send({ command: 'workspace.settings.load-project' });
  }

  function sendScanTerminal() {
    state.terminalsScanning = true;
    send({ command: 'workspace.terminal.scan' });
  }

  function requestCliShimStatus() {
    if (window.Commands && typeof window.Commands.run === 'function' && (!window.Commands.has || window.Commands.has('cli.shim-status'))) {
      try {
        window.Commands.run('cli.shim-status');
        return;
      } catch (e) {}
    }
    send({ command: 'cli.shim-status' });
  }

  function open() {
    state.open = true;
    if (window.contextKeys) { window.contextKeys.set('settingsFocus', true); window.contextKeys.set('dialogOpen', true); }
    if (typeof document !== 'undefined' && document.activeElement) {
      lastFocusedEl = document.activeElement;
    }
    var p = ensure();
    p.hidden = false;
    restoreGeometry(p);
    sendReads();
    if (!state.terminalsScanned) {
      sendScanTerminal();
    }
    requestCliShimStatus();
    var filter = p.querySelector('#settings-filter');
    if (filter && typeof filter.focus === 'function') {
      filter.focus();
    }
  }

  function close() {
    state.open = false;
    if (window.contextKeys) { window.contextKeys.remove('settingsFocus'); window.contextKeys.remove('dialogOpen'); }
    cancelKbRecording();
    closeCustomSelect();
    var p = document.getElementById('settings-panel');
    if (p) p.hidden = true;
    if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') {
      try { lastFocusedEl.focus(); } catch (e) {}
      lastFocusedEl = null;
    }
  }

  function refresh() { if (state.open) sendReads(); }

  function receive(e, d) {
    if (e === 'workspace:settings-effective') {
      state.effective = (d && d.settings) || {};
      state.overridden = (d && d.overridden) || [];
      state.warnings = (d && d.warnings) || [];
      render();
    }
    else if (e === 'workspace:settings-global') {
      state.global = (d && d.settings) || {};
      if (!Object.keys(state.effective).length) state.effective = state.global;
      if (d && d.warnings && d.warnings.length) state.warnings = d.warnings;
      render();
    }
    else if (e === 'workspace:settings-project') {
      state.project = (d && d.patch) || {};
      if (d && d.warnings && d.warnings.length) state.warnings = d.warnings;
      render();
    }
    else if (e === 'workspace:settings-changed') { refresh(); }
    else if (e === 'workspace:terminal-list') {
      state.terminals = (d && d.terminals) || [];
      state.terminalsScanning = false;
      state.terminalsScanned = true;
      if (state.open) {
        render();
      }
    }
    else if (e === 'workspace:cli-shim-status') {
      state.cliShim = {
        installed: !!(d && d.installed),
        dir: (d && d.dir) || '',
        message: (d && d.message) || ''
      };
      if (state.open) {
        render();
      }
    }
    else if (e === 'workspace:proxy-test-result' || e === 'net:test-proxy-result') {
      if (state.proxyTestTimer) {
        clearTimeout(state.proxyTestTimer);
        state.proxyTestTimer = null;
      }
      state.proxyTesting = false;
      state.proxyTestResult = d;
      if (state.open) {
        render();
      }
    }
  }

  if (window.Workspace && Workspace.on) {
    Workspace.on('workspace:settings-effective', function (d) { receive('workspace:settings-effective', d); });
    Workspace.on('workspace:settings-global', function (d) { receive('workspace:settings-global', d); });
    Workspace.on('workspace:settings-project', function (d) { receive('workspace:settings-project', d); });
    Workspace.on('workspace:settings-changed', function (d) { receive('workspace:settings-changed', d); });
    Workspace.on('workspace:terminal-list', function (d) { receive('workspace:terminal-list', d); });
    Workspace.on('workspace:cli-shim-status', function (d) { receive('workspace:cli-shim-status', d); });
    Workspace.on('workspace:proxy-test-result', function (d) { receive('workspace:proxy-test-result', d); });
    Workspace.on('net:test-proxy-result', function (d) { receive('net:test-proxy-result', d); });
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('i18n-changed', function () {
      if (state.open) {
        renderCategories();
        render();
      }
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.open) close();
  });

  window.SettingsUI = {
    open: open,
    close: close,
    toggle: function () { state.open ? close() : open(); },
    refresh: refresh,
    setCategory: function (category) {
      if (CATEGORIES.some(function (item) { return item.key === category; })) {
        state.category = category;
        if (state.open) {
          renderCategories();
          render();
        }
      }
    },
    receive: receive,
    getState: function () { return state; }
  };
})();
