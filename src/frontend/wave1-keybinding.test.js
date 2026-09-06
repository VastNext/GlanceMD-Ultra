const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function load(files) {
  const c = { console, setTimeout, clearTimeout };
  c.window = c; c.globalThis = c;
  files.forEach(f => vm.runInNewContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), c, { filename: f }));
  return c;
}
const context = () => load(['context-keys.js']);
const parser = () => load(['keybinding-parser.js']);
const all = () => load(['context-keys.js', 'when-clause.js', 'keybinding-parser.js', 'default-keybindings.js', 'keybinding-service.js']);

test('ContextKeyService parent, child, values and snapshots', () => {
  const c = context(); const root = new c.ContextKeyService(); const child = root.createChild();
  assert.equal(root.get('missing'), undefined); assert.equal(child.get('missing'), undefined);
  root.set('workspaceOpen', true); assert.equal(child.get('workspaceOpen'), true);
  child.set('editorFocus', true); assert.equal(root.get('editorFocus'), undefined); assert.equal(child.get('editorFocus'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(root.snapshot())), { workspaceOpen: true }); assert.deepEqual(JSON.parse(JSON.stringify(child.snapshot())), { workspaceOpen: true, editorFocus: true });
  child.setMany({ inputFocus: false, panelVisible: 'outline' }); const snap = child.snapshot();
  assert.equal(snap.inputFocus, false); assert.equal(snap.panelVisible, 'outline'); assert.equal(child.get('panelVisible'), 'outline');
  child.remove('panelVisible'); assert.equal(child.get('panelVisible'), undefined); assert.equal(child.snapshot().workspaceOpen, true);
});
test('ContextKeyService subscriptions and unsubscribe', () => {
  const c = context(), s = new c.ContextKeyService(), events = [], allEvents = [];
  const off = s.subscribe('mode', (v, old, key) => events.push([v, old, key])); s.subscribe('*', (v, old, key) => allEvents.push([v, old, key]));
  s.set('mode', 'vim'); s.set('mode', 'vim'); s.set('mode', 'insert'); off(); s.set('mode', 'normal');
  assert.deepEqual(events, [['vim', undefined, 'mode'], ['insert', 'vim', 'mode']]); assert.equal(allEvents.length, 3); assert.equal(allEvents[2][0], 'normal');
});
test('when parser precedence, operators, parentheses and truthy keys', () => {
  const c = context(), s = new c.ContextKeyService(); s.setMany({ a: true, b: false, n: 2, mode: 'vim' }); const W = load(['context-keys.js', 'when-clause.js']);
  const cases = [['a', true], ['!b', true], ['a && !b', true], ['b || a', true], ['a && b || a', true], ['b || a && b', false], ['(a && b) || a', true], ['n == 2', true], ['n != 3', true], ['mode == vim', true], ['mode != insert', true]];
  cases.forEach(([source, expected]) => assert.equal(new W.WhenClause(source).evaluate(s), expected, source));
  assert.equal(new W.WhenClause('').evaluate(s), true); assert.throws(() => new W.WhenClause('a &&'), /Expected/); assert.throws(() => new W.WhenClause('(a'), /Expected/);
});
test('key parser strokes, chords, event keys and formatting', () => {
  const p = parser(), cases = [['ctrl+shift+s', 'Ctrl+Shift+S'], ['ALT+o', 'Alt+O'], ['Meta+Shift+P', 'Shift+Meta+P'], [' ', 'Space'], ['f12', 'F12'], ['Ctrl+K Ctrl+O', 'Ctrl+K Ctrl+O']];
  cases.forEach(([input, expected]) => assert.equal(p.KeybindingParser.format(input), expected));
  assert.deepEqual(JSON.parse(JSON.stringify(p.KeybindingParser.parse('Ctrl+K Ctrl+O'))), ['Ctrl+K', 'Ctrl+O']);
  assert.equal(p.KeybindingParser.stroke({ ctrlKey: true, shiftKey: true, key: 's' }), 'Ctrl+Shift+S');
  assert.equal(p.KeybindingParser.stroke({ altKey: true, key: ' ' }), 'Alt+Space');
  assert.equal(p.KeybindingParser.stroke({ metaKey: true, code: 'F6' }), 'Meta+F6');
  assert.equal(p.KeybindingParser.format('Ctrl+Alt+Shift+P', 'macOS'), '⌘+⌥+⇧+P');
  assert.equal(p.KeybindingParser.matches({ ctrlKey: true, key: 'o' }, 'Ctrl+O'), true);
  assert.equal(p.KeybindingParser.matches({ ctrlKey: false, key: 'o' }, 'Ctrl+O'), false);
});
test('default schemes expose confirmed core bindings', () => {
  const c = all(), D = c.DefaultKeybindings;
  assert.equal(D.defaultScheme, 'ultra.eclipse'); assert.ok(D.schemes['ultra.eclipse']); assert.ok(D.schemes['ultra.vscode']);
  const e = Object.fromEntries(D.schemes['ultra.eclipse'].map(x => [x.commandId, x.sequence]));
  [['outline.quickOpen','Ctrl+O'],['file.saveAll','Ctrl+Shift+S'],['file.saveAs','Alt+Shift+S'],['file.open','Alt+Shift+F O'],['workspace.open','Alt+Shift+F P'],['settings.toggle','Alt+Shift+P'],['settings.keybindings','Alt+Shift+P K'],['editor.vim.toggle','Alt+Shift+E V'],['palette.toggle','Ctrl+3'],['search.toggle','Ctrl+H'],['tabs.quickSwitch','Ctrl+E'],['editor.focus','F12']].forEach(([id,key]) => assert.equal(e[id], key, id));
  D.schemes['ultra.eclipse'].forEach(binding => assert.deepEqual(Object.keys(binding).sort(), ['commandId','platform','removed','sequence','source','when']));
});
test('BindingService contexts, platforms and exact versus partial matching', () => {
  const c = all(), s = new c.ContextKeyService(); s.setMany({ editorTextFocus: true, settingsContext: false });
  const svc = new c.BindingService({ schemes: { Test: [{ commandId: 'one', sequence: 'Ctrl+K Ctrl+O', when: 'editorTextFocus' }, { commandId: 'two', sequence: 'Alt+X', when: 'settingsContext', platform: 'macOS' }] }, scheme: 'Test', context: s, platform: 'Windows' });
  assert.equal(svc.resolve('Ctrl+K').partial, true); assert.equal(svc.resolve('Ctrl+K').bindings.length, 0);
  assert.equal(svc.resolve('Ctrl+K Ctrl+O').bindings[0].commandId, 'one'); assert.equal(svc.resolve('Alt+X').bindings.length, 0);
  s.set('settingsContext', true); svc.platform = 'macOS'; assert.equal(svc.resolve('Alt+X').bindings[0].commandId, 'two');
  s.set('editorTextFocus', false); assert.equal(svc.resolve('Ctrl+K Ctrl+O').bindings.length, 0); assert.equal(svc.resolve('Ctrl+K Ctrl+O').partial, false);
});
test('BindingService chord pending, timeout and Escape', async () => {
  const c = all(), svc = new c.BindingService({ schemes: { T: [{ commandId:'chord', sequence:'Ctrl+K Ctrl+O' }] }, scheme:'T', timeout:15 });
  let r = svc.handleKey({ ctrlKey:true, key:'k' }); assert.equal(r.status, 'pending'); assert.deepEqual(JSON.parse(JSON.stringify(r.sequence)), ['Ctrl+K']);
  r = svc.handleKey({ ctrlKey:false, key:'Escape' }); assert.equal(r.status, 'cancelled');
  r = svc.handleKey({ ctrlKey:true, key:'k' }); assert.equal(r.status, 'pending'); await new Promise(resolve => setTimeout(resolve, 25));
  r = svc.handleKey({ ctrlKey:false, key:'o' }); assert.equal(r.status, 'unmatched');
  r = svc.handleKey({ ctrlKey:true, key:'k' }); r = svc.handleKey({ ctrlKey:true, key:'o' }); assert.equal(r.status, 'matched'); assert.equal(r.binding.commandId, 'chord');
});
test('BindingService overrides, explicit unbinds, multiple bindings and schemes', () => {
  const c = all(), svc = new c.BindingService({ schemes: { A:[{commandId:'a',sequence:'Ctrl+A'},{commandId:'shared',sequence:'Ctrl+S'}], B:[{commandId:'b',sequence:'Ctrl+B'}] }, scheme:'A' });
  assert.equal(svc.getBindings().length, 2); svc.bind('a','Alt+A'); assert.deepEqual(svc.getBindings().filter(x => x.commandId==='a').map(x => x.sequence), ['Alt+A']);
  svc.bind('a','Ctrl+Alt+A'); assert.equal(svc.getBindings().filter(x => x.commandId==='a').length, 2); svc.unbind('shared'); assert.equal(svc.resolve('Ctrl+S').bindings.length, 0);
  assert.equal(svc.setScheme('B'), 'B'); assert.equal(svc.getScheme(), 'B'); assert.equal(svc.resolve('Ctrl+B').bindings[0].commandId, 'b'); assert.throws(() => svc.setScheme('Nope'), /Unknown/);
});
test('BindingService conflict scan and dispatch', () => {
  const c = all(), calls = [], svc = new c.BindingService({ schemes: { T:[{commandId:'one',sequence:'Ctrl+X'},{commandId:'two',sequence:'Ctrl+X'},{commandId:'three',sequence:'Ctrl+Y',when:'active'}] }, scheme:'T', commands:{one:()=>calls.push('one')} });
  assert.equal(svc.scanConflicts().length, 1); assert.deepEqual(JSON.parse(JSON.stringify(svc.scanConflicts()[0].commands)), ['one','two']);
  const ev = { ctrlKey:true, key:'x', preventDefault:()=>calls.push('prevent') }; const r = svc.dispatch(ev); assert.equal(r.status,'matched'); assert.deepEqual(calls,['prevent','one']);
  svc.context.set('active', true); assert.equal(svc.resolve('Ctrl+Y').bindings[0].commandId,'three');
});
