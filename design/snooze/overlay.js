(function(){
function sv(p,s){return '<svg xmlns="http://www.w3.org/2000/svg" width="'+(s||16)+'" height="'+(s||16)+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+p+'</svg>';}
var I={
 clock:'<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
 moon:'<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
 sunrise:'<path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
 check:'<path d="M20 6 9 17l-5-5"/>',
 alert:'<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
 ask:'<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
 tools:'<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
 eyeoff:'<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>',
 move:'<path d="M5 9l-3 3 3 3"/><path d="M9 5l3-3 3 3"/><path d="M15 19l-3 3-3-3"/><path d="M19 9l3 3-3 3"/><path d="M2 12h20"/><path d="M12 2v20"/>',
 trash:'<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
 x:'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
 chev:'<path d="m6 9 6 6 6-6"/>',
 target:'<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>'
};
function el(h){var d=document.createElement('div');d.innerHTML=h.trim();return d.firstChild;}
function $(s,r){return (r||document).querySelector(s);}
function $$(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));}

var SCREENS=['today','chat','project','away','back','opened'];
var s=(location.hash||'#today').slice(1); if(SCREENS.indexOf(s)<0)s='today';

/* ---------- shell: a believable evening sidebar ---------- */
$$('.dev-source-badge').forEach(function(n){n.remove();});
var scroll=$('[data-testid=sb-scroll]');
var rowT=$('.sb-row',scroll).cloneNode(true), folderT=$$('.sb-folder',scroll)[1].cloneNode(true);
$$('.sb-row',folderT).forEach(function(r){r.remove();});
function row(name,badge,when,extra){
  var r=rowT.cloneNode(true);
  r.querySelector('.name').textContent=name;
  var b=r.querySelector('.badge');b.className='badge badge-'+badge;
  r.querySelector('.when-time').textContent=when||'';
  if(extra)r.classList.add(extra);
  return r;
}
function folder(name,rows){
  var f=folderT.cloneNode(true);
  f.querySelector('.folder-head-label').textContent=name;
  rows.forEach(function(r){f.appendChild(r);});
  return f;
}
var WORK=[
 ['Migrate billing to Postgres 17','working','',1],
 ['Fix flaky checkout e2e','working','',1],
 ['Q3 incident write-up','done','17:40'],
 ['Jira backlog triage','done','16:12'],
 ['Tempo timesheet','read','14:03']
];
var HOME=[['Meal plan','done','18:55'],['Boiler service','read','12:30'],['Garden lighting','read','Mon']];
function fill(opts){
  scroll.innerHTML='';
  if(opts.top)scroll.appendChild(opts.top);
  if(opts.work!==false)scroll.appendChild(folder('work',WORK.map(function(w){return row(w[0],w[1],w[2]);})));
  scroll.appendChild(folder('home',HOME.map(function(w){return row(w[0],w[1],w[2]);})));
  scroll.appendChild(folder('portfolio',[row('Forage nav bar','read','Tue'),row('Prod sync fix','read','Tue')]));
}
function setChat(title,crumb){$('[data-testid=chat-title]').textContent=title;$('[data-testid=folder-path]')&&($('[data-testid=folder-path]').textContent=crumb[0]);$('[data-testid=chat-host]')&&($('[data-testid=chat-host]').textContent=crumb[1]);}
var stream=$('.chat-stream-content'),uT=$('.msg-user',stream),aT=$('.msg-assistant',stream),gT=$('.tool-group',stream);
function msgs(list){
  stream.innerHTML='';
  list.forEach(function(m){
    var n;
    if(m[0]==='t'){n=gT.cloneNode(true);n.querySelector('.tool-summary-text').textContent=m[1];}
    else if(m[0]==='h'){n=el(m[1]);}
    else{n=(m[0]==='u'?uT:aT).cloneNode(true);$$('.msg-edit,.msg-side-thread',n).forEach(function(x){x.remove();});n.querySelector('.content').innerHTML=m[1];}
    stream.appendChild(n);
  });
}
function selectRow(name){$$('.sb-row').forEach(function(r){if(r.querySelector('.name').textContent===name)r.classList.add('active');});}

var BILLING=[
 ['u','<p>Move billing off Postgres 12 onto 17. Keep going until the shadow run matches for 1,000 invoices, then cut over staging.</p>'],
 ['t','Ran 14 commands, read 9 files'],
 ['a','<p>Schema ported. Starting the shadow run now — it compares every invoice from both databases and takes about 40 minutes a pass.</p>'],
 ['t','Ran 3 commands']
];

/* =====================================================================
   today: what Snooze looks like now — nothing says it keeps running
   ===================================================================== */
function headerMenu(snoozeHtml,label){
  var wrap=$('.head-menu-wrap');
  $('[data-testid=action-more]').classList.add('sz-pressed');
  wrap.appendChild(el('<div class="head-menu sz-menu" role="menu">'+
   '<button type="button" class="head-menu-item">'+sv(I.tools,14)+'Tools</button>'+
   '<button type="button" class="head-menu-item sz-on">'+sv(I.clock,14)+(label||'Snooze')+'</button>'+
   '<button type="button" class="head-menu-item">'+sv(I.eyeoff,14)+'Hide</button>'+
   '<button type="button" class="head-menu-item">'+sv(I.move,14)+'Move to…</button>'+
   '<button type="button" class="head-menu-item">'+sv(I.trash,14)+'Delete</button>'+
   snoozeHtml+'</div>'));
}
if(s==='today'){
  fill({});selectRow('Migrate billing to Postgres 17');
  setChat('Migrate billing to Postgres 17',['work','Mac']);
  msgs(BILLING);
  headerMenu('<div class="snooze-menu sz-sub">'+
   ['2 minutes','5 minutes','30 minutes','1 hour','5pm','Tomorrow 8am','1 day','Next week','Custom…'].map(function(p){return '<button type="button" class="snooze-option">'+p+'</button>';}).join('')+'</div>');
}

/* =====================================================================
   Snooze always opens a sheet: when it's back, and what keeps working
   ===================================================================== */
var PRE=[['30 minutes','20:12'],['1 hour','20:42'],['5pm','Fri 17:00'],['Tomorrow 8am','Fri 08:00'],['Next week','Thu 22 Oct'],['Custom…','']];
function sheet(title,sub,keep,others,on,btn){
  document.body.appendChild(el('<div class="sz-scrim"></div>'));
  document.body.appendChild(el('<div class="sz-sheet" role="dialog">'+
   '<div class="sz-sheet-h"><h2 class="display">'+title+'</h2>'+(sub?'<span>'+sub+'</span>':'')+'</div>'+
   '<div class="sz-pre">'+PRE.map(function(p,i){return '<button type="button" class="sz-p'+(i===on?' on':'')+'"><span>'+p[0]+'</span>'+(p[1]?'<span class="sz-at">'+p[1]+'</span>':'')+'</button>';}).join('')+'</div>'+
   (keep.length?'<div class="sz-group"><div class="sz-group-h">'+sv(I.clock,14)+'Run in background<span>'+keep.length+'</span></div>'+
     keep.map(function(k){return '<div class="sz-item"><span class="badge badge-working"></span><div><b>'+k[0]+'</b>'+(k[1]?'<span>'+k[1]+'</span>':'')+'</div><span class="sz-run">'+k[2]+'</span></div>';}).join('')+
     (others?'<div class="sz-others">+ '+others+' not running</div>':'')+'</div>':'')+
   '<div class="sz-rule">Snoozed chats keep running and reappear when scheduled</div>'+
   '<div class="sz-actions"><button type="button" class="sz-ghost">Cancel</button><span class="pip-flex"></span><button type="button" class="sz-primary">'+sv(I.clock,15)+btn+'</button></div>'+
  '</div>'));
}
if(s==='chat'){
  fill({});selectRow('Migrate billing to Postgres 17');
  setChat('Migrate billing to Postgres 17',['work','Mac']);
  msgs(BILLING);
  sheet('Snooze','Migrate billing to Postgres 17',[['This chat','Shadow run, pass 1 of ~4','2h 10m']],0,3,'Snooze until Fri 08:00');
}
if(s==='project'){
  fill({});
  setChat('Meal plan',['home','Mac']);
  msgs([['u','<p>Plan the week’s dinners.</p>'],['a','<p>Seven dinners planned; shopping list is in the Groceries project.</p>']]);
  $$('.sb-folder')[0].querySelector('.folder-head').classList.add('sz-hl');
  sheet('Snooze work','5 chats',[['Migrate billing to Postgres 17','Shadow run, pass 1 of ~4','2h 10m'],['Fix flaky checkout e2e','Re-running the suite 20×','25m']],3,3,'Snooze 5 until Fri 08:00');
}

/* =====================================================================
   away: snoozed chats collapse to one line inside their own project
   ===================================================================== */
function awayLine(n,at){return el('<button type="button" class="sz-away">'+sv(I.clock,14)+'<span class="sz-away-t">'+n+' snoozed</span><span class="sz-away-m">back '+at+'</span></button>');}
if(s==='away'){
  fill({});selectRow('Meal plan');
  var fs=$$('.sb-folder');
  $$('.sb-row',fs[0]).forEach(function(r){r.remove();});fs[0].appendChild(awayLine(5,'Fri 08:00'));
  $$('.sb-row',fs[1])[1].remove();fs[1].appendChild(awayLine(1,'20:12'));
  setChat('Meal plan',['home','Mac']);
  msgs([['u','<p>Plan the week’s dinners.</p>'],['a','<p>Seven dinners planned; shopping list is in the Groceries project.</p>']]);
  var tg=$('[data-testid=snoozed-toggle]');tg.classList.add('sz-moon');tg.insertAdjacentHTML('beforeend','<span class="sz-pip">6</span>');
  $('.chat-main').appendChild(el('<div class="sz-toast" role="status">'+sv(I.clock,16)+'<div><b>work snoozed until Fri 08:00</b><span>2 chats running in background</span></div><button type="button">Undo</button></div>'));
}

/* =====================================================================
   back: chats return to their project and say what happened meanwhile
   ===================================================================== */
if(s==='back'||s==='opened'){
  var opened=s==='opened';
  fill({});selectRow(opened?'Migrate billing to Postgres 17':'Meal plan');
  var wf=$$('.sb-folder')[0];
  // The tag has no close button: it goes the first time any chat in the set is opened.
  if(!opened)wf.querySelector('.folder-head-actions').insertAdjacentHTML('beforebegin','<span class="sz-tag">back · snoozed 12h</span>');
  var OUT={'Migrate billing to Postgres 17':['done','sz-ok',opened?'':'finished 03:52'],'Fix flaky checkout e2e':['permission','sz-ask','waiting on you since 21:14'],'Q3 incident write-up':['read','',''],'Jira backlog triage':['read','',''],'Tempo timesheet':['read','','']};
  $$('.sb-row',wf).forEach(function(r){
    var nm=r.querySelector('.name').textContent,o=OUT[nm];if(!o)return;
    r.querySelector('.badge').className='badge badge-'+o[0];r.querySelector('.when-time').textContent='';
    if(!opened)r.classList.add('sz-backrow');
    if(o[2]&&!opened)r.querySelector('.name').innerHTML='<span class="sz-nm">'+nm+'</span><span class="sz-out '+o[1]+'">'+o[2]+'</span>';
  });
  if(opened){
    setChat('Migrate billing to Postgres 17',['work','Mac']);
    msgs(BILLING.concat([
     ['h','<div class="sz-divider"><span>'+sv(I.clock,13)+'Snoozed 19:42 – 08:00 · finished 03:52</span></div>'],
     ['t','Ran 46 commands, read 12 files'],
     ['a','<p>Shadow run matched on pass 4: 1,000 of 1,000 invoices identical. Staging is on Postgres 17 and the smoke tests pass. Production cut-over is ready for you to start.</p>']
    ]));
  }else{
    setChat('Meal plan',['home','Mac']);
    msgs([['u','<p>Plan the week’s dinners.</p>'],['a','<p>Seven dinners planned; shopping list is in the Groceries project.</p>']]);
  }
}

window.addEventListener('hashchange',function(){location.reload();});
})();
