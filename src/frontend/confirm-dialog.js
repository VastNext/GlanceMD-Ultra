/* confirm-dialog.js — 统一未保存修改确认对话框 (ConfirmDialog)
 * 契约与规范：
 * 1. 替代浏览器原生 window.confirm() 与操作系统的原生 MessageBox；
 * 2. 视觉严格遵从 GlanceMD-Ultra 设计语言：居中、磨砂半透明遮罩、精致阴影与紫粉发光边框；
 * 3. 覆盖全软件以下关键场景：
 *    - 顶栏关闭按钮及操作系统关闭事件（Alt+F4 / 任务栏关闭）的未保存确认；
 *    - 单个 Tab 关闭（点击 Tab ✕ 或 Ctrl+W）时的未保存确认；
 *    - 批量 Tab 关闭（右键菜单关闭其他/关闭所有/关闭右侧）时的未保存确认；
 * 4. 异步 Promise 接口，支持键盘 Escape / 点击遮罩取消，Enter / 点击确认按钮放行，打开时自动聚焦在操作按钮上；
 * 5. 零依赖，适配暗黑 (Dark) 与明亮 (Light) 双主题。
 */

(function (root) {
  'use strict';

  function t(key, params) {
    if (window.I18n && typeof window.I18n.t === 'function') {
      return window.I18n.t(key, params);
    }
    return key;
  }

  var state = {
    isOpen: false,
    dom: null,
    resolve: null,
    previousActiveElement: null
  };

  function ensureDom() {
    if (state.dom) return state.dom;

    var overlay = document.createElement('div');
    overlay.id = 'confirm-dialog-overlay';
    overlay.className = 'confirm-dialog-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    var dialog = document.createElement('div');
    dialog.className = 'confirm-dialog-card';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('tabindex', '-1');

    dialog.innerHTML = [
      '<div class="confirm-dialog-header">',
      '  <div class="confirm-dialog-title-wrap">',
      '    <div class="confirm-dialog-icon">',
      '      <svg viewBox="0 0 16 16" fill="none">',
      '        <path d="M8 1.5l6.5 12h-13l6.5-12z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
      '        <path d="M8 6v4M8 12v.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
      '      </svg>',
      '    </div>',
      '    <h3 id="confirm-dialog-title" class="confirm-dialog-title">未保存的修改</h3>',
      '  </div>',
      '  <button id="confirm-dialog-btn-close" class="confirm-dialog-close-btn" aria-label="关闭">✕</button>',
      '</div>',
      '<div class="confirm-dialog-body">',
      '  <p id="confirm-dialog-message" class="confirm-dialog-message">有未保存的修改，确定关闭窗口吗？</p>',
      '</div>',
      '<div class="confirm-dialog-footer">',
      '  <button id="confirm-dialog-btn-cancel" class="confirm-dialog-btn btn-cancel" type="button">取消</button>',
      '  <button id="confirm-dialog-btn-confirm" class="confirm-dialog-btn btn-danger" type="button">放弃并关闭</button>',
      '</div>'
    ].join('');

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    var dom = {
      overlay: overlay,
      dialog: dialog,
      title: dialog.querySelector('#confirm-dialog-title'),
      message: dialog.querySelector('#confirm-dialog-message'),
      btnClose: dialog.querySelector('#confirm-dialog-btn-close'),
      btnCancel: dialog.querySelector('#confirm-dialog-btn-cancel'),
      btnConfirm: dialog.querySelector('#confirm-dialog-btn-confirm')
    };

    function onCancel() {
      close(false);
    }

    function onConfirm() {
      close(true);
    }

    dom.btnClose.addEventListener('click', onCancel);
    dom.btnCancel.addEventListener('click', onCancel);
    dom.btnConfirm.addEventListener('click', onConfirm);

    overlay.addEventListener('pointerdown', function (e) {
      if (e.target === overlay) {
        onCancel();
      }
    });

    dialog.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
    });

    state.dom = dom;
    return dom;
  }

  function show(options) {
    options = options || {};
    if (state.isOpen) {
      close(false);
    }

    state.previousActiveElement = document.activeElement;
    var dom = ensureDom();

    // fallback 走 I18n：调用方未传文案时也随界面语言；DOM 首建 innerHTML 的
    // 中文默认值同样会被这里覆盖
    dom.title.textContent = options.title || t('app.unsavedCloseTitle');
    dom.message.textContent = options.message || t('app.unsavedClose');
    dom.btnConfirm.textContent = options.confirmText || t('app.confirmDiscardClose');
    dom.btnCancel.textContent = options.cancelText || t('app.cancel');
    dom.btnClose.setAttribute('aria-label', t('app.close'));

    if (options.danger === false) {
      dom.btnConfirm.classList.remove('btn-danger');
      dom.btnConfirm.classList.add('btn-primary');
    } else {
      dom.btnConfirm.classList.remove('btn-primary');
      dom.btnConfirm.classList.add('btn-danger');
    }

    dom.overlay.classList.add('open');
    state.isOpen = true;

    // 默认聚焦在取消按钮，防止误敲回车丢内容
    setTimeout(function () {
      if (options.focusConfirm && dom.btnConfirm) {
        dom.btnConfirm.focus();
      } else if (dom.btnCancel) {
        dom.btnCancel.focus();
      }
    }, 20);

    return new Promise(function (resolve) {
      state.resolve = resolve;
    });
  }

  function close(result) {
    if (!state.isOpen) return;
    var dom = state.dom;
    if (dom) {
      dom.overlay.classList.remove('open');
    }
    state.isOpen = false;

    if (typeof state.resolve === 'function') {
      var r = state.resolve;
      state.resolve = null;
      r(Boolean(result));
    }

    if (!result && state.previousActiveElement && typeof state.previousActiveElement.focus === 'function') {
      try {
        state.previousActiveElement.focus();
      } catch (e) {}
    }
  }

  root.ConfirmDialog = {
    show: show,
    close: function () { close(false); },
    isOpen: function () { return state.isOpen; }
  };

})(typeof window !== 'undefined' ? window : globalThis);
