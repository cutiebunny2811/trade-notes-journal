const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const STORAGE = { trades: 'trade-notes:v1:trades', setups: 'trade-notes:v1:setups' };
const CLOUD_URL = 'https://yfbbpertvtmwfadfldia.supabase.co';
const CLOUD_KEY = 'sb_publishable_-zWhSbG4lfuTqd1T6o2P4A_D_CveFwH';
const cloud = window.supabase?.createClient(CLOUD_URL, CLOUD_KEY);
let cloudUser = null;
let cloudReady = false;
let loadingUserId = null;
const TRADE_EMOTIONS = [
  { id:'confident', label:'Confident', thai:'มั่นใจ', mark:'↗' },
  { id:'anxious', label:'Anxious', thai:'กังวล', mark:'≈' },
  { id:'hesitant', label:'Hesitant', thai:'ลังเล', mark:'◇' },
  { id:'fomo', label:'FOMO', thai:'กลัวตกรถ', mark:'⚡' }
];
const EXIT_EMOTIONS = [
  { id:'satisfied', label:'Satisfied', thai:'พึงพอใจ', mark:'✓' },
  { id:'proud', label:'Proud', thai:'ภูมิใจ', mark:'◆' },
  { id:'disappointed', label:'Disappointed', thai:'ผิดหวัง', mark:'↓' },
  { id:'regretful', label:'Regretful', thai:'เสียดาย', mark:'↩' }
];
const EMOTIONS = TRADE_EMOTIONS;
const ASSETS = [
  {id:'gold',label:'ทอง',english:'GOLD'},
  {id:'stock',label:'หุ้น',english:'STOCK'},
  {id:'option',label:'ออปชั่น',english:'OPTIONS'},
  {id:'crypto',label:'คริปโต',english:'CRYPTO'}
];
const emotionLabels = { before:'ก่อนเข้า', during:'ระหว่างถือ', after:'หลังปิด' };
const seedSetups = ['Breakout + Retest','Liquidity Sweep','Trend Pullback'];
let setups = JSON.parse(localStorage.getItem(STORAGE.setups) || 'null') || seedSetups;
let trades = JSON.parse(localStorage.getItem(STORAGE.trades) || '[]');
let activeFilter = 'all';
let activeMarket = 'all';
let searchQuery = '';
let activeView = 'journal';
let pendingImages = [];
let viewerImages = [];
let viewerIndex = 0;

function save(){ localStorage.setItem(STORAGE.trades, JSON.stringify(trades)); localStorage.setItem(STORAGE.setups, JSON.stringify(setups)); }
function cloudError(error){ throw new Error(error?.message || 'เชื่อมต่อ Supabase ไม่สำเร็จ'); }
function dataUrlBlob(src){ const [header,body]=src.split(',');const mime=header.match(/data:([^;]+)/)?.[1]||'image/jpeg';const bytes=atob(body),array=new Uint8Array(bytes.length);for(let i=0;i<bytes.length;i++)array[i]=bytes.charCodeAt(i);return new Blob([array],{type:mime}); }
async function imageUrl(path){const {data,error}=await cloud.storage.from('trade-images').createSignedUrl(path,86400);if(error)cloudError(error);return data.signedUrl;}
async function prepareRemoteTrade(trade,old,importing=false){
  const imagePaths=[];
  for(const [imageIndex,src] of (trade.images||[]).entries()){
    if(src.startsWith('data:')){const path=`${cloudUser.id}/${trade.id}/${importing?`import-${imageIndex}`:crypto.randomUUID()}.jpg`;const {error}=await cloud.storage.from('trade-images').upload(path,dataUrlBlob(src),{contentType:'image/jpeg',upsert:false});if(error&&!(importing&&String(error.statusCode)==='409'))cloudError(error);imagePaths.push(path);}
    else {const index=old?.images?.indexOf(src)??-1;if(index>=0&&old.imagePaths?.[index])imagePaths.push(old.imagePaths[index]);}
  }
  return {...trade,imagePaths};
}
async function persistTrade(trade,old,importing=false){
  const prepared=await prepareRemoteTrade(trade,old,importing);
  const {images,imagePaths,...clean}=prepared;
  const {error}=await cloud.from('journal_trades').upsert({id:trade.id,user_id:cloudUser.id,data:{...clean,imagePaths},updated_at:new Date().toISOString()});if(error)cloudError(error);
  return {...trade,imagePaths};
}
async function loadCloud(){
  if(!cloudUser)return;
  const [{data:remoteTrades,error:tradeError},{data:remoteSetups,error:setupError}]=await Promise.all([
    cloud.from('journal_trades').select('id,data').order('created_at',{ascending:false}),
    cloud.from('journal_setups').select('name').order('created_at',{ascending:true})
  ]);
  if(tradeError)cloudError(tradeError);if(setupError)cloudError(setupError);
  const previousOwner=localStorage.getItem('trade-notes:cloud-owner');
  const canImport=!previousOwner||previousOwner===cloudUser.id;
  const localTrades=canImport?[...trades]:[],localSetups=canImport?[...setups]:[];
  if(canImport&&!localStorage.getItem('trade-notes:v1:pre-cloud-backup')){
    const original=localStorage.getItem(STORAGE.trades);
    if(original&&localTrades.length)try{localStorage.setItem('trade-notes:v1:pre-cloud-backup',original);}catch(_error){/* Keep the original key until the first new save if browser storage is full. */}
  }
  const remoteIds=new Set(remoteTrades.map(row=>row.id));
  const missing=localTrades.filter(t=>!remoteIds.has(t.id));
  for(const trade of missing)await persistTrade(trade,null,true);
  const remoteNames=new Set(remoteSetups.map(row=>row.name));
  for(const name of localSetups.filter(name=>!remoteNames.has(name))){const {error}=await cloud.from('journal_setups').insert({user_id:cloudUser.id,name});if(error&&error.code!=='23505')cloudError(error);}
  const [{data:allTrades,error:reloadError},{data:allSetups,error:reloadSetupError}]=await Promise.all([
    cloud.from('journal_trades').select('id,data').order('created_at',{ascending:false}),cloud.from('journal_setups').select('name').order('created_at',{ascending:true})
  ]);
  if(reloadError)cloudError(reloadError);if(reloadSetupError)cloudError(reloadSetupError);
  trades=await Promise.all(allTrades.map(async row=>{const data=row.data||{},imagePaths=data.imagePaths||[];return {...data,id:row.id,imagePaths,images:await Promise.all(imagePaths.map(imageUrl))};}));
  setups=allSetups.map(row=>row.name);
  cloudReady=true;localStorage.setItem('trade-notes:cloud-owner',cloudUser.id);render();
  $('#authGate').hidden=true;$('#syncStatus').textContent='DATA · SUPABASE';$('#signOutBtn').hidden=false;
  if(missing.length)toast(`ย้ายบันทึกเดิม ${missing.length} รายการขึ้นคลาวด์แล้ว`);
}
async function acceptSession(session){
  if(!session?.user){cloudUser=null;cloudReady=false;$('#authGate').hidden=false;$('#syncStatus').textContent='DATA · SIGN IN REQUIRED';$('#signOutBtn').hidden=true;return;}
  if((cloudReady&&cloudUser?.id===session.user.id)||loadingUserId===session.user.id)return;
  loadingUserId=session.user.id;
  cloudUser=session.user;$('#authMessage').textContent='กำลังโหลดบันทึก…';
  try{await loadCloud();}catch(error){$('#authGate').hidden=false;$('#authMessage').textContent=`โหลดข้อมูลไม่สำเร็จ: ${error.message}`;}finally{loadingUserId=null;}
}
function money(n){ const abs = Math.abs(Number(n)); return `${n > 0 ? '+' : n < 0 ? '−' : ''}$${abs.toLocaleString('en-US',{maximumFractionDigits:2})}`; }
function emotionOptions(stage){ return stage==='after'?EXIT_EMOTIONS:TRADE_EMOTIONS; }
function normalizeEmotion(value,stage='before'){
  const options=emotionOptions(stage);if(options.some(e=>e.id===value))return value;if(value==null)return null;
  if(stage==='after'){
    const legacy={confident:'satisfied',anxious:'disappointed',hesitant:'regretful',fomo:'regretful'};
    if(legacy[value])return legacy[value];
    const n=Number(value);return n<=2?'disappointed':n===3?'regretful':n===4?'satisfied':'proud';
  }
  const n=Number(value);return n<=2?'anxious':n===3?'hesitant':'confident';
}
function emotionMini(value,stage,label){ const id=normalizeEmotion(value,stage);if(!id)return '<span class="emotion-dot is-empty" title="ยังไม่บันทึก"></span>';const e=emotionOptions(stage).find(x=>x.id===id);return `<span class="emotion-dot emotion-${id}" title="${label}: ${e.label}"></span>`; }
function escapeHTML(v=''){ return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function localDateValue(d=new Date()){ const x=new Date(d.getTime()-d.getTimezoneOffset()*60000); return x.toISOString().slice(0,16); }
function dateParts(value){ const d=new Date(value); return {day:d.toLocaleDateString('th-TH',{day:'2-digit'}),month:d.toLocaleDateString('en-US',{month:'short'}).toUpperCase(),time:d.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'})}; }
function toast(msg){ const el=$('#toast'); el.textContent=msg; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),2200); }
function tradeAsset(trade){
  if(ASSETS.some(asset=>asset.id===trade.assetClass))return trade.assetClass;
  const symbol=String(trade.symbol||'').toUpperCase();
  if(/^(XAU|GOLD)/.test(symbol))return 'gold';
  if(/^(BTC|ETH|SOL|BNB|DOGE|XRP|ADA|AVAX|LTC)/.test(symbol))return 'crypto';
  return 'stock';
}
function assetLabel(id){return ASSETS.find(asset=>asset.id===id)?.label||'ทั้งหมด';}
function scopedTrades(){return trades.filter(t=>(activeMarket==='all'||tradeAsset(t)===activeMarket)&&(!searchQuery||String(t.symbol||'').toUpperCase().includes(searchQuery)));}
function updateAssetFields(){
  const asset=$('#assetClass').value;
  $('#tradeStyleField').hidden=asset!=='stock'&&asset!=='option';
  $('#symbolLabel').textContent=asset==='stock'||asset==='option'?'SYMBOL / ชื่อหุ้น':'SYMBOL / คู่เทรด';
  $('#symbol').placeholder=({gold:'เช่น XAUUSD',stock:'เช่น AAPL หรือ Apple',option:'เช่น AAPL หรือ TSLA',crypto:'เช่น BTCUSDT'})[asset];
}

function render(){
  const scope=scopedTrades();
  const filtered=scope.filter(t=>activeFilter==='all'||(activeFilter==='pending'?(t.status==='pending'):(t.status!=='pending'&&(activeFilter==='win'?t.pl>=0:t.pl<0)))).sort((a,b)=>new Date(b.date)-new Date(a.date));
  $('#tradeList').innerHTML=filtered.map(t=>{const d=dateParts(t.date);return `<article class="trade-row" data-id="${t.id}">
    <div class="trade-date"><strong>${d.day}</strong><span>${d.month}</span></div>
    <div class="symbol-cell"><strong>${escapeHTML(t.symbol)} <span class="direction ${t.direction.toLowerCase()}">${t.direction}</span>${t.status==='pending'?'<span class="status-chip">PENDING</span>':''}</strong><small><span class="asset-tag">${assetLabel(tradeAsset(t))}</span>${t.tradeStyle?`<span class="style-tag">${escapeHTML(t.tradeStyle)}</span>`:''}${d.time} น.</small></div>
    <div class="setup-cell"><span class="setup-chip">${escapeHTML(t.setup||'No setup')}</span></div>
    <div class="emotion-triplet">${emotionMini(t.emotions?.before,'before','ก่อนเข้า')}${emotionMini(t.emotions?.during,'during','ระหว่างถือ')}${emotionMini(t.emotions?.after,'after','หลังปิด')}</div>
    <div class="pl-cell ${t.status==='pending'?'pending-pl':(t.pl>=0?'win':'loss')}">${t.status==='pending'?'กำลังถือ':money(t.pl)}</div>
    <div class="thumb-stack">${(t.images||[]).slice(0,2).map((src,i)=>`<img src="${src}" alt="ภาพออเดอร์ ${i+1}">`).join('')}</div>
    <button class="more-btn" aria-label="แก้ไข">›</button>
  </article>`}).join('');
  $('#emptyState').hidden=filtered.length>0;
  const closed=scope.filter(t=>t.status!=='pending'), pending=scope.filter(t=>t.status==='pending');
  $('#openTradeCount').textContent=pending.length; $('#tradeCount').textContent=`${filtered.length} / ${scope.length} ENTRIES`;
  const net=closed.reduce((s,t)=>s+Number(t.pl),0), wins=closed.filter(t=>t.pl>0);
  $('#netPL').textContent=money(net); $('#netPL').className=net>=0?'positive':'negative';
  $('#netCaption').textContent=`${closed.length} ปิดแล้ว${pending.length?' · '+pending.length+' กำลังถือ':''}`; $('#winRate').textContent=closed.length?`${Math.round(wins.length/closed.length*100)}%`:'—';
  $('#avgWin').textContent=wins.length?money(wins.reduce((s,t)=>s+Number(t.pl),0)/wins.length):'—';
  const bySetup={}; closed.forEach(t=>{if(!bySetup[t.setup])bySetup[t.setup]={pl:0,n:0};bySetup[t.setup].pl+=Number(t.pl);bySetup[t.setup].n++});
  const best=Object.entries(bySetup).sort((a,b)=>b[1].pl-a[1].pl)[0]; $('#bestSetup').textContent=best?.[0]||'—'; $('#bestSetupCaption').textContent=best?`${money(best[1].pl)} / ${best[1].n} เทรด`:'ยังไม่มีข้อมูล';
  renderEmotionSummary(scope); renderSetupOptions(); renderSetupList(); renderInsights(scope);
}
function renderEmotionSummary(scope){
  const rows=['before','during','after'].map(k=>{const options=emotionOptions(k);const values=scope.map(t=>normalizeEmotion(t.emotions?.[k],k)).filter(Boolean);const counts=Object.fromEntries(options.map(e=>[e.id,values.filter(v=>v===e.id).length]));const total=values.length||1;return `<div class="emotion-summary-card"><div class="emotion-line-head"><strong>${emotionLabels[k]}</strong></div><div class="emotion-distribution" aria-label="สัดส่วนอารมณ์ช่วง${emotionLabels[k]}">${options.map(e=>counts[e.id]?`<i class="emotion-${e.id}" style="width:${counts[e.id]/total*100}%" title="${e.label} ${counts[e.id]} ครั้ง"></i>`:'').join('')}</div></div>`});
  $('#emotionSummary').innerHTML=rows.join('');
  const closed=scope.filter(t=>t.status!=='pending');
  const insight=id=>{const entries=closed.filter(t=>normalizeEmotion(t.emotions?.before)===id),net=entries.reduce((sum,t)=>sum+Number(t.pl),0),wins=entries.filter(t=>Number(t.pl)>0).length,rate=entries.length?Math.round(wins/entries.length*100):0,label=EMOTIONS.find(e=>e.id===id).label;return `<article class="emotion-insight-card emotion-${id}"><span>BEFORE ENTRY · ${label.toUpperCase()}</span><strong class="${net>=0?'is-profit':'is-loss'}">${entries.length?money(net):'—'}</strong><small>${entries.length?`${entries.length} เทรด · WIN ${rate}%`:'ยังไม่มีข้อมูลเทรดที่ปิดแล้ว'}</small></article>`};
  $('#emotionInsights').innerHTML=insight('confident')+insight('hesitant');
  if(scope.length>2){const during=scope.map(t=>normalizeEmotion(t.emotions?.during,'during'));const risky=during.filter(x=>x==='anxious'||x==='fomo').length>during.length/2;$('#coachText').textContent=risky?'ช่วงถือออเดอร์มีความกังวลหรือ FOMO บ่อย ลองกำหนดแผนออกก่อนกดเข้า':'ภาพรวมอารมณ์ค่อนข้างนิ่ง ทบทวนบันทึกหลังปิดออเดอร์เพื่อรักษา pattern นี้ไว้';}
  else $('#coachText').textContent='บันทึกเพิ่มอีกหน่อยเพื่อเห็นรูปแบบอารมณ์ที่ชัดขึ้น';
}
function tradeStats(entries){
  const net=entries.reduce((sum,t)=>sum+Number(t.pl||0),0);
  const wins=entries.filter(t=>Number(t.pl)>0).length;
  return {count:entries.length,net,winRate:entries.length?Math.round(wins/entries.length*100):0};
}
function groupedResults(entries,key){
  const groups=new Map();
  entries.forEach(t=>{const name=key(t)||'ไม่ระบุ';if(!groups.has(name))groups.set(name,[]);groups.get(name).push(t);});
  return [...groups].map(([name,items])=>({name,...tradeStats(items)})).sort((a,b)=>b.count-a.count||b.net-a.net);
}
function resultRows(groups,empty='ยังไม่มีเทรดที่ปิดแล้วในตัวกรองนี้'){
  if(!groups.length)return `<p class="insight-empty">${empty}</p>`;
  const peak=Math.max(...groups.map(g=>Math.abs(g.net)),1);
  return groups.map(g=>`<div class="result-row"><div class="result-row-top"><strong>${escapeHTML(g.name)}</strong><span class="${g.net<0?'is-loss':'is-profit'}">${money(g.net)}</span></div><div class="result-row-foot"><span>${g.count} เทรด · ชนะ ${g.winRate}%</span><span class="result-track"><i class="${g.net<0?'negative':''}" style="width:${Math.max(3,Math.abs(g.net)/peak*100)}%"></i></span></div></div>`).join('');
}
function renderInsights(scope){
  const closed=scope.filter(t=>t.status!=='pending');
  const overall=tradeStats(closed),pending=scope.length-closed.length;
  $('#insightScope').textContent=activeMarket==='all'?'ทุกตลาด':assetLabel(activeMarket);
  $('#insightMetrics').innerHTML=`<article><span>CLOSED TRADES</span><strong>${overall.count}</strong><small>${pending} รายการกำลังถือ</small></article><article><span>NET P/L</span><strong class="${overall.net<0?'is-loss':'is-profit'}">${money(overall.net)}</strong><small>เฉพาะรายการปิดแล้ว</small></article><article><span>WIN RATE</span><strong>${overall.count?overall.winRate+'%':'—'}</strong><small>กำไร / รายการปิดแล้ว</small></article><article><span>AVG. TRADE</span><strong>${overall.count?money(overall.net/overall.count):'—'}</strong><small>ผลลัพธ์เฉลี่ยต่อเทรด</small></article>`;
  $('#marketBreakdown').innerHTML=resultRows(groupedResults(closed,t=>assetLabel(tradeAsset(t))));
  $('#setupBreakdown').innerHTML=resultRows(groupedResults(closed,t=>t.setup));
  $('#symbolBreakdown').innerHTML=resultRows(groupedResults(closed,t=>t.symbol));
  $('#mindsetBreakdown').innerHTML=resultRows(groupedResults(closed,t=>{const id=normalizeEmotion(t.emotions?.before);return TRADE_EMOTIONS.find(e=>e.id===id)?.label||'ไม่ได้บันทึก';}));
  $('#styleBreakdown').innerHTML=resultRows(groupedResults(closed.filter(t=>t.tradeStyle),t=>({swing:'Swing trade',day:'Day trade',position:'Position trade'})[t.tradeStyle]||t.tradeStyle),'ยังไม่มีข้อมูลรูปแบบการถือ — เพิ่มได้ตอนจดหุ้นหรือออปชั่น');
  const review=scope.filter(t=>t.status==='pending'||Number(t.pl)<0).sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,5);
  $('#reviewQueue').innerHTML=review.length?review.map(t=>`<button type="button" class="review-trade" data-review-trade="${t.id}"><span><strong>${escapeHTML(t.symbol)}</strong><small>${assetLabel(tradeAsset(t))} · ${t.status==='pending'?'กำลังถือ':'ขาดทุน'}</small></span><b class="${t.status==='pending'?'': 'is-loss'}">${t.status==='pending'?'↗':money(t.pl)}</b></button>`).join(''):'<p class="insight-empty">ยังไม่มีรายการขาดทุนหรือกำลังถือในตัวกรองนี้</p>';
  const losses=closed.filter(t=>Number(t.pl)<0).length;
  $('#reviewNote').innerHTML=`<span>REVIEW PROMPT</span><p>${overall.count<5?'ข้อมูลยังน้อย ใช้ตัวเลขเป็นจุดเริ่มทบทวน ไม่ใช่ข้อสรุปของกลยุทธ์':`มีเทรดขาดทุน ${losses} รายการ ลองเปิดบันทึกและภาพประกอบเพื่อดูว่าทำตามแผนหรือไม่`}</p><small>เลือกตลาดหรือค้นหาสัญลักษณ์ด้านบนเพื่อเจาะลึกเฉพาะรายการที่ต้องการ</small>`;
}
function renderSetupOptions(selected){ const sel=$('#setup'); sel.innerHTML=setups.map(x=>`<option ${x===selected?'selected':''}>${escapeHTML(x)}</option>`).join('')+`<option value="">— ไม่ระบุ —</option>`; }
function renderSetupList(){ $('#setupList').innerHTML=setups.map((x,i)=>`<div class="setup-item"><div><strong>${escapeHTML(x)}</strong><br><small>${trades.filter(t=>t.setup===x).length} บันทึก</small></div><button class="delete-setup" data-index="${i}" ${trades.some(t=>t.setup===x)?'title="ลบได้โดยบันทึกเก่าจะยังคงชื่อเดิม"':''}>ลบ</button></div>`).join(''); }
function renderEmotionForm(values={before:'confident',during:'confident',after:'satisfied'}){ $('#emotionForm').innerHTML=Object.entries(emotionLabels).map(([k,label])=>{const options=emotionOptions(k);const selected=normalizeEmotion(values[k],k)||(k==='after'?'satisfied':'confident');return `<div class="emotion-field" data-emotion="${k}"><strong>${label}</strong><div class="emotion-choice-grid">${options.map(e=>`<button type="button" class="emotion-choice emotion-${e.id} ${selected===e.id?'selected':''}" data-value="${e.id}"><b>${e.mark}</b><span><strong>${e.label}</strong><small>${e.thai}</small></span></button>`).join('')}</div></div>`}).join(''); updateStatusFields(); }
function updateStatusFields(){ const pending=$('#tradeStatus').value==='pending';$('#pl').required=!pending;$('#plField').classList.toggle('is-disabled',pending);$('[data-emotion="after"]')?.classList.toggle('is-disabled',pending); }
function openTrade(trade){
  $('#tradeForm').reset(); pendingImages=trade?.images?[...trade.images]:[]; $('#tradeId').value=trade?.id||''; $('#formTitle').textContent=trade?'ดูและแก้ไขบันทึก':'บันทึกเทรด';
  $('#assetClass').value=trade?tradeAsset(trade):(activeMarket==='all'?'gold':activeMarket);updateAssetFields();$('#tradeStyle').value=trade?.tradeStyle||'swing';
  $('#symbol').value=trade?.symbol||''; $('#tradeStatus').value=trade?.status||(trade?'closed':'pending'); $('#direction').value=trade?.direction||'LONG'; $('#tradeDate').value=trade?.date?.slice(0,16)||localDateValue(); $('#pl').value=trade?.pl??''; $('#notes').value=trade?.notes||'';
  $('#deleteTradeBtn').hidden=!trade;
  renderSetupOptions(trade?.setup); renderEmotionForm(trade?.emotions); renderPreviews(); openModal('trade');
}
function openModal(which){ $(`#${which}Modal`).classList.add('open'); $(`#${which}Modal`).setAttribute('aria-hidden','false'); document.body.classList.add('modal-open'); }
function closeModal(which){ $(`#${which}Modal`).classList.remove('open'); $(`#${which}Modal`).setAttribute('aria-hidden','true'); if(!$('.modal.open'))document.body.classList.remove('modal-open'); }

$('#tradeForm').addEventListener('submit',async e=>{e.preventDefault();if(!cloudReady)return toast('กรุณาเข้าสู่ระบบก่อน'); const status=$('#tradeStatus').value,assetClass=$('#assetClass').value;const emotions={}; $$('.emotion-field').forEach(f=>emotions[f.dataset.emotion]=f.dataset.emotion==='after'&&status==='pending'?null:$('.selected',f).dataset.value); const id=$('#tradeId').value||crypto.randomUUID(); const old=trades.find(t=>t.id===id); const trade={id,status,assetClass,tradeStyle:assetClass==='stock'||assetClass==='option'?$('#tradeStyle').value:null,symbol:$('#symbol').value.trim().toUpperCase(),direction:$('#direction').value,date:$('#tradeDate').value,pl:status==='pending'?null:Number($('#pl').value),setup:$('#setup').value,emotions,notes:$('#notes').value.trim(),images:pendingImages.length?pendingImages:(old?.images||[])}; const button=$('#tradeForm button[type="submit"]');button.disabled=true;try{const saved=await persistTrade(trade,old);trades=old?trades.map(t=>t.id===id?saved:t):[saved,...trades];save();render();closeModal('trade');toast(status==='pending'?'บันทึกเป็นออเดอร์กำลังถือแล้ว':'บันทึกเทรดแล้ว ✓');}catch(error){toast(`บันทึกไม่สำเร็จ: ${error.message}`);}finally{button.disabled=false;}});
$('#setupForm').addEventListener('submit',async e=>{e.preventDefault();if(!cloudReady)return toast('กรุณาเข้าสู่ระบบก่อน');const name=$('#newSetupName').value.trim();if(!name)return;if(setups.some(x=>x.toLowerCase()===name.toLowerCase()))return toast('มี Setup ชื่อนี้แล้ว');const {error}=await cloud.from('journal_setups').insert({user_id:cloudUser.id,name});if(error)return toast(`เพิ่ม Setup ไม่สำเร็จ: ${error.message}`);setups.push(name);$('#newSetupName').value='';save();render();toast('เพิ่ม Setup แล้ว');});
$('#screenshots').addEventListener('change',async e=>{const files=[...e.target.files].slice(0,3);pendingImages=await Promise.all(files.map(file=>new Promise(resolve=>{const img=new Image(),reader=new FileReader();reader.onload=()=>{img.onload=()=>{const c=document.createElement('canvas'),max=1200,scale=Math.min(1,max/img.width);c.width=img.width*scale;c.height=img.height*scale;c.getContext('2d').drawImage(img,0,0,c.width,c.height);resolve(c.toDataURL('image/jpeg',.76));};img.src=reader.result};reader.readAsDataURL(file)})));renderPreviews();});
$('#tradeStatus').addEventListener('change',updateStatusFields);
$('#assetClass').addEventListener('change',updateAssetFields);
$('#deleteTradeBtn').addEventListener('click',()=>{const trade=trades.find(t=>t.id===$('#tradeId').value);if(!trade)return;$('#deleteDescription').textContent=`${trade.symbol} · ${dateParts(trade.date).day} ${dateParts(trade.date).month} — รายการและรูปออเดอร์จะถูกลบออกจากคลาวด์ กู้คืนไม่ได้`;openModal('delete');});
$('#confirmDeleteBtn').addEventListener('click',async()=>{const id=$('#tradeId').value,trade=trades.find(t=>t.id===id);if(!trade||!cloudReady)return;const button=$('#confirmDeleteBtn');button.disabled=true;try{const {data,error}=await cloud.from('journal_trades').delete().eq('id',id).eq('user_id',cloudUser.id).select('id');if(error)cloudError(error);if(!data?.length)throw new Error('ไม่พบรายการที่ลบได้');trades=trades.filter(t=>t.id!==id);save();render();closeModal('delete');closeModal('trade');const paths=trade.imagePaths||[];if(paths.length){const result=await cloud.storage.from('trade-images').remove(paths);if(result.error){toast('ลบรายการแล้ว แต่ลบไฟล์รูปไม่สำเร็จ');return;}}toast('ลบรายการเทรดแล้ว');}catch(error){toast(`ลบไม่สำเร็จ: ${error.message}`);}finally{button.disabled=false;}});
function renderPreviews(){ $('#imagePreviews').innerHTML=(pendingImages.length?'<div class="saved-images-label">ภาพที่บันทึกไว้ — แตะภาพเพื่อดูขนาดเต็ม</div>':'')+pendingImages.map((src,i)=>`<div class="preview-wrap"><img src="${src}" alt="ภาพออเดอร์ ${i+1}" data-view-image="${i}"><button type="button" data-remove-image="${i}" aria-label="ลบภาพ ${i+1}">×</button></div>`).join(''); }
function openImageViewer(images,index=0){ viewerImages=images;viewerIndex=index;updateViewer();$('#imageViewer').classList.add('open');$('#imageViewer').setAttribute('aria-hidden','false'); }
function updateViewer(){ if(!viewerImages.length)return closeImageViewer();viewerIndex=(viewerIndex+viewerImages.length)%viewerImages.length;$('#viewerImage').src=viewerImages[viewerIndex];$('#viewerCount').textContent=`${viewerIndex+1} / ${viewerImages.length}`;$('.viewer-prev').hidden=viewerImages.length<2;$('.viewer-next').hidden=viewerImages.length<2; }
function closeImageViewer(){ $('#imageViewer').classList.remove('open');$('#imageViewer').setAttribute('aria-hidden','true'); }
function setView(view){
  activeView=view;
  $('#journalView').hidden=view!=='journal';$('#insightsView').hidden=view!=='insights';
  $$('.nav-item').forEach(item=>item.classList.toggle('active',item.dataset.view===view));
  $('.topbar h1').textContent=view==='insights'?'Trade Insights':'Trading Journal';
  $('.page-intro').textContent=view==='insights'?'ทบทวนผลลัพธ์ตามตลาด สัญลักษณ์ Setup และอารมณ์':'ทบทวนแผน การตัดสินใจ และอารมณ์ — ไม่ใช่แค่ผลลัพธ์';
}
document.addEventListener('click',e=>{
  const close=e.target.closest('[data-close]'); if(close)closeModal(close.dataset.close);
  if(e.target.closest('#newTradeBtn')||e.target.closest('#emptyAddBtn'))openTrade();
  if(e.target.closest('#quickAddSetup'))openModal('setup');
  const nav=e.target.closest('.nav-item');if(nav){if(nav.dataset.view==='setups')openModal('setup');else setView(nav.dataset.view);}
  const emo=e.target.closest('.emotion-choice');if(emo){$$('.emotion-choice',emo.parentElement).forEach(x=>x.classList.remove('selected'));emo.classList.add('selected');}
  const row=e.target.closest('.trade-row');if(row)openTrade(trades.find(t=>t.id===row.dataset.id));
  const review=e.target.closest('[data-review-trade]');if(review)openTrade(trades.find(t=>t.id===review.dataset.reviewTrade));
  const filter=e.target.closest('.filter');if(filter){activeFilter=filter.dataset.filter;$$('.filter').forEach(x=>x.classList.remove('active'));filter.classList.add('active');render();}
  const market=e.target.closest('.market-filter');if(market){activeMarket=market.dataset.market;$$('.market-filter').forEach(x=>{const selected=x===market;x.classList.toggle('active',selected);x.setAttribute('aria-pressed',String(selected));});render();}
  const del=e.target.closest('.delete-setup');if(del){const name=setups[Number(del.dataset.index)];if(!cloudReady)return toast('กรุณาเข้าสู่ระบบก่อน');cloud.from('journal_setups').delete().eq('name',name).then(({error})=>{if(error)return toast(`ลบไม่สำเร็จ: ${error.message}`);setups.splice(setups.indexOf(name),1);save();render();});}
  const rm=e.target.closest('[data-remove-image]');if(rm){pendingImages.splice(Number(rm.dataset.removeImage),1);renderPreviews();}
  const view=e.target.closest('[data-view-image]');if(view)openImageViewer(pendingImages,Number(view.dataset.viewImage));
  if(e.target.closest('.viewer-close')||e.target.id==='imageViewer')closeImageViewer();
  if(e.target.closest('.viewer-prev')){viewerIndex--;updateViewer();}
  if(e.target.closest('.viewer-next')){viewerIndex++;updateViewer();}
});
$('#symbolSearch').addEventListener('input',e=>{searchQuery=e.target.value.trim().toUpperCase();render();});
$('#exportJournalBtn').addEventListener('click',()=>{
  const payload={schemaVersion:2,exportedAt:new Date().toISOString(),currency:'USD',setups,trades:trades.map(({images,...trade})=>({...trade,assetClass:tradeAsset(trade)}))};
  const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=`trade-notes-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast('ส่งออกบันทึกทั้งหมดแล้ว เก็บไฟล์นี้เป็นส่วนตัว');
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeImageViewer();$$('.modal.open').forEach(m=>closeModal(m.id.replace('Modal','')))}if($('#imageViewer').classList.contains('open')&&e.key==='ArrowLeft'){viewerIndex--;updateViewer()}if($('#imageViewer').classList.contains('open')&&e.key==='ArrowRight'){viewerIndex++;updateViewer()}});
$('#todayLabel').textContent=new Date().toLocaleDateString('en-US',{month:'short',year:'numeric'}).toUpperCase();
renderEmotionForm();render();
$('#authForm').addEventListener('submit',async e=>{e.preventDefault();if(!cloud)return;const email=$('#authEmail').value.trim(),password=$('#authPassword').value;$('#authMessage').textContent='กำลังเข้าสู่ระบบ…';const {error}=await cloud.auth.signInWithPassword({email,password});if(error)$('#authMessage').textContent=error.message;});
$('#signUpBtn').addEventListener('click',async()=>{if(!cloud)return;const email=$('#authEmail').value.trim(),password=$('#authPassword').value;if(!email||password.length<6){$('#authMessage').textContent='กรอกอีเมลและรหัสผ่านอย่างน้อย 6 ตัวอักษรก่อน';return;}$('#authMessage').textContent='กำลังสร้างบัญชี…';const {data,error}=await cloud.auth.signUp({email,password,options:{emailRedirectTo:location.origin+location.pathname}});$('#authMessage').textContent=error?error.message:(data.session?'สมัครสำเร็จ กำลังเปิดบันทึก…':'ส่งอีเมลยืนยันแล้ว กรุณากดลิงก์ในอีเมลก่อนเข้าสู่ระบบ');});
$('#signOutBtn').addEventListener('click',async()=>{await cloud?.auth.signOut();trades=[];setups=[];render();});
if(cloud){cloud.auth.onAuthStateChange((_event,session)=>{setTimeout(()=>acceptSession(session),0);});cloud.auth.getSession().then(({data,error})=>{if(error)$('#authMessage').textContent=error.message;else acceptSession(data.session);});}else{$('#authMessage').textContent='โหลดระบบคลาวด์ไม่สำเร็จ กรุณารีเฟรชหน้า';}
