/* Pure Vim state machine for textarea offsets. No DOM or runtime dependencies. */
(function(root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) { root.VimEngine = api.VimEngine; root.createVimEngine = api.createVimEngine; }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function() {
  'use strict';
  var MOTIONS = { h:1,j:1,k:1,l:1,w:1,W:1,b:1,B:1,e:1,E:1,'0':1,'^':1,'$':1,g:1,G:1,'{':1,'}':1,f:1,F:1,t:1,T:1,';':1,',':1,'%':1 };
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function linesOf(s) { return String(s).split('\n'); }
  function lineStart(s, p) { var a = String(s).lastIndexOf('\n', Math.max(0,p-1)); return a < 0 ? 0 : a + 1; }
  function lineEnd(s, p) { var a = String(s).indexOf('\n', p); return a < 0 ? String(s).length : a; }
  function wordChar(c) { return /[A-Za-z0-9_]/.test(c); }
  function makeRange(a,b) { return { start:Math.min(a,b), end:Math.max(a,b), anchor:a, head:b }; }

  function VimEngine(options) {
    options = options || {};
    this.text = options.textarea && options.textarea.value != null ? String(options.textarea.value) : String(options.text || '');
    this.cursor = clamp(Number(options.cursor) || 0, 0, this.text.length);
    this.mode = 'Normal'; this.selection = null; this.commandLine = ''; this.pending = ''; this.count = '';
    this.find = null; this.lastChange = null; this.lastSearch = null; this.composing = false; this.wrap = true;
    this.registers = { '"':'', '0':'', '+':'' }; for (var i=1;i<=9;i++) this.registers[String(i)]=''; for (var c=97;c<=122;c++) this.registers[String.fromCharCode(c)]='';
    this.marks = {}; this.undoStack=[]; this.redoStack=[];
    this.commandRunner = options.commandRunner || (options.Commands && typeof options.Commands.run === 'function' ? options.Commands.run.bind(options.Commands) : function() {});
    this.textarea = options.textarea || null; this._sync();
  }
  VimEngine.prototype._sync = function() { if (this.textarea) { this.textarea.value=this.text; if (this.textarea.setSelectionRange) this.textarea.setSelectionRange(this.cursor, this.mode.indexOf('Visual')===0 && this.selection ? this.selection.head : this.cursor); } };
  VimEngine.prototype._save = function() { this.undoStack.push({text:this.text,cursor:this.cursor}); if(this.undoStack.length>100)this.undoStack.shift(); this.redoStack=[]; };
  VimEngine.prototype._replace = function(a,b,value,record) { if(record!==false)this._save(); this.text=this.text.slice(0,a)+value+this.text.slice(b); this.cursor=clamp(a,0,this.text.length); this._sync(); };
  VimEngine.prototype.setText = function(s) { this._save(); this.text=String(s); this.cursor=clamp(this.cursor,0,this.text.length); this._sync(); };
  VimEngine.prototype.getState = function() { return { text:this.text,cursor:this.cursor,mode:this.mode,selection:this.selection,commandLine:this.commandLine,registers:this.registers,marks:this.marks,composing:this.composing }; };
  VimEngine.prototype.setComposing = function(v) { this.composing=!!v; };
  VimEngine.prototype.getRegister = function(name) { return this.registers[name || '"'] || ''; };
  VimEngine.prototype.setRegister = function(name, value) { name=name || '"'; if (name === '+') this.registers['+']=String(value); else if (this.registers[name] !== undefined) this.registers[name]=String(value); return this.getRegister(name); };
  VimEngine.prototype._search = function(query, direction) { query=String(query || ''); if (!query) return false; var pos=direction < 0 ? this.text.lastIndexOf(query, Math.max(0,this.cursor-1)) : this.text.indexOf(query, this.cursor+1); if (pos < 0 && this.wrap) pos=direction < 0 ? this.text.lastIndexOf(query) : this.text.indexOf(query); if (pos < 0) return false; this.cursor=pos; this.lastSearch={query:query,direction:direction}; this._sync(); return true; };
  VimEngine.prototype.undo = function() { if(!this.undoStack.length)return false; this.redoStack.push({text:this.text,cursor:this.cursor}); var x=this.undoStack.pop(); this.text=x.text;this.cursor=x.cursor;this._sync();return true; };
  VimEngine.prototype.redo = function() { if(!this.redoStack.length)return false; this.undoStack.push({text:this.text,cursor:this.cursor}); var x=this.redoStack.pop();this.text=x.text;this.cursor=x.cursor;this._sync();return true; };
  VimEngine.prototype._count = function() { var n=Number(this.count)||1;this.count='';return n; };
  VimEngine.prototype._lineCol = function(p) { var pre=this.text.slice(0,p), ls=pre.split('\n');return {line:ls.length-1,col:ls[ls.length-1].length}; };
  VimEngine.prototype._pos = function(line,col) { var a=linesOf(this.text); line=clamp(line,0,a.length-1); return a.slice(0,line).reduce(function(n,x){return n+x.length+1;},0)+clamp(col,0,a[line].length); };
  VimEngine.prototype.motion = function(k, n) {
    n=n||1; var p=this.cursor, lc=this._lineCol(p), i, target;
    if(k==='h')return clamp(p-n,0,this.text.length); if(k==='l')return clamp(p+n,0,this.text.length);
    if(k==='0')return this._pos(lc.line,0); if(k==='^'){target=(linesOf(this.text)[lc.line].match(/^\s*/) || [''])[0].length;return this._pos(lc.line,target);}
    if(k==='$')return lineEnd(this.text,p); if(k==='j'||k==='k')return this._pos(lc.line+(k==='j'?n:-n),lc.col);
    if(k==='G')return this._pos(n>1?n-1:linesOf(this.text).length-1,lc.col);
    if(k==='g')return this._pos(0,lc.col);
    if(k==='{'||k==='}') { var a=linesOf(this.text), d=k==='{'?-1:1, l=lc.line; for(i=0;i<n;i++){l=clamp(l+d,0,a.length-1);while(l>0&&l<a.length-1&&a[l].trim()!=='')l=clamp(l+d,0,a.length-1);} return this._pos(l,0); }
    if(k==='w'||k==='W'||k==='e'||k==='E'||k==='b'||k==='B') { var big=k===k.toUpperCase(), forward=k==='w'||k==='W'||k==='e'||k==='E'; for(i=0;i<n;i++){if(forward){while(p<this.text.length&&(big?/\s/.test(this.text[p]):!wordChar(this.text[p])))p++;while(p<this.text.length&&!/\s/.test(this.text[p]))p++; if(k==='e'||k==='E')p=Math.max(0,p-1);}else{p=clamp(p-1,0,this.text.length);while(p>0&&/\s/.test(this.text[p]))p--;while(p>0&&(big?/\S/.test(this.text[p-1]):wordChar(this.text[p-1])))p--;}} return clamp(p,0,this.text.length); }
    if(k==='%') { var pairs={'(':')','[':']','{':'}',')':'(',']':'[','}':'{'}; var ch=this.text[p], close=pairs[ch]; if(!close){for(i=p;i>=0;i--)if(pairs[this.text[i]]){ch=this.text[i];close=pairs[ch];p=i;break;}} if(close){var step='([{'.indexOf(ch)>=0?1:-1, depth=0;for(i=p;i>=0&&i<this.text.length;i+=step){if(this.text[i]===ch)depth++;if(this.text[i]===close)depth--;if(depth===0)return i;}} }
    if((k==='f'||k==='F'||k==='t'||k==='T')&&this.find){var q=this.find.ch, step=(k==='f'||k==='t')?1:-1, x=p;for(i=0;i<n;i++){x+=step;while(x>=0&&x<this.text.length&&this.text[x]!==q)x+=step;}return clamp(x-(k==='t'||k==='T'?step:0),0,this.text.length);}
    return p;
  };
  VimEngine.prototype._operator = function(op, motion, count) { var start=this.cursor, end=this.motion(motion,count), a=Math.min(start,end), b=Math.max(start,end); if(motion==='0')a=lineStart(this.text,start); if(motion==='$')b=lineEnd(this.text,start); if(end===start&&motion!=='$')return; if(op==='>'||op==='<'){var chunk=this.text.slice(a,b), indent=op==='>'?'  ':'', out=chunk.split('\n').map(function(x){return op==='>'?indent+x:x.replace(/^ {1,2}/,'');}).join('\n');this._replace(a,b,out);this.cursor=a;return;} var val=this.text.slice(a,b+(end>start?0:1)); if(op==='d'||op==='c')this.registers['"']=val; if(op==='y') {this.registers['"']=val;this.registers['0']=val;} if(op!=='y')this._replace(a,b+(end>start?0:1),''); else {this.cursor=a;this._sync();} if(op==='c'){this.mode='Insert';} this.lastChange={type:'operator',op:op,motion:motion,count:count}; };
  VimEngine.prototype._textObject = function(obj) { var p=this.cursor, a=this.text, pairs={'(':')','[':']','{':'}','"':'"',"'":"'",'`':'`'}, ch=obj.slice(-1); if(obj==='iw'||obj==='aw'){var s=p,e=p;while(s>0&&wordChar(a[s-1]))s--;while(e<a.length&&wordChar(a[e]))e++;if(obj==='aw')while(e<a.length&&/\s/.test(a[e]))e++;return {start:s,end:e};} if(obj==='ip'||obj==='ap'){var s2=lineStart(a,p),e2=lineEnd(a,p)+(obj==='ap'&&a[lineEnd(a,p)]==='\n'?1:0);return {start:s2,end:e2};} var close=pairs[ch], s3=p,e3=p;while(s3>=0&&a[s3]!==ch)s3--;while(e3<a.length&&a[e3]!==close)e3++;if(s3>=0&&e3<a.length)return {start:s3,end:e3+1};return null; };
  VimEngine.prototype._visualAction = function(k) { var r=makeRange(this.selection.anchor,this.cursor), a=r.start,b=r.end; if(this.mode==='VisualLine'){a=lineStart(this.text,a);b=Math.min(this.text.length,lineEnd(this.text,b)+1);} if(k==='d'||k==='x'||k==='c'||k==='y'){var v=this.text.slice(a,b);this.registers['"']=v;if(k==='y'){this.cursor=a;}else{this._replace(a,b,'');if(k==='c')this.mode='Insert';} if(k==='d'||k==='x')this.lastChange={type:'visual',op:'d',value:v}; if(k==='y')this.lastChange={type:'visual',op:'y',value:v};if(this.mode!=='Insert')this.mode='Normal';this.selection=null;return true;} if(k==='>'||k==='<'){this._operator(k,'$',1);this.mode='Normal';this.selection=null;return true;} return false; };
  VimEngine.prototype.ex = function(cmd) { var raw=String(cmd).replace(/^:/,'').trim(), bang=/!$/.test(raw), name=raw.replace(/!$/,'').split(/\s+/)[0], args=raw.slice(name.length).trim(); if(name==='set'){this.wrap=args!=='nowrap';} this.commandRunner(name,{command:raw,args:args,bang:bang,engine:this}); return raw; };
  VimEngine.prototype.handleKey = function(key, event) {
    if(this.composing || (event&&event.isComposing) || key==='Process')return {handled:false,composing:true};
    key=String(key); var n, p;
    if(this.mode==='CommandLine'){if(key==='Escape'){this.mode='Normal';this.commandLine='';}else if(key==='Enter'){var c=this.commandLine;this.ex(c);this.mode='Normal';this.commandLine='';}else if(key==='Backspace')this.commandLine=this.commandLine.slice(0,-1);else if(key.length===1)this.commandLine+=key;return {handled:true};}
    if(this.mode==='Insert'){if(key==='Escape'){this.mode='Normal';this.cursor=clamp(this.cursor-1,0,this.text.length);this._sync();return {handled:true};} if(key.length===1||key==='Enter'||key==='Tab'){this._replace(this.cursor,this.cursor,key==='Enter'?'\n':key);this.cursor++;this._sync();return {handled:true};} return {handled:false};}
    if(this.mode.indexOf('Visual')===0){if(key==='Escape'){this.mode='Normal';this.selection=null;return {handled:true};}if(MOTIONS[key]){this.cursor=this.motion(key,this._count());this._sync();return {handled:true};}if(this._visualAction(key))return {handled:true};}
    if(/^\d$/.test(key)&&(key!=='0'||this.count)){this.count+=key;return {handled:true};}
    if(key==='i'){this.mode='Insert';return {handled:true};} if(key==='v'){this.mode='Visual';this.selection={anchor:this.cursor,head:this.cursor};return {handled:true};} if(key==='V'){this.mode='VisualLine';this.selection={anchor:this.cursor,head:this.cursor};return {handled:true};} if(key===':'){this.mode='CommandLine';this.commandLine=':';return {handled:true};}
    if(key==='u'){return {handled:this.undo()};} if(key==='R'&&event&&event.ctrlKey)return {handled:this.redo()}; if(key==='.'&&this.lastChange){return {handled:this._repeatChange()};}
    if(key==='J'){var e=lineEnd(this.text,this.cursor);if(this.text[e]==='\n'){this._replace(e,e+1,' ');this.cursor=e;};return {handled:true};} if(key==='~'){var ch=this.text[this.cursor];if(ch){this._replace(this.cursor,this.cursor+1,ch===ch.toUpperCase()?ch.toLowerCase():ch.toUpperCase());this.cursor++;}return {handled:true};}
    if(key==='m'){this.pending='mark';return {handled:true};} if(key==="'"||key==='`'){this.pending=key;return {handled:true};}
    if(this.pending==='mark'){if(/^[a-z]$/.test(key))this.marks[key]=this.cursor;this.pending='';return {handled:true};} if((this.pending==="'"||this.pending==='`')&&/^[a-z]$/.test(key)){this.cursor=clamp(this.marks[key]||0,0,this.text.length);this.pending='';this._sync();return {handled:true};}
    if(key==='/'||key==='?'){this.lastSearch={direction:key==='/'?1:-1,query:''};this.mode='CommandLine';this.commandLine=key;return {handled:true};} if((key==='n'||key==='N')&&this.lastSearch)return {handled:true}; if(key==='*'||key==='#'){this.lastSearch={direction:key==='*'?1:-1,query:this.text.slice(this.cursor).match(/^\w+/)?.[0]||''};return {handled:true};}
    if(this.pending==='mark'){if(/^[a-z]$/.test(key))this.marks[key]=this.cursor;this.pending='';return {handled:true};}
    if((this.pending==="'"||this.pending==='`')&&/^[a-z]$/.test(key)){this.cursor=clamp(this.marks[key]||0,0,this.text.length);this.pending='';this._sync();return {handled:true};}
    if(this.pending==='f'||this.pending==='F'||this.pending==='t'||this.pending==='T') { this.find={ch:key}; var fk=this.pending; this.pending=''; this.cursor=this.motion(fk,1); this._sync(); return {handled:true}; }
    if((this.pending==='d'||this.pending==='y'||this.pending==='c')&&(key===this.pending)){var dop=this.pending;this.pending='';var ls=lineStart(this.text,this.cursor), le=lineEnd(this.text,this.cursor);if(dop==='y'){this.registers['"']=this.text.slice(ls,le+1);this.registers['0']=this.registers['"'];this.cursor=ls;this._sync();}else{this._replace(ls,Math.min(this.text.length,le+1),'');if(dop==='c')this.mode='Insert';}this.lastChange={type:'operator',op:dop,motion:'$ ',count:1};return {handled:true};}
    if((this.pending==='c'||this.pending==='d'||this.pending==='y')&&(key==='i'||key==='a')){this.pending=this.pending+key;return {handled:true};}
    if((/^([dcy<>])$/.test(this.pending))&&MOTIONS[key]){var op=this.pending;this.pending='';this._operator(op,key,this._count());return {handled:true};}
    if((/^([dcy<>])$/.test(this.pending))&&key==='f'||key==='F'||key==='t'||key==='T'){return {handled:true};}
    if((this.pending==='ci'||this.pending==='ca'||this.pending==='di'||this.pending==='da'||this.pending==='yi'||this.pending==='ya') && key.length===1){var object=this._textObject(this.pending.slice(1)+key), objectOp=this.pending.charAt(0);this.pending='';if(object){var ov=this.text.slice(object.start,object.end);this.registers['"']=ov;if(objectOp==='y'){this.registers['0']=ov;this.cursor=object.start;this._sync();}else{this._replace(object.start,object.end,'');if(objectOp==='c')this.mode='Insert';}this.lastChange={type:'operator',op:objectOp,motion:'iw',count:1};return {handled:true};}}
    if(key==='d'||key==='y'||key==='c'||key==='>'||key==='<'){this.pending=key;return {handled:true};}
    if(key==='f'||key==='F'||key==='t'||key==='T'){this.pending=key;return {handled:true};}
    if(MOTIONS[key]){this.cursor=this.motion(key,this._count());this._sync();return {handled:true};}
    return {handled:false};
  };
  VimEngine.prototype._repeatChange=function(){if(!this.lastChange)return false;var x=this.lastChange;if(x.type==='operator'){this.cursor=this.motion(x.motion,x.count);this._operator(x.op,x.motion,x.count);return true;}return false;};
  VimEngine.prototype.feed = function(keys) { var self=this; Array.prototype.forEach.call(keys,function(k){self.handleKey(k);}); return this; };
  return { VimEngine:VimEngine, createVimEngine:function(options){return new VimEngine(options);} };
});
