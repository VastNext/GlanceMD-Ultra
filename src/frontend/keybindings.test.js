const assert=require('node:assert/strict');const test=require('node:test');const vm=require('node:vm');const fs=require('node:fs');
function load(){const ls={};const c={window:{},document:{addEventListener(n,f){c.listener=f;}},localStorage:{getItem:k=>ls[k]||null,setItem:(k,v)=>{ls[k]=v;}},console};c.window=c;vm.runInNewContext(fs.readFileSync('src/frontend/keybindings.js','utf8'),c);return {c,ls};}
test('keybindings default map and persistence key',()=>{const h=load();assert.equal(h.c.Keybindings.effective()['file.open'],'Ctrl+O');assert.equal(h.c.Keybindings.defaults['quickopen.toggle'],'Ctrl+P');});
test('keybindings conflict blocks save',()=>{const h=load();assert.throws(()=>h.c.Keybindings.save({a:'Ctrl+X',b:'Ctrl+X'}),/冲突/);});
test('keybindings save/load roundtrip',()=>{const h=load();h.c.Keybindings.save({'file.open':'Alt+O'});assert.equal(JSON.parse(h.ls['glancemd-ultra-keybindings'])['file.open'],'Alt+O');assert.equal(h.c.Keybindings.effective()['file.open'],'Alt+O');});
test('key normalization',()=>{const h=load();assert.equal(h.c.Keybindings.normalize({ctrlKey:true,shiftKey:true,altKey:false,metaKey:false,key:'p'}),'Ctrl+Shift+P');});
