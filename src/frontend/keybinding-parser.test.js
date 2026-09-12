const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function parser() {
  const c = { console };
  c.window = c;
  c.globalThis = c;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'keybinding-parser.js'), 'utf8'),
    c,
    { filename: 'keybinding-parser.js' }
  );
  return c.KeybindingParser;
}

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function generatedStrokes(seed, count) {
  const random = rng(seed);
  const keys = ['a', 'Z', '0', 'Enter', 'Escape', 'ArrowLeft', 'F1', 'f12', 'ß', 'Unidentified'];
  const aliases = [
    ['ctrl', 'control'],
    ['alt'],
    ['shift'],
    ['meta', 'cmd', 'command']
  ];
  const result = [];
  for (let i = 0; i < count; i += 1) {
    const parts = [];
    aliases.forEach(group => {
      if (random() < 0.55) parts.push(group[Math.floor(random() * group.length)]);
    });
    parts.push(keys[Math.floor(random() * keys.length)]);
    if (random() < 0.3) parts.reverse();
    if (random() < 0.2) parts.push(parts[parts.length - 1]);
    result.push(parts.join('+'));
  }
  return result;
}

function eventFor(canonical) {
  const parts = canonical.split('+');
  const key = parts.pop();
  return {
    ctrlKey: parts.includes('Ctrl'),
    altKey: parts.includes('Alt'),
    shiftKey: parts.includes('Shift'),
    metaKey: parts.includes('Meta'),
    key
  };
}

test('generated strokes are canonical and stroke is idempotent', () => {
  const p = parser();
  generatedStrokes(0x51f15e, 500).forEach(input => {
    const canonical = p.stroke(input);
    assert.equal(p.stroke(canonical), canonical, input);
    assert.match(canonical, /^(Ctrl\+|Alt\+|Shift\+|Meta\+)*(?:[A-Z0-9]|Space|[A-Za-z0-9]+|ArrowLeft|ß|Unidentified)$/);
  });
});

test('parse preserves generated chord boundaries and round-trips canonical strokes', () => {
  const p = parser();
  const strokes = generatedStrokes(0xc0ffee, 300);
  const sequence = strokes.map((stroke, index) => index % 4 === 0 ? `  ${stroke}  ` : stroke).join('   ');
  const parsed = p.parse(sequence);
  assert.equal(parsed.length, strokes.length);
  assert.deepEqual(p.parse(parsed.join(' ')), parsed);
  assert.deepEqual(p.parse(parsed), parsed);
});

test('format is a canonical sequence formatter on Windows and macOS', () => {
  const p = parser();
  generatedStrokes(0x12345678, 250).forEach(input => {
    const canonical = p.stroke(input);
    assert.equal(p.format(input), canonical);
    assert.equal(p.format(` ${input}  ${input} `), `${canonical} ${canonical}`);
    const mac = p.format(input, 'macOS');
    assert.equal(mac, canonical
      .replace(/Ctrl/g, '⌘')
      .replace(/Alt/g, '⌥')
      .replace(/Shift/g, '⇧')
      .replace(/Meta/g, '⌘'));
  });
});

test('matches agrees with generated event and equivalent modifier spellings', () => {
  const p = parser();
  generatedStrokes(0xdecafbad, 500).forEach(input => {
    const canonical = p.stroke(input);
    assert.equal(p.matches(eventFor(canonical), canonical), true, input);
    assert.equal(p.matches(eventFor(canonical), input), true, input);
    const opposite = { ...eventFor(canonical), ctrlKey: !eventFor(canonical).ctrlKey };
    assert.equal(p.matches(opposite, canonical), opposite.ctrlKey === eventFor(canonical).ctrlKey && canonical.startsWith('Ctrl+'), input);
  });
});

test('modifier aliases normalize case, order, and duplicates', () => {
  const p = parser();
  const aliases = ['CTRL', 'Control', 'alt', 'SHIFT', 'cmd', 'COMMAND', 'Meta'];
  aliases.forEach(modifier => {
    const expected = modifier.toLowerCase() === 'alt' ? 'Alt+K'
      : modifier.toLowerCase() === 'shift' ? 'Shift+K'
        : modifier.toLowerCase() === 'meta' || modifier.toLowerCase() === 'cmd' || modifier.toLowerCase() === 'command' ? 'Meta+K'
          : 'Ctrl+K';
    assert.equal(p.stroke(`${modifier}+k+${modifier}`), expected, modifier);
  });
  assert.equal(p.stroke('meta+ctrl+alt+shift+q'), 'Ctrl+Alt+Shift+Meta+Q');
  assert.equal(p.stroke('SHIFT+CTRL+q'), 'Ctrl+Shift+Q');
});

test('malformed and unusual inputs remain deterministic without throwing', () => {
  const p = parser();
  const inputs = ['', '   ', '+', '+++', 'ctrl++', ' + + ', 'NotAMod+q', 0, false, 42, Symbol('key'), ['ctrl+k', ''], { key: '' }, { code: 'F2' }];
  inputs.forEach(input => {
    assert.doesNotThrow(() => p.parse(input), String(input));
    assert.doesNotThrow(() => p.format(input), String(input));
  });
  assert.equal(p.stroke(''), 'Unidentified');
  assert.equal(p.stroke('+++'), 'Unidentified');
  assert.deepEqual(JSON.parse(JSON.stringify(p.parse('   '))), ['   ']);
  assert.deepEqual(JSON.parse(JSON.stringify(p.parse(['ctrl+k', '', 'f3']))), ['Ctrl+K', 'Unidentified', 'F3']);
  assert.equal(p.stroke({ key: '', code: 'F2' }), 'F2');
  assert.equal(p.stroke({ key: ' ', code: 'Space' }), 'Space');
});

test('IME Process/Unidentified 键回退 e.code 物理键位', () => {
  const p = parser();
  // 中文输入法接管 Alt+字母 时的标准形态：e.key='Process'
  assert.equal(p.stroke({ key: 'Process', code: 'KeyA', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }), 'Alt+A');
  assert.equal(p.stroke({ key: 'Process', code: 'KeyT', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false }), 'Alt+Shift+T');
  assert.equal(p.stroke({ key: 'Unidentified', code: 'KeyR', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }), 'Alt+R');
  assert.equal(p.stroke({ key: 'Process', code: 'Digit1', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }), 'Ctrl+1');
  // e.code 缺失时退回 'Unidentified'，不抛错
  assert.equal(p.stroke({ key: 'Process', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }), 'Alt+Process');
  // 正常 e.key 不受影响
  assert.equal(p.stroke({ key: 'a', code: 'KeyA', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }), 'Alt+A');
  // 无修饰键同样回退（编辑器内 IME 接管的普通输入不产生绑定匹配）
  assert.equal(p.stroke({ key: 'Process', code: 'KeyZ' }), 'Z');
});
