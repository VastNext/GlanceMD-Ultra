const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadPreview(options = {}) {
  let clickHandler;
  let activePath = 'D:/Software/CLIProxyAPI/README.md';
  const listeners = {};
  const messages = [];
  const preview = { innerHTML: '<h1>当前文档</h1>', querySelectorAll() { return []; } };
  const fallback = {
    hidden: true,
    focus() {},
    querySelector() { return null; },
  };
  const elements = {
    preview,
    'preview-container': { focus() {} },
    'navigation-fallback': fallback,
    'navigation-fallback-target': { textContent: '' },
    'navigation-fallback-back': {},
    'navigation-fallback-retry': {},
    'navigation-fallback-close': {},
    'image-lightbox': { hidden: true, classList: { add() {}, remove() {} } },
    'lightbox-img': { removeAttribute() {} },
    'lightbox-caption': { textContent: '' },
    'lightbox-close': { focus() {} },
  };
  const context = {
    marked: {
      Renderer: function() {},
      use() {},
      setOptions() {},
    },
    hljs: {},
    TabManager: {
      getActiveTab() {
        return { path: activePath };
      },
    },
    sendToRust(command, data) {
      messages.push({ command, data });
    },
    document: {
      activeElement: { focus() {} },
      body: {
        appendChild() {},
        removeChild() {},
      },
      createElement() {
        return {
          style: {},
          select() {},
          setAttribute() {},
          appendChild() {},
          removeChild() {},
          normalize() {},
        };
      },
      getElementById(id) {
        if (id === 'preview-container') {
          return {
            addEventListener(type, handler) {
              if (type === 'click') clickHandler = handler;
            },
          };
        }
        const element = elements[id] || { querySelectorAll() { return []; } };
        element.addEventListener = function(type, handler) {
          listeners[id + ':' + type] = handler;
        };
        return element;
      },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      addEventListener(type, handler) { listeners['document:' + type] = handler; },
      execCommand() {},
    },
    window: {},
    navigator: options.navigator || {},
    setTimeout() {},
    showError(message) {
      messages.push({ command: 'error', data: { message } });
    },
  };

  const source = fs.readFileSync(__dirname + '/preview.js', 'utf8');
  vm.runInNewContext(source, context);
  return {
    clickHandler,
    elements,
    listeners,
    messages,
    setActivePath(path) { activePath = path; },
    window: context.window,
  };
}

test('点击相对 Markdown 链接时请求 Rust 打开目标文件', () => {
  const { clickHandler, messages } = loadPreview();
  const anchor = { getAttribute: () => 'README_CN.md' };
  let prevented = false;

  clickHandler({
    target: {
      closest(selector) {
        return selector === 'a' ? anchor : null;
      },
    },
    preventDefault() { prevented = true; },
  });

  assert.equal(prevented, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].command, 'open_file');
  assert.equal(messages[0].data.path, 'D:/Software/CLIProxyAPI/README_CN.md');
});

test('被拦截导航显示回退提示且保留当前预览', () => {
  const loaded = loadPreview();
  const elements = loaded.elements;

  elements.preview.innerHTML = '<h1>当前文档</h1>';
  assert.equal(typeof elements['navigation-fallback'].hidden, 'boolean');

  assert.doesNotThrow(() => {
    // Rust 事件最终调用该全局函数。
    loaded.window.showNavigationFallback('http://glancemd.localhost/README_CN.md');
  });
  assert.equal(elements.preview.innerHTML, '<h1>当前文档</h1>');
  assert.equal(elements['navigation-fallback'].hidden, false);
});

test('重试被拦截的应用内路径时打开当前文档旁的文件', () => {
  const loaded = loadPreview();

  loaded.window.showNavigationFallback('http://glancemd.localhost/README_CN.md');
  loaded.listeners['navigation-fallback-retry:click']();

  assert.equal(loaded.messages.at(-1).command, 'open_file');
  assert.equal(
    loaded.messages.at(-1).data.path,
    'D:/Software/CLIProxyAPI/README_CN.md',
  );
  assert.equal(loaded.elements['navigation-fallback'].hidden, true);
});

test('重试使用触发失败时的源标签路径', () => {
  const loaded = loadPreview();
  loaded.window.showNavigationFallback('http://glancemd.localhost/README_CN.md');
  loaded.setActivePath('D:/Other/other.md');
  loaded.listeners['navigation-fallback-retry:click']();

  assert.equal(
    loaded.messages.at(-1).data.path,
    'D:/Software/CLIProxyAPI/README_CN.md',
  );
});

test('macOS/Linux 的 glancemd 协议被拦截后仍显示回退并可重试', () => {
  const loaded = loadPreview();
  loaded.setActivePath('/Users/admin/Docs/README.md');
  loaded.window.showNavigationFallback('glancemd://localhost/README_CN.md');
  assert.equal(loaded.elements['navigation-fallback'].hidden, false);
  assert.equal(loaded.elements['navigation-fallback-retry'].hidden, false);

  loaded.listeners['navigation-fallback-retry:click']();
  assert.equal(loaded.messages.at(-1).command, 'open_file');
  assert.equal(loaded.messages.at(-1).data.path, '/Users/admin/Docs/README_CN.md');
});

test('网络链接与页内锚点保持浏览器默认行为', () => {
  ['https://example.com', '#usage'].forEach((href) => {
    const { clickHandler, messages } = loadPreview();
    const anchor = { getAttribute: () => href };
    let prevented = false;

    clickHandler({
      target: { closest: () => anchor },
      preventDefault() { prevented = true; },
    });

    assert.equal(prevented, false);
    assert.deepEqual(messages, []);
  });
});

test('点击 Windows 绝对路径时直接打开该文件', () => {
  ['D:/Docs/guide.md', 'D:\\Docs\\guide.md'].forEach((href) => {
    const { clickHandler, messages } = loadPreview();

    clickHandler({
      target: { closest: () => ({ getAttribute: () => href }) },
      preventDefault() {},
    });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].command, 'open_file');
    assert.equal(messages[0].data.path, 'D:/Docs/guide.md');
  });
});

test('解析路径前先移除查询和锚点', () => {
  const { clickHandler, messages } = loadPreview();

  clickHandler({
    target: { closest: () => ({ getAttribute: () => 'design%23draft%3Fv2.md#section' }) },
    preventDefault() {},
  });

  assert.equal(messages[0].data.path, 'D:/Software/CLIProxyAPI/design#draft?v2.md');
});

test('非法 URL 编码不会触发 WebView 导航或抛出异常', () => {
  const { clickHandler, messages } = loadPreview();
  let prevented = false;

  assert.doesNotThrow(() => clickHandler({
    target: { closest: () => ({ getAttribute: () => 'bad%ZZ.md' }) },
    preventDefault() { prevented = true; },
  }));

  assert.equal(prevented, true);
  assert.equal(messages[0].command, 'error');
  assert.equal(messages[0].data.message, '链接地址格式无效');
});

test('点击常见图片相对链接时请求 Rust 打开图片文件', () => {
  const { clickHandler, messages } = loadPreview();
  const anchor = { getAttribute: () => './assets/diagram.png' };
  let prevented = false;

  clickHandler({
    target: {
      closest(selector) {
        return selector === 'a' ? anchor : null;
      },
    },
    preventDefault() { prevented = true; },
  });

  assert.equal(prevented, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].command, 'open_file');
  assert.equal(messages[0].data.path, 'D:/Software/CLIProxyAPI/assets/diagram.png');
});

test('Mermaid 语言代码块被渲染为专用 mermaid-block 容器', () => {
  let customRenderer;
  const context = {
    marked: {
      Renderer: function() {
        customRenderer = this;
      },
      use() {},
      setOptions() {},
    },
    hljs: {
      getLanguage() { return false; },
      highlightAuto() { return { value: '' }; }
    },
    TabManager: { getActiveTab() { return null; } },
    sendToRust() {},
    document: {
      activeElement: { focus() {} },
      getElementById() { return { addEventListener() {} }; },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      addEventListener() {},
    },
    window: {},
    navigator: {},
    setTimeout() {},
  };

  const source = fs.readFileSync(__dirname + '/preview.js', 'utf8');
  vm.runInNewContext(source, context);

  const mermaidCode = 'graph TD;\n  A-->B;';
  const html = customRenderer.code({ lang: 'mermaid', text: mermaidCode });

  assert.match(html, /class="mermaid-block"/);
  assert.match(html, /class="mermaid-chart"/);
  assert.match(html, /data-raw-code="graph%20TD%3B%0A%20%20A--%3EB%3B"/);
  assert.match(html, /class="code-copy-btn mermaid-copy-btn"/);
});

test('点击 Mermaid 代码块的复制按钮时复制原始未转义代码', () => {
  const rawCode = 'graph TD;\n  A-->B;';
  let copiedText = null;
  const { clickHandler } = loadPreview({
    navigator: {
      clipboard: {
        writeText: async (t) => { copiedText = t; }
      }
    }
  });

  const button = {
    className: 'code-copy-btn mermaid-copy-btn',
    classList: { add() {}, remove() {} },
    innerHTML: '<svg></svg>',
    closest(selector) {
      if (selector === '.code-copy-btn') return button;
      if (selector === '.mermaid-block') {
        return {
          getAttribute(attr) {
            return attr === 'data-raw-code' ? encodeURIComponent(rawCode) : null;
          }
        };
      }
      return null;
    }
  };

  clickHandler({
    target: {
      closest(selector) {
        if (selector === 'a') return null;
        if (selector === 'img') return null;
        if (selector === '.code-copy-btn') return button;
        return null;
      }
    },
    preventDefault() {},
  });

  assert.equal(copiedText, rawCode);
});

test('点击预览中的普通图片元素打开 Lightbox 预览', () => {
  const { clickHandler, elements } = loadPreview();
  const imgElement = {
    src: 'http://127.0.0.1:4123/test-demo.svg',
    getAttribute(attr) {
      return attr === 'alt' ? '测试SVG图标' : null;
    },
    closest(selector) {
      if (selector === 'a') return null;
      if (selector === '.code-copy-btn') return null;
      if (selector === 'img') return imgElement;
      return null;
    }
  };

  clickHandler({
    target: imgElement,
    preventDefault() {},
  });

  assert.equal(elements['image-lightbox'].hidden, false);
  assert.equal(elements['lightbox-caption'].textContent, '测试SVG图标');
});
