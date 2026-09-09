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
const all = () => load(['context-keys.js', 'when-clause.js', 'keybinding-parser.js', 'keybinding-service.js']);

test('非法 When 表达式在运行时安全置为 inactive，不阻断其他有效绑定', () => {
  const c = all();
  const svc = new c.BindingService({
    schemes: { T: [
      { commandId: 'broken', sequence: 'Ctrl+B', when: 'editorFocus &&' }, // 非法语法（parse 抛错）
      { commandId: 'good', sequence: 'Ctrl+Y', when: 'active' },
      { commandId: 'plain', sequence: 'Ctrl+P' }
    ] },
    scheme: 'T',
    commands: { good: () => 'good-called', plain: () => 'plain-called' }
  });

  // 非法 when 的绑定参与序列解析时不应抛错，且视为 inactive 不命中
  let threw = false;
  let brokenResult = null;
  try {
    brokenResult = svc.resolve('Ctrl+B');
  } catch (e) { threw = true; }
  assert.equal(threw, false, 'resolve 不应因非法 when 抛错');
  assert.equal(brokenResult.bindings.length, 0, '非法 when 绑定视为 inactive');

  // 同一 service 实例的其他有效绑定不受影响
  svc.context.set('active', true);
  const good = svc.resolve('Ctrl+Y');
  assert.equal(good.bindings.length, 1, '合法 when 绑定正常解析');
  assert.equal(good.bindings[0].commandId, 'good');
  assert.equal(svc.resolve('Ctrl+P').bindings[0].commandId, 'plain');

  // 全局按键分派端到端：按下非法 when 绑定的键不抛错，不执行命令，
  // 随后同一实例仍能正常匹配并执行有效键（其他有效键不失效）
  const calls = [];
  const svc2 = new c.BindingService({
    schemes: { T2: [
      { commandId: 'broken', sequence: 'Ctrl+B', when: '(a' },
      { commandId: 'ok', sequence: 'Ctrl+O' }
    ] },
    scheme: 'T2',
    commands: { ok: () => calls.push('ok') }
  });

  let dispatchThrew = false;
  let result = null;
  try {
    result = svc2.dispatch({ key: 'b', ctrlKey: true, preventDefault() {} });
  } catch (e) { dispatchThrew = true; }
  assert.equal(dispatchThrew, false, 'dispatch 不应因非法 when 抛错');
  assert.equal(result.status, 'unmatched');
  assert.deepEqual(calls, [], '非法 when 的绑定不应执行命令');

  const okResult = svc2.dispatch({ key: 'o', ctrlKey: true, preventDefault() {} });
  assert.equal(okResult.status, 'matched', '后续有效键仍可正常匹配');
  assert.equal(okResult.binding.commandId, 'ok');
  assert.deepEqual(calls, ['ok']);
});

test('validateWhen 校验 When 表达式合法性', () => {
  const c = all();
  const svc = new c.BindingService({ schemes: { T: [] }, scheme: 'T' });

  assert.equal(svc.validateWhen(''), true, '空表达式合法（不限定上下文）');
  assert.equal(svc.validateWhen('global'), true, 'global 合法');
  assert.equal(svc.validateWhen('editorTextFocus'), true);
  assert.equal(svc.validateWhen('a && b'), true);
  assert.equal(svc.validateWhen('mode == vim || inputFocus'), true);
  assert.equal(svc.validateWhen('!(a || b) && mode != insert'), true);
  assert.equal(svc.validateWhen('a &&'), false, '悬空 && 非法');
  assert.equal(svc.validateWhen('(a'), false, '括号未闭合非法');
  assert.equal(svc.validateWhen('a b'), false, '非法 token 序列非法');
});
