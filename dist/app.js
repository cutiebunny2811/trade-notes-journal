const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const STORAGE = { trades: 'trade-notes:v1:trades', setups: 'trade-notes:v1:setups' };
const EMOJIS = ['😣','😟','😐','🙂','😎'];
const emotionLabels = { before:'ก่อนเข้า', during:'ระหว่างถือ', after:'หลังปิด' };
const seedSetups = ['Breakout + Retest','Liquidity Sweep','Trend Pullback'];
let setups = JSON.parse(localStorage.getItem(STORAGE.setups) || 'null') || seedSetups;
let trades = JSON.parse(localStorage.getItem(STORAGE.trades) || '[]');
let activeFilter = 'all';
let pendingImages = [];
let viewerImages = [];
let viewerIndex = 0;

function save(){ localStorage.setItem(STORAGE.trades, JSON.stringify(trades)); localStorage.setItem(STORAGE.setups, JSON.stringify(setups)); }
function money(n){ const abs = Math.abs(Number(n)); return `${n > 0 ? '+' : n < 0 ? '−' : ''}฿${abs.toLocaleString('th-TH',{maximumFractionDigits:2})}`; }
function escapeHTML(v=''){ return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function localDateValue(d=new Date()){ const x=new Date(d.getTime()-d.getTimezoneOffset()*60000); return x.toISOString().slice(0,16); }
function dateParts(value){ const d=new Date(value); return {day:d.toLocaleDateString('th-TH',{day:'2-digit'}),month:d.toLocaleDateString('en-US',{month:'short'}).toUpperCase(),time:d.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'})}; }
function toast(msg){ const el=$('#toast'); el.textContent=msg; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),2200); }

function render(){
  const filtered=trades.filter(t=>activeFilter==='all'||(activeFilter==='pending'?(t.status==='pending'):(t.status!=='pending'&&(activeFilter==='win'?t.pl>=0:t.pl<0)))).sort((a,b)=>new Date(b.date)-new Date(a.date));
  $('#tradeList').innerHTML=filtered.map(t=>{const d=dateParts(t.date);return `<article class="trade-row" data-id="${t.id}">
    <div class="trade-date"><strong>${d.day}</strong><span>${d.month}</span></div>
    <div class="symbol-cell"><strong>${escapeHTML(t.symbol)} <span class="direction ${t.direction.toLowerCase()}">${t.direction}</span>${t.status==='pending'?'<span class="status-chip">PENDING</span>':''}</strong><small>${d.time} น.</small></div>
    <div><span class="setup-chip">${escapeHTML(t.setup||'No setup')}</span></div>
    <div class="emotion-triplet" title="ก่อน / ระหว่าง / หลัง">${EMOJIS[t.emotions.before-1]}${EMOJIS[t.emotions.during-1]}${t.emotions.after?EMOJIS[t.emotions.after-1]:'·'}</div>
    <div class="pl-cell ${t.status==='pending'?'pending-pl':(t.pl>=0?'win':'loss')}">${t.status==='pending'?'กำลังถือ':money(t.pl)}</div>
    <div class="thumb-stack">${(t.images||[]).slice(0,2).map((src,i)=>`<img src="${src}" alt="ภาพออเดอร์ ${i+1}">`).join('')}</div>
    <button class="more-btn" aria-label="แก้ไข">›</button>
  </article>`}).join('');
  $('#emptyState').hidden=filtered.length>0;
  const closed=trades.filter(t=>t.status!=='pending'), pending=trades.filter(t=>t.status==='pending');
  const net=closed.reduce((s,t)=>s+Number(t.pl),0), wins=closed.filter(t=>t.pl>0);
  $('#netPL').textContent=money(net); $('#netPL').className=net>=0?'positive':'negative';
  $('#netCaption').textContent=`${closed.length} ปิดแล้ว${pending.length?' · '+pending.length+' กำลังถือ':''}`; $('#winRate').textContent=closed.length?`${Math.round(wins.length/closed.length*100)}%`:'—';
  $('#avgWin').textContent=wins.length?money(wins.reduce((s,t)=>s+Number(t.pl),0)/wins.length):'—';
  const bySetup={}; closed.forEach(t=>{if(!bySetup[t.setup])bySetup[t.setup]={pl:0,n:0};bySetup[t.setup].pl+=Number(t.pl);bySetup[t.setup].n++});
  const best=Object.entries(bySetup).sort((a,b)=>b[1].pl-a[1].pl)[0]; $('#bestSetup').textContent=best?.[0]||'—'; $('#bestSetupCaption').textContent=best?`${money(best[1].pl)} / ${best[1].n} เทรด`:'ยังไม่มีข้อมูล';
  renderEmotionSummary(); renderSetupOptions(); renderSetupList();
}
function renderEmotionSummary(){
  const rows=['before','during','after'].map(k=>{const entries=trades.filter(t=>t.emotions[k]);const avg=entries.length?entries.reduce((s,t)=>s+t.emotions[k],0)/entries.length:3; const value=Math.round(avg);return `<div class="emotion-line"><div class="emotion-line-head"><strong>${emotionLabels[k]}</strong><span>${EMOJIS[value-1]}</span></div><div class="meter"><i style="width:${avg/5*100}%"></i></div></div>`});
  $('#emotionSummary').innerHTML=rows.join('');
  if(trades.length>2){const losing=trades.filter(t=>t.pl<0); const tense=losing.length&&losing.reduce((s,t)=>s+t.emotions.during,0)/losing.length<3; $('#coachText').textContent=tense?'เทรดที่ขาดทุนมักมีอารมณ์ตึงระหว่างถือ ลองกำหนดจุดออกให้ชัดก่อนกดเข้า':'วินัยกำลังดูดี ทบทวนบันทึกหลังปิดออเดอร์เพื่อรักษา pattern นี้ไว้';}
}
function renderSetupOptions(selected){ const sel=$('#setup'); sel.innerHTML=setups.map(x=>`<option ${x===selected?'selected':''}>${escapeHTML(x)}</option>`).join('')+`<option value="">— ไม่ระบุ —</option>`; }
function renderSetupList(){ $('#setupList').innerHTML=setups.map((x,i)=>`<div class="setup-item"><div><strong>${escapeHTML(x)}</strong><br><small>${trades.filter(t=>t.setup===x).length} บันทึก</small></div><button class="delete-setup" data-index="${i}" ${trades.some(t=>t.setup===x)?'title="ลบได้โดยบันทึกเก่าจะยังคงชื่อเดิม"':''}>ลบ</button></div>`).join(''); }
function renderEmotionForm(values={before:3,during:3,after:3}){ $('#emotionForm').innerHTML=Object.entries(emotionLabels).map(([k,label])=>`<div class="emotion-field" data-emotion="${k}"><strong>${label}</strong><div class="emoji-picker">${EMOJIS.map((e,i)=>`<button type="button" class="${(values[k]??3)===i+1?'selected':''}" data-value="${i+1}" title="ระดับ ${i+1}">${e}</button>`).join('')}</div></div>`).join(''); updateStatusFields(); }
function updateStatusFields(){ const pending=$('#tradeStatus').value==='pending';$('#pl').required=!pending;$('#plField').classList.toggle('is-disabled',pending);$('[data-emotion="after"]')?.classList.toggle('is-disabled',pending); }
function openTrade(trade){
  $('#tradeForm').reset(); pendingImages=trade?.images?[...trade.images]:[]; $('#tradeId').value=trade?.id||''; $('#formTitle').textContent=trade?'ดูและแก้ไขบันทึก':'บันทึกเทรด';
  $('#symbol').value=trade?.symbol||''; $('#tradeStatus').value=trade?.status||(trade?'closed':'pending'); $('#direction').value=trade?.direction||'LONG'; $('#tradeDate').value=trade?.date?.slice(0,16)||localDateValue(); $('#pl').value=trade?.pl??''; $('#notes').value=trade?.notes||'';
  renderSetupOptions(trade?.setup); renderEmotionForm(trade?.emotions); renderPreviews(); openModal('trade');
}
function openModal(which){ $(`#${which}Modal`).classList.add('open'); $(`#${which}Modal`).setAttribute('aria-hidden','false'); document.body.classList.add('modal-open'); }
function closeModal(which){ $(`#${which}Modal`).classList.remove('open'); $(`#${which}Modal`).setAttribute('aria-hidden','true'); document.body.classList.remove('modal-open'); }

$('#tradeForm').addEventListener('submit',e=>{e.preventDefault(); const status=$('#tradeStatus').value;const emotions={}; $$('.emotion-field').forEach(f=>emotions[f.dataset.emotion]=f.dataset.emotion==='after'&&status==='pending'?null:Number($('.selected',f).dataset.value)); const id=$('#tradeId').value||crypto.randomUUID(); const old=trades.find(t=>t.id===id); const trade={id,status,symbol:$('#symbol').value.trim().toUpperCase(),direction:$('#direction').value,date:$('#tradeDate').value,pl:status==='pending'?null:Number($('#pl').value),setup:$('#setup').value,emotions,notes:$('#notes').value.trim(),images:pendingImages.length?pendingImages:(old?.images||[])}; trades=old?trades.map(t=>t.id===id?trade:t):[trade,...trades];save();render();closeModal('trade');toast(status==='pending'?'บันทึกเป็นออเดอร์กำลังถือแล้ว':'บันทึกเทรดแล้ว ✓');});
$('#setupForm').addEventListener('submit',e=>{e.preventDefault();const name=$('#newSetupName').value.trim();if(!name)return;if(setups.some(x=>x.toLowerCase()===name.toLowerCase()))return toast('มี Setup ชื่อนี้แล้ว');setups.push(name);$('#newSetupName').value='';save();render();toast('เพิ่ม Setup แล้ว');});
$('#screenshots').addEventListener('change',async e=>{const files=[...e.target.files].slice(0,3);pendingImages=await Promise.all(files.map(file=>new Promise(resolve=>{const img=new Image(),reader=new FileReader();reader.onload=()=>{img.onload=()=>{const c=document.createElement('canvas'),max=1200,scale=Math.min(1,max/img.width);c.width=img.width*scale;c.height=img.height*scale;c.getContext('2d').drawImage(img,0,0,c.width,c.height);resolve(c.toDataURL('image/jpeg',.76));};img.src=reader.result};reader.readAsDataURL(file)})));renderPreviews();});
$('#tradeStatus').addEventListener('change',updateStatusFields);
function renderPreviews(){ $('#imagePreviews').innerHTML=(pendingImages.length?'<div class="saved-images-label">ภาพที่บันทึกไว้ — แตะภาพเพื่อดูขนาดเต็ม</div>':'')+pendingImages.map((src,i)=>`<div class="preview-wrap"><img src="${src}" alt="ภาพออเดอร์ ${i+1}" data-view-image="${i}"><button type="button" data-remove-image="${i}" aria-label="ลบภาพ ${i+1}">×</button></div>`).join(''); }
function openImageViewer(images,index=0){ viewerImages=images;viewerIndex=index;updateViewer();$('#imageViewer').classList.add('open');$('#imageViewer').setAttribute('aria-hidden','false'); }
function updateViewer(){ if(!viewerImages.length)return closeImageViewer();viewerIndex=(viewerIndex+viewerImages.length)%viewerImages.length;$('#viewerImage').src=viewerImages[viewerIndex];$('#viewerCount').textContent=`${viewerIndex+1} / ${viewerImages.length}`;$('.viewer-prev').hidden=viewerImages.length<2;$('.viewer-next').hidden=viewerImages.length<2; }
function closeImageViewer(){ $('#imageViewer').classList.remove('open');$('#imageViewer').setAttribute('aria-hidden','true'); }
document.addEventListener('click',e=>{
  const close=e.target.closest('[data-close]'); if(close)closeModal(close.dataset.close);
  if(e.target.closest('#newTradeBtn')||e.target.closest('#emptyAddBtn'))openTrade();
  if(e.target.closest('#quickAddSetup'))openModal('setup');
  const nav=e.target.closest('.nav-item');if(nav){$$('.nav-item').forEach(x=>x.classList.remove('active'));nav.classList.add('active');if(nav.dataset.view==='setups')openModal('setup');if(nav.dataset.view==='insights'){toast('Insights แบบละเอียดจะมาใน V2');$$('.nav-item')[0].classList.add('active');nav.classList.remove('active');}}
  const emo=e.target.closest('.emoji-picker button');if(emo){$$('button',emo.parentElement).forEach(x=>x.classList.remove('selected'));emo.classList.add('selected');}
  const row=e.target.closest('.trade-row');if(row)openTrade(trades.find(t=>t.id===row.dataset.id));
  const filter=e.target.closest('.filter');if(filter){activeFilter=filter.dataset.filter;$$('.filter').forEach(x=>x.classList.remove('active'));filter.classList.add('active');render();}
  const del=e.target.closest('.delete-setup');if(del){setups.splice(Number(del.dataset.index),1);save();render();}
  const rm=e.target.closest('[data-remove-image]');if(rm){pendingImages.splice(Number(rm.dataset.removeImage),1);renderPreviews();}
  const view=e.target.closest('[data-view-image]');if(view)openImageViewer(pendingImages,Number(view.dataset.viewImage));
  if(e.target.closest('.viewer-close')||e.target.id==='imageViewer')closeImageViewer();
  if(e.target.closest('.viewer-prev')){viewerIndex--;updateViewer();}
  if(e.target.closest('.viewer-next')){viewerIndex++;updateViewer();}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeImageViewer();$$('.modal.open').forEach(m=>closeModal(m.id.replace('Modal','')))}if($('#imageViewer').classList.contains('open')&&e.key==='ArrowLeft'){viewerIndex--;updateViewer()}if($('#imageViewer').classList.contains('open')&&e.key==='ArrowRight'){viewerIndex++;updateViewer()}});
$('#todayLabel').textContent=new Date().toLocaleDateString('en-US',{month:'short',year:'numeric'}).toUpperCase();
renderEmotionForm();render();
