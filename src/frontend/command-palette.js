(function () {
  'use strict';
  var KEY='glancemd-ultra-palette-recent', state={open:false,selected:0,recent:[]};
  function esc(s){return String(s).replace(/[&<>"']/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];});}
  function score(q,s){q=q.toLowerCase();s=s.toLowerCase();var i=0,n=0,last=-2;for(var c=0;c<q.length;c++){var p=s.indexOf(q[c],i);if(p<0)return -1;n+=1+(p===last+1?3:0);last=p;i=p+1;}return n;}
  function ensure(){var p=document.getElementById('command-palette');if(p)return p;p=document.createElement('section');p.id='command-palette';p.className='command-palette';p.hidden=true;p.innerHTML='<input id="palette-input" placeholder="输入命令"><div id="palette-list"></div>';document.body.appendChild(p);p.querySelector('input').oninput=render;return p;}
  function render(){var p=ensure(),q=p.querySelector('input').value||'',ids=window.Commands&&Commands.ids?Commands.ids():[],items=ids.map(function(id){return {id:id,s:score(q,id)};}).filter(function(x){return x.s>=0;}).sort(function(a,b){return b.s-a.s||a.id.localeCompare(b.id);});p.querySelector('#palette-list').innerHTML=items.map(function(x,i){return '<button class="palette-item '+(i===state.selected?'active':'')+'" data-id="'+esc(x.id)+'">'+esc(x.id)+'</button>';}).join('');Array.prototype.forEach.call(p.querySelectorAll('.palette-item'),function(b){b.onclick=function(){run(b.dataset.id);};});}
  function run(id){if(window.Commands&&Commands.run){try{Commands.run(id);}catch(e){}state.recent.unshift(id);state.recent=state.recent.filter(function(x,i,a){return a.indexOf(x)===i;}).slice(0,5);try{localStorage.setItem(KEY,JSON.stringify(state.recent));}catch(e){}close();}}
  function open(){state.open=true;var p=ensure();p.hidden=false;state.selected=0;p.querySelector('input').value='';p.querySelector('input').focus();render();}
  function close(){state.open=false;var p=document.getElementById('command-palette');if(p)p.hidden=true;}
  document.addEventListener('keydown',function(e){if(e.ctrlKey&&e.shiftKey&&e.key.toLowerCase()==='p'){e.preventDefault();state.open?close():open();}else if(state.open&&e.key==='Escape')close();else if(state.open&&(e.key==='ArrowDown'||e.key==='ArrowUp')){e.preventDefault();state.selected=Math.max(0,state.selected+(e.key==='ArrowDown'?1:-1));render();}else if(state.open&&e.key==='Enter'){var b=ensure().querySelector('.palette-item.active');if(b)b.click();}});
  try{state.recent=JSON.parse(localStorage.getItem(KEY)||'[]')||[];}catch(e){}
  window.CommandPalette={open:open,close:close,toggle:function(){state.open?close():open();},run:run,score:score};
})();
