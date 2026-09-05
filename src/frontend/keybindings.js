(function () {
  'use strict';
  var KEY='glancemd-ultra-keybindings', defaults={'file.open':'Ctrl+O','quickopen.toggle':'Ctrl+P','search.toggle':'Ctrl+Shift+F','palette.toggle':'Ctrl+Shift+P','settings.toggle':'Ctrl+`'}, overrides={};
  function load(){try{overrides=JSON.parse(localStorage.getItem(KEY)||'{}')||{};}catch(e){overrides={};}return overrides;}
  function effective(){var x=Object.assign({},defaults,overrides);return x;}
  function conflict(map){var seen={};for(var k in map){if(!map[k])continue;if(seen[map[k]])return {key:map[k],commands:[seen[map[k]],k]};seen[map[k]]=k;}return null;}
  function save(map){var c=conflict(map);if(c)throw new Error('快捷键冲突：'+c.key);overrides=map;try{localStorage.setItem(KEY,JSON.stringify(map));}catch(e){}return true;}
  function normalize(e){var a=[];if(e.ctrlKey)a.push('Ctrl');if(e.altKey)a.push('Alt');if(e.shiftKey)a.push('Shift');if(e.metaKey)a.push('Meta');var k=e.key===' '?'Space':e.key.length===1?e.key.toUpperCase():e.key;return a.join('+')+(a.length?'+' :'')+k;}
  // 输入框聚焦时仍放行的面板切换类命令（搜索/快开/面板/设置需要在编辑中可达）
  var INPUT_ALLOWED={'quickopen.toggle':1,'search.toggle':1,'palette.toggle':1,'settings.toggle':1};
  function dispatch(e){var inInput=e.target&&/INPUT|TEXTAREA|SELECT/.test(e.target.tagName);var key=normalize(e),map=effective();for(var id in map)if(map[id]===key&&window.Commands&&Commands.has&&Commands.has(id)){if(inInput&&!INPUT_ALLOWED[id])return null;e.preventDefault();Commands.run(id);return id;}return null;}
  load();document.addEventListener('keydown',dispatch);
  window.Keybindings={defaults:defaults,load:load,effective:effective,save:save,clear:function(){save({});},conflict:conflict,normalize:normalize,dispatch:dispatch,exportJSON:function(){return JSON.stringify(overrides,null,2);},importJSON:function(s){var x=JSON.parse(s);save(x);return x;}};
})();
