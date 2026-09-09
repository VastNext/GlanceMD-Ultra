# GlanceMD Ultra 未提交代码拆分提交方案 (Conventional Commits)

- 日期：2026-09-09
- 状态：已成功执行
- 分支：`feat/keyboard-schemes-vim`

---

## 1. 提交执行总览

通过“基础设施与新脚本静态骨架先行就位”的设计，彻底消除了 Rust `include_str!` 编译期找不到文件的断层隐患，保证每一个提交节点 `cargo build`、`cargo test` 与前端测试全部 100% 绿色通过。

1. **Commit 1 (`4ae75f1`)**: `chore(infra): 注册新增前端模块并更新编译与组装加载链`
   - 新增 caret.js、editor-commands.js、overlay-helper.js、quick-outline.js、preview-navigation.js、confirm-dialog.js
   - 同步 main.rs、build_test_page.py、smoke.test.js，过滤 Windows 最小化 0 尺寸
2. **Commit 2 (`fe0c0ab`)**: `feat(editor): 增强编辑区内核、Vim 模式交互与布局尺寸保护`
   - 接入 3px 自定义光标、折行切换平滑居中、Vim 方块光标与底栏提示、layout.js 最小化恢复展开
3. **Commit 3 (`a320523`)**: `feat(ui): 升级浮层面板体验、快速大纲与自研居中确认弹窗`
   - 升级 Quick Open、Command Palette、Search Panel、tabs.js 接入异步居中 ConfirmDialog
4. **Commit 4 (`5ccf9aa`)**: `feat(keybindings): 完善双键位方案、顶栏 Tooltip 动态联动与搜索定位`
   - 映射 Ctrl+Alt+O (文件)、Ctrl+Alt+P (文件夹)、Ctrl+Shift+V (预览)、Ctrl+\ (分屏)
   - 顶栏与欢迎页快捷键 Tooltip 响应式动态联动
   - Preview 搜索全局字符锚点比对与正下方紫粉居中气泡
5. **Commit 5**: `test(e2e): 建立全量端到端回归测试套件并归档 QA 验证矩阵`
   - 建立覆盖 92 项关键交互的 Playwright 端到端回归测试集与双主题验收截图
