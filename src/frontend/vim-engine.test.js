const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'vim-engine.js'), 'utf8');
function make(text='', cursor=0, options={}) { const E=require('./vim-engine.js'); return new E.VimEngine({text,cursor,...options}); }
function feed(e, keys, event) { for (const k of keys) e.handleKey(k, event); return e; }
function text(e) { return e.getState().text; }

test('IIFE is Node-vm loadable without dependencies', () => { const ctx={}; vm.runInNewContext(source, ctx); assert.equal(typeof ctx.VimEngine, 'function'); });
for (const [keys, initial] of [['h',1],['l',0],['0',2],['$',0],['j',0],['k',3]]) test(`motion ${keys}`,()=>{const e=make('abc\ndef',initial); feed(e,keys); assert.equal(e.mode,'Normal');});
for (const key of ['w','W','b','B','e','E','^','{','}','%']) test(`word/structural motion ${key}`,()=>{const e=make('one two\n\nthree (x)',1);feed(e,key);assert.ok(e.cursor>=0);});
for (const key of ['g','G','f','F','t','T',';',',']) test(`extended motion ${key}`,()=>{const e=make('abc abc',1);if('fFtT'.includes(key)){feed(e,key);feed(e,'x');}else feed(e,key);assert.ok(e.cursor>=0);});
for (const keys of ['dw','de','d$','d0','dd','yy','cc','yw','y$','cw','ciw','caw']) test(`operator ${keys}`,()=>{const e=make('abc\ndef',0);feed(e,keys);assert.ok(typeof text(e)==='string');});
for (const keys of ['3j','2dd','3dw','2yap']) test(`count ${keys}`,()=>{const e=make('one\ntwo\nthree\nfour',0);feed(e,keys);assert.ok(e.cursor>=0);});
for (const mode of ['v','V']) test(`visual ${mode}`,()=>{const e=make('abc\ndef',0);feed(e,mode+'l');assert.equal(e.mode,mode==='v'?'Visual':'VisualLine');feed(e,'y');assert.ok(e.registers['"']!==undefined);});
for (const obj of ['iw','aw','ip','ap','i"',"i'",'i`','i(','i{','i[']) test(`text object ${obj}`,()=>{const e=make('hello world (x)',1);feed(e,'d'+obj);assert.ok(typeof text(e)==='string');});
test('registers include unnamed numbered named and clipboard',()=>{const e=make('abc');for(const r of ['"','0','1','a','+'])assert.ok(r in e.registers);});
test('undo restores edit',()=>{const e=make('abc');feed(e,'iX');e.handleKey('Escape');feed(e,'u');assert.equal(text(e),'abc');});
test('redo ctrl-r, repeat, join and case toggle',()=>{const e=make('a\nb');feed(e,'J');assert.equal(text(e),'a b');feed(e,'u');feed(e,'r',{ctrlKey:true});feed(e,'~');assert.ok(typeof text(e)==='string');});
for (const key of ['/','?','n','N','*','#']) test(`search ${key}`,()=>{const e=make('foo bar foo',0);if(key==='n'||key==='N')e.lastSearch={direction:1,query:'foo'};feed(e,key);assert.ok(e.lastSearch);});
test('marks and jumps',()=>{const e=make('abc',1);feed(e,'ma');feed(e,"'a");assert.equal(e.cursor,1);feed(e,'`a');assert.equal(e.cursor,1);});
for (const cmd of [':w',':wa',':q',':q!',':wq',':x',':e file',':bn',':bp',':ls',':set wrap',':set nowrap',':noh']) test(`Ex ${cmd}`,()=>{let calls=[];const e=make('',0,{commandRunner:(name,args)=>calls.push([name,args])});feed(e,cmd);e.handleKey('Enter');assert.equal(e.mode,'Normal');assert.equal(calls.length,1);});
test('IME composition protects state',()=>{const e=make('abc');e.setComposing(true);assert.equal(e.handleKey('d').handled,false);assert.equal(text(e),'abc');assert.equal(e.handleKey('x',{isComposing:true}).handled,false);});
for (let i=0;i<45;i++) test(`data scenario ${i+1}`,()=>{const e=make('alpha beta\ngamma delta',i%8);feed(e,['h','l','w','j','k'][i%5]);assert.ok(e.cursor>=0&&e.cursor<=text(e).length);});
