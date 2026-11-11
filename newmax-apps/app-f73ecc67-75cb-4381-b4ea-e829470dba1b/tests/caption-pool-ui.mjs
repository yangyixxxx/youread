import {mountBulkReview,wait} from './bulk-read-ui.mjs';
const assert=(ok,m)=>{if(!ok)throw new Error(m);};
export async function mountPoolReview(){
  const ctx=await mountBulkReview(1086,650),{w,doc:d}=ctx,h=w.__harness;
  h.pool={enabled:true,nodeCount:3,available:3,cooling:0,running:false,maxAttempts:3,intervalSeconds:20};
  h.library=JSON.parse(JSON.stringify(h.store.get('yingdu.library-cache.v1')));h.posts=0;
  w.newmaxApp.files.readText=async()=>JSON.stringify({url:'http://127.0.0.1:18743',token:'isolated-only-not-a-real-token-aaaaaaaaaaaaa'});
  w.fetch=async(url,options={})=>{
    if(String(url).endsWith('/health'))return {ok:true,json:async()=>({ok:true,workerRunning:true,background:true,captionProxy:h.pool})};
    if(String(url).endsWith('/library'))return {ok:true,json:async()=>JSON.parse(JSON.stringify(h.library))};
    if(options.method==='POST'&&String(url).includes('/transcript')){h.posts++;h.pool.running=true;h.library.videos.find(v=>v.id===ctx.ids[0]).transcriptStatus='pending';return {ok:true,json:async()=>({ok:true,status:'pending'})};}
    throw new Error('隔离验收禁止其它网络');
  };
  return ctx;
}
async function reconnect(ctx){const {doc:d}=ctx;d.querySelector('#connector-indicator').click();d.querySelector('[data-action="reconnect"]').click();await new Promise(r=>setTimeout(r,80));d.querySelector('[data-action="close-dialog"]').click();}
export async function exercisePoolReview(ctx){
  const {w,doc:d}=ctx,h=w.__harness,$=s=>d.querySelector(s),before=JSON.stringify(h.store.get('yingdu.workspace.v1'));
  await reconnect(ctx);assert($('.caption-pool-status').textContent.includes('已配置 3'),'专用配置状态不显示');
  assert(!$('[data-action="fetch-transcript"]').disabled,'有可用出口仍禁用');
  h.pool={...h.pool,available:0,cooling:3,nextAvailableAt:Date.now()/1000+1800};
  await reconnect(ctx);assert($('[data-action="fetch-transcript"]').disabled&&$('[data-action="fetch-transcript"]').textContent==='出口冷却中','冷却未禁止重复排队');
  assert($('.caption-pool-status').textContent.includes('最早')&&$('.caption-pool-status').textContent.includes('付费备用未配置'),'冷却时间或付费边界未说明');
  h.pool={...h.pool,nodeCount:0,available:0,cooling:0,lastError:'无法连接Clash控制接口，不会切换全局出口。'};
  await reconnect(ctx);assert($('.caption-pool-status').textContent.includes('无法连接Clash'),'控制异常未显示');
  h.pool={enabled:true,nodeCount:3,available:1,cooling:2,running:false};
  await reconnect(ctx);assert(!$('[data-action="fetch-transcript"]').disabled&&$('[data-action="fetch-transcript"]').textContent==='获取字幕','恢复未重新启用并恢复文案');
  const button=$('[data-action="fetch-transcript"]');button.click();button.click();await wait(()=>h.posts===1&&$('[data-action="fetch-transcript"]').disabled&&$('.caption-pool-status').textContent.includes('正在获取'));
  assert(h.posts===1&&$('.caption-pool-status').textContent.includes('正在获取'),'重复点击或运行状态错误');
  ctx.frame.style.width='640px';ctx.frame.style.height='560px';await wait(()=>w.innerWidth===640);
  assert(d.documentElement.scrollWidth===640&&$('.caption-pool-status').getBoundingClientRect().right<=640,'窄屏状态横溢出');
  assert(JSON.stringify(h.store.get('yingdu.workspace.v1'))===before&&h.calls.length===0,'修改原解析或调用AI');
  return {passed:true,evidence:'隔离真实UI验证3节点配置、全冷却禁用/恢复时刻、Clash不可用提示、恢复后按钮重新启用及文案恢复、双击仅1次字幕POST、运行状态与640×560换行；workspace不变、AI0。'};
}
