const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const frontendDir = path.join(__dirname, 'src', 'frontend');
const indexHtml = fs.readFileSync(path.join(frontendDir, 'index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(frontendDir, 'style.css'), 'utf8');
const hljs = fs.readFileSync(path.join(frontendDir, 'highlight.min.js'), 'utf8');
const marked = fs.readFileSync(path.join(frontendDir, 'marked.min.js'), 'utf8');
const mermaid = fs.readFileSync(path.join(frontendDir, 'mermaid.min.js'), 'utf8');
const preview = fs.readFileSync(path.join(frontendDir, 'preview.js'), 'utf8');
const tabs = fs.readFileSync(path.join(frontendDir, 'tabs.js'), 'utf8');
const editor = fs.readFileSync(path.join(frontendDir, 'editor.js'), 'utf8');
const app = fs.readFileSync(path.join(frontendDir, 'app.js'), 'utf8');

function escapeForScriptTag(js) {
  return js.replace(/<\/script/g, '<\\/script');
}

// 构造测试图片（1x1 绿色透明 PNG base64）与测试 SVG
const testSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect width="300" height="200" fill="#1e1b4b" rx="12"/><circle cx="80" cy="100" r="50" fill="#a855f7"/><text x="190" y="106" fill="#ec4899" font-size="22" font-weight="bold" text-anchor="middle" font-family="sans-serif">GlanceMD</text></svg>`;

const mockIpc = `
  window.__ipcMessages = [];
  window.ipc = {
    postMessage: function(msgStr) {
      const msg = JSON.parse(msgStr);
      window.__ipcMessages.push(msg);
      console.log('IPC Mock Received:', msg);
      if (msg.command === 'ready') {
        // 打开一个 Markdown 文档，包含 Mermaid 图表、非法图表和图片
        const mdContent = '# GlanceMD 功能与图表演示\\n\\n' +
          '## 1. Mermaid 流程图\\n\\n' +
          '\`\`\`mermaid\\ngraph TD;\\n  A[用户输入] --> B{解析引擎};\\n  B -->|Markdown| C[Marked 渲染];\\n  B -->|Mermaid| D[Mermaid.js 图表];\\n  C --> E[统一视图];\\n  D --> E;\\n\`\`\`\\n\\n' +
          '## 2. Mermaid 时序图\\n\\n' +
          '\`\`\`mermaid\\nsequenceDiagram\\n  autonumber\\n  actor User as 用户\\n  participant Editor as 编辑器\\n  participant Preview as 预览区\\n  User->>Editor: 输入 Markdown / Mermaid\\n  Editor-->>Preview: 实时防抖渲染\\n  Preview-->>User: 展示精致图表与排版\\n\`\`\`\\n\\n' +
          '## 3. 非法 Mermaid 图表（容错测试）\\n\\n' +
          '\`\`\`mermaid\\nthis is an invalid mermaid syntax -->> error\\n\`\`\`\\n\\n' +
          '## 4. 本地与嵌入图片预览\\n\\n' +
          '![测试SVG图标](/test-demo.svg)\\n\\n' +
          '[点击查看独立图片 Tab](/test-demo.svg)';

        setTimeout(() => {
          window.__fromRust('file_opened', {
            path: 'D:/Documents/demo.md',
            content: mdContent,
            is_image: false
          });
        }, 50);
      } else if (msg.command === 'read_image') {
        setTimeout(() => {
          window.__setImage(msg.path, 'http://127.0.0.1:4123/test-demo.svg');
        }, 50);
      } else if (msg.command === 'open_file' && msg.path && (msg.path.endsWith('.svg') || msg.path.endsWith('.png'))) {
        setTimeout(() => {
          window.__fromRust('file_opened', {
            path: msg.path,
            content: '',
            is_image: true
          });
        }, 50);
      }
    }
  };
  // 覆盖获取图片源，使其在本地测试服务器下直接可用
  var origGetImageSourceUrl = window.getImageSourceUrl;
  window.getImageSourceUrl = function(path) {
    if (path && (path.endsWith('.svg') || path.endsWith('.png') || path.indexOf('test-demo') !== -1)) {
      return 'http://127.0.0.1:4123/test-demo.svg';
    }
    return (origGetImageSourceUrl ? origGetImageSourceUrl(path) : path);
  };
`;

const scripts = [
  `<script>${escapeForScriptTag(hljs)}</script>`,
  `<script>${escapeForScriptTag(marked)}</script>`,
  `<script>${escapeForScriptTag(mermaid)}</script>`,
  `<script>${escapeForScriptTag(preview)}</script>`,
  `<script>${escapeForScriptTag(tabs)}</script>`,
  `<script>${escapeForScriptTag(editor)}</script>`,
  `<script>${escapeForScriptTag(app)}</script>`,
  `<script>${mockIpc}</script>`,
].join('\n');

const fullHtml = indexHtml
  .replace('/* __CSS__ */', () => styleCss)
  .replace('<body>', '<body data-platform="windows">')
  .replace('<!-- __SCRIPTS__ -->', () => scripts);

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fullHtml);
  } else if (req.url === '/test-demo.svg' || req.url.startsWith('/local-image')) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(testSvg);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(4124, '127.0.0.1', () => {
  console.log('测试服务已启动：http://127.0.0.1:4124');
});
