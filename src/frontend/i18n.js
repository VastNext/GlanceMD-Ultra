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
      'app.unsavedCloseTitle': '未保存的修改',
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

      // settings：设置页通用词、分类、各设置项与枚举
      'settings.title': '设置',
      'settings.searchPlaceholder': '搜索设置',
      'settings.close': '关闭',
      'settings.openJson': '打开设置JSON',
      'settings.openJsonTitle': '在内置编辑器中直接查看与编辑 JSON 配置文件',
      'settings.resetCategory': '重置当前分类为默认',
      'settings.done': '完成',
      'settings.projectOverriddenBanner': '此分类下有设置项已被当前项目配置 (.glancemd/settings.json) 覆盖',
      'settings.searchHeading': '搜索：“{q}”',
      'settings.noMatch': '没有匹配的设置',
      'settings.projectOverridden': '项目已覆盖',
      'settings.categoryEmpty': '该分类暂无可配置项',
      'settings.currentValue': '（当前值）',
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
      'settings.httpCategory': '网络',
      'settings.httpCategoryDesc': 'HTTP/HTTPS/SOCKS5 代理与连接测试',
      'settings.proxySupport': '代理模式',
      'settings.proxySupportDesc': '跟随系统代理、显式指定代理，或直连禁用',
      'settings.proxyUrl': '代理服务器',
      'settings.proxyUrlDesc': '支持 http://、https://、socks5:// 地址，如 http://127.0.0.1:7890',
      'settings.proxyStrictSSL': '严格校验 SSL 证书',
      'settings.proxyStrictSSLDesc': '关闭后跳过证书校验（仅用于自签证书/中间人代理等特殊场景）',
      'settings.proxyTest': '测试连接',
      'settings.proxyTesting': '测试中…',
      'settings.proxyTestEmpty': '请先填写代理地址',
      'settings.proxyTestTimeout': '连接超时，未收到探测响应',
      'settings.proxyDisabledHint': '将代理模式设为“使用下方指定代理”后可用',
      'settings.proxyRestartHint': '代理设置需重启应用后生效。',

      // settings 分类名与描述
      'settings.cat.appearance': '外观',
      'settings.cat.appearanceDesc': '主题与界面配色',
      'settings.cat.files': '文件',
      'settings.cat.filesDesc': '可见类型、隐藏文件与排除规则',
      'settings.cat.watching': '监听',
      'settings.cat.watchingDesc': '文件监听与自动保存行为',
      'settings.cat.search': '搜索',
      'settings.cat.searchDesc': '搜索范围与结果数量上限',
      'settings.cat.editor': '编辑器',
      'settings.cat.editorDesc': '字号、缩进、换行与大文件阈值',
      'settings.cat.window': '窗口与命令行',
      'settings.cat.windowDesc': '窗口多开复用与命令行工具集成',
      'settings.cat.http': '网络',
      'settings.cat.httpDesc': 'HTTP/HTTPS/SOCKS5 代理与连接测试',
      'settings.cat.keybindings': '快捷键',
      'settings.cat.keybindingsDesc': '查看并修改命令快捷键',
      'settings.cat.recovery': '恢复',
      'settings.cat.recoveryDesc': '未保存确认与崩溃恢复',

      // settings 各字段 label & desc
      'settings.meta.appearance.theme': '主题',
      'settings.meta.appearance.themeDesc': '界面配色：深色、浅色或跟随系统',
      'settings.meta.appearance.language': '界面语言',
      'settings.meta.appearance.languageDesc': '界面文案语言；切换后立即生效',
      'settings.meta.appearance.sidebarFontSize': '侧栏字体大小（px）',
      'settings.meta.appearance.sidebarFontSizeDesc': '资源管理器与大纲面板的基准字号（12–18）',
      'settings.meta.appearance.outlineSide': 'Outline 显示位置',
      'settings.meta.appearance.outlineSideDesc': '大纲浮层显示在编辑区右侧或左侧，修改后立即生效',
      'settings.meta.files.visibleExts': '可见扩展名',
      'settings.meta.files.visibleExtsDesc': '项目树中显示的文件类型，逗号分隔',
      'settings.meta.files.showHidden': '显示隐藏文件',
      'settings.meta.files.showHiddenDesc': '在项目树中显示点开头的隐藏文件',
      'settings.meta.files.exclude': '浏览排除',
      'settings.meta.files.excludeDesc': '项目树不展示的目录或路径段，逗号分隔',
      'settings.meta.files.watcherExclude': '监听排除',
      'settings.meta.files.watcherExcludeDesc': '文件监听忽略的目录或路径段，逗号分隔',
      'settings.meta.files.terminalPath': '终端程序',
      'settings.meta.files.terminalPathDesc': '在终端中打开项目或目录时调用的程序',
      'settings.meta.files.terminalArgs': '终端参数',
      'settings.meta.files.terminalArgsDesc': '附加启动参数，支持 {dir} 作为目标目录占位符',
      'settings.meta.watching.enableWatcher': '启用文件监听',
      'settings.meta.watching.enableWatcherDesc': '监听文件变更；修改此设置后自动暂停或恢复监听',
      'settings.meta.watching.autoSave': '自动保存',
      'settings.meta.watching.autoSaveDesc': '关闭、延时后自动保存，或失去焦点时保存',
      'settings.meta.watching.autoSaveDelayMs': '自动保存延时（毫秒）',
      'settings.meta.watching.autoSaveDelayMsDesc': '“延时后自动保存”模式的触发延时',
      'settings.meta.search.exclude': '搜索排除',
      'settings.meta.search.excludeDesc': '全文搜索跳过的目录或 glob，逗号分隔',
      'settings.meta.search.maxFileSizeMB': '文件大小上限（MB）',
      'settings.meta.search.maxFileSizeMBDesc': '超过该大小的文件不参与搜索',
      'settings.meta.search.maxResults': '结果数上限',
      'settings.meta.search.maxResultsDesc': '单次搜索最多返回的结果数',
      'settings.meta.editor.fontSize': '字号（px）',
      'settings.meta.editor.fontSizeDesc': '编辑区字体大小',
      'settings.meta.editor.tabSize': 'Tab 宽度',
      'settings.meta.editor.tabSizeDesc': '一个 Tab 对应的空格数',
      'settings.meta.editor.wordWrap': '自动换行',
      'settings.meta.editor.wordWrapDesc': '超出编辑区宽度时自动折行',
      'settings.meta.editor.lineNumbers': '显示行号',
      'settings.meta.editor.lineNumbersDesc': '编辑区左侧显示行号',
      'settings.meta.editor.largeFileMB': '大文件阈值（MB）',
      'settings.meta.editor.largeFileMBDesc': '超过该大小进入大文件模式',
      'settings.meta.recovery.confirmCloseDirty': '关闭未保存确认',
      'settings.meta.recovery.confirmCloseDirtyDesc': '关闭有未保存修改的标签时弹出确认',
      'settings.meta.recovery.crashRecovery': '崩溃恢复',
      'settings.meta.recovery.crashRecoveryDesc': '定期把编辑内容写入恢复区',
      'settings.meta.recovery.createProjectSettings': '自动创建项目设置',
      'settings.meta.recovery.createProjectSettingsDesc': '打开工作区时自动创建 .glancemd/settings.json',

      // settings 枚举项翻译
      'settings.enum.theme.dark': '深色',
      'settings.enum.theme.light': '浅色',
      'settings.enum.theme.system': '跟随系统',
      'settings.enum.outlineSide.right': '右侧',
      'settings.enum.outlineSide.left': '左侧',
      'settings.enum.autoSave.off': '关闭',
      'settings.enum.autoSave.afterDelay': '延时后保存',
      'settings.enum.autoSave.onFocusLost': '失焦时保存',
      'settings.enum.proxySupport.off': '直连（禁用代理）',
      'settings.enum.proxySupport.system': '跟随系统代理',
      'settings.enum.proxySupport.override': '使用下方指定代理',

      // quickoutline：快速大纲
      'quickoutline.title': '大纲',
      'quickoutline.badgeCount': '{n} 个标题',
      'quickoutline.placeholder': '按标题快速过滤 (↑↓ 导航, Enter 跳转)...',
      'quickoutline.hintNav': '导航',
      'quickoutline.hintJump': '跳转',
      'quickoutline.hintClose': '关闭',
      'quickoutline.closeAria': '关闭',
      'quickoutline.emptyDoc': '当前文档无标题',
      'quickoutline.noMatches': '无匹配标题',
      'quickoutline.line': '行 {n}',

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
      'search.closeHint': '关闭 (Escape)',
      'search.resizeHandle': '拖动调整搜索面板大小',

      // commands：命令集中翻译表（keybindings-settings 显示与搜索共用）。
      // 覆盖 default-keybindings.js 全量键位命令；未收录的命令回退注册 label 或命令 ID。
      'command.file.new': '新建文件',
      'command.file.open': '打开文件…',
      'command.file.save': '保存',
      'command.file.saveAll': '全部保存',
      'command.file.saveAs': '另存为…',
      'command.file.close': '关闭标签页',
      'command.workspace.open': '打开项目文件夹…',
      'command.settings.toggle': '设置',
      'command.settings.keybindings': '快捷键设置',
      'command.editor.vim.toggle': '切换 Vim 模式',
      'command.editor.focus': '聚焦编辑器',
      'command.palette.toggle': '命令面板',
      'command.keyassist.toggle': '快捷键速查',
      'command.search.toggle': '全文搜索',
      'command.tabs.quickSwitch': '快速切换标签页',
      'command.resource.open': '快速打开文件',
      'command.tabs.next': '下一个标签页',
      'command.tabs.previous': '上一个标签页',
      'command.focus.next': '下一个焦点区域',
      'command.focus.previous': '上一个焦点区域',
      'command.outline.toggle': '切换大纲',
      'command.outline.focus': '聚焦大纲',
      'command.quickopen.toggle': '快速打开',
      'commandDesc.file.new': '创建新的 Markdown 文件',
      'commandDesc.file.open': '打开单个文件或从对话框选择',
      'commandDesc.file.save': '保存当前标签页',
      'commandDesc.file.saveAll': '保存所有未保存的标签页',
      'commandDesc.file.saveAs': '将当前文档另存为新文件',
      'commandDesc.file.close': '关闭当前标签页',
      'commandDesc.workspace.open': '选择并打开一个项目目录',
      'commandDesc.settings.toggle': '打开或关闭设置面板',
      'commandDesc.settings.keybindings': '打开快捷键设置页',
      'commandDesc.editor.vim.toggle': '启用或禁用 Vim 模态编辑',
      'commandDesc.editor.focus': '将焦点移动到编辑器',
      'commandDesc.palette.toggle': '打开或关闭命令面板',
      'commandDesc.keyassist.toggle': '打开或关闭快捷键速查面板',
      'commandDesc.search.toggle': '打开或关闭项目全文搜索',
      'commandDesc.tabs.quickSwitch': '在已打开的标签页间快速切换',
      'commandDesc.resource.open': '按文件名快速打开项目内文件',
      'commandDesc.tabs.next': '切换到后一个标签页',
      'commandDesc.tabs.previous': '切换到前一个标签页',
      'commandDesc.focus.next': '按顺序聚焦下一个工作区区域',
      'commandDesc.focus.previous': '按顺序聚焦上一个工作区区域',
      'commandDesc.outline.toggle': '显示或隐藏大纲面板',
      'commandDesc.outline.focus': '显示大纲面板并将焦点移入',
      'commandDesc.quickopen.toggle': '按路径快速打开项目内文件',

      // kbScheme：键位方案显示名称（keybindings-settings 方案下拉）
      'kbScheme.ultra.eclipse': 'Ultra Eclipse 键位',
      'kbScheme.ultra.vscode': 'VS Code 键位',

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
      'toolbar.new': '新建',
      'toolbar.openFolder': '打开文件夹',
      'toolbar.openFile': '打开文件',
      'toolbar.openFileAria': '打开文件',
      'toolbar.settings': '设置',
      'toolbar.save': '保存',
      'toolbar.togglePreview': '切换预览',
      'toolbar.modeEdit': '编辑模式 (Ctrl+Shift+V)',
      'toolbar.modePreview': '预览模式 (Ctrl+Shift+V)',
      'toolbar.splitView': '分屏',
      'toolbar.wordWrapOn': '自动换行：已开启 (Alt+Shift+Y)',
      'toolbar.wordWrapOff': '自动换行：已关闭 (Alt+Shift+Y)',
      'toolbar.outline': '大纲',
      'toast.wordWrapOn': '自动换行已开启',
      'toast.wordWrapOff': '自动换行已关闭',
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
      'app.unsavedCloseTitle': 'Unsaved Changes',
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
      'settings.openJsonTitle': 'View and edit JSON configuration file directly in built-in editor',
      'settings.resetCategory': 'Reset current category to defaults',
      'settings.done': 'Done',
      'settings.projectOverriddenBanner': 'Some settings in this category are overridden by current project (.glancemd/settings.json)',
      'settings.searchHeading': 'Search: "{q}"',
      'settings.noMatch': 'No matching settings',
      'settings.projectOverridden': 'Overridden by project',
      'settings.categoryEmpty': 'Nothing to configure in this category',
      'settings.currentValue': ' (current)',
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
      'settings.httpCategory': 'Network',
      'settings.httpCategoryDesc': 'HTTP/HTTPS/SOCKS5 proxy and connectivity test',
      'settings.proxySupport': 'Proxy mode',
      'settings.proxySupportDesc': 'Follow system proxy, use a custom proxy, or connect directly',
      'settings.proxyUrl': 'Proxy server',
      'settings.proxyUrlDesc': 'Supports http://, https://, socks5:// addresses, e.g. http://127.0.0.1:7890',
      'settings.proxyStrictSSL': 'Strict SSL certificate verification',
      'settings.proxyStrictSSLDesc': 'Turn off to skip certificate checks (only for self-signed certs / MITM proxies)',
      'settings.proxyTest': 'Test connection',
      'settings.proxyTesting': 'Testing…',
      'settings.proxyTestEmpty': 'Enter a proxy address first',
      'settings.proxyTestTimeout': 'Connection timed out, no response received',
      'settings.proxyDisabledHint': 'Select "Use the proxy below" to enable',
      'settings.proxyRestartHint': 'Proxy settings take effect after restarting the app.',

      // settings categories
      'settings.cat.appearance': 'Appearance',
      'settings.cat.appearanceDesc': 'Theme and UI color schemes',
      'settings.cat.files': 'Files',
      'settings.cat.filesDesc': 'Visible extensions, hidden files and excludes',
      'settings.cat.watching': 'Watcher',
      'settings.cat.watchingDesc': 'File watching and auto save behaviors',
      'settings.cat.search': 'Search',
      'settings.cat.searchDesc': 'Search scope and maximum result limits',
      'settings.cat.editor': 'Editor',
      'settings.cat.editorDesc': 'Font size, indent, wrap and large file thresholds',
      'settings.cat.window': 'Window & CLI',
      'settings.cat.windowDesc': 'Window reuse and command-line integration',
      'settings.cat.http': 'Network',
      'settings.cat.httpDesc': 'HTTP/HTTPS/SOCKS5 proxy and connectivity test',
      'settings.cat.keybindings': 'Shortcuts',
      'settings.cat.keybindingsDesc': 'View and customize keyboard shortcuts',
      'settings.cat.recovery': 'Recovery',
      'settings.cat.recoveryDesc': 'Unsaved confirmations and crash recovery',

      // settings meta
      'settings.meta.appearance.theme': 'Theme',
      'settings.meta.appearance.themeDesc': 'Color scheme: Dark, Light or follow system',
      'settings.meta.appearance.language': 'Language',
      'settings.meta.appearance.languageDesc': 'UI language; takes effect immediately',
      'settings.meta.appearance.sidebarFontSize': 'Sidebar Font Size (px)',
      'settings.meta.appearance.sidebarFontSizeDesc': 'Base font size for explorer and outline (12–18)',
      'settings.meta.appearance.outlineSide': 'Outline Position',
      'settings.meta.appearance.outlineSideDesc': 'Show outline panel on the right or left of editor',
      'settings.meta.files.visibleExts': 'Visible Extensions',
      'settings.meta.files.visibleExtsDesc': 'File extensions shown in project tree, comma-separated',
      'settings.meta.files.showHidden': 'Show Hidden Files',
      'settings.meta.files.showHiddenDesc': 'Show dotfiles in project tree',
      'settings.meta.files.exclude': 'Explorer Exclude',
      'settings.meta.files.excludeDesc': 'Directories or patterns excluded from project tree, comma-separated',
      'settings.meta.files.watcherExclude': 'Watcher Exclude',
      'settings.meta.files.watcherExcludeDesc': 'Directories or patterns ignored by file watcher, comma-separated',
      'settings.meta.files.terminalPath': 'Terminal Program',
      'settings.meta.files.terminalPathDesc': 'Program used when opening project or folder in terminal',
      'settings.meta.files.terminalArgs': 'Terminal Arguments',
      'settings.meta.files.terminalArgsDesc': 'Additional startup arguments; supports {dir} as directory placeholder',
      'settings.meta.watching.enableWatcher': 'Enable File Watcher',
      'settings.meta.watching.enableWatcherDesc': 'Watch for file changes; automatically pauses/resumes on change',
      'settings.meta.watching.autoSave': 'Auto Save',
      'settings.meta.watching.autoSaveDesc': 'Off, after delay, or on focus lost',
      'settings.meta.watching.autoSaveDelayMs': 'Auto Save Delay (ms)',
      'settings.meta.watching.autoSaveDelayMsDesc': 'Delay before auto save triggers in "After Delay" mode',
      'settings.meta.search.exclude': 'Search Exclude',
      'settings.meta.search.excludeDesc': 'Directories or globs skipped during full-text search, comma-separated',
      'settings.meta.search.maxFileSizeMB': 'Max File Size (MB)',
      'settings.meta.search.maxFileSizeMBDesc': 'Files larger than this limit are skipped during search',
      'settings.meta.search.maxResults': 'Max Results Limit',
      'settings.meta.search.maxResultsDesc': 'Maximum number of results returned per search',
      'settings.meta.editor.fontSize': 'Font Size (px)',
      'settings.meta.editor.fontSizeDesc': 'Font size of editor area',
      'settings.meta.editor.tabSize': 'Tab Size',
      'settings.meta.editor.tabSizeDesc': 'Number of spaces per Tab',
      'settings.meta.editor.wordWrap': 'Word Wrap',
      'settings.meta.editor.wordWrapDesc': 'Wrap long lines when exceeding editor width',
      'settings.meta.editor.lineNumbers': 'Show Line Numbers',
      'settings.meta.editor.lineNumbersDesc': 'Show line numbers on the left of editor',
      'settings.meta.editor.largeFileMB': 'Large File Threshold (MB)',
      'settings.meta.editor.largeFileMBDesc': 'Files exceeding this size enter large-file mode',
      'settings.meta.recovery.confirmCloseDirty': 'Confirm Close Unsaved',
      'settings.meta.recovery.confirmCloseDirtyDesc': 'Prompt confirmation when closing unsaved tabs',
      'settings.meta.recovery.crashRecovery': 'Crash Recovery',
      'settings.meta.recovery.crashRecoveryDesc': 'Periodically save active edits to recovery area',
      'settings.meta.recovery.createProjectSettings': 'Auto Create Project Settings',
      'settings.meta.recovery.createProjectSettingsDesc': 'Automatically create .glancemd/settings.json when opening workspace',

      // settings enums
      'settings.enum.theme.dark': 'Dark',
      'settings.enum.theme.light': 'Light',
      'settings.enum.theme.system': 'System',
      'settings.enum.outlineSide.right': 'Right',
      'settings.enum.outlineSide.left': 'Left',
      'settings.enum.autoSave.off': 'Off',
      'settings.enum.autoSave.afterDelay': 'After Delay',
      'settings.enum.autoSave.onFocusLost': 'On Focus Lost',
      'settings.enum.proxySupport.off': 'Direct (Disable Proxy)',
      'settings.enum.proxySupport.system': 'System Proxy',
      'settings.enum.proxySupport.override': 'Use Specified Proxy Below',

      // quickoutline
      'quickoutline.title': 'Outline',
      'quickoutline.badgeCount': '{n} headings',
      'quickoutline.placeholder': 'Filter headings (↑↓ to navigate, Enter to jump)...',
      'quickoutline.hintNav': 'navigate',
      'quickoutline.hintJump': 'jump',
      'quickoutline.hintClose': 'close',
      'quickoutline.closeAria': 'Close',
      'quickoutline.emptyDoc': 'No headings in current document',
      'quickoutline.noMatches': 'No matching headings',
      'quickoutline.line': 'Line {n}',

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
      'search.closeHint': 'Close (Escape)',
      'search.resizeHandle': 'Drag to resize search panel',

      // commands：命令集中翻译表（与 zh-CN 的 command.* / commandDesc.* / kbScheme.* 一一对应）
      'command.file.new': 'New File',
      'command.file.open': 'Open File…',
      'command.file.save': 'Save',
      'command.file.saveAll': 'Save All',
      'command.file.saveAs': 'Save As…',
      'command.file.close': 'Close Tab',
      'command.workspace.open': 'Open Project Folder…',
      'command.settings.toggle': 'Settings',
      'command.settings.keybindings': 'Keyboard Shortcuts',
      'command.editor.vim.toggle': 'Toggle Vim Mode',
      'command.editor.focus': 'Focus Editor',
      'command.palette.toggle': 'Command Palette',
      'command.keyassist.toggle': 'Key Assist',
      'command.search.toggle': 'Full-Text Search',
      'command.tabs.quickSwitch': 'Quick Switch Tabs',
      'command.resource.open': 'Quick Open File',
      'command.tabs.next': 'Next Tab',
      'command.tabs.previous': 'Previous Tab',
      'command.focus.next': 'Next Focus Area',
      'command.focus.previous': 'Previous Focus Area',
      'command.outline.toggle': 'Toggle Outline',
      'command.outline.focus': 'Focus Outline',
      'command.quickopen.toggle': 'Quick Open',
      'commandDesc.file.new': 'Create a new Markdown file',
      'commandDesc.file.open': 'Open a single file or pick one via dialog',
      'commandDesc.file.save': 'Save the active tab',
      'commandDesc.file.saveAll': 'Save all unsaved tabs',
      'commandDesc.file.saveAs': 'Save the current document as a new file',
      'commandDesc.file.close': 'Close the active tab',
      'commandDesc.workspace.open': 'Choose and open a project directory',
      'commandDesc.settings.toggle': 'Toggle the settings panel',
      'commandDesc.settings.keybindings': 'Open keyboard shortcuts settings',
      'commandDesc.editor.vim.toggle': 'Enable or disable Vim modal editing',
      'commandDesc.editor.focus': 'Move focus to the editor',
      'commandDesc.palette.toggle': 'Toggle the command palette',
      'commandDesc.keyassist.toggle': 'Toggle the key assist panel',
      'commandDesc.search.toggle': 'Toggle project full-text search',
      'commandDesc.tabs.quickSwitch': 'Quickly switch between open tabs',
      'commandDesc.resource.open': 'Quickly open a project file by name',
      'commandDesc.tabs.next': 'Switch to the next tab',
      'commandDesc.tabs.previous': 'Switch to the previous tab',
      'commandDesc.focus.next': 'Focus the next workspace area in order',
      'commandDesc.focus.previous': 'Focus the previous workspace area in order',
      'commandDesc.outline.toggle': 'Show or hide the outline panel',
      'commandDesc.outline.focus': 'Show the outline panel and focus it',
      'commandDesc.quickopen.toggle': 'Quickly open project files by path',

      // kbScheme
      'kbScheme.ultra.eclipse': 'Ultra Eclipse keymap',
      'kbScheme.ultra.vscode': 'VS Code keymap',

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
      'toolbar.new': 'New',
      'toolbar.openFolder': 'Open Folder',
      'toolbar.openFile': 'Open File',
      'toolbar.openFileAria': 'Open File',
      'toolbar.settings': 'Settings',
      'toolbar.save': 'Save',
      'toolbar.togglePreview': 'Toggle Preview',
      'toolbar.modeEdit': 'Edit Mode (Ctrl+Shift+V)',
      'toolbar.modePreview': 'Preview Mode (Ctrl+Shift+V)',
      'toolbar.splitView': 'Split View',
      'toolbar.wordWrapOn': 'Word Wrap: On (Alt+Shift+Y)',
      'toolbar.wordWrapOff': 'Word Wrap: Off (Alt+Shift+Y)',
      'toolbar.outline': 'Outline',
      'toast.wordWrapOn': 'Word wrap enabled',
      'toast.wordWrapOff': 'Word wrap disabled',
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

  /* ── 命令集中翻译（keybindings-settings 显示与搜索共用） ──
   * 以 zh-CN 字典收录与否判定命令是否入表；入表命令按活动语言取词，
   * 未收录命令回退调用方传入的注册 label（通常已内联中文）或命令 ID 本身。 */
  function commandLabel(id, fallbackLabel) {
    var key = 'command.' + String(id == null ? '' : id);
    if (hasOwn(LOCALES[DEFAULT_LANGUAGE], key)) return t(key);
    if (fallbackLabel != null && fallbackLabel !== '') return String(fallbackLabel);
    return String(id == null ? '' : id);
  }

  function commandDescription(id, fallbackDescription) {
    var key = 'commandDesc.' + String(id == null ? '' : id);
    if (hasOwn(LOCALES[DEFAULT_LANGUAGE], key)) return t(key);
    return fallbackDescription != null ? String(fallbackDescription) : '';
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

  // setLanguage(lang)：写 localStorage + 更新活动语言 + <html lang> + applyDom + 派发 i18n-changed。
  // 未支持的语言 no-op 返回 false；与当前语言相同则不重复派发。
  function setLanguage(lang) {
    var next = String(lang == null ? '' : lang);
    if (!hasOwn(LOCALES, next)) return false;
    if (next === currentLanguage) return true;
    currentLanguage = next;
    try { window.localStorage.setItem(LOCALE_KEY, currentLanguage); } catch (e) {}
    setDocumentLang();
    applyDom();
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
    commandLabel: commandLabel,
    commandDescription: commandDescription,
    LOCALES: LOCALES,
    DEFAULT_LANGUAGE: DEFAULT_LANGUAGE,
    LOCALE_KEY: LOCALE_KEY,
    CHANGED_EVENT: CHANGED_EVENT
  };

  init();
})();
