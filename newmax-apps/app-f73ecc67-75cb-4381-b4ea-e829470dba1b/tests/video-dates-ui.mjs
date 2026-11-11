import {mountBulkReview,wait} from './bulk-read-ui.mjs';
const assert=(ok,msg)=>{if(!ok)throw new Error(msg);};
export async function mountDateReview(width=1086,height=650,seed){
  const ids=['date-review-old','date-review-new','date-review-unknown','date-review-other'];
  const videos=ids.map((id,i)=>({id,title:['旧视频','最近一小时的视频','日期未知的视频','另一频道视频'][i],channelId:i===3?'two':'one',channelTitle:i===3?'临时频道二':'临时频道一',publishedAt:['2026-05-10T00:00:00Z','2026-11-05T00:30:00Z',null,'2026-11-04T00:00:00Z'][i],datePrecision:i===1?'approximate':'day',transcriptStatus:'ready'}));
  const records=Object.fromEntries(ids.map(id=>[id,{read:false,favorite:true,analysis:'原解析不可覆盖',messages:[]}])) ;
  const initial=seed||[['yingdu.workspace.v1',{records,imports:[],model:''}],['yingdu.library-cache.v1',{channels:[{id:'one',title:'临时频道一',status:'ready'},{id:'two',title:'临时频道二',status:'ready'}],videos,settings:{intervalMinutes:30,autoCaptions:false},lastSync:null}],...ids.map(id=>['yingdu.transcript.'+id,{segments:[{start:0,end:10,text:'只用于隔离日期验收的文稿'}]}])];
  return mountBulkReview(width,height,initial);
}
export async function exerciseDateReview(ctx){
  const {w,doc:d}=ctx,$=s=>d.querySelector(s),store=w.__harness.store;
  const ids=()=>[...d.querySelectorAll('#video-list .video-item')].map(x=>x.dataset.id);
  const before=JSON.stringify(store.get('yingdu.workspace.v1'));
  assert(ids().join(',')==='date-review-new,date-review-old,date-review-unknown','初次频道没有按时间排序');
  assert($('.video-item.selected').dataset.id==='date-review-new','默认不是最新视频');
  assert($('#video-list [data-video-date="date-review-new"]').textContent.startsWith('约 '),'未标记近似');
  assert($('#video-list [data-video-date="date-review-new"]').title.includes('相对时间换算'),'近似说明缺失');
  $('[data-action="filter"][data-value="all"]').click();
  assert(ids().join(',')==='date-review-new,date-review-other,date-review-old,date-review-unknown','全库顺序错误');
  for(const value of ['unread','saved']){$(`[data-action="filter"][data-value="${value}"]`).click();assert(ids()[0]==='date-review-new'&&ids().at(-1)==='date-review-unknown','筛选顺序错误');}
  const input=$('#video-search');input.value='视频';input.dispatchEvent(new w.Event('input',{bubbles:true}));assert(ids()[0]==='date-review-new','搜索排序错误');
  input.value='没有匹配的临时内容';input.dispatchEvent(new w.Event('input',{bubbles:true}));assert($('#list-count').textContent==='0'&&$('.list-empty'),'无匹配空态缺失');
  input.value='';input.dispatchEvent(new w.Event('input',{bubbles:true}));$('[data-action="channel"][data-id="one"]').click();
  $('[data-action="tab"][data-value="chat"]').click();
  const composer=d.querySelector('textarea');assert(composer,'对话框不存在');composer.value='未发送的问题保留';composer.dispatchEvent(new w.Event('input',{bubbles:true}));
  const readerNode=$('#reader').firstElementChild;
  const fresh=JSON.parse(JSON.stringify(store.get('yingdu.library-cache.v1')));
  fresh.videos.find(x=>x.id==='date-review-new').datePrecision='second';
  Object.assign(fresh.videos.find(x=>x.id==='date-review-unknown'),{publishedAt:'2026-11-05T01:30:00Z',datePrecision:'second'});
  w.newmaxApp.files.readText=async()=>JSON.stringify({url:'http://127.0.0.1:18743',token:'isolated-no-credentials-aaaaaaaaaaaaaaaaaaaaa'});
  w.fetch=async url=>({ok:true,json:async()=>String(url).endsWith('/health')?{ok:true,workerRunning:true,background:true}:JSON.parse(JSON.stringify(fresh))});
  $('#connector-indicator').click();$('[data-action="reconnect"]').click();await wait(()=>$('#video-list [data-video-date="date-review-unknown"]')?.textContent!=='日期未提供');
  $('[data-action="close-dialog"]').click();
  assert(ids()[0]==='date-review-unknown'&&$('.video-item.selected').dataset.id==='date-review-new','补日期没有重排或抢选中');
  assert($('#reader').firstElementChild===readerNode&&d.querySelector('textarea')===composer&&composer.value==='未发送的问题保留','更新日期重建正文或清空问题');
  assert(!$('#reader [data-video-date]').textContent.startsWith('约 '),'选中视频日期没有局部校准');
  assert(JSON.stringify(store.get('yingdu.workspace.v1'))===before&&w.__harness.calls.length===0,'改写阅读记录或调用AI');
  ctx.frame.style.width='640px';ctx.frame.style.height='560px';await wait(()=>w.innerWidth===640);
  $('[data-action="back"]').click();
  assert(d.documentElement.scrollWidth===640&&$('#video-list [data-video-date="date-review-unknown"]').getBoundingClientRect().right<=640,'窄屏日期横溢出');
  return {passed:true,evidence:'隔离真实界面已验证：频道/全库/未读/收藏/搜索最新优先，未知置后，近似约标识与完整时刻提示，补全后即时重排但保持手动选中、原正文节点和未发送问题；640×560无横溢出；阅读状态不变、AI0。',seed:[...store.entries()]};
}
