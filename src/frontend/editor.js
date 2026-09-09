(function() {
  var editor = document.getElementById('editor');

  function normalizeHeadingText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function markdownHeadingDescriptors(markdown) {
    var lines = String(markdown || '').split('\n');
    var result = [];
    var inFence = false;
    var fenceChar = null;
    var fenceLength = 0;
    var frontmatterEnd = 0;
    // Keep this in sync with preview.js stripFrontmatter: only a document-
    // initial YAML block is ignored, and its closing --- is not Setext text.
    if (/^---\r?$/.test(lines[0] || '')) {
      for (var fm = 1; fm < lines.length; fm++) {
        if (/^---\s*\r?$/.test(lines[fm])) {
          frontmatterEnd = fm + 1;
          break;
        }
      }
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var fence = line.match(/^\s{0,3}(`{3,}|~{3,})(?:[^`~]|$)/);
      if (inFence) {
        if (fence && fence[1].charAt(0) === fenceChar && fence[1].length >= fenceLength && /^[ \t]*(?:`{3,}|~{3,})[ \t]*\r?$/.test(line)) {
          inFence = false;
          fenceChar = null;
          fenceLength = 0;
        }
        continue;
      }
      if (i < frontmatterEnd) continue;
      if (fence) {
        inFence = true;
        fenceChar = fence[1].charAt(0);
        fenceLength = fence[1].length;
        continue;
      }
      var atx = line.match(/^\s{0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)\r?$/);
      if (atx) {
        var atxText = normalizeHeadingText(atx[2] || '').replace(/[ \t]+#+[ \t]*$/, '');
        result.push({ line: i, level: atx[1].length, text: normalizeHeadingText(atxText) });
        continue;
      }
      // Setext headings are rendered by marked as headings whose source line
      // is the text line, not the underline.
      if (line.trim() && i + 1 >= frontmatterEnd && i + 1 < lines.length && /^\s*(?:=+|-+)\s*\r?$/.test(lines[i + 1])) {
        result.push({ line: i, level: /^\s*=/.test(lines[i + 1]) ? 1 : 2, text: normalizeHeadingText(line) });
        i++;
      }
    }
    return result;
  }

  function markdownHeadingLines(markdown) {
    return markdownHeadingDescriptors(markdown).map(function(heading) { return heading.line; });
  }

  function resolveHeading(index, expected) {
    var descriptors = markdownHeadingDescriptors(editor && editor.value);
    var fallback = Number(index);
    var indexed = fallback >= 0 && fallback < descriptors.length ? descriptors[fallback] : null;
    if (expected && expected.level != null && expected.text != null) {
      var wantedLevel = Number(expected.level);
      var wantedText = normalizeHeadingText(expected.text);
      if (indexed && indexed.level === wantedLevel && indexed.text === wantedText) {
        return indexed;
      }
      var nearest = null;
      var nearestDistance = Infinity;
      for (var i = 0; i < descriptors.length; i++) {
        if (descriptors[i].level === wantedLevel && descriptors[i].text === wantedText) {
          var distance = Math.abs(i - fallback);
          if (distance < nearestDistance) {
            nearest = descriptors[i];
            nearestDistance = distance;
          }
        }
      }
      if (nearest) return nearest;
    }
    return indexed;
  }

  function measureOffsetCoordinates(offset) {
    if (!editor || !editor.ownerDocument || !editor.parentNode) return null;
    var doc = editor.ownerDocument;
    var mirror = doc.createElement('div');
    var marker = doc.createElement('span');
    var win = doc.defaultView || window;
    var cs = win && win.getComputedStyle ? win.getComputedStyle(editor) : null;
    if (typeof mirror.setAttribute === 'function') {
      mirror.setAttribute('aria-hidden', 'true');
    }
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.pointerEvents = 'none';
    mirror.style.whiteSpace = cs && cs.whiteSpace || 'pre-wrap';
    mirror.style.overflowWrap = cs && cs.overflowWrap || 'break-word';
    mirror.style.wordBreak = cs && cs.wordBreak || 'normal';
    mirror.style.tabSize = cs && (cs.tabSize || cs.MozTabSize) || '4';
    mirror.style.font = cs && cs.font || '';
    mirror.style.fontFamily = cs && cs.fontFamily || '';
    mirror.style.fontSize = cs && cs.fontSize || '';
    mirror.style.fontWeight = cs && cs.fontWeight || '';
    mirror.style.lineHeight = cs && cs.lineHeight || '';
    mirror.style.letterSpacing = cs && cs.letterSpacing || '';
    mirror.style.padding = cs && cs.padding || '';
    mirror.style.border = cs && cs.border || '';
    mirror.style.boxSizing = cs && cs.boxSizing || 'border-box';
    mirror.style.width = (editor.clientWidth || parseFloat(cs && cs.width) || 0) + 'px';

    var text = String(editor.value || '');
    var pos = Math.max(0, Math.min(Number(offset) || 0, text.length));
    var before = text.slice(0, pos);
    var charUnder = text.charAt(pos);
    var after = text.slice(pos + 1);

    marker.textContent = (!charUnder || charUnder === '\n') ? '\u200b' : charUnder;
    mirror.appendChild(doc.createTextNode(before));
    mirror.appendChild(marker);
    if (after) mirror.appendChild(doc.createTextNode(after));

    editor.parentNode.appendChild(mirror);
    var markerLeft = marker.offsetLeft || 0;
    var markerTop = marker.offsetTop || 0;
    var markerW = marker.offsetWidth || 8.5;
    var markerH = marker.offsetHeight || parseFloat(cs && cs.lineHeight) || 20;
    editor.parentNode.removeChild(mirror);

    var edOffsetLeft = editor.offsetLeft || 0;
    var edOffsetTop = editor.offsetTop || 0;
    var sLeft = editor.scrollLeft || 0;
    var sTop = editor.scrollTop || 0;

    return {
      left: edOffsetLeft + markerLeft - sLeft,
      top: edOffsetTop + markerTop - sTop,
      markerLeft: markerLeft,
      markerTop: markerTop,
      width: markerW,
      height: markerH,
      charUnder: charUnder,
      lineHeight: parseFloat(cs && cs.lineHeight) || markerH
    };
  }

  function measureOffsetTop(offset) {
    var coords = measureOffsetCoordinates(offset);
    return coords ? coords.markerTop : null;
  }

  function ensureCursorVisible(offset, marginLines) {
    if (!editor) return false;
    var coords = measureOffsetCoordinates(offset !== undefined ? offset : editor.selectionStart);
    if (!coords) return false;
    var lines = typeof marginLines === 'number' ? marginLines : 2;
    var lineHeight = coords.lineHeight || coords.height || 20;
    var margin = lineHeight * lines;
    var sTop = editor.scrollTop;
    var cHeight = editor.clientHeight;
    var sHeight = editor.scrollHeight;
    var maxScroll = Math.max(0, sHeight - cHeight);

    if (cHeight > 0 && maxScroll > 0) {
      if (coords.markerTop - margin < sTop) {
        editor.scrollTop = Math.max(0, coords.markerTop - margin);
        return true;
      } else if (coords.markerTop + lineHeight + margin > sTop + cHeight) {
        editor.scrollTop = Math.min(maxScroll, coords.markerTop + lineHeight + margin - cHeight);
        return true;
      }
    }
    return false;
  }

  function scrollToOffset(offset, end) {
    if (!editor) return false;
    var pos = Math.max(0, Math.min(Number(offset) || 0, editor.value.length));
    editor.focus();
    editor.setSelectionRange(pos, end == null ? pos : Math.max(pos, Math.min(Number(end), editor.value.length)));
    var markerTop = measureOffsetTop(pos);
    if (markerTop != null) {
      var maxScroll = Math.max(0, editor.scrollHeight - editor.clientHeight);
      editor.scrollTop = Math.max(0, Math.min(maxScroll, markerTop - editor.clientHeight / 3));
    }
    return true;
  }

  function scrollToLine(lineNumber) {
    if (!editor) return false;
    var lines = editor.value.split('\n');
    var line = Math.max(0, Math.min(Number(lineNumber) || 0, lines.length - 1));
    var pos = 0;
    for (var i = 0; i < line; i++) pos += lines[i].length + 1;
    return scrollToOffset(pos, pos + lines[line].length);
  }

  window.EditorNavigation = {
    scrollToLine: scrollToLine,
    scrollToHeading: function(index, expected) {
      var heading = resolveHeading(index, expected);
      return heading ? scrollToLine(heading.line) : false;
    },
    resolveHeading: resolveHeading,
    getHeadingDescriptors: function() {
      return markdownHeadingDescriptors(editor && editor.value);
    },
    getHeadingLines: function() {
      return markdownHeadingLines(editor && editor.value);
    },
    measureOffsetTop: measureOffsetTop,
    measureOffsetCoordinates: measureOffsetCoordinates,
    ensureCursorVisible: ensureCursorVisible,
    scrollToOffset: scrollToOffset
  };

  var changeTimer = null;
  var autoSaveTimer = null;

  function effectiveSettings() {
    var sa = window.SettingsApply;
    try { return sa && typeof sa.get === 'function' ? (sa.get() || {}) : {}; } catch (e) { return {}; }
  }

  function scheduleAutoSave() {
    clearTimeout(autoSaveTimer);
    var watching = effectiveSettings().watching || {};
    var mode = watching.autoSave || 'off';
    if (mode !== 'afterDelay') return;
    var delay = Number(watching.autoSaveDelayMs);
    if (!isFinite(delay) || delay < 0) delay = 1000;
    autoSaveTimer = setTimeout(function() {
      var tab = TabManager.getActiveTab();
      if (tab && tab.dirty && typeof doSave === 'function') doSave();
    }, delay);
  }

  editor.addEventListener('input', function() {
    // dirty 必须同步标记且绑定产生输入的 tab：若延迟到 300ms 防抖回调，
    // 输入后立即保存/关闭会在回调触发前丢失 dirty 标记而静默丢数据。
    // 防抖仅保留字数/最近面板/TOC 等重计算，回调内不得再触碰 dirty 状态，
    // 避免把已保存（clean）的 tab 重新标脏。
    var activeTab = TabManager.getActiveTab();
    if (activeTab) activeTab.parsedHtml = null;
    TabManager.markDirty(activeTab ? activeTab.id : undefined);
    clearTimeout(changeTimer);
    changeTimer = setTimeout(function() {
      updateWordCount();
      if (typeof showRecentPanel === 'function') showRecentPanel();
      if (typeof tocOpen !== 'undefined' && tocOpen) updateTOC();
    }, 300);
    if (typeof splitMode !== 'undefined' && splitMode) {
      updateSplitPreview();
    }
    scheduleAutoSave();

    // 同步 Vim 与自定义光标状态
    if (vimEnabled && vimEngine) {
      vimEngine.text = editor.value;
      vimEngine.cursor = editor.selectionStart || 0;
      updateVimUi();
    }
    if (window.CustomCaret && typeof window.CustomCaret.triggerTyping === 'function') {
      window.CustomCaret.triggerTyping();
    }
  });

  /* ══════════ Vim Mode 桥接与输入代理 ══════════ */
  var vimEngine = null;
  var vimEnabled = false;

  function executeSaveAsync() {
    if (typeof window.saveActiveTabAndWait === 'function') {
      try {
        return Promise.resolve(window.saveActiveTabAndWait());
      } catch (e) {
        return Promise.reject(e);
      }
    }
    if (window.Commands && typeof window.Commands.run === 'function') {
      try {
        var res = window.Commands.run('file.save');
        if (res && typeof res.then === 'function') {
          return res;
        }
      } catch (e) {
        return Promise.reject(e);
      }
    }
    if (typeof window.doSave === 'function') {
      try {
        window.doSave();
        return Promise.resolve(true);
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return Promise.resolve(false);
  }

  function isVimAllowed() {
    var sa = window.SettingsApply;
    try {
      var s = sa && typeof sa.get === 'function' ? sa.get() : {};
      return Boolean(s.editor && s.editor.vim && s.editor.vim.enabled);
    } catch (e) {
      return false;
    }
  }

  function ensureVimEngine() {
    if (!editor || !window.VimEngine) return null;
    if (!vimEngine) {
      vimEngine = new window.VimEngine({
        textarea: editor,
        cursor: editor.selectionStart || 0,
        commandRunner: function(name, opts) {
          var isBang = (opts && opts.bang) || /!$/.test(name);
          var baseName = name.replace(/!$/, '');

          if (baseName === 'w') {
            executeSaveAsync();
          } else if (baseName === 'wa') {
            if (window.Commands && window.Commands.has('file.saveAll')) {
              window.Commands.run('file.saveAll');
            } else {
              executeSaveAsync();
            }
          } else if (baseName === 'q') {
            // 最新用户明确改变Ex语义：:q/:q!退出Vim但保留编辑内容dirty且不关闭tab不保存
            toggleVimMode(false);
          } else if (baseName === 'wq' || baseName === 'x') {
            // :wq/:x必须保存成功才退出Vim，保存失败/取消仍在Vim
            executeSaveAsync().then(function(saved) {
              if (saved === true) {
                toggleVimMode(false);
              } else {
                if (window.VimUI && typeof window.VimUI.setMessage === 'function') {
                  window.VimUI.setMessage('保存未完成，保持 Vim 模式', 'info');
                }
              }
            }).catch(function(err) {
              if (window.VimUI && typeof window.VimUI.setMessage === 'function') {
                window.VimUI.setMessage('保存失败，保持 Vim 模式', 'error');
              }
            });
          } else if (window.Commands && typeof window.Commands.run === 'function') {
            if (baseName === 'bn') {
              window.Commands.run('tabs.next');
            } else if (baseName === 'bp') {
              window.Commands.run('tabs.previous');
            } else if (baseName === 'e') {
              if (window.Commands.has('recovery.reload')) window.Commands.run('recovery.reload', opts);
            } else if (baseName === 'ls') {
              if (window.TabManager && typeof window.TabManager.getTabs === 'function') return window.TabManager.getTabs();
            } else if (baseName === 'set' && opts && opts.args) {
              if (opts.args === 'wrap') {
                if (window.SettingsApply && typeof window.SettingsApply.patch === 'function') {
                  window.SettingsApply.patch({ editor: { wordWrap: 'on' } });
                } else {
                  toggleEditorWrap(true);
                }
              } else if (opts.args === 'nowrap') {
                if (window.SettingsApply && typeof window.SettingsApply.patch === 'function') {
                  window.SettingsApply.patch({ editor: { wordWrap: 'off' } });
                } else {
                  toggleEditorWrap(false);
                }
              }
            } else if (baseName === 'noh' || baseName === 'nohlsearch') {
              if (typeof clearFind === 'function') clearFind();
            }
          }
        }
      });
    }
    return vimEngine;
  }

  function syncVimContext() {
    if (!window.contextKeys) return;
    if (!vimEnabled || !vimEngine) {
      window.contextKeys.remove('vim.normal');
      window.contextKeys.remove('vim.insert');
      window.contextKeys.remove('vim.visual');
      window.contextKeys.remove('vim.commandLine');
      return;
    }
    var m = vimEngine.mode || 'Normal';
    window.contextKeys.set('vim.normal', m === 'Normal');
    window.contextKeys.set('vim.insert', m === 'Insert');
    window.contextKeys.set('vim.visual', m.indexOf('Visual') === 0);
    window.contextKeys.set('vim.commandLine', m === 'CommandLine');
  }

  function updateVimUi() {
    if (window.VimUI && typeof window.VimUI.update === 'function') {
      if (vimEnabled && vimEngine) {
        window.VimUI.update(vimEngine.getState());
        if (window.CustomCaret && typeof window.CustomCaret.setEnabled === 'function') {
          // Vim 模式下仅 Insert 模式显示 3px 竖线光标，Normal/Visual 等使用方块光标
          var isInsert = vimEngine.mode === 'Insert';
          window.CustomCaret.setEnabled(isInsert);
        }
      } else if (window.VimUI.unmount) {
        window.VimUI.unmount();
        if (window.CustomCaret && typeof window.CustomCaret.setEnabled === 'function') {
          window.CustomCaret.setEnabled(true);
        }
      }
    }
    syncVimContext();
  }

  function toggleEditorWrap(force) {
    if (!editor) return false;
    var isCurrentlyWrapping = true;
    if (window.SettingsApply && typeof window.SettingsApply.get === 'function') {
      var eff = window.SettingsApply.get();
      if (eff && eff.editor && typeof eff.editor.wordWrap === 'boolean') {
        isCurrentlyWrapping = eff.editor.wordWrap;
      }
    } else if (typeof editor.getAttribute === 'function') {
      isCurrentlyWrapping = (editor.getAttribute('wrap') !== 'off' && (!editor.classList || !editor.classList.contains('wrap-off')));
    }
    var nextWrap = force !== undefined ? Boolean(force) : !isCurrentlyWrapping;
    var savedOffset = (editor && typeof editor.selectionStart === 'number') ? editor.selectionStart : 0;

    if (window.SettingsApply && typeof window.SettingsApply.patch === 'function') {
      window.SettingsApply.patch({ editor: { wordWrap: nextWrap } });
    } else if (window.SettingsApply && typeof window.SettingsApply.applyWordWrap === 'function') {
      window.SettingsApply.applyWordWrap(nextWrap);
    } else {
      var wrapAttr = nextWrap ? 'soft' : 'off';
      if (typeof editor.getAttribute === 'function' && editor.getAttribute('wrap') !== wrapAttr) {
        var val = editor.value;
        editor.setAttribute('wrap', wrapAttr);
        editor.value = val;
      }
      if (editor.classList && typeof editor.classList.toggle === 'function') {
        editor.classList.toggle('wrap-off', !nextWrap);
      }
      if (window.SettingsApply && typeof window.SettingsApply.syncGutter === 'function') {
        window.SettingsApply.syncGutter();
      }
      if (window.SettingsApply && typeof window.SettingsApply.updateWordWrapButton === 'function') {
        window.SettingsApply.updateWordWrapButton(nextWrap);
      }
    }

    if (editor && typeof editor.setSelectionRange === 'function') {
      editor.setSelectionRange(savedOffset, savedOffset);
    }
    if (window.EditorNavigation && typeof window.EditorNavigation.scrollToOffset === 'function') {
      window.EditorNavigation.scrollToOffset(savedOffset);
    }
    if (window.CustomCaret && typeof window.CustomCaret.update === 'function') {
      window.CustomCaret.update();
    }
    if (typeof window.updateEditorFindMarkers === 'function') {
      window.updateEditorFindMarkers();
    }
    if (typeof window.showAppToast === 'function') {
      var t = window.I18n && typeof window.I18n.t === 'function' ? window.I18n.t : function(k) { return k; };
      window.showAppToast(nextWrap ? t('toast.wordWrapOn') : t('toast.wordWrapOff'), 1200);
    }
    return nextWrap;
  }
  window.toggleEditorWrap = toggleEditorWrap;

  function toggleVimMode(force) {
    var next = force !== undefined ? Boolean(force) : !vimEnabled;
    if (next) {
      if (typeof currentMode !== 'undefined' && currentMode === 'preview' && typeof toggleMode === 'function') {
        toggleMode();
        scrollToOffset(editor.selectionStart);
      }
      var eng = ensureVimEngine();
      if (!eng) {
        vimEnabled = false;
        updateVimUi();
        return false;
      }
      vimEnabled = true;
      eng.text = editor.value;
      eng.cursor = Math.max(0, Math.min(editor.value.length, editor.selectionStart || 0));
      eng.mode = 'Normal';
      eng.pending = '';
      eng.count = '';
      eng._sync();
      if (editor.scrollHeight > editor.clientHeight) {
        var maxScroll = editor.scrollHeight - editor.clientHeight;
        if (editor.scrollTop > maxScroll) editor.scrollTop = maxScroll;
      }
      if (window.VimUI && typeof window.VimUI.mount === 'function') {
        var editorCont = document.getElementById('editor-container') || (editor && editor.parentNode);
        var sb = document.getElementById('statusbar') || document.getElementById('status-bar');
        window.VimUI.mount({
          container: sb,
          editorTarget: editorCont,
          commandContainer: editorCont,
          editorElement: editor,
          enabled: true,
          initialState: eng.getState()
        });
      }
      if (window.VimUI && typeof window.VimUI.showToast === 'function') {
        // 翻译交给 VimUI 内建双语回退字典（全局 I18n 字典无 vim.toast.* 条目，直接 t 会显示裸 key）
        window.VimUI.showToast(null, 1500, 'vim.toast.enter');
      }
    } else {
      vimEnabled = false;
      if (window.VimUI && typeof window.VimUI.showToast === 'function') {
        window.VimUI.showToast(null, 1500, 'vim.toast.exit');
      }
      if (window.VimUI && typeof window.VimUI.unmount === 'function') {
        window.VimUI.unmount();
      }
    }
    updateVimUi();
    return vimEnabled;
  }

  function initEditorCommands() {
    if (!window.Commands || typeof window.Commands.register !== 'function') return;
    if (!window.Commands.has('editor.toggleWrap')) {
      window.Commands.register('editor.toggleWrap', {
        label: '切换自动换行',
        category: 'View',
        run: function(force) { return toggleEditorWrap(force); }
      });
    }
    if (!window.Commands.has('editor.vim.toggle')) {
      window.Commands.register('editor.vim.toggle', {
        label: '切换 Vim 模式',
        category: 'Editor',
        run: function(force) { return toggleVimMode(force); }
      });
    }
  }

  function initCustomCaret() {
    if (typeof window !== 'undefined' && !window.CustomCaret) {
      // 保证在未通过独立 <script src="caret.js"> 引入时依然具备完整自定义光标能力
      var caretState = {
        mounted: false,
        enabled: true,
        visible: false,
        isComposing: false,
        isTyping: false,
        typingTimer: null,
        relocateTimer: null,
        dom: { editor: null, container: null, caretEl: null, mirrorEl: null, markerSpan: null },
        listeners: [],
        lastOffset: 0
      };

      function setNativeCaretVisible(visible) {
        var ed = caretState.dom.editor;
        if (!ed) return;
        if (visible) {
          ed.classList.remove('custom-caret-active');
          ed.style.caretColor = '';
        } else {
          ed.classList.add('custom-caret-active');
          ed.style.caretColor = 'transparent';
        }
      }

      function updateCaret() {
        if (!caretState.mounted || !caretState.dom.editor || !caretState.dom.caretEl) return;
        var ed = caretState.dom.editor;
        var caretEl = caretState.dom.caretEl;
        var doc = ed.ownerDocument || document;
        var isFocused = doc.activeElement === ed;
        var selStart = ed.selectionStart;
        var selEnd = ed.selectionEnd;
        var hasRangeSelection = (selStart !== selEnd);

        if (!caretState.enabled || !isFocused || hasRangeSelection || caretState.isComposing || (vimEnabled && vimEngine && vimEngine.mode !== 'Insert')) {
          caretEl.style.display = 'none';
          if (caretState.isComposing) setNativeCaretVisible(true);
          return;
        }

        var pos = selStart || 0;
        caretState.lastOffset = pos;
        var coords = window.EditorNavigation && typeof window.EditorNavigation.measureOffsetCoordinates === 'function'
          ? window.EditorNavigation.measureOffsetCoordinates(pos)
          : null;

        if (!coords) {
          caretEl.style.display = 'none';
          setNativeCaretVisible(true);
          return;
        }

        setNativeCaretVisible(false);
        var edLeft = ed.offsetLeft || 0;
        var edTop = ed.offsetTop || 0;
        var edW = ed.clientWidth || 0;
        var edH = ed.clientHeight || 0;

        if (coords.left < edLeft - 5 || coords.left > edLeft + edW + 5 ||
            coords.top < edTop - coords.height || coords.top > edTop + edH + coords.height) {
          caretEl.style.display = 'none';
          return;
        }

        caretEl.style.display = 'block';
        caretEl.style.left = coords.left + 'px';
        caretEl.style.top = coords.top + 'px';
        caretEl.style.height = coords.height + 'px';
      }

      function triggerTyping() {
        if (!caretState.dom.caretEl) return;
        var caretEl = caretState.dom.caretEl;
        caretEl.classList.add('custom-caret-solid');
        caretEl.classList.remove('custom-caret-blink');
        clearTimeout(caretState.typingTimer);
        clearTimeout(caretState.relocateTimer);
        caretState.isTyping = true;
        updateCaret();
        caretState.typingTimer = setTimeout(function() {
          caretState.isTyping = false;
          if (caretEl) {
            caretEl.classList.remove('custom-caret-solid');
            caretEl.classList.add('custom-caret-blink');
          }
        }, 500);
      }

      function triggerRelocated() {
        if (!caretState.dom.caretEl) return;
        var caretEl = caretState.dom.caretEl;
        caretEl.classList.add('custom-caret-solid');
        caretEl.classList.remove('custom-caret-blink');
        clearTimeout(caretState.typingTimer);
        clearTimeout(caretState.relocateTimer);
        updateCaret();
        caretState.relocateTimer = setTimeout(function() {
          if (caretEl) {
            caretEl.classList.remove('custom-caret-solid');
            caretEl.classList.add('custom-caret-blink');
          }
        }, 1000);
      }

      function mountCaret(options) {
        options = options || {};
        var ed = options.editor || editor;
        if (!ed) return window.CustomCaret;
        var cont = options.container || document.getElementById('editor-container') || ed.parentNode;
        var doc = ed.ownerDocument || document;

        var caretEl = doc.getElementById('custom-caret');
        if (!caretEl) {
          caretEl = doc.createElement('div');
          caretEl.id = 'custom-caret';
          caretEl.className = 'custom-caret custom-caret-blink';
          caretEl.setAttribute('aria-hidden', 'true');
          caretEl.style.display = 'none';
          if (cont) cont.appendChild(caretEl);
        }

        caretState.dom.editor = ed;
        caretState.dom.container = cont;
        caretState.dom.caretEl = caretEl;
        caretState.mounted = true;
        caretState.enabled = options.enabled !== undefined ? !!options.enabled : true;

        ed.addEventListener('scroll', updateCaret);
        ed.addEventListener('select', updateCaret);
        ed.addEventListener('click', triggerRelocated);
        ed.addEventListener('focus', triggerRelocated);
        ed.addEventListener('keydown', function(e) {
          if (e.isComposing) return;
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
              e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') {
            setTimeout(triggerRelocated, 0);
          }
        });
        if (doc && typeof doc.addEventListener === 'function') {
          doc.addEventListener('selectionchange', function() {
            if (doc.activeElement === ed) {
              updateCaret();
            }
          });
        }
        ed.addEventListener('blur', function() {
          if (caretState.dom.caretEl) caretState.dom.caretEl.style.display = 'none';
          setNativeCaretVisible(true);
        });

        ed.addEventListener('compositionstart', function() {
          caretState.isComposing = true;
          if (caretState.dom.caretEl) caretState.dom.caretEl.style.display = 'none';
          setNativeCaretVisible(true);
        });

        ed.addEventListener('compositionupdate', function() {
          caretState.isComposing = true;
          if (caretState.dom.caretEl) caretState.dom.caretEl.style.display = 'none';
          setNativeCaretVisible(true);
        });

        ed.addEventListener('compositionend', function() {
          caretState.isComposing = false;
          setNativeCaretVisible(false);
          triggerRelocated();
        });

        updateCaret();
        return window.CustomCaret;
      }

      window.CustomCaret = {
        mount: mountCaret,
        unmount: function() {
          if (caretState.dom.caretEl && caretState.dom.caretEl.parentNode) {
            caretState.dom.caretEl.parentNode.removeChild(caretState.dom.caretEl);
          }
          setNativeCaretVisible(true);
          caretState.mounted = false;
        },
        update: updateCaret,
        setEnabled: function(v) { caretState.enabled = Boolean(v); updateCaret(); },
        triggerTyping: triggerTyping,
        triggerRelocated: triggerRelocated,
        getState: function() {
          return {
            mounted: caretState.mounted,
            enabled: caretState.enabled,
            isComposing: caretState.isComposing,
            isTyping: caretState.isTyping,
            lastOffset: caretState.lastOffset
          };
        }
      };
    }

    if (window.CustomCaret && typeof window.CustomCaret.mount === 'function' && editor) {
      var editorCont = document.getElementById('editor-container') || editor.parentNode;
      window.CustomCaret.mount({
        editor: editor,
        container: editorCont,
        enabled: true
      });
    }
  }

  // editor.js 在 commands.js 之前加载时，DOMContentLoaded 补偿注册；
  // commands.js 已存在时立即注册，确保全局 chord 不受初始化时序影响。
  initCustomCaret();
  initEditorCommands();
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', function() {
      initCustomCaret();
      initEditorCommands();
      if (isVimAllowed()) {
        toggleVimMode(true);
      }
    });
  } else {
    initEditorCommands();
  }

  if (editor && typeof editor.addEventListener === 'function') {
    editor.addEventListener('focus', function() {
      if (window.contextKeys) window.contextKeys.set('editorTextFocus', true);
      if (vimEnabled) {
        ensureVimEngine();
        updateVimUi();
      }
    });

    editor.addEventListener('click', function() {
      if (vimEnabled && vimEngine) {
        vimEngine.cursor = editor.selectionStart || 0;
        updateVimUi();
      }
    });

    editor.addEventListener('keyup', function(e) {
      if (vimEnabled && vimEngine) {
        vimEngine.cursor = editor.selectionStart || 0;
        updateVimUi();
      }
    });

    editor.addEventListener('blur', function() {
      if (window.contextKeys) window.contextKeys.remove('editorTextFocus');
      var watching = effectiveSettings().watching || {};
      if (watching.autoSave === 'onFocusLost') {
        var tab = TabManager.getActiveTab();
        if (tab && tab.dirty && typeof doSave === 'function') doSave();
      }
    });

    // Tab key inserts spaces (but not Ctrl+Tab which switches tabs)
    editor.addEventListener('keydown', function(e) {
      if (vimEnabled && vimEngine) {
        // 带应用级修饰键的快捷键/chord 交给全局分派器，Vim 只处理无修饰编辑键与特定 Vim 控制键 (如 Ctrl+R)。
        if (e.isComposing || vimEngine.composing) return;
        if (window.BindingService && window.BindingService.pending) return;
        if (e.altKey || e.metaKey || (e.ctrlKey && e.key !== 'r' && e.key !== 'R')) return;
        var res = vimEngine.handleKey(e.key, e);
        if (res && res.handled) {
          e.preventDefault();
          e.stopPropagation();
          updateVimUi();
          if (window.CustomCaret && typeof window.CustomCaret.triggerTyping === 'function') {
            window.CustomCaret.triggerTyping();
          }
          TabManager.markDirty();
          if (typeof splitMode !== 'undefined' && splitMode) updateSplitPreview();
          return;
        }
      }

      if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        e.stopPropagation();
        var pageSize = Math.max(40, (editor.clientHeight || 400) - 50);
        var dir = e.key === 'PageDown' ? 1 : -1;
        editor.scrollTop = Math.max(0, editor.scrollTop + dir * pageSize);
        if (window.CustomCaret && typeof window.CustomCaret.update === 'function') {
          window.CustomCaret.update();
        }
        return;
      }

      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        // Tab 宽度读设置生效层（editor.tabSize，settings-apply.js 维护），缺省 4
        var sa = window.SettingsApply;
        var tabSize = (sa && typeof sa.get === 'function' && sa.get().editor.tabSize) || 4;
        if (!isFinite(tabSize) || tabSize < 1) tabSize = 4;
        var spaces = new Array(tabSize + 1).join(' ');
        var start = editor.selectionStart;
        var end = editor.selectionEnd;
        editor.value = editor.value.substring(0, start) + spaces + editor.value.substring(end);
        editor.selectionStart = editor.selectionEnd = start + tabSize;
        editor.dispatchEvent(new Event('input'));
        TabManager.markDirty();
        if (typeof splitMode !== 'undefined' && splitMode) updateSplitPreview();
      }
    });
  }

  window.EditorVim = {
    toggle: toggleVimMode,
    isEnabled: function() { return vimEnabled; },
    getEngine: function() { return vimEngine; }
  };
})();
