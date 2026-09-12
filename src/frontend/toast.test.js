/* toast.test.js —— AppToast 统一气泡提示的单元测试（node:test + node:vm） */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadHarness() {
  const els = {};
  let now = 0;
  const timers = [];
  function makeEl(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      id: '',
      hidden: false,
      textContent: '',
      attrs: {},
      parentNode: null,
      classList: {
        _classes: new Set(),
        add(c) { this._classes.add(c); },
        remove(c) { this._classes.delete(c); },
        contains(c) { return this._classes.has(c); },
      },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      rafCount: 0,
    };
    return el;
  }
  const body = makeEl('body');
  body.appendChild = function (child) {
    child.parentNode = this;
    if (child.id) els[child.id] = child;
    return child;
  };
  const doc = {
    readyState: 'complete',
    body,
    documentElement: body,
    createElement: makeEl,
  };
  const ctx = {
    console,
    document: doc,
    setTimeout(fn, ms) { const t = { id: ++now, fn, ms }; timers.push(t); return t.id; },
    clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    requestAnimationFrame(fn) { fn(); return 1; },
  };
  ctx.window = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'toast.js'), 'utf8'), ctx, { filename: 'toast.js' });
  return { ctx, els, timers, body };
}

test('AppToast 模块挂载与 API 暴露', () => {
  const h = loadHarness();
  assert.ok(h.ctx.AppToast);
  assert.equal(typeof h.ctx.AppToast.show, 'function');
  assert.equal(typeof h.ctx.AppToast.hide, 'function');
});

test('show 创建唯一元素、写入文字并显示', () => {
  const h = loadHarness();
  h.ctx.AppToast.show('正在翻译…', { sticky: true });
  const el = h.els['app-toast'];
  assert.ok(el, '#app-toast 已创建');
  assert.equal(el.textContent, '正在翻译…');
  assert.equal(el.hidden, false);
  assert.equal(el.classList.contains('visible'), true);
  assert.equal(el.attrs.role, 'status');

  // 再次 show：复用同一元素、文字替换
  h.ctx.AppToast.show('已还原原文');
  assert.equal(h.els['app-toast'], el, '复用同一元素');
  assert.equal(el.textContent, '已还原原文');
});

test('非 sticky 自动消失，sticky 不安排计时器', () => {
  const h = loadHarness();
  h.ctx.AppToast.show('自动消失', { duration: 1200 });
  assert.equal(h.timers.length, 1, '安排了隐藏计时器');
  h.ctx.AppToast.show('粘滞提示', { sticky: true });
  assert.equal(h.timers.length, 0, 'sticky 清除隐藏计时器');
  h.ctx.AppToast.show('默认时长');
  assert.equal(h.timers.length, 1);
  const t = h.timers[0];
  assert.equal(t.ms, 1600, '默认时长 1600ms');
  t.fn();
  assert.equal(h.els['app-toast'].classList.contains('visible'), false);
  assert.equal(h.els['app-toast'].hidden, true);
});

test('hide 立即收敛', () => {
  const h = loadHarness();
  h.ctx.AppToast.show('x', { sticky: true });
  h.ctx.AppToast.hide();
  assert.equal(h.els['app-toast'].classList.contains('visible'), false);
});
