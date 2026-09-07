# 设置、快捷键与命令面板契约

## 设置
`SettingsUI` 打开时请求 `workspace.settings.get-effective`、`get-global`、`load-project`；编辑后发送 `workspace.settings.set-global`，数据放 `data` JSON 字符串；主题同步 `data-theme` 与 `glancemd-ultra-theme`。界面固定七类：appearance、files、watching、search、editor、keybindings、recovery。

## 快捷键
`Keybindings` 默认表：Ctrl+O=file.open、Ctrl+P=quickopen.toggle、Ctrl+Shift+F=search.toggle、Ctrl+Shift+P=palette.toggle、Ctrl+`=settings.toggle。自定义覆盖持久化在 `glancemd-ultra-keybindings`；重复组合键阻止保存。

## 命令面板
`CommandPalette` 通过 Ctrl+Shift+P 打开，枚举 `window.Commands.ids()`，子序列过滤，最近执行记录保存到 `glancemd-ultra-palette-recent`，最多 5 条。

所有模块均为 IIFE，使用 `window.*` 命名空间与 `window.ipc`，不引入运行时依赖；不可用 DOM API 时应安全降级，不阻断既有编辑器。
