/* about-dialog.js — 「关于 GlanceMD Ultra」对话框（window.AboutDialog）
 * 契约与规范：
 * 1. 参考 VS Code / Typora 等桌面软件的 About 入口：应用 Logo、名称 + 版本徽章、
 *    一句话简介、官网与源码链接、版权行；
 * 2. 版本号由 Rust 侧启动时注入的 window.__APP_VERSION__ 提供（与 Cargo.toml
 *    package.version 同源），前端不做第二事实源；缺省回退 dev 占位；
 * 3. 链接点击经上行 IPC `open_external` 交给系统浏览器打开（wire 命令，见
 *    docs/dev/interfaces.md §2.2），前端仅放行 http/https URL；
 * 4. 视觉遵从设计语言：磨砂遮罩、紫粉渐变 Logo（--heading-gradient）与徽章，
 *    暗色/亮色双主题随既有 token 自适配；
 * 5. 交互：Esc / 点击遮罩 / 关闭按钮均可关闭，打开时聚焦关闭按钮，关闭后焦点还原；
 *    零依赖，惰性建 DOM（首次 show 才创建，同 confirm-dialog 模式）。
 */

(function (root) {
  'use strict';

  var WEBSITE_URL = 'https://vastnext.com/glance-md-ultra';
  var SOURCE_URL = 'https://github.com/VastNext/GlanceMD-Ultra';

  function t(key, params, fallback) {
    if (root.I18n && typeof root.I18n.t === 'function') {
      var v = root.I18n.t(key, params);
      if (typeof v === 'string' && v && v !== key) return v;
    }
    return fallback || key;
  }

  var state = {
    isOpen: false,
    dom: null,
    previousActiveElement: null
  };

  function appVersion() {
    var v = root.__APP_VERSION__;
    return (typeof v === 'string' && v) ? v : '0.0.0-dev';
  }

  function currentYear() {
    try { return new Date().getFullYear(); } catch (e) { return 2026; }
  }

  function isSafeExternalUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url) && !/[\s"'<>]/.test(url);
  }

  function sendToRust(command, data) {
    var msg = JSON.stringify(Object.assign({ command: command }, data || {}));
    if (root.ipc && typeof root.ipc.postMessage === 'function') {
      root.ipc.postMessage(msg);
    }
  }

  function ensureDom() {
    if (state.dom) return state.dom;

    var overlay = document.createElement('div');
    overlay.id = 'about-dialog-overlay';
    overlay.className = 'about-dialog-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    var dialog = document.createElement('div');
    dialog.className = 'about-dialog-card';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'about-dialog-title');
    dialog.setAttribute('tabindex', '-1');

    dialog.innerHTML = [
      '<button id="about-dialog-btn-close" class="about-dialog-close" type="button" aria-label="关闭">✕</button>',
      '<div class="about-dialog-logo" aria-hidden="true">',
      '  <svg viewBox="0 0 16 16" fill="none">',
      '    <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" stroke-width="1.2"/>',
      '    <circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.2"/>',
      '  </svg>',
      '</div>',
      '<h2 id="about-dialog-title" class="about-dialog-name">GlanceMD Ultra</h2>',
      '<div class="about-dialog-version-badge" id="about-dialog-version">v0.0.0</div>',
      '<p class="about-dialog-desc" id="about-dialog-desc"></p>',
      '<div class="about-dialog-links">',
      '  <button type="button" class="about-dialog-link" data-url="' + WEBSITE_URL + '" id="about-dialog-link-website"></button>',
      '  <span class="about-dialog-link-sep" aria-hidden="true">·</span>',
      '  <button type="button" class="about-dialog-link" data-url="' + SOURCE_URL + '" id="about-dialog-link-source"></button>',
      '</div>',
      '<div class="about-dialog-copyright" id="about-dialog-copyright"></div>'
    ].join('');

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    var dom = {
      overlay: overlay,
      dialog: dialog,
      btnClose: dialog.querySelector('#about-dialog-btn-close'),
      version: dialog.querySelector('#about-dialog-version'),
      desc: dialog.querySelector('#about-dialog-desc'),
      copyright: dialog.querySelector('#about-dialog-copyright')
    };

    function onClose() {
      close();
    }

    dom.btnClose.addEventListener('click', onClose);
    overlay.addEventListener('pointerdown', function (e) {
      if (e.target === overlay) onClose();
    });
    dialog.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        onClose();
      }
    });

    Array.prototype.forEach.call(dialog.querySelectorAll('.about-dialog-link'), function (link) {
      link.addEventListener('click', function (e) {
        if (e.preventDefault) e.preventDefault();
        var url = link.getAttribute('data-url');
        if (!isSafeExternalUrl(url)) return;
        sendToRust('open_external', { url: url });
        close();
      });
    });

    state.dom = dom;
    refreshTexts();
    return dom;
  }

  function refreshTexts() {
    if (!state.dom) return;
    var dom = state.dom;
    dom.version.textContent = 'v' + appVersion().replace(/^v/, '');
    dom.desc.textContent = t('about.description', '轻量原生 Markdown 工作区编辑器');
    dom.copyright.textContent = t(
      'about.copyright',
      { year: currentYear() },
      '© ' + currentYear() + ' VastNext · GlanceMD Ultra'
    );
    dom.btnClose.setAttribute('aria-label', t('about.close', '关闭'));
    var website = document.getElementById('about-dialog-link-website');
    var source = document.getElementById('about-dialog-link-source');
    if (website) {
      website.textContent = t('about.website', '官方网站');
      website.setAttribute('title', WEBSITE_URL);
    }
    if (source) {
      source.textContent = t('about.source', '源代码');
      source.setAttribute('title', SOURCE_URL);
    }
  }

  function show() {
    state.previousActiveElement = document.activeElement;
    var dom = ensureDom();

    refreshTexts();
    dom.overlay.classList.add('open');
    dom.overlay.setAttribute('aria-hidden', 'false');
    state.isOpen = true;

    setTimeout(function () {
      if (dom.btnClose && typeof dom.btnClose.focus === 'function') dom.btnClose.focus();
    }, 20);
  }

  function close() {
    if (!state.isOpen) return;
    var dom = state.dom;
    if (dom) {
      dom.overlay.classList.remove('open');
      dom.overlay.setAttribute('aria-hidden', 'true');
    }
    state.isOpen = false;

    if (state.previousActiveElement && typeof state.previousActiveElement.focus === 'function') {
      try { state.previousActiveElement.focus(); } catch (e) {}
    }
  }

  /* 语言切换时刷新文案（对话框未建 DOM 时跳过，show 会按当前语言渲染） */
  root.addEventListener('i18n-changed', refreshTexts);

  /* 命令注册：help.about 是菜单 / 命令面板 / 快捷键共用的唯一入口 ID。
   * 本模块晚于 commands.js 装载，可直接登记；重复装载以 has 门控防抛错 */
  if (root.Commands && typeof root.Commands.register === 'function' && !root.Commands.has('help.about')) {
    root.Commands.register('help.about', {
      label: '关于 GlanceMD Ultra',
      category: 'Help',
      run: function () { show(); }
    });
  }

  root.AboutDialog = {
    show: show,
    close: close,
    isOpen: function () { return state.isOpen; },
    refresh: refreshTexts,
    /* 供单测注入伪版本号；生产环境由 Rust 启动引导脚本写入 */
    _setVersionForTest: function (v) { root.__APP_VERSION__ = v; }
  };

})(typeof window !== 'undefined' ? window : globalThis);
