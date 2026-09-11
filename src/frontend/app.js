function t(key, params) { return window.I18n ? window.I18n.t(key, params) : key; }
// IPC Bridge
function sendToRust(command, data) {
  var msg = JSON.stringify(Object.assign({ command: command }, data || {}));
  window.ipc.postMessage(msg);
}

// Rust calls this to send events to JS
var pendingSaveRequests = [];
var saveRequestSeq = 0;

window.__fromRust = function(event, data) {
  switch (event) {
    case 'file_opened':
      addRecentFile(data.path);
      TabManager.createTab(data.path, data.content, null, null, data.is_image);
      break;
    case 'file_saved':
      var savedPath = data && data.path ? String(data.path).replace(/\\/g, '/') : '';
      var saveRequest = null;
      for (var saveIndex = 0; saveIndex < pendingSaveRequests.length; saveIndex++) {
        var candidate = pendingSaveRequests[saveIndex];
        if (data.requestId === candidate.id && data.tabId === candidate.tabId) {
          saveRequest = pendingSaveRequests.splice(saveIndex, 1)[0];
          break;
        }
      }
      if (saveRequest) {
        var savedTab = TabManager.getTabs().find(function(tab) { return tab.id === saveRequest.tabId; });
        var currentContent = savedTab && (savedTab.id === TabManager.getState().activeTabId
          ? document.getElementById('editor').value : savedTab.content);
        var unchanged = !!savedTab && currentContent === saveRequest.content;
        if (unchanged) TabManager.markClean(saveRequest.tabId);
        if (savedTab && savedPath) TabManager.updateTabPath(saveRequest.tabId, savedPath);
        saveRequest.resolve(unchanged);
      } else if (savedPath && data.requestId == null) {
        var activeSaved = TabManager.findTabByPath(savedPath);
        if (activeSaved && !pendingSaveRequests.some(function(request) { return request.tabId === activeSaved.id; })) TabManager.markClean(activeSaved.id);
      }
      onFileSaved();
      break;
    case 'stdin_opened':
      TabManager.createTab(null, data.content, 'preview', data.title || 'stdin');
      break;
    case 'save_cancelled':
    case 'error':
      if (event === 'error') showError(data.message);
      for (var errorIndex = pendingSaveRequests.length - 1; errorIndex >= 0; errorIndex--) {
        var pending = pendingSaveRequests[errorIndex];
        if (data.requestId === pending.id && data.tabId === pending.tabId) {
          pendingSaveRequests.splice(errorIndex, 1);
          pending.resolve(false);
        }
      }
      break;
    case 'navigation_blocked':
      if (typeof window.showNavigationFallback === 'function') {
        window.showNavigationFallback(data.url);
      }
      break;
    case 'file_reloaded':
      // 外部修改热重载（BUG-001）：file.reload 命令读回的最新内容
      TabManager.reloadTabContent(data.path, data.content);
      break;
  }
};

// Cached DOM refs
var $ = {};
document.addEventListener('DOMContentLoaded', function() {
    $.editor = document.getElementById('editor');
    $.preview = document.getElementById('preview');
    $.previewContainer = document.getElementById('preview-container');
    $.previewWrapper = document.getElementById('preview-wrapper');
    $.editorContainer = document.getElementById('editor-container');
    $.statusInfo = document.getElementById('status-info');
    $.statusFile = document.getElementById('status-file');
    $.titlebarTitle = document.getElementById('titlebar-title');
    $.dropOverlay = document.getElementById('drop-overlay');
    $.findBar = document.getElementById('find-bar');
    $.findInput = document.getElementById('find-input');
    $.findCount = document.getElementById('find-count');
    $.gotoBar = document.getElementById('goto-bar');
    $.gotoInput = document.getElementById('goto-input');
    $.gotoHint = document.getElementById('goto-hint');
    $.zoomToast = document.getElementById('zoom-toast');
    var editorColumn = document.getElementById('editor-column');
    if (editorColumn) editorColumn.style.position = 'relative';
});

// State
var currentMode = 'edit';
var splitMode = false;
var isMacOS = document.body.dataset.platform === 'macos';

// Restore the clean VS Code-style empty state after the last tab closes.
function resetToWelcomeState() {
  currentMode = 'edit';
  splitMode = false;

  var editorContainer = $.editorContainer || document.getElementById('editor-container');
  var previewContainer = $.previewContainer || document.getElementById('preview-container');
  if (editorContainer) editorContainer.classList.add('active');
  if (previewContainer) {
    previewContainer.classList.remove('active');
    previewContainer.style.flex = '';
  }
  document.body.classList.remove('split-mode');

  var splitButton = document.getElementById('btn-split');
  if (splitButton) splitButton.classList.remove('active');
  var toggleButton = document.getElementById('btn-toggle');
  if (toggleButton) toggleButton.classList.remove('active');
  var iconPreview = document.getElementById('icon-preview');
  var iconEdit = document.getElementById('icon-edit');
  if (iconPreview) iconPreview.style.display = '';
  if (iconEdit) iconEdit.style.display = 'none';
  var statusMode = document.getElementById('status-mode');
  if (statusMode) statusMode.textContent = 'EDIT';
  var preview = $.preview || document.getElementById('preview');
  if (preview) preview.innerHTML = '';

  // 空态收起大纲浮层：z-index 高于欢迎视图，留着会遮挡干净空态（VS Code 行为）
  if (window.LayoutUI && typeof window.LayoutUI.collapse === 'function') {
    window.LayoutUI.collapse('outline');
  }

  updateWelcome();
}

function hasPrimaryModifier(event) {
  return isMacOS ? event.metaKey : event.ctrlKey;
}

// Cross-mode selection helpers
function selectInPreview(text, ratio) {
  var preview = document.getElementById('preview');
  var walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
  var nodes = [], node, fullText = '';
  while (node = walker.nextNode()) {
    nodes.push({ node: node, start: fullText.length });
    fullText += node.textContent;
  }
  if (!nodes.length) return false;
  var textLower = text.toLowerCase(), fullLower = fullText.toLowerCase();
  var occurrences = [], idx = 0;
  while ((idx = fullLower.indexOf(textLower, idx)) !== -1) {
    occurrences.push(idx);
    idx += 1;
  }
  if (!occurrences.length) return false;
  var targetPos = ratio * fullText.length;
  var best = occurrences.reduce(function(a, b) {
    return Math.abs(b - targetPos) < Math.abs(a - targetPos) ? b : a;
  });
  var startPos = best, endPos = best + text.length;
  var startNode, startOffset, endNode, endOffset;
  for (var i = 0; i < nodes.length; i++) {
    var ns = nodes[i].start, ne = ns + nodes[i].node.textContent.length;
    if (!startNode && startPos >= ns && startPos < ne) {
      startNode = nodes[i].node; startOffset = startPos - ns;
    }
    if (endPos >= ns && endPos <= ne) {
      endNode = nodes[i].node; endOffset = endPos - ns;
    }
  }
  if (!startNode || !endNode) return false;
  var range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  if (startNode.parentElement && window.PreviewNavigation && typeof window.PreviewNavigation.scrollToElement === 'function') {
    window.PreviewNavigation.scrollToElement(startNode.parentElement, { block: 'center' });
  }
  return true;
}

function selectInEditor(text, ratio) {
  var editor = document.getElementById('editor');
  var valueLower = editor.value.toLowerCase(), textLower = text.toLowerCase();
  var occurrences = [], idx = 0;
  while ((idx = valueLower.indexOf(textLower, idx)) !== -1) {
    occurrences.push(idx);
    idx += 1;
  }
  if (!occurrences.length) return false;
  var targetPos = ratio * editor.value.length;
  var best = occurrences.reduce(function(a, b) {
    return Math.abs(b - targetPos) < Math.abs(a - targetPos) ? b : a;
  });
  editor.selectionStart = best;
  editor.selectionEnd = best + text.length;
  var lines = editor.value.substring(0, best).split('\n');
  var approxLine = lines.length - 1;
  var totalLines = editor.value.split('\n').length;
  editor.scrollTop = (approxLine / totalLines) * editor.scrollHeight - editor.clientHeight / 3;
  return true;
}

// Toolbar & View control for Image Tabs
function setToolbarForImage(isImage) {
  var btns = ['btn-toggle', 'btn-split', 'btn-toc', 'btn-save'];
  btns.forEach(function(id) {
    var b = document.getElementById(id);
    if (!b) return;
    if (isImage) {
      b.setAttribute('disabled', 'disabled');
      b.classList.add('disabled');
    } else {
      b.removeAttribute('disabled');
      b.classList.remove('disabled');
    }
  });
  if (isImage) {
    closeFind();
    document.getElementById('btn-toggle').classList.remove('active');
    document.getElementById('btn-split').classList.remove('active');
    var recentPanel = document.getElementById('recent-panel');
    if (recentPanel) recentPanel.classList.remove('visible');
  }
}

function getImageSourceUrl(path) {
  if (!path) return '';
  /* 与 main.rs::platform_base_url 保持一致：Ultra 使用 glancemd-ultra 协议 */
  var isWin = document.body.dataset.platform === 'windows';
  var base = isWin ? 'http://glancemd-ultra.localhost/' : 'glancemd-ultra://localhost/';
  return base + 'local-image?' + encodeURIComponent(path);
}

var currentImageZoom = 1;
function applyImageZoom(tab, zoom) {
  if (!tab || !tab.isImage || TabManager.getActiveTab() !== tab) return;
  var img = document.getElementById('image-preview');
  var stage = document.getElementById('image-stage');
  tab.imageZoom = zoom == null ? null : Math.min(5, Math.max(0.1, zoom));
  if (!img.naturalWidth || !img.naturalHeight) return;
  currentImageZoom = tab.imageZoom == null ? Math.min(1,
    Math.max(1, stage.clientWidth - 64) / img.naturalWidth,
    Math.max(1, stage.clientHeight - 64) / img.naturalHeight) : tab.imageZoom;
  var valEl = document.getElementById('image-zoom-val');
  img.style.width = img.naturalWidth * currentImageZoom + 'px';
  img.style.height = img.naturalHeight * currentImageZoom + 'px';
  if (valEl) valEl.textContent = Math.round(currentImageZoom * 100) + '%';
}

function showImageTab(tab) {
  if (!tab || !tab.path) return;
  var img = document.getElementById('image-preview');
  var metaEl = document.getElementById('image-meta-info');
  var statusCounts = document.getElementById('status-counts');
  if (!img) return;

  var url = getImageSourceUrl(tab.path);
  img.style.width = '';
  img.style.height = '';

  var ext = tab.path.split('.').pop().toUpperCase();
  metaEl.textContent = '正在加载 ' + ext + '...';
  statusCounts.textContent = ext;

  img.onload = function() {
    if (TabManager.getActiveTab() !== tab || img.getAttribute('src') !== url) return;
    applyImageZoom(tab, tab.imageZoom);
    var w = img.naturalWidth || 0;
    var h = img.naturalHeight || 0;
    var info = w + ' × ' + h + ' px • ' + ext;
    metaEl.textContent = info;
    statusCounts.textContent = info;
  };
  img.onerror = function() {
    if (TabManager.getActiveTab() !== tab || img.getAttribute('src') !== url) return;
    metaEl.textContent = '图片加载失败';
    statusCounts.textContent = '加载失败';
  };
  img.src = url;
}

// Mode Switch UI 联动（微型双格胶囊开关）
function updateModeSwitchUI(mode) {
  var segEdit = document.getElementById('btn-mode-edit');
  var segPreview = document.getElementById('btn-mode-preview');
  var isSplit = typeof splitMode !== 'undefined' && splitMode;
  if (segEdit && segPreview) {
    if (isSplit) {
      segEdit.classList.add('active');
      segPreview.classList.add('active');
    } else if (mode === 'preview') {
      segEdit.classList.remove('active');
      segPreview.classList.add('active');
    } else {
      segEdit.classList.add('active');
      segPreview.classList.remove('active');
    }
  }
  var btnToggle = document.getElementById('btn-toggle');
  if (btnToggle) {
    btnToggle.classList.toggle('active', mode === 'preview');
  }
}
window.updateModeSwitchUI = updateModeSwitchUI;

var appToastTimer = null;
function showAppToast(text, duration) {
  var toast = (typeof $ !== 'undefined' && $.zoomToast) || document.getElementById('zoom-toast');
  if (!toast) return;
  toast.textContent = text;
  toast.classList.add('visible');
  if (appToastTimer) clearTimeout(appToastTimer);
  appToastTimer = setTimeout(function () {
    toast.classList.remove('visible');
    appToastTimer = null;
  }, duration || 1200);
}
window.showAppToast = showAppToast;

// Mode Toggle
function toggleMode() {
  if (currentMode === 'image') return;
  if (splitMode) {
    splitMode = false;
    document.body.classList.remove('split-mode');
    document.getElementById('btn-split').classList.remove('active');
    /* 退出 split，还原预览栏的弹性宽度 */
    ($.previewContainer || document.getElementById('preview-container')).style.flex = '';
  }

  var iconPreview = document.getElementById('icon-preview');
  var iconEdit = document.getElementById('icon-edit');

  if (currentMode === 'edit') {
    var editor = $.editor || document.getElementById('editor');
    var content = editor.value;
    var selectedText = content.substring(editor.selectionStart, editor.selectionEnd);
    var scrollRatio = content.length > 0 ? editor.selectionStart / content.length : 0;
    var tab = TabManager.getActiveTab();
    var previewEl = $.preview || document.getElementById('preview');
    if (tab && tab.parsedHtml) {
      previewEl.innerHTML = tab.parsedHtml;
    } else {
      var html = marked.parse(content);
      previewEl.innerHTML = html;
      if (tab) tab.parsedHtml = html;
    }
    resolveLocalImages();
    if (typeof renderMermaidCharts === 'function') renderMermaidCharts(previewEl);
    ($.editorContainer || document.getElementById('editor-container')).classList.remove('active');
    ($.previewContainer || document.getElementById('preview-container')).classList.add('active');
    document.getElementById('btn-toggle').classList.add('active');
    document.getElementById('status-mode').textContent = 'PREVIEW';
    if (iconPreview) iconPreview.style.display = 'none';
    if (iconEdit) iconEdit.style.display = '';
    currentMode = 'preview';
    updateModeSwitchUI('preview');
    setTimeout(function() {
      if (!selectedText || !selectInPreview(selectedText, scrollRatio)) {
        if (window.PreviewNavigation && typeof window.PreviewNavigation.scrollToRatio === 'function') {
          window.PreviewNavigation.scrollToRatio(scrollRatio);
        }
      }
      if (findState.open || gotoState.open) {
        syncFindContainer();
        var fi = $.findInput || document.getElementById('find-input');
        if (findState.open && fi && fi.value) doFind(fi.value);
      }
    }, 0);
  } else {
    var sel = window.getSelection();
    var selectedText = sel.toString();
    var pc = $.previewContainer || document.getElementById('preview-container');
    var scrollRatio = window.PreviewNavigation && typeof window.PreviewNavigation.getScrollRatio === 'function'
      ? window.PreviewNavigation.getScrollRatio()
      : 0;
    pc.classList.remove('active');
    ($.editorContainer || document.getElementById('editor-container')).classList.add('active');
    document.getElementById('btn-toggle').classList.remove('active');
    document.getElementById('status-mode').textContent = 'EDIT';
    if (iconPreview) iconPreview.style.display = '';
    if (iconEdit) iconEdit.style.display = 'none';
    currentMode = 'edit';
    updateModeSwitchUI('edit');
    var editor = $.editor || document.getElementById('editor');
    editor.focus();
    if (!selectedText || !selectInEditor(selectedText, scrollRatio)) {
      var pos = Math.round(scrollRatio * editor.value.length);
      editor.selectionStart = editor.selectionEnd = pos;
      editor.scrollTop = scrollRatio * (editor.scrollHeight - editor.clientHeight);
    }
    if (findState.open || gotoState.open) {
      syncFindContainer();
      if (findState.open) doFind(($.findInput || document.getElementById('find-input')).value);
    }
  }
}

function setTitle(title) {
  ($.titlebarTitle || document.getElementById('titlebar-title')).textContent = title;
}

function onFileSaved() {
  var info = document.getElementById('status-info');
  info.textContent = t('app.saved');
  setTimeout(function() { info.textContent = ''; }, 2000);
}

function showError(message) {
  var info = document.getElementById('status-info');
  info.textContent = t('app.error', { message: message });
  info.style.color = '#c15050';
  setTimeout(function() { info.textContent = ''; info.style.color = ''; }, 5000);
}

// Split View
function toggleSplit() {
  if (currentMode === 'image') return;
  var iconPreview = document.getElementById('icon-preview');
  var iconEdit = document.getElementById('icon-edit');

  if (splitMode) {
    splitMode = false;
    document.body.classList.remove('split-mode');
    document.getElementById('btn-split').classList.remove('active');
    ($.previewContainer || document.getElementById('preview-container')).classList.remove('active');
    /* 退出 split，还原预览栏的弹性宽度 */
    ($.previewContainer || document.getElementById('preview-container')).style.flex = '';
    currentMode = 'edit';
    document.getElementById('btn-toggle').classList.remove('active');
    document.getElementById('status-mode').textContent = 'EDIT';
    if (iconPreview) iconPreview.style.display = '';
    if (iconEdit) iconEdit.style.display = 'none';
    updateModeSwitchUI('edit');
    ($.editor || document.getElementById('editor')).focus();
  } else {
    splitMode = true;
    document.body.classList.add('split-mode');
    document.getElementById('btn-split').classList.add('active');
    ($.editorContainer || document.getElementById('editor-container')).classList.add('active');
    ($.previewContainer || document.getElementById('preview-container')).classList.add('active');
    /* 恢复上次的两栏比例 */
    if (typeof applySplitRatio === 'function') applySplitRatio();
    var splitTab = TabManager.getActiveTab();
    var splitContent = ($.editor || document.getElementById('editor')).value;
    var splitPreviewEl = $.preview || document.getElementById('preview');
    if (splitTab && splitTab.parsedHtml) {
      splitPreviewEl.innerHTML = splitTab.parsedHtml;
    } else {
      var splitHtml = marked.parse(splitContent);
      splitPreviewEl.innerHTML = splitHtml;
      if (splitTab) splitTab.parsedHtml = splitHtml;
    }
    resolveLocalImages();
    if (typeof renderMermaidCharts === 'function') renderMermaidCharts(splitPreviewEl);
    currentMode = 'edit';
    document.getElementById('btn-toggle').classList.remove('active');
    document.getElementById('status-mode').textContent = 'SPLIT';
    if (iconPreview) iconPreview.style.display = '';
    if (iconEdit) iconEdit.style.display = 'none';
    updateModeSwitchUI('split');
    document.getElementById('editor').focus();
  }
}

var splitPreviewTimer = null;
function updateSplitPreview() {
  if (!splitMode || currentMode === 'image') return;
  clearTimeout(splitPreviewTimer);
  splitPreviewTimer = setTimeout(function() {
    if (!splitMode || currentMode === 'image') return;
    var tab = TabManager.getActiveTab();
    var content = ($.editor || document.getElementById('editor')).value;
    var html = marked.parse(content);
    var previewEl = $.preview || document.getElementById('preview');
    previewEl.innerHTML = html;
    if (tab) tab.parsedHtml = html;
    resolveLocalImages();
    if (typeof renderMermaidCharts === 'function') renderMermaidCharts(previewEl);
  }, 150);
}

// Word count
function updateWordCount() {
  var countEl = document.getElementById('status-counts');
  if (!countEl) return;
  var tab = typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;
  if (!tab) {
    countEl.textContent = '';
    return;
  }
  var text = ($.editor || document.getElementById('editor')).value;
  var words = text.trim() ? text.trim().split(/\s+/).length : 0;
  var key = words === 1 ? 'app.word' : 'app.words';
  countEl.textContent = t(key, { n: words });
}

// Recent Files, Recent Projects & Welcome View
function getRecentFiles() {
  try { return JSON.parse(localStorage.getItem('glancemd-ultra-recent')) || []; } catch(e) { return []; }
}

function addRecentFile(path) {
  if (!path) return;
  var recent = getRecentFiles();
  var filename = path.split(/[/\\]/).pop();
  recent = recent.filter(function(r) { return r.path.replace(/\\/g, '/').toLowerCase() !== path.replace(/\\/g, '/').toLowerCase(); });
  recent.unshift({ path: path, filename: filename });
  if (recent.length > 10) recent = recent.slice(0, 10);
  try { localStorage.setItem('glancemd-ultra-recent', JSON.stringify(recent)); } catch(e) {}
}

function getRecentProjects() {
  try { return JSON.parse(localStorage.getItem('glancemd-ultra-recent-projects')) || []; } catch(e) { return []; }
}

function addRecentProject(dirPath) {
  if (!dirPath) return;
  var norm = dirPath.replace(/\\/g, '/').replace(/\/+$/, '');
  var name = norm.split('/').pop() || norm;
  var list = getRecentProjects();
  list = list.filter(function(p) {
    return p.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() !== norm.toLowerCase();
  });
  list.unshift({ path: dirPath, name: name, ts: Date.now() });
  if (list.length > 10) list = list.slice(0, 10);
  try { localStorage.setItem('glancemd-ultra-recent-projects', JSON.stringify(list)); } catch(e) {}
}

if (typeof window !== 'undefined') {
  function initWorkspaceRecent() {
    if (window.Workspace && typeof window.Workspace.on === 'function') {
      window.Workspace.on('workspace:opened', function(data) {
        var p = data && (data.path || data.root || (typeof data === 'string' ? data : null));
        if (p) addRecentProject(p);
        if (welcomeActiveTab === 'projects') renderWelcomeRecentProjects();
      });
    }
  }
  if (window.Workspace) {
    initWorkspaceRecent();
  } else {
    document.addEventListener('DOMContentLoaded', initWorkspaceRecent);
  }
}

var welcomeActiveTab = 'projects';

function setWelcomeTab(tab) {
  welcomeActiveTab = tab;
  var btnProjects = document.getElementById('welcome-tab-projects');
  var btnFiles = document.getElementById('welcome-tab-files');
  var paneProjects = document.getElementById('welcome-projects-pane');
  var paneFiles = document.getElementById('welcome-files-pane');

  if (btnProjects) {
    btnProjects.classList.toggle('active', tab === 'projects');
    btnProjects.setAttribute('aria-selected', tab === 'projects' ? 'true' : 'false');
  }
  if (btnFiles) {
    btnFiles.classList.toggle('active', tab === 'files');
    btnFiles.setAttribute('aria-selected', tab === 'files' ? 'true' : 'false');
  }
  if (paneProjects) {
    paneProjects.style.display = tab === 'projects' ? 'block' : 'none';
  }
  if (paneFiles) {
    paneFiles.style.display = tab === 'files' ? 'block' : 'none';
  }

  if (tab === 'projects') {
    renderWelcomeRecentProjects();
  } else {
    renderWelcomeRecent();
  }
}

function renderWelcomeRecent() {
  var recentList = document.getElementById('welcome-recent-list');
  var recentEmpty = document.getElementById('welcome-recent-empty');
  if (!recentList) return;
  var recent = getRecentFiles();
  recentList.innerHTML = '';
  if (recent.length === 0) {
    if (recentEmpty) recentEmpty.style.display = 'block';
    return;
  }
  if (recentEmpty) recentEmpty.style.display = 'none';

  recent.forEach(function(r) {
    var item = document.createElement('div');
    item.className = 'welcome-recent-item';
    var name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = r.filename;
    var path = document.createElement('span');
    path.className = 'recent-path';
    path.textContent = r.path;
    item.appendChild(name);
    item.appendChild(path);
    item.addEventListener('click', function() {
      sendToRust('open_file', { path: r.path });
    });
    recentList.appendChild(item);
  });
}

function renderWelcomeRecentProjects() {
  var listEl = document.getElementById('welcome-recent-projects-list');
  var emptyEl = document.getElementById('welcome-recent-projects-empty');
  if (!listEl) return;
  var projects = getRecentProjects();
  listEl.innerHTML = '';
  if (projects.length === 0) {
    if (emptyEl) emptyEl.style.display = 'block';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  var currentRoot = (window.Workspace && typeof window.Workspace.getState === 'function' && window.Workspace.getState().root) || null;
  var normCurrent = currentRoot ? currentRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : null;

  projects.forEach(function(p) {
    var item = document.createElement('div');
    item.className = 'welcome-recent-item';
    var isCurrent = normCurrent && p.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === normCurrent;
    if (isCurrent) item.classList.add('is-current');

    var name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = p.name || p.path.split(/[/\\]/).pop();
    if (isCurrent) {
      var badge = document.createElement('span');
      badge.className = 'recent-badge';
      badge.textContent = t('welcome.currentProject');
      name.appendChild(badge);
    }

    var pathSpan = document.createElement('span');
    pathSpan.className = 'recent-path';
    pathSpan.textContent = p.path;

    item.appendChild(name);
    item.appendChild(pathSpan);

    item.addEventListener('click', function() {
      if (window.Commands && typeof window.Commands.run === 'function') {
        window.Commands.run('workspace.open', { path: p.path });
      } else {
        sendToRust('workspace.open', { path: p.path });
      }
    });
    listEl.appendChild(item);
  });
}

function updateWelcome() {
  var welcomeView = document.getElementById('welcome-view');
  var legacyPanel = document.getElementById('recent-panel');
  var tab = typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;

  if (tab) {
    if (welcomeView) {
      welcomeView.classList.remove('visible');
      welcomeView.style.display = 'none';
    }
    if (legacyPanel) legacyPanel.classList.remove('visible');
    return;
  }

  if (welcomeView) {
    welcomeView.classList.add('visible');
    welcomeView.style.display = 'flex';
    setWelcomeTab(welcomeActiveTab);
  }
  if (legacyPanel) legacyPanel.classList.remove('visible');
}

function showRecentPanel() {
  updateWelcome();
}

function doSave() {
  var tab = TabManager.getActiveTab();
  if (!tab || tab.isImage) return false;
  window.saveActiveTabAndWait();
  return true;
}

// Vim integration contract: resolve only when the exact tab/request is saved.
// A tab switch or an unrelated file_saved event cannot complete this promise.
window.saveActiveTabAndWait = function() {
  var tab = typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;
  if (!tab || tab.isImage) return Promise.resolve(false);
  var editor = document.getElementById('editor');
  var request = {
    id: ++saveRequestSeq,
    tabId: tab.id,
    path: tab.path ? String(tab.path).replace(/\\/g, '/') : '',
    content: editor ? editor.value : '',
    resolve: null
  };
  var promise = new Promise(function(resolve) { request.resolve = resolve; });
  pendingSaveRequests.push(request);
  var data = { content: request.content, requestId: request.id, tabId: request.tabId };
  if (request.path) data.path = request.path;
  sendToRust('save_file', data);
  return promise;
};

function cancelPendingSavesForTab(tabId) {
  for (var i = pendingSaveRequests.length - 1; i >= 0; i--) {
    if (pendingSaveRequests[i].tabId === tabId) pendingSaveRequests.splice(i, 1)[0].resolve(false);
  }
}

// Zoom
var zoomLevel = 1;
var ZOOM_STEP = 0.1;
var ZOOM_MIN = 0.5;
var ZOOM_MAX = 3;

function applyZoom(level) {
  zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
  document.documentElement.style.setProperty('--zoom', zoomLevel);
  var toast = $.zoomToast || document.getElementById('zoom-toast');
  toast.textContent = Math.round(zoomLevel * 100) + '%';
  toast.classList.add('visible');
  clearTimeout(applyZoom._timer);
  applyZoom._timer = setTimeout(function() {
    toast.classList.remove('visible');
  }, 800);
}

document.addEventListener('wheel', function(e) {
  if (hasPrimaryModifier(e)) {
    e.preventDefault();
    applyZoom(zoomLevel + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
  }
}, { passive: false });

// Split 分界拖拽：调整编辑/预览两栏比例（交互与 TOC 拖宽一致）
(function() {
  var handle = document.getElementById('split-resize-handle');
  var container = document.getElementById('preview-container');
  var area = document.getElementById('content');
  var MIN_PANE = 240; /* 任一栏最小宽度，保证两侧始终可用 */
  var savedRatio = null;
  try {
    var v = parseFloat(localStorage.getItem('glancemd-ultra-split-ratio'));
    if (v > 0 && v < 1) savedRatio = v;
  } catch (e) {}

  var dragging = false;

  function setPaneWidth(px) {
    container.style.flex = '0 0 ' + Math.round(px) + 'px';
  }

  function currentWidth() {
    var m = /(\d+(?:\.\d+)?)px/.exec(container.style.flex || '');
    return m ? parseFloat(m[1]) : 0;
  }

  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.classList.add('split-resizing');
  });

  document.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    var areaRect = area.getBoundingClientRect();
    /* 预览右缘贴内容区右缘，宽度 = 右缘 X - 鼠标 X */
    var width = Math.min(areaRect.width - MIN_PANE, Math.max(MIN_PANE, areaRect.right - e.clientX));
    setPaneWidth(width);
  });

  document.addEventListener('mouseup', function() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('split-resizing');
    var w = currentWidth();
    if (w > 0) {
      savedRatio = w / area.getBoundingClientRect().width;
      try { localStorage.setItem('glancemd-ultra-split-ratio', String(savedRatio)); } catch (e) {}
    }
  });

  /* 双击恢复 50/50 并清除记忆 */
  handle.addEventListener('dblclick', function() {
    container.style.flex = '';
    savedRatio = null;
    try { localStorage.removeItem('glancemd-ultra-split-ratio'); } catch (e) {}
  });

  /* 进入 split 时按记忆的比例恢复两栏宽度 */
  window.applySplitRatio = function() {
    if (!savedRatio || savedRatio <= 0 || savedRatio >= 1) return;
    var areaRect = area.getBoundingClientRect();
    if (areaRect.width < MIN_PANE * 2) return;
    var width = Math.min(areaRect.width - MIN_PANE, Math.max(MIN_PANE, areaRect.width * savedRatio));
    setPaneWidth(width);
  };
})();

// Find
var findState = { open: false, matches: [], current: -1, marks: [], lastQuery: '', incremental: false, lastMatch: null };
var gotoState = { open: false };

function syncFindContainer() {
  var findBar = document.getElementById('find-bar');
  var gotoBar = document.getElementById('goto-bar');
  var editorContainer = document.getElementById('editor-container');
  var previewContainer = document.getElementById('preview-container');
  var target = currentMode === 'edit' ? editorContainer : previewContainer;
  if (editorContainer) { editorContainer.classList.remove('find-open', 'goto-open'); }
  if (previewContainer) { previewContainer.classList.remove('find-open', 'goto-open'); }
  if (findState.open && target) {
    if (findBar.parentNode !== target) target.insertBefore(findBar, target.firstChild);
    target.classList.add('find-open');
  }
  if (gotoState.open && target) {
    if (gotoBar.parentNode !== target) target.insertBefore(gotoBar, target.firstChild);
    target.classList.add('goto-open');
  }
}

function getPreviewSelectionOffset() {
  var sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  var range = sel.getRangeAt(0);
  var preview = document.getElementById('preview');
  if (!preview || !preview.contains(range.startContainer)) return null;

  try {
    var preStartRange = document.createRange();
    preStartRange.selectNodeContents(preview);
    preStartRange.setEnd(range.startContainer, range.startOffset);
    var start = preStartRange.toString().length;

    var preEndRange = document.createRange();
    preEndRange.selectNodeContents(preview);
    preEndRange.setEnd(range.endContainer, range.endOffset);
    var end = preEndRange.toString().length;

    return {
      start: Math.min(start, end),
      end: Math.max(start, end)
    };
  } catch (e) {
    return null;
  }
}

function resolveCurrentMatchIndex(matches, anchorStart, anchorEnd) {
  if (!matches || matches.length === 0) return 0;
  if (anchorStart == null) return 0;
  // 1. 完全吻合
  for (var i = 0; i < matches.length; i++) {
    var m = matches[i];
    if (m && typeof m === 'object' && m.start === anchorStart && m.end === anchorEnd) return i;
  }
  // 2. 锚点落在匹配项区间内
  for (var j = 0; j < matches.length; j++) {
    var mj = matches[j];
    if (mj && typeof mj === 'object' && anchorStart >= mj.start && anchorStart <= mj.end) return j;
  }
  // 3. 寻找锚点之后的第一个匹配项
  for (var k = 0; k < matches.length; k++) {
    var mk = matches[k];
    if (mk && typeof mk === 'object' && mk.start >= anchorStart) return k;
  }
  return 0;
}

function openFind(options) {
  if (currentMode === 'image') return;
  options = options || {};
  var bar = document.getElementById('find-bar');
  var input = document.getElementById('find-input');
  var editor = document.getElementById('editor');
  var anchorStart = null;
  var anchorEnd = null;
  var preserveCurrent = false;
  findState.incremental = false;
  bar.classList.add('open');
  findState.open = true;
  syncFindContainer();
  if (options.query != null) {
    input.value = String(options.query);
  } else if (currentMode === 'edit') {
    if (editor && editor.selectionStart !== editor.selectionEnd) {
      input.value = editor.value.slice(editor.selectionStart, editor.selectionEnd);
      anchorStart = editor.selectionStart;
      anchorEnd = editor.selectionEnd;
    } else {
      var candidateQuery = findState.lastQuery || input.value || '';
      input.value = candidateQuery;
      if (candidateQuery && candidateQuery === findState.lastQuery && findState.lastMatch) {
        preserveCurrent = true;
      } else if (editor) {
        anchorStart = editor.selectionStart;
        anchorEnd = editor.selectionEnd;
      }
    }
  } else {
    // preview 模式：从 window.getSelection() 提取选中文字及全局字符锚点
    var winSel = typeof window.getSelection === 'function' ? window.getSelection().toString() : '';
    if (winSel) {
      input.value = winSel;
      var previewSel = getPreviewSelectionOffset();
      if (previewSel) {
        anchorStart = previewSel.start;
        anchorEnd = previewSel.end;
      }
    } else {
      input.value = findState.lastQuery || input.value || '';
    }
  }
  if (currentMode === 'edit' && editor && editor.selectionStart !== editor.selectionEnd && input.value === editor.value.slice(editor.selectionStart, editor.selectionEnd)) {
    findState.lastMatch = { start: editor.selectionStart, end: editor.selectionEnd };
  }
  input.placeholder = 'Find...';
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  findState.lastQuery = input.value;
  if (input.value) {
    doFind(input.value, { preserveFocus: true, anchorStart: anchorStart, anchorEnd: anchorEnd, preserveCurrent: preserveCurrent });
    if (findState.matches.length > 0 && findState.current >= 0) {
      showMatchBadge(findState.current, findState.matches.length);
    }
  }
}

function clearEditorFindMarkers() {
  var markersEl = document.getElementById('editor-find-markers');
  if (markersEl) {
    markersEl.innerHTML = '';
  }
}

function updateEditorFindMarkers(recalc) {
  var container = document.getElementById('editor-container');
  var editor = document.getElementById('editor');
  if (!container || !editor) return;

  var markersEl = document.getElementById('editor-find-markers');
  if (!markersEl) {
    markersEl = document.createElement('div');
    markersEl.id = 'editor-find-markers';
    markersEl.setAttribute('aria-hidden', 'true');
    container.appendChild(markersEl);
  }

  if (!findState.open || currentMode !== 'edit' || !findState.matches || findState.matches.length === 0) {
    markersEl.innerHTML = '';
    return;
  }

  var nav = window.EditorNavigation;
  if (!nav || typeof nav.measureOffsetCoordinates !== 'function') {
    markersEl.innerHTML = '';
    return;
  }

  var edTop = editor.offsetTop || 0;
  var edLeft = editor.offsetLeft || 0;
  var sTop = editor.scrollTop || 0;
  var sLeft = editor.scrollLeft || 0;
  var clientHeight = editor.clientHeight || 400;
  var fullText = editor.value || '';

  var fragment = document.createDocumentFragment();

  for (var i = 0; i < findState.matches.length; i++) {
    var match = findState.matches[i];
    if (!match || typeof match.start !== 'number' || typeof match.end !== 'number') continue;

    if (recalc || !match._coords) {
      var startCoords = nav.measureOffsetCoordinates(match.start);
      if (!startCoords) continue;
      var endCoords = match.end > match.start ? nav.measureOffsetCoordinates(match.end) : startCoords;
      var isSameLine = endCoords && Math.abs(endCoords.markerTop - startCoords.markerTop) < 5;
      var w = isSameLine
        ? Math.max(startCoords.width || 8, endCoords.markerLeft - startCoords.markerLeft)
        : Math.max(startCoords.width || 8, (match.end - match.start) * (startCoords.width || 8.5));
      match._coords = {
        markerLeft: startCoords.markerLeft,
        markerTop: startCoords.markerTop,
        width: w,
        height: startCoords.height || startCoords.lineHeight || 25,
        text: fullText.slice(match.start, match.end)
      };
    }

    var c = match._coords;
    var top = c.markerTop + edTop - sTop;
    var left = c.markerLeft + edLeft - sLeft;

    if (top + c.height < -50 || top > clientHeight + 50) continue;

    var marker = document.createElement('div');
    marker.className = 'find-match-marker';
    marker.style.left = left + 'px';
    marker.style.top = top + 'px';
    marker.style.width = c.width + 'px';
    marker.style.height = c.height + 'px';

    if (i === findState.current) {
      marker.classList.add('active-match');
    }

    fragment.appendChild(marker);
  }

  markersEl.innerHTML = '';
  markersEl.appendChild(fragment);
}
window.updateEditorFindMarkers = updateEditorFindMarkers;

function closeFind() {
  var input = document.getElementById('find-input');
  if (input.value) findState.lastQuery = input.value;
  document.getElementById('find-bar').classList.remove('open');
  findState.open = false;
  findState.incremental = false;
  syncFindContainer();
  findState.matches = [];
  findState.current = -1;
  clearPreviewHighlights();
  clearEditorFindMarkers();
  document.getElementById('find-count').textContent = '';
  if (currentMode === 'edit') {
    var editor = document.getElementById('editor');
    if (findState.lastMatch) {
      editor.focus();
      editor.setSelectionRange(findState.lastMatch.start, findState.lastMatch.end);
    } else editor.focus();
  } else {
    if (window.PreviewNavigation && typeof window.PreviewNavigation.focus === 'function') {
      window.PreviewNavigation.focus();
    }
  }
}

function doFind(term, options) {
  options = options || {};
  if (String(term || '')) findState.lastQuery = String(term);
  findState.matches = [];
  findState.current = -1;
  clearPreviewHighlights();
  clearEditorFindMarkers();
  if (!term) {
    ($.findCount || document.getElementById('find-count')).textContent = '';
    return;
  }
  if (currentMode === 'edit') {
    var text = ($.editor || document.getElementById('editor')).value.toLowerCase();
    var termLower = term.toLowerCase();
    var idx = 0;
    while ((idx = text.indexOf(termLower, idx)) !== -1) {
      findState.matches.push({ start: idx, end: idx + term.length });
      idx += term.length;
    }
  } else {
    var preview = $.preview || document.getElementById('preview');
    var walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
    var node, matchInfos = [], termLower = term.toLowerCase();
    var fullCharOffset = 0;
    while (node = walker.nextNode()) {
      var nodeText = node.textContent.toLowerCase();
      var idx = 0;
      while ((idx = nodeText.indexOf(termLower, idx)) !== -1) {
        var range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + term.length);
        matchInfos.push({
          range: range,
          start: fullCharOffset + idx,
          end: fullCharOffset + idx + term.length
        });
        idx += term.length;
      }
      fullCharOffset += node.textContent.length;
    }
    for (var i = matchInfos.length - 1; i >= 0; i--) {
      var mark = document.createElement('mark');
      mark.className = 'find-match';
      matchInfos[i].range.surroundContents(mark);
      findState.marks.unshift(mark);
      matchInfos[i].mark = mark;
    }
    findState.matches = matchInfos;
  }
  if (findState.matches.length > 0) {
    var initial = 0;
    if (options.anchorStart != null) {
      initial = resolveCurrentMatchIndex(findState.matches, options.anchorStart, options.anchorEnd);
    } else if (options.preserveCurrent && findState.lastMatch) {
      var matchIdx = findState.matches.findIndex(function(match) {
        return match && match.start === findState.lastMatch.start && match.end === findState.lastMatch.end;
      });
      if (matchIdx >= 0) initial = matchIdx;
    }
    if (!options.silent) {
      goToMatch(initial, { keepFocus: Boolean(options.preserveFocus) });
    } else {
      updateEditorFindMarkers();
    }
  } else {
    updateEditorFindMarkers();
  }
  updateFindCount();
}

function clearPreviewHighlights() {
  findState.marks.forEach(function(mark) {
    var parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
  findState.marks = [];
}

var matchBadgeTimer = null;
function showMatchBadge(current, total) {
  if (total <= 0 || current < 0) return;
  var badge = document.getElementById('find-match-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'find-match-badge';
    badge.className = 'find-match-badge';
    document.body.appendChild(badge);
  }
  badge.textContent = (current + 1) + ' / ' + total;
  badge.classList.add('visible');
  clearTimeout(matchBadgeTimer);
  matchBadgeTimer = setTimeout(function() {
    badge.classList.remove('visible');
  }, 1500);
}
window.showMatchBadge = showMatchBadge;

function triggerWordFlash(start, end) {
  var container = document.getElementById('editor-container');
  var editor = document.getElementById('editor');
  if (!container || !editor) return;
  var nav = window.EditorNavigation;
  if (!nav || typeof nav.measureOffsetCoordinates !== 'function') return;
  var coords = nav.measureOffsetCoordinates(start);
  if (!coords) return;
  var endCoords = typeof end === 'number' ? nav.measureOffsetCoordinates(end) : null;

  var old = container.querySelector('.find-word-flash');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  var flash = document.createElement('div');
  flash.className = 'find-word-flash';
  flash.style.left = coords.left + 'px';
  flash.style.top = coords.top + 'px';
  var width = endCoords ? Math.max(12, endCoords.left - coords.left) : (coords.width || 12);
  flash.style.width = width + 'px';
  flash.style.height = (coords.height || coords.lineHeight || 20) + 'px';
  container.appendChild(flash);

  flash.addEventListener('animationend', function() {
    if (flash.parentNode) flash.parentNode.removeChild(flash);
  });
  setTimeout(function() {
    if (flash.parentNode) flash.parentNode.removeChild(flash);
  }, 1500);
}

function goToMatch(idx, options) {
  options = options || {};
  if (idx == null || idx < 0 || idx >= findState.matches.length || findState.matches[idx] === undefined) return false;
  findState.current = idx;
  if (currentMode === 'edit') {
    var match = findState.matches[idx];
    findState.lastMatch = { start: match.start, end: match.end };
    var editor = document.getElementById('editor');
    var input = document.getElementById('find-input');
    if (editor) {
      editor.focus();
      editor.setSelectionRange(match.start, match.end);
      var navigation = window.EditorNavigation;
      if (navigation && typeof navigation.scrollToOffset === 'function') {
        navigation.scrollToOffset(match.start, match.end);
      }
    }
    updateEditorFindMarkers();
    if (options.keepFocus && input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  } else {
    var previewMatch = findState.matches[idx];
    if (previewMatch && typeof previewMatch === 'object') {
      findState.lastMatch = { start: previewMatch.start, end: previewMatch.end };
    }
    findState.marks.forEach(function(m) { m.classList.remove('find-active'); });
    var mark = findState.marks[idx];
    if (mark) {
      mark.classList.add('find-active');
      if (window.PreviewNavigation && typeof window.PreviewNavigation.scrollToElement === 'function') {
        window.PreviewNavigation.scrollToElement(mark, { block: 'center' });
      }
      var sel = window.getSelection();
      if (sel && typeof sel.removeAllRanges === 'function') {
        try {
          var r = document.createRange();
          r.selectNodeContents(mark);
          sel.removeAllRanges();
          sel.addRange(r);
        } catch (e) {}
      }
    }
    var previewInput = document.getElementById('find-input');
    if (options.keepFocus && previewInput) {
      previewInput.focus();
      previewInput.setSelectionRange(previewInput.value.length, previewInput.value.length);
    }
  }
  updateFindCount();
  return true;
}

function findNext() {
  if (findState.matches.length === 0) return;
  var isFindInput = (document.activeElement && document.activeElement.id === 'find-input') || (findState.open && document.getElementById('find-input'));
  var nextIdx = (findState.current + 1) % findState.matches.length;
  goToMatch(nextIdx, { keepFocus: Boolean(isFindInput) });
  if (isFindInput) {
    showMatchBadge(findState.current, findState.matches.length);
  }
}

function findPrev() {
  if (findState.matches.length === 0) return;
  var isFindInput = (document.activeElement && document.activeElement.id === 'find-input') || (findState.open && document.getElementById('find-input'));
  var prevIdx = (findState.current - 1 + findState.matches.length) % findState.matches.length;
  goToMatch(prevIdx, { keepFocus: Boolean(isFindInput) });
  if (isFindInput) {
    showMatchBadge(findState.current, findState.matches.length);
  }
}

function findFromEditor(direction) {
  var editor = document.getElementById('editor');
  var input = document.getElementById('find-input');
  var query = '';
  var anchorStart = null;
  var anchorEnd = null;

  if (currentMode === 'edit') {
    if (editor && editor.selectionStart !== editor.selectionEnd) {
      query = editor.value.slice(editor.selectionStart, editor.selectionEnd);
      anchorStart = editor.selectionStart;
      anchorEnd = editor.selectionEnd;
    } else {
      query = findState.lastQuery || (input && input.value ? input.value : '');
    }
  } else {
    var winSel = typeof window.getSelection === 'function' ? window.getSelection().toString() : '';
    if (winSel) {
      query = winSel;
      var previewSel = getPreviewSelectionOffset();
      if (previewSel) {
        anchorStart = previewSel.start;
        anchorEnd = previewSel.end;
      }
    } else {
      query = findState.lastQuery || (input && input.value ? input.value : '');
    }
  }
  if (!query) return false;

  var isSameQuery = Boolean(findState.lastQuery &&
    findState.lastQuery.toLowerCase() === query.toLowerCase() &&
    findState.matches && findState.matches.length > 0);
  findState.lastQuery = query;
  if (input) input.value = query;

  // 1. 若查找栏未打开：静默查找（绝不主动弹出查找条），提取选区或上次 query 进行推进
  if (!findState.open) {
    if (!isSameQuery) {
      doFind(query, { preserveFocus: false, silent: true, anchorStart: anchorStart, anchorEnd: anchorEnd });
    }
    if (findState.matches && findState.matches.length > 0) {
      var curIdx = 0;
      if (anchorStart != null) {
        curIdx = resolveCurrentMatchIndex(findState.matches, anchorStart, anchorEnd);
      } else if (currentMode === 'edit' && editor) {
        curIdx = resolveCurrentMatchIndex(findState.matches, editor.selectionStart, editor.selectionEnd);
      } else {
        curIdx = findState.current >= 0 ? findState.current : 0;
      }
      var targetIdx = (curIdx + (direction > 0 ? 1 : -1) + findState.matches.length) % findState.matches.length;
      goToMatch(targetIdx, { keepFocus: false });
      showMatchBadge(targetIdx, findState.matches.length);
    }
    if (currentMode === 'edit') {
      if (editor) editor.focus();
    } else if (window.PreviewNavigation && typeof window.PreviewNavigation.focus === 'function') {
      window.PreviewNavigation.focus();
    }
    return true;
  }

  // 2. 若查找栏已打开：在已开状态下推进
  var queryChanged = input && input.value.toLowerCase() !== query.toLowerCase();
  if (queryChanged) {
    input.value = query;
    doFind(query, { preserveFocus: true, anchorStart: anchorStart, anchorEnd: anchorEnd });
  }

  if (findState.matches.length > 0) {
    var curIdxOpened = 0;
    if (anchorStart != null) {
      curIdxOpened = resolveCurrentMatchIndex(findState.matches, anchorStart, anchorEnd);
    } else if (currentMode === 'edit' && editor) {
      curIdxOpened = resolveCurrentMatchIndex(findState.matches, editor.selectionStart, editor.selectionEnd);
    } else {
      curIdxOpened = findState.current >= 0 ? findState.current : 0;
    }
    var nextIdx = (curIdxOpened + (direction > 0 ? 1 : -1) + findState.matches.length) % findState.matches.length;
    goToMatch(nextIdx, { keepFocus: false });
    showMatchBadge(nextIdx, findState.matches.length);
  }
  if (currentMode === 'edit') {
    if (editor) editor.focus();
  } else if (window.PreviewNavigation && typeof window.PreviewNavigation.focus === 'function') {
    window.PreviewNavigation.focus();
  }
  return true;
}

function incrementalFind(direction) {
  var input = document.getElementById('find-input');
  if (!input) return false;
  if (!findState.open || !findState.incremental) {
    openFind({ query: '' });
    findState.incremental = true;
    input.placeholder = direction > 0 ? '增量查找（向前）' : '增量查找（向后）';
    input.setAttribute('aria-label', input.placeholder);
  }
  input.focus();
  return true;
}

function openGotoLine() {
  var input = document.getElementById('goto-input');
  var editor = document.getElementById('editor');
  if (!input || !editor) return false;
  var line = editor.value.slice(0, editor.selectionStart).split('\n').length;
  var max = editor.value.split('\n').length;
  gotoState.open = true;
  document.getElementById('goto-bar').classList.add('open');
  syncFindContainer();
  input.value = String(line);
  input.removeAttribute('aria-invalid');
  var hint = document.getElementById('goto-hint');
  hint.classList.remove('invalid');
  hint.textContent = '共 ' + max + ' 行';
  input.focus();
  input.select();
  return true;
}

function closeGotoLine() {
  gotoState.open = false;
  var bar = document.getElementById('goto-bar');
  if (bar) bar.classList.remove('open');
  syncFindContainer();
  var editor = document.getElementById('editor');
  if (editor) editor.focus();
}

function commitGotoLine() {
  var input = document.getElementById('goto-input');
  var editor = document.getElementById('editor');
  if (!input || !editor) return false;
  var raw = String(input.value || '').trim();
  var line = Number(raw);
  var max = editor.value.split('\n').length;
  var hint = document.getElementById('goto-hint');
  if (!/^\d+$/.test(raw) || line < 1 || line > max) {
    input.setAttribute('aria-invalid', 'true');
    hint.classList.add('invalid');
    hint.textContent = '请输入 1–' + max + ' 的行号';
    input.focus();
    input.select();
    return false;
  }
  input.removeAttribute('aria-invalid');
  closeGotoLine();
  return window.EditorNavigation ? window.EditorNavigation.scrollToLine(line - 1) : false;
}

function updateFindCount() {
  var el = document.getElementById('find-count');
  if (findState.matches.length === 0) {
    el.textContent = document.getElementById('find-input').value ? t('app.noResults') : '';
  } else {
    el.textContent = (findState.current + 1) + ' of ' + findState.matches.length;
  }
}

document.getElementById('find-input').addEventListener('input', function() {
  doFind(this.value, { preserveFocus: true });
});
document.getElementById('find-input').addEventListener('keydown', function(e) {
  if (e.key === 'Escape') { closeFind(); e.preventDefault(); }
  else if (e.key === 'Enter' && !e.shiftKey) { findNext(); e.preventDefault(); }
  else if (e.key === 'Enter' && e.shiftKey) { findPrev(); e.preventDefault(); }
  else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'k') { e.stopPropagation(); findFromEditor(-1); e.preventDefault(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.stopPropagation(); findFromEditor(1); e.preventDefault(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.stopPropagation(); openGotoLine(); e.preventDefault(); }
});
document.getElementById('goto-input').addEventListener('keydown', function(e) {
  if (e.key === 'Escape') { closeGotoLine(); e.preventDefault(); }
  else if (e.key === 'Enter') { commitGotoLine(); e.preventDefault(); }
});
document.getElementById('find-close').addEventListener('click', closeFind);
document.getElementById('goto-close').addEventListener('click', closeGotoLine);
document.getElementById('goto-btn-go').addEventListener('click', commitGotoLine);
document.getElementById('find-next').addEventListener('click', findNext);
document.getElementById('find-prev').addEventListener('click', findPrev);

var editorFindTarget = document.getElementById('editor');
if (editorFindTarget) {
  editorFindTarget.addEventListener('scroll', function() {
    if (findState && findState.open && currentMode === 'edit' && findState.matches && findState.matches.length > 0) {
      updateEditorFindMarkers();
    }
  });
  editorFindTarget.addEventListener('input', function() {
    if (findState && findState.open && currentMode === 'edit') {
      var fi = document.getElementById('find-input');
      if (fi && fi.value) {
        doFind(fi.value, { preserveFocus: true, preserveCurrent: true });
      }
    }
  });
}
window.addEventListener('resize', function() {
  if (findState && findState.open && currentMode === 'edit' && findState.matches && findState.matches.length > 0) {
    updateEditorFindMarkers(true);
  }
});

// 全局 Esc 调度总线：无论当前焦点在输入框还是编辑器，按 Esc 均优先无条件关闭转到行条与查找条，并归还编辑器焦点
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    if (gotoState && gotoState.open) {
      closeGotoLine();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (findState && findState.open) {
      closeFind();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }
  // 多面板智能 PageUp / PageDown 视口翻页，并严格杜绝顶层网页滚动穿透
  if (e.key === 'PageUp' || e.key === 'PageDown') {
    e.preventDefault();
    var dir = e.key === 'PageDown' ? 1 : -1;
    var activeEl = document.activeElement;

    var isTreeFocus = (activeEl && (activeEl.id === 'project-tree-root' || (activeEl.closest && activeEl.closest('#project-tree-root')))) ||
      (window.contextKeys && typeof window.contextKeys.get === 'function' && window.contextKeys.get('projectTreeFocus'));

    var isOutlineFocus = (activeEl && (activeEl.id === 'outline-root' || (activeEl.closest && activeEl.closest('#outline-root')))) ||
      (window.contextKeys && typeof window.contextKeys.get === 'function' && window.contextKeys.get('outlineFocus'));

    var isPreviewFocus = (activeEl && (activeEl.id === 'preview-wrapper' || (activeEl.closest && activeEl.closest('#preview-container'))));

    if (isTreeFocus) {
      var tree = document.getElementById('project-tree-root');
      if (tree) tree.scrollTop += dir * Math.max(40, (tree.clientHeight || 300) - 40);
    } else if (isOutlineFocus) {
      var outline = document.getElementById('outline-root');
      if (outline) outline.scrollTop += dir * Math.max(40, (outline.clientHeight || 300) - 40);
    } else if (currentMode === 'preview' || isPreviewFocus) {
      if (window.PreviewNavigation && typeof window.PreviewNavigation.scrollByPage === 'function') {
        window.PreviewNavigation.scrollByPage(dir);
      }
    } else {
      var ed = document.getElementById('editor');
      if (ed) ed.scrollTop = Math.max(0, ed.scrollTop + dir * Math.max(40, (ed.clientHeight || 400) - 40));
    }
  }
}, true);

// Keyboard Shortcuts: legacy document keydown block is removed in favor of
// unified BindingService / Keybindings dispatcher. Only keep find-input local keys.
function initAppCommands() {
  if (!window.Commands || typeof window.Commands.register !== 'function') return;
  var reg = window.Commands.register;
  function safeReg(id, def) {
    if (!window.Commands.has(id)) reg(id, def);
  }

  safeReg('file.new', {
    label: '新建文件',
    category: 'File',
    run: function() { TabManager.createTab(null, ''); }
  });
  safeReg('file.save', {
    label: '保存',
    category: 'File',
    run: function() { doSave(); }
  });
  safeReg('file.saveAs', {
    label: '另存为…',
    category: 'File',
    run: function() {
      if (currentMode === 'image') return;
      sendToRust('save_as', { content: document.getElementById('editor').value });
    }
  });
  safeReg('file.saveAll', {
    label: '保存全部',
    category: 'File',
    run: function() {
      if (typeof TabManager !== 'undefined' && TabManager.hasAnyDirty()) {
        doSave();
      }
    }
  });
  safeReg('file.close', {
    label: '关闭标签页',
    category: 'File',
    run: function() {
      var active = typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;
      if (active) TabManager.closeTab(active.id);
    }
  });
  safeReg('editor.togglePreview', {
    label: '切换编辑/预览',
    category: 'View',
    run: function() { toggleMode(); }
  });
  safeReg('editor.toggleSplit', {
    label: '切换分屏视图',
    category: 'View',
    run: function() { toggleSplit(); }
  });
  safeReg('actions.find', {
    label: '在文档中查找',
    category: 'Edit',
    run: function() { openFind(); }
  });
  safeReg('actions.find.next', {
    label: '查找下一个',
    category: 'Edit',
    run: function() {
      return document.activeElement && document.activeElement.id === 'find-input' ? findNext() : findFromEditor(1);
    }
  });
  safeReg('actions.find.previous', {
    label: '查找上一个',
    category: 'Edit',
    run: function() {
      return document.activeElement && document.activeElement.id === 'find-input' ? findPrev() : findFromEditor(-1);
    }
  });
  safeReg('actions.find.incrementalNext', {
    label: '增量查找（向前）',
    category: 'Edit',
    run: function() { return incrementalFind(1); }
  });
  safeReg('actions.find.incrementalPrevious', {
    label: '增量查找（向后）',
    category: 'Edit',
    run: function() { return incrementalFind(-1); }
  });
  safeReg('editor.goToLine', {
    label: '转到行',
    category: 'Navigation',
    run: function() { return openGotoLine(); }
  });
  safeReg('outline.quickOpen', {
    label: '大纲',
    category: 'Navigation',
    run: function() {
      if (window.QuickOutline && typeof window.QuickOutline.toggle === 'function') {
        return window.QuickOutline.toggle();
      }
      return false;
    }
  });
  safeReg('actions.find.close', {
    label: '关闭查找',
    category: 'Edit',
    visibleInPalette: false,
    run: function() { closeFind(); }
  });
  safeReg('actions.find.next', {
    label: '查找下一个',
    category: 'Edit',
    run: function() {
      return document.activeElement && document.activeElement.id === 'find-input' ? findNext() : findFromEditor(1);
    }
  });
  safeReg('actions.find.previous', {
    label: '查找上一个',
    category: 'Edit',
    run: function() {
      return document.activeElement && document.activeElement.id === 'find-input' ? findPrev() : findFromEditor(-1);
    }
  });
  safeReg('window.zoomIn', {
    label: '放大',
    category: 'View',
    run: function() { applyZoom(zoomLevel + ZOOM_STEP); }
  });
  safeReg('window.zoomOut', {
    label: '缩小',
    category: 'View',
    run: function() { applyZoom(zoomLevel - ZOOM_STEP); }
  });
  safeReg('window.zoomReset', {
    label: '重置缩放',
    category: 'View',
    run: function() { applyZoom(1); }
  });
  safeReg('appearance.toggleTheme', {
    label: '切换主题',
    category: 'Appearance',
    run: function() {
      var current = document.documentElement.getAttribute('data-theme') || 'light';
      var next = current === 'dark' ? 'light' : 'dark';
      if (window.ipc && window.ipc.postMessage) {
        window.ipc.postMessage(JSON.stringify({ command: 'workspace.settings.set-theme', theme: next }));
      }
      setTheme(next);
    }
  });
}

document.addEventListener('DOMContentLoaded', initAppCommands);

// Window Controls
document.getElementById('btn-minimize').addEventListener('click', function() { sendToRust('window_minimize'); });
document.getElementById('btn-maximize').addEventListener('click', function() { sendToRust('window_maximize'); });
function requestCloseWindow() {
  var settings = window.SettingsApply && typeof window.SettingsApply.get === 'function'
    ? window.SettingsApply.get()
    : {};
  var shouldConfirm = !settings.recovery || settings.recovery.confirmCloseDirty !== false;
  if (typeof TabManager !== 'undefined' && TabManager.hasAnyDirty && TabManager.hasAnyDirty() && shouldConfirm) {
    if (window.ConfirmDialog && typeof window.ConfirmDialog.show === 'function') {
      window.ConfirmDialog.show({
        title: t('app.unsavedCloseTitle') || '未保存的修改',
        message: t('app.unsavedClose') || '有未保存的修改，确定关闭窗口吗？',
        confirmText: t('app.confirmDiscardClose'),
        cancelText: t('app.cancel'),
        danger: true
      }).then(function(confirmed) {
        if (confirmed) sendToRust('window_close');
      });
      return;
    } else if (typeof confirm === 'function' && !confirm(t('app.unsavedClose'))) {
      return;
    }
  }
  sendToRust('window_close');
}
window.requestCloseWindow = requestCloseWindow;

document.getElementById('btn-close').addEventListener('click', requestCloseWindow);

// Toolbar Buttons
document.getElementById('btn-new').addEventListener('click', function() {
  if (window.Commands && Commands.has('file.new')) Commands.run('file.new');
  else TabManager.createTab(null, '');
});
document.getElementById('btn-open').addEventListener('click', function() {
  if (window.Commands && Commands.has('workspace.open')) Commands.run('workspace.open');
  else sendToRust('workspace.open');
});
document.getElementById('btn-save').addEventListener('click', function() {
  if (window.Commands && Commands.has('file.save')) Commands.run('file.save');
  else doSave();
});
var btnToggleEl = document.getElementById('btn-toggle');
if (btnToggleEl) {
  btnToggleEl.addEventListener('click', function(e) {
    var target = e.target && e.target.closest ? e.target.closest('#btn-mode-edit, #btn-mode-preview') : null;
    if (target && target.id === 'btn-mode-edit') {
      if (currentMode === 'image') return;
      if (splitMode) {
        toggleSplit();
      } else if (currentMode === 'preview') {
        if (window.Commands && Commands.has('editor.togglePreview')) Commands.run('editor.togglePreview');
        else toggleMode();
      } else {
        var ed = (typeof $ !== 'undefined' && $.editor) || document.getElementById('editor');
        if (ed) ed.focus();
      }
      return;
    }
    if (target && target.id === 'btn-mode-preview') {
      if (currentMode === 'image') return;
      if (splitMode) {
        toggleSplit();
      } else if (currentMode === 'edit') {
        if (window.Commands && Commands.has('editor.togglePreview')) Commands.run('editor.togglePreview');
        else toggleMode();
      } else {
        if (window.Commands && Commands.has('editor.togglePreview')) Commands.run('editor.togglePreview');
        else toggleMode();
      }
      return;
    }
    if (window.Commands && Commands.has('editor.togglePreview')) Commands.run('editor.togglePreview');
    else toggleMode();
  });
}
var btnWordWrap = document.getElementById('btn-word-wrap');
if (btnWordWrap) {
  btnWordWrap.addEventListener('click', function() {
    if (window.Commands && Commands.has('editor.toggleWrap')) Commands.run('editor.toggleWrap');
    else if (typeof toggleEditorWrap === 'function') toggleEditorWrap();
  });
}
document.getElementById('btn-split').addEventListener('click', function() {
  if (window.Commands && Commands.has('editor.toggleSplit')) Commands.run('editor.toggleSplit');
  else toggleSplit();
});
var btnToc = document.getElementById('btn-toc');
if (btnToc) {
  btnToc.addEventListener('click', function() {
    if (window.Commands && Commands.has('outline.toggle')) Commands.run('outline.toggle');
    else if (window.LayoutUI && typeof window.LayoutUI.toggle === 'function') {
      window.LayoutUI.toggle('outline');
    }
  });
}

// Theme Toggle
function setTheme(theme) {
  if (window.SettingsApply && typeof window.SettingsApply.applyTheme === 'function') {
    window.SettingsApply.applyTheme(theme);
  } else {
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  }
  var resolved = document.documentElement.getAttribute('data-theme') || 'light';
  document.getElementById('icon-sun').style.display = resolved === 'light' ? '' : 'none';
  document.getElementById('icon-moon').style.display = resolved === 'light' ? 'none' : '';
  // Mermaid 图表按主题重新配色
  if (typeof reRenderAllMermaid === 'function') {
    reRenderAllMermaid();
  }
}

document.getElementById('btn-theme').addEventListener('click', function() {
  var effective = window.SettingsApply && typeof window.SettingsApply.get === 'function'
    ? window.SettingsApply.get()
    : {};
  var requested = effective.appearance && effective.appearance.theme;
  // 工具栏是当前实际渲染主题的切换器；effective 仅用于识别 system 模式，
  // 避免 settings.changed 尚未回执时连续点击始终基于旧值计算。
  var current = document.documentElement.getAttribute('data-theme') || 'light';
  if (requested === 'system') {
    current = document.documentElement.getAttribute('data-theme') || 'light';
  }
  var next = current === 'dark' ? 'light' : 'dark';
  if (window.ipc && window.ipc.postMessage) {
    window.ipc.postMessage(JSON.stringify({ command: 'workspace.settings.set-theme', theme: next }));
  }
  setTheme(next);
});

// Image viewer controls
(function() {
  var btnIn = document.getElementById('btn-img-zoom-in');
  var btnOut = document.getElementById('btn-img-zoom-out');
  var btnReset = document.getElementById('btn-img-zoom-reset');
  var btnActual = document.getElementById('btn-img-zoom-actual');
  var img = document.getElementById('image-preview');
  var stage = document.getElementById('image-stage');

  if (btnIn) {
    btnIn.addEventListener('click', function() {
      var tab = TabManager.getActiveTab();
      applyImageZoom(tab, currentImageZoom + 0.25);
    });
  }
  if (btnOut) {
    btnOut.addEventListener('click', function() {
      var tab = TabManager.getActiveTab();
      applyImageZoom(tab, currentImageZoom - 0.25);
    });
  }
  if (btnReset) {
    btnReset.addEventListener('click', function() {
      var tab = TabManager.getActiveTab();
      applyImageZoom(tab, null);
    });
  }
  if (btnActual) {
    btnActual.addEventListener('click', function() {
      var tab = TabManager.getActiveTab();
      applyImageZoom(tab, 1);
    });
  }

  if (img) {
    img.addEventListener('dblclick', function() {
      var tab = TabManager.getActiveTab();
      applyImageZoom(tab, tab.imageZoom == null ? 1 : null);
    });
  }

  if (stage) {
    stage.addEventListener('wheel', function(e) {
      if (!hasPrimaryModifier(e)) return;
      e.preventDefault();
      var tab = TabManager.getActiveTab();
      var delta = e.deltaY < 0 ? 0.15 : -0.15;
      applyImageZoom(tab, currentImageZoom + delta);
    }, { passive: false });
  }
  window.addEventListener('resize', function() {
    var tab = TabManager.getActiveTab();
    if (tab && tab.isImage && tab.imageZoom == null) applyImageZoom(tab, null);
  });
})();

// Init
document.addEventListener('DOMContentLoaded', function() {
  // 外部修改自动重载订阅（BUG-001）：workspace.js 晚于 app.js 加载，
  // 因此挂在这个 DOMContentLoaded 时机（此时全部脚本已执行完毕）。
  // 仅 clean tab 发起 file.reload 读回；dirty tab 由 recovery.js 冲突横幅负责。
  if (window.Workspace && typeof window.Workspace.on === 'function') {
    window.Workspace.on('workspace:file-changed', function(data) {
      if (!data || !data.path) return;
      if (String(data.kind || '').toLowerCase() !== 'modified') return;
      var tab = TabManager.findTabByPath(data.path);
      if (!tab || tab.dirty || tab.isImage) return;
      sendToRust('file.reload', { path: data.path });
    });
  }
  var wBtnNew = document.getElementById('welcome-btn-new');
  if (wBtnNew) {
    wBtnNew.addEventListener('click', function() { TabManager.createTab(null, ''); });
  }
  var wBtnOpenFile = document.getElementById('welcome-btn-open-file');
  if (wBtnOpenFile) {
    wBtnOpenFile.addEventListener('click', function() {
      if (window.Commands && Commands.has && Commands.has('file.open')) Commands.run('file.open');
      else sendToRust('open_file');
    });
  }
  var wBtnOpenFolder = document.getElementById('welcome-btn-open-folder');
  if (wBtnOpenFolder) {
    wBtnOpenFolder.addEventListener('click', function() {
      if (window.Commands && Commands.has && Commands.has('workspace.open')) Commands.run('workspace.open');
      else sendToRust('open_file');
    });
  }

  var wTabProjects = document.getElementById('welcome-tab-projects');
  if (wTabProjects) {
    wTabProjects.addEventListener('click', function() {
      setWelcomeTab('projects');
    });
  }
  var wTabFiles = document.getElementById('welcome-tab-files');
  if (wTabFiles) {
    wTabFiles.addEventListener('click', function() {
      setWelcomeTab('files');
    });
  }

  if (isMacOS) {
    document.querySelectorAll('[title*="Ctrl+"]').forEach(function(element) {
      element.title = element.title.replaceAll('Ctrl+', '⌘');
    });
    document.querySelectorAll('.welcome-btn-shortcut').forEach(function(element) {
      element.textContent = element.textContent.replaceAll('Ctrl+', '⌘');
    });
  }
  // 主题由 SettingsApply 启动后加载的 effective settings 决定；此处只保持首帧默认。
  setTheme(document.documentElement.getAttribute('data-theme') || 'light');
  if (typeof TabManager !== 'undefined' && typeof TabManager.updateWindowTitle === 'function') {
    TabManager.updateWindowTitle();
  } else {
    setTitle('GlanceMD Ultra');
  }
  updateWordCount();
  updateWelcome();
  refreshShortcutTooltips();
  sendToRust('ready');
});

document.addEventListener('click', function(e) {
  var revealBtn = e.target && e.target.closest && e.target.closest('#project-tree-reveal');
  if (revealBtn) {
    revealBtn.classList.remove('flashing');
    void revealBtn.offsetWidth;
    revealBtn.classList.add('flashing');
    setTimeout(function() {
      revealBtn.classList.remove('flashing');
    }, 1000);
  }
});

function refreshShortcutTooltips() {
  if (typeof document === 'undefined') return;
  var keyMap = {};
  if (window.Keybindings && typeof window.Keybindings.effective === 'function') {
    try { keyMap = window.Keybindings.effective() || {}; } catch (e) {}
  }
  var isMac = typeof isMacOS !== 'undefined' ? isMacOS : (document.body && document.body.dataset && document.body.dataset.platform === 'macos');

  function formatKey(key) {
    if (!key) return '';
    if (isMac) {
      return key
        .replace(/Ctrl\+/g, '⌘')
        .replace(/Control\+/g, '⌘')
        .replace(/Alt\+/g, '⌥')
        .replace(/Shift\+/g, '⇧');
    }
    return key;
  }

  var elements = document.querySelectorAll('[data-command-id]');
  elements.forEach(function(el) {
    var cmdId = el.getAttribute('data-command-id');
    if (!cmdId) return;
    var rawKey = keyMap[cmdId] || '';
    var displayKey = formatKey(rawKey);

    var i18nKey = el.getAttribute('data-i18n-title');
    var baseTitle = '';
    if (i18nKey && window.I18n && typeof window.I18n.t === 'function') {
      baseTitle = window.I18n.t(i18nKey);
    } else if (el.getAttribute('data-base-title')) {
      baseTitle = el.getAttribute('data-base-title');
    } else if (el.title) {
      baseTitle = el.title.replace(/\s*\([^)]*\)$/, '').trim();
      el.setAttribute('data-base-title', baseTitle);
    }
    if (baseTitle) {
      el.title = displayKey ? baseTitle + ' (' + displayKey + ')' : baseTitle;
    }

    var shortcutSpan = el.querySelector('.welcome-btn-shortcut');
    if (shortcutSpan) {
      shortcutSpan.textContent = displayKey || '';
      shortcutSpan.style.display = displayKey ? '' : 'none';
    }
  });
}
window.refreshShortcutTooltips = refreshShortcutTooltips;

window.addEventListener('scheme-changed', refreshShortcutTooltips);
window.addEventListener('keybindings-changed', refreshShortcutTooltips);
window.addEventListener('language-changed', refreshShortcutTooltips);
window.addEventListener('i18n-changed', function() {
  updateWelcome();
  updateWordCount();
  refreshShortcutTooltips();
});
