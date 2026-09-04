// 冲突横幅 + 崩溃恢复 + 周期快照（前端，Wave 2b / 阶段 2 与 6 的 UI 部分）—— window.RecoveryUI
// 契约唯一事实源：docs/dev/interfaces.md；实现层细化：docs/dev/contracts/recovery-outline.md、
// docs/dev/contracts/watcher.md（file-changed 语义）、docs/dev/contracts/data-protection.md（恢复命令/事件）。
// 视觉对照：docs/design/03-conflict-banner.html（琥珀=外部修改、红=外部删除，非模态下推内容区）。
//
// 装载顺序：app.js → commands.js → workspace.js → 本模块（之后还有 outline.js）。
// tab 状态归 TabManager（闭包内）所有，本模块只做 DOM 启发式判定（选择器见契约），
// 活动 tab 的完整路径经 window.TabManager.getActiveTab() 读取（DOM 中只有文件名）。
(function() {
  'use strict';

  if (window.RecoveryUI) {
    return;
  }

  /* ── 常量 ── */
  var SNAPSHOT_INTERVAL_MS = 30 * 1000; // 周期快照节奏（契约：30s，内容未变跳过）
  var MAX_BANNERS = 3;                  // 横幅堆叠上限，超出折叠为"…还有 N 个"

  /* ── 模块状态 ── */
  var banners = new Map();      // key(path) → { path, kind: 'modified'|'removed', ts }
  var keepPaths = new Map();    // key(path) → true（用户已选择"保留编辑版本"）
  var lastSnapshot = new Map(); // tabId → 上次快照内容（同值跳过）
  var pendingEntries = [];      // workspace:recovery-available 的条目副本
  var pendingWarnings = [];
  var lastRestored = null;      // 最近一次 workspace:recovery-restored 的 { tabId, path, content }
  var rootPath = null;          // workspace:opened 的项目根（相对路径兜底拼接用）

  /* ── DOM 引用（惰性创建） ── */
  var stackEl = null;           // #conflict-banner-stack（插在 #content 之前，下推内容）
  var panelEl = null;           // #recovery-panel（崩溃恢复列表，固定浮层）
  var restoredEl = null;        // #recovery-restored-overlay（恢复内容只读浮层）

  /* ══════════ 工具 ══════════ */

  function sendToRust(command, data) {
    if (!window.ipc || typeof window.ipc.postMessage !== 'function') {
      return;
    }
    window.ipc.postMessage(JSON.stringify(Object.assign({ command: command }, data || {})));
  }

  function keyOf(path) {
    return String(path || '').replace(/\\/g, '/').toLowerCase();
  }

  function basename(path) {
    return String(path || '').split(/[/\\]/).pop();
  }

  function isAbsolute(path) {
    var p = String(path || '');
    return /^[a-zA-Z]:[\\/]/.test(p) || p.charAt(0) === '/';
  }

  // watcher 事件路径为绝对路径；相对路径仅作防御性兜底（拼接 workspace:opened 的根）。
  function resolveAbs(path) {
    if (isAbsolute(path) || !rootPath) {
      return String(path || '');
    }
    return String(rootPath).replace(/[\\/]+$/, '') + '/' + String(path).replace(/^[\\/]+/, '');
  }

  function argPath(arg) {
    if (typeof arg === 'string') {
      return arg;
    }
    return arg && typeof arg === 'object' ? String(arg.path || '') : '';
  }

  function argValue(arg, name) {
    if (arg && typeof arg === 'object') {
      return arg[name];
    }
    return undefined;
  }

  function formatTime(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n <= 0) {
      return '';
    }
    try {
      return new Date(n).toLocaleString();
    } catch (e) {
      return '';
    }
  }

  function createElement(tag, className) {
    var el = document.createElement(tag);
    if (className) {
      el.className = className;
    }
    return el;
  }

  /* ══════════ tab DOM 启发式（选择器契约见 recovery-outline.md §2） ══════════ */

  function tabElements() {
    var bar = document.getElementById('tab-bar');
    if (!bar || typeof bar.querySelectorAll !== 'function') {
      return [];
    }
    var nodes = bar.querySelectorAll('.tab');
    return Array.prototype.slice.call(nodes || []);
  }

  function tabLabel(el) {
    var label = typeof el.querySelector === 'function' ? el.querySelector('.tab-label') : null;
    return label ? String(label.textContent) : '';
  }

  function tabIsDirty(el) {
    if (typeof el.querySelector !== 'function') {
      return false;
    }
    return !!el.querySelector('.tab-dirty');
  }

  function tabIdOf(el) {
    return el && el.dataset ? String(el.dataset.tabId || '') : '';
  }

  // 同名文件可能多 tab（不同目录）：任一 dirty 即视为 dirty（宁可误报横幅，不可漏报冲突）。
  function findTabElsByPath(path) {
    var name = basename(path).toLowerCase();
    if (!name) {
      return [];
    }
    return tabElements().filter(function(el) {
      return tabLabel(el).toLowerCase() === name;
    });
  }

  function isDirtyByDom(path) {
    var els = findTabElsByPath(path);
    if (els.length) {
      return els.some(tabIsDirty);
    }
    // 回退：tab 栏缺失/无匹配时用状态栏 + 标题栏（标题 dirty 后缀 " *"）判定
    var statusFile = document.getElementById('status-file');
    var title = document.getElementById('titlebar-title');
    return !!(statusFile && title &&
      String(statusFile.textContent).toLowerCase() === basename(path).toLowerCase() &&
      /\*\s*$/.test(String(title.textContent)));
  }

  // 横幅动作作用于受影响文件：先把同名 tab 置前（保证 #editor 持有该 tab 内容），再执行。
  function activateTabsForPath(path) {
    var els = findTabElsByPath(path);
    els.forEach(function(el) {
      if (!el.classList.contains('active')) {
        if (typeof el.click === 'function') {
          el.click();
        } else if (typeof el.dispatchEvent === 'function') {
          el.dispatchEvent({ type: 'click' });
        }
      }
    });
    return els;
  }

  function activeTabEl() {
    var els = tabElements();
    for (var i = 0; i < els.length; i++) {
      if (els[i].classList.contains('active')) {
        return els[i];
      }
    }
    return els.length === 1 ? els[0] : null;
  }

  function activeTabId() {
    var el = activeTabEl();
    var id = tabIdOf(el);
    return id || 'active';
  }

  function activeTabPath() {
    // DOM 只有文件名，完整路径经公开的 TabManager API 读取（缺失则 path 记 null）
    var tm = window.TabManager;
    if (tm && typeof tm.getActiveTab === 'function') {
      var tab = tm.getActiveTab();
      if (tab && tab.path) {
        return String(tab.path);
      }
    }
    return null;
  }

  /* ══════════ 横幅栈（对照设计稿 03，非模态下推 #content） ══════════ */

  function ensureStack() {
    if (stackEl && stackEl.parentNode) {
      return stackEl;
    }
    var existing = document.getElementById('conflict-banner-stack');
    stackEl = existing || createElement('div', 'recovery-banner-stack');
    stackEl.id = 'conflict-banner-stack';
    if (!stackEl.parentNode) {
      var content = document.getElementById('content');
      if (content && content.parentNode) {
        content.parentNode.insertBefore(stackEl, content);
      } else if (document.body) {
        document.body.appendChild(stackEl);
      } else {
        stackEl = null;
      }
    }
    return stackEl;
  }

  // 下推量经 CSS 变量交给 recovery.css（必须在 style.css 之后装载才生效，见契约 §6）。
  function applyPushdown() {
    var root = document.documentElement;
    if (!root || !root.style || typeof root.style.setProperty !== 'function') {
      return;
    }
    var h = stackEl && typeof stackEl.offsetHeight === 'number' ? stackEl.offsetHeight : 0;
    root.style.setProperty('--recovery-push', h + 'px');
  }

  function bannerIcon(kind) {
    var svg = createElement('span', 'recovery-ico');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = kind === 'removed'
      ? '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.8 9h5.4l.8-9"></path><path d="M6.8 7v4.5M9.2 7v4.5"></path></svg>'
      : '<svg viewBox="0 0 16 16"><path d="M8 2 14.5 13.5h-13z"></path><path d="M8 6.5v3.2M8 11.6v.9"></path></svg>';
    return svg;
  }

  function bannerButton(label, command, arg) {
    var btn = createElement('button', 'recovery-btn');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', function() {
      runCommand(command, arg);
    });
    return btn;
  }

  function runCommand(id, arg) {
    if (window.Commands && typeof window.Commands.run === 'function') {
      window.Commands.run(id, arg);
    }
  }

  function buildBannerNode(entry) {
    var isRemoved = entry.kind === 'removed';
    var keep = keepPaths.has(keyOf(entry.path));

    var node = createElement('div', 'recovery-banner ' + (isRemoved ? 'recovery-banner--removed' : 'recovery-banner--modified'));
    node.setAttribute('data-path', entry.path);
    node.setAttribute('role', 'alert');

    node.appendChild(bannerIcon(entry.kind));

    var copy = createElement('div', 'recovery-copy');
    var title = createElement('div', 'recovery-title');
    var strong = createElement('strong');
    strong.textContent = isRemoved ? '磁盘文件已被删除' : '文件已在外部被修改';
    title.appendChild(strong);
    title.appendChild(document.createTextNode(isRemoved
      ? '——内容仍保留在编辑器中，不会静默丢失'
      : '——你的编辑尚未保存'));
    copy.appendChild(title);

    var sub = createElement('div', 'recovery-sub');
    var fileSpan = createElement('span', 'recovery-file');
    fileSpan.textContent = entry.path;
    sub.appendChild(fileSpan);
    if (entry.ts) {
      var sep1 = createElement('span', 'recovery-sep');
      sep1.textContent = '·';
      sub.appendChild(sep1);
      sub.appendChild(document.createTextNode((isRemoved ? '删除发生于 ' : '磁盘版本 ') + formatTime(entry.ts)));
    }
    if (!isRemoved) {
      var sep2 = createElement('span', 'recovery-sep');
      sep2.textContent = '·';
      sub.appendChild(sep2);
      sub.appendChild(document.createTextNode(keep
        ? '已选择保留编辑版本'
        : '选择"保留编辑版本"后再次保存将要求二次确认覆盖'));
    }
    copy.appendChild(sub);

    if (keep) {
      // 降级方案的常驻警示条：无法拦截保存动作（拦截点在 app.js，见契约 §5 限制清单），
      // 在该文件保存/关闭前持续显示"保存将被覆盖"警示。
      var keepNote = createElement('div', 'recovery-keep-note');
      keepNote.textContent = '保存将被覆盖：该文件再次保存前需二次确认（保存成功或关闭后自动解除）';
      copy.appendChild(keepNote);
    }

    node.appendChild(copy);

    var acts = createElement('div', 'recovery-acts');
    if (isRemoved) {
      acts.appendChild(bannerButton('另存为…', 'recovery.save-as', { path: entry.path }));
      acts.appendChild(bannerButton('关闭', 'recovery.close-tab', { path: entry.path }));
    } else {
      acts.appendChild(bannerButton('重新加载', 'recovery.reload', { path: entry.path }));
      if (!keep) {
        acts.appendChild(bannerButton('保留编辑版本', 'recovery.keep-edited', { path: entry.path }));
      }
      acts.appendChild(bannerButton('另存为…', 'recovery.save-as', { path: entry.path }));
    }
    var closeBtn = createElement('button', 'recovery-close');
    closeBtn.type = 'button';
    closeBtn.title = '暂时关闭（该文件再次变更时会重现）';
    closeBtn.setAttribute('aria-label', '关闭横幅');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', function() {
      runCommand('recovery.dismiss-banner', { path: entry.path });
    });
    acts.appendChild(closeBtn);
    node.appendChild(acts);

    return node;
  }

  function renderStack() {
    var stack = ensureStack();
    if (!stack) {
      return;
    }
    stack.innerHTML = '';
    var entries = Array.from(banners.values());
    var visible = entries.slice(0, MAX_BANNERS);
    visible.forEach(function(entry) {
      stack.appendChild(buildBannerNode(entry));
    });
    var overflow = entries.length - visible.length;
    if (overflow > 0) {
      var more = createElement('div', 'recovery-banner-more');
      more.textContent = '…还有 ' + overflow + ' 个文件冲突';
      stack.appendChild(more);
    }
    applyPushdown();
  }

  function showBanner(path, kind, ts) {
    banners.set(keyOf(path), { path: String(path), kind: kind, ts: Number(ts) || 0 });
    renderStack();
  }

  function removeBanner(path) {
    if (banners.delete(keyOf(path))) {
      renderStack();
    }
  }

  // tab 关闭 / 转为 clean 时解除"保留编辑版本"标记并撤下对应横幅（tab 栏 MutationObserver 驱动）。
  function recheckKeepFlags() {
    var changed = false;
    Array.from(keepPaths.keys()).forEach(function(key) {
      var matched = findTabElsByPath(key);
      var dirty = matched.length > 0 && matched.some(tabIsDirty);
      if (!dirty) {
        keepPaths.delete(key);
        changed = true;
      }
    });
    // 横幅随 tab 状态清理：同名 tab 已不存在（关闭）或已 clean（已保存/还原）时移除
    Array.from(banners.keys()).forEach(function(key) {
      var entry = banners.get(key);
      var els = findTabElsByPath(key);
      if (!els.length || (entry.kind === 'modified' && !els.some(tabIsDirty))) {
        banners.delete(key);
        changed = true;
      }
    });
    if (changed) {
      renderStack();
    }
  }

  function watchTabBar() {
    if (typeof MutationObserver !== 'function') {
      return;
    }
    var bar = document.getElementById('tab-bar');
    if (!bar || typeof MutationObserver !== 'function') {
      return;
    }
    try {
      var observer = new MutationObserver(function() {
        recheckKeepFlags();
      });
      observer.observe(bar, { childList: true, subtree: true });
    } catch (e) {
      /* 观察失败静默：保留标记仅延迟解除，不影响数据安全 */
    }
  }

  /* ══════════ 崩溃恢复面板（workspace:recovery-available） ══════════ */

  function ensurePanel() {
    if (panelEl && panelEl.parentNode) {
      return panelEl;
    }
    panelEl = createElement('div', 'recovery-panel');
    panelEl.id = 'recovery-panel';
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-label', '崩溃恢复');
    (document.body || document.documentElement).appendChild(panelEl);
    return panelEl;
  }

  function entryTimeText(entry) {
    return formatTime(entry.savedAtMs != null ? entry.savedAtMs : entry.saved_at_ms);
  }

  function renderPanel() {
    var panel = ensurePanel();
    panel.innerHTML = '';

    var head = createElement('div', 'recovery-panel-head');
    var title = createElement('span', 'recovery-panel-title');
    title.textContent = '检测到 ' + pendingEntries.length + ' 条未保存的编辑内容（上次异常退出前自动保存）';
    head.appendChild(title);
    var close = createElement('button', 'recovery-close');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭恢复提示');
    close.textContent = '×';
    close.title = '暂不处理（数据保留在恢复区，下次启动会再次提示）';
    close.addEventListener('click', function() {
      runCommand('recovery.hide-panel', {});
    });
    head.appendChild(close);
    panel.appendChild(head);

    pendingEntries.forEach(function(entry) {
      var row = createElement('div', 'recovery-entry');
      row.setAttribute('data-tab-id', entry.tabId != null ? entry.tabId : entry.tab_id);

      var main = createElement('div', 'recovery-entry-main');
      var pathLine = createElement('div', 'recovery-entry-path');
      pathLine.textContent = entry.path || '（未命中文档路径）';
      var timeLine = createElement('div', 'recovery-entry-time');
      timeLine.textContent = '最后保存 ' + (entryTimeText(entry) || '未知时间');
      main.appendChild(pathLine);
      main.appendChild(timeLine);
      row.appendChild(main);

      var acts = createElement('div', 'recovery-entry-acts');
      var tabId = entry.tabId != null ? entry.tabId : entry.tab_id;
      var restoreBtn = createElement('button', 'recovery-btn');
      restoreBtn.type = 'button';
      restoreBtn.textContent = '恢复';
      restoreBtn.addEventListener('click', function() {
        runCommand('recovery.restore-entry', { tabId: tabId });
      });
      var discardBtn = createElement('button', 'recovery-btn');
      discardBtn.type = 'button';
      discardBtn.textContent = '丢弃';
      discardBtn.addEventListener('click', function() {
        runCommand('recovery.discard-entry', { tabId: tabId });
      });
      acts.appendChild(restoreBtn);
      acts.appendChild(discardBtn);
      row.appendChild(acts);
      panel.appendChild(row);
    });

    if (pendingWarnings.length) {
      var warn = createElement('div', 'recovery-panel-warnings');
      warn.textContent = '部分恢复条目已损坏跳过：' + pendingWarnings.join('；');
      panel.appendChild(warn);
    }

    var foot = createElement('div', 'recovery-panel-foot');
    var discardAll = createElement('button', 'recovery-btn');
    discardAll.type = 'button';
    discardAll.textContent = '全部丢弃';
    discardAll.addEventListener('click', function() {
      runCommand('recovery.discard-all', {});
    });
    foot.appendChild(discardAll);
    panel.appendChild(foot);

    panel.classList.add('visible');
  }

  function hidePanel() {
    if (panelEl) {
      panelEl.classList.remove('visible');
    }
  }

  /* ══════════ 恢复内容只读浮层（workspace:recovery-restored） ══════════ */

  function ensureRestored() {
    if (restoredEl && restoredEl.parentNode) {
      return restoredEl;
    }
    restoredEl = createElement('div', 'recovery-restored');
    restoredEl.id = 'recovery-restored-overlay';
    restoredEl.setAttribute('role', 'dialog');
    restoredEl.setAttribute('aria-label', '恢复的编辑内容');
    (document.body || document.documentElement).appendChild(restoredEl);
    return restoredEl;
  }

  function copyText(text) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function') {
        var writing = navigator.clipboard.writeText(text);
        if (writing && typeof writing.catch === 'function') {
          writing.catch(function() { /* 剪贴板拒绝时静默，按钮反馈"复制失败"由后续调用判定 */ });
        }
        return true;
      }
    } catch (e) { /* 走 execCommand 回退 */ }
    try {
      if (typeof document.execCommand !== 'function') {
        return false;
      }
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      if (ta.parentNode) {
        ta.parentNode.removeChild(ta);
      }
      return ok;
    } catch (e) {
      return false;
    }
  }

  function renderRestored() {
    if (!lastRestored) {
      return;
    }
    var box = ensureRestored();
    box.innerHTML = '';

    var head = createElement('div', 'recovery-restored-head');
    var title = createElement('span', 'recovery-restored-title');
    title.textContent = '已恢复的编辑内容（只读副本）';
    head.appendChild(title);
    var close = createElement('button', 'recovery-close');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭恢复内容');
    close.textContent = '×';
    close.addEventListener('click', function() {
      box.classList.remove('visible');
    });
    head.appendChild(close);
    box.appendChild(head);

    var pathLine = createElement('div', 'recovery-restored-path');
    pathLine.textContent = lastRestored.path || '（未命中文档路径）';
    box.appendChild(pathLine);

    var pre = createElement('pre', 'recovery-restored-content');
    pre.setAttribute('tabindex', '0');
    pre.textContent = lastRestored.content;
    box.appendChild(pre);

    var acts = createElement('div', 'recovery-restored-acts');
    var copyBtn = createElement('button', 'recovery-btn');
    copyBtn.type = 'button';
    copyBtn.textContent = '复制全部';
    copyBtn.addEventListener('click', function() {
      var ok = copyText(String(lastRestored ? lastRestored.content : ''));
      copyBtn.textContent = ok ? '已复制' : '复制失败';
    });
    acts.appendChild(copyBtn);
    var hint = createElement('span', 'recovery-restored-hint');
    hint.textContent = '以 dirty tab 打开恢复内容需后端 recovery.open-as-tab 命令（见契约 §5），当前请复制后自行粘贴';
    acts.appendChild(hint);
    box.appendChild(acts);

    box.classList.add('visible');
  }

  /* ══════════ 路径迁移（rename/move 事务与 watcher rename 事件） ══════════ */

  function remapPath(from, to) {
    var fromKey = keyOf(from);
    var toKey = keyOf(to);
    if (!fromKey || !toKey || fromKey === toKey) {
      return;
    }
    if (banners.has(fromKey)) {
      var entry = banners.get(fromKey);
      banners.delete(fromKey);
      entry.path = String(to);
      banners.set(toKey, entry);
      renderStack();
    }
    if (keepPaths.has(fromKey)) {
      keepPaths.delete(fromKey);
      keepPaths.set(toKey, true);
    }
  }

  /* ══════════ 周期快照 ══════════ */

  function snapshotTick() {
    var editor = document.getElementById('editor');
    if (!editor) {
      return;
    }
    var content = typeof editor.value === 'string' ? editor.value : '';
    if (!content) {
      return; // 空内容无需恢复条目
    }
    var activeEl = activeTabEl();
    if (!activeEl || !tabIsDirty(activeEl)) {
      return; // 仅对 dirty 的活动 tab 快照（data-protection.md §4.3 建议）
    }
    var tabId = activeTabId();
    if (lastSnapshot.get(tabId) === content) {
      return; // 内容与上次相同则跳过
    }
    lastSnapshot.set(tabId, content);
    sendToRust('workspace.recovery.snapshot', {
      data: JSON.stringify({
        tab_id: String(tabId),
        path: activeTabPath(),
        content: content,
        saved_at_ms: Date.now()
      })
    });
  }

  /* ══════════ 命令注册 ══════════ */

  function registerCommands() {
    if (!window.Commands || typeof window.Commands.register !== 'function') {
      return;
    }
    var register = window.Commands.register;

    register('recovery.reload', {
      label: '冲突：重新加载磁盘版本',
      run: function(arg) {
        var path = argPath(arg);
        if (!path) {
          return;
        }
        activateTabsForPath(path);
        sendToRust('open_file', { path: resolveAbs(path) });
        removeBanner(path); // 乐观撤下；重载未生效前磁盘再变更会重现
      }
    });

    register('recovery.keep-edited', {
      label: '冲突：保留编辑版本',
      run: function(arg) {
        var path = argPath(arg);
        if (!path) {
          return;
        }
        keepPaths.set(keyOf(path), true);
        renderStack(); // 横幅转为"保存将被覆盖"常驻警示，直到保存/关闭（tab 栏观察器解除）
      }
    });

    register('recovery.confirm-overwrite', {
      label: '冲突：确认覆盖保存（解除二次确认标记）',
      // app.js 收编保存链路后，在用户对"保存将覆盖磁盘版本"确认后调用：
      // Commands.run('recovery.confirm-overwrite', { path })。
      run: function(arg) {
        var path = argPath(arg);
        if (!path) {
          return;
        }
        keepPaths.delete(keyOf(path));
        removeBanner(path);
      }
    });

    register('recovery.save-as', {
      label: '冲突：编辑内容另存为…',
      run: function(arg) {
        var path = argPath(arg);
        if (path) {
          activateTabsForPath(path); // 保证 #editor 持有的是受影响 tab 的内容
        }
        var editor = document.getElementById('editor');
        if (!editor) {
          return;
        }
        sendToRust('save_as', { content: String(editor.value != null ? editor.value : '') });
      }
    });

    register('recovery.close-tab', {
      label: '冲突：关闭该文件 tab',
      run: function(arg) {
        var path = argPath(arg);
        var els = path ? activateTabsForPath(path) : [];
        var tm = window.TabManager;
        var closed = false;
        if (tm && typeof tm.closeTab === 'function' && els.length) {
          var id = Number(tabIdOf(els[0]));
          if (isFinite(id)) {
            tm.closeTab(id);
            closed = true;
          }
        }
        if (path) {
          removeBanner(path);
        }
        if (!closed) {
          recheckKeepFlags(); // TabManager 不可达时至少清理横幅与标记
        }
      }
    });

    register('recovery.dismiss-banner', {
      label: '冲突：暂时关闭横幅',
      run: function(arg) {
        var path = argPath(arg);
        if (path) {
          removeBanner(path); // × 仅暂时关闭；该文件再次变更时重现
        }
      }
    });

    register('recovery.restore-entry', {
      label: '崩溃恢复：恢复选中条目',
      run: function(arg) {
        var tabId = argValue(arg, 'tabId');
        if (tabId == null || tabId === '') {
          return;
        }
        sendToRust('workspace.recovery.restore', {
          data: JSON.stringify({ tab_id: String(tabId) })
        });
      }
    });

    register('recovery.discard-entry', {
      label: '崩溃恢复：丢弃选中条目',
      run: function(arg) {
        var tabId = argValue(arg, 'tabId');
        if (tabId == null || tabId === '') {
          return;
        }
        sendToRust('workspace.recovery.discard', {
          data: JSON.stringify({ tab_id: String(tabId) })
        });
        pendingEntries = pendingEntries.filter(function(e) {
          var id = e.tabId != null ? e.tabId : e.tab_id;
          return String(id) !== String(tabId);
        });
        if (pendingEntries.length) {
          renderPanel();
        } else {
          hidePanel();
        }
      }
    });

    register('recovery.discard-all', {
      label: '崩溃恢复：全部丢弃',
      run: function() {
        pendingEntries.forEach(function(entry) {
          var id = entry.tabId != null ? entry.tabId : entry.tab_id;
          sendToRust('workspace.recovery.discard', {
            data: JSON.stringify({ tab_id: String(id) })
          });
        });
        pendingEntries = [];
        hidePanel();
      }
    });

    register('recovery.hide-panel', {
      label: '崩溃恢复：暂不处理',
      run: function() {
        hidePanel(); // 条目保留在恢复区，下次启动再次提示
      }
    });

    register('recovery.copy-restored', {
      label: '崩溃恢复：复制恢复内容',
      run: function() {
        return lastRestored ? copyText(String(lastRestored.content)) : false;
      }
    });
  }

  /* ══════════ 事件订阅 ══════════ */

  function subscribe() {
    if (!window.Workspace || typeof window.Workspace.on !== 'function') {
      return;
    }
    var on = window.Workspace.on;

    on('workspace:opened', function(data) {
      rootPath = data && data.root ? String(data.root) : null;
    });

    on('workspace:file-changed', function(data) {
      if (!data || !data.path) {
        return;
      }
      var kind = String(data.kind || '').toLowerCase(); // watcher.md 小写为准，大小写不敏感兼容
      var path = String(data.path);
      var ts = data.ts;
      if (kind === 'renamed') {
        // 可唯一识别的重命名：静默更新已记录路径（dirty 状态保持，不弹横幅）
        var to = data.to || path;
        var from = data.from || null;
        if (from) {
          remapPath(from, to);
        }
        return;
      }
      if (kind === 'modified') {
        if (isDirtyByDom(path)) {
          showBanner(path, 'modified', ts);
        } else {
          // clean tab：自动重载由 app.js 层负责；若曾有线横幅/保留标记则冲突已被解决
          keepPaths.delete(keyOf(path));
          removeBanner(path);
        }
        return;
      }
      if (kind === 'removed') {
        showBanner(path, 'removed', ts); // clean/dirty 一律红横幅，内存内容不静默丢弃
        return;
      }
      // created：树侧职责，不影响编辑缓冲区
    });

    on('workspace:recovery-available', function(data) {
      pendingEntries = (data && data.entries) || [];
      pendingWarnings = (data && data.warnings) || [];
      if (pendingEntries.length) {
        renderPanel();
      }
    });

    on('workspace:recovery-restored', function(data) {
      lastRestored = {
        tabId: data && data.tab_id != null ? data.tab_id : (data && data.tabId),
        path: data && data.path ? String(data.path) : null,
        content: data && typeof data.content === 'string' ? data.content : ''
      };
      pendingEntries = pendingEntries.filter(function(e) {
        var id = e.tabId != null ? e.tabId : e.tab_id;
        return String(id) !== String(lastRestored.tabId);
      });
      if (pendingEntries.length) {
        renderPanel();
      } else {
        hidePanel();
      }
      renderRestored();
      notifyRestored();
    });

    on('workspace:fs-op-done', function(data) {
      if (!data) {
        return;
      }
      var op = String(data.op || '');
      if (op === 'rename' || op === 'move' || op === 'undo-rename' || op === 'undo-move') {
        var paths = data.paths || [];
        if (paths.length >= 2) {
          remapPath(paths[0], paths[1]);
        }
      }
    });
  }

  function notifyRestored() {
    if (!window.dispatchEvent || !lastRestored) {
      return;
    }
    var event = null;
    if (typeof CustomEvent === 'function') {
      event = new CustomEvent('recovery:restored', { detail: lastRestored });
    } else {
      event = { type: 'recovery:restored', detail: lastRestored };
    }
    try {
      window.dispatchEvent(event);
    } catch (e) { /* 分发失败不影响浮层展示 */ }
  }

  /* ══════════ 初始化 ══════════ */

  registerCommands();
  subscribe();
  watchTabBar();
  if (typeof window.setInterval === 'function') {
    window.setInterval(snapshotTick, SNAPSHOT_INTERVAL_MS);
  }

  window.RecoveryUI = {
    /** 该路径保存前是否需要二次确认覆盖（app.js 收编保存链路后的拦截查询点） */
    needsConfirm: function(path) {
      return keepPaths.has(keyOf(path));
    },
    /** 当前未处理的冲突横幅（含被堆叠折叠的），[{path, kind, ts}] */
    getActiveConflicts: function() {
      return Array.from(banners.values()).map(function(e) {
        return { path: e.path, kind: e.kind, ts: e.ts };
      });
    },
    /** 最近一次 workspace:recovery-restored 的内容（{tabId, path, content} 或 null） */
    getLastRestored: function() {
      return lastRestored;
    },
    /** 当前待恢复条目（元数据，无内容） */
    getPendingEntries: function() {
      return pendingEntries.slice();
    },
    /** 手动触发一次快照判定（正常由 30s 定时器驱动；测试与切 tab/失焦补拍可用） */
    snapshotNow: snapshotTick,
    /** 重新评估保留标记与横幅（tab 栏观察器的手动触发点） */
    recheck: recheckKeepFlags
  };
})();
