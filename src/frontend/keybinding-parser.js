(function (root) {
  'use strict';
  var MODS = { ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta', cmd: 'Meta', command: 'Meta' };
  function stroke(input) {
    if (typeof input === 'object') { var a = []; if (input.ctrlKey) a.push('Ctrl'); if (input.altKey) a.push('Alt'); if (input.shiftKey) a.push('Shift'); if (input.metaKey) a.push('Meta'); var k = input.key || input.code || ''; if (k === ' ') k = 'Space'; else if (k.length === 1 || /^f\d+$/i.test(k)) k = k.toUpperCase(); return a.concat(k).join('+'); }
    var parts = String(input || '').split('+'), mods = [], key = ''; parts.forEach(function (p) { var m = MODS[p.toLowerCase()]; if (m) { if (mods.indexOf(m) < 0) mods.push(m); } else key = p; });
    if (!key) key = 'Unidentified'; if (key === ' ') key = 'Space'; else if (key.length === 1 || /^f\d+$/i.test(key)) key = key.toUpperCase();
    return ['Ctrl', 'Alt', 'Shift', 'Meta'].filter(function (m) { return mods.indexOf(m) >= 0; }).concat(key).join('+');
  }
  function parse(input) { if (Array.isArray(input)) return input.map(stroke); if (typeof input === 'string' && input.trim() === '' && input.length) return [stroke(input)]; return String(input || '').trim().split(/\s+/).filter(Boolean).map(stroke); }
  function format(input, platform) { var result = parse(input).map(function (s) { if (platform === 'macOS') return s.replace(/Ctrl/g, '⌘').replace(/Alt/g, '⌥').replace(/Shift/g, '⇧').replace(/Meta/g, '⌘'); return s; }); return result.join(' '); }
  function matches(event, expected) { return stroke(event) === stroke(expected); }
  root.KeybindingParser = { stroke: stroke, parse: parse, format: format, matches: matches };
})(typeof window !== 'undefined' ? window : globalThis);
