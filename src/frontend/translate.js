// 划词翻译前端模块（FEAT-005）—— window.TranslateUI
// 架构角色：
// - 监听 #editor 的选区变化（mouseup / keyup / selectionchange），非折叠选区
//   时在选区附近显示浮动翻译触发按钮（可由 settings.translation.selectionTriggerEnabled 控制）；
// - 提供命令 `translate.selection`（默认键 `Alt+T`），无选区时不弹，有选区直接开气泡；
// - 气泡状态机：loading / result / error / retry；
// - 请求关联：前端生成单调递增 requestId，通过 `window.ipc.postMessage('translate.request')`
//   发送；监听 `workspace:translate-result` 下行事件，非当前 pending requestId 的回执
//   静默丢弃（防止快速连续划词导致结果错位）；
// - 动作支持：替换选区（`setRangeText` 保持原生撤销栈可退回）、插入到选区后、复制（Clipboard API）；
// - 国际化：监听 `i18n-changed` 动态重渲染文案；
// - 模块以 IIFE 组织并挂载 window.TranslateUI 供 Node/e2e 测试调用。

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

  var state = {
    triggerEl: null,
    bubbleEl: null,
    toastTimer: null,
    hideTriggerTimer: null,
    activeSelection: null, // { text, start, end, x, y }
    currentRequestId: null,
    currentResult: null, // String
    currentError: null,  // String
    isLoading: false,
    isOpen: false,
    targetLanguageOverride: null,
  };

  var requestSeq = 0;

  function t(k, p) {
    return window.I18n && typeof window.I18n.t === 'function' ? window.I18n.t(k, p) : k;
  }

  function getSettings() {
    if (window.SettingsApply && typeof window.SettingsApply.get === 'function') {
      var s = window.SettingsApply.get();
      return (s && s.translation) || {};
    }
    return {};
  }

  function getEditor() {
    return document.getElementById('editor');
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function send(m) {
    if (window.ipc && typeof window.ipc.postMessage === 'function') {
      window.ipc.postMessage(JSON.stringify(m));
    }
  }

  /* ── DOM 构造 ── */

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

  function ensureBubble() {
    if (state.bubbleEl) return state.bubbleEl;
    var bubble = document.createElement('div');
    bubble.id = 'translate-bubble';
    bubble.hidden = true;
    bubble.setAttribute('role', 'dialog');
    bubble.setAttribute('aria-label', t('translate.dialogTitle'));
    document.body.appendChild(bubble);
    state.bubbleEl = bubble;

    // 点击气泡内部阻止冒泡
    bubble.addEventListener('click', function(e) {
      e.stopPropagation();
    });
    bubble.addEventListener('mousedown', function(e) {
      e.stopPropagation();
    });
    return bubble;
  }

  /* ── 视口边界约束 ── */

  function clampPosition(x, y, width, height) {
    var margin = 12;
    var vw = window.innerWidth || 1024;
    var vh = window.innerHeight || 768;
    var clampedX = Math.max(margin, Math.min(x, vw - width - margin));
    var clampedY = Math.max(margin, Math.min(y, vh - height - margin));
    return { x: clampedX, y: clampedY };
  }

  /* ── 选区检测与触发按钮定位 ── */

  function getEditorSelection() {
    var ed = getEditor();
    if (!ed) return null;
    var start = ed.selectionStart;
    var end = ed.selectionEnd;
    if (typeof start !== 'number' || typeof end !== 'number' || start === end) {
      return null;
    }
    var text = ed.value.substring(start, end);
    if (!text || !text.trim()) return null;
    return { text: text, start: start, end: end };
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
    if (state.triggerEl) {
      state.triggerEl.hidden = true;
    }
  }

  function onSelectionChange(e) {
    // 气泡已打开时不破坏其选区上下文
    if (state.isOpen) return;
    var sel = getEditorSelection();
    if (!sel) {
      hideTrigger();
      state.activeSelection = null;
      return;
    }
    var conf = getSettings();
    if (conf.selectionTriggerEnabled === false) {
      // 用户关闭了浮动按钮：仍保留活动选区供 Alt+T 使用，但不显式展示浮动按钮
      state.activeSelection = sel;
      hideTrigger();
      return;
    }
    state.activeSelection = sel;
    var x = e && typeof e.clientX === 'number' ? e.clientX : undefined;
    var y = e && typeof e.clientY === 'number' ? e.clientY : undefined;
    if (x === undefined || y === undefined) {
      // 键盘选区：回退到编辑器中心偏上
      var ed = getEditor();
      if (ed) {
        var rect = ed.getBoundingClientRect();
        x = rect.left + rect.width / 2;
        y = rect.top + 60;
      }
    }
    positionTrigger(x, y);
  }

  /* ── 气泡渲染 ── */

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

  function renderBubbleContent() {
    var bubble = ensureBubble();
    var conf = getSettings();
    var targetLang = state.targetLanguageOverride || conf.targetLanguage || 'zh-Hans';
    var engineKind = conf.engineKind || 'google';
    var engineLabel = engineKind === 'bing' ? 'Bing' : (engineKind === 'customAi' ? 'AI' : 'Google');

    var optionsHtml = TARGET_LANGUAGES.map(function(item) {
      var sel = item.value === targetLang ? ' selected' : '';
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
        + '<span class="translate-bubble-engine-badge">' + esc(engineLabel) + '</span>'
        + '<button type="button" class="translate-btn" id="translate-btn-cancel">' + esc(t('translate.actionClose')) + '</button>'
        + '</div>';
    } else if (state.currentError) {
      footerHtml = '<div class="translate-bubble-footer">'
        + '<span class="translate-bubble-engine-badge">' + esc(engineLabel) + '</span>'
        + '<button type="button" class="translate-btn translate-btn-primary" id="translate-btn-retry">' + esc(t('translate.actionRetry')) + '</button>'
        + '<button type="button" class="translate-btn" id="translate-btn-close">' + esc(t('translate.actionClose')) + '</button>'
        + '</div>';
    } else {
      footerHtml = '<div class="translate-bubble-footer">'
        + '<span class="translate-bubble-engine-badge">' + esc(engineLabel) + '</span>'
        + '<button type="button" class="translate-btn translate-btn-primary" id="translate-btn-replace">' + esc(t('translate.actionReplace')) + '</button>'
        + '<button type="button" class="translate-btn" id="translate-btn-insert">' + esc(t('translate.actionInsert')) + '</button>'
        + '<button type="button" class="translate-btn" id="translate-btn-copy">' + esc(t('translate.actionCopy')) + '</button>'
        + '</div>';
    }

    bubble.innerHTML = '<div class="translate-bubble-header">'
      + '<span class="translate-bubble-title">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"></path></svg>'
      + esc(t('translate.dialogTitle'))
      + '</span>'
      + '<select class="translate-bubble-target-select" id="translate-target-select">' + optionsHtml + '</select>'
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

    var select = bubble.querySelector('#translate-target-select');
    if (select) {
      select.onchange = function() {
        state.targetLanguageOverride = select.value;
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

  /* ── 动作执行 ── */

  function onActionReplace() {
    if (!state.currentResult || !state.activeSelection) return;
    var ed = getEditor();
    if (!ed) return;
    var sel = state.activeSelection;
    ed.focus();
    ed.setSelectionRange(sel.start, sel.end);
    if (typeof ed.setRangeText === 'function') {
      ed.setRangeText(state.currentResult, sel.start, sel.end, 'end');
    } else {
      var val = ed.value;
      ed.value = val.substring(0, sel.start) + state.currentResult + val.substring(sel.end);
      ed.selectionStart = ed.selectionEnd = sel.start + state.currentResult.length;
    }
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    closeBubble();
  }

  function onActionInsert() {
    if (!state.currentResult || !state.activeSelection) return;
    var ed = getEditor();
    if (!ed) return;
    var sel = state.activeSelection;
    ed.focus();
    var insertText = '\n\n' + state.currentResult;
    ed.setSelectionRange(sel.end, sel.end);
    if (typeof ed.setRangeText === 'function') {
      ed.setRangeText(insertText, sel.end, sel.end, 'end');
    } else {
      var val = ed.value;
      ed.value = val.substring(0, sel.end) + insertText + val.substring(sel.end);
      ed.selectionStart = ed.selectionEnd = sel.end + insertText.length;
    }
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    closeBubble();
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

  /* ── 翻译请求与回执 ── */

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
      segments: [segment]
    });
  }

  function onTranslateResult(d) {
    if (!d || !d.requestId) return;
    // 忽略测试命令回执与过期请求回执
    if (d.requestId === 'test') return;
    if (d.requestId !== state.currentRequestId) return;

    state.isLoading = false;
    if (d.ok && d.results && d.results.length > 0) {
      state.currentResult = d.results.map(function(r) { return r.text; }).join('\n\n');
      state.currentError = null;
    } else {
      state.currentError = d.message || t('translate.actionRetry');
      state.currentResult = null;
    }
    if (state.isOpen) {
      renderBubbleContent();
    }
  }

  /* ── 气泡打开与关闭 ── */

  function openBubble() {
    var sel = getEditorSelection() || state.activeSelection;
    if (!sel || !sel.text) return;
    state.activeSelection = sel;
    hideTrigger();

    var bubble = ensureBubble();
    // 默认定位在当前触发按钮附近或编辑器中心
    var rect = state.triggerEl && !state.triggerEl.hidden ? state.triggerEl.getBoundingClientRect() : null;
    var x = rect ? rect.left : 120;
    var y = rect ? rect.bottom + 8 : 120;
    var pos = clampPosition(x, y, 380, 240);
    bubble.style.left = pos.x + 'px';
    bubble.style.top = pos.y + 'px';
    bubble.hidden = false;
    state.isOpen = true;

    startTranslate();
  }

  function closeBubble() {
    if (state.bubbleEl) {
      state.bubbleEl.hidden = true;
    }
    state.isOpen = false;
    state.isLoading = false;
    state.currentRequestId = null;
    state.targetLanguageOverride = null;
    hideTrigger();
  }

  /* ── 键盘与外部点击监听 ── */

  function onGlobalKeyDown(e) {
    if (!state.isOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeBubble();
    }
  }

  function onGlobalClick(e) {
    if (!state.isOpen) {
      // 点击非编辑器且非触发按钮时隐藏浮动按钮
      if (state.triggerEl && !state.triggerEl.contains(e.target)) {
        var ed = getEditor();
        if (!ed || !ed.contains(e.target)) {
          hideTrigger();
        }
      }
      return;
    }
    if (state.bubbleEl && !state.bubbleEl.contains(e.target) && (!state.triggerEl || !state.triggerEl.contains(e.target))) {
      closeBubble();
    }
  }

  /* ── 初始化与命令注册 ── */

  function init() {
    var ed = getEditor();
    if (ed) {
      ed.addEventListener('mouseup', onSelectionChange);
      ed.addEventListener('keyup', function(e) {
        // Shift+方向键选区
        if (e.shiftKey) onSelectionChange(e);
      });
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
        if (state.isOpen) {
          renderBubbleContent();
        }
      });
    }

    // 注册 translate.selection 命令
    if (window.Commands && typeof window.Commands.register === 'function') {
      try {
        window.Commands.register('translate.selection', {
          label: t('translate.cmdSelection'),
          category: 'Edit',
          description: t('translate.cmdSelection'),
          isEnabled: function() {
            var s = getEditorSelection();
            return !!(s && s.text);
          },
          run: function() {
            openBubble();
          }
        });
      } catch (e) {}
    }
  }

  // 立即初始化
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
    startTranslate: startTranslate,
    getState: function() { return Object.assign({}, state); },
    getEditorSelection: getEditorSelection,
    clampPosition: clampPosition,
    onTranslateResult: onTranslateResult,
  };
});
