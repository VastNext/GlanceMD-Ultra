(function (root) {
  'use strict';

  var undoStack = [];
  var redoStack = [];
  var applyingHistory = false;
  var composing = false;
  var lastObserved = null;

  function editor() { return document.getElementById('editor'); }
  function snapshot(el) {
    return { value: el.value, start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection || 'none', scrollTop: el.scrollTop };
  }
  function same(a, b) { return a && b && a.value === b.value && a.start === b.start && a.end === b.end; }
  function restore(el, state) {
    applyingHistory = true;
    el.value = state.value;
    el.setSelectionRange(state.start, state.end, state.direction);
    el.scrollTop = state.scrollTop || 0;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    applyingHistory = false;
    lastObserved = snapshot(el);
    el.focus();
  }
  function transact(mutator) {
    var el = editor();
    if (!el || composing) return false;
    var before = snapshot(el);
    mutator(el);
    var after = snapshot(el);
    if (same(before, after)) return false;
    undoStack.push(before);
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
    el.dispatchEvent(new Event('input', { bubbles: true }));
    lastObserved = snapshot(el);
    el.focus();
    return true;
  }
  function undo() {
    var el = editor(); if (!el || !undoStack.length) return false;
    var current = snapshot(el), previous = undoStack.pop(); redoStack.push(current); restore(el, previous); return true;
  }
  function redo() {
    var el = editor(); if (!el || !redoStack.length) return false;
    var current = snapshot(el), next = redoStack.pop(); undoStack.push(current); restore(el, next); return true;
  }
  function lineStart(text, pos) { var at = text.lastIndexOf('\n', Math.max(0, pos - 1)); return at < 0 ? 0 : at + 1; }
  function lineEnd(text, pos) { var at = text.indexOf('\n', pos); return at < 0 ? text.length : at; }
  function selectedLineRange(el) {
    var start = lineStart(el.value, el.selectionStart);
    var endPos = el.selectionEnd > el.selectionStart && el.value[el.selectionEnd - 1] === '\n' ? el.selectionEnd - 1 : el.selectionEnd;
    var end = lineEnd(el.value, endPos);
    if (end < el.value.length) end += 1;
    return { start: start, end: end };
  }
  function replace(el, start, end, value, selectStart, selectEnd) {
    el.value = el.value.slice(0, start) + value + el.value.slice(end);
    el.setSelectionRange(selectStart == null ? start + value.length : selectStart, selectEnd == null ? start + value.length : selectEnd);
  }
  function deleteLines() { return transact(function(el) { var r=selectedLineRange(el); replace(el,r.start,r.end,'',r.start,r.start); }); }
  function deleteToLineEnd() { return transact(function(el) { var end=lineEnd(el.value,el.selectionEnd); replace(el,el.selectionStart,end,'',el.selectionStart,el.selectionStart); }); }
  function moveLines(direction) { return transact(function(el) {
    var r=selectedLineRange(el), block=el.value.slice(r.start,r.end);
    if (direction < 0) {
      if (r.start === 0) return;
      var prevStart=lineStart(el.value,r.start-1), prev=el.value.slice(prevStart,r.start);
      replace(el,prevStart,r.end,block+prev,prevStart,prevStart+block.length);
    } else {
      if (r.end >= el.value.length) return;
      var nextEnd=lineEnd(el.value,r.end); if(nextEnd<el.value.length) nextEnd++;
      var next=el.value.slice(r.end,nextEnd);
      replace(el,r.start,nextEnd,next+block,r.start+next.length,r.start+next.length+block.length);
    }
  }); }
  function copyLines(direction) { return transact(function(el) {
    var r=selectedLineRange(el), block=el.value.slice(r.start,r.end);
    if (direction < 0) replace(el,r.start,r.start,block,r.start,r.start+block.length);
    else replace(el,r.end,r.end,block,r.end,r.end+block.length);
  }); }
  function insertLine(direction) { return transact(function(el) {
    var pos = direction < 0 ? lineStart(el.value,el.selectionStart) : lineEnd(el.value,el.selectionEnd);
    var insertion = direction < 0 ? '\n' : '\n';
    if (direction > 0) { replace(el,pos,pos,insertion,pos+1,pos+1); }
    else { replace(el,pos,pos,insertion,pos,pos); }
  }); }
  function outdent() { return transact(function(el) {
    var r=selectedLineRange(el), block=el.value.slice(r.start,r.end), removed=0;
    var next=block.replace(/^(?:\t| {1,4})/gm,function(m){removed+=m.length;return '';});
    replace(el,r.start,r.end,next,r.start,Math.max(r.start,r.end-removed));
  }); }
  function scrollLine(direction) { var el=editor(); if(!el)return false; var lh=parseFloat(getComputedStyle(el).lineHeight)||20; el.scrollTop=Math.max(0,el.scrollTop+direction*lh); return true; }
  function heading(direction) {
    var el=editor(), nav=root.EditorNavigation; if(!el||!nav||!nav.getHeadingDescriptors)return false;
    var rows=nav.getHeadingDescriptors(), line=el.value.slice(0,el.selectionStart).split('\n').length-1, chosen=null;
    if(direction<0){for(var i=rows.length-1;i>=0;i--){if(rows[i].line<line){chosen=rows[i];break;}}}
    else {for(var j=0;j<rows.length;j++){if(rows[j].line>line){chosen=rows[j];break;}}}
    return chosen ? nav.scrollToLine(chosen.line) : false;
  }
  function goToLine(arg) {
    if (arg && arg.line != null) {
      var nav = root.EditorNavigation;
      var n = Number(arg.line);
      return nav && isFinite(n) && n > 0 ? nav.scrollToLine(n - 1) : false;
    }
    return typeof root.openGotoLine === 'function' ? root.openGotoLine() : false;
  }
  function transform(fn) { return transact(function(el){if(el.selectionStart===el.selectionEnd)return;var s=el.selectionStart,e=el.selectionEnd,v=fn(el.value.slice(s,e));replace(el,s,e,v,s,s+v.length);}); }
  function addComment() { return transact(function(el){var s=el.selectionStart,e=el.selectionEnd,v=el.value.slice(s,e);replace(el,s,e,'<!-- '+v+' -->',s,s+v.length+9);}); }
  function removeComment() { return transact(function(el){var s=el.selectionStart,e=el.selectionEnd,v=el.value.slice(s,e),m=v.match(/^\s*<!--\s?([\s\S]*?)\s?-->\s*$/);if(!m)return;replace(el,s,e,m[1],s,s+m[1].length);}); }
  function toggleComment() { var el=editor(); if(!el)return false; var v=el.value.slice(el.selectionStart,el.selectionEnd); return /^\s*<!--[\s\S]*-->\s*$/.test(v) ? removeComment() : addComment(); }
  function toggleWrap() {
    if (typeof root.toggleEditorWrap === 'function') {
      root.toggleEditorWrap();
      return true;
    }
    if (root.SettingsApply && typeof root.SettingsApply.patch === 'function') {
      var cur = root.SettingsApply.get();
      var next = !(cur && cur.editor && cur.editor.wordWrap);
      root.SettingsApply.patch({ editor: { wordWrap: next } });
      return true;
    }
    var el = editor();
    if (!el) return false;
    var off = el.getAttribute('wrap') === 'off';
    el.setAttribute('wrap', off ? 'soft' : 'off');
    el.classList.toggle('wrap-off', !off);
    return true;
  }
  function nativeEdit(command) { var el=editor(); if(!el)return false; el.focus(); try{return document.execCommand(command);}catch(e){return false;} }
  function selectAll() { var el=editor(); if(!el)return false; el.focus(); el.setSelectionRange(0,el.value.length); return true; }

  function registerCommands() {
    if (!root.Commands || typeof root.Commands.register !== 'function') return false;
    function reg(id,label,run){if(!root.Commands.has(id))root.Commands.register(id,{label:label,category:'Edit',run:run});}
    reg('editor.undo','撤销',undo); reg('editor.redo','重做',redo);
    reg('editor.cut','剪切',function(){return nativeEdit('cut');}); reg('editor.copy','复制',function(){return nativeEdit('copy');}); reg('editor.paste','粘贴',function(){return nativeEdit('paste');}); reg('editor.selectAll','全选',selectAll);
    reg('editor.deleteLines','删除行',deleteLines); reg('editor.deleteToLineEnd','删除到行尾',deleteToLineEnd);
    reg('editor.moveLinesUp','上移行',function(){return moveLines(-1);}); reg('editor.moveLinesDown','下移行',function(){return moveLines(1);});
    reg('editor.copyLinesUp','向上复制行',function(){return copyLines(-1);}); reg('editor.copyLinesDown','向下复制行',function(){return copyLines(1);});
    reg('editor.insertLineBelow','在下方插入行',function(){return insertLine(1);}); reg('editor.insertLineAbove','在上方插入行',function(){return insertLine(-1);}); reg('editor.outdent','减少缩进',outdent);
    reg('editor.scrollLineUp','视口上滚一行',function(){return scrollLine(-1);}); reg('editor.scrollLineDown','视口下滚一行',function(){return scrollLine(1);});
    reg('editor.previousHeading','上一个 Markdown 标题',function(){return heading(-1);}); reg('editor.nextHeading','下一个 Markdown 标题',function(){return heading(1);}); reg('editor.goToLine','转到行',goToLine);
    reg('editor.uppercase','转换为大写',function(){return transform(function(v){return v.toUpperCase();});}); reg('editor.lowercase','转换为小写',function(){return transform(function(v){return v.toLowerCase();});});
    reg('editor.toggleComment','切换 HTML 注释',toggleComment); reg('editor.addBlockComment','添加 HTML 块注释',addComment); reg('editor.removeBlockComment','移除 HTML 块注释',removeComment); reg('editor.toggleWrap','切换自动换行',toggleWrap);
    reg('actions.find.incrementalNext','增量查找（向前）',function(){return typeof root.incrementalFind==='function'&&root.incrementalFind(1);});
    reg('actions.find.incrementalPrevious','增量查找（向后）',function(){return typeof root.incrementalFind==='function'&&root.incrementalFind(-1);});
    return true;
  }
  var el=editor(); if(el){
    lastObserved=snapshot(el);
    el.addEventListener('compositionstart',function(){composing=true;});
    el.addEventListener('compositionend',function(){composing=false;lastObserved=snapshot(el);});
    el.addEventListener('beforeinput',function(){ if(!applyingHistory&&!composing) lastObserved=snapshot(el); });
    el.addEventListener('input',function(){
      if(!applyingHistory&&!composing&&lastObserved&&!same(lastObserved,snapshot(el))){undoStack.push(lastObserved);if(undoStack.length>200)undoStack.shift();redoStack=[];}
      lastObserved=snapshot(el);
    });
  }
  registerCommands();
  if(typeof document!=='undefined')document.addEventListener('DOMContentLoaded',registerCommands);
  root.EditorCommands={registerCommands:registerCommands,undo:undo,redo:redo,transact:transact,getHistory:function(){return {undo:undoStack.length,redo:redoStack.length};},resetHistory:function(){undoStack=[];redoStack=[];}};
})(typeof window!=='undefined'?window:globalThis);
