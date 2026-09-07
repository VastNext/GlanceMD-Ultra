(function () {
  'use strict';
  function t(key, params) { return window.I18n ? window.I18n.t(key, params) : key; }
  var state = { open: false, searchId: null, root: '', hits: [], timer: 0 };
  function send(message) { if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(JSON.stringify(message)); }
  function effectiveSettings() {
    var sa = window.SettingsApply;
    try { return sa && typeof sa.get === 'function' ? (sa.get() || {}) : {}; } catch (e) { return {}; }
  }
  function searchOptions() {
    var search = effectiveSettings().search || {};
    var exclude = search.exclude;
    if (!Array.isArray(exclude)) exclude = typeof exclude === 'string' ? exclude.split(',').map(function(v) { return v.trim(); }).filter(Boolean) : [];
    var maxFileSizeMB = Number(search.maxFileSizeMB);
    var maxResults = Number(search.maxResults);
    return {
      exclude: exclude,
      maxFileSizeMB: isFinite(maxFileSizeMB) && maxFileSizeMB > 0 ? maxFileSizeMB : 5,
      maxResults: isFinite(maxResults) && maxResults > 0 ? Math.floor(maxResults) : 2000
    };
  }
  function esc(value) { return String(value).replace(/[&<>"']/g, function (c) { return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]; }); }
  function getPanel() {
    var panel = document.getElementById('search-panel');
    if (panel) return panel;
    panel = document.createElement('section'); panel.id='search-panel'; panel.className='search-panel'; panel.hidden=true;
    panel.innerHTML='<header><strong>' + t('search.title') + '</strong><button id="search-close" type="button">×</button></header><div class="search-controls"><input id="search-input" placeholder="' + t('search.placeholder') + '"><button data-search-toggle="case">Aa</button><button data-search-toggle="word">ab</button><button data-search-toggle="regex">.*</button></div><div class="search-globs"><input id="search-include" placeholder="' + t('search.includeGlob') + '"><input id="search-exclude" placeholder="' + t('search.excludeGlob') + '"></div><div id="search-status"></div><div id="search-results"></div>';
    document.body.appendChild(panel);
    panel.querySelector('#search-close').addEventListener('click', close);
    panel.querySelector('#search-input').addEventListener('input', function(){ clearTimeout(state.timer); state.timer=setTimeout(start,300); });
    Array.prototype.forEach.call(panel.querySelectorAll('[data-search-toggle]'), function(button){ button.addEventListener('click', function(){ button.classList.toggle('active'); if(panel.querySelector('#search-input').value.trim()) start(); }); });
    return panel;
  }
  function open() { state.open=true; var p=getPanel(); p.hidden=false; p.querySelector('#search-input').focus(); }
  function close() { if(state.searchId) send({command:'workspace.search.cancel',options:{searchId:state.searchId}}); state.open=false; var p=document.getElementById('search-panel'); if(p)p.hidden=true; }
  function start() { var p=getPanel(), q=p.querySelector('#search-input').value.trim(); if(!q)return; if(state.searchId)send({command:'workspace.search.cancel',options:{searchId:state.searchId}}); state.searchId='search-'+Date.now(); state.hits=[]; p.querySelector('#search-results').innerHTML=''; p.querySelector('#search-status').textContent=t('search.searching'); var configured=searchOptions(); send({command:'workspace.search.start',options:{searchId:state.searchId,query:q,caseSensitive:p.querySelector('[data-search-toggle="case"]').classList.contains('active'),wholeWord:p.querySelector('[data-search-toggle="word"]').classList.contains('active'),regex:p.querySelector('[data-search-toggle="regex"]').classList.contains('active'),includeGlobs:p.querySelector('#search-include').value.split(',').map(function(v){return v.trim();}).filter(Boolean),excludeGlobs:p.querySelector('#search-exclude').value.split(',').map(function(v){return v.trim();}).filter(Boolean),exclude:configured.exclude,maxFileSizeMB:configured.maxFileSizeMB,maxFileBytes:Math.floor(configured.maxFileSizeMB*1024*1024),maxResults:configured.maxResults}}); }
  function render() { var p=getPanel(), groups={}; state.hits.forEach(function(h){var f=h.relPath||h.rel_path||'';(groups[f]||(groups[f]=[])).push(h);}); var html=''; Object.keys(groups).sort().forEach(function(file){html+='<div class="search-file"><div class="search-file-name">'+esc(file)+' <b>'+groups[file].length+'</b></div>';groups[file].forEach(function(h){html+='<button class="search-hit" data-path="'+esc(file)+'"><span>'+h.line+'</span> '+esc(h.lineText||h.line_text||'')+'</button>';});html+='</div>';});p.querySelector('#search-results').innerHTML=html||'<p class="search-empty">' + t('search.noResults') + '</p>';Array.prototype.forEach.call(p.querySelectorAll('.search-hit'),function(b){b.addEventListener('click',function(){send({command:'open_file',path:(state.root?state.root+'/':'')+b.dataset.path});});}); }
  function receive(event,data){if(event==='workspace:opened')state.root=data.root||'';if(event==='workspace:search-result'&&(!state.searchId||data.searchId===state.searchId)){state.hits=state.hits.concat(data.hits||[]);render();}if(event==='workspace:search-completed'&&data.searchId===state.searchId){var s=data.summary||{};getPanel().querySelector('#search-status').textContent=(s.cancelled?t('search.cancelled'):t('search.completed', { n: (s.hits || state.hits.length) }))+(s.truncated?t('search.truncated'):'');}if(event==='workspace:error'&&state.open)getPanel().querySelector('#search-status').textContent=data.message||t('search.failed');}
  if(window.Workspace&&Workspace.on){Workspace.on('workspace:opened',function(d){receive('workspace:opened',d);});Workspace.on('workspace:search-result',function(d){receive('workspace:search-result',d);});Workspace.on('workspace:search-completed',function(d){receive('workspace:search-completed',d);});Workspace.on('workspace:error',function(d){receive('workspace:error',d);});}
  document.addEventListener('keydown',function(e){if(e.ctrlKey&&e.shiftKey&&e.key.toLowerCase()==='f'){e.preventDefault();state.open?close():open();}else if(e.key==='Escape'&&state.open)close();});
  window.SearchPanel={open:open,close:close,toggle:function(){state.open?close():open();},start:start,getState:function(){return {open:state.open,searchId:state.searchId,hits:state.hits.slice()};}};
})();
