(function () {
  'use strict';
  function t(key, params) { return window.I18n ? window.I18n.t(key, params) : key; }
  var state = { open: false, searchId: null, root: '', hits: [], timer: 0 };
  function send(message) { if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(JSON.stringify(message)); }
  function runCommand(id,arg){if(window.Commands&&typeof window.Commands.run==='function')return window.Commands.run(id,arg);}
  function effectiveSettings() { var sa = window.SettingsApply; try { return sa && typeof sa.get === 'function' ? (sa.get() || {}) : {}; } catch (e) { return {}; } }
  function searchOptions() { var search = effectiveSettings().search || {}, exclude = search.exclude; if (!Array.isArray(exclude)) exclude = typeof exclude === 'string' ? exclude.split(',').map(function(v) { return v.trim(); }).filter(Boolean) : []; var maxFileSizeMB = Number(search.maxFileSizeMB), maxResults = Number(search.maxResults); return { exclude: exclude, maxFileSizeMB: isFinite(maxFileSizeMB) && maxFileSizeMB > 0 ? maxFileSizeMB : 5, maxResults: isFinite(maxResults) && maxResults > 0 ? Math.floor(maxResults) : 2000 }; }
  function esc(value) { return String(value).replace(/[&<>"']/g, function (c) { return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]; }); }

  /* ── 弹层几何：默认居中宽 60vw 高 80vh（左右 20% 上下 10%），header 可拖动、右下角可缩放，localStorage 持久化 ── */
  var GEOMETRY_KEY = 'glancemd-ultra-search-panel-geometry-v2';
  var geometry = null;

  function readStore() { try { if (window.localStorage && typeof window.localStorage.getItem === 'function') return window.localStorage.getItem(GEOMETRY_KEY); } catch (e) {} return null; }
  function writeStore(value) { try { if (window.localStorage && typeof window.localStorage.setItem === 'function') window.localStorage.setItem(GEOMETRY_KEY, value); } catch (e) {} }
  function viewportSize() { return { w: (typeof window.innerWidth === 'number' && window.innerWidth) || 1280, h: (typeof window.innerHeight === 'number' && window.innerHeight) || 800 }; }
  function defaultGeometry() {
    var v = viewportSize();
    var w = Math.round(v.w * 0.6);
    var h = Math.round(v.h * 0.8);
    var x = Math.round(v.w * 0.2);
    var y = Math.round(v.h * 0.1);
    return { w: w, h: h, x: x, y: y };
  }
  function clampGeometry(g) {
    var v = viewportSize();
    var def = defaultGeometry();
    var minW = Math.min(380, Math.max(160, v.w - 16));
    var minH = Math.min(240, Math.max(120, v.h - 16));
    var maxW = Math.max(minW, v.w - 16);
    var maxH = Math.max(minH, v.h - 16);

    var out = {
      w: (g && typeof g.w === 'number' && isFinite(g.w) && g.w > 0) ? g.w : def.w,
      h: (g && typeof g.h === 'number' && isFinite(g.h) && g.h > 0) ? g.h : def.h,
      x: (g && typeof g.x === 'number' && isFinite(g.x)) ? g.x : def.x,
      y: (g && typeof g.y === 'number' && isFinite(g.y)) ? g.y : def.y
    };
    out.w = Math.min(Math.max(minW, out.w), maxW);
    out.h = Math.min(Math.max(minH, out.h), maxH);
    out.x = Math.min(Math.max(0, out.x), Math.max(0, v.w - out.w));
    out.y = Math.min(Math.max(0, out.y), Math.max(0, v.h - out.h));
    return out;
  }
  function loadGeometry() {
    var raw = readStore();
    if (!raw) return clampGeometry(defaultGeometry());
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || (parsed.w === 820 && parsed.h === 460)) {
        return clampGeometry(defaultGeometry());
      }
      return clampGeometry(parsed);
    } catch (e) {
      return clampGeometry(defaultGeometry());
    }
  }
  function saveGeometry() { writeStore(JSON.stringify({ w: geometry.w, h: geometry.h, x: geometry.x, y: geometry.y })); }
  function applyGeometry(panel) {
    var p = panel || document.getElementById('search-panel');
    if (!p || !p.style) return geometry;
    p.style.width = geometry.w + 'px';
    p.style.height = geometry.h + 'px';
    if (geometry.x != null && geometry.y != null) { p.style.left = geometry.x + 'px'; p.style.top = geometry.y + 'px'; p.style.right = 'auto'; }
    else { p.style.left = ''; p.style.top = ''; p.style.right = ''; }
    return geometry;
  }
  function setGeometry(next, persist) {
    geometry = clampGeometry(Object.assign({}, geometry, next || {}));
    applyGeometry();
    if (persist !== false) saveGeometry();
    return geometry;
  }
  function resetGeometry() { geometry = clampGeometry(defaultGeometry()); applyGeometry(); saveGeometry(); return geometry; }
  function getGeometry() { return Object.assign({}, geometry); }

  function startPointerInteraction(panel, e, mode) {
    if (!e || typeof e.clientX !== 'number') return;
    if (e.stopPropagation) e.stopPropagation();
    if (e.preventDefault) e.preventDefault();
    if (panel.setPointerCapture && typeof e.pointerId === 'number') {
      try { panel.setPointerCapture(e.pointerId); } catch (_) {}
    }
    var startX = e.clientX, startY = e.clientY;
    var base = {};
    if (mode === 'move') {
      var rect = typeof panel.getBoundingClientRect === 'function' ? panel.getBoundingClientRect() : { left: 0, top: 0 };
      base.x = rect.left; base.y = rect.top;
    } else { base.w = geometry.w; base.h = geometry.h; }
    function onMove(ev) {
      if (typeof ev.clientX !== 'number') return;
      if (ev.stopPropagation) ev.stopPropagation();
      if (ev.preventDefault) ev.preventDefault();
      if (mode === 'move') setGeometry({ x: base.x + (ev.clientX - startX), y: base.y + (ev.clientY - startY) }, false);
      else setGeometry({ w: base.w + (ev.clientX - startX), h: base.h + (ev.clientY - startY) }, false);
    }
    function onUp(ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      if (panel.releasePointerCapture && typeof e.pointerId === 'number') {
        try { panel.releasePointerCapture(e.pointerId); } catch (_) {}
      }
      if (typeof window.removeEventListener === 'function') {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
      }
      panel.classList.remove(mode === 'move' ? 'dragging' : 'resizing');
      saveGeometry();
    }
    panel.classList.add(mode === 'move' ? 'dragging' : 'resizing');
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    }
  }
  function attachDrag(panel) {
    var header = panel.querySelector('header');
    if (!header || typeof header.addEventListener !== 'function') return;
    header.addEventListener('pointerdown', function (e) {
      if (!state.open) return;
      if (e.target && e.target.closest && e.target.closest('button,input,select,textarea')) return;
      e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
      startPointerInteraction(panel, e, 'move');
    });
  }
  function attachResize(panel) {
    var handle = panel.querySelector('#search-resize');
    if (!handle || typeof handle.addEventListener !== 'function') return;
    handle.addEventListener('pointerdown', function (e) {
      if (!state.open) return;
      e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
      startPointerInteraction(panel, e, 'size');
    });
  }
  function attachViewportClamp() {
    if (typeof window.addEventListener !== 'function') return;
    window.addEventListener('resize', function () { if (state.open) setGeometry({}, false); });
  }

  function getPanel() { var panel = document.getElementById('search-panel'); if (panel) return panel; panel = document.createElement('section'); panel.id='search-panel'; panel.className='search-panel'; panel.hidden=true; panel.innerHTML='<header><strong>' + t('search.title') + '</strong><button id="search-close" type="button" title="' + t('search.closeHint') + '">×</button></header><div class="search-controls"><input id="search-input" placeholder="' + t('search.placeholder') + '"><button data-search-toggle="case">Aa</button><button data-search-toggle="word">ab</button><button data-search-toggle="regex">.*</button></div><div class="search-globs"><input id="search-include" placeholder="' + t('search.includeGlob') + '"><input id="search-exclude" placeholder="' + t('search.excludeGlob') + '"></div><div id="search-status"></div><div id="search-results"></div><div id="search-resize" class="search-resize-handle" title="' + t('search.resizeHandle') + '"></div>'; document.body.appendChild(panel); panel.querySelector('#search-close').addEventListener('click',function(){runCommand('search.close');}); panel.querySelector('#search-input').addEventListener('input', function(){ clearTimeout(state.timer); state.timer=setTimeout(function(){runCommand('search.start');},300); }); Array.prototype.forEach.call(panel.querySelectorAll('[data-search-toggle]'), function(button){ button.addEventListener('click', function(){ button.classList.toggle('active'); if(panel.querySelector('#search-input').value.trim())runCommand('search.start'); }); }); panel.addEventListener('keydown',function(e){if(!state.open)return;if(e.key==='Escape'){e.preventDefault();runCommand(state.searchId?'search.cancel':'search.close');} }); attachDrag(panel); attachResize(panel); return panel; }
  // 静态文案按活动语言刷新：面板 DOM 缓存复用，getPanel 只在首建时写入文案
  function applyStaticText(panel) { var p=panel||document.getElementById('search-panel'); if(!p||!p.querySelector)return; function put(el,attr,val){ if(el&&typeof el.setAttribute==='function')el.setAttribute(attr,val); } var title=p.querySelector('header strong'); if(title&&'textContent' in title)title.textContent=t('search.title'); put(p.querySelector('#search-close'),'title',t('search.closeHint')); put(p.querySelector('#search-input'),'placeholder',t('search.placeholder')); put(p.querySelector('#search-include'),'placeholder',t('search.includeGlob')); put(p.querySelector('#search-exclude'),'placeholder',t('search.excludeGlob')); put(p.querySelector('#search-resize'),'title',t('search.resizeHandle')); }
  function open() { state.open=true; var p=getPanel(); applyStaticText(p); applyGeometry(p); p.hidden=false; p.querySelector('#search-input').focus(); }
  function close() { if(state.searchId)runCommand('search.cancel'); state.open=false; var p=document.getElementById('search-panel');if(p)p.hidden=true; }
  function cancel() { if(state.searchId){send({command:'workspace.search.cancel',options:{searchId:state.searchId}});state.searchId=null;getPanel().querySelector('#search-status').textContent=t('search.cancelled');} }
  function start() { var p=getPanel(), q=p.querySelector('#search-input').value.trim(); if(!q)return; if(state.searchId)cancel(); state.searchId='search-'+Date.now(); state.hits=[]; p.querySelector('#search-results').innerHTML=''; p.querySelector('#search-status').textContent=t('search.searching'); var configured=searchOptions(); send({command:'workspace.search.start',options:{searchId:state.searchId,query:q,caseSensitive:p.querySelector('[data-search-toggle="case"]').classList.contains('active'),wholeWord:p.querySelector('[data-search-toggle="word"]').classList.contains('active'),regex:p.querySelector('[data-search-toggle="regex"]').classList.contains('active'),includeGlobs:p.querySelector('#search-include').value.split(',').map(function(v){return v.trim();}).filter(Boolean),excludeGlobs:p.querySelector('#search-exclude').value.split(',').map(function(v){return v.trim();}).filter(Boolean),exclude:configured.exclude,maxFileSizeMB:configured.maxFileSizeMB,maxFileBytes:Math.floor(configured.maxFileSizeMB*1024*1024),maxResults:configured.maxResults}}); }
  function toggleCaseSensitive(){var b=getPanel().querySelector('[data-search-toggle="case"]');b.classList.toggle('active');if(getPanel().querySelector('#search-input').value.trim())start();}
  function toggleWholeWord(){var b=getPanel().querySelector('[data-search-toggle="word"]');b.classList.toggle('active');if(getPanel().querySelector('#search-input').value.trim())start();}
  function toggleRegex(){var b=getPanel().querySelector('[data-search-toggle="regex"]');b.classList.toggle('active');if(getPanel().querySelector('#search-input').value.trim())start();}
  function render() { var p=getPanel(), groups={}; state.hits.forEach(function(h){var f=h.relPath||h.rel_path||'';(groups[f]||(groups[f]=[])).push(h);}); var html=''; Object.keys(groups).sort().forEach(function(file){html+='<div class="search-file"><div class="search-file-name">'+esc(file)+' <b>'+groups[file].length+'</b></div>';groups[file].forEach(function(h){html+='<button class="search-hit" data-path="'+esc(file)+'"><span>'+h.line+'</span> '+esc(h.lineText||h.line_text||'')+'</button>';});html+='</div>';});p.querySelector('#search-results').innerHTML=html||'<p class="search-empty">' + t('search.noResults') + '</p>';Array.prototype.forEach.call(p.querySelectorAll('.search-hit'),function(b){b.addEventListener('click',function(){runCommand('file.open',{path:(state.root?state.root+'/':'')+b.dataset.path});});}); }
  function receive(event,data){if(event==='workspace:opened')state.root=data.root||'';if(event==='workspace:search-result'&&(!state.searchId||data.searchId===state.searchId)){state.hits=state.hits.concat(data.hits||[]);render();}if(event==='workspace:search-completed'&&data.searchId===state.searchId){var s=data.summary||{};state.searchId=null;getPanel().querySelector('#search-status').textContent=(s.cancelled?t('search.cancelled'):t('search.completed', { n: (s.hits || state.hits.length) }))+(s.truncated?t('search.truncated'):'');}if(event==='workspace:error'&&state.open)getPanel().querySelector('#search-status').textContent=data.message||t('search.failed');}
  if(window.Workspace&&Workspace.on){Workspace.on('workspace:opened',function(d){receive('workspace:opened',d);});Workspace.on('workspace:search-result',function(d){receive('workspace:search-result',d);});Workspace.on('workspace:search-completed',function(d){receive('workspace:search-completed',d);});Workspace.on('workspace:error',function(d){receive('workspace:error',d);});}
  function registerCommands(){if(!window.Commands||typeof window.Commands.register!=='function')return;var reg=window.Commands.register;reg('search.toggle',{label:'切换搜索',category:'Navigation',run:function(){state.open?close():open();}});reg('search.open',{label:'打开搜索',category:'Navigation',run:open});reg('search.close',{label:'关闭搜索',category:'Navigation',run:close});reg('search.start',{label:'开始搜索',category:'Search',run:start});reg('search.cancel',{label:'取消搜索',category:'Search',run:cancel});reg('search.toggleCaseSensitive',{label:'切换大小写敏感',category:'Search',run:toggleCaseSensitive});reg('search.toggleWholeWord',{label:'切换全字匹配',category:'Search',run:toggleWholeWord});reg('search.toggleRegex',{label:'切换正则表达式',category:'Search',run:toggleRegex});}
  registerCommands();
  // 语言切换：面板打开时重刷静态文案（关闭状态下下次 open 时刷新）
  if (window.addEventListener) window.addEventListener('i18n-changed', function () { if (state.open) applyStaticText(); });
  geometry = loadGeometry();
  attachViewportClamp();
  window.SearchPanel={open:open,close:close,toggle:function(){state.open?close():open();},start:start,cancel:cancel,toggleCaseSensitive:toggleCaseSensitive,toggleWholeWord:toggleWholeWord,toggleRegex:toggleRegex,getGeometry:getGeometry,setGeometry:function(next){return setGeometry(next,true);},resetGeometry:resetGeometry,clampGeometry:clampGeometry,getState:function(){return {open:state.open,searchId:state.searchId,hits:state.hits.slice()};}};
})();
