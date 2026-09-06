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

  function scrollToLine(lineNumber) {
    if (!editor) return false;
    var lines = editor.value.split('\n');
    var line = Math.max(0, Math.min(Number(lineNumber) || 0, lines.length - 1));
    var pos = 0;
    for (var i = 0; i < line; i++) pos += lines[i].length + 1;
    editor.focus();
    editor.setSelectionRange(pos, pos + lines[line].length);
    var lineHeight = lines.length && editor.scrollHeight ? editor.scrollHeight / lines.length : 0;
    if (lineHeight > 0 && isFinite(lineHeight)) {
      editor.scrollTop = Math.max(0, line * lineHeight - editor.clientHeight / 3);
    }
    return true;
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
    }
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
    var activeTab = TabManager.getActiveTab();
    if (activeTab) activeTab.parsedHtml = null;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(function() {
      TabManager.markDirty();
      updateWordCount();
      if (typeof showRecentPanel === 'function') showRecentPanel();
      if (typeof tocOpen !== 'undefined' && tocOpen) updateTOC();
    }, 300);
    if (typeof splitMode !== 'undefined' && splitMode) {
      updateSplitPreview();
    }
    scheduleAutoSave();
  });

  editor.addEventListener('blur', function() {
    var watching = effectiveSettings().watching || {};
    if (watching.autoSave === 'onFocusLost') {
      var tab = TabManager.getActiveTab();
      if (tab && tab.dirty && typeof doSave === 'function') doSave();
    }
  });

  // Tab key inserts spaces (but not Ctrl+Tab which switches tabs)
  editor.addEventListener('keydown', function(e) {
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey) {
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
})();
