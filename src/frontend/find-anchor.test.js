const assert = require('node:assert/strict');
const test = require('node:test');

// 模拟 app.js 核心算法逻辑
function resolveCurrentMatchIndex(matches, anchorStart, anchorEnd) {
  if (!matches || matches.length === 0) return 0;
  if (anchorStart == null) return 0;
  // 1. 完全吻合
  for (var i = 0; i < matches.length; i++) {
    var m = matches[i];
    if (m && typeof m === 'object' && m.start === anchorStart && m.end === anchorEnd) return i;
  }
  // 2. 锚点落在匹配项区间内
  for (var j = 0; j < matches.length; j++) {
    var mj = matches[j];
    if (mj && typeof mj === 'object' && anchorStart >= mj.start && anchorStart <= mj.end) return j;
  }
  // 3. 寻找锚点之后的第一个匹配项
  for (var k = 0; k < matches.length; k++) {
    var mk = matches[k];
    if (mk && typeof mk === 'object' && mk.start >= anchorStart) return k;
  }
  return 0;
}

test('resolveCurrentMatchIndex: 完全吻合优先命中', () => {
  const matches = [
    { start: 10, end: 12 },
    { start: 30, end: 32 },
    { start: 50, end: 52 },
  ];
  assert.equal(resolveCurrentMatchIndex(matches, 30, 32), 1);
});

test('resolveCurrentMatchIndex: 锚点在区间内命中该项', () => {
  const matches = [
    { start: 10, end: 20 },
    { start: 30, end: 40 },
  ];
  assert.equal(resolveCurrentMatchIndex(matches, 15, 15), 0);
  assert.equal(resolveCurrentMatchIndex(matches, 35, 35), 1);
});

test('resolveCurrentMatchIndex: 锚点在区间之间命中后一项', () => {
  const matches = [
    { start: 10, end: 20 },
    { start: 30, end: 40 },
    { start: 50, end: 60 },
  ];
  assert.equal(resolveCurrentMatchIndex(matches, 25, 25), 1);
  assert.equal(resolveCurrentMatchIndex(matches, 45, 45), 2);
});

test('openFind / doFind: 无选区再次 Ctrl+F 且词未变时使用 preserveCurrent 保留原匹配位置', () => {
  const fullText = Array.from({ length: 54 }, (_, i) => `line ${i + 1}: is target`).join('\n');
  const term = 'target';
  const matches = [];
  let idx = 0;
  while ((idx = fullText.indexOf(term, idx)) !== -1) {
    matches.push({ start: idx, end: idx + term.length });
    idx += term.length;
  }
  assert.equal(matches.length, 54);

  // 模拟推进到第 16 个匹配项 (index 15)
  const lastMatch = { start: matches[15].start, end: matches[15].end };
  const lastQuery = 'target';

  // 模拟用户 Escape 并点击正文光标到开头 (selectionStart = 0, selectionEnd = 0, 无选区)
  const editor = { selectionStart: 0, selectionEnd: 0, value: fullText };
  const input = { value: '' };
  let anchorStart = null;
  let anchorEnd = null;
  let preserveCurrent = false;

  const candidateQuery = lastQuery || input.value || '';
  input.value = candidateQuery;
  if (candidateQuery && candidateQuery === lastQuery && lastMatch) {
    preserveCurrent = true;
  } else if (editor) {
    anchorStart = editor.selectionStart;
    anchorEnd = editor.selectionEnd;
  }

  assert.equal(preserveCurrent, true);
  assert.equal(anchorStart, null);

  // 模拟 doFind 定位
  let initial = 0;
  if (anchorStart != null) {
    initial = resolveCurrentMatchIndex(matches, anchorStart, anchorEnd);
  } else if (preserveCurrent && lastMatch) {
    const matchIdx = matches.findIndex(m => m.start === lastMatch.start && m.end === lastMatch.end);
    if (matchIdx >= 0) initial = matchIdx;
  }

  // 必须依然保持在 index 15（即第 16 个匹配），绝不跳回 0！
  assert.equal(initial, 15);
});

test('openFind / doFind: 词变化时从当前选区或光标锚点开始定位', () => {
  const fullText = 'first apple\nsecond banana\nthird apple\nfourth banana';
  const targetStart = fullText.indexOf('third apple') + 'third '.length;
  const targetEnd = targetStart + 'apple'.length;
  const editor = {
    value: fullText,
    selectionStart: targetStart,
    selectionEnd: targetEnd
  };
  const lastQuery = 'banana';
  const lastMatch = { start: fullText.indexOf('second banana') + 'second '.length, end: fullText.indexOf('second banana') + 'second banana'.length };
  let anchorStart = null;
  let anchorEnd = null;
  let preserveCurrent = false;

  const input = { value: '' };
  if (editor.selectionStart !== editor.selectionEnd) {
    input.value = editor.value.slice(editor.selectionStart, editor.selectionEnd); // "apple"
    anchorStart = editor.selectionStart;
    anchorEnd = editor.selectionEnd;
  }

  assert.equal(input.value, 'apple');
  assert.equal(anchorStart, targetStart);
  assert.equal(preserveCurrent, false);

  const term = input.value;
  const matches = [];
  let idx = 0;
  while ((idx = fullText.indexOf(term, idx)) !== -1) {
    matches.push({ start: idx, end: idx + term.length });
    idx += term.length;
  }
  assert.equal(matches.length, 2);

  let initial = 0;
  if (anchorStart != null) {
    initial = resolveCurrentMatchIndex(matches, anchorStart, anchorEnd);
  }

  // 精准命中第 2 处 apple (index 1)
  assert.equal(initial, 1);
});
