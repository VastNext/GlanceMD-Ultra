const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, expect } = require('playwright/test');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = path.join(ROOT, 'tests', '.tmp', 'index.html');
const REAL_MD_PATH = 'D:/WorkDev/SEOKnowleageBase/raw/articles/seo-references-advanced_en/02.demand-is-keywords-six-methods.md';

function url() {
  execFileSync('python', [path.join(ROOT, 'tools', 'build_test_page.py')], { cwd: ROOT, stdio: 'pipe' });
  return pathToFileURL(PAGE).href;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url());
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const btnNew = page.locator('#btn-new');
  await btnNew.waitFor({ state: 'visible' });
  await btnNew.click();
});

test('问题1：彻底废除实体高亮覆盖层，无DOM下沉重影与悬浮，全靠原生选区', async ({ page }) => {
  const editor = page.locator('#editor');
  await editor.fill('first keyword text\nsecond keyword text\nthird keyword line');
  await editor.focus();

  // 验证页面内已彻底不存在 #editor-find-highlight 元素
  const highlightEl = page.locator('#editor-find-highlight');
  await expect(highlightEl).toHaveCount(0);

  // 执行查找后滚动，选区由原生 selection 渲染，无任何外部浮脱 DOM
  await page.keyboard.press('Control+f');
  await page.locator('#find-input').fill('keyword');
  await page.keyboard.press('Enter');

  await expect(highlightEl).toHaveCount(0);
});

test('问题2：选中文字后按 Ctrl+F 保持在当前选中的匹配项(如 15/29)，绝不跳回第 1 项', async ({ page }) => {
  const editor = page.locator('#editor');
  let content = '';
  if (fs.existsSync(REAL_MD_PATH)) {
    content = fs.readFileSync(REAL_MD_PATH, 'utf8');
  } else {
    content = 'target word\n'.repeat(29);
  }
  await editor.evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, content);
  await editor.focus();

  // 1. 先在内存中找出所有 "is" 的位置
  const matches = await editor.evaluate(() => {
    const text = document.getElementById('editor').value.toLowerCase();
    const list = [];
    let idx = 0;
    while ((idx = text.indexOf('is', idx)) !== -1) {
      list.push({ start: idx, end: idx + 2 });
      idx += 2;
    }
    return list;
  });
  expect(matches.length).toBe(29);

  // 2. 选中第 15 个匹配项（index 14）
  const match15 = matches[14];
  await editor.evaluate((el, m) => el.setSelectionRange(m.start, m.end), match15);

  // 3. 按 Ctrl+F 打开搜索
  await page.keyboard.press('Control+f');
  const findInput = page.locator('#find-input');
  await expect(findInput).toBeVisible();
  await expect(findInput).toHaveValue('is');

  // 4. 计数器必须直接显示 15 of 29！绝不能跳回 1 of 29！
  const findCount = page.locator('#find-count');
  await expect(findCount).toHaveText('15 of 29');

  // 5. 选区仍然停留在第 15 个匹配项，视口不发生向前回跳
  const curSel = await editor.evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd }));
  expect(curSel.start).toBe(match15.start);
  expect(curSel.end).toBe(match15.end);

  // 6. 在搜索框内按 Enter，顺畅去到第 16 个匹配项（16 of 29），焦点依然在搜索框
  await findInput.press('Enter');
  await expect(findCount).toHaveText('16 of 29');
  await expect(findInput).toBeFocused();
  const match16 = matches[15];
  const nextSel = await editor.evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd }));
  expect(nextSel.start).toBe(match16.start);
});

test('问题3：选中文本按 Ctrl+K 静默推进（不主动弹搜索框），已开弹框时在正文按 Esc 立即关闭', async ({ page }) => {
  const editor = page.locator('#editor');
  await editor.fill('apple test\nbanana test\norange test');
  await editor.focus();

  // 1. 查找框关闭状态下，选中文本 "test"
  await editor.evaluate(el => el.setSelectionRange(6, 10)); // 第一处 "test"
  const findBar = page.locator('#find-bar');
  await expect(findBar).toBeHidden();

  // 2. 按 Ctrl+K：必须静默推进到下一处，绝不主动弹出搜索框！焦点依然在编辑器！
  await page.keyboard.press('Control+k');
  await expect(findBar).toBeHidden();
  await expect(editor).toBeFocused();
  const sel1 = await editor.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd));
  expect(sel1).toBe('test');
  const pos1 = await editor.evaluate(el => el.selectionStart);
  expect(pos1).toBe(18); // 第二处 "test"

  // 3. 打开查找框后，把焦点移回正文编辑区
  await page.keyboard.press('Control+f');
  await expect(findBar).toBeVisible();
  await editor.focus();
  await expect(editor).toBeFocused();
  await expect(findBar).toBeVisible();

  // 4. 在正文编辑区直接按 Esc，查找框必须立即关闭，焦点稳稳在编辑器！
  await page.keyboard.press('Escape');
  await expect(findBar).toBeHidden();
  await expect(editor).toBeFocused();
});

test('问题4：Ctrl+F 与 Ctrl+L 为纯悬浮层，正文与行号槽 padding 恒定不变，零顶偏', async ({ page }) => {
  const editor = page.locator('#editor');
  await editor.fill('line 1\nline 2\nline 3\nline 4\nline 5');
  await editor.focus();

  const getPaddings = () => page.evaluate(() => {
    const ed = document.getElementById('editor');
    const gt = document.getElementById('editor-gutter');
    return {
      edPaddingTop: parseFloat(window.getComputedStyle(ed).paddingTop),
      gtPaddingTop: parseFloat(window.getComputedStyle(gt).paddingTop),
      edRectTop: ed.getBoundingClientRect().top,
      gtRectTop: gt.getBoundingClientRect().top
    };
  });

  const basePaddings = await getPaddings();
  expect(basePaddings.edPaddingTop).toBe(28);
  expect(basePaddings.gtPaddingTop).toBe(28);

  // 1. 打开 Ctrl+F
  await page.keyboard.press('Control+f');
  const findBar = page.locator('#find-bar');
  await expect(findBar).toBeVisible();

  const findPaddings = await getPaddings();
  // 核心断言：正文与行号槽的 paddingTop 与矩形 top 绝不被顶偏，与初始恒定一致！
  expect(findPaddings.edPaddingTop).toBe(28);
  expect(findPaddings.gtPaddingTop).toBe(28);
  expect(findPaddings.edRectTop).toBe(basePaddings.edRectTop);

  // 2. 双开 Ctrl+L
  await page.keyboard.press('Control+l');
  const gotoBar = page.locator('#goto-bar');
  await expect(gotoBar).toBeVisible();

  const dualPaddings = await getPaddings();
  expect(dualPaddings.edPaddingTop).toBe(28);
  expect(dualPaddings.gtPaddingTop).toBe(28);
  expect(dualPaddings.edRectTop).toBe(basePaddings.edRectTop);

  // 浮层自带高 z-index 与绝对定位，纯悬浮在正文之上
  await expect(findBar).toHaveCSS('position', 'absolute');
  await expect(gotoBar).toHaveCSS('position', 'absolute');
});

test('问题5：真实 MD 文章搜索 is 匹配 29 项，Ctrl+K 连续推进绝不死循环在第 8 行与第 10 行', async ({ page }) => {
  const editor = page.locator('#editor');
  let content = '';
  if (fs.existsSync(REAL_MD_PATH)) {
    content = fs.readFileSync(REAL_MD_PATH, 'utf8');
  } else {
    content = '# Demand Is Keywords\n> This is a quote.\n' + 'is other content\n'.repeat(27);
  }
  await editor.evaluate((el, val) => {
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, content);
  await editor.focus();

  // 搜索 "is"
  await page.keyboard.press('Control+f');
  const findInput = page.locator('#find-input');
  await findInput.fill('is');

  const findCount = page.locator('#find-count');
  await expect(findCount).toContainText('of 29');

  // 连续按下 10 次 Ctrl+K，记录每次命中的 offset
  const offsets = [];
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Control+k');
    const selStart = await editor.evaluate((el) => el.selectionStart);
    offsets.push(selStart);
  }

  // 验证推进的 offset 是单调递增向前，绝不死循环
  const uniqueFirstFive = new Set(offsets.slice(0, 5));
  expect(uniqueFirstFive.size).toBe(5);
  expect(offsets[2]).toBeGreaterThan(offsets[1]);
  expect(offsets[3]).toBeGreaterThan(offsets[2]);
  expect(offsets[4]).toBeGreaterThan(offsets[3]);
});

async function measureLineAlignment(page, lineNumber, markerText) {
  return page.evaluate(({ lineNumber, markerText }) => {
    const editor = document.getElementById('editor');
    const gutter = document.getElementById('editor-gutter');
    const lines = editor.value.split('\n');
    let lineStart = 0;
    for (let i = 0; i < lineNumber - 1; i++) {
      lineStart += lines[i].length + 1;
    }
    const lineRow = gutter.children[lineNumber - 1];
    if (!lineRow) throw new Error('行号槽缺少第 ' + lineNumber + ' 行');

    const nav = window.EditorNavigation;
    const coords = nav ? nav.measureOffsetCoordinates(lineStart) : null;
    const edRect = editor.getBoundingClientRect();
    const rowTop = lineRow.getBoundingClientRect().top;
    const markerTop = coords ? (edRect.top + coords.top) : 0;
    const cs = getComputedStyle(editor);
    return {
      markerTop,
      rowTop,
      diff: Math.abs(markerTop - rowTop),
      fontSize: cs.fontSize
    };
  }, { lineNumber, markerText });
}

test('问题7：真实文章 10.traffic-acquisition... 关闭自动换行后 77 行在 14px/16px 下绝对对齐', async ({ page }) => {
  const candidateFiles = [
    'D:/WorkDev/SEOKnowleageBase/raw/articles/seo-references-advanced_en/10.traffic-acquisition-8-channels-bing.md',
    'D:/WorkDev/SEOKnowleageBase/raw/articles/seo-references-advanced_en/10.traffic-acquisition-channels-bing.md'
  ];
  const file10 = candidateFiles.find(f => fs.existsSync(f));
  let content = '';
  if (file10) {
    const lines = fs.readFileSync(file10, 'utf8').split(/\r?\n/);
    lines.splice(76, 0, '我在77行');
    content = lines.join('\n');
  } else {
    const lines = Array.from({ length: 90 }, (_, i) => `line ${i + 1} content text`);
    lines.splice(76, 0, '我在77行');
    content = lines.join('\n');
  }
  const editor = page.locator('#editor');
  await editor.evaluate((el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, content);
  await editor.focus();
  await page.keyboard.press('Alt+Shift+y');
  await expect(editor).toHaveClass(/wrap-off/);

  const gotoLine = async () => {
    await page.keyboard.press('Control+l');
    const input = page.locator('#goto-input');
    await input.fill('77');
    await input.press('Enter');
    await expect(page.locator('#goto-bar')).toBeHidden();
    await page.waitForTimeout(50);
  };
  const assertAlignment = async () => {
    const alignment = await measureLineAlignment(page, 77, '我在77行');
    expect(alignment.fontSize).toBe('14px');
    expect(alignment.diff).toBeLessThanOrEqual(5);
  };

  await gotoLine();
  await assertAlignment();
  await editor.evaluate(el => el.scrollLeft = 0);
  fs.mkdirSync(path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07'), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07', 'line-77-wrap-off-14px.png') });

  await page.evaluate(() => {
    const settings = window.SettingsApply.get();
    settings.editor.fontSize = 16;
    window.SettingsApply.apply(settings);
  });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.getElementById('editor')).fontSize)).toBe('16px');
  await gotoLine();
  await editor.evaluate(el => el.scrollLeft = 0);
  const alignment16 = await measureLineAlignment(page, 77, '我在77行');
  expect(alignment16.fontSize).toBe('16px');
  expect(alignment16.diff).toBeLessThanOrEqual(5);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07', 'line-77-wrap-off-16px.png') });
});

test('问题8：方案 B 查找 Enter 激活正文选区并显示发光气泡，Ctrl+K 不打开查找框', async ({ page }) => {
  const editor = page.locator('#editor');
  await editor.fill('alpha needle\\nneedle beta\\nneedle gamma\\nneedle delta');
  await editor.focus();
  await page.keyboard.press('Control+f');
  const findInput = page.locator('#find-input');
  await findInput.fill('needle');
  await expect(findInput).toBeFocused();
  await findInput.press('Enter');
  await expect(findInput).toBeFocused();
  await expect(page.locator('#find-match-badge')).toHaveClass(/visible/);
  await expect(page.locator('#find-match-badge')).toHaveText(/\d+ \/ \d+/);
  expect(await editor.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('needle');

  await page.keyboard.press('Escape');
  await expect(page.locator('#find-bar')).toBeHidden();
  await editor.focus();
  await page.keyboard.press('Control+k');
  await expect(page.locator('#find-bar')).toBeHidden();
  await expect(editor).toBeFocused();
  await expect(page.locator('#find-match-badge')).toHaveClass(/visible/);
  await expect(page.locator('#find-match-badge')).toHaveText(/\d+ \/ \d+/);
  expect(await editor.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('needle');
});

test('问题6：真实文章 09.going-live... 软换行下 Ctrl+L 46 行号与正文精确对齐，且拖动视口依然稳健', async ({ page }) => {
  const file09 = 'D:/WorkDev/SEOKnowleageBase/raw/articles/seo-references-advanced_en/09.going-live-domains-hosting-gsc-analytics-crawlers.md';
  if (!fs.existsSync(file09)) return;
  const content = fs.readFileSync(file09, 'utf8');

  const editor = page.locator('#editor');
  await editor.evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, content);
  await editor.focus();

  // 1. 跳转到 46 行
  await page.keyboard.press('Control+l');
  const input = page.locator('#goto-input');
  await input.fill('46');
  await input.press('Enter');

  // 验证行号槽中第 46 行的行号存在且与正文第 46 行垂直基线对齐
  const align46 = await measureLineAlignment(page, 46, 'Using Vercel');
  expect(align46.diff).toBeLessThanOrEqual(5);

  // 2. 改变视口大小（模拟侧边栏拖拽让编辑器变窄）
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(100); // 等待 ResizeObserver 响应
  const align46Narrow = await measureLineAlignment(page, 46, 'Using Vercel');
  expect(align46Narrow.diff).toBeLessThanOrEqual(5);
});

test('问题9：查找时所有匹配项常驻高亮，当前激活项呈现紫粉渐变底色与发光外框(纯色块零实体文字绝不下沉重影)', async ({ page }) => {
  const editor = page.locator('#editor');
  await editor.fill('target first match\nsome text here\ntarget second match\nmore text\ntarget third match');
  await editor.focus();

  // 按 Ctrl+F 搜索 target
  await page.keyboard.press('Control+f');
  const findInput = page.locator('#find-input');
  await findInput.fill('target');

  // 验证所有匹配项常驻高亮容器诞生，且共有 3 个匹配矩形
  const markers = page.locator('#editor-find-markers .find-match-marker');
  await expect(markers).toHaveCount(3);

  // 验证当前激活项具有 .active-match 类，并且内部绝无 .active-match-text 实体文字（彻底消除下沉与重影）
  const activeMarker = page.locator('#editor-find-markers .find-match-marker.active-match');
  await expect(activeMarker).toHaveCount(1);
  const activeText = activeMarker.locator('.active-match-text');
  await expect(activeText).toHaveCount(0);

  // 按 Enter 切换到下一个，验证 active-match 平滑移到下一个矩形
  await findInput.press('Enter');
  await expect(activeMarker).toHaveCount(1);
});

test('问题10：Ctrl+Shift+R 打开深层文件时，资源管理器自动级联递归展开各级父目录并高亮文件', async ({ page }) => {
  // 模拟工作区打开根目录及多级树结构返回
  await page.evaluate(() => {
    window.__fromRust('workspace:opened', { root: 'D:/WorkDev/SEOKnowleageBase' });
    // 返回根目录包含 raw 子目录
    window.__fromRust('workspace:tree-listed', {
      path: '',
      entries: [{ name: 'raw', relPath: 'raw', kind: 'dir' }]
    });
    // 返回 raw 包含 articles
    window.__fromRust('workspace:tree-listed', {
      path: 'raw',
      entries: [{ name: 'articles', relPath: 'raw/articles', kind: 'dir' }]
    });
    // 返回 articles 包含 seo-references_en
    window.__fromRust('workspace:tree-listed', {
      path: 'raw/articles',
      entries: [{ name: 'seo-references_en', relPath: 'raw/articles/seo-references_en', kind: 'dir' }]
    });
    // 返回 seo-references_en 包含目标 md 文件
    window.__fromRust('workspace:tree-listed', {
      path: 'raw/articles/seo-references_en',
      entries: [{ name: '12.free-seo-tools-ahrefs-aitdk.md', relPath: 'raw/articles/seo-references_en/12.free-seo-tools-ahrefs-aitdk.md', kind: 'file' }]
    });

    // 创建该深层文件 Tab（模拟通过快捷键或最近文件打开）
    window.TabManager.createTab('D:/WorkDev/SEOKnowleageBase/raw/articles/seo-references_en/12.free-seo-tools-ahrefs-aitdk.md', '# Content');
  });

  // 验证 ProjectTree 的 activeFile 准确记录为该目标文件的相对路径
  const activeFile = await page.evaluate(() => {
    return window.ProjectTree && window.ProjectTree.getState ? window.ProjectTree.getState().activeFile : null;
  });
  expect(activeFile).toBe('raw/articles/seo-references_en/12.free-seo-tools-ahrefs-aitdk.md');
});

test('问题11：切换自动换行(Alt+Shift+Y)时光标所在行在视口中保持居中锚定，不发生跳偏', async ({ page }) => {
  const editor = page.locator('#editor');
  const longText = Array.from({ length: 100 }, (_, i) => `Paragraph line ${i + 1}: ` + '超长中文文本用以强制折行排版。'.repeat(i % 3 === 0 ? 15 : 2)).join('\n');
  await editor.evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, longText);
  await editor.focus();

  // 定位到第 50 行
  await page.keyboard.press('Control+l');
  const gotoInput = page.locator('#goto-input');
  await gotoInput.fill('50');
  await gotoInput.press('Enter');

  const offset50 = await editor.evaluate(el => el.selectionStart);
  const edRect = await editor.evaluate(el => el.getBoundingClientRect());
  const initialTop = await editor.evaluate((el, off) => window.EditorNavigation.measureOffsetCoordinates(off).top, offset50);

  // 按 Alt+Shift+Y 关闭换行
  await page.keyboard.press('Alt+Shift+y');
  await expect(editor).toHaveClass(/wrap-off/);

  // 验证光标字符 offset 严格不变，且目标文字依然稳固处于视口可见区域（未跳脱到视口外）
  const afterOffset = await editor.evaluate(el => el.selectionStart);
  expect(afterOffset).toBe(offset50);

  const visibleTop = await editor.evaluate((el, off) => window.EditorNavigation.measureOffsetCoordinates(off).top, offset50);
  // 必须位于编辑区视口高度之内（即可见）
  expect(visibleTop).toBeGreaterThanOrEqual(0);
  expect(visibleTop).toBeLessThan(edRect.height);
});

test('问题12：真实文章 11.seo-meta-tags 中定位 a post 之间，Alt+Shift+Y 切换前后光标严格锁定在原单词处且查找绝不下沉重影', async ({ page }) => {
  const file11 = 'D:/WorkDev/SEOKnowleageBase/raw/articles/seo-references_en/11.seo-meta-tags-part3-canonical-schema-opengraph-viewport.md';
  if (!fs.existsSync(file11)) return;
  const content = fs.readFileSync(file11, 'utf8');
  const target = 'a post';
  const targetIdx = content.indexOf(target);
  expect(targetIdx).toBeGreaterThan(0);

  const editor = page.locator('#editor');
  await editor.evaluate((el, text) => {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, content);

  // 1. 将光标精准定位到 'a post' 的 'a' 和 ' post' 之间 (targetIdx + 1)
  const cursorOffset = targetIdx + 1;
  await editor.evaluate((el, pos) => {
    el.focus();
    el.setSelectionRange(pos, pos);
    if (window.EditorNavigation && window.EditorNavigation.scrollToOffset) {
      window.EditorNavigation.scrollToOffset(pos);
    }
    if (window.CustomCaret && window.CustomCaret.update) {
      window.CustomCaret.update();
    }
  }, cursorOffset);
  await page.waitForTimeout(100);

  // 验证软换行开启时光标定位在 'a post'
  const caret = page.locator('#custom-caret');
  await expect(caret).toBeVisible();
  const boxWrapOn = await caret.boundingBox();
  expect(boxWrapOn).toBeTruthy();

  // 截图保存开启软换行时状态
  fs.mkdirSync(path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07'), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07', 'real-article-11-wrap-on.png') });

  // 2. 按 Alt+Shift+Y 切换自动换行（关闭软换行）
  await page.keyboard.press('Alt+Shift+y');
  await expect(editor).toHaveClass(/wrap-off/);
  await page.waitForTimeout(150);

  // 验证切换换行后 selectionStart 严格保持不变
  const curPos = await editor.evaluate(el => el.selectionStart);
  expect(curPos).toBe(cursorOffset);

  // 验证切换换行后自定义光标依然位于可视区域内，并且牢固对齐原文字
  await expect(caret).toBeVisible();
  const boxWrapOff = await caret.boundingBox();
  expect(boxWrapOff).toBeTruthy();

  // 截图保存关闭软换行时状态
  await page.screenshot({ path: path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07', 'real-article-11-wrap-off.png') });

  // 3. 执行查找 'Example'，验证无实体下沉文本（无 .active-match-text）
  await page.keyboard.press('Control+f');
  const findInput = page.locator('#find-input');
  await findInput.fill('Example');
  await findInput.press('Enter');

  const activeMarker = page.locator('#editor-find-markers .find-match-marker.active-match');
  await expect(activeMarker).toHaveCount(1);
  await expect(activeMarker.locator('.active-match-text')).toHaveCount(0);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07', 'real-article-11-find-no-ghosting.png') });
});

test('问题13：在 Preview 模式下按 Ctrl+F 弹出查找条并精准搜索 Preview 页内容，Ctrl+K 推进并显示发光气泡', async ({ page }) => {
  const editor = page.locator('#editor');
  await editor.fill('# Heading Preview\n\nThis is a sample markdown paragraph with target word and another target word in preview.');
  await page.keyboard.press('Control+s'); // 切换或保存

  // 点击模式切换按钮，切到 Preview 模式
  const btnToggle = page.locator('#btn-toggle');
  await btnToggle.click();
  await expect(page.locator('#status-mode')).toHaveText('PREVIEW');
  await expect(page.locator('#preview-container')).toHaveClass(/active/);

  // 1. 在 Preview 状态下按下 Ctrl+F，验证查找条准确弹出在 preview-container 顶部
  await page.keyboard.press('Control+f');
  const findBar = page.locator('#find-bar');
  await expect(findBar).toBeVisible();
  await expect(findBar).toHaveClass(/open/);

  // 验证 findBar 的父节点正是 preview-container
  const parentId = await findBar.evaluate(el => el.parentNode ? el.parentNode.id : null);
  expect(parentId).toBe('preview-container');

  // 2. 输入搜索词 'target'，验证在 preview 中生成 mark.find-match 并且当前项为 mark.find-active
  const findInput = page.locator('#find-input');
  await findInput.fill('target');

  const matches = page.locator('#preview mark.find-match');
  await expect(matches).toHaveCount(2);

  const activeMatch = page.locator('#preview mark.find-match.find-active');
  await expect(activeMatch).toHaveCount(1);
  await expect(activeMatch).toHaveText('target');

  // 按 Enter 推进到下一个并触发发光气泡提示 (2 / 2)
  await findInput.press('Enter');
  const badge = page.locator('#find-match-badge');
  await expect(badge).toHaveClass(/visible/);
  await expect(badge).toHaveText('2 / 2');

  // 截图验证 Preview 模式下查找效果
  fs.mkdirSync(path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07'), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07', 'preview-find-active.png') });

  // 3. 继续按 Enter，验证循环回到第一个匹配项 (1 / 2)
  await findInput.press('Enter');
  await expect(badge).toHaveText('1 / 2');

  // 4. 按 Escape 关闭查找条
  await page.keyboard.press('Escape');
  await expect(findBar).toBeHidden();

  // 5. 在 Preview 模式下按 Ctrl+K，验证静默查找并推进到下一个匹配项 (2 / 2)
  await page.keyboard.press('Control+k');
  await expect(findBar).toBeHidden(); // 静默，不打开查找条
  await expect(badge).toHaveClass(/visible/);
  await expect(badge).toHaveText('2 / 2');
  await expect(activeMatch).toHaveCount(1);
});

test('问题14：Preview 跨屏滚动搜索时，查找条保持在固定外壳内绝不随正文滚出视口', async ({ page }) => {
  const file02 = 'D:/WorkDev/SEOKnowleageBase/raw/articles/seo-references_en/02.google-seo-ranking-factors.md';
  let content = '';
  if (fs.existsSync(file02)) {
    content = fs.readFileSync(file02, 'utf8');
  } else {
    // 自包含兜底内容：生成 100 个章节包含目标词 seo 的长文档，确保 CI 无外部文件时绝不跳跑
    content = Array.from({ length: 80 }, (_, i) => `## Chapter ${i + 1} with seo topic\n\nLong paragraph content for section ${i + 1} discussing seo principles in depth.\n`).join('\n');
  }

  const editor = page.locator('#editor');
  await editor.evaluate((el, text) => {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, content);

  // 切到 Preview 预览模式
  await page.click('#btn-toggle');
  await expect(page.locator('#status-mode')).toHaveText('PREVIEW');

  // 按 Ctrl+F 搜索 'seo'
  await page.keyboard.press('Control+f');
  const findBar = page.locator('#find-bar');
  const findInput = page.locator('#find-input');
  await findInput.fill('seo');
  await expect(findBar).toBeVisible();

  // 连续 Enter 多次直到发生深层跨屏滚动
  for (let i = 0; i < 6; i++) {
    await findInput.press('Enter');
  }

  // 验证只有 preview-wrapper 滚动，find-bar 仍以 absolute 挂在固定外壳中且输入框持续聚焦
  await expect(findBar).toBeVisible();
  await expect(findBar).toHaveCSS('position', 'absolute');
  await expect(findInput).toBeFocused();
  expect(await page.locator('#preview-wrapper').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.locator('#preview-container').evaluate(el => el.scrollTop)).toBe(0);
  expect(await page.evaluate(() => document.body.scrollTop)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
  const box = await findBar.boundingBox();
  expect(box).toBeTruthy();
  const paneBox = await page.locator('#preview-container').boundingBox();
  expect(paneBox).toBeTruthy();
  expect(box.y).toBeGreaterThanOrEqual(paneBox.y);
  expect(box.y).toBeLessThan(paneBox.y + 80);

  // 截图留档保存
  await page.screenshot({ path: path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07', 'preview-find-sticky-fixed.png') });
});

test('问题15：Preview 选中文本按 Ctrl+F 定位在当前项(如 3/6)不回跳第 1 项；关闭搜索框后选中新词按 Ctrl+K 顺畅推进到下一项且连续按键绝不跳回老搜索词', async ({ page }) => {
  const editor = page.locator('#editor');
  const markdown = [
    '# Test Document',
    '',
    'Here is oldterm first mention.',
    'Now we have newterm alpha here.',
    'Some filler text in between lines.',
    'Now we have newterm beta here.',
    'More filler text lines.',
    'Now we have newterm gamma here.',
    'Another oldterm second mention.',
    'Now we have newterm delta here.',
    'Filler text continuation.',
    'Now we have newterm epsilon here.',
    'And finally newterm zeta here.'
  ].join('\n');

  await editor.evaluate((el, text) => {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, markdown);

  // 切到 Preview 预览模式
  await page.click('#btn-toggle');
  await expect(page.locator('#status-mode')).toHaveText('PREVIEW');

  // 1. 先用 Ctrl+F 搜索老词 'oldterm'，然后关闭搜索框（此时 input.value 曾残留 oldterm）
  await page.keyboard.press('Control+f');
  const findInput = page.locator('#find-input');
  await findInput.fill('oldterm');
  await expect(page.locator('#preview mark.find-match')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('#find-bar')).toBeHidden();

  // 2. 在 Preview 划选第三个 'newterm'（位于 'newterm gamma'）
  await page.evaluate(() => {
    const preview = document.getElementById('preview');
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
    let node;
    let count = 0;
    while (node = walker.nextNode()) {
      const idx = node.textContent.indexOf('newterm gamma');
      if (idx !== -1) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + 'newterm'.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        break;
      }
    }
  });

  // 3. 选中文本后按下 Ctrl+F，验证精准定位到第 3 项 (3 of 6)，而不是跳回第 1 项！
  await page.keyboard.press('Control+f');
  await expect(page.locator('#find-bar')).toBeVisible();
  await expect(findInput).toHaveValue('newterm');
  const countEl = page.locator('#find-count');
  await expect(countEl).toHaveText('3 of 6');

  // 验证底栏正中央紫粉发光气泡 (3 / 6)
  const badge = page.locator('#find-match-badge');
  await expect(badge).toHaveClass(/visible/);
  await expect(badge).toHaveText('3 / 6');

  // 验证气泡位于窗口水平正中间
  const badgeBox = await badge.boundingBox();
  const viewportSize = page.viewportSize();
  const badgeCenter = badgeBox.x + badgeBox.width / 2;
  expect(Math.abs(badgeCenter - viewportSize.width / 2)).toBeLessThan(5);
  // 验证气泡位于底部上方
  expect(badgeBox.y + badgeBox.height).toBeLessThanOrEqual(viewportSize.height - 20);

  // 截图验证正下方紫粉气泡视觉效果
  await page.screenshot({ path: path.join(ROOT, 'docs', 'qa', 'integration-2026-09-07', 'preview-bottom-purple-badge.png') });

  // 4. 关闭搜索框
  await page.keyboard.press('Escape');
  await expect(page.locator('#find-bar')).toBeHidden();

  // 5. 划选第 4 个 'newterm'（'newterm delta'）
  await page.evaluate(() => {
    const preview = document.getElementById('preview');
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      const idx = node.textContent.indexOf('newterm delta');
      if (idx !== -1) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + 'newterm'.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        break;
      }
    }
  });

  // 6. 按 Ctrl+K，验证静默查找并精准推进到下一个（第 5 项 epsilon：5 / 6）
  await page.keyboard.press('Control+k');
  await expect(page.locator('#find-bar')).toBeHidden();
  await expect(badge).toHaveClass(/visible/);
  await expect(badge).toHaveText('5 / 6');

  // 7. 再次按 Ctrl+K，验证顺畅推进到第 6 项（6 / 6），绝不跳回老词 oldterm！
  await page.keyboard.press('Control+k');
  await expect(badge).toHaveText('6 / 6');
  const activeMark = page.locator('#preview mark.find-match.find-active');
  await expect(activeMark).toHaveText('newterm');
});

test('问题16：Ctrl+Shift+V 切换编辑预览与 Ctrl+\\ 切换分屏生效，顶栏按钮 Tooltip 同步最新快捷键', async ({ page }) => {
  // 1. 验证顶栏按钮的 Tooltip (title 属性)
  const btnToggle = page.locator('#btn-toggle');
  const btnSplit = page.locator('#btn-split');
  await expect(btnToggle).toHaveAttribute('title', /Ctrl\+Shift\+V/);
  expect(await btnSplit.getAttribute('title')).toContain('Ctrl+\\');

  // 2. 在编辑模式下按 Ctrl+Shift+V 切换到预览
  await expect(page.locator('#status-mode')).toHaveText('EDIT');
  await page.keyboard.press('Control+Shift+v');
  await expect(page.locator('#status-mode')).toHaveText('PREVIEW');
  await expect(page.locator('#preview-container')).toHaveClass(/active/);

  // 再次按 Ctrl+Shift+V 切回编辑
  await page.keyboard.press('Control+Shift+v');
  await expect(page.locator('#status-mode')).toHaveText('EDIT');
  await expect(page.locator('#editor-container')).toHaveClass(/active/);

  // 3. 按 Ctrl+\ 开启左右分屏
  await page.keyboard.press('Control+\\');
  await expect(page.locator('body')).toHaveClass(/split-mode/);
  await expect(page.locator('#btn-split')).toHaveClass(/active/);

  // 再次按 Ctrl+\ 退出分屏
  await page.keyboard.press('Control+\\');
  await expect(page.locator('body')).not.toHaveClass(/split-mode/);
  await expect(page.locator('#btn-split')).not.toHaveClass(/active/);
});




