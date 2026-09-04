const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// outline.js 单测（node:test + vm，零依赖，stub 风格照 smoke.test.js / layout.test.js）。
// 覆盖：层级提取、缩进类名、空态、点击滚动、激活高亮、MutationObserver 接线、
// 200ms 防抖重建、IntersectionObserver 可视高亮（可选增强，缺失时静默）。
const SOURCE = fs.readFileSync(path.join(__dirname, 'outline.js'), 'utf8');

/* ── 最小 DOM stub ── */

function matchSelector(el, selector) {
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  return el.tagName === selector.toUpperCase();
}

function descendants(el) {
  const out = [];
  (el.children || []).forEach((child) => {
    if (!child || child.nodeType === 3) return;
    out.push(child);
    out.push(...descendants(child));
  });
  return out;
}

function makeElement(tag) {
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    listeners: {},
    dataset: {},
    attributes: {},
    style: {},
    textContent: '',
    parentNode: null,
    appendChild(child) {
      el.children.push(child);
      child.parentNode = el;
      return child;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i !== -1) el.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, handler) {
      (el.listeners[type] = el.listeners[type] || []).push(handler);
    },
    removeEventListener() {},
    setAttribute(name, value) {
      el.attributes[name] = String(value);
    },
    getAttribute(name) {
      return name in el.attributes ? el.attributes[name] : null;
    },
    classList: {
      add(...names) { names.forEach((n) => classes.add(n)); },
      remove(...names) { names.forEach((n) => classes.delete(n)); },
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains(name) { return classes.has(name); },
    },
    querySelector(selector) {
      const parts = String(selector).split(',').map((s) => s.trim());
      return descendants(el).find((d) => parts.some((s) => matchSelector(d, s))) || null;
    },
    querySelectorAll(selector) {
      const parts = String(selector).split(',').map((s) => s.trim());
      return descendants(el).filter((d) => parts.some((s) => matchSelector(d, s)));
    },
    scrollIntoView(opts) {
      el.scrollCalls = el.scrollCalls || [];
      el.scrollCalls.push(opts);
    },
    dispatchEvent(ev) {
      (el.listeners[ev.type] || []).forEach((fn) => fn(ev));
      return true;
    },
    click() {
      el.dispatchEvent({ type: 'click' });
    },
    focus() {},
  };
  Object.defineProperty(el, 'className', {
    get: () => Array.from(classes).join(' '),
    set: (v) => {
      classes.clear();
      String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
  });
  let innerHTMLValue = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => innerHTMLValue,
    set: (value) => {
      innerHTMLValue = String(value);
      el.children.length = 0;
    },
  });
  return el;
}

/* ── 装载 harness ── */

function loadHarness({ headings = [], withIntersection = false, seedPreview = true } = {}) {
  const observers = [];
  const intersections = [];
  const pendingTimers = [];
  const scrollCalls = [];

  const ids = {};
  const byId = (id) => (ids[id] = ids[id] || makeElement('div'));

  const body = makeElement('body');
  const outlineRoot = byId('outline-root');
  const builtinEmpty = makeElement('p');
  builtinEmpty.className = 'panel-empty';
  builtinEmpty.textContent = '暂无大纲';
  outlineRoot.appendChild(builtinEmpty); // index.html 自带空态
  if (seedPreview) byId('preview');
  byId('preview-container');
  body.appendChild(outlineRoot);

  headings.forEach((def) => {
    const el = makeElement('h' + def.level);
    el.textContent = def.text;
    el.scrollIntoView = (opts) => {
      scrollCalls.push({ el, opts });
    };
    byId('preview').appendChild(el);
  });

  class MutationObserverStub {
    constructor(cb) {
      this.cb = cb;
      observers.push(this);
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
    }
    disconnect() {
      this.disconnected = true;
    }
  }

  class IntersectionObserverStub {
    constructor(cb, options) {
      this.cb = cb;
      this.options = options;
      this.observed = [];
      intersections.push(this);
    }
    observe(el) {
      this.observed.push(el);
    }
    disconnect() {
      this.disconnected = true;
    }
  }

  const windowObj = {
    // 定时器句柄用对象模拟，clearTimeout 真实移除（防抖合并断言依赖此语义）
    setTimeout: (fn, ms) => {
      const handle = { fn, ms };
      pendingTimers.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      const i = pendingTimers.indexOf(handle);
      if (i !== -1) pendingTimers.splice(i, 1);
    },
  };

  const context = {
    window: windowObj,
    document: {
      body,
      getElementById: (id) => (ids[id] ? ids[id] : null),
      createElement: (tag) => makeElement(tag),
      createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    },
    MutationObserver: MutationObserverStub,
    console,
  };
  if (withIntersection) {
    context.IntersectionObserver = IntersectionObserverStub;
  }

  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'outline.js' });

  return {
    ids,
    Outline: windowObj.Outline,
    observers,
    intersections,
    pendingTimers,
    scrollCalls,
    preview() {
      return ids['preview'] || null;
    },
    listItems() {
      const list = ids['outline-root'].children[0];
      return list ? list.children.filter((n) => n.classList.contains('outline-item')) : [];
    },
    emptyEl() {
      const list = ids['outline-root'].children[0];
      return list ? list.children.find((n) => n.classList.contains('outline-empty')) : null;
    },
    flushTimeouts() {
      while (pendingTimers.length) pendingTimers.shift().fn();
    },
  };
}

const SAMPLE = [
  { level: 1, text: '写作工作流' },
  { level: 2, text: '素材收集' },
  { level: 2, text: '草稿与修订' },
  { level: 3, text: '版本快照' },
];

/* ══════════ 提取与渲染 ══════════ */

test('挂载：接管 #outline-root，创建 #outline-list 并摘掉自带空态', () => {
  const h = loadHarness({ headings: SAMPLE });
  assert.equal(h.Outline.isMounted(), true);
  const list = h.ids['outline-root'].children[0];
  assert.equal(list.id, 'outline-list');
  assert.equal(h.ids['outline-root'].children.length, 1, 'index.html 自带空态已被移除');
  assert.equal(h.listItems().length, 4);
});

test('层级提取：按文档顺序提取 h1–h6 的级别与文本', () => {
  const h = loadHarness({ headings: SAMPLE });
  const heads = h.Outline.getHeadings();
  // vm 沙箱数组与宿主 realm 原型不同，展开为宿主数组后比较（interfaces.md §4.1 约定）
  assert.deepEqual([...heads.map((x) => x.level)], [1, 2, 2, 3]);
  assert.deepEqual([...heads.map((x) => x.text)], ['写作工作流', '素材收集', '草稿与修订', '版本快照']);
});

test('缩进层级：条目携带 outline-h1…outline-h6 类名（缩进由 CSS 承担）', () => {
  const h = loadHarness({ headings: SAMPLE });
  const items = h.listItems();
  assert.equal(items[0].classList.contains('outline-h1'), true);
  assert.equal(items[1].classList.contains('outline-h2'), true);
  assert.equal(items[3].classList.contains('outline-h3'), true);

  const h6 = loadHarness({ headings: [{ level: 6, text: '最深' }] }).listItems()[0];
  assert.equal(h6.classList.contains('outline-h6'), true);
});

test('每项含级别标记与标题文本', () => {
  const h = loadHarness({ headings: SAMPLE });
  const items = h.listItems();
  assert.equal(items[0].querySelector('.outline-lv').textContent, 'H1');
  assert.equal(items[2].querySelector('.outline-line').textContent, '草稿与修订');
});

test('空文档/无标题：显示"暂无大纲"空态', () => {
  const h = loadHarness({ headings: [] });
  assert.equal(h.listItems().length, 0);
  assert.ok(h.emptyEl());
  assert.equal(h.emptyEl().textContent, '暂无大纲');
  assert.equal(h.Outline.getActiveIndex(), -1);
});

test('空白文本归一：连续空白折叠、无文本标题占位', () => {
  const h = loadHarness({
    headings: [
      { level: 1, text: '  多   空格  标题 ' },
      { level: 2, text: '' },
    ],
  });
  const heads = h.Outline.getHeadings();
  assert.equal(heads[0].text, '多 空格 标题');
  assert.equal(heads[1].text, '');
  assert.equal(h.listItems()[1].querySelector('.outline-line').textContent, '（无标题文本）');
});

/* ══════════ 点击滚动与激活高亮 ══════════ */

test('点击条目滚动预览到对应标题并即时高亮', () => {
  const h = loadHarness({ headings: SAMPLE });
  const target = h.preview().children[2]; // 第二个 h2"草稿与修订"

  h.listItems()[2].click();

  assert.equal(h.scrollCalls.length, 1);
  assert.equal(h.scrollCalls[0].el, target, '滚动到第二个 h2（草稿与修订）');
  assert.equal(h.scrollCalls[0].opts.behavior, 'smooth');
  assert.equal(h.scrollCalls[0].opts.block, 'start');
  assert.equal(h.Outline.getActiveIndex(), 2);
  assert.equal(h.listItems()[2].classList.contains('active'), true);
});

test('Outline.scrollTo：越界下标不滚动也不抛错', () => {
  const h = loadHarness({ headings: SAMPLE });
  assert.doesNotThrow(() => h.Outline.scrollTo(99));
  assert.deepEqual(h.scrollCalls, []);
  assert.equal(h.Outline.getActiveIndex(), -1);
});

test('激活高亮互斥：切换后仅当前项带 active', () => {
  const h = loadHarness({ headings: SAMPLE });
  h.Outline.setActive(0);
  assert.equal(h.listItems()[0].classList.contains('active'), true);

  h.Outline.setActive(3);
  assert.equal(h.listItems()[0].classList.contains('active'), false);
  assert.equal(h.listItems()[3].classList.contains('active'), true);
  assert.equal(h.listItems().filter((n) => n.classList.contains('active')).length, 1);
});

test('setActive 越界下标被忽略', () => {
  const h = loadHarness({ headings: SAMPLE });
  h.Outline.setActive(-1);
  h.Outline.setActive(4);
  assert.equal(h.listItems().filter((n) => n.classList.contains('active')).length, 0);
});

/* ══════════ 预览变化监听与防抖重建 ══════════ */

test('MutationObserver 接线：监听 #preview 的 childList/subtree/characterData', () => {
  const h = loadHarness({ headings: SAMPLE });
  assert.equal(h.observers.length, 1);
  assert.equal(h.observers[0].target, h.preview());
  const options = h.observers[0].options;
  assert.equal(options.childList, true);
  assert.equal(options.subtree, true);
  assert.equal(options.characterData, true);
});

test('防抖重建：变化后不立即重建，200ms 后重建为新内容', () => {
  const h = loadHarness({ headings: SAMPLE });
  assert.equal(h.Outline.getHeadings().length, 4);

  // 预览追加一个 h2（模拟 marked 重渲染）
  const extra = makeElement('h2');
  extra.textContent = '新增小节';
  h.preview().appendChild(extra);
  h.observers[0].cb();

  assert.equal(h.Outline.getHeadings().length, 4, '防抖窗口内不重建');
  assert.equal(h.pendingTimers.length, 1);
  assert.equal(h.pendingTimers[0].ms, 200, '防抖 200ms');

  h.flushTimeouts();
  const heads = h.Outline.getHeadings();
  assert.equal(heads.length, 5);
  assert.equal(heads[4].text, '新增小节');
});

test('防抖合并：窗口内多次变化只重建一次', () => {
  const h = loadHarness({ headings: SAMPLE });

  h.observers[0].cb();
  h.observers[0].cb();
  h.observers[0].cb();
  assert.equal(h.pendingTimers.length, 1, '重复触发只保留一个定时器');

  h.flushTimeouts();
  assert.equal(h.Outline.getHeadings().length, 4);
});

test('Outline.refresh：手动立即重建（观察器不可用时的兜底）', () => {
  const h = loadHarness({ headings: SAMPLE });

  h.preview().innerHTML = ''; // 清空预览
  h.Outline.refresh();

  assert.equal(h.Outline.getHeadings().length, 0);
  assert.ok(h.emptyEl(), '重建后回到空态');
});

test('重建后旧激活下标越界即清除', () => {
  const h = loadHarness({ headings: SAMPLE });
  h.Outline.setActive(3);
  assert.equal(h.Outline.getActiveIndex(), 3);

  h.preview().children[3].parentNode.removeChild(h.preview().children[3]);
  h.Outline.refresh();

  assert.equal(h.Outline.getHeadings().length, 3);
  assert.equal(h.Outline.getActiveIndex(), -1);
});

test('预览缺失时安全降级：空态 + refresh 不抛错', () => {
  const h = loadHarness({ headings: [], seedPreview: false });
  assert.equal(h.Outline.isMounted(), true);
  assert.ok(h.emptyEl());
  assert.doesNotThrow(() => h.Outline.refresh());
});

test('#outline-root 缺失时模块不挂载也不抛错', () => {
  const ids = {};
  const context = {
    window: { setTimeout() { return 0; }, clearTimeout() {} },
    document: {
      getElementById: (id) => (ids[id] ? ids[id] : null),
      createElement: () => makeElement('div'),
    },
    console,
  };
  vm.createContext(context);
  assert.doesNotThrow(() => {
    vm.runInContext(SOURCE, context, { filename: 'outline.js' });
  });
  assert.equal(context.window.Outline.isMounted(), false);
  assert.doesNotThrow(() => context.window.Outline.refresh());
});

/* ══════════ 可视标题高亮（IntersectionObserver，可选增强） ══════════ */

test('IntersectionObserver 可用：观察全部标题并按可视项高亮', () => {
  const h = loadHarness({ headings: SAMPLE, withIntersection: true });
  assert.equal(h.intersections.length, 1);
  const io = h.intersections[0];
  assert.deepEqual(io.observed, h.preview().children, '四个标题全部被观察');
  assert.equal(io.options.root, h.ids['preview-container']);

  io.cb([{ target: h.preview().children[2], isIntersecting: true }]);
  assert.equal(h.Outline.getActiveIndex(), 2);

  io.cb([{ target: h.preview().children[0], isIntersecting: true }]);
  assert.equal(h.Outline.getActiveIndex(), 0);
});

test('IntersectionObserver：非可视项与未知目标不改变高亮', () => {
  const h = loadHarness({ headings: SAMPLE, withIntersection: true });
  const io = h.intersections[0];

  io.cb([{ target: h.preview().children[1], isIntersecting: false }]);
  assert.equal(h.Outline.getActiveIndex(), -1);

  io.cb([{ target: makeElement('h1'), isIntersecting: true }]);
  assert.equal(h.Outline.getActiveIndex(), -1);
});

test('IntersectionObserver 缺失时静默跳过（其余功能不受影响）', () => {
  const h = loadHarness({ headings: SAMPLE, withIntersection: false });
  assert.equal(h.intersections.length, 0);
  assert.equal(h.Outline.getHeadings().length, 4);
  assert.doesNotThrow(() => h.Outline.setActive(1));
});

test('重建时断开旧观察器并重新观察新标题', () => {
  const h = loadHarness({ headings: SAMPLE, withIntersection: true });
  const first = h.intersections[0];

  const extra = makeElement('h2');
  extra.textContent = '新节';
  h.preview().appendChild(extra);
  h.Outline.refresh();

  assert.equal(first.disconnected, true, '旧观察器已断开');
  assert.equal(h.intersections.length, 2);
  assert.equal(h.intersections[1].observed.length, 5);
});
