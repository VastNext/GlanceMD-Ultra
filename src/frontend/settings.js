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
//   localStorage['glancemd-ultra-theme']。
//
// 渲染层是元数据驱动的：七类分类（中文标签 + 一句描述）与每个键的中文
// 标签/说明集中在下方 CATEGORIES / META / ENUMS 表；控件按当前值类型选择
// （bool→switch、number→数字输入、枚举→下拉、数组→逗号分隔文本、
// 对象→JSON 文本、其余→文本输入）。
(function () {
  'use strict';

  var state = { open: false, category: 'appearance', global: {}, effective: {}, project: {} };

  // 七类分类（与 Rust settings schema 一一对应）：中文标签 + 每类一句描述。
  var CATEGORIES = [
    { key: 'appearance', label: '外观', desc: '主题与界面配色' },
    { key: 'files', label: '文件', desc: '可见类型、隐藏文件与排除规则' },
    { key: 'watching', label: '监听', desc: '文件监听与自动保存行为' },
    { key: 'search', label: '搜索', desc: '搜索范围与结果数量上限' },
    { key: 'editor', label: '编辑器', desc: '字号、缩进、换行与大文件阈值' },
    { key: 'keybindings', label: '快捷键', desc: '命令快捷键的覆盖表' },
    { key: 'recovery', label: '恢复', desc: '未保存确认与崩溃恢复' }
  ];

  // 设置键元数据：key_path（类名.JSON 字段名，与序列化键一致）→ 中文标签 + 说明。
  var META = {
    'appearance.theme': { label: '主题', desc: '界面配色：深色、浅色或跟随系统' },
    'appearance.sidebarFontSize': { label: '侧栏字体大小（px）', desc: '资源管理器与大纲面板的基准字号（12–18）' },
    'files.visibleExts': { label: '可见扩展名', desc: '项目树中显示的文件类型，逗号分隔' },
    'files.showHidden': { label: '显示隐藏文件', desc: '在项目树中显示点开头的隐藏文件' },
    'files.exclude': { label: '浏览排除', desc: '项目树不展示的目录或路径段，逗号分隔' },
    'files.watcherExclude': { label: '监听排除', desc: '文件监听忽略的目录或路径段，逗号分隔' },
    'watching.enableWatcher': { label: '启用文件监听', desc: '监听文件变更；修改此设置后自动暂停或恢复监听' },
    'watching.autoSave': { label: '自动保存', desc: '关闭、延时后自动保存，或失去焦点时保存' },
    'watching.autoSaveDelayMs': { label: '自动保存延时（毫秒）', desc: '“延时后自动保存”模式的触发延时' },
    'search.exclude': { label: '搜索排除', desc: '全文搜索跳过的目录或 glob，逗号分隔' },
    'search.maxFileSizeMB': { label: '文件大小上限（MB）', desc: '超过该大小的文件不参与搜索' },
    'search.maxResults': { label: '结果数上限', desc: '单次搜索最多返回的结果数' },
    'editor.fontSize': { label: '字号（px）', desc: '编辑区字体大小' },
    'editor.tabSize': { label: 'Tab 宽度', desc: '一个 Tab 对应的空格数' },
    'editor.wordWrap': { label: '自动换行', desc: '超出编辑区宽度时自动折行' },
    'editor.lineNumbers': { label: '显示行号', desc: '编辑区左侧显示行号' },
    'editor.largeFileMB': { label: '大文件阈值（MB）', desc: '超过该大小进入大文件模式' },
    'keybindings.overrides': { label: '快捷键覆盖', desc: '命令 ID 到组合键的映射（JSON 对象）' },
    'recovery.confirmCloseDirty': { label: '关闭未保存确认', desc: '关闭有未保存修改的标签时弹出确认' },
    'recovery.crashRecovery': { label: '崩溃恢复', desc: '定期把编辑内容写入恢复区' },
    'recovery.createProjectSettings': { label: '自动创建项目设置', desc: '打开工作区时自动创建 .glancemd/settings.json' }
  };

  // 枚举键：取值清单（渲染 <select>；当前值不在清单内时补一项兜底）。
  var ENUMS = {
    'appearance.theme': [
      { value: 'dark', label: '深色' },
      { value: 'light', label: '浅色' },
      { value: 'system', label: '跟随系统' }
    ],
    'watching.autoSave': [
      { value: 'off', label: '关闭' },
      { value: 'afterDelay', label: '延时后保存' },
      { value: 'onFocusLost', label: '失焦时保存' }
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
    return { key: key, label: key, desc: '' };
  }

  function metaOf(cat, key) {
    return META[cat + '.' + key] || { label: key, desc: '' };
  }

  // 渲染与回写共用的取值来源：优先 effective（与显示一致），缺键回退 global。
  function valueOf(cat, key) {
    var obj = state.effective[cat] || {};
    if (key in obj) return obj[key];
    return (state.global[cat] || {})[key];
  }

  // ── 面板骨架 ──
  function ensure() {
    var p = document.getElementById('settings-panel'); if (p) return p;
    p = document.createElement('section'); p.id = 'settings-panel'; p.className = 'settings-panel'; p.hidden = true;
    p.innerHTML = '<header><strong>设置</strong><input id="settings-filter" placeholder="搜索设置（支持中文标签或键名）"><button id="settings-close" title="关闭（Esc）">×</button></header>'
      + '<div class="settings-layout"><nav id="settings-categories"></nav><main id="settings-body"></main></div>'
      + '<footer><button id="settings-json">打开设置 JSON</button></footer>';
    document.body.appendChild(p);
    p.querySelector('#settings-close').onclick = close;
    p.querySelector('#settings-json').onclick = function () { send({ command: 'workspace.settings.open-settings-json' }); };
    p.querySelector('#settings-filter').oninput = render;
    renderCategories(); render(); return p;
  }

  // ── 左侧分类导航（中文标签；active 项样式见 settings.css）──
  function renderCategories() {
    var n = ensure().querySelector('#settings-categories');
    if (!n) return;
    n.innerHTML = CATEGORIES.map(function (c) {
      return '<button type="button" data-category="' + c.key + '" class="' + (c.key === state.category ? 'active' : '') + '">' + esc(c.label) + '</button>';
    }).join('');
    Array.prototype.forEach.call(n.children, function (b) {
      b.onclick = function () {
        state.category = b.dataset.category;
        renderCategories();
        render();
      };
    });
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
    var attr = ' data-setting="' + esc(key) + '"';
    var keyPath = cat + '.' + key;
    if (typeof v === 'boolean') {
      // switch：label 包裹 checkbox + 轨道/滑块（纯视觉，语义仍是 checkbox）
      return '<label class="settings-switch"><input type="checkbox"' + attr + (v ? ' checked' : '')
        + '><span class="settings-switch-track"><span class="settings-switch-thumb"></span></span></label>';
    }
    if (ENUMS[keyPath]) return '<select' + attr + '>' + optionsHTML(keyPath, v) + '</select>';
    if (typeof v === 'number') return '<input type="number"' + attr + ' value="' + esc(v) + '">';
    if (Array.isArray(v)) return '<input type="text"' + attr + ' value="' + esc(v.join(', ')) + '">';
    if (v !== null && typeof v === 'object') return '<input type="text"' + attr + ' value="' + esc(JSON.stringify(v)) + '">';
    return '<input type="text"' + attr + ' value="' + esc(v) + '">';
  }

  // ── 设置行：左（中文标签 + 说明 + 项目覆盖徽标）/ 右（控件）──
  function rowHTML(cat, key, v) {
    var m = metaOf(cat, key);
    var overridden = !!(state.project[cat] && Object.prototype.hasOwnProperty.call(state.project[cat], key));
    return '<div class="setting-row">'
      + '<div class="setting-info">'
      + '<span class="setting-label">' + esc(m.label) + (overridden ? '<em class="setting-badge">项目已覆盖</em>' : '') + '</span>'
      + '<span class="setting-desc">' + esc(m.desc) + '</span>'
      + '</div>'
      + '<div class="setting-control">' + controlHTML(cat, key, v) + '</div>'
      + '</div>';
  }

  // ── 主体渲染：分类标题 + 描述 + 过滤后的设置行 ──
  function render() {
    var p = ensure();
    var filter = p.querySelector('#settings-filter');
    var q = ((filter && filter.value) || '').trim().toLowerCase();
    var cat = categoryOf(state.category);
    var obj = state.effective[state.category] || {};
    var keys = Object.keys(obj).filter(function (k) {
      if (!q) return true;
      var m = metaOf(state.category, k);
      return (k + ' ' + m.label + ' ' + m.desc).toLowerCase().indexOf(q) >= 0;
    });
    var html = '<h2>' + esc(cat.label) + '</h2>'
      + '<p class="settings-category-desc">' + esc(cat.desc) + '</p>';
    if (!keys.length) {
      html += '<p class="settings-empty">' + (q ? '没有匹配的设置' : '该分类暂无可配置项') + '</p>';
    } else {
      keys.forEach(function (k) { html += rowHTML(state.category, k, obj[k]); });
    }
    var body = p.querySelector('#settings-body');
    if (!body) return;
    body.innerHTML = html;
    Array.prototype.forEach.call(p.querySelectorAll('[data-setting]'), wire);
  }

  // 从控件读回值：按渲染时的原始值类型转换；非法输入返回 undefined（不提交）。
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

  // 提交：在既有 Object.assign 模式上做类内合并——只替换被改的键，同类其余键
  // 与其它类原样保留（Rust 端 serde 类级有 default，发残缺对象会把兄弟键
  // 重置为默认值）。信封保持现状：data 为合并后完整 Settings 的 JSON 字符串。
  function commit(cat, key, v) {
    var patch = {};
    patch[cat] = {};
    patch[cat][key] = v;
    var next = Object.assign({}, state.global);
    next[cat] = Object.assign({}, state.global[cat], patch[cat]);
    send({ command: 'workspace.settings.set-global', data: JSON.stringify(next) });
  }

  // appearance.theme：即时切换主题并持久化（与 app.js 的 localStorage 键一致）。
  function applyTheme(v) {
    document.documentElement.dataset.theme = v;
    try { localStorage.setItem('glancemd-ultra-theme', v); } catch (e) { /* 无存储环境忽略 */ }
  }

  function wire(i) {
    var cat = state.category, key = i.dataset.setting;
    i.onchange = function () {
      var v = readControl(i, valueOf(cat, key));
      if (v === undefined) return;
      commit(cat, key, v);
      if (cat === 'appearance' && key === 'theme') applyTheme(v);
    };
  }

  // ── 打开 / 关闭 / 刷新 ──
  function sendReads() {
    send({ command: 'workspace.settings.get-effective' });
    send({ command: 'workspace.settings.get-global' });
    send({ command: 'workspace.settings.load-project' });
  }

  function open() { state.open = true; ensure().hidden = false; sendReads(); }

  function close() { state.open = false; var p = document.getElementById('settings-panel'); if (p) p.hidden = true; }

  // settings-changed 回执：面板开着就重新拉取（自己改的会收到回执；其他来源
  // ——另一窗口、手动编辑 settings.json——造成的改动同样刷新）。
  function refresh() { if (state.open) sendReads(); }

  function receive(e, d) {
    if (e === 'workspace:settings-effective') { state.effective = (d && d.settings) || {}; render(); }
    else if (e === 'workspace:settings-global') {
      state.global = (d && d.settings) || {};
      if (!Object.keys(state.effective).length) state.effective = state.global;
      render();
    }
    else if (e === 'workspace:settings-project') { state.project = (d && d.patch) || {}; render(); }
    else if (e === 'workspace:settings-changed') { refresh(); }
  }

  if (window.Workspace && Workspace.on) {
    Workspace.on('workspace:settings-effective', function (d) { receive('workspace:settings-effective', d); });
    Workspace.on('workspace:settings-global', function (d) { receive('workspace:settings-global', d); });
    Workspace.on('workspace:settings-project', function (d) { receive('workspace:settings-project', d); });
    Workspace.on('workspace:settings-changed', function (d) { receive('workspace:settings-changed', d); });
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.open) close(); });
  window.SettingsUI = { open: open, close: close, toggle: function () { state.open ? close() : open(); }, receive: receive, getState: function () { return state; } };
})();
