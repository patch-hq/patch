(function(){
function sv(p,s){return '<svg xmlns="http://www.w3.org/2000/svg" width="'+(s||16)+'" height="'+(s||16)+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+p+'</svg>';}
var I={
 monitor:'<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
 server:'<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>',
 hand:'<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
 back:'<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
 x:'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
 down:'<path d="m6 9 6 6 6-6"/>',
 right:'<path d="m9 18 6-6-6-6"/>',
 check:'<path d="M20 6 9 17l-5-5"/>',
 eyeoff:'<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>',
 loader:'<path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/>',
 lock:'<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
 plus:'<path d="M5 12h14"/><path d="M12 5v14"/>',
 search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'
};
function el(h){var d=document.createElement('div');d.innerHTML=h.trim();return d.firstChild;}
function $(s,r){return (r||document).querySelector(s);}
function $$(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));}

/* app icons, drawn small and flat */
var APP={
 settings:'<span class="cu-ai cu-ai-set"><svg viewBox="0 0 24 24" width="70%" height="70%" fill="none" stroke="#fff" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg></span>',
 whatsapp:'<span class="cu-ai cu-ai-wa"><svg viewBox="0 0 24 24" width="66%" height="66%" fill="none" stroke="#fff" stroke-width="2"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg></span>',
 spotify:'<span class="cu-ai cu-ai-sp"><svg viewBox="0 0 24 24" width="72%" height="72%" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round"><path d="M6 9.5c4-1.3 8.5-1 12 1"/><path d="M7 13c3.3-1 6.6-.7 9.5.9"/><path d="M8 16.2c2.5-.7 5-.5 7.2.7"/></svg></span>',
 chromium:'<span class="cu-ai cu-ai-cr"><i></i></span>',
 terminal:'<span class="cu-ai cu-ai-term">&gt;_</span>',
 patch:'<span class="cu-ai cu-ai-patch">p</span>',
 keychain:'<span class="cu-ai cu-ai-key">'+sv(I.lock,13)+'</span>',
 onepw:'<span class="cu-ai cu-ai-1p">1</span>',
 bank:'<span class="cu-ai cu-ai-bank">£</span>',
 admin:'<span class="cu-ai cu-ai-admin">'+sv('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',13)+'</span>',
 finder:'<span class="cu-ai cu-ai-finder"><i></i></span>',
 safari:'<span class="cu-ai cu-ai-safari"><i></i></span>',
 preview:'<span class="cu-ai cu-ai-prev"><i></i></span>'
};

var settingsPage=!!$('.set-main');
var s=settingsPage?'settings':(location.hash||'#working').slice(1);
if(!settingsPage&&['working','approve','takeover','server'].indexOf(s)<0)s='working';

/* ---------- shell common to every screen ---------- */
$$('.dev-source-badge, .toast, [role=alert]').forEach(function(n){if(!n.closest('.set-main'))n.remove();});
var NM=['Display settings','Tell Ruth I\'m late','Spotify autoplay','netcup invoice','Computer use','Hetzner to Netcup migration','Kitchen tap research','Bristol cinema this week','Patch tabs cleanup','Garden lighting','Train to London Friday','Meal plan','Boiler service','Eleanor birthday ideas','Fish sleep audio','Basket watch','Forage nav bar','Prod sync fix','Yonder playlist','Freeagent October','Screwfix order','Dog Log sync bug'],k=0;
$$('.sb-row .name').forEach(function(n){if(n.textContent.trim()==='Manager')return;n.textContent=NM[(k++)%NM.length];});
$$('.sb-row .row-when .when-time').forEach(function(n){n.textContent='';});
$$('.folder-head-label').forEach(function(n,i){n.textContent=['portfolio','patch','home','goodgirl','work'][i%5];});
$$('.sb-row.active').forEach(function(r){r.classList.remove('active');});

/* ================= Settings › Hosts › Mac › Computer use ================= */
if(settingsPage){
  var row=$('[data-testid=host-d1]');
  $('[data-testid=host-d1-label]').textContent='Mac';
  $('[data-testid=host-d1-status]').textContent='macOS · online';
  var srv=row.cloneNode(true);srv.classList.remove('selected');
  $('.set-chip',srv).remove();
  $('[data-testid=host-d1-label]',srv).textContent='netcup';
  $('[data-testid=host-d1-status]',srv).textContent='linux · online';
  row.parentNode.appendChild(srv);
  var det=$('[data-testid=host-detail-d1]');
  $('.set-label',det).textContent='Mac';
  $('[data-testid=host-d1-name-input]').value='Mac';
  $('[data-testid=host-d1-platform]').textContent='darwin arm64';
  $('[data-testid=host-d1-version]').textContent='0.1.912';
  function r(t,ctrl,sub){return '<div class="set-row"><div class="set-row-text"><span class="set-row-title">'+t+'</span>'+(sub?'<span class="set-sub">'+sub+'</span>':'')+'</div>'+(ctrl?'<div class="set-row-ctrl">'+ctrl+'</div>':'')+'</div>';}
  function appRow(ic,name,ctrl){return '<div class="set-row cu-app-row"><div class="set-row-text"><span class="set-row-title">'+APP[ic]+name+'</span></div><div class="set-row-ctrl">'+ctrl+'</div></div>';}
  var tog='<label class="toggle"><input type="checkbox" role="switch" class="toggle-input" checked><span class="toggle-track" aria-hidden="true"><span class="toggle-knob"></span></span></label>';
  var rm='<button type="button" class="set-btn ghost">Remove</button>';
  var lk='<span class="cu-lock">'+sv(I.lock,15)+'</span>';
  function chip(ic,name,x){return '<span class="cu-chip">'+APP[ic]+'<span>'+name+'</span>'+x+'</span>';}
  var rmx='<button type="button" class="cu-chip-x" aria-label="Remove">'+sv(I.x,14)+'</button>';
  var lkx='<span class="cu-chip-x">'+sv(I.lock,13)+'</span>';
  var cu=el('<div class="cu-set" data-testid="host-d1-computer-use">'+
   '<h2 class="set-label">Computer use</h2>'+
   '<div class="set-card">'+
     r('Computer use',tog)+
     r('Mode','<div class="set-pills" role="group" aria-label="Mode"><button type="button" class="on">Background on my screen</button><button type="button">Separate virtual screen</button></div>')+
     r('Stop shortcut','<span class="cu-kbd"><kbd>⌃</kbd><kbd>⌥</kbd><kbd>⌘</kbd><kbd>.</kbd></span><button type="button" class="set-btn ghost">Change</button>')+
     '<div class="set-row stack"><div class="set-row-head"><span class="set-row-title">Approved apps</span><button type="button" class="set-btn">'+sv(I.plus,14)+'Add app</button></div><div class="cu-chips">'+
       chip('settings','System Settings',rmx)+chip('whatsapp','WhatsApp',rmx)+chip('spotify','Spotify',rmx)+chip('finder','Finder',rmx)+chip('safari','Safari',rmx)+chip('preview','Preview',rmx)+
     '</div></div>'+
     '<div class="set-row stack"><div class="set-row-head"><span class="set-row-title">Always denied</span></div><div class="cu-chips">'+
       chip('terminal','Terminal',lkx)+chip('patch','Patch',lkx)+chip('keychain','Keychain Access',lkx)+chip('onepw','1Password',lkx)+chip('bank','Banking apps',lkx)+chip('admin','Admin prompts',lkx)+
     '</div></div>'+
   '</div></div>');
  var cards=$$('.set-card',det);
  cards[0].parentNode.insertBefore(cu,cards[0].nextSibling);
  setTimeout(function(){var m=$('.set-main');if(m)m.scrollTop=det.offsetTop-24;},50);
  return;
}

/* ================= chat screens ================= */
var pane=$('.pane');
$('.three-col').classList.add('cu-collapsed');
$('.three-col').appendChild(el('<button type="button" class="sidebar-expand-btn cu-expand" aria-label="Expand sidebar">'+sv(I.right)+'</button>'));
function setChat(title,crumb){$('[data-testid=chat-title]').textContent=title;$('[data-testid=folder-path]').textContent=crumb[0];$('[data-testid=chat-host]').textContent=crumb[1];}
function msgs(list){
  var stream=$('.chat-stream-content'),uT=$('.msg-user',stream),aT=$('.msg-assistant',stream),gT=$('.tool-group',stream);
  stream.innerHTML='';
  list.forEach(function(m){
    var n;
    if(m[0]==='t'||m[0]==='r'){n=gT.cloneNode(true);n.querySelector('.tool-summary-text').textContent=m[1];
      if(m[0]==='r')n.querySelector('.tool-summary').appendChild(el('<span class="tool-running">'+sv(I.loader,14).replace('<svg ','<svg class="tool-running-spinner" ')+'</span>'));}
    else if(m[0]==='h'){n=el(m[1]);}
    else{n=(m[0]==='u'?uT:aT).cloneNode(true);$$('.msg-edit',n).forEach(function(x){x.remove();});n.querySelector('.content').innerHTML=m[1];}
    stream.appendChild(n);
  });
}

/* --- the screens inside the live view (drawn at 1280×800, scaled to fit) --- */
var MENU='<div class="mac-menu"><span class="mac-apple"><svg viewBox="0 0 17 20" width="13" height="15"><path fill="currentColor" d="M14.1 10.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9C3.6 4.8 2 5.8 1.1 7.4c-1.9 3.3-.5 8.1 1.3 10.8.9 1.3 1.9 2.7 3.3 2.7 1.3-.1 1.8-.9 3.4-.9s2 .9 3.4.8c1.4 0 2.3-1.3 3.2-2.6 1-1.5 1.4-2.9 1.4-3-.1 0-2.9-1.1-3-4.6zM11.5 3c.7-.9 1.2-2.1 1.1-3.3-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.2 1.2.1 2.3-.6 3-1.5z"/></svg></span><b>{app}</b><span>File</span><span>Edit</span><span>View</span><span>Window</span><span>Help</span><span class="mac-flex"></span>'+
  '<span class="mac-mi"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1"/></svg></span>'+
  '<span class="mac-mi mac-batt"><i></i></span><span class="mac-mi"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></span><span>Tue 7 Oct&nbsp; {time}</span></div>';
function traffic(){return '<span class="mac-tl"><i></i><i></i><i></i></span>';}
function cursor(cls,x,y,label,lp){return '<div class="cu-cur '+(cls||'')+(lp?' lp-'+lp:'')+'" style="left:'+x+'px;top:'+y+'px"><svg viewBox="0 0 20 24" width="26" height="31"><path d="M2 1.5v18.2l4.6-4.4 3 6.9 3.2-1.4-3-6.8h6.5z" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>'+(label?'<span>'+label+'</span>':'')+'</div>';}

function sysSettings(){
  var side=[['Wi-Fi','#2f7cf6'],['Bluetooth','#2f7cf6'],['Network','#2f7cf6'],['Battery','#34c759'],['General','#8e8e93'],['Accessibility','#2f7cf6'],['Appearance','#1c1c1e'],['Control Centre','#8e8e93'],['Desktop & Dock','#1c1c1e'],['Displays','#2f7cf6'],['Screen Saver','#5ac8fa'],['Wallpaper','#5ac8fa'],['Notifications','#ff3b30'],['Sound','#ff2d55'],['Focus','#5e5ce6'],['Screen Time','#5e5ce6'],['Lock Screen','#1c1c1e'],['Privacy & Security','#2f7cf6'],['Touch ID & Password','#ff3b30']];
  var sizes=['Larger Text','','Default','','More Space'];
  return '<div class="mac">'+MENU.replace('{app}','System Settings').replace('{time}','14:32')+
   '<div class="mac-win ss" style="left:96px;top:48px;width:832px;height:566px">'+
    '<div class="ss-side">'+traffic()+'<div class="ss-search">'+sv(I.search,13)+'Search</div>'+
     '<div class="ss-acct"><span class="ss-av">TC</span><div><b>Tom Chambers</b><span>Apple Account</span></div></div>'+
     side.map(function(x){return '<div class="ss-it'+(x[0]==='Displays'?' on':'')+'"><i style="background:'+x[1]+'"></i>'+x[0]+'</div>';}).join('')+
    '</div>'+
    '<div class="ss-main"><div class="ss-bar"><span class="ss-nav">‹ ›</span><b>Displays</b></div>'+
     '<div class="ss-body">'+
      '<div class="ss-disp"><div class="ss-mon"><i></i></div><b>Built-in Liquid Retina XDR Display</b><span>14-inch (3024 × 1964)</span></div>'+
      '<div class="ss-grp"><div class="ss-row ss-sizes">'+sizes.map(function(t,i){return '<div class="ss-size'+(i===4?' sel':'')+'"><div class="ss-thumb'+(i===4?' cu-target':'')+'" style="transform:scale('+(0.78+i*0.055)+')"><i></i></div><span>'+t+'</span></div>';}).join('')+'</div></div>'+
      '<div class="ss-grp">'+
       '<div class="ss-row"><span>Brightness</span><span class="ss-slider"><i style="width:68%"></i><b style="left:68%"></b></span></div>'+
       '<div class="ss-row"><span>Automatically adjust brightness</span><span class="ss-tg on"></span></div>'+
       '<div class="ss-row"><span>True Tone</span><span class="ss-tg on"></span></div>'+
      '</div>'+
      '<div class="ss-grp">'+
       '<div class="ss-row"><span>Colour profile</span><span class="ss-pop">Apple XDR Display (P3-1600 nits) ⌃</span></div>'+
       '<div class="ss-row"><span>Refresh rate</span><span class="ss-pop">ProMotion ⌃</span></div>'+
      '</div>'+
      '<div class="ss-foot"><span class="ss-btn">Advanced…</span><span class="ss-btn">Night Shift…</span><span class="ss-q">?</span></div>'+
     '</div>'+
    '</div>'+
   '</div>'+
  '</div>';
}

function whatsapp(){
  var chats=[['Ruth Chambers','You: Ok see you there','14:10','#c58b6b',1],['Eleanor Dolan','Photo','13:52','#7b9e87'],['Rob Dolan','Are you around Saturday?','12:30','#6d84b4'],['Broad Walk neighbours','Lindsay: Bins are Thursday this week','11:04','#b49a6d'],['Joe Shellard','👍','Yesterday','#9a6db4'],['Lindsay Ruddock','Thanks!','Yesterday','#b46d7f']];
  return '<div class="mac">'+MENU.replace('{app}','WhatsApp').replace('{time}','17:48')+
   '<div class="mac-win wa" style="left:40px;top:44px;width:944px;height:576px">'+
    '<div class="wa-list"><div class="wa-lh">'+traffic()+'<b>Chats</b></div><div class="wa-search">'+sv(I.search,13)+'Search or start a new chat</div>'+
     chats.map(function(c){return '<div class="wa-chat'+(c[4]?' on':'')+'"><span class="wa-av" style="background:'+c[3]+'">'+c[0].split(' ').map(function(w){return w[0];}).join('').slice(0,2)+'</span><div><div class="wa-r1"><b>'+c[0]+'</b><span>'+c[2]+'</span></div><div class="wa-r2">'+c[1]+'</div></div></div>';}).join('')+
    '</div>'+
    '<div class="wa-conv"><div class="wa-ch"><span class="wa-av" style="background:#c58b6b">RC</span><b>Ruth Chambers</b></div>'+
     '<div class="wa-msgs"><div class="wa-day">Today</div>'+
      '<div class="wa-b in">What time are you leaving work?<span>13:58</span></div>'+
      '<div class="wa-b out">About 5:30, meet you at the restaurant at 6<span>14:06</span></div>'+
      '<div class="wa-b in">Ok see you there<span>14:10</span></div>'+
     '</div>'+
     '<div class="wa-compose"><span class="wa-plus">+</span><div class="wa-input">Running 10 minutes late, sorry!<i class="caret"></i></div><span class="wa-send cu-target">'+sv(I.right,18).replace('stroke-width="2"','stroke-width="2.5"')+'</span></div>'+
    '</div>'+
   '</div>'+
  '</div>';
}

function spotify(){
  return '<div class="mac">'+MENU.replace('{app}','Spotify').replace('{time}','09:15')+
   '<div class="mac-win sp" style="left:132px;top:42px;width:760px;height:580px">'+
    '<div class="sp-top">'+traffic()+'</div>'+
    '<div class="sp-card">'+
     '<div class="sp-logo">'+APP.spotify+'</div>'+
     '<h3>Log in to Spotify</h3>'+
     '<div class="sp-alt">Continue with Google</div><div class="sp-alt">Continue with Apple</div>'+
     '<div class="sp-hr"></div>'+
     '<label>Email or username</label><div class="sp-in">tomchambers</div>'+
     '<label>Password</label><div class="sp-in focus cu-target">•••••••••••<i class="caret"></i></div>'+
     '<div class="sp-btn">Log In</div>'+
     '<div class="sp-link">Forgot your password?</div>'+
    '</div>'+
   '</div>'+
  '</div>';
}

function linux(){
  var inv=[['INV-2026-10-0182','01.10.2026','€13.04'],['INV-2026-09-0177','01.09.2026','€13.04'],['INV-2026-08-0171','01.08.2026','€13.04'],['INV-2026-07-0166','01.07.2026','€9.10'],['INV-2026-06-0160','01.06.2026','€9.10']];
  return '<div class="lnx"><div class="lnx-bar"><span>Activities</span><span class="lnx-mid">Tue 7 Oct&nbsp; 10:41</span><span class="lnx-sys">'+sv('<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1"/>',14)+sv('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',14)+sv('<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><path d="M12 2v10"/>',14)+'</span></div>'+
   '<div class="lnx-win cr" style="left:28px;top:46px;width:968px;height:594px">'+
    '<div class="cr-tabs"><div class="cr-tab on">'+APP.chromium+'Invoices · netcup CCP<span>×</span></div><div class="cr-tab new">+</div><span class="mac-flex"></span><span class="cr-wc">–</span><span class="cr-wc">▢</span><span class="cr-wc">×</span></div>'+
    '<div class="cr-bar"><span class="cr-nav">←&nbsp; →&nbsp; ↻</span><div class="cr-url">'+sv(I.lock,12)+'customercontrolpanel.de/rechnungen.php</div></div>'+
    '<div class="nc"><div class="nc-head"><b>netcup</b><span class="mac-flex"></span><span>Customer 228914</span><span>Log out</span></div>'+
     '<div class="nc-body"><nav class="nc-nav"><span>Overview</span><span>Products</span><span class="on">Invoices</span><span>Master data</span><span>Payment</span><span>Support</span></nav>'+
      '<div class="nc-main"><h2>Invoices</h2><table><thead><tr><th>Invoice</th><th>Date</th><th>Amount</th><th>Status</th><th>PDF</th></tr></thead><tbody>'+
       inv.map(function(r,i){return '<tr><td>'+r[0]+'</td><td>'+r[1]+'</td><td>'+r[2]+'</td><td><span class="nc-paid">'+(i===0?'Open':'Paid')+'</span></td><td><span class="nc-pdf'+(i===0?' cu-target':'')+'">PDF</span></td></tr>';}).join('')+
      '</tbody></table></div></div></div>'+
   '</div>'+
  '</div>';
}

/* --- the Computer pane --- */
function computerPane(o){
  var hostIc=o.server?I.server:I.monitor;
  var head='<header class="cu-head">'+
    '<button type="button" class="cu-host'+(o.menu?' open':'')+'">'+sv(hostIc,16)+'<b>'+o.host+'</b><span class="cu-mode">'+o.mode+'</span>'+sv(I.down,14)+'</button>'+
    '<span class="cu-app">'+APP[o.appIc]+'<span>'+o.app+'</span></span>'+
    '<span class="cu-flex"></span>'+
    (o.control?'<button type="button" class="cu-handback">'+sv(I.back,16)+'Hand back</button>':'<button type="button" class="cu-takeover">'+sv(I.hand,16)+'Take over</button>')+
    '<button type="button" class="head-action cu-close" aria-label="Close">'+sv(I.x,18)+'</button>'+
   '</header>';
  var menu=o.menu?'<div class="cu-menu" role="menu">'+
    '<div class="cu-mi">'+sv(I.monitor,16)+'<div><b>Mac</b><span>Background</span></div><span class="set-dot"></span></div>'+
    '<div class="cu-mi">'+sv(I.monitor,16)+'<div><b>Mac</b><span>Virtual screen</span></div><span class="set-dot"></span></div>'+
    '<div class="cu-mi on">'+sv(I.server,16)+'<div><b>netcup</b><span>Virtual desktop</span></div>'+sv(I.check,16)+'</div>'+
   '</div>':'';
  return el('<div class="pane cu-pane'+(o.control?' is-control':'')+'"><div class="pane-content"><section class="cu">'+head+menu+
    '<div class="cu-stage"><div class="cu-screen'+(o.control?' control':'')+(o.wait?' wait':'')+'"><div class="cu-scale">'+o.screen+'</div>'+
    (o.control?'<span class="cu-yours">'+sv(I.hand,14)+'You</span>':'')+'</div>'+
    '<div class="cu-status'+(o.wait?' wait':'')+(o.control?' paused':'')+'">'+(o.control?sv(I.eyeoff,15):'<span class="cu-dot"></span>')+'<span>'+o.status+'</span></div></div>'+
   '</section></div></div>');
}
function mount(o){
  var p=computerPane(o);
  pane.classList.add('cu-chatpane');
  pane.parentNode.insertBefore(p,pane.nextSibling);
  pane.parentNode.insertBefore(el('<div class="pane-divider"></div>'),p);
  var sc=$('.cu-scale',p),t=$('.cu-target',sc),a=sc.getBoundingClientRect(),b=t.getBoundingClientRect(),c=o.cur;
  var x=b.left-a.left,y=b.top-a.top;
  if(c.ring)sc.appendChild(el('<div class="cu-ring'+(c.ring==='wait'?' wait':'')+'" style="left:'+(x-6)+'px;top:'+(y-6)+'px;width:'+(b.width+12)+'px;height:'+(b.height+12)+'px'+(c.round?';border-radius:50%':'')+'"></div>'));
  sc.appendChild(el(cursor(c.kind,x+b.width*(c.fx||.6),y+b.height*(c.fy||.6),c.label||'',c.lp)));
  var st=$('.chat-stream');st.scrollTop=st.scrollHeight;
  function fit(){sc.style.transform='scale('+(sc.parentNode.clientWidth/1024)+')';}
  fit();window.addEventListener('resize',fit);
}

/* ---------- 1. working: a setting in a native Mac app ---------- */
if(s==='working'){
  setChat('Display settings',['home','Mac']);
  msgs([
   ['u','<p>Turn on Night Shift and set the display to More Space</p>'],
   ['t','Opened System Settings › Displays'],
   ['t','Night Shift › Schedule › Sunset to Sunrise'],
   ['r','Choosing More Space']
  ]);
  mount({host:'Mac',mode:'Background',app:'System Settings',appIc:'settings',screen:sysSettings(),status:'Clicking More Space',cur:{kind:'agent',label:'Patch',ring:1,lp:'u',fx:.5,fy:.55}});
}

/* ---------- 2. approve: a new app, then a risky step ---------- */
if(s==='approve'){
  setChat('Tell Ruth I\'m late',['home','Mac']);
  msgs([
   ['u','<p>Tell Ruth on WhatsApp I\'m running 10 minutes late</p>'],
   ['h','<div class="permission question-card resolved resolved-approve cu-ask" role="group"><div class="question-block"><span class="question-header">Mac</span><p class="question-text cu-ask-q">'+APP.whatsapp+'Use WhatsApp?</p><div class="permission-buttons cu-btns"><button type="button" class="cu-b-dim" disabled>Allow once</button><button type="button" class="cu-b-pick" disabled>'+sv(I.check,14)+'Always on Mac</button><button type="button" class="cu-b-dim" disabled>Deny</button></div></div></div>'],
   ['t','Opened WhatsApp › Ruth Chambers'],
   ['t','Typed the message'],
   ['h','<div class="permission question-card cu-ask" role="group"><div class="question-block"><span class="question-header">WhatsApp · Mac</span><p class="question-text">Send this message?</p>'+
     '<div class="cu-preview"><span class="wa-av sm" style="background:#c58b6b">RC</span><div><b>Ruth Chambers</b><p>Running 10 minutes late, sorry!</p></div></div>'+
     '<div class="permission-buttons cu-btns"><button type="button">Send</button><button type="button" class="cu-b-no">Don\'t send</button></div></div></div>']
  ]);
  mount({host:'Mac',mode:'Background',app:'WhatsApp',appIc:'whatsapp',screen:whatsapp(),status:'Waiting for you',wait:true,cur:{kind:'agent paused',label:'Patch',ring:'wait',round:1,lp:'l'}});
}

/* ---------- 3. takeover: Tom signs in, the agent is not watching ---------- */
if(s==='takeover'){
  setChat('Spotify autoplay',['home','Mac']);
  msgs([
   ['u','<p>Turn off autoplay and crossfade in Spotify</p>'],
   ['t','Opened Spotify'],
   ['a','<p>Spotify wants you to log in.</p>'],
   ['h','<div class="cu-event">'+sv(I.hand,14)+'You took over · 09:15</div>']
  ]);
  mount({host:'Mac',mode:'Background',app:'Spotify',appIc:'spotify',screen:spotify(),status:'Patch paused · not watching',control:true,cur:{kind:'tom',fx:.85,fy:1.3}});
}

/* ---------- 4. server: the same on the Linux server's virtual desktop ---------- */
if(s==='server'){
  setChat('netcup invoice',['portfolio','netcup']);
  msgs([
   ['u','<p>Download October\'s netcup invoice into ~/invoices</p>'],
   ['t','Started a virtual desktop on netcup'],
   ['t','Opened customercontrolpanel.de › Invoices'],
   ['r','Downloading INV-2026-10-0182']
  ]);
  mount({host:'netcup',mode:'Virtual desktop',app:'Chromium',appIc:'chromium',screen:linux(),status:'Clicking PDF',server:true,menu:true,cur:{kind:'agent',label:'Patch',ring:1}});
}

window.addEventListener('hashchange',function(){location.reload();});
})();
