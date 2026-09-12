// toast.js —— 全应用统一的气泡提示（AppToast）
//
// 设计约定（见 style.css #app-toast）：紫粉渐变底 + 白字是全应用唯一的
// 气泡提示样式；任何模块需要提示时只传文字调用 AppToast.show，
// 禁止自建提示元素。
//
// 用法：
//   AppToast.show('已保存', { duration: 1400 })   // 自动消失（默认 1600ms）
//   AppToast.show('正在翻译…', { sticky: true })  // 粘滞，直至下一次 show/hide
//   AppToast.hide()
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.AppToast = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var el = null;
  var timer = null;

  function ensure() {
    if (el && el.parentNode) return el;
    if (typeof document === 'undefined') return null;
    el = document.createElement('div');
    el.id = 'app-toast';
    el.hidden = true;
    el.setAttribute('role', 'status');
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  // 连续两次 rAF：保证重复 show 时 visible 类的过渡动画可重放
  function raf(fn) {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(function () { window.requestAnimationFrame(fn); });
    } else {
      fn();
    }
  }

  function show(text, opts) {
    var node = ensure();
    if (!node) return;
    opts = opts || {};
    node.textContent = String(text == null ? '' : text);
    node.hidden = false;
    raf(function () { if (el) el.classList.add('visible'); });
    if (timer) { clearTimeout(timer); timer = null; }
    if (!opts.sticky) {
      var duration = typeof opts.duration === 'number' ? opts.duration : 1600;
      timer = setTimeout(function () { hide(); }, duration);
    }
  }

  function hide() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!el) return;
    el.classList.remove('visible');
    raf(function () { if (el && !el.classList.contains('visible')) el.hidden = true; });
  }

  return { show: show, hide: hide };
});
