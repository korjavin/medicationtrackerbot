/* Presentation helpers: phone chrome, nav bars, fake keyboard, demo interactions. Vanilla JS. */
(function(){
var V2=[['today','Today','home'],['food','Food','food'],['meds','Meds','pill'],['train','Train','dumbbell'],['health','Health','health']];
var LEG=[['today','Today','home'],['bp','BP','activity'],['food','Food','food'],['meds','Meds','pill'],['vitals','Vitals','health'],['workouts','Workouts','dumbbell'],['weight','Weight','scale'],['settings','Settings','gear']];
function tabs(list,active,badges){return list.map(function(t){var b=badges&&badges[t[0]];return '<button class="wg-tab"'+(t[0]===active?' aria-current="page"':'')+'><i class="wg-ico" data-icon="'+t[2]+'"></i>'+t[1]+(b?'<span class="wg-tab__badge">'+b+'</span>':'')+'</button>';}).join('');}
function parseBadges(s){var o={};(s||'').split(',').forEach(function(p){var kv=p.split(':');if(kv[1])o[kv[0]]=kv[1];});return o;}
function kb(){var r=['qwertyuiop','asdfghjkl','zxcvbnm'];var h='';r.forEach(function(row,i){h+='<div class="kit-kb__row">'+(i===2?'<span class="kit-kb__key kit-kb__key--fn">⇧</span>':'')+row.split('').map(function(c){return '<span class="kit-kb__key">'+c+'</span>';}).join('')+(i===2?'<span class="kit-kb__key kit-kb__key--fn">⌫</span>':'')+'</div>';});h+='<div class="kit-kb__row"><span class="kit-kb__key kit-kb__key--fn">123</span><span class="kit-kb__key kit-kb__key--space">space</span><span class="kit-kb__key kit-kb__key--go">done</span></div>';return h;}
function kbNum(){var h='';[['1','2','3'],['4','5','6'],['7','8','9'],['.','0','⌫']].forEach(function(r){h+='<div class="kit-kb__row">'+r.map(function(c){return '<span class="kit-kb__key kit-kb__key--num">'+c+'</span>';}).join('')+'</div>';});return h;}
function boot(){
document.querySelectorAll('.kit-phone').forEach(function(p){p.insertAdjacentHTML('beforeend','<div class="kit-island"></div><div class="kit-home"></div>');});
document.querySelectorAll('.kit-status').forEach(function(s){if(s.firstChild)return;s.innerHTML='<span>9:41</span><span class="kit-status__r"><i class="wg-ico wg-ico--sm" data-icon="sig"></i><i class="wg-ico wg-ico--sm" data-icon="wifi"></i><i class="wg-ico wg-ico--lg" data-icon="batt"></i></span>';});
document.querySelectorAll('[data-tabbar]').forEach(function(n){n.innerHTML=tabs(V2,n.getAttribute('data-tabbar'),parseBadges(n.getAttribute('data-badges')));});
document.querySelectorAll('[data-tabbar-legacy]').forEach(function(n){n.innerHTML=tabs(LEG,n.getAttribute('data-tabbar-legacy'));});
document.querySelectorAll('.kit-kb').forEach(function(k){k.innerHTML=k.hasAttribute('data-num')?kbNum():kb();});
if(window.wgIcons)wgIcons.hydrate();
requestAnimationFrame(function(){document.querySelectorAll('[data-scroll]').forEach(function(el){el.scrollTop=+el.getAttribute('data-scroll');});});
}
document.addEventListener('click',function(e){
var t=e.target.closest('.wg-seg__opt');if(t){t.parentNode.querySelectorAll('.wg-seg__opt').forEach(function(o){o.setAttribute('aria-pressed',o===t?'true':'false');});return;}
t=e.target.closest('.wg-toggle');if(t){t.setAttribute('aria-checked',t.getAttribute('aria-checked')==='true'?'false':'true');return;}
t=e.target.closest('.wg-choice');if(t&&t.classList.contains('wg-choice--check')){t.setAttribute('aria-pressed',t.getAttribute('aria-pressed')==='true'?'false':'true');return;}if(t){t.parentNode.querySelectorAll('.wg-choice').forEach(function(o){o.setAttribute('aria-pressed',o===t?'true':'false');});return;}
t=e.target.closest('.wg-pick');if(t){var g=t.closest('[data-single]');if(g){g.querySelectorAll('.wg-pick').forEach(function(o){o.setAttribute('aria-pressed',o===t?'true':'false');});}else{t.setAttribute('aria-pressed',t.getAttribute('aria-pressed')==='true'?'false':'true');}return;}
t=e.target.closest('.wg-set__done');if(t){t.closest('.wg-set').classList.toggle('wg-set--done');return;}
t=e.target.closest('[data-swipe-demo]');if(t){t.closest('.wg-swipe').classList.toggle('wg-swipe--open');}
});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
