// Configure marked.js with highlight.js via custom renderer
var renderer = new marked.Renderer();
renderer.code = function(token) {
  var lang = (token.lang || '').trim();
  var code = token.text;
  var highlighted;
  if (lang && hljs.getLanguage(lang)) {
    highlighted = hljs.highlight(code, { language: lang }).value;
  } else {
    highlighted = hljs.highlightAuto(code).value;
  }
  var cls = lang ? ' class="language-' + lang + '"' : '';
  // data-language 供 CSS 显示 marco 风格的语言标签
  var dataLang = lang ? ' data-language="' + lang + '"' : '';
  // 右上角复制按钮（复制逻辑走事件委托，见文件末尾）
  var copyBtn =
    '<button class="code-copy-btn" title="Copy code" aria-label="Copy code">' +
    '<svg viewBox="0 0 16 16" fill="none">' +
    '<rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/>' +
    '<path d="M11 5V3.5a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1H4.5" stroke="currentColor" stroke-width="1.2"/>' +
    '</svg></button>';
  return '<pre' + dataLang + '>' + copyBtn + '<code' + cls + '>' + highlighted + '</code></pre>';
};

// 文档开头 YAML frontmatter（--- 包裹）特殊处理：
// 若直接交给 marked，结尾的 --- 会被当作 setext 标题下划线，
// 导致整块 frontmatter 以超大标题渲染、且与正文之间失去分隔线。
// 这里在最前提取并转义为普通信息块，再补一个空行 + --- 生成分隔线。
function stripFrontmatter(markdown) {
  var m = /^---\r?\n([\s\S]+?)\r?\n---\s*\r?\n?/.exec(markdown);
  if (!m) return markdown;
  var esc = m[1]
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return (
    '<div class="frontmatter"><pre>' + esc + '</pre></div>\n\n---\n\n' +
    markdown.slice(m[0].length)
  );
}

marked.use({
  hooks: {
    preprocess: stripFrontmatter,
  },
});

marked.setOptions({
  breaks: true,
  gfm: true,
  renderer: renderer,
});

// Post-process: resolve local images via IPC
function resolveLocalImages() {
  var tab = typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;
  if (!tab || !tab.path) return;
  var dir = tab.path.replace(/[/\\][^/\\]*$/, '');
  var imgs = document.getElementById('preview').querySelectorAll('img');
  for (var i = 0; i < imgs.length; i++) {
    var src = imgs[i].getAttribute('src');
    if (!src || /^https?:\/\/|^data:/i.test(src)) continue;
    if (imgs[i].getAttribute('data-local-src')) continue;
    // Decode URL-encoded characters (%20 → space, %5C → backslash, etc.)
    var decoded = decodeURIComponent(src);
    // Strip file:// prefix if present
    decoded = decoded.replace(/^file:\/\/\/?/, '');
    // Detect absolute paths (D:/... or /...) vs relative
    var absPath;
    if (/^[a-zA-Z]:[\\/]/.test(decoded) || decoded.startsWith('/')) {
      absPath = decoded;
    } else {
      absPath = dir + '/' + decoded.replace(/^\.\//, '');
    }
    // Normalize to forward slashes
    absPath = absPath.replace(/\\/g, '/');
    imgs[i].setAttribute('data-local-src', absPath);
    imgs[i].removeAttribute('src');
    sendToRust('read_image', { path: absPath });
  }
}

// Rust calls this with base64 data
window.__setImage = function(path, dataUri) {
  var imgs = document.querySelectorAll('img[data-local-src]');
  for (var i = 0; i < imgs.length; i++) {
    if (imgs[i].getAttribute('data-local-src') === path) {
      imgs[i].src = dataUri;
    }
  }
};

function resolveLocalLinkPath(href, sourcePath) {
  var tab = typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;
  var tabPath = sourcePath || (tab && tab.path);
  if (!href || !tabPath) return null;
  var rawPath = href.replace(/[?#].*$/, '');
  var decoded = decodeURIComponent(rawPath).replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(decoded) || decoded.startsWith('/')) return decoded;
  var base = tabPath.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
  return base + '/' + decoded.replace(/^\.\//, '');
}

var blockedNavigationUrl = null;
var blockedNavigationPath = null;
var fallbackPreviousFocus = null;

function hideNavigationFallback() {
  document.getElementById('navigation-fallback').hidden = true;
  if (fallbackPreviousFocus && typeof fallbackPreviousFocus.focus === 'function') {
    fallbackPreviousFocus.focus();
  } else {
    document.getElementById('preview-container').focus();
  }
}

window.showNavigationFallback = function(url) {
  blockedNavigationUrl = url;
  fallbackPreviousFocus = document.activeElement;
  blockedNavigationPath = null;
  var href = url.replace(/^(?:http:\/\/glancemd\.localhost|glancemd:\/\/localhost)\//i, '');
  try { blockedNavigationPath = resolveLocalLinkPath(href); } catch (_) {}
  var fallback = document.getElementById('navigation-fallback');
  document.getElementById('navigation-fallback-target').textContent = url;
  var retry = document.getElementById('navigation-fallback-retry');
  retry.hidden = !/^(?:http:\/\/glancemd\.localhost|glancemd:\/\/localhost)\//i.test(url);
  fallback.hidden = false;
  fallback.focus();
};

document.getElementById('navigation-fallback-back').addEventListener('click', hideNavigationFallback);
document.getElementById('navigation-fallback-close').addEventListener('click', hideNavigationFallback);
document.getElementById('navigation-fallback-retry').addEventListener('click', function() {
  if (blockedNavigationUrl && blockedNavigationPath) {
    hideNavigationFallback();
    sendToRust('open_file', { path: blockedNavigationPath });
  }
});

document.getElementById('navigation-fallback').addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    hideNavigationFallback();
  }
});

/* ── 代码块右上角复制按钮 ── */

// 兜底复制：clipboard API 不可用时使用隐藏 textarea + execCommand
function copyCodeFallback(text, done) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) {}
  document.body.removeChild(ta);
}

// 复制成功后的按钮反馈（临时换成对勾，1.5s 后还原）
function copyCodeDone(btn) {
  var orig = btn.innerHTML;
  btn.classList.add('copied');
  btn.innerHTML =
    '<svg viewBox="0 0 16 16" fill="none">' +
    '<path d="M3.5 8.5l3 3 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  setTimeout(function() {
    btn.classList.remove('copied');
    btn.innerHTML = orig;
  }, 1500);
}

// 事件委托：preview 每次 innerHTML 重建后仍有效，无需重新绑定
document.getElementById('preview-container').addEventListener('click', function(e) {
  if (!e.target || !e.target.closest) return;
  var link = e.target.closest('a');
  if (link) {
    var href = link.getAttribute('href');
    var windowsPath = href && /^[a-zA-Z]:[\\/]/.test(href);
    if (href && (windowsPath || !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href))) {
      if (typeof TabManager !== 'undefined' && TabManager.getActiveTab()) {
        try {
          var path = resolveLocalLinkPath(href);
        } catch (_) {
          e.preventDefault();
          if (typeof showError === 'function') showError('链接地址格式无效');
          return;
        }
        if (path) {
          e.preventDefault();
          sendToRust('open_file', { path: path });
        }
      }
    }
    return;
  }
  var btn = e.target.closest('.code-copy-btn');
  if (!btn) return;
  var pre = btn.parentElement;
  var codeEl = pre ? pre.querySelector('code') : null;
  if (!codeEl) return;
  // textContent 保留高亮前的原始代码文本（含换行与缩进）
  var text = codeEl.textContent;
  function done() { copyCodeDone(btn); }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function() {
      copyCodeFallback(text, done);
    });
  } else {
    copyCodeFallback(text, done);
  }
});
