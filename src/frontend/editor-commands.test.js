const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');

function element(value = '') {
  const listeners = {};
  return {
    value, selectionStart: 0, selectionEnd: 0, selectionDirection: 'none', scrollTop: 0,
    attrs: {}, classList: { toggle() {} },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(e) { (listeners[e.type] || []).forEach(fn => fn(e)); return true; },
    setSelectionRange(s, e, d) { this.selectionStart=s; this.selectionEnd=e; this.selectionDirection=d||'none'; },
    setAttribute(k,v){this.attrs[k]=v;}, getAttribute(k){return this.attrs[k];}, focus(){this.focused=true;}
  };
}
function load(value) {
  const editor = element(value); const registry = {};
  const c = { console, Event: class { constructor(type){this.type=type;} }, getComputedStyle:()=>({lineHeight:'20'}), prompt:()=>null };
  c.window=c; c.globalThis=c;
  c.document={ getElementById:id=>id==='editor'?editor:null, addEventListener(){}, execCommand(){return true;} };
  c.Commands={register:(id,d)=>registry[id]=d,has:id=>!!registry[id],run:id=>registry[id].run()};
  vm.runInNewContext(fs.readFileSync('src/frontend/editor-commands.js','utf8'),c);
  return {c,editor,registry};
}
function run(h,id){return h.registry[id].run();}

test('editor commands register complete Eclipse edit command set',()=>{
  const h=load('a');
  ['undo','redo','cut','copy','paste','selectAll','deleteLines','deleteToLineEnd','moveLinesUp','moveLinesDown','copyLinesUp','copyLinesDown','insertLineBelow','insertLineAbove','outdent','scrollLineUp','scrollLineDown','previousHeading','nextHeading','goToLine','uppercase','lowercase','toggleComment','addBlockComment','removeBlockComment','toggleWrap'].forEach(name=>assert.ok(h.registry['editor.'+name],name));
});
test('delete line and undo redo roundtrip',()=>{const h=load('a\nb\nc');h.editor.setSelectionRange(2,2);run(h,'editor.deleteLines');assert.equal(h.editor.value,'a\nc');run(h,'editor.undo');assert.equal(h.editor.value,'a\nb\nc');run(h,'editor.redo');assert.equal(h.editor.value,'a\nc');});
test('move and copy selected lines',()=>{const h=load('a\nb\nc\n');h.editor.setSelectionRange(2,3);run(h,'editor.moveLinesUp');assert.equal(h.editor.value,'b\na\nc\n');run(h,'editor.copyLinesDown');assert.equal(h.editor.value,'b\nb\na\nc\n');});
test('uppercase lowercase and comments preserve selections',()=>{const h=load('Hello');h.editor.setSelectionRange(0,5);run(h,'editor.uppercase');assert.equal(h.editor.value,'HELLO');run(h,'editor.lowercase');assert.equal(h.editor.value,'hello');run(h,'editor.addBlockComment');assert.equal(h.editor.value,'<!-- hello -->');h.editor.setSelectionRange(0,h.editor.value.length);run(h,'editor.removeBlockComment');assert.equal(h.editor.value,'hello');});
test('scroll line keeps selection unchanged',()=>{const h=load('a\nb');h.editor.setSelectionRange(1,1);h.editor.scrollTop=40;run(h,'editor.scrollLineDown');assert.equal(h.editor.scrollTop,60);assert.equal(h.editor.selectionStart,1);run(h,'editor.scrollLineUp');assert.equal(h.editor.scrollTop,40);});
test('delete to line end, insert above/below and outdent',()=>{const h=load('    abc\ndef');h.editor.setSelectionRange(5,5);run(h,'editor.deleteToLineEnd');assert.equal(h.editor.value,'    a\ndef');h.editor.setSelectionRange(0,0);run(h,'editor.insertLineBelow');assert.equal(h.editor.value,'    a\n\ndef');run(h,'editor.insertLineAbove');assert.equal(h.editor.value,'    a\n\n\ndef');h.editor.setSelectionRange(0,5);run(h,'editor.outdent');assert.equal(h.editor.value,'a\n\n\ndef');});
test('go to line and toggle wrap',()=>{const h=load('a\nb\nc');h.c.EditorNavigation={scrollToLine:n=>{h.line=n;return true;}};h.registry['editor.goToLine'].run({line:3});assert.equal(h.line,2);run(h,'editor.toggleWrap');assert.equal(h.editor.getAttribute('wrap'),'off');run(h,'editor.toggleWrap');assert.equal(h.editor.getAttribute('wrap'),'soft');});
test('ordinary beforeinput/input changes enter application undo history',()=>{const h=load('a');h.editor.setSelectionRange(1,1);h.editor.dispatchEvent({type:'beforeinput'});h.editor.value='ab';h.editor.setSelectionRange(2,2);h.editor.dispatchEvent({type:'input'});run(h,'editor.undo');assert.equal(h.editor.value,'a');run(h,'editor.redo');assert.equal(h.editor.value,'ab');});
test('transact after programmatic load undoes to pre-edit text, not stale blank',()=>{
  // 复现：启动后文件经 tabs.js 程序化写入 editor.value（无 input 事件，
  // lastObserved 停留在空文档快照）；随后划词替换走 transact。修复前 Ctrl+Z
  // 会把这份过期空快照弹回，编辑器直接变空白。
  const h=load('');
  h.editor.value='Hello world';
  h.editor.setSelectionRange(6,11);
  h.c.EditorCommands.transact(el=>{el.value=el.value.slice(0,6)+'世界'+el.value.slice(11);el.setSelectionRange(8,8);});
  assert.equal(h.editor.value,'Hello 世界');
  run(h,'editor.undo');
  assert.equal(h.editor.value,'Hello world');
  run(h,'editor.redo');
  assert.equal(h.editor.value,'Hello 世界');
});
