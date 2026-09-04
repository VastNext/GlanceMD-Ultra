(function () {
  'use strict';
  var state = { open: false, category: 'appearance', global: {}, effective: {}, project: {} };
  var categories = ['appearance', 'files', 'watching', 'search', 'editor', 'keybindings', 'recovery'];
  function send(m) { if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(JSON.stringify(m)); }
  function ensure() {
    var p = document.getElementById('settings-panel'); if (p) return p;
    p = document.createElement('section'); p.id = 'settings-panel'; p.className = 'settings-panel'; p.hidden = true;
    p.innerHTML = '<header><strong>设置</strong><input id="settings-filter" placeholder="搜索设置"><button id="settings-close">×</button></header><div class="settings-layout"><nav id="settings-categories"></nav><main id="settings-body"></main></div><footer><button id="settings-json">打开设置 JSON</button></footer>';
    document.body.appendChild(p);
    p.querySelector('#settings-close').onclick = close;
    p.querySelector('#settings-json').onclick = function () { send({ command: 'workspace.settings.open-settings-json' }); };
    p.querySelector('#settings-filter').oninput = render;
    renderCategories(); render(); return p;
  }
  function renderCategories() { var n = ensure().querySelector('#settings-categories'); if (!n) return; n.innerHTML = categories.map(function (c) { return '<button data-category="'+c+'" class="'+(c===state.category?'active':'')+'">'+c+'</button>'; }).join(''); if (!n.children) return; Array.prototype.forEach.call(n.children, function (b) { b.onclick = function () { state.category=b.dataset.category; renderCategories(); render(); }; }); }
  function render() { var p=ensure(), q=(p.querySelector('#settings-filter').value||'').toLowerCase(), obj=state.effective[state.category]||{}; var html='<h2>'+state.category+'</h2>'; Object.keys(obj).filter(function(k){return !q||k.toLowerCase().indexOf(q)>=0;}).forEach(function(k){var v=obj[k], id='setting-'+state.category+'-'+k.replace(/[^a-z0-9]/gi,'-'); var input=typeof v==='boolean'?'<input type="checkbox" '+(v?'checked':'')+' data-setting="'+k+'">':Array.isArray(v)?'<input value="'+String(v).replace(/"/g,'&quot;')+'" data-setting="'+k+'">':'<input value="'+String(v).replace(/"/g,'&quot;')+'" data-setting="'+k+'">'; html+='<label class="setting-row" for="'+id+'"><span>'+k+(state.project[state.category]&&state.project[state.category][k]!==undefined?'<em>项目已覆盖</em>':'')+'</span>'+input+'</label>';}); p.querySelector('#settings-body').innerHTML=html; Array.prototype.forEach.call(p.querySelectorAll('[data-setting]'),function(i){i.id='setting-'+state.category+'-'+i.dataset.setting;i.onchange=function(){var v=i.type==='checkbox'?i.checked:i.value;var patch={};patch[state.category]={};patch[state.category][i.dataset.setting]=v;send({command:'workspace.settings.set-global',data:JSON.stringify(Object.assign({},state.global,patch))});if(state.category==='appearance'&&i.dataset.setting==='theme'){document.documentElement.dataset.theme=v;try{localStorage.setItem('glancemd-ultra-theme',v);}catch(e){}}};}); }
  function open(){state.open=true;var p=ensure();p.hidden=false;send({command:'workspace.settings.get-effective'});send({command:'workspace.settings.get-global'});send({command:'workspace.settings.load-project'});}
  function close(){state.open=false;var p=document.getElementById('settings-panel');if(p)p.hidden=true;}
  function receive(e,d){if(e==='workspace:settings-effective'){state.effective=d.settings||{};render();}if(e==='workspace:settings-global'){state.global=d.settings||{};if(!Object.keys(state.effective).length)state.effective=state.global;render();}if(e==='workspace:settings-project'){state.project=d.patch||{};render();}}
  if(window.Workspace&&Workspace.on){Workspace.on('workspace:settings-effective',function(d){receive('workspace:settings-effective',d);});Workspace.on('workspace:settings-global',function(d){receive('workspace:settings-global',d);});Workspace.on('workspace:settings-project',function(d){receive('workspace:settings-project',d);});}
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&state.open)close();if(e.ctrlKey&&e.key==='`'){e.preventDefault();state.open?close():open();}});
  window.SettingsUI={open:open,close:close,toggle:function(){state.open?close():open();},receive:receive,getState:function(){return state;}};
})();
