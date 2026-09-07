/* 测试专用 IPC mock 引导脚本。
 *
 * 由 tools/build_test_page.py 注入到组装页第一个 <script>（先于全部产品脚本执行），
 * 同时复制为 tests/.tmp/mock-ipc.js 供 Playwright page.addInitScript() 在
 * 真实浏览器导航前注册同样的 mock。
 *
 * 契约：
 * - JS -> Rust：产品代码调用 window.ipc.postMessage(JSON 字符串)；此处把每条
 *   消息记录进 window.__ipcLog（字符串数组），并转发给可替换的
 *   window.__ipcResponder(msg) 钩子（测试可随时挂载/替换）。
 * - Rust -> JS：默认 window.__fromRust 为 no-op 收集器，记录进
 *   window.__fromRustLog。注意：app.js 加载后会把 window.__fromRust 覆盖为
 *   真实事件处理器——测试中模拟 Rust 事件时，直接调用
 *   window.__fromRust(event, data) 即可驱动产品逻辑（与真实 evaluate_script 一致）。
 */
window.ipc = {
  postMessage: function (msg) {
    (window.__ipcLog = window.__ipcLog || []).push(msg);
    if (window.__ipcResponder) window.__ipcResponder(msg);
  },
};

window.__fromRust = function (event, data) {
  (window.__fromRustLog = window.__fromRustLog || []).push({ event: event, data: data });
};
