(function() {
  var editor = document.getElementById('editor');

  var changeTimer = null;
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
