function t(key, params) { return window.I18n ? window.I18n.t(key, params) : key; }
// IPC Bridge
function sendToRust(command, data) {
  var msg = JSON.stringify(Object.assign({ command: command }, data || {}));
  window.ipc.postMessage(msg);
}

// Rust calls this to send events to JS
window.__fromRust = function(event, data) {
  switch (event) {
    case 'file_opened':
      addRecentFile(data.path);
      TabManager.createTab(data.path, data.content, null, null, data.is_image);
      break;
    case 'file_saved':
      TabManager.markClean();
      if (data.path) {
        TabManager.updateTabPath(null, data.path);
      }
      onFileSaved();
      break;
    case 'stdin_opened':
      TabManager.createTab(null, data.content, 'preview', data.title || 'stdin');
      break;
    case 'error':
      showError(data.message);
      break;
    case 'navigation_blocked':
      if (typeof window.showNavigationFallback === 'function') {
        window.showNavigationFallback(data.url);
      }
      break;
  }
};

// Cached DOM refs
var $ = {};
document.addEventListener('DOMContentLoaded', function() {
    $.editor = document.getElementById('editor');
    $.preview = document.getElementById('preview');
    $.previewContainer = document.getElementById('preview-container');
    $.editorContainer = document.getElementById('editor-container');
    $.statusInfo = document.getElementById('status-info');
    $.statusFile = document.getElementById('status-file');
    $.titlebarTitle = document.getElementById('titlebar-title');
    $.dropOverlay = document.getElementById('drop-overlay');
    $.findBar = document.getElementById('find-bar');
    $.findInput = document.getElementById('find-input');
    $.findCount = document.getElementById('find-count');
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
  if (startNode.parentElement) startNode.parentElement.scrollIntoView({ block: 'center' });
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
    iconPreview.style.display = 'none';
    iconEdit.style.display = '';
    currentMode = 'preview';
    var pc = $.previewContainer || document.getElementById('preview-container');
    setTimeout(function() {
      if (!selectedText || !selectInPreview(selectedText, scrollRatio)) {
        pc.scrollTop = scrollRatio * (pc.scrollHeight - pc.clientHeight);
      }
    }, 0);
    if (findState.open) doFind(($.findInput || document.getElementById('find-input')).value);
  } else {
    var sel = window.getSelection();
    var selectedText = sel.toString();
    var pc = $.previewContainer || document.getElementById('preview-container');
    var scrollRatio = pc.scrollHeight > pc.clientHeight ? pc.scrollTop / (pc.scrollHeight - pc.clientHeight) : 0;
    pc.classList.remove('active');
    ($.editorContainer || document.getElementById('editor-container')).classList.add('active');
    document.getElementById('btn-toggle').classList.remove('active');
    document.getElementById('status-mode').textContent = 'EDIT';
    iconPreview.style.display = '';
    iconEdit.style.display = 'none';
    currentMode = 'edit';
    var editor = $.editor || document.getElementById('editor');
    editor.focus();
    if (!selectedText || !selectInEditor(selectedText, scrollRatio)) {
      var pos = Math.round(scrollRatio * editor.value.length);
      editor.selectionStart = editor.selectionEnd = pos;
      editor.scrollTop = scrollRatio * (editor.scrollHeight - editor.clientHeight);
    }
    if (findState.open) doFind(($.findInput || document.getElementById('find-input')).value);
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
    iconPreview.style.display = '';
    iconEdit.style.display = 'none';
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
    iconPreview.style.display = '';
    iconEdit.style.display = 'none';
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
  countEl.textContent = words + ' word' + (words !== 1 ? 's' : '');
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
  if (!tab) return;
  if (tab.isImage) return;
  var data = { content: document.getElementById('editor').value };
  if (tab.path) data.path = tab.path;
  sendToRust('save_file', data);
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
var findState = { open: false, matches: [], current: -1, marks: [] };

function openFind() {
  if (currentMode === 'image') return;
  document.getElementById('find-bar').classList.add('open');
  findState.open = true;
  var input = document.getElementById('find-input');
  input.focus();
  input.select();
  if (input.value) doFind(input.value);
}

function closeFind() {
  document.getElementById('find-bar').classList.remove('open');
  findState.open = false;
  findState.matches = [];
  findState.current = -1;
  clearPreviewHighlights();
  document.getElementById('find-count').textContent = '';
  if (currentMode === 'edit') document.getElementById('editor').focus();
}

function doFind(term) {
  findState.matches = [];
  findState.current = -1;
  clearPreviewHighlights();
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
    var node, ranges = [], termLower = term.toLowerCase();
    while (node = walker.nextNode()) {
      var nodeText = node.textContent.toLowerCase();
      var idx = 0;
      while ((idx = nodeText.indexOf(termLower, idx)) !== -1) {
        var range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + term.length);
        ranges.push(range);
        idx += term.length;
      }
    }
    for (var i = ranges.length - 1; i >= 0; i--) {
      var mark = document.createElement('mark');
      mark.className = 'find-match';
      ranges[i].surroundContents(mark);
      findState.marks.unshift(mark);
    }
    findState.matches = findState.marks.map(function(_, i) { return i; });
  }
  if (findState.matches.length > 0) {
    findState.current = 0;
    goToMatch(0);
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

function goToMatch(idx) {
  findState.current = idx;
  if (currentMode === 'edit') {
    var match = findState.matches[idx];
    var editor = document.getElementById('editor');
    editor.focus();
    editor.selectionStart = match.start;
    editor.selectionEnd = match.end;
  } else {
    findState.marks.forEach(function(m) { m.classList.remove('find-active'); });
    var mark = findState.marks[idx];
    mark.classList.add('find-active');
    mark.scrollIntoView({ block: 'center' });
  }
  updateFindCount();
}

function findNext() {
  if (findState.matches.length === 0) return;
  goToMatch((findState.current + 1) % findState.matches.length);
}

function findPrev() {
  if (findState.matches.length === 0) return;
  goToMatch((findState.current - 1 + findState.matches.length) % findState.matches.length);
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
  doFind(this.value);
});
document.getElementById('find-input').addEventListener('keydown', function(e) {
  if (e.key === 'Escape') { closeFind(); e.preventDefault(); }
  else if (e.key === 'Enter' && !e.shiftKey) { findNext(); e.preventDefault(); }
  else if (e.key === 'Enter' && e.shiftKey) { findPrev(); e.preventDefault(); }
});
document.getElementById('find-close').addEventListener('click', closeFind);
document.getElementById('find-next').addEventListener('click', findNext);
document.getElementById('find-prev').addEventListener('click', findPrev);

// Keyboard Shortcuts
document.addEventListener('keydown', function(e) {
  var primaryModifier = hasPrimaryModifier(e);
  if (primaryModifier && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openFind();
  } else if (e.key === 'Escape' && findState.open) {
    e.preventDefault();
    closeFind();
  } else if (primaryModifier && !e.shiftKey && e.key.toLowerCase() === 'o') {
    // keybindings.js owns Ctrl+O when the command registry is available. It is
    // loaded after app.js, so check at dispatch time and retain the legacy IPC
    // fallback for test pages and older builds without the keybinding stack.
    var keybindingsReady = window.Keybindings && window.Commands
      && typeof window.Keybindings.dispatch === 'function'
      && typeof window.Keybindings.effective === 'function'
      && typeof window.Keybindings.normalize === 'function'
      && typeof window.Commands.has === 'function';
    var keybindingsOwnsOpen = keybindingsReady
      && window.Keybindings.effective()['file.open'] === window.Keybindings.normalize(e)
      && window.Commands.has('file.open');
    if (!keybindingsOwnsOpen) {
      e.preventDefault();
      if (window.Commands && Commands.has && Commands.has('file.open')) Commands.run('file.open');
      else sendToRust('open_file');
    }
  } else if (primaryModifier && !e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    doSave();
  } else if (primaryModifier && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (currentMode === 'image') return;
    sendToRust('save_as', { content: document.getElementById('editor').value });
  } else if (primaryModifier && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    toggleMode();
  } else if (primaryModifier && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    TabManager.createTab(null, '');
  } else if (primaryModifier && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    var active = TabManager.getActiveTab();
    if (active) TabManager.closeTab(active.id);
  } else if (e.ctrlKey && !e.shiftKey && e.key === 'Tab') {
    e.preventDefault();
    TabManager.nextTab();
  } else if (e.ctrlKey && e.shiftKey && e.key === 'Tab') {
    e.preventDefault();
    TabManager.prevTab();
  } else if (primaryModifier && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    applyZoom(zoomLevel + ZOOM_STEP);
  } else if (primaryModifier && e.key === '-') {
    e.preventDefault();
    applyZoom(zoomLevel - ZOOM_STEP);
  } else if (primaryModifier && e.key === '0') {
    e.preventDefault();
    applyZoom(1);
  } else if (primaryModifier && e.key === '\\') {
    e.preventDefault();
    toggleSplit();
  } else if (primaryModifier && e.shiftKey && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    if (window.LayoutUI && typeof window.LayoutUI.toggle === 'function') {
      window.LayoutUI.toggle('outline');
    }
  }
});

// Window Controls
document.getElementById('btn-minimize').addEventListener('click', function() { sendToRust('window_minimize'); });
document.getElementById('btn-maximize').addEventListener('click', function() { sendToRust('window_maximize'); });
document.getElementById('btn-close').addEventListener('click', function() {
  var settings = window.SettingsApply && typeof window.SettingsApply.get === 'function'
    ? window.SettingsApply.get()
    : {};
  var shouldConfirm = !settings.recovery || settings.recovery.confirmCloseDirty !== false;
  if (TabManager.hasAnyDirty() && shouldConfirm) {
    if (!confirm(t('app.unsavedClose'))) return;
  }
  sendToRust('window_close');
});

// Toolbar Buttons
document.getElementById('btn-new').addEventListener('click', function() { TabManager.createTab(null, ''); });
document.getElementById('btn-open').addEventListener('click', function() { sendToRust('open_file'); });
document.getElementById('btn-save').addEventListener('click', doSave);
document.getElementById('btn-toggle').addEventListener('click', toggleMode);
document.getElementById('btn-split').addEventListener('click', toggleSplit);
var btnToc = document.getElementById('btn-toc');
if (btnToc) {
  btnToc.addEventListener('click', function() {
    if (window.LayoutUI && typeof window.LayoutUI.toggle === 'function') {
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

window.addEventListener('i18n-changed', function() {
  updateWelcome();
});
