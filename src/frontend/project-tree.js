// 项目树面板（前端，阶段 1/3）—— window.ProjectTree
// 契约唯一事实源：docs/dev/contracts/project-tree.md（本文按其实现）。
// 视觉对照：docs/design/01-project-tree.html；树 token（--tree-* / --hover-*）
// 与面板骨架（#panel-tree / #project-tree-root）由 style.css / index.html 提供。
// 职责：懒加载目录树渲染、选择模型（单选/Ctrl/Shift 多选）、键盘导航、
// 内联重命名与新建、上下文菜单、文件变更联动、展开状态持久化、活动文件定位。
// 依赖（均为既有 window 命名空间，缺失时优雅降级）：
//   window.Commands（动作注册）、window.Workspace（workspace:* 事件订阅）、
//   window.ipc（上行信封）、#tab-bar DOM + TabManager（活动文件来源）。
(function() {
  'use strict';
  function t(key, params) { return window.I18n ? window.I18n.t(key, params) : key; }

  /* ══════════ 常量与状态 ══════════ */

  var KEY_EXPANDED = 'glancemd-ultra-tree-expanded';

  var els = { root: null, tree: null, empty: null, headBtn: null };
  // root：已打开工作区的规范化（/ 分隔）绝对路径；null = 未打开项目
  var root = null;
  // relDir → 归一化条目数组（缓存，展开不再重复请求）
  var entriesByDir = {};
  // 已列出（渲染过子层）的 relDir 集合
  var loadedDirs = {};
  // 在途请求（去重：同一 relDir 不重复上行 tree.list）
  var pendingLists = {};
  // 展开中的 relDir 集合（'' = 根，恒展开）
  var expanded = {};
  // 选择模型：selectedRels 全部选中项；activeRel 激活行（单选语义载体）；
  // anchorRel Shift 范围锚点。多选（>1）时激活语义禁用（st-active 不渲染）。
  var selectedRels = [];
  var activeRel = null;
  var anchorRel = null;
  // 活动 tab 文件（rel，项目外为 null）；切换 tab 只同步高亮不滚动
  var activeFileRel = null;
  // 定位当前文件：级联展开中的目标路径（逐层 tree-listed 后继续推进）
  var pendingRevealPath = null;
  // 树内剪贴板：{mode: 'copy'|'cut'|null, rels: string[]}
  var clipboard = { mode: null, rels: [] };
  // 行登记表（rel → row 元素）：渲染/移除/键盘导航的 DOM 索引
  var rowByRel = {};
  // 内联编辑会话：rename / create 期间非 null
  var editing = null;
  // 上下文菜单
  var menuEl = null;
  var menuOpen = false;
  var effectiveFilter = null;
  var lastTreeFilterKey = null;

  /* ══════════ 基础工具 ══════════ */

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) {}
  }

  // 反斜杠归一为 /（tabs.js 同规则；fs-op-done 的 Windows 绝对路径对齐用）
  function normPath(p) {
    return String(p == null ? '' : p).replace(/\\/g, '/');
  }

  function basename(rel) {
    var i = rel.lastIndexOf('/');
    return i === -1 ? rel : rel.slice(i + 1);
  }

  function parentRel(rel) {
    var i = rel.lastIndexOf('/');
    return i === -1 ? '' : rel.slice(0, i);
  }

  // 行深：根 0，一级 1……（root rel='' 拆分前特判）
  function depthOf(rel) {
    return rel === '' ? 0 : rel.split('/').length;
  }

  // 绝对路径（root + rel 拼接）。root 先归一为 / 分隔，产物与 tab 路径口径一致。
  function joinAbs(absRoot, rel) {
    return absRoot.replace(/\/+$/, '') + '/' + rel;
  }

  // rel 拼接子名（dirRel 为空 = 项目根下直接创建）
  function joinRel(dir, name) {
    return dir === '' ? name : dir + '/' + name;
  }

  // 绝对路径 → 项目内 rel；越出根（或未打开）返回 null，根自身返回 ''
  function toRel(absPath) {
    if (root === null) return null;
    var n = normPath(absPath);
    if (n === root) return '';
    var prefix = root + '/';
    if (n.indexOf(prefix) === 0) return n.slice(prefix.length);
    return null;
  }

  // 条目 kind 归一：兼容 tree-search.md 的 wire 值（"dir"/"file"/"symlink-file"）
  // 与事件概述里的首字母大写形式（Dir/File/SymLinkFile）。
  function normKind(k) {
    var s = String(k == null ? '' : k).toLowerCase();
    if (s === 'dir' || s === 'directory') return 'dir';
    if (s === 'symlinkfile' || s === 'symlink-file' || s === 'symlink') return 'symlink-file';
    return 'file';
  }

  // 条目归一：rel_path（tree-search.md §3.2）与 relPath 两种拼写都接受
  function normEntry(e) {
    var rel = normPath(e && (e.rel_path != null ? e.rel_path : (e.relPath != null ? e.relPath : '')));
    return {
      name: String((e && e.name) != null ? e.name : basename(rel)),
      rel: rel,
      kind: normKind(e && e.kind)
    };
  }

  function hasKey(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key);
  }

  function setAdd(set, v) { set[v] = true; }
  function setDel(set, v) { delete set[v]; }
  function setHas(set, v) { return hasKey(set, v); }
  function setKeys(set) { return Object.keys(set); }

  // 上行信封（interfaces.md §1.1：JSON.stringify(Object.assign({command}, data))）
  function post(command, data) {
    var msg = Object.assign({ command: command }, data || {});
    window.ipc.postMessage(JSON.stringify(msg));
  }

  function emitEvent(type, detail) {
    try {
      if (typeof window.CustomEvent === 'function') {
        window.dispatchEvent(new window.CustomEvent(type, { detail: detail }));
        return;
      }
    } catch (e) { /* 降级为普通对象 */ }
    if (typeof window.dispatchEvent === 'function') {
      window.dispatchEvent({ type: type, detail: detail });
    }
  }

  // 直接子节点按 class 查找（避免依赖 querySelector 的 mock 复杂度）
  function childByClass(el, cls) {
    var kids = el.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].classList && kids[i].classList.contains(cls)) return kids[i];
    }
    return null;
  }

  /* ══════════ 图标（内联 SVG，单色线性，着色交给 CSS currentColor） ══════════ */

  var SVG_CHEV = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5 10 8l-5 4.5"/></svg>';
  var SVG_DIR = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4A1.5 1.5 0 0 1 3 2.5h2.8L7.3 4H13A1.5 1.5 0 0 1 14.5 5.5v6A1.5 1.5 0 0 1 13 13H3A1.5 1.5 0 0 1 1.5 11.5z"/></svg>';
  var SVG_FILE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5L12 4.5v10H4z"/><path d="M9 1.5V5h3"/></svg>';
  // 文件符号链接：文档轮廓 + 指向箭头（后端不提供目标路径，故无 .sym 目标文本）
  var SVG_SYM = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5L12 4.5v10H4z"/><path d="M9 1.5V5h3"/><path d="M5.5 10h4M9.5 8l2 2-2 2"/></svg>';
  var SVG_REVEAL = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4"/><path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15"/></svg>';

  function kindIcon(kind) {
    if (kind === 'dir') return SVG_DIR;
    if (kind === 'symlink-file') return SVG_SYM;
    return SVG_FILE;
  }

  /* ══════════ 持久化（展开状态） ══════════ */

  function loadExpanded() {
    var raw = storageGet(KEY_EXPANDED);
    var set = {};
    if (raw) {
      try {
        var arr = JSON.parse(raw);
        if (Object.prototype.toString.call(arr) === '[object Array]') {
          arr.forEach(function(rel) {
            if (typeof rel === 'string') setAdd(set, rel.replace(/^\/+|\/+$/g, ''));
          });
        }
      } catch (e) { /* 损坏数据视同空 */ }
    }
    return set;
  }

  function saveExpanded() {
    storageSet(KEY_EXPANDED, JSON.stringify(setKeys(expanded)));
  }

  /* ══════════ 行渲染 ══════════ */

  function makeEl(tag) {
    return document.createElement(tag);
  }

  function insertAfter(el, anchor) {
    if (!anchor.parentNode) return;
    anchor.parentNode.insertBefore(el, anchor.nextSibling);
  }

  function chevState(entry) {
    if (entry.kind !== 'dir') return 'ghost';
    return setHas(expanded, entry.rel) ? 'open' : 'closed';
  }

  function buildRow(entry, depth) {
    var row = makeEl('div');
    row.className = 'tree-row';
    row.dataset.rel = entry.rel;
    row.dataset.kind = entry.kind;
    row.id = 'project-tree-row-' + (entry.rel === '' ? 'root' : entry.rel.replace(/[^A-Za-z0-9_-]/g, '-'));
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    row.setAttribute('aria-selected', 'false');
    if (entry.kind === 'dir') row.setAttribute('aria-expanded', setHas(expanded, entry.rel) ? 'true' : 'false');
    // 缩进走 --tree-indent token（style.css 阶段 1 登记值）
    row.style.paddingLeft = 'calc(8px + var(--tree-indent) * ' + depth + ')';

    var chev = makeEl('span');
    chev.className = 'chev ' + chevState(entry);
    chev.innerHTML = SVG_CHEV;
    row.appendChild(chev);

    var ico = makeEl('span');
    ico.className = 'f-ico f-' + entry.kind + (entry.kind === 'dir' ? '' : ' dim');
    ico.innerHTML = kindIcon(entry.kind);
    row.appendChild(ico);

    var nm = makeEl('span');
    nm.className = 'nm';
    nm.textContent = entry.name;
    row.appendChild(nm);

    return row;
  }

  // 行深从 DOM 读（dataset.rel 重算），供子树删除/键盘导航用
  function rowDepth(row) {
    return depthOf(String(row.dataset.rel || ''));
  }

  // 可导航行（排除新建输入行）
  function visibleRows() {
    var rows = [];
    var kids = els.tree ? els.tree.children : [];
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (!el.classList || !el.classList.contains('tree-row')) continue;
      if (el.classList.contains('tree-create-row')) continue;
      rows.push(el);
    }
    return rows;
  }

  // 移除 relDir 子树的所有已渲染行（不含 dir 行自身），并回收 rowByRel 登记。
  // 这里以 dataset.rel 前缀判定子树，避免依赖兄弟遍历的平台差异。
  function removeSubtreeRows(relDir) {
    var prefix = relDir + '/';
    setKeys(rowByRel).forEach(function(rel) {
      if ((relDir === '' && rel !== '') || (relDir !== '' && rel.indexOf(prefix) === 0)) {
        var row = rowByRel[rel];
        if (row && row.parentNode) row.parentNode.removeChild(row);
        delete rowByRel[rel];
      }
    });
  }

  // 渲染 relDir 的子行（插在 dir 行之后），级联处理已展开且已加载的子目录；
  // 已展开未加载的子目录触发懒加载（恢复会话/移动后级联都走这条路径）。
  // 返回该层最后一个已插入行。
  function renderChildren(relDir, anchor) {
    var depth = depthOf(relDir) + 1;
    var entries = entriesByDir[relDir] || [];
    var last = anchor;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var row = buildRow(entry, depth);
      insertAfter(row, last);
      rowByRel[entry.rel] = row;
      last = row;
      if (entry.kind === 'dir') {
        if (setHas(expanded, entry.rel)) {
          if (hasKey(loadedDirs, entry.rel)) {
            last = renderChildren(entry.rel, row);
          } else {
            requestList(entry.rel);
          }
        }
      }
    }
    return last;
  }

  // 展开集合 → 行状态类（st-selected / st-active / st-reveal / st-cut）
  function syncStates() {
    var multi = selectedRels.length > 1;
    setKeys(rowByRel).forEach(function(rel) {
      var row = rowByRel[rel];
      if (!row) return;
      var cls = row.classList;
      var selected = selectedRels.indexOf(rel) !== -1;
      cls.toggle('st-selected', selected);
      cls.toggle('st-active', !multi && rel === activeRel);
      cls.toggle('st-reveal', activeFileRel !== null && rel === activeFileRel);
      cls.toggle('st-cut', clipboard.mode === 'cut' && clipboard.rels.indexOf(rel) !== -1);
      row.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (String(row.dataset.kind) === 'dir') {
        row.setAttribute('aria-expanded', setHas(expanded, rel) ? 'true' : 'false');
      }
    });
    // 面板头"定位当前文件"按钮：无活动文件时置灰
    if (els.headBtn) {
      els.headBtn.classList.toggle('disabled', activeFileRel === null);
    }
  }

  /* ══════════ 懒加载 ══════════ */

  // force=false：已加载或已在途则跳过（去重）；force=true：刷新（在途仍去重）
  function requestList(rel, force) {
    if (root === null) return;
    rel = rel.replace(/\/+$/g, '');
    if (setHas(pendingLists, rel)) return;
    if (!force && hasKey(loadedDirs, rel)) return;
    setAdd(pendingLists, rel);
    post('workspace.tree.list', { path: rel });
  }

  function onTreeListed(data) {
    var relDir = String((data && data.relDir) || '').replace(/^\/+|\/+$/g, '');
    setDel(pendingLists, relDir);
    setAdd(loadedDirs, relDir);
    entriesByDir[relDir] = ((data && data.entries) || []).map(normEntry);

    var row = rowByRel[relDir];
    var entryCount = (entriesByDir[relDir] || []).length;
    if (row && setHas(expanded, relDir)) {
      removeSubtreeRows(relDir);
      renderChildren(relDir, row);
      // 空目录不可再展开：chev 转 ghost；非空且展开保持 open
      var chevAfter = childByClass(row, 'chev');
      if (chevAfter) chevAfter.className = 'chev ' + (entryCount ? 'open' : 'ghost');
    } else if (row) {
      // 未展开的目录（刷新场景）：仅更新 chev 语义（空目录不可展开）
      var chev = childByClass(row, 'chev');
      if (chev) chev.className = 'chev ' + (entryCount ? 'closed' : 'ghost');
    }
    maybeCompleteReveal();
    syncStates();
  }

  /* ══════════ 选择模型 ══════════ */

  function selectSingle(rel) {
    selectedRels = [rel];
    activeRel = rel;
    anchorRel = rel;
    syncStates();
  }

  function clearSelection() {
    selectedRels = [];
    activeRel = null;
    syncStates();
  }

  function toggleSelect(rel) {
    var idx = selectedRels.indexOf(rel);
    if (idx !== -1) {
      selectedRels.splice(idx, 1);
    } else {
      selectedRels.push(rel);
    }
    if (selectedRels.length === 0) {
      activeRel = null;
    }
    anchorRel = rel;
    syncStates();
  }

  function rangeSelect(rel) {
    if (anchorRel === null) anchorRel = activeRel !== null ? activeRel : rel;
    var rows = visibleRows();
    var rels = rows.map(function(r) { return String(r.dataset.rel); });
    var a = rels.indexOf(anchorRel);
    var b = rels.indexOf(rel);
    if (a === -1 || b === -1) {
      selectedRels = [rel];
    } else {
      var lo = Math.min(a, b);
      var hi = Math.max(a, b);
      selectedRels = rels.slice(lo, hi + 1);
    }
    activeRel = rel;
    syncStates();
  }

  // 多选时激活语义禁用：打开/重命名/reveal 仅在单选时可用
  function soleSelection() {
    return selectedRels.length === 1 ? selectedRels[0] : null;
  }

  function rowFromEvent(e) {
    var el = e.target;
    while (el && el !== els.tree) {
      if (el.classList && el.classList.contains('tree-row')) return el;
      el = el.parentNode;
    }
    return null;
  }

  /* ══════════ 展开 / 收起 ══════════ */

  function expandDir(rel) {
    setAdd(expanded, rel);
    saveExpanded();
    var row = rowByRel[rel];
    if (row) {
      var chev = childByClass(row, 'chev');
      if (chev) chev.className = 'chev open';
    }
    if (hasKey(loadedDirs, rel)) {
      if (row) {
        removeSubtreeRows(rel);
        renderChildren(rel, row);
      }
      syncStates();
    } else {
      requestList(rel);
    }
  }

  function collapseDir(rel) {
    setDel(expanded, rel);
    saveExpanded();
    removeSubtreeRows(rel);
    var row = rowByRel[rel];
    if (row) {
      var chev = childByClass(row, 'chev');
      if (chev) chev.className = 'chev closed';
    }
    syncStates();
  }

  function toggleDir(rel) {
    if (!rowByRel[rel] || String(rowByRel[rel].dataset.kind) !== 'dir') return;
    if (setHas(expanded, rel)) collapseDir(rel); else expandDir(rel);
  }

  /* ══════════ 点击处理（事件委托） ══════════ */

  function onTreeClick(e) {
    if (menuOpen) closeMenu();
    if (root === null || editing) return;
    var row = rowFromEvent(e);
    if (!row) {
      // 空白处点击：清空选择（保留焦点）
      clearSelection();
      return;
    }
    var rel = String(row.dataset.rel);
    var kind = String(row.dataset.kind);
    if (e.ctrlKey || e.metaKey) {
      toggleSelect(rel);
      return;
    }
    if (e.shiftKey) {
      rangeSelect(rel);
      return;
    }
    if (kind === 'dir') {
      selectSingle(rel);
      toggleDir(rel);
      return;
    }
    // 文件行：单击 = 选中 + 激活 + 打开（主计划验收"单击文件永久打开 tab"；
    // 重复单击幂等——同路径 tab 复用）。路径经命令表下发（动态参数走 project.open-file）。
    selectSingle(rel);
    runCommand('project.open-file', { rel: rel });
  }

  function onTreeContextMenu(e) {
    if (root === null) return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation(); // 不冒泡到 document 关闭逻辑
    var row = rowFromEvent(e);
    openMenu(
      typeof e.clientX === 'number' ? e.clientX : 0,
      typeof e.clientY === 'number' ? e.clientY : 0,
      row ? String(row.dataset.rel) : null
    );
  }

  /* ══════════ 键盘导航 ══════════ */

  function currentRel() {
    if (activeRel !== null) return activeRel;
    return soleSelection();
  }

  function moveHighlight(delta) {
    var rows = visibleRows();
    if (!rows.length) return;
    var cur = currentRel();
    var idx = -1;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].dataset.rel) === cur) { idx = i; break; }
    }
    var next = idx === -1 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, idx + delta));
    selectSingle(String(rows[next].dataset.rel));
  }

  function onTreeKeyDown(e) {
    if (root === null || editing) return;
    var key = e.key;
    var cur = currentRel();

    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault();
      moveHighlight(key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (key === 'ArrowRight') {
      e.preventDefault();
      if (cur !== null && String(rowByRel[cur] && rowByRel[cur].dataset.kind) === 'dir' && !setHas(expanded, cur)) {
        expandDir(cur);
      }
      return;
    }
    if (key === 'ArrowLeft') {
      e.preventDefault();
      if (cur !== null && String(rowByRel[cur] && rowByRel[cur].dataset.kind) === 'dir' && setHas(expanded, cur)) {
        collapseDir(cur);
      } else if (cur) {
        var parent = parentRel(cur);
        if (rowByRel[parent]) selectSingle(parent);
      }
      return;
    }
    if (key === 'Enter') {
      e.preventDefault();
      if (cur === null || selectedRels.length > 1) return;
      if (String(rowByRel[cur] && rowByRel[cur].dataset.kind) === 'dir') {
        toggleDir(cur);
      } else {
        runCommand('project.open-file', { rel: cur });
      }
      return;
    }
    if (key === 'F2') {
      e.preventDefault();
      if (selectedRels.length === 1 && cur) startRename(cur);
      return;
    }
    if (key === 'Delete') {
      e.preventDefault();
      deleteSelection(e.shiftKey);
      return;
    }
    if (key === 'ContextMenu') {
      e.preventDefault();
      openMenuAtRow(cur);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (key === 'c' || key === 'C')) {
      e.preventDefault();
      clipboardCopy();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (key === 'x' || key === 'X')) {
      e.preventDefault();
      clipboardCut();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (key === 'v' || key === 'V')) {
      e.preventDefault();
      clipboardPaste(currentRel());
      return;
    }
  }

  /* ══════════ 内联重命名 / 新建 ══════════ */

  function isEditableTarget(el) {
    return el && el.classList && (el.classList.contains('tree-rename-input') || el.classList.contains('tree-create-input'));
  }

  function finishEditing(commit) {
    if (!editing) return;
    var session = editing;
    editing = null;
    if (session.input && session.input.parentNode) {
      session.input.parentNode.removeChild(session.input);
    }
    // 新建会话的整行占位（tree-create-row）一并移除；重命名会话的 row 是真实树行，保留
    if (session.type !== 'rename' && session.row && session.row.parentNode) {
      session.row.parentNode.removeChild(session.row);
    }
    if (session.nm) session.nm.style.display = '';
    if (session.row && session.row.classList) session.row.classList.remove('st-editing');
    if (commit && session.type === 'rename') {
      var name = (session.input.value || '').trim();
      if (name && name !== session.origName) {
        runCommand('project.rename', { path: session.rel, newName: name });
      }
    } else if (commit) {
      var newName = (session.input.value || '').trim();
      if (newName) {
        runCommand(session.type === 'file' ? 'project.create-file' : 'project.create-dir', {
          dir: session.dir,
          name: newName
        });
      }
    }
    if (els.tree && els.tree.focus) els.tree.focus();
  }

  function bindEditorInput(input) {
    input.addEventListener('keydown', function(e) {
      if (e.stopPropagation) e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finishEditing(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finishEditing(false);
      }
    });
    input.addEventListener('blur', function() {
      // Enter 提交会先摘除输入框（editing 置 null），迟到的 blur 不回滚提交
      if (editing && editing.input === input) finishEditing(false);
    });
  }

  function startRename(rel) {
    if (root === null || rel === '' || selectedRels.length !== 1) return; // 根不可重命名；多选禁用
    var row = rowByRel[rel];
    var nm = row ? childByClass(row, 'nm') : null;
    if (!row || !nm) return;
    var input = makeEl('input');
    input.className = 'tree-rename-input';
    input.value = basename(rel);
    input.setAttribute('aria-label', '重命名');
    nm.style.display = 'none';
    row.appendChild(input);
    row.classList.add('st-editing');
    editing = { type: 'rename', rel: rel, input: input, nm: nm, row: row, origName: basename(rel) };
    bindEditorInput(input);
    if (input.focus) input.focus();
    if (input.select) input.select();
  }

  function startCreate(dirRel, type) {
    if (root === null) return;
    var row = rowByRel[dirRel];
    if (!row) return;
    var input = makeEl('input');
    input.className = 'tree-create-input';
    input.value = '';
    input.setAttribute('placeholder', type === 'file' ? '新建文件（无扩展名自动补 .md）' : '新建文件夹');
    input.setAttribute('aria-label', type === 'file' ? '新建文件' : '新建文件夹');
    var holder = makeEl('div');
    holder.className = 'tree-row tree-create-row';
    holder.style.paddingLeft = 'calc(8px + var(--tree-indent) * ' + (depthOf(dirRel) + 1) + ')';
    holder.appendChild(input);
    insertAfter(holder, row);
    editing = { type: type, dir: dirRel, input: input, nm: null, row: holder };
    bindEditorInput(input);
    if (input.focus) input.focus();
  }

  /* ══════════ 删除 ══════════ */

  function deleteSelection(permanent) {
    var rels = selectedRels.filter(function(rel) { return rel !== ''; });
    if (!rels.length || root === null) return;
    if (permanent && typeof window.confirm === 'function') {
      if (!window.confirm(t('tree.deletePermanentConfirm', { n: rels.length }))) return;
    }
    runCommand('project.delete', { paths: rels, permanent: !!permanent });
  }

  /* ══════════ 树内剪贴板（复制 / 剪切 / 粘贴） ══════════ */

  function clipboardCopy() {
    if (!selectedRels.length) return;
    clipboard = { mode: 'copy', rels: selectedRels.slice() };
    syncStates();
  }

  function clipboardCut() {
    if (!selectedRels.length || selectedRels.indexOf('') !== -1) return;
    clipboard = { mode: 'cut', rels: selectedRels.slice() };
    syncStates();
  }

  function clipboardPaste(destDir) {
    if (!clipboard.rels.length || root === null) return;
    var dest = destDir == null ? '' : destDir;
    // 目标落入被移动/复制目录内部（或其自身）由后端拒绝，这里先行剪除避免整批失败
    var rels = clipboard.rels.filter(function(rel) {
      return rel !== dest && dest.indexOf(rel + '/') !== 0;
    });
    if (!rels.length) return;
    if (clipboard.mode === 'cut') {
      runCommand('project.move', { paths: rels, destDir: dest });
    } else {
      runCommand('project.copy', { paths: rels, destDir: dest });
    }
  }

  /* ══════════ 系统剪贴板（复制路径） ══════════ */

  function fallbackCopy(text) {
    var ta = makeEl('textarea');
    ta.value = text;
    if (ta.select) ta.select();
    document.body.appendChild(ta);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    if (ta.parentNode) ta.parentNode.removeChild(ta);
    return ok;
  }

  function writeClipboard(text) {
    var nav = typeof navigator !== 'undefined' ? navigator : {};
    if (nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      try {
        var res = nav.clipboard.writeText(text);
        if (res && typeof res.catch === 'function') {
          res.catch(function() { fallbackCopy(text); });
        }
        return;
      } catch (e) { /* 落到降级 */ }
    }
    fallbackCopy(text);
  }

  /* ══════════ 上下文菜单（对照设计稿 01 菜单样式） ══════════ */

  var MENU_ITEMS = [
    { id: 'create-file', label: t('tree.createFile') },
    { id: 'create-dir', label: t('tree.createDir') },
    { sep: true },
    { id: 'cut', label: t('tree.cut'), kbd: 'Ctrl+X' },
    { id: 'copy', label: t('tree.copy'), kbd: 'Ctrl+C' },
    { id: 'paste', label: t('tree.paste'), kbd: 'Ctrl+V' },
    { sep: true },
    { id: 'rename', label: t('tree.rename'), kbd: 'F2' },
    { id: 'delete', label: t('tree.delete'), kbd: 'Del', danger: true },
    { id: 'delete-permanent', label: t('tree.deletePermanent'), kbd: 'Shift+Del', danger: true },
    { sep: true },
    { id: 'terminal', label: t('tree.openInTerminal'), kbd: 'Ctrl+`' },
    { id: 'reveal', label: t('tree.revealInFileManager') },
    { id: 'copy-abs', label: t('tree.copyAbsolutePath') },
    { id: 'copy-rel', label: t('tree.copyRelativePath') }
  ];

  var menuActiveIndex = -1;

  function menuItems() {
    if (!menuEl) return [];
    return Array.prototype.filter.call(menuEl.children || [], function(el) {
      return el.dataset && el.dataset.action;
    });
  }

  function focusMenuItem(index) {
    var items = menuItems();
    if (!items.length) return;
    var next = index;
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    for (var n = 0; n < items.length; n++) {
      var candidate = items[(next + n) % items.length];
      if (!candidate.classList.contains('disabled')) {
        menuActiveIndex = (next + n) % items.length;
        items.forEach(function(item) { item.classList.toggle('is-active', item === candidate); });
        if (candidate.focus) candidate.focus();
        return;
      }
    }
  }

  function onMenuKeyDown(e) {
    var items = menuItems();
    if (!items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (e.preventDefault) e.preventDefault();
      focusMenuItem(menuActiveIndex + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (e.preventDefault) e.preventDefault();
      var item = items[menuActiveIndex];
      if (item && !item.classList.contains('disabled')) {
        runMenuAction(item.dataset.action);
        closeMenu();
      }
    } else if (e.key === 'Escape') {
      if (e.preventDefault) e.preventDefault();
      closeMenu();
    }
  }

  function buildMenu() {
    if (menuEl) return menuEl;
    menuEl = makeEl('div');
    menuEl.className = 'ctx-menu';
    menuEl.setAttribute('role', 'menu');
    menuEl.setAttribute('aria-label', '项目树操作');
    menuEl.addEventListener('keydown', onMenuKeyDown);
    MENU_ITEMS.forEach(function(def) {
      if (def.sep) {
        var sep = makeEl('div');
        sep.className = 'ctx-sep';
        sep.setAttribute('role', 'separator');
        menuEl.appendChild(sep);
        return;
      }
      var item = makeEl('div');
      item.className = 'ctx-item' + (def.danger ? ' danger' : '');
      item.dataset.action = def.id;
      item.setAttribute('role', 'menuitem');
      item.setAttribute('tabindex', '-1');
      item.textContent = def.label;
      if (def.kbd) {
        var kbd = makeEl('span');
        kbd.className = 'kbd';
        kbd.textContent = def.kbd;
        item.appendChild(kbd);
      }
      item.addEventListener('click', function(e) {
        if (e.stopPropagation) e.stopPropagation();
        if (item.classList.contains('disabled')) return;
        runMenuAction(item.dataset.action);
        closeMenu();
      });
      menuEl.appendChild(item);
    });
    return menuEl;
  }

  // 当前菜单目标目录：目录行 = 自身；文件行 = 父目录；无行 = 项目根
  function targetDirOf(rel) {
    if (rel === null) return '';
    return rowByRel[rel] && String(rowByRel[rel].dataset.kind) === 'dir' ? rel : parentRel(rel);
  }

  function refreshMenuState() {
    if (!menuEl) return;
    var single = soleSelection();
    var has = selectedRels.length > 0;
    var state = {
      'create-file': true,
      'create-dir': true,
      'cut': has && selectedRels.indexOf('') === -1,
      'copy': has && selectedRels.indexOf('') === -1,
      'paste': clipboard.rels.length > 0,
      'rename': selectedRels.length === 1 && single !== '' && single !== null,
      'delete': has && selectedRels.indexOf('') === -1,
      'delete-permanent': has && selectedRels.indexOf('') === -1,
      'terminal': selectedRels.length <= 1,
      'reveal': selectedRels.length <= 1,           // 多选时禁用（主计划 §0.2）
      'copy-abs': has,
      'copy-rel': has
    };
    MENU_ITEMS.forEach(function(def) {
      if (def.sep) return;
      var item = menuEl.querySelector ? menuEl.querySelector('[data-action="' + def.id + '"]') : null;
      if (!item) {
        var kids = menuEl.children || [];
        for (var i = 0; i < kids.length; i++) {
          if (kids[i].dataset && kids[i].dataset.action === def.id) { item = kids[i]; break; }
        }
      }
      if (item) {
        var disabled = !state[def.id];
        item.classList.toggle('disabled', disabled);
        item.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      }
    });
  }

  function openMenu(x, y, rel) {
    if (root === null) return;
    if (rel !== null && selectedRels.indexOf(rel) === -1) {
      selectSingle(rel); // 右键未选中项：先选中（Windows 惯例）
    }
    var menu = buildMenu();
    refreshMenuState();
    if (!menu.parentNode && document.body) document.body.appendChild(menu);
    // 先挂载测量，再夹紧并在空间不足时翻转，确保菜单不越出 viewport。
    var px = typeof x === 'number' ? x : 0;
    var py = typeof y === 'number' ? y : 0;
    var rect = menu.getBoundingClientRect ? menu.getBoundingClientRect() : { width: 212, height: 26 * 12 + 8 };
    var vw = typeof window.innerWidth === 'number' && window.innerWidth > 0 ? window.innerWidth : 1024;
    var vh = typeof window.innerHeight === 'number' && window.innerHeight > 0 ? window.innerHeight : 768;
    var width = rect.width || 212;
    var height = rect.height || (26 * 12 + 8);
    if (px + width > vw) px = Math.max(0, px - width);
    if (py + height > vh) py = Math.max(0, py - height);
    px = Math.max(0, Math.min(px, Math.max(0, vw - width)));
    py = Math.max(0, Math.min(py, Math.max(0, vh - height)));
    menu.style.left = px + 'px';
    menu.style.top = py + 'px';
    menuOpen = true;
    menuActiveIndex = -1;
    focusMenuItem(0);
  }

  function openMenuAtRow(rel) {
    var row = rel !== null ? rowByRel[rel] : null;
    if (!row && visibleRows().length) row = visibleRows()[0];
    if (!row) return;
    openMenu(0, 0, String(row.dataset.rel));
  }

  function closeMenu() {
    menuOpen = false;
    menuActiveIndex = -1;
    if (menuEl) {
      menuItems().forEach(function(item) { item.classList.remove('is-active'); });
      if (menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    }
    if (els.tree && els.tree.focus) els.tree.focus();
  }

  function runMenuAction(action) {
    var single = soleSelection();
    switch (action) {
      case 'create-file':
        startCreate(targetDirOf(soleSelection()), 'file');
        break;
      case 'create-dir':
        startCreate(targetDirOf(soleSelection()), 'dir');
        break;
      case 'cut':
        clipboardCut();
        break;
      case 'copy':
        clipboardCopy();
        break;
      case 'paste':
        clipboardPaste(targetDirOf(soleSelection()));
        break;
      case 'rename':
        if (single) startRename(single);
        break;
      case 'delete':
        deleteSelection(false);
        break;
      case 'delete-permanent':
        deleteSelection(true);
        break;
      case 'terminal': {
        var dir = targetDirOf(single);
        runCommand('project.terminal', { path: dir });
        break;
      }
      case 'reveal': {
        var target = single !== null ? single : '';
        runCommand('project.reveal', { path: target });
        break;
      }
      case 'copy-abs': {
        var abs = selectedRels.map(function(rel) { return joinAbs(root, rel); });
        writeClipboard(abs.join('\n'));
        break;
      }
      case 'copy-rel': {
        writeClipboard(selectedRels.join('\n'));
        break;
      }
    }
  }

  /* ══════════ Workspace 事件联动 ══════════ */

  function onOpened(data) {
    lastTreeFilterKey = null;
    root = normPath(data && data.root);
    entriesByDir = {};
    loadedDirs = {};
    pendingLists = {};
    selectedRels = [];
    activeRel = null;
    anchorRel = null;
    clipboard = { mode: null, rels: [] };
    pendingRevealPath = null;
    expanded = loadExpanded();
    setAdd(expanded, ''); // 根恒展开（默认展开第一层）
    if (els.empty && els.empty.parentNode) els.empty.parentNode.removeChild(els.empty);

    // 重建树：根行 +（无子层，等 tree-listed）
    els.tree.innerHTML = '';
    rowByRel = {};
    var rootEntry = { name: basename(root), rel: '', kind: 'dir' };
    var rootRow = buildRow(rootEntry, 0);
    els.tree.appendChild(rootRow);
    rowByRel[''] = rootRow;

    resolveActiveFile();
    requestList(''); // 打开即请求根列表；已持久化的展开目录在渲染后级联拉取
    syncStates();
  }

  function onError() {
    // 目录不可读等失败：释放在途标记，允许用户重试展开
    pendingLists = {};
  }

  function onSettingsChanged(data) {
    effectiveFilter = data && (data.filter || data.settings || data) || null;
    var files = effectiveFilter && effectiveFilter.files || {};
    var filterKey = JSON.stringify({
      visibleExts: files.visibleExts || [],
      showHidden: !!files.showHidden,
      exclude: files.exclude || []
    });
    var changed = filterKey !== lastTreeFilterKey;
    lastTreeFilterKey = filterKey;
    if (root !== null && changed) refreshAll();
  }

  // 文件内容变更：刷新其父目录（kind 为 dir 时连带目录自身）
  function onFileChanged(data) {
    if (root === null) return;
    var rel = toRel(data && data.path);
    if (rel === null || rel === '') return;
    requestList(parentRel(rel), true);
    if (normKind(data && data.kind) === 'dir') requestList(rel, true);
  }

  // 路径重映射（rename / move / undo-*）：前缀搬移选择、展开与活动文件状态
  function remapRel(rel, from, to) {
    if (rel === from) return to;
    if (rel.indexOf(from + '/') === 0) return to + rel.slice(from.length);
    return rel;
  }

  function onFsOpDone(data) {
    if (root === null) return;
    var op = String((data && data.op) || '');
    var paths = (data && data.paths) || [];

    var isMoveLike = op === 'rename' || op === 'move' || op === 'undo-rename' || op === 'undo-move';
    if (isMoveLike && paths.length >= 2) {
      var from = toRel(paths[0]);
      var to = toRel(paths[1]);
      if (from !== null && to !== null) {
        // 展开状态随目录搬移（保持深层展开）；持久化
        var nextExpanded = {};
        setKeys(expanded).forEach(function(rel) { setAdd(nextExpanded, remapRel(rel, from, to)); });
        expanded = nextExpanded;
        saveExpanded();
        // 被搬移子树的条目缓存整体作废（relPath 已过期），按需重列
        setKeys(entriesByDir).forEach(function(rel) {
          if (rel === from || rel.indexOf(from + '/') === 0) {
            delete entriesByDir[rel];
            setDel(loadedDirs, rel);
          }
        });
        selectedRels = selectedRels.map(function(rel) { return remapRel(rel, from, to); });
        if (activeRel !== null) activeRel = remapRel(activeRel, from, to);
        if (anchorRel !== null) anchorRel = remapRel(anchorRel, from, to);
        if (activeFileRel !== null) activeFileRel = remapRel(activeFileRel, from, to);
        // 通知域：活动文件路径已迁移（tab 事务等后续流可接）
        emitEvent('projecttree:file-moved', { from: from, to: to, op: op });
      }
    }

    // 按 paths 刷新受影响目录（旧/新父目录都要刷）
    var dirs = {};
    paths.forEach(function(p) {
      var rel = toRel(p);
      if (rel !== null && rel !== '') setAdd(dirs, parentRel(rel));
    });
    setKeys(dirs).forEach(function(d) { requestList(d, true); });

    if (op === 'move' && clipboard.mode === 'cut') {
      clipboard = { mode: null, rels: [] };
    }
    syncStates();
  }

  /* ══════════ 活动文件（tab 栏联动） ══════════ */

  // 来源优先级：window.TabManager.getActiveTab().path（完整路径，tabs.js 归一为 /）
  // > #tab-bar DOM 活动行 .tab-label 文本（仅文件名，best-effort 兜底）。
  // 变更侦测：MutationObserver 监听 #tab-bar（tabs.js 每次重渲染整个 tab 栏）。
  function resolveActiveFile() {
    var path = null;
    if (window.TabManager && typeof window.TabManager.getActiveTab === 'function') {
      var tab = window.TabManager.getActiveTab();
      if (tab && tab.path) path = tab.path;
    } else {
      var bar = document.getElementById('tab-bar');
      var kids = bar ? bar.children || [] : [];
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].classList && kids[i].classList.contains('tab') && kids[i].classList.contains('active')) {
          var label = childByClass(kids[i], 'tab-label');
          if (label && label.textContent) path = label.textContent;
          break;
        }
      }
    }
    activeFileRel = path !== null ? toRel(path) : null;
    syncStates();
  }

  function watchTabs() {
    if (typeof MutationObserver !== 'function') return;
    var bar = document.getElementById('tab-bar');
    if (!bar) return;
    var observer = new MutationObserver(function() { resolveActiveFile(); });
    observer.observe(bar, { childList: true, subtree: true, attributes: true });
  }

  /* ══════════ 定位当前文件 ══════════ */

  // 逐层推进定位队列。懒加载目录的子行只有在其父目录收到 tree-listed
  // 后才会存在，因此不能同时请求所有祖先目录。
  function maybeCompleteReveal() {
    if (pendingRevealPath === null) return;
    var rel = pendingRevealPath;

    var parts = rel === '' ? [] : rel.split('/');
    parts.pop();
    var acc = '';
    var ancestors = [''];
    for (var i = 0; i < parts.length; i++) {
      acc = acc === '' ? parts[i] : acc + '/' + parts[i];
      ancestors.push(acc);
    }

    for (var j = 0; j < ancestors.length; j++) {
      var ancestor = ancestors[j];
      if (!setHas(expanded, ancestor) || !hasKey(loadedDirs, ancestor)) {
        expandDir(ancestor);
        // 已加载目录由 expandDir 同步挂载子行；继续处理后续祖先。
        // 未加载目录则等待 workspace:tree-listed 事件，避免越过懒加载边界。
        if (hasKey(loadedDirs, ancestor)) maybeCompleteReveal();
        return;
      }
    }

    var row = rowByRel[rel];
    if (row) {
      selectSingle(rel);
      if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
      pendingRevealPath = null;
    }
  }

  // 展开祖先 → 选中 → 滚动到位。每次 tree-listed 挂载完当前层后，
  // maybeCompleteReveal 会继续展开下一个尚未加载的祖先目录。
  function revealCurrent() {
    if (root === null || activeFileRel === null) return;
    pendingRevealPath = activeFileRel;
    // 不直接写入根的展开状态：让队列通过 expandDir 处理已加载根目录的
    // 子行重渲染，以及未加载根目录的请求。
    maybeCompleteReveal();
    saveExpanded();
    syncStates();
  }

  function refreshAll() {
    if (root === null) return;
    setKeys(loadedDirs).forEach(function(rel) { requestList(rel, true); });
  }

  /* ══════════ 命令注册（window.Commands） ══════════ */

  function runCommand(id, arg) {
    if (window.Commands && typeof window.Commands.run === 'function') {
      window.Commands.run(id, arg);
    }
  }

  function registerCommands() {
    if (!window.Commands || typeof window.Commands.register !== 'function') return;
    var reg = window.Commands.register;
    // 阶段 1 过渡：项目内文件打开由前端拼绝对路径后复用既有 file.open
    // （file.open 的注册表 handler 不接受动态 path）。后端提供项目内打开命令后迁移。
    reg('project.open-file', {
      label: '打开项目内文件',
      run: function(arg) {
        if (root === null) return;
        var rel = arg && typeof arg === 'object' ? arg.rel : arg;
        if (typeof rel !== 'string' || rel === '') return;
        post('open_file', { path: joinAbs(root, rel) });
      }
    });
    reg('project.reveal-current', {
      label: '定位当前文件',
      run: function() { revealCurrent(); }
    });
    reg('project.refresh', {
      label: '刷新项目树',
      run: function() { refreshAll(); }
    });
    reg('project.create-file', {
      label: '新建文件',
      run: function(arg) {
        if (root === null || !arg || typeof arg.name !== 'string' || !arg.name.trim()) return;
        post('workspace.fs.create-file', { path: joinRel(String(arg.dir || ''), arg.name.trim()) });
      }
    });
    reg('project.create-dir', {
      label: '新建文件夹',
      run: function(arg) {
        if (root === null || !arg || typeof arg.name !== 'string' || !arg.name.trim()) return;
        post('workspace.fs.create-dir', { path: joinRel(String(arg.dir || ''), arg.name.trim()) });
      }
    });
    reg('project.rename', {
      label: '重命名',
      run: function(arg) {
        if (root === null || !arg || typeof arg.path !== 'string' || !arg.path) return;
        if (typeof arg.newName !== 'string' || !arg.newName.trim()) return;
        post('workspace.fs.rename', { path: arg.path, new_name: arg.newName.trim() });
      }
    });
    reg('project.delete', {
      label: '删除',
      run: function(arg) {
        if (root === null || !arg || !arg.paths || !arg.paths.length) return;
        post('workspace.fs.delete', { paths: arg.paths, permanent: !!arg.permanent });
      }
    });
    reg('project.move', {
      label: '剪切到…',
      run: function(arg) {
        if (root === null || !arg || !arg.paths || !arg.paths.length || typeof arg.destDir !== 'string') return;
        post('workspace.fs.move', { paths: arg.paths, dest_dir: arg.destDir });
      }
    });
    reg('project.copy', {
      label: '粘贴复制',
      run: function(arg) {
        if (root === null || !arg || !arg.paths || !arg.paths.length || typeof arg.destDir !== 'string') return;
        post('workspace.fs.copy', { paths: arg.paths, dest_dir: arg.destDir });
      }
    });
    reg('project.undo', {
      label: '撤销文件操作',
      run: function() {
        if (root === null) return;
        post('workspace.fs.undo');
      }
    });
    reg('project.reveal', {
      label: '在文件管理器中显示',
      run: function(arg) {
        if (root === null) return;
        var rel = arg && typeof arg.path === 'string' ? arg.path : '';
        post('workspace.fs.reveal', { path: rel });
      }
    });
    reg('project.terminal', {
      label: '在终端中打开',
      run: function(arg) {
        if (root === null) return;
        var rel = arg && typeof arg.path === 'string' ? arg.path : '';
        post('workspace.fs.terminal', { path: rel });
      }
    });
    reg('project.copy-path', {
      label: '复制路径',
      run: function(arg) {
        if (root === null || !arg || !arg.paths || !arg.paths.length) return;
        if (arg.absolute) {
          writeClipboard(arg.paths.map(function(rel) { return joinAbs(root, rel); }).join('\n'));
        } else {
          writeClipboard(arg.paths.join('\n'));
        }
      }
    });

    // 面向键盘与快捷键系统的无参数 UI Handler 命令
    reg('projectTree.focus', {
      label: '聚焦项目树',
      category: 'View',
      run: function() {
        if (els.tree && typeof els.tree.focus === 'function') {
          if (window.LayoutUI && typeof window.LayoutUI.expand === 'function') {
            window.LayoutUI.expand('tree');
          }
          els.tree.focus();
        }
      }
    });
    reg('projectTree.openSelection', {
      label: '打开选中项',
      category: 'File',
      run: function() {
        var cur = currentRel();
        if (cur == null) return;
        if (String(rowByRel[cur] && rowByRel[cur].dataset.kind) === 'dir') {
          toggleDir(cur);
        } else {
          runCommand('project.open-file', { rel: cur });
        }
      }
    });
    reg('projectTree.rename', {
      label: '重命名',
      category: 'File',
      run: function() {
        var cur = currentRel();
        if (selectedRels.length === 1 && cur) startRename(cur);
      }
    });
    reg('projectTree.createFile', {
      label: '在当前目录新建文件',
      category: 'File',
      run: function() {
        var targetDir = activeDirForCreate();
        startCreate(targetDir, false);
      }
    });
    reg('projectTree.createDirectory', {
      label: '在当前目录新建文件夹',
      category: 'File',
      run: function() {
        var targetDir = activeDirForCreate();
        startCreate(targetDir, true);
      }
    });
    reg('projectTree.delete', {
      label: '移到回收站',
      category: 'File',
      run: function() { deleteSelection(false); }
    });
    reg('projectTree.deletePermanently', {
      label: '永久删除',
      category: 'File',
      run: function() { deleteSelection(true); }
    });
    reg('projectTree.cut', {
      label: '剪切',
      category: 'Edit',
      run: function() { clipboardCut(); }
    });
    reg('projectTree.copy', {
      label: '复制',
      category: 'Edit',
      run: function() { clipboardCopy(); }
    });
    reg('projectTree.paste', {
      label: '粘贴',
      category: 'Edit',
      run: function() { clipboardPaste(currentRel()); }
    });
    reg('projectTree.undo', {
      label: '撤销文件操作',
      category: 'Edit',
      run: function() { runCommand('project.undo'); }
    });
    reg('projectTree.refresh', {
      label: '刷新项目树',
      category: 'View',
      run: function() { refreshAll(); }
    });
    reg('projectTree.revealCurrent', {
      label: '定位当前文件',
      category: 'View',
      run: function() { revealCurrent(); }
    });
    reg('projectTree.openInTerminal', {
      label: '在终端中打开',
      category: 'File',
      run: function() {
        var cur = currentRel();
        runCommand('project.terminal', { path: cur || '' });
      }
    });
    reg('projectTree.openContextMenu', {
      label: '打开上下文菜单',
      category: 'View',
      run: function() {
        var cur = currentRel();
        openMenuAtRow(cur);
      }
    });
  }

  /* ══════════ 挂载 ══════════ */

  function rowByRelProxy() {}
  function mountHeadButton() {
    var panel = document.getElementById('panel-tree');
    if (!panel) return;
    var head = childByClass(panel, 'panel-head');
    if (!head) return;
    var btn = makeEl('button');
    btn.type = 'button';
    btn.id = 'project-tree-reveal';
    btn.className = 'panel-btn';
    btn.title = '定位当前文件';
    btn.setAttribute('aria-label', '定位当前文件');
    btn.innerHTML = SVG_REVEAL;
    btn.addEventListener('click', function(e) {
      if (e.preventDefault) e.preventDefault();
      if (btn.classList.contains('disabled')) return;
      runCommand('project.reveal-current');
    });
    var collapse = document.getElementById('panel-tree-collapse');
    if (collapse && collapse.parentNode === head) {
      head.insertBefore(btn, collapse);
    } else {
      head.appendChild(btn);
    }
    els.headBtn = btn;
  }

  function bindDocumentHandlers() {
    // 菜单外点击 / Esc 关闭（document 级，菜单开合状态门控）
    document.addEventListener('click', function(e) {
      if (!menuOpen) return;
      if (e.target && menuEl && menuEl.contains && menuEl.contains(e.target)) return;
      closeMenu();
    });
    document.addEventListener('keydown', function(e) {
      if (menuOpen) {
        if (e.key === 'Escape') {
          if (e.preventDefault) e.preventDefault();
          closeMenu();
        }
      }
    });
    document.addEventListener('contextmenu', function(e) {
      if (!menuOpen) return;
      if (e.target && menuEl && menuEl.contains && menuEl.contains(e.target)) return;
      closeMenu();
    });
  }

  function init() {
    els.root = document.getElementById('project-tree-root');
    if (!els.root) return;

    // 接管面板主体：清空占位（"尚未打开项目"），由本模块管理空态与树
    els.root.innerHTML = '';
    els.empty = makeEl('p');
    els.empty.className = 'panel-empty';
    els.empty.textContent = '尚未打开项目';
    els.root.appendChild(els.empty);

    els.tree = makeEl('div');
    els.tree.className = 'tree';
    els.tree.setAttribute('tabindex', '0');
    els.tree.setAttribute('role', 'tree');
    els.tree.setAttribute('aria-label', '项目树');
    els.root.appendChild(els.tree);

    els.tree.addEventListener('click', onTreeClick);
    els.tree.addEventListener('keydown', onTreeKeyDown);
    els.tree.addEventListener('contextmenu', onTreeContextMenu);
    els.tree.addEventListener('focus', function() {
      if (window.contextKeys && typeof window.contextKeys.set === 'function') {
        window.contextKeys.set('projectTreeFocus', true);
      }
    });
    els.tree.addEventListener('blur', function() {
      if (window.contextKeys && typeof window.contextKeys.remove === 'function') {
        window.contextKeys.remove('projectTreeFocus');
      }
    });

    if (window.Workspace && typeof window.Workspace.on === 'function') {
      window.Workspace.on('workspace:opened', onOpened);
      window.Workspace.on('workspace:tree-listed', onTreeListed);
      window.Workspace.on('workspace:file-changed', onFileChanged);
      window.Workspace.on('workspace:fs-op-done', onFsOpDone);
      window.Workspace.on('workspace:error', onError);
      window.Workspace.on('workspace:settings-effective', onSettingsChanged);
      window.Workspace.on('workspace:settings-changed', onSettingsChanged);
    }

    bindDocumentHandlers();
    mountHeadButton();
    registerCommands();
    watchTabs();
    resolveActiveFile();
  }

  /* ══════════ 对外 API ══════════ */

  window.ProjectTree = {
    // 调试/集成用状态快照（数组均返回副本）
    getState: function() {
      return {
        root: root,
        expanded: setKeys(expanded),
        loaded: setKeys(loadedDirs),
        pending: setKeys(pendingLists),
        selected: selectedRels.slice(),
        active: activeRel,
        activeFile: activeFileRel
      };
    },
    // 手动指定活动文件（绝对或项目内 rel；供无 MutationObserver 环境与后续流调用）
    setActiveFile: function(path) {
      activeFileRel = path == null || path === '' ? null : toRel(path);
      syncStates();
    },
    revealCurrent: revealCurrent,
    refresh: refreshAll,
    // 内部工具暴露给测试/集成（不属于稳定契约）
    __closeMenu: closeMenu,
    __isMenuOpen: function() { return menuOpen; }
  };

  init();
})();
