// 划词与全文翻译前端模块（FEAT-005）—— window.TranslateUI
// 架构角色：
// 1. 顶栏翻译图标按钮（#btn-translate）与 Popup 浮窗（#translate-popup）：
//    - 引擎选择（Google 翻译 / Bing 翻译 / 自定义 OpenAI 兼容接口），独立存储并自动记忆上次选择；
//    - 目标语言选择（简体中文、繁體中文、English 等），自动记忆；
//    - 呈现模式：双语对照（Bilingual，默认）/ 纯译文替换（Translation）；
//    - 操作：单一主操作按钮（按当前 Tab 的翻译状态动态显示「翻译预览区全文」或「还原预览原文」）；
//    - 右上角设置图标直达设置面板「翻译」分类；
// 2. 预览区（#preview）段落级全文翻译与双语对照渲染：
//    - 智能提取 h1-h6/p/li/blockquote/table 文本段落，自动跳过 pre/code/mermaid/复制按钮；
//    - 按 Tab 分离翻译状态，切 Tab / 重新渲染即时同步状态；
//    - 回执按 Tab 缓存：已翻译后切换 双语对照/纯译文 直接复用译文本地重渲染，不发新请求；
//    - 分批发送 translate.request，回执后按语层翻译内联风格（无引用框的纯文本行）
//      在段落下插入 .preview-trans-block；
// 3. 划词选区翻译（同时支持编辑区 #editor 与预览区 #preview）：
//    - 划词气泡独立支持切换翻译引擎与目标语言，并记住上次选择；
//    - 气泡锚定在选区旁，标题栏可拖动、右下角可 resize；
//    - 编辑区支持「替换选区」、「插入到选区后」、「复制」；预览区支持「复制」；
//    - 替换/插入经 EditorCommands.transact 落应用级撤销栈（Ctrl+Z 可回退）；
//    - 快捷键 Alt+T 呼出气泡；Alt+Shift+X 跳过气泡直接"翻译选区并替换"；
//    - 浮层局部键（仅浮层打开时生效，tooltip 有标注）：气泡 Alt+R 替换/重试、
//      Alt+I 插入、Alt+C 复制；Popup Alt+A 主操作、Alt+B/Alt+V 切呈现模式。
// 4. 模块以 IIFE 组织并挂载 window.TranslateUI 供 Node/e2e 测试调用。

(function(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.TranslateUI = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function() {
  'use strict';

  var STORAGE_ENGINE_KEY = 'glancemd-ultra-trans-engine';
  var STORAGE_TARGET_KEY = 'glancemd-ultra-trans-target';

  var state = {
    triggerEl: null,
    bubbleEl: null,
    popupEl: null,
    toastTimer: null,
    activeSelection: null, // { text, start, end, source: 'editor' | 'preview' }
    lastMouse: null, // { x, y } 最近一次划词鼠标位置（气泡定位兜底）
    currentRequestId: null,
    currentResult: null, // String
    currentError: null,  // String
    isLoading: false,
    isOpen: false, // bubble is open
    isPopupOpen: false, // popup is open
    pendingAutoReplace: false, // 直达替换流程：回执后跳过气泡直接替换选区
    displayMode: 'bilingual', // 'bilingual' | 'replace'
    previewLoading: false,
    previewStatusText: '',
    previewPendingReqId: null,
    previewSegmentsMap: null, // Map of id -> element
    tabTranslationState: {}, // tabId -> { isTranslated, displayMode, segmentsMap }
  };

  var requestSeq = 0;

  var TARGET_LANGUAGES = [
    { value: 'zh-Hans', label: '简体中文' },
    { value: 'zh-Hant', label: '繁體中文' },
    { value: 'en', label: 'English' },
    { value: 'ja', label: '日本語' },
    { value: 'ko', label: '한국어' },
    { value: 'fr', label: 'Français' },
    { value: 'de', label: 'Deutsch' },
    { value: 'es', label: 'Español' },
    { value: 'ru', label: 'Русский' }
  ];

  var ENGINES = [
    { value: 'google', label: 'Google 翻译' },
    { value: 'bing', label: 'Bing 翻译' },
    { value: 'customAi', label: '自定义 OpenAI 兼容接口' }
  ];

  function t(k, p) {
    return window.I18n && typeof window.I18n.t === 'function' ? window.I18n.t(k, p) : k;
  }

  function getActiveTabId() {
    if (window.TabManager && typeof window.TabManager.getActiveTab === 'function') {
      var tab = window.TabManager.getActiveTab();
      return (tab && tab.id) || '__default__';
    }
    return '__default__';
  }

  function isCurrentTabTranslated() {
    var tabId = getActiveTabId();
    return !!(state.tabTranslationState[tabId] && state.tabTranslationState[tabId].isTranslated);
  }

  function getSavedEngine() {
    try {
      var s = localStorage.getItem(STORAGE_ENGINE_KEY);
      if (s) return s;
    } catch (e) {}
    if (window.SettingsApply && typeof window.SettingsApply.get === 'function') {
      var conf = window.SettingsApply.get().translation || {};
      return conf.engineKind || 'google';
    }
    return 'google';
  }

  function saveEngine(val) {
    try { localStorage.setItem(STORAGE_ENGINE_KEY, val); } catch (e) {}
    if (window.SettingsApply && typeof window.SettingsApply.patch === 'function') {
      window.SettingsApply.patch({ translation: { engineKind: val } });
    }
  }

  function getSavedTargetLang() {
    try {
      var s = localStorage.getItem(STORAGE_TARGET_KEY);
      if (s) return s;
    } catch (e) {}
    if (window.SettingsApply && typeof window.SettingsApply.get === 'function') {
      var conf = window.SettingsApply.get().translation || {};
      return conf.targetLanguage || 'zh-Hans';
    }
    return 'zh-Hans';
  }

  function saveTargetLang(val) {
    try { localStorage.setItem(STORAGE_TARGET_KEY, val); } catch (e) {}
    if (window.SettingsApply && typeof window.SettingsApply.patch === 'function') {
      window.SettingsApply.patch({ translation: { targetLanguage: val } });
    }
  }

  function getSettings() {
    if (window.SettingsApply && typeof window.SettingsApply.get === 'function') {
      var s = window.SettingsApply.get();
      return (s && s.translation) || {};
    }
    return {};
  }

  function getEditor() { return document.getElementById('editor'); }
  function getPreview() { return document.getElementById('preview'); }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function send(m) {
    if (window.ipc && typeof window.ipc.postMessage === 'function') {
      window.ipc.postMessage(JSON.stringify(m));
    }
  }

  /* ── 视口边界约束 ── */

  function clampPosition(x, y, width, height) {
    var margin = 12;
    var vw = (typeof window !== 'undefined' && window.innerWidth) || 1024;
    var vh = (typeof window !== 'undefined' && window.innerHeight) || 768;
    var clampedX = Math.max(margin, Math.min(x, vw - width - margin));
    var clampedY = Math.max(margin, Math.min(y, vh - height - margin));
    return { x: clampedX, y: clampedY };
  }

  /* ── DOM 构造：划词浮动触发按钮 ── */

  function ensureTriggerBtn() {
    if (state.triggerEl) return state.triggerEl;
    var btn = document.createElement('button');
    btn.id = 'translate-trigger-btn';
    btn.type = 'button';
    btn.hidden = true;
    btn.setAttribute('aria-label', t('translate.triggerBtn'));
    btn.setAttribute('title', t('translate.triggerBtn') + ' (Alt+T)');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"></path>'
      + '</svg>';
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      e.preventDefault();
      openBubble();
    });
    document.body.appendChild(btn);
    state.triggerEl = btn;
    return btn;
  }

  /* ── DOM 构造：划词气泡面板 ── */

  function ensureBubble() {
    if (state.bubbleEl) return state.bubbleEl;
    var bubble = document.createElement('div');
    bubble.id = 'translate-bubble';
    bubble.hidden = true;
    bubble.setAttribute('role', 'dialog');
    bubble.setAttribute('aria-label', t('translate.dialogTitle'));
    document.body.appendChild(bubble);
    state.bubbleEl = bubble;

    bubble.addEventListener('click', function(e) { e.stopPropagation(); });
    bubble.addEventListener('mousedown', function(e) { e.stopPropagation(); });
    // 标题栏拖拽（事件委托：header 随 renderBubbleContent 重建）
    bubble.addEventListener('mousedown', function(e) {
      if (e.button !== 0 || !state.isOpen) return;
      var header = bubble.querySelector('.translate-bubble-header');
      if (!header || !header.contains(e.target)) return;
      if (e.target.closest && e.target.closest('select, button, input, option')) return;
      beginBubbleDrag(e);
    });
    return bubble;
  }

  function beginBubbleDrag(e) {
    var bubble = state.bubbleEl;
    if (!bubble) return;
    var rect = bubble.getBoundingClientRect();
    var offsetX = e.clientX - rect.left;
    var offsetY = e.clientY - rect.top;
    bubble.classList.add('is-dragging');

    function onMove(ev) {
      var pos = clampPosition(ev.clientX - offsetX, ev.clientY - offsetY, bubble.offsetWidth, bubble.offsetHeight);
      bubble.style.left = pos.x + 'px';
      bubble.style.top = pos.y + 'px';
      ev.preventDefault();
    }
    function onUp() {
      bubble.classList.remove('is-dragging');
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
    }
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    e.preventDefault();
  }

  /* ── DOM 构造：顶栏 Popup 浮窗 ── */

  function ensurePopup() {
    if (state.popupEl) return state.popupEl;
    var popup = document.createElement('div');
    popup.id = 'translate-popup';
    popup.hidden = true;
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', t('translate.popupTitle'));
    document.body.appendChild(popup);
    state.popupEl = popup;

    popup.addEventListener('click', function(e) { e.stopPropagation(); });
    popup.addEventListener('mousedown', function(e) { e.stopPropagation(); });
    return popup;
  }

  /* ── 选区检测（同时支持 Editor 与 Preview） ── */

  function getSelectionInfo() {
    var ed = getEditor();
    if (ed) {
      var start = ed.selectionStart;
      var end = ed.selectionEnd;
      if (typeof start === 'number' && typeof end === 'number' && start !== end) {
        var text = ed.value.substring(start, end);
        if (text && text.trim()) {
          return { text: text, start: start, end: end, source: 'editor' };
        }
      }
    }
    if (typeof window !== 'undefined' && window.getSelection) {
      var sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        var sText = sel.toString();
        if (sText && sText.trim()) {
          var prev = getPreview();
          if (prev && sel.anchorNode && prev.contains(sel.anchorNode)) {
            return { text: sText, start: 0, end: sText.length, source: 'preview' };
          }
        }
      }
    }
    return null;
  }

  function positionTrigger(clientX, clientY) {
    var btn = ensureTriggerBtn();
    var x = clientX !== undefined ? clientX + 8 : 100;
    var y = clientY !== undefined ? clientY - 32 : 100;
    var pos = clampPosition(x, y, 28, 28);
    btn.style.left = pos.x + 'px';
    btn.style.top = pos.y + 'px';
    btn.hidden = false;
  }

  function hideTrigger() {
    if (state.triggerEl) state.triggerEl.hidden = true;
  }

  function onSelectionChange(e) {
    if (state.isOpen) return;
    var sel = getSelectionInfo();
    if (!sel) {
      hideTrigger();
      state.activeSelection = null;
      return;
    }
    var conf = getSettings();
    if (conf.selectionTriggerEnabled === false) {
      state.activeSelection = sel;
      hideTrigger();
      return;
    }
    state.activeSelection = sel;
    var x = e && typeof e.clientX === 'number' ? e.clientX : undefined;
    var y = e && typeof e.clientY === 'number' ? e.clientY : undefined;
    if (x !== undefined && y !== undefined) {
      state.lastMouse = { x: x, y: y };
    }
    if (x === undefined || y === undefined) {
      var ed = getEditor();
      if (ed) {
        var rect = ed.getBoundingClientRect();
        x = rect.left + rect.width / 2;
        y = rect.top + 60;
      }
    }
    positionTrigger(x, y);
  }

  /* ── 划词气泡渲染与动作 ── */

  function renderBubbleContent() {
    var bubble = ensureBubble();
    var curEngine = getSavedEngine();
    var curTarget = getSavedTargetLang();
    var isPreviewSource = state.activeSelection && state.activeSelection.source === 'preview';

    var engineOptionsHtml = ENGINES.map(function(item) {
      var sel = item.value === curEngine ? ' selected' : '';
      return '<option value="' + esc(item.value) + '"' + sel + '>' + esc(item.label) + '</option>';
    }).join('');

    var targetOptionsHtml = TARGET_LANGUAGES.map(function(item) {
      var sel = item.value === curTarget ? ' selected' : '';
      return '<option value="' + esc(item.value) + '"' + sel + '>' + esc(item.label) + '</option>';
    }).join('');

    var bodyHtml = '';
    if (state.isLoading) {
      bodyHtml = '<div class="translate-bubble-body is-loading">'
        + '<svg class="svg-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"></circle></svg>'
        + '<span>' + esc(t('translate.loading')) + '</span>'
        + '</div>';
    } else if (state.currentError) {
      bodyHtml = '<div class="translate-bubble-body is-error">'
        + esc(state.currentError)
        + '</div>';
    } else {
      bodyHtml = '<div class="translate-bubble-body" id="translate-result-text">'
        + esc(state.currentResult || '')
        + '</div>';
    }

    var footerHtml = '';
    if (state.isLoading) {
      footerHtml = '<div class="translate-bubble-footer">'
        + '<button type="button" class="translate-btn" id="translate-btn-cancel" title="' + esc(t('translate.actionClose') + ' (Esc)') + '">' + esc(t('translate.actionClose')) + '</button>'
        + '</div>';
    } else if (state.currentError) {
      footerHtml = '<div class="translate-bubble-footer">'
        + '<button type="button" class="translate-btn translate-btn-primary" id="translate-btn-retry" title="' + esc(t('translate.actionRetry') + ' (Alt+R)') + '">' + esc(t('translate.actionRetry')) + '</button>'
        + '<button type="button" class="translate-btn" id="translate-btn-close" title="' + esc(t('translate.actionClose') + ' (Esc)') + '">' + esc(t('translate.actionClose')) + '</button>'
        + '</div>';
    } else {
      var actionButtons = isPreviewSource
        ? '<button type="button" class="translate-btn translate-btn-primary" id="translate-btn-copy" title="' + esc(t('translate.actionCopy') + ' (Alt+C)') + '">' + esc(t('translate.actionCopy')) + '</button>'
        : '<button type="button" class="translate-btn translate-btn-primary" id="translate-btn-replace" title="' + esc(t('translate.actionReplace') + ' (Alt+R)') + '">' + esc(t('translate.actionReplace')) + '</button>'
          + '<button type="button" class="translate-btn" id="translate-btn-insert" title="' + esc(t('translate.actionInsert') + ' (Alt+I)') + '">' + esc(t('translate.actionInsert')) + '</button>'
          + '<button type="button" class="translate-btn" id="translate-btn-copy" title="' + esc(t('translate.actionCopy') + ' (Alt+C)') + '">' + esc(t('translate.actionCopy')) + '</button>';

      footerHtml = '<div class="translate-bubble-footer">'
        + actionButtons
        + '</div>';
    }

    bubble.innerHTML = '<div class="translate-bubble-header">'
      + '<span class="translate-bubble-title">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"></path></svg>'
      + esc(t('translate.dialogTitle'))
      + '</span>'
      + '<div class="translate-bubble-controls">'
      + '<select class="translate-bubble-select" id="translate-bubble-engine-select">' + engineOptionsHtml + '</select>'
      + '<select class="translate-bubble-select" id="translate-target-select">' + targetOptionsHtml + '</select>'
      + '</div>'
      + '<button type="button" class="translate-bubble-close" id="translate-close-btn" aria-label="' + esc(t('translate.actionClose')) + '">&times;</button>'
      + '</div>'
      + bodyHtml
      + footerHtml
      + '<div class="translate-toast" id="translate-toast" hidden>' + esc(t('translate.copied')) + '</div>';

    wireBubbleEvents(bubble);
  }

  function wireBubbleEvents(bubble) {
    var closeBtn = bubble.querySelector('#translate-close-btn');
    if (closeBtn) closeBtn.onclick = closeBubble;
    var closeBtn2 = bubble.querySelector('#translate-btn-close');
    if (closeBtn2) closeBtn2.onclick = closeBubble;
    var cancelBtn = bubble.querySelector('#translate-btn-cancel');
    if (cancelBtn) cancelBtn.onclick = closeBubble;

    var engineSel = bubble.querySelector('#translate-bubble-engine-select');
    if (engineSel) {
      engineSel.onchange = function() {
        saveEngine(engineSel.value);
        startTranslate();
      };
    }

    var targetSel = bubble.querySelector('#translate-target-select');
    if (targetSel) {
      targetSel.onchange = function() {
        saveTargetLang(targetSel.value);
        startTranslate();
      };
    }

    var retryBtn = bubble.querySelector('#translate-btn-retry');
    if (retryBtn) retryBtn.onclick = startTranslate;

    var replaceBtn = bubble.querySelector('#translate-btn-replace');
    if (replaceBtn) replaceBtn.onclick = onActionReplace;

    var insertBtn = bubble.querySelector('#translate-btn-insert');
    if (insertBtn) insertBtn.onclick = onActionInsert;

    var copyBtn = bubble.querySelector('#translate-btn-copy');
    if (copyBtn) copyBtn.onclick = onActionCopy;
  }

  /* ── 编辑区写入（统一走应用级撤销栈）── */

  // 经 EditorCommands.transact 写入，保证 Ctrl+Z 能精确回退本次替换/插入；
  // EditorCommands 缺席时（最小测试环境）退回 setRangeText + input 事件。
  function editSelection(ed, sel, text, insertAfter) {
    // 替换：[sel.start, sel.end)；插入：在 sel.end 处插入"空行 + 译文"
    var at = insertAfter ? sel.end : sel.start;
    var to = sel.end;
    var insertText = insertAfter ? '\n\n' + text : text;

    function mutate(el) {
      if (typeof el.setRangeText === 'function') {
        el.setRangeText(insertText, at, to, 'end');
      } else {
        var val = el.value;
        el.value = val.substring(0, at) + insertText + val.substring(to);
        el.selectionStart = el.selectionEnd = at + insertText.length;
      }
    }

    ed.focus();
    if (window.EditorCommands && typeof window.EditorCommands.transact === 'function') {
      ed.setSelectionRange(at, to);
      window.EditorCommands.transact(mutate);
    } else {
      mutate(ed);
      ed.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function applyResultToSelection(mode) {
    if (!state.currentResult || !state.activeSelection) return false;
    var ed = getEditor();
    if (!ed) return false;
    var sel = state.activeSelection;
    if (sel.source !== 'editor') return false;
    editSelection(ed, sel, state.currentResult, mode === 'insert');
    closeBubble();
    return true;
  }

  function onActionReplace() {
    applyResultToSelection('replace');
  }

  function onActionInsert() {
    applyResultToSelection('insert');
  }

  function onActionCopy() {
    if (!state.currentResult) return;
    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(state.currentResult).then(showCopyToast).catch(function() {
        fallbackCopy(state.currentResult);
      });
    } else {
      fallbackCopy(state.currentResult);
    }
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showCopyToast();
    } catch (e) {}
  }

  function showCopyToast() {
    var bubble = ensureBubble();
    var toast = bubble.querySelector('#translate-toast');
    if (!toast) return;
    toast.hidden = false;
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function() {
      if (toast) toast.hidden = true;
    }, 1500);
  }

  function startTranslate() {
    if (!state.activeSelection || !state.activeSelection.text) return;
    requestSeq += 1;
    var reqId = 'tr_' + requestSeq + '_' + Date.now();
    state.currentRequestId = reqId;
    state.isLoading = true;
    state.currentError = null;
    state.currentResult = null;
    renderBubbleContent();

    var segment = { id: 's0', text: state.activeSelection.text };
    send({
      command: 'translate.request',
      requestId: reqId,
      engineKind: getSavedEngine(),
      targetLanguage: getSavedTargetLang(),
      segments: [segment]
    });
  }

  /* ── 气泡锚定：贴着选区弹出 ── */

  // 编辑区选区几何：CustomCaret 的镜像测距给出选区首字符的行内坐标
  // （mirror 与编辑器同排版样式，markerLeft/Top 自 padding 边缘起算），
  // 换算为视口坐标并下移一行，让气泡落在选区文字旁——键盘划词（无鼠标
  // 坐标）时浮动按钮只能落在编辑器顶部中央，靠它锚定会跑偏。
  function getEditorSelectionAnchor() {
    var ed = getEditor();
    var sel = state.activeSelection;
    if (!ed || !sel || typeof sel.start !== 'number') return null;
    var caret = (typeof window !== 'undefined') ? window.CustomCaret : null;
    if (!caret || typeof caret.measureCoordinates !== 'function') return null;
    var m = caret.measureCoordinates(sel.start);
    if (!m) return null;
    var rect = ed.getBoundingClientRect();
    return {
      x: rect.left + (ed.clientLeft || 0) + (m.markerLeft || 0) - (ed.scrollLeft || 0),
      y: rect.top + (ed.clientTop || 0) + (m.markerTop || 0) - (ed.scrollTop || 0) + (m.lineHeight || 20)
    };
  }

  // 选区旁的锚点：预览区用 DOM 选区真实几何，编辑区用 CustomCaret 测距；
  // 都不可用时退回触发按钮位置（即划词时的鼠标位置）与最近鼠标位置。
  function getBubbleAnchor() {
    var sel = state.activeSelection;
    if (sel && sel.source === 'preview' && typeof window.getSelection === 'function') {
      try {
        var range = window.getSelection().getRangeAt(0);
        var r = range.getBoundingClientRect();
        if (r && (r.width || r.height)) return { x: r.left, y: r.bottom + 8 };
      } catch (err) {}
    }
    var edAnchor = sel && sel.source === 'editor' ? getEditorSelectionAnchor() : null;
    if (edAnchor) return edAnchor;
    if (state.triggerEl && !state.triggerEl.hidden) {
      var rect = state.triggerEl.getBoundingClientRect();
      return { x: rect.left, y: rect.bottom + 8 };
    }
    if (state.lastMouse && typeof state.lastMouse.x === 'number') {
      return { x: state.lastMouse.x + 8, y: state.lastMouse.y - 32 };
    }
    return { x: 120, y: 120 };
  }

  function showBubble() {
    var bubble = ensureBubble();
    var anchor = getBubbleAnchor();
    var pos = clampPosition(anchor.x, anchor.y, 420, 240);
    bubble.style.left = pos.x + 'px';
    bubble.style.top = pos.y + 'px';
    bubble.hidden = false;
    state.isOpen = true;
    hideTrigger();
  }

  function openBubble() {
    var sel = getSelectionInfo() || state.activeSelection;
    if (!sel || !sel.text) return;
    state.activeSelection = sel;
    state.pendingAutoReplace = false;
    showBubble();
    startTranslate();
  }

  function closeBubble() {
    if (state.bubbleEl) state.bubbleEl.hidden = true;
    state.isOpen = false;
    state.isLoading = false;
    state.currentRequestId = null;
    state.pendingAutoReplace = false;
    hideTrigger();
  }

  /* ── 直达替换：跳过气泡，翻译选区并直接写回编辑区 ── */

  function translateSelectionReplace() {
    var sel = getSelectionInfo();
    if (!sel || !sel.text) return;
    if (sel.source !== 'editor') return; // 替换写入编辑区，预览区选区不适用
    state.activeSelection = sel;
    state.pendingAutoReplace = true;
    hideTrigger();
    startTranslate();
  }

  /* ── 顶栏 Popup 浮窗渲染与交互 ── */

  function renderPopupContent() {
    var popup = ensurePopup();
    var conf = getSettings();
    var curEngine = getSavedEngine();
    var curTarget = getSavedTargetLang();
    var isCustom = curEngine === 'customAi';
    var hasCustomConfig = Boolean(conf.baseUrl && conf.apiKey);
    var isTranslated = isCurrentTabTranslated();

    var engineOptions = ENGINES.map(function(item) {
      return '<option value="' + esc(item.value) + '"' + (item.value === curEngine ? ' selected' : '') + '>' + esc(item.label) + '</option>';
    }).join('');

    var targetOptions = TARGET_LANGUAGES.map(function(item) {
      return '<option value="' + esc(item.value) + '"' + (item.value === curTarget ? ' selected' : '') + '>' + esc(item.label) + '</option>';
    }).join('');

    var aiAlertHtml = (isCustom && !hasCustomConfig)
      ? '<div class="translate-popup-alert" id="translate-popup-ai-alert">'
        + '<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>'
        + '<span>' + esc(t('translate.aiNotConfigured')) + '</span>'
        + '</div>'
      : '';

    var statusHtml = state.previewStatusText
      ? '<div class="translate-popup-status">' + esc(state.previewStatusText) + '</div>'
      : '';

    var mainActionBtnHtml = isTranslated
      ? '<button type="button" class="translate-btn translate-btn-block translate-btn-restore" id="popup-btn-toggle-preview" title="' + esc(t('translate.btnRestorePreview') + ' (Alt+A)') + '">'
        + '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>'
        + esc(t('translate.btnRestorePreview'))
        + '</button>'
      : '<button type="button" class="translate-btn translate-btn-primary translate-btn-block" id="popup-btn-toggle-preview" title="' + esc(t('translate.btnTranslatePreview') + ' (Alt+A)') + '"' + (state.previewLoading ? ' disabled' : '') + '>'
        + (state.previewLoading ? '<svg class="svg-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"></circle></svg>' : '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h7M6 2.5v1.5M3.5 6.5c.7 1.4 1.7 2.6 3 3.3M7 4c-.6 1.7-1.6 3.1-3 4.1M8.5 13.5l3.2-7 3.3 7M9.8 11.2h4.4"/></svg>')
        + esc(t('translate.btnTranslatePreview'))
        + '</button>';

    popup.innerHTML = '<div class="translate-popup-header">'
      + '<span class="translate-popup-title">'
      // 语层翻译品牌标（V 形星座，取自 VastTranslatorChromePlugin 的 BrandMark）
      + '<svg viewBox="0 0 48 48" fill="none" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M11.5 14 24 36 37.5 10.5" stroke="currentColor" stroke-width="3.5"/>'
      + '<circle cx="11.5" cy="14" r="3.5" fill="currentColor" stroke="none"/>'
      + '<circle cx="24" cy="36" r="3.5" fill="currentColor" stroke="none"/>'
      + '<circle cx="37.5" cy="10.5" r="3.5" fill="currentColor" stroke="none"/>'
      + '</svg>'
      + esc(t('translate.popupTitle'))
      + '</span>'
      + '<button type="button" class="translate-popup-icon-btn" id="translate-popup-btn-settings" title="' + esc(t('translate.quickSettings')) + '" aria-label="' + esc(t('translate.quickSettings')) + '">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>'
      + '</button>'
      + '</div>'
      + '<div class="translate-popup-body">'
      + '<div class="translate-popup-field">'
      + '<label class="translate-popup-label">' + esc(t('translate.engine')) + '</label>'
      + '<select class="translate-popup-select" id="translate-popup-engine">' + engineOptions + '</select>'
      + '</div>'
      + '<div class="translate-popup-field">'
      + '<label class="translate-popup-label">' + esc(t('translate.targetLanguage')) + '</label>'
      + '<select class="translate-popup-select" id="translate-popup-target-lang">' + targetOptions + '</select>'
      + '</div>'
      + '<div class="translate-popup-field">'
      + '<label class="translate-popup-label">' + esc(t('translate.displayMode')) + '</label>'
      + '<div class="translate-popup-segment-group">'
      + '<button type="button" class="translate-popup-seg-btn' + (state.displayMode === 'bilingual' ? ' active' : '') + '" data-mode="bilingual" title="' + esc(t('translate.modeBilingual') + ' (Alt+B)') + '">' + esc(t('translate.modeBilingual')) + '</button>'
      + '<button type="button" class="translate-popup-seg-btn' + (state.displayMode === 'replace' ? ' active' : '') + '" data-mode="replace" title="' + esc(t('translate.modeReplace') + ' (Alt+V)') + '">' + esc(t('translate.modeReplace')) + '</button>'
      + '</div>'
      + '</div>'
      + aiAlertHtml
      + '<div class="translate-popup-actions">'
      + mainActionBtnHtml
      + '</div>'
      + statusHtml
      + '</div>';

    wirePopupEvents(popup);
  }

  function goToSettingsTranslation() {
    closePopup();
    if (window.SettingsUI && typeof window.SettingsUI.open === 'function') {
      window.SettingsUI.open();
      if (typeof window.SettingsUI.setCategory === 'function') {
        window.SettingsUI.setCategory('translation');
      }
    } else if (window.Commands && typeof window.Commands.run === 'function') {
      window.Commands.run('settings.toggle');
    }
  }

  function wirePopupEvents(popup) {
    var settingsBtn = popup.querySelector('#translate-popup-btn-settings');
    if (settingsBtn) settingsBtn.onclick = goToSettingsTranslation;

    var aiAlert = popup.querySelector('#translate-popup-ai-alert');
    if (aiAlert) aiAlert.onclick = goToSettingsTranslation;

    var engineSelect = popup.querySelector('#translate-popup-engine');
    if (engineSelect) {
      engineSelect.onchange = function() {
        saveEngine(engineSelect.value);
        renderPopupContent();
      };
    }

    var targetSelect = popup.querySelector('#translate-popup-target-lang');
    if (targetSelect) {
      targetSelect.onchange = function() {
        saveTargetLang(targetSelect.value);
      };
    }

    var segBtns = popup.querySelectorAll('.translate-popup-seg-btn');
    Array.prototype.forEach.call(segBtns, function(btn) {
      btn.onclick = function() {
        setPreviewDisplayMode(btn.dataset.mode);
      };
    });

    var togglePreviewBtn = popup.querySelector('#popup-btn-toggle-preview');
    if (togglePreviewBtn) {
      togglePreviewBtn.onclick = function() {
        if (isCurrentTabTranslated()) {
          restorePreview();
        } else {
          translatePreview();
        }
      };
    }
  }

  function togglePopup() {
    if (state.isPopupOpen) closePopup(); else openPopup();
  }

  function openPopup() {
    var popup = ensurePopup();
    var btn = document.getElementById('btn-translate');
    var rect = btn ? btn.getBoundingClientRect() : null;
    var x = rect ? rect.left - 240 : 200;
    var y = rect ? rect.bottom + 6 : 50;
    var pos = clampPosition(x, y, 290, 320);
    popup.style.left = pos.x + 'px';
    popup.style.top = pos.y + 'px';
    popup.hidden = false;
    state.isPopupOpen = true;
    renderPopupContent();
  }

  function closePopup() {
    if (state.popupEl) state.popupEl.hidden = true;
    state.isPopupOpen = false;
  }

  /* ── 预览区全文与双语对照翻译 ── */

  function collectPreviewSegments() {
    var prev = getPreview();
    if (!prev) return null;
    var nodes = prev.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, blockquote > p, td, th, dt, dd');
    var segments = [];
    var elementsMap = {};
    var count = 0;

    Array.prototype.forEach.call(nodes, function(node) {
      if (node.closest('pre') || node.closest('.mermaid-block') || node.classList.contains('preview-trans-block')) {
        return;
      }
      var text = (node.textContent || '').trim();
      if (!text) return;
      var id = 'p_' + count;
      count++;
      segments.push({ id: id, text: text });
      elementsMap[id] = node;
    });

    return { segments: segments, map: elementsMap };
  }

  function translatePreview() {
    var collected = collectPreviewSegments();
    if (!collected || !collected.segments.length) {
      state.previewStatusText = t('translate.previewEmpty');
      renderPopupContent();
      return;
    }

    requestSeq += 1;
    var reqId = 'prev_' + requestSeq + '_' + Date.now();
    state.previewPendingReqId = reqId;
    state.previewSegmentsMap = collected.map;
    state.previewLoading = true;
    state.previewStatusText = t('translate.loading');
    renderPopupContent();

    send({
      command: 'translate.request',
      requestId: reqId,
      engineKind: getSavedEngine(),
      targetLanguage: getSavedTargetLang(),
      segments: collected.segments
    });
  }

  function restorePreview() {
    var prev = getPreview();
    if (!prev) return;
    var transBlocks = prev.querySelectorAll('.preview-trans-block');
    Array.prototype.forEach.call(transBlocks, function(el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    var replacedEls = prev.querySelectorAll('[data-orig-html]');
    Array.prototype.forEach.call(replacedEls, function(el) {
      el.innerHTML = el.getAttribute('data-orig-html');
      el.removeAttribute('data-orig-html');
    });

    var tabId = getActiveTabId();
    delete state.tabTranslationState[tabId];

    state.previewStatusText = t('translate.previewRestored');
    renderPopupContent();
  }

  function applyPreviewTranslation(results) {
    var map = state.previewSegmentsMap;
    if (!map) return;
    var isBilingual = state.displayMode === 'bilingual';

    restorePreview();

    results.forEach(function(res) {
      var elem = map[res.id];
      if (!elem || !elem.parentNode) return;

      if (isBilingual) {
        var transDiv = document.createElement('div');
        transDiv.className = 'preview-trans-block';
        transDiv.setAttribute('data-trans-for', res.id);
        transDiv.textContent = res.text;
        elem.parentNode.insertBefore(transDiv, elem.nextSibling);
      } else {
        elem.setAttribute('data-orig-html', elem.innerHTML);
        elem.textContent = res.text;
      }
    });

    var tabId = getActiveTabId();
    state.tabTranslationState[tabId] = {
      isTranslated: true,
      displayMode: state.displayMode,
      results: results // 缓存回执：切换呈现模式时本地重渲染，不再发新请求
    };
  }

  // Popup 呈现模式切换：当前 Tab 已翻译且有缓存回执时直接复用译文重渲染；
  // 未翻译时仅记录模式，下一次翻译生效。
  function setPreviewDisplayMode(mode) {
    if (mode !== 'bilingual' && mode !== 'replace') return;
    state.displayMode = mode;
    var tabId = getActiveTabId();
    var tabState = state.tabTranslationState[tabId];
    if (tabState && tabState.isTranslated && tabState.results && tabState.results.length) {
      applyPreviewTranslation(tabState.results);
      state.previewStatusText = t('translate.modeSwitched', {
        mode: mode === 'bilingual' ? t('translate.modeBilingual') : t('translate.modeReplace'),
        count: tabState.results.length
      });
    }
    renderPopupContent();
  }

  /* ── IPC 事件与生命周期 ── */

  function onTranslateResult(d) {
    if (!d || !d.requestId) return;
    if (d.requestId === 'test') return;

    if (d.requestId === state.previewPendingReqId) {
      state.previewLoading = false;
      if (d.ok && d.results && d.results.length) {
        applyPreviewTranslation(d.results);
        state.previewStatusText = t('translate.previewSuccess', { count: d.results.length, ms: 120 });
      } else {
        state.previewStatusText = d.message || t('translate.actionRetry');
      }
      renderPopupContent();
      return;
    }

    if (d.requestId !== state.currentRequestId) return;
    state.isLoading = false;
    if (d.ok && d.results && d.results.length > 0) {
      state.currentResult = d.results.map(function(r) { return r.text; }).join('\n\n');
      state.currentError = null;
    } else {
      state.currentError = d.message || t('translate.actionRetry');
      state.currentResult = null;
    }
    if (state.pendingAutoReplace && !state.isOpen) {
      state.pendingAutoReplace = false;
      // 选区自请求发出后未被改动才允许直接写回，否则退回气泡让用户确认
      var sel = state.activeSelection;
      var ed = getEditor();
      var unchanged = !!(sel && ed && ed.value.substring(sel.start, sel.end) === sel.text);
      if (state.currentResult && unchanged && applyResultToSelection('replace')) return;
      showBubble();
      renderBubbleContent();
      return;
    }
    if (state.isOpen) {
      renderBubbleContent();
    }
  }

  // 浮层局部快捷键：气泡/Popup 打开期间生效（capture 先于全局键位分派）。
  // 不注册进全局键位系统——这些键是浮层按钮的键盘等价物，随浮层出现/消失，
  // 避免污染用户键位方案；AltGr（ctrlKey+altKey 同真）不触发，防误触。
  function isLocalCombo(e, letter) {
    return Boolean(e.altKey) && !e.ctrlKey && !e.metaKey && !e.shiftKey
      && typeof e.key === 'string' && e.key.toLowerCase() === letter;
  }

  function onGlobalKeyDown(e) {
    if (e.key === 'Escape') {
      if (state.isOpen) { e.preventDefault(); e.stopPropagation(); closeBubble(); }
      if (state.isPopupOpen) { e.preventDefault(); e.stopPropagation(); closePopup(); }
      return;
    }
    if (state.isOpen) {
      if (isLocalCombo(e, 'r')) {
        e.preventDefault(); e.stopPropagation();
        if (state.currentError) startTranslate(); // 错误态同槽：Alt+R=重试
        else if (state.currentResult) onActionReplace();
      } else if (isLocalCombo(e, 'i')) {
        e.preventDefault(); e.stopPropagation();
        if (state.currentResult) onActionInsert();
      } else if (isLocalCombo(e, 'c')) {
        e.preventDefault(); e.stopPropagation();
        if (state.currentResult) onActionCopy();
      }
      return;
    }
    if (state.isPopupOpen) {
      if (isLocalCombo(e, 'a')) {
        e.preventDefault(); e.stopPropagation();
        if (isCurrentTabTranslated()) restorePreview();
        else if (!state.previewLoading) translatePreview();
      } else if (isLocalCombo(e, 'b')) {
        e.preventDefault(); e.stopPropagation();
        setPreviewDisplayMode('bilingual');
      } else if (isLocalCombo(e, 'v')) {
        e.preventDefault(); e.stopPropagation();
        setPreviewDisplayMode('replace');
      }
    }
  }

  function onGlobalClick(e) {
    if (!state.isOpen) {
      if (state.triggerEl && !state.triggerEl.contains(e.target)) {
        var ed = getEditor();
        var prev = getPreview();
        var inEd = ed && ed.contains(e.target);
        var inPrev = prev && prev.contains(e.target);
        if (!inEd && !inPrev) hideTrigger();
      }
    } else {
      if (state.bubbleEl && !state.bubbleEl.contains(e.target) && (!state.triggerEl || !state.triggerEl.contains(e.target))) {
        closeBubble();
      }
    }

    if (state.isPopupOpen) {
      var btnTrans = document.getElementById('btn-translate');
      if (state.popupEl && !state.popupEl.contains(e.target) && (!btnTrans || !btnTrans.contains(e.target))) {
        closePopup();
      }
    }
  }

  /* ── 统一初始化 ── */

  function init() {
    var ed = getEditor();
    if (ed) {
      ed.addEventListener('mouseup', onSelectionChange);
      ed.addEventListener('keyup', function(e) {
        if (e.shiftKey) onSelectionChange(e);
      });
    }

    var prev = getPreview();
    if (prev) {
      prev.addEventListener('mouseup', onSelectionChange);
    }

    var topBtn = document.getElementById('btn-translate');
    if (topBtn) {
      topBtn.onclick = function(e) {
        e.stopPropagation();
        togglePopup();
      };
    }

    if (window.Workspace && typeof window.Workspace.on === 'function') {
      window.Workspace.on('workspace:translate-result', onTranslateResult);
    }

    document.addEventListener('keydown', onGlobalKeyDown, true);
    document.addEventListener('click', onGlobalClick, true);

    if (typeof window.addEventListener === 'function') {
      window.addEventListener('i18n-changed', function() {
        if (state.triggerEl) {
          state.triggerEl.setAttribute('aria-label', t('translate.triggerBtn'));
          state.triggerEl.setAttribute('title', t('translate.triggerBtn') + ' (Alt+T)');
        }
        var tb = document.getElementById('btn-translate');
        if (tb) {
          tb.setAttribute('title', t('toolbar.translate'));
          tb.setAttribute('aria-label', t('toolbar.translate'));
        }
        if (state.isOpen) renderBubbleContent();
        if (state.isPopupOpen) renderPopupContent();
      });
    }

    // 注册公开命令
    if (window.Commands && typeof window.Commands.register === 'function') {
      try {
        window.Commands.register('translate.popup', {
          label: t('translate.cmdPopup'),
          category: 'View',
          description: t('translate.cmdPopup'),
          run: togglePopup
        });
        window.Commands.register('translate.selection', {
          label: t('translate.cmdSelection'),
          category: 'Edit',
          description: t('translate.cmdSelection'),
          isEnabled: function() {
            var s = getSelectionInfo();
            return !!(s && s.text);
          },
          run: openBubble
        });
        window.Commands.register('translate.selectionReplace', {
          label: t('translate.cmdSelectionReplace'),
          category: 'Edit',
          description: t('translate.cmdSelectionReplace'),
          isEnabled: function() {
            var s = getSelectionInfo();
            return !!(s && s.text && s.source === 'editor');
          },
          run: translateSelectionReplace
        });
        window.Commands.register('translate.preview', {
          label: t('translate.btnTranslatePreview'),
          category: 'View',
          description: t('translate.btnTranslatePreview'),
          run: translatePreview
        });
        window.Commands.register('translate.restore', {
          label: t('translate.btnRestorePreview'),
          category: 'View',
          description: t('translate.btnRestorePreview'),
          run: restorePreview
        });
      } catch (e) {}
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  return {
    init: init,
    openBubble: openBubble,
    closeBubble: closeBubble,
    openPopup: openPopup,
    closePopup: closePopup,
    togglePopup: togglePopup,
    translatePreview: translatePreview,
    restorePreview: restorePreview,
    setPreviewDisplayMode: setPreviewDisplayMode,
    collectPreviewSegments: collectPreviewSegments,
    startTranslate: startTranslate,
    translateSelectionReplace: translateSelectionReplace,
    getState: function() { return Object.assign({}, state); },
    getSelectionInfo: getSelectionInfo,
    clampPosition: clampPosition,
    onTranslateResult: onTranslateResult,
    getSavedEngine: getSavedEngine,
    saveEngine: saveEngine,
    getSavedTargetLang: getSavedTargetLang,
    saveTargetLang: saveTargetLang,
    isCurrentTabTranslated: isCurrentTabTranslated,
  };
});
