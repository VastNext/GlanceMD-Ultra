const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');

function createEnv() {
  const listeners = {};
  let currentActiveElement = null;

  const doc = {
    get activeElement() {
      return currentActiveElement;
    },
    set activeElement(el) {
      currentActiveElement = el;
    },
    addEventListener(event, fn) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(fn);
    },
    removeEventListener(event, fn) {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(l => l !== fn);
      }
    },
    dispatchEvent(e) {
      const fns = listeners[e.type] || [];
      fns.forEach(fn => fn(e));
    }
  };

  function createElement(tag, id) {
    const el = {
      tagName: tag.toUpperCase(),
      id: id || '',
      parentNode: null,
      focused: false,
      scrolled: false,
      focus() {
        this.focused = true;
        doc.activeElement = this;
      },
      scrollIntoView(opt) {
        this.scrolled = true;
        this.scrollOpt = opt;
      },
      contains(other) {
        let curr = other;
        while (curr) {
          if (curr === this) return true;
          curr = curr.parentNode;
        }
        return false;
      }
    };
    return el;
  }

  const win = { document: doc, console };
  win.window = win;

  vm.runInNewContext(fs.readFileSync('src/frontend/overlay-helper.js', 'utf8'), win);

  return { win, doc, createElement, listeners };
}

test('OverlayHelper records activeElement on open and restores on close', () => {
  const env = createEnv();
  const input = env.createElement('input', 'test-input');
  input.focus();
  assert.equal(env.doc.activeElement, input);

  const dialog = env.createElement('div', 'my-dialog');
  let closed = false;

  env.win.OverlayHelper.open('my-dialog', dialog, () => { closed = true; });
  assert.equal(env.win.OverlayHelper.getActiveOverlay().id, 'my-dialog');

  // Change focus inside dialog
  const dialogInput = env.createElement('input', 'dialog-input');
  dialogInput.parentNode = dialog;
  dialogInput.focus();
  assert.equal(env.doc.activeElement, dialogInput);

  // Close and restore focus
  input.focused = false;
  env.win.OverlayHelper.close('my-dialog');
  assert.equal(input.focused, true);
});

test('OverlayHelper closes previous overlay on opening new one (mutual exclusion)', () => {
  const env = createEnv();
  const panel1 = env.createElement('div', 'panel-1');
  const panel2 = env.createElement('div', 'panel-2');
  let p1Closed = false;
  let p2Closed = false;

  env.win.OverlayHelper.open('panel-1', panel1, () => { p1Closed = true; });
  assert.equal(env.win.OverlayHelper.getActiveOverlay().id, 'panel-1');

  env.win.OverlayHelper.open('panel-2', panel2, () => { p2Closed = true; });
  assert.equal(p1Closed, true, 'panel-1 should be closed when panel-2 opens');
  assert.equal(env.win.OverlayHelper.getActiveOverlay().id, 'panel-2');
});

test('OverlayHelper detects outside pointerdown and calls close', () => {
  const env = createEnv();
  const dialog = env.createElement('div', 'dialog');
  const insideBtn = env.createElement('button', 'btn-inside');
  insideBtn.parentNode = dialog;
  const outsideBtn = env.createElement('button', 'btn-outside');

  let closeCount = 0;
  env.win.OverlayHelper.open('dialog', dialog, () => { closeCount++; });

  // Inside click should not close
  env.doc.dispatchEvent({ type: 'pointerdown', target: insideBtn });
  assert.equal(closeCount, 0);

  // Outside click should close
  env.doc.dispatchEvent({ type: 'pointerdown', target: outsideBtn });
  assert.equal(closeCount, 1);
});

test('OverlayHelper detects outside focusin and calls close', () => {
  const env = createEnv();
  const dialog = env.createElement('div', 'dialog');
  const insideEl = env.createElement('input', 'in-input');
  insideEl.parentNode = dialog;
  const outsideEl = env.createElement('input', 'out-input');

  let closeCount = 0;
  env.win.OverlayHelper.open('dialog', dialog, () => { closeCount++; });

  // Focus inside should not close
  env.doc.dispatchEvent({ type: 'focusin', target: insideEl });
  assert.equal(closeCount, 0);

  // Focus outside should close
  env.doc.dispatchEvent({ type: 'focusin', target: outsideEl });
  assert.equal(closeCount, 1);
});

test('OverlayHelper scrollIntoView safely invokes element scrollIntoView', () => {
  const env = createEnv();
  const item = env.createElement('li', 'item-1');
  env.win.OverlayHelper.scrollIntoView(item);
  assert.equal(item.scrolled, true);
  assert.equal(item.scrollOpt.block, 'nearest');
  assert.equal(item.scrollOpt.inline, 'nearest');
});
