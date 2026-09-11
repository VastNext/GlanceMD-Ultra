(function (root) {
  'use strict';

  function record(commandId, sequence, when, platform, passthrough) {
    return {
      commandId: commandId,
      sequence: sequence,
      when: when || '',
      platform: platform || '*',
      source: 'default',
      removed: false,
      passthrough: Boolean(passthrough)
    };
  }

  var eclipse = [
    record('outline.quickOpen', 'Ctrl+O'),
    record('outline.toggle', 'Ctrl+Shift+O'),
    record('file.saveAll', 'Ctrl+Shift+S'),
    record('file.saveAs', 'Alt+Shift+S'),
    record('file.open', 'Ctrl+Alt+O'),
    record('workspace.open', 'Ctrl+Alt+P'),
    record('settings.toggle', 'Alt+Shift+P'),
    record('settings.keybindings', 'Alt+Shift+P K', 'settingsFocus'),
    record('editor.vim.toggle', 'Alt+Shift+E V'),
    record('palette.toggle', 'Ctrl+3'),
    record('keyassist.toggle', 'Ctrl+Shift+L'),
    record('search.toggle', 'Ctrl+H'),
    record('tabs.quickSwitch', 'Ctrl+E'),
    record('resource.open', 'Ctrl+Shift+R'),
    record('tabs.next', 'Ctrl+F6'),
    record('tabs.previous', 'Ctrl+Shift+F6'),
    record('focus.next', 'Ctrl+F7'),
    record('focus.previous', 'Ctrl+Shift+F7'),
    record('editor.focus', 'F12'),
    record('file.save', 'Ctrl+S'),
    record('file.new', 'Ctrl+N'),
    record('file.close', 'Ctrl+W'),
    record('editor.undo', 'Ctrl+Z', 'editorTextFocus'),
    record('editor.redo', 'Ctrl+Y', 'editorTextFocus'),
    record('editor.cut', 'Ctrl+X', 'editorTextFocus', '*', true),
    record('editor.copy', 'Ctrl+C', 'editorTextFocus', '*', true),
    record('editor.paste', 'Ctrl+V', 'editorTextFocus', '*', true),
    record('editor.selectAll', 'Ctrl+A', 'editorTextFocus'),
    record('editor.deleteLines', 'Ctrl+D', 'editorTextFocus'),
    record('editor.deleteToLineEnd', 'Ctrl+Shift+Delete', 'editorTextFocus'),
    record('editor.moveLinesUp', 'Alt+ArrowUp', 'editorTextFocus'),
    record('editor.moveLinesDown', 'Alt+ArrowDown', 'editorTextFocus'),
    record('editor.copyLinesUp', 'Ctrl+Alt+ArrowUp', 'editorTextFocus'),
    record('editor.copyLinesDown', 'Ctrl+Alt+ArrowDown', 'editorTextFocus'),
    record('editor.insertLineBelow', 'Shift+Enter', 'editorTextFocus'),
    record('editor.insertLineAbove', 'Ctrl+Shift+Enter', 'editorTextFocus'),
    record('editor.outdent', 'Shift+Tab', 'editorTextFocus'),
    record('editor.scrollLineUp', 'Ctrl+ArrowUp', 'editorTextFocus'),
    record('editor.scrollLineDown', 'Ctrl+ArrowDown', 'editorTextFocus'),
    record('editor.previousHeading', 'Ctrl+Shift+ArrowUp', 'editorTextFocus'),
    record('editor.nextHeading', 'Ctrl+Shift+ArrowDown', 'editorTextFocus'),
    record('editor.goToLine', 'Ctrl+L', 'editorTextFocus'),
    record('actions.find', 'Ctrl+F'),
    record('actions.find.next', 'Ctrl+K'),
    record('actions.find.previous', 'Ctrl+Shift+K'),
    record('actions.find.incrementalNext', 'Ctrl+J'),
    record('actions.find.incrementalPrevious', 'Ctrl+Shift+J'),
    record('editor.uppercase', 'Ctrl+Shift+X', 'editorTextFocus'),
    record('editor.lowercase', 'Ctrl+Shift+Y', 'editorTextFocus'),
    record('editor.toggleComment', 'Ctrl+/', 'editorTextFocus'),
    record('editor.addBlockComment', 'Ctrl+Shift+/', 'editorTextFocus'),
    record('editor.removeBlockComment', 'Ctrl+Shift+\\', 'editorTextFocus'),
    record('editor.toggleWrap', 'Alt+Shift+Y', 'editorTextFocus'),
    record('editor.togglePreview', 'Ctrl+Shift+V'),
    record('editor.toggleSplit', 'Ctrl+\\'),
    // translate.selection 不设 when：编辑区与预览区选中的文本都要能呼出划词气泡
    // （无选区时命令自身空转）；直接替换写入编辑区，保留 editorTextFocus。
    record('translate.selection', 'Alt+T'),
    record('translate.selectionReplace', 'Alt+Shift+T', 'editorTextFocus')
  ];

  var vscode = [
    record('file.open', 'Ctrl+O'), record('workspace.open', 'Ctrl+K Ctrl+O'), record('file.new', 'Ctrl+N'),
    record('file.save', 'Ctrl+S'), record('file.saveAs', 'Ctrl+Shift+S'),
    record('file.close', 'Ctrl+W'), record('quickopen.toggle', 'Ctrl+P'),
    record('search.toggle', 'Ctrl+Shift+F'), record('palette.toggle', 'Ctrl+Shift+P'),
    record('outline.toggle', 'Ctrl+Shift+O'), record('settings.keybindings', 'Ctrl+K Ctrl+S'),
    record('settings.toggle', 'Ctrl+,'), record('tabs.quickSwitch', 'Ctrl+Tab'),
    record('actions.find', 'Ctrl+F'),
    record('editor.togglePreview', 'Ctrl+Shift+V'),
    record('editor.toggleSplit', 'Ctrl+\\'),
    record('editor.toggleSplit', 'Ctrl+K V'),
    record('editor.focus', 'F12'),
    record('translate.selection', 'Alt+T'),
    record('translate.selectionReplace', 'Alt+Shift+T', 'editorTextFocus')
  ];

  var schemes = {
    'ultra.eclipse': eclipse,
    'ultra.vscode': vscode
  };
  root.DefaultKeybindings = {
    schemes: schemes,
    defaultScheme: 'ultra.eclipse',
    eclipse: eclipse,
    vscode: vscode,
    all: eclipse.concat(vscode)
  };
})(typeof window !== 'undefined' ? window : globalThis);
