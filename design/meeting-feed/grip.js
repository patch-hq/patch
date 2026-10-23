(function(){var g=document.querySelector('.grip'),m=document.querySelector('.meeting');if(!g||!m)return;
g.addEventListener('pointerdown',function(e){g.setPointerCapture(e.pointerId);var y0=e.clientY,h0=m.offsetHeight;
function mv(ev){m.style.height=Math.max(120,Math.min(window.innerHeight-160,h0+ev.clientY-y0))+'px'}
function up(){g.removeEventListener('pointermove',mv);g.removeEventListener('pointerup',up)}
g.addEventListener('pointermove',mv);g.addEventListener('pointerup',up)});
var f=document.querySelector('.feed');if(f)f.scrollTop=f.scrollHeight;})();
