// 国际化基础设施（用户反馈 #6）—— window.I18n
// 装载顺序：main.rs::build_html 将本文件放在全部产品脚本**最前**（highlight 之前），
// 保证 tabs/project-tree/recovery 等模块执行时 window.I18n 已可用。
//
// 设计要点：
// - 字典 LOCALES 为扁平点分 key（'app.saved'、'tree.cut'），zh-CN 为默认语言与
//   回退语言；en 为第二语言。键缺失时先回退 zh-CN，仍缺失返回 key 本身。
// - 语言持久化到 localStorage 'glancemd-ultra-language'（阶段 0 身份前缀约定）。
// - setLanguage 时向 window 派发 'i18n-changed' 事件：已打开的面板/菜单监听后
//   重渲染；静态 chrome 由 applyDom 重刷。生效边界：切换语言后**重新打开**的
//   面板/菜单使用新语言（详见各模块的 i18n-changed 监听）。
// - 与 settings 的关系：appearance.language（Rust schema v1）由设置页下拉接线
//   （集成者在 settings.js 中调 I18n.setLanguage）；本模块 init 只读 localStorage，
//   不与 settings-apply 跨模块耦合。
// - applyDom 按 data-i18n（textContent）/ data-i18n-title / data-i18n-aria /
//   data-i18n-placeholder 替换静态 chrome；HTML 中的默认文案即 zh-CN 值，
//   无 JS 时页面保持可读。macOS 平台下 title 中的 'Ctrl+' 沿用 app.js 惯例替换为 '⌘'。
(function() {
  'use strict';

  var LOCALE_KEY = 'glancemd-ultra-language';
  var DEFAULT_LANGUAGE = 'zh-CN';
  var CHANGED_EVENT = 'i18n-changed';

  /* ── 字典（扁平点分 key；zh-CN 值与迁移前各文件内联文案逐条对齐） ── */
  var LOCALES = {
    'zh-CN': {
      // app：全局状态栏 / 最近文件 / 查找栏 / 编辑占位 / 导航回退 / 拖放
      'app.saved': '已保存',
      'app.error': '错误：{message}',
      'app.word': '{n} 词',
      'app.words': '{n} 词',
      'app.recentFiles': '最近文件',
      'app.noResults': '无结果',
      'app.find': '查找…',
      'app.unsavedClose': '有未保存的修改，确定关闭窗口吗？',
      'app.noHeadings': '无标题',
      'app.findProgress': '{n}/{m}',
      'app.editorPlaceholder': '开始书写 Markdown…',
      'app.dropToOpen': '拖放以打开',
      'app.cannotOpenLink': '无法打开链接',
      'app.backToDoc': '返回文档',
      'app.retry': '重试',
      'app.dismissNotice': '关闭提示',

      // welcome：欢迎视图
      'welcome.subtitle': '轻量原生 Markdown 工作区编辑器',
      'welcome.newFile': '新建文件',
      'welcome.openFile': '打开文件',
      'welcome.openFolder': '打开文件夹',
      'welcome.noRecent': '暂无最近文件',
      'welcome.clearRecent': '清除',
      'welcome.recentProjects': '最近目录',
      'welcome.recentFiles': '最近文件',
      'welcome.noRecentProjects': '尚未打开过项目，点击上方打开文件夹开始',
      'welcome.currentProject': '当前',

      // tabs：未命名 / 关闭确认 / 批量关闭确认 / 右键菜单
      'tabs.untitled': '未命名',
      'tabs.image': '图片',
      'tabs.closeConfirm': '“{name}” 有未保存的修改，确定关闭？',
      'tabs.closeBatchConfirm': '有 {n} 个未保存的标签页，确定全部关闭？',
      'tabs.menuClose': '关闭',
      'tabs.menuCloseLeft': '关闭左侧标签',
      'tabs.menuCloseRight': '关闭右侧标签',
      'tabs.menuCloseAll': '关闭所有标签',
      'tabs.menuAria': '标签页操作',

      // tree：项目树空态 / 右键菜单 12 项 / 确认 / aria
      'tree.emptyState': '尚未打开项目',
      'tree.ariaTree': '项目树',
      'tree.menuAria': '项目树操作',
      'tree.createFile': '新建文件',
      'tree.createFilePlaceholder': '新建文件（无扩展名自动补 .md）',
      'tree.createDir': '新建文件夹',
      'tree.cut': '剪切',
      'tree.copy': '复制',
      'tree.paste': '粘贴',
      'tree.rename': '重命名',
      'tree.delete': '删除',
      'tree.deletePermanent': '永久删除',
      'tree.deletePermanentConfirm': '永久删除选中的 {n} 项？此操作不可撤销。',
      'tree.openInTerminal': '在终端中打开',
      'tree.revealInFileManager': '在文件管理器中显示',
      'tree.copyAbsolutePath': '复制绝对路径',
      'tree.copyRelativePath': '复制相对路径',
      'tree.revealCurrent': '定位当前文件',
      'tree.explorer': '资源管理器',

      // settings：设置页通用词（分类与键的中文标签即中文原文，不进字典；
      // 语言下拉由集成者在 settings.js 接线 I18n.setLanguage）
      'settings.title': '设置',
      'settings.searchPlaceholder': '搜索设置',
      'settings.close': '关闭',
      'settings.openJson': '打开设置JSON',
      'settings.noMatch': '没有匹配的设置',
      'settings.projectOverridden': '项目已覆盖',
      'settings.categoryEmpty': '该分类暂无可配置项',
      'settings.terminal': '终端程序',
      'settings.terminalDesc': '在终端中打开项目或目录时调用的程序',
      'settings.terminalAuto': '自动（检测已安装终端）',
      'settings.terminalScanning': '正在扫描系统终端…',
      'settings.terminalCustom': '自定义…',
      'settings.terminalCustomPlaceholder': '可执行文件完整路径',
      'settings.terminalArgs': '终端参数',
      'settings.terminalArgsDesc': '附加启动参数，支持 {dir} 作为目标目录占位符',
      'settings.terminalArgsPlaceholder': '例如 -e /bin/zsh -c "cd {dir}"，支持 {dir} 占位符',
      'settings.cliTitle': 'Glance 命令行工具',
      'settings.cliDesc': '先点击安装再使用 gmdu .。Windows 自动添加程序 bin 到用户 PATH，请重开终端；macOS/Linux 请确保 ~/.local/bin 在 PATH 中。',
      'settings.cliInstall': '安装 gmdu 命令',
      'settings.cliRemove': '移除 gmdu 命令',
      'settings.cliDirectory': '安装目录',
      'settings.windowCategory': '窗口与命令行',
      'settings.windowCategoryDesc': '窗口多开复用与命令行工具集成',
      'settings.reuseWindowForFolder': '命令行打开目录时复用已有窗口',
      'settings.reuseWindowForFolderDesc': '仅 Windows：关闭（默认）时每次打开新窗口；开启后切换已有窗口工作区',

      // search：全文搜索面板
      'search.title': '全文搜索',
      'search.placeholder': '搜索项目',
      'search.includeGlob': '包含 glob',
      'search.excludeGlob': '排除 glob',
      'search.searching': '搜索中…',
      'search.noResults': '无匹配结果',
      'search.cancelled': '已取消',
      'search.completed': '完成：{n} 个结果',
      'search.truncated': '（已截断）',
      'search.failed': '搜索失败',

      // quickopen：快速打开
      'quickopen.placeholder': '快速打开文件',
      'quickopen.noMatches': '无匹配文件',

      // palette：命令面板
      'palette.placeholder': '输入命令',

      // recovery：冲突横幅 / 崩溃恢复面板 / 恢复内容浮层
      'recovery.bannerModifiedTitle': '文件已在外部被修改',
      'recovery.bannerModifiedDesc': '——你的编辑尚未保存',
      'recovery.bannerRemovedTitle': '磁盘文件已被删除',
      'recovery.bannerRemovedDesc': '——内容仍保留在编辑器中，不会静默丢失',
      'recovery.diskVersion': '磁盘版本 {time}',
      'recovery.removedAt': '删除发生于 {time}',
      'recovery.keepChosen': '已选择保留编辑版本',
      'recovery.keepHint': '选择"保留编辑版本"后再次保存将要求二次确认覆盖',
      'recovery.keepNote': '保存将被覆盖：该文件再次保存前需二次确认（保存成功或关闭后自动解除）',
      'recovery.reload': '重新加载',
      'recovery.keepEdited': '保留编辑版本',
      'recovery.saveAs': '另存为…',
      'recovery.close': '关闭',
      'recovery.dismissTitle': '暂时关闭（该文件再次变更时会重现）',
      'recovery.dismissAria': '关闭横幅',
      'recovery.moreConflicts': '…还有 {n} 个文件冲突',
      'recovery.panelAria': '崩溃恢复',
      'recovery.panelTitle': '检测到 {n} 条未保存的编辑内容（上次异常退出前自动保存）',
      'recovery.panelCloseAria': '关闭恢复提示',
      'recovery.panelCloseTitle': '暂不处理（数据保留在恢复区，下次启动会再次提示）',
      'recovery.untitledPath': '（未命中文档路径）',
      'recovery.lastSave': '最后保存 {time}',
      'recovery.unknownTime': '未知时间',
      'recovery.restore': '恢复',
      'recovery.discard': '丢弃',
      'recovery.warnings': '部分恢复条目已损坏跳过：{list}',
      'recovery.discardAll': '全部丢弃',
      'recovery.restoredAria': '恢复的编辑内容',
      'recovery.restoredTitle': '已恢复的编辑内容（只读副本）',
      'recovery.restoredCloseAria': '关闭恢复内容',
      'recovery.copyAll': '复制全部',
      'recovery.copied': '已复制',
      'recovery.copyFailed': '复制失败',
      'recovery.restoredHint': '以 dirty tab 打开恢复内容需后端 recovery.open-as-tab 命令（见契约 §5），当前请复制后自行粘贴',

      // toolbar：titlebar 按钮 / 窗口控制 / tab 导航 / 查找栏按钮 / 面板骨架
      'toolbar.new': '新建 (Ctrl+N)',
      'toolbar.openFolder': '打开文件夹',
      'toolbar.openFile': '打开文件 (Ctrl+O)',
      'toolbar.openFileAria': '打开文件',
      'toolbar.settings': '设置',
      'toolbar.save': '保存 (Ctrl+S)',
      'toolbar.togglePreview': '切换预览 (Ctrl+E)',
      'toolbar.splitView': '分屏 (Ctrl+\\)',
      'toolbar.outline': '大纲 (Ctrl+Shift+O)',
      'toolbar.toggleTheme': '切换主题',
      'toolbar.minimize': '最小化',
      'toolbar.maximize': '最大化',
      'toolbar.close': '关闭',
      'toolbar.scrollTabsLeft': '向左滚动标签页',
      'toolbar.scrollTabsRight': '向右滚动标签页',
      'toolbar.prev': '上一个 (Shift+Enter)',
      'toolbar.next': '下一个 (Enter)',
      'toolbar.closeFind': '关闭 (Escape)',
      'toolbar.resizePanes': '拖动调整分栏宽度',
      'toolbar.collapsePanel': '折叠面板',
      'toolbar.expandPanel': '展开面板',
      'toolbar.resizeWidth': '拖动调整宽度',
      'toolbar.resizeTreeAria': '调整项目树面板宽度',
      'toolbar.resizeOutlineAria': '调整 Outline 面板宽度',
      'toolbar.expandTreeAria': '展开项目树面板',

      // outline：Outline 面板骨架（空态会被 outline.js 运行时覆盖，见报告边界）
      'outline.ariaPanel': '大纲',
      'outline.title': '大纲',
      'outline.empty': '暂无大纲',
      'outline.expandAria': '展开 Outline 面板'
    },
    'en': {
      // app
      'app.saved': 'Saved',
      'app.error': 'Error: {message}',
      'app.word': '{n} word',
      'app.words': '{n} words',
      'app.recentFiles': 'Recent Files',
      'app.noResults': 'No results',
      'app.find': 'Find...',
      'app.unsavedClose': 'You have unsaved changes. Close anyway?',
      'app.noHeadings': 'No headings',
      'app.findProgress': '{n} of {m}',
      'app.editorPlaceholder': 'Start writing markdown...',
      'app.dropToOpen': 'Drop to open',
      'app.cannotOpenLink': 'Cannot open link',
      'app.backToDoc': 'Back to document',
      'app.retry': 'Retry',
      'app.dismissNotice': 'Dismiss notice',

      // welcome
      'welcome.subtitle': 'Lightweight native Markdown workspace editor',
      'welcome.newFile': 'New File',
      'welcome.openFile': 'Open File',
      'welcome.openFolder': 'Open Folder',
      'welcome.noRecent': 'No recent files',
      'welcome.clearRecent': 'Clear',
      'welcome.recentProjects': 'Recent Projects',
      'welcome.recentFiles': 'Recent Files',
      'welcome.noRecentProjects': 'No recent projects. Click Open Folder above to start.',
      'welcome.currentProject': 'Current',

      // tabs
      'tabs.untitled': 'Untitled',
      'tabs.image': 'Image',
      'tabs.closeConfirm': 'Unsaved changes in "{name}". Close anyway?',
      'tabs.closeBatchConfirm': '{n} unsaved tabs. Close all?',
      'tabs.menuClose': 'Close',
      'tabs.menuCloseLeft': 'Close tabs to the left',
      'tabs.menuCloseRight': 'Close tabs to the right',
      'tabs.menuCloseAll': 'Close all tabs',
      'tabs.menuAria': 'Tab actions',

      // tree
      'tree.emptyState': 'No project opened',
      'tree.ariaTree': 'Project tree',
      'tree.menuAria': 'Project tree actions',
      'tree.createFile': 'New File',
      'tree.createFilePlaceholder': 'New file (adds .md when no extension)',
      'tree.createDir': 'New Folder',
      'tree.cut': 'Cut',
      'tree.copy': 'Copy',
      'tree.paste': 'Paste',
      'tree.rename': 'Rename',
      'tree.delete': 'Delete',
      'tree.deletePermanent': 'Delete Permanently',
      'tree.deletePermanentConfirm': 'Permanently delete {n} selected items? This cannot be undone.',
      'tree.openInTerminal': 'Open in Terminal',
      'tree.revealInFileManager': 'Reveal in File Manager',
      'tree.copyAbsolutePath': 'Copy Absolute Path',
      'tree.copyRelativePath': 'Copy Relative Path',
      'tree.revealCurrent': 'Reveal current file',
      'tree.explorer': 'Explorer',

      // settings
      'settings.title': 'Settings',
      'settings.searchPlaceholder': 'Search settings',
      'settings.close': 'Close',
      'settings.openJson': 'Open settings JSON',
      'settings.noMatch': 'No matching settings',
      'settings.projectOverridden': 'Overridden by project',
      'settings.categoryEmpty': 'Nothing to configure in this category',
      'settings.terminal': 'Terminal Program',
      'settings.terminalDesc': 'Program used when opening project or folder in terminal',
      'settings.terminalAuto': 'Auto (detect installed terminals)',
      'settings.terminalScanning': 'Scanning system terminals...',
      'settings.terminalCustom': 'Custom...',
      'settings.terminalCustomPlaceholder': 'Full path to executable',
      'settings.terminalArgs': 'Terminal Arguments',
      'settings.terminalArgsDesc': 'Additional startup arguments; supports {dir} as directory placeholder',
      'settings.terminalArgsPlaceholder': 'e.g. -e /bin/zsh -c "cd {dir}", supports {dir}',
      'settings.cliTitle': 'Glance Command Line Tool',
      'settings.cliDesc': 'Install first, then run gmdu . Windows adds the application bin to your user PATH; reopen the terminal. On macOS/Linux, ensure ~/.local/bin is on PATH.',
      'settings.cliInstall': 'Install gmdu command',
      'settings.cliRemove': 'Remove gmdu command',
      'settings.cliDirectory': 'Install directory',
      'settings.windowCategory': 'Window & Command Line',
      'settings.windowCategoryDesc': 'Window reuse and command-line integration',
      'settings.reuseWindowForFolder': 'Reuse an existing window for CLI folders',
      'settings.reuseWindowForFolderDesc': 'Windows only: off (default) opens a new window; on switches the workspace in the existing window',

      // search
      'search.title': 'Full-Text Search',
      'search.placeholder': 'Search project',
      'search.includeGlob': 'Include globs',
      'search.excludeGlob': 'Exclude globs',
      'search.searching': 'Searching…',
      'search.noResults': 'No matches',
      'search.cancelled': 'Cancelled',
      'search.completed': 'Done: {n} results',
      'search.truncated': ' (truncated)',
      'search.failed': 'Search failed',

      // quickopen
      'quickopen.placeholder': 'Quick open file',
      'quickopen.noMatches': 'No matching files',

      // palette
      'palette.placeholder': 'Type a command',

      // recovery
      'recovery.bannerModifiedTitle': 'File modified externally',
      'recovery.bannerModifiedDesc': ' — your edits are not saved yet',
      'recovery.bannerRemovedTitle': 'File deleted on disk',
      'recovery.bannerRemovedDesc': ' — content is kept in the editor and will not be lost silently',
      'recovery.diskVersion': 'Disk version {time}',
      'recovery.removedAt': 'Deleted at {time}',
      'recovery.keepChosen': 'Keeping edited version',
      'recovery.keepHint': 'After choosing "Keep edited version", saving again will ask for a second confirmation to overwrite',
      'recovery.keepNote': 'Saving will overwrite: a second confirmation is required before this file is saved again (cleared after a successful save or closing the tab)',
      'recovery.reload': 'Reload',
      'recovery.keepEdited': 'Keep edited version',
      'recovery.saveAs': 'Save As…',
      'recovery.close': 'Close',
      'recovery.dismissTitle': 'Dismiss for now (reappears when this file changes again)',
      'recovery.dismissAria': 'Close banner',
      'recovery.moreConflicts': '…and {n} more file conflicts',
      'recovery.panelAria': 'Crash recovery',
      'recovery.panelTitle': 'Found {n} unsaved edits (auto-saved before the last abnormal exit)',
      'recovery.panelCloseAria': 'Close recovery notice',
      'recovery.panelCloseTitle': 'Decide later (data stays in the recovery area; you will be asked again next launch)',
      'recovery.untitledPath': '(unknown document path)',
      'recovery.lastSave': 'Last saved {time}',
      'recovery.unknownTime': 'Unknown time',
      'recovery.restore': 'Restore',
      'recovery.discard': 'Discard',
      'recovery.warnings': 'Some corrupted recovery entries skipped: {list}',
      'recovery.discardAll': 'Discard all',
      'recovery.restoredAria': 'Restored edits',
      'recovery.restoredTitle': 'Restored edits (read-only copy)',
      'recovery.restoredCloseAria': 'Close restored content',
      'recovery.copyAll': 'Copy all',
      'recovery.copied': 'Copied',
      'recovery.copyFailed': 'Copy failed',
      'recovery.restoredHint': 'Opening restored content as a dirty tab needs the recovery.open-as-tab command (see contract §5); for now, copy and paste it yourself',

      // toolbar
      'toolbar.new': 'New (Ctrl+N)',
      'toolbar.openFolder': 'Open Folder',
      'toolbar.openFile': 'Open File (Ctrl+O)',
      'toolbar.openFileAria': 'Open File',
      'toolbar.settings': 'Settings',
      'toolbar.save': 'Save (Ctrl+S)',
      'toolbar.togglePreview': 'Toggle Preview (Ctrl+E)',
      'toolbar.splitView': 'Split View (Ctrl+\\)',
      'toolbar.outline': 'Outline (Ctrl+Shift+O)',
      'toolbar.toggleTheme': 'Toggle Theme',
      'toolbar.minimize': 'Minimize',
      'toolbar.maximize': 'Maximize',
      'toolbar.close': 'Close',
      'toolbar.scrollTabsLeft': 'Scroll tabs left',
      'toolbar.scrollTabsRight': 'Scroll tabs right',
      'toolbar.prev': 'Previous (Shift+Enter)',
      'toolbar.next': 'Next (Enter)',
      'toolbar.closeFind': 'Close (Escape)',
      'toolbar.resizePanes': 'Drag to resize panes',
      'toolbar.collapsePanel': 'Collapse panel',
      'toolbar.expandPanel': 'Expand panel',
      'toolbar.resizeWidth': 'Drag to resize',
      'toolbar.resizeTreeAria': 'Resize project tree panel',
      'toolbar.resizeOutlineAria': 'Resize outline panel',
      'toolbar.expandTreeAria': 'Expand project tree panel',

      // outline
      'outline.ariaPanel': 'Outline',
      'outline.title': 'Outline',
      'outline.empty': 'No outline',
      'outline.expandAria': 'Expand outline panel'
    }
  };

  var currentLanguage = DEFAULT_LANGUAGE;

  /* ── 工具 ── */

  function hasOwn(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key);
  }

  // 占位符替换：{name} → params.name；未提供的占位符原样保留
  function interpolate(text, params) {
    if (!params || typeof params !== 'object') return text;
    return String(text).replace(/\{(\w+)\}/g, function(whole, name) {
      return hasOwn(params, name) ? String(params[name]) : whole;
    });
  }

  /* ── 取词 ── */

  // t(key, params?)：活动语言缺键回退 zh-CN，再缺返回 key 本身
  function t(key, params) {
    var dict = LOCALES[currentLanguage] || LOCALES[DEFAULT_LANGUAGE];
    var fallbackDict = LOCALES[DEFAULT_LANGUAGE];
    var raw = hasOwn(dict, key) ? dict[key]
      : (hasOwn(fallbackDict, key) ? fallbackDict[key] : key);
    return interpolate(raw, params);
  }

  /* ── 语言切换与持久化 ── */

  function setDocumentLang() {
    try {
      var docEl = document.documentElement;
      if (docEl && typeof docEl.setAttribute === 'function') {
        docEl.setAttribute('lang', currentLanguage);
      }
    } catch (e) { /* 无 document 环境（vm 测试）忽略 */ }
  }

  function dispatchChanged() {
    var detail = { language: currentLanguage };
    try {
      if (typeof window.CustomEvent === 'function') {
        window.dispatchEvent(new window.CustomEvent(CHANGED_EVENT, { detail: detail }));
        return;
      }
    } catch (e) { /* 降级为普通对象事件 */ }
    if (typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent({ type: CHANGED_EVENT, detail: detail });
      } catch (e) { /* 分发失败不影响语言状态 */ }
    }
  }

  // setLanguage(lang)：写 localStorage + 更新活动语言 + <html lang> + 派发 i18n-changed。
  // 未支持的语言 no-op 返回 false；与当前语言相同则不重复派发。
  function setLanguage(lang) {
    var next = String(lang == null ? '' : lang);
    if (!hasOwn(LOCALES, next)) return false;
    if (next === currentLanguage) return true;
    currentLanguage = next;
    try { window.localStorage.setItem(LOCALE_KEY, currentLanguage); } catch (e) {}
    setDocumentLang();
    dispatchChanged();
    return true;
  }

  function getLanguage() {
    return currentLanguage;
  }

  /* ── 静态 chrome 应用（data-i18n 属性驱动） ── */

  // macOS 平台 title 中的 'Ctrl+' 替换为 '⌘'（与 app.js DOMContentLoaded 惯例一致；
  // i18n.js 在 app.js 之前执行，此处先替换，app.js 的二次替换不受影响）
  function platformTitle(text) {
    try {
      var platform = document.body && document.body.dataset ? document.body.dataset.platform : null;
      if (platform === 'macos') {
        return String(text).split('Ctrl+').join('\u2318');
      }
    } catch (e) { /* 平台标记缺失时原样返回 */ }
    return text;
  }

  function applyDom(root) {
    var scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    var nodes = scope.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-aria],[data-i18n-placeholder]');
    Array.prototype.forEach.call(nodes, function(el) {
      if (!el || typeof el.getAttribute !== 'function') return;
      var key;
      if ((key = el.getAttribute('data-i18n-title'))) {
        el.setAttribute('title', platformTitle(t(key)));
      }
      if ((key = el.getAttribute('data-i18n-aria'))) {
        el.setAttribute('aria-label', t(key));
      }
      if ((key = el.getAttribute('data-i18n-placeholder'))) {
        el.setAttribute('placeholder', t(key));
      }
      if ((key = el.getAttribute('data-i18n'))) {
        el.textContent = t(key);
      }
    });
  }

  /* ── 初始化：读 localStorage 语言、设置 <html lang>、应用静态 chrome ── */

  function init() {
    var saved = null;
    try { saved = window.localStorage.getItem(LOCALE_KEY); } catch (e) {}
    if (saved && hasOwn(LOCALES, saved)) {
      currentLanguage = saved;
    }
    setDocumentLang();
    applyDom();
  }

  window.I18n = {
    t: t,
    setLanguage: setLanguage,
    getLanguage: getLanguage,
    init: init,
    applyDom: applyDom,
    LOCALES: LOCALES,
    DEFAULT_LANGUAGE: DEFAULT_LANGUAGE,
    LOCALE_KEY: LOCALE_KEY,
    CHANGED_EVENT: CHANGED_EVENT
  };

  init();
})();
