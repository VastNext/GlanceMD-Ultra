(function (root) {
  'use strict';

  function record(commandId, sequence, when, platform) {
    return {
      commandId: commandId,
      sequence: sequence,
      when: when || '',
      platform: platform || '*',
      source: 'default',
      removed: false
    };
  }

  var eclipse = [
    record('outline.quickOpen', 'Ctrl+O'),
    record('file.saveAll', 'Ctrl+Shift+S'),
    record('file.saveAs', 'Alt+Shift+S'),
    record('file.open', 'Alt+Shift+F O'),
    record('workspace.open', 'Alt+Shift+F P'),
    record('settings.toggle', 'Alt+Shift+P'),
    record('settings.keybindings', 'Alt+Shift+P K', 'settingsFocus'),
    record('editor.vim.toggle', 'Alt+Shift+E V'),
    record('palette.toggle', 'Ctrl+3'),
    record('search.toggle', 'Ctrl+H'),
    record('tabs.quickSwitch', 'Ctrl+E'),
    record('tabs.next', 'Ctrl+F6'),
    record('tabs.previous', 'Ctrl+Shift+F6'),
    record('focus.next', 'Ctrl+F7'),
    record('focus.previous', 'Ctrl+Shift+F7'),
    record('editor.focus', 'F12'),
    record('file.save', 'Ctrl+S'),
    record('file.new', 'Ctrl+N'),
    record('file.close', 'Ctrl+W')
  ];

  var vscode = [
    record('file.open', 'Ctrl+O'), record('file.new', 'Ctrl+N'),
    record('file.save', 'Ctrl+S'), record('file.saveAs', 'Ctrl+Shift+S'),
    record('file.close', 'Ctrl+W'), record('quickopen.toggle', 'Ctrl+P'),
    record('search.toggle', 'Ctrl+Shift+F'), record('palette.toggle', 'Ctrl+Shift+P'),
    record('outline.toggle', 'Ctrl+Shift+O'), record('settings.keybindings', 'Ctrl+K Ctrl+S'),
    record('settings.toggle', 'Ctrl+,'), record('tabs.quickSwitch', 'Ctrl+Tab'),
    record('editor.focus', 'F12')
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
