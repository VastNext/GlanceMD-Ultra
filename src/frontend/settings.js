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
//
// 例外：keybindings 分类不走通用行渲染，而是专用快捷键列表（见 renderKbList）
// ——数据源是 window.Keybindings（localStorage 覆盖表，命令实际生效的一方）与
// window.Commands（命令中文标签），支持逐项录制修改、恢复默认与冲突提示；
// 全局搜索聚合同样跳过该分类。
(function () {
  'use strict';

  var state = { open: false, category: 'appearance', global: {}, effective: {}, project: {}, kbRecording: null, kbError: null };

  // 七类分类（与 Rust settings schema 一一对应）：中文标签 + 每类一句描述。
  var CATEGORIES = [
    { key: 'appearance', label: '外观', desc: '主题与界面配色' },
    { key: 'files', label: '文件', desc: '可见类型、隐藏文件与排除规则' },
    { key: 'watching', label: '监听', desc: '文件监听与自动保存行为' },
    { key: 'search', label: '搜索', desc: '搜索范围与结果数量上限' },
    { key: 'editor', label: '编辑器', desc: '字号、缩进、换行与大文件阈值' },
    { key: 'keybindings', label: '快捷键', desc: '查看并修改命令快捷键' },
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
    p.innerHTML = '<header id="settings-header"><strong>设置</strong><input id="settings-filter" placeholder="搜索设置（支持中文标签或键名）"><button id="settings-close" title="关闭（Esc）">×</button></header>'
      + '<div class="settings-layout"><nav id="settings-categories"></nav><main id="settings-body"></main></div>'
      + '<footer><button id="settings-json">打开设置 JSON</button></footer>'
      + '<div id="settings-resize-handle" class="settings-resize-handle" title="调整大小"></div>';
    document.body.appendChild(p);
    p.querySelector('#settings-close').onclick = close;
    p.querySelector('#settings-json').onclick = function () { send({ command: 'workspace.settings.open-settings-json' }); };
    p.querySelector('#settings-filter').oninput = render;
    wireDrag(p);
    wireResize(p);
    renderCategories(); render(); return p;
  }

  // ── 拖动 / 缩放 / 位置记忆 ──
  // 首次拖动把 CSS 的 left:50%+transform 居中换成绝对 left/top；
  // 位置与尺寸分别持久化，open() 时恢复（clamp 在 viewport 内）。
  var POS_KEY = 'glancemd-ultra-settings-pos';
  var SIZE_KEY = 'glancemd-ultra-settings-size';

  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 无存储环境忽略 */ } }

  function viewport() {
    return { w: window.innerWidth || 1024, h: window.innerHeight || 768 };
  }

  function applyGeometry(p, left, top, width, height) {
    var vp = viewport();
    p.style.transform = 'none';
    p.style.left = Math.max(0, Math.min(left, vp.w - 120)) + 'px';
    p.style.top = Math.max(0, Math.min(top, vp.h - 60)) + 'px';
    if (width) p.style.width = Math.max(640, Math.min(width, Math.floor(vp.w * 0.95))) + 'px';
    if (height) p.style.height = Math.max(420, Math.min(height, Math.floor(vp.h * 0.92))) + 'px';
  }

  function restoreGeometry(p) {
    var pos = lsGet(POS_KEY), size = lsGet(SIZE_KEY);
    if (pos && typeof pos.left === 'number') {
      applyGeometry(p, pos.left, pos.top || 0, size && size.width, size && size.height);
    }
  }

  function wireDrag(p) {
    var header = p.querySelector('#settings-header');
    header.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button, input')) return; // 按钮/输入框不触发拖动
      var rect = p.getBoundingClientRect();
      var offX = e.clientX - rect.left, offY = e.clientY - rect.top;
      p.classList.add('dragging');
      function onMove(ev) {
        applyGeometry(p, ev.clientX - offX, ev.clientY - offY, null, null);
      }
      function onUp() {
        p.classList.remove('dragging');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        var r = p.getBoundingClientRect();
        lsSet(POS_KEY, { left: Math.round(r.left), top: Math.round(r.top) });
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      e.preventDefault();
    });
  }

  function wireResize(p) {
    var handle = p.querySelector('#settings-resize-handle');
    if (!handle) return;
    handle.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      e.preventDefault();
      var rect = p.getBoundingClientRect();
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
        var r = p.getBoundingClientRect();
        lsSet(SIZE_KEY, { width: Math.round(r.width), height: Math.round(r.height) });
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
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

  // ── 主体渲染：无查询 = 当前分类视图；有查询 = 跨七类全局聚合（按分类分组，
  //    分类标题可点击跳转），命中项进入该分类并保留过滤词高亮语境 ──
  function render() {
    var p = ensure();
    var filter = p.querySelector('#settings-filter');
    var q = ((filter && filter.value) || '').trim().toLowerCase();
    if (!q) return renderCategory(state.category);

    var html = '<h2>搜索：“' + esc(q) + '”</h2>';
    var total = 0;
    CATEGORIES.forEach(function (c) {
      if (c.key === 'keybindings') return; // 快捷键是专用编辑器（非键值行），不进全局聚合
      var obj = state.effective[c.key] || {};
      var hits = Object.keys(obj).filter(function (k) {
        var m = metaOf(c.key, k);
        return (k + ' ' + m.label + ' ' + m.desc).toLowerCase().indexOf(q) >= 0;
      });
      if (!hits.length) return;
      total += hits.length;
      html += '<div class="settings-search-group">'
        + '<button type="button" class="settings-search-cat" data-goto="' + esc(c.key) + '">'
        + esc(c.label) + '<span>' + hits.length + '</span></button>';
      hits.forEach(function (k) { html += rowHTML(c.key, k, obj[k]); });
      html += '</div>';
    });
    if (!total) html += '<p class="settings-empty">没有匹配的设置</p>';

    var body = p.querySelector('#settings-body');
    if (!body) return;
    body.innerHTML = html;
    Array.prototype.forEach.call(p.querySelectorAll('[data-setting]'), wire);
    Array.prototype.forEach.call(p.querySelectorAll('[data-goto]'), function (b) {
      b.onclick = function () {
        state.category = b.dataset.goto;
        renderCategories();
        renderCategory(state.category); // 跳转到该分类并保留过滤词，仅显示本类命中项
      };
    });
  }

  // ── 分类视图：分类标题 + 描述 + 过滤后的设置行 ──
  // keybindings 分类特判：不走通用行渲染，改用专用快捷键列表（renderKbList）。
  function renderCategory(catKey) {
    var p = ensure();
    var filter = p.querySelector('#settings-filter');
    var q = ((filter && filter.value) || '').trim().toLowerCase();
    var cat = categoryOf(catKey);
    var html = '<h2>' + esc(cat.label) + '</h2>'
      + '<p class="settings-category-desc">' + esc(cat.desc) + '</p>';
    var body = p.querySelector('#settings-body');
    if (!body) return;
    if (catKey === 'keybindings') { renderKbList(body, html, q); return; }
    var obj = state.effective[catKey] || {};
    var keys = Object.keys(obj).filter(function (k) {
      if (!q) return true;
      var m = metaOf(catKey, k);
      return (k + ' ' + m.label + ' ' + m.desc).toLowerCase().indexOf(q) >= 0;
    });
    if (!keys.length) {
      html += '<p class="settings-empty">' + (q ? '没有匹配的设置' : '该分类暂无可配置项') + '</p>';
    } else {
      keys.forEach(function (k) { html += rowHTML(catKey, k, obj[k]); });
    }
    body.innerHTML = html;
    Array.prototype.forEach.call(p.querySelectorAll('[data-setting]'), wire);
  }

  // ── 快捷键专用列表（用户反馈 #7）──
  // 数据源：window.Keybindings（defaults / effective / save / clear / overrides，
  // 覆盖表落在 localStorage，是命令实际生效的一方）与 window.Commands（中文标签）。
  // 结构：顶部“全部恢复默认”；每个默认绑定一行 = 命令中文名 + 当前组合键 +
  // [修改]（点击进入录制）+ [恢复默认]（有覆盖时）；Commands 注册了但未设快捷键
  // 组合键的命令以“未设快捷键”徽标附在末尾（只读对照，无编辑入口）。
  function kbLabel(id) {
    var c = window.Commands && typeof window.Commands.get === 'function' ? window.Commands.get(id) : null;
    return (c && c.label) || id;
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
    var kb = window.Keybindings;
    if (!kb || !kb.defaults || typeof kb.effective !== 'function') {
      body.innerHTML = headerHTML + '<p class="settings-empty">快捷键模块未加载</p>';
      return;
    }
    var match = function (s) { return !q || String(s).toLowerCase().indexOf(q) >= 0; };
    var eff = kb.effective();
    var ovr = kbOverrides();
    var rows = '';
    Object.keys(kb.defaults).forEach(function (id) {
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
    // 未设快捷键命令对照：Commands 注册表中不在 effective 映射内的命令
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
    if (!rows) html += '<p class="settings-empty">' + (q ? '没有匹配的设置' : '该分类暂无可配置项') + '</p>';
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

  // 录制：document 级一次性 keydown（capture 阶段拦截，避免组合键同时触发
  // Keybindings.dispatch 与面板 Esc 关闭）。handler 常驻引用、以 state 守卫，
  // 便于测试 harness（不移除监听）与真实 DOM 两相兼容。
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
    if (id == null || !e) return; // 已取消的残留监听
    var swallow = function () {
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
    };
    if (e.key === 'Escape') { swallow(); cancelKbRecording(); render(); return; }
    if (e.key === 'Backspace') { swallow(); cancelKbRecording(); kbResetOne(id); return; }
    if (/^(Control|Shift|Alt|Meta)$/.test(e.key)) return; // 修饰键单独按下：继续等待组合
    var kb = window.Keybindings;
    if (!kb || typeof kb.normalize !== 'function' || typeof kb.save !== 'function') { cancelKbRecording(); return; }
    swallow();
    var map = kbOverrides();
    map[id] = kb.normalize(e);
    try {
      kb.save(map);
      state.kbError = null;
    } catch (err) {
      // 冲突：Keybindings.save 抛“快捷键冲突：key”，行内红字提示且不落盘
      state.kbError = { id: id, message: err && err.message ? err.message : String(err) };
    }
    cancelKbRecording();
    render();
  }

  // 单行恢复默认：从覆盖表删除该命令再保存（删除不会引入冲突）。
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

  function open() {
    state.open = true;
    var p = ensure();
    p.hidden = false;
    restoreGeometry(p);
    sendReads();
  }

  function close() {
    state.open = false;
    cancelKbRecording(); // 录制中途关闭面板：静默取消，不渲染隐藏面板
    var p = document.getElementById('settings-panel'); if (p) p.hidden = true;
  }

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
