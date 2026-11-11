import {mountBulkReview,wait} from './bulk-read-ui.mjs';
const assert=(ok,text)=>{if(!ok)throw new Error(text);};
export async function mountTemporaryReview(seed){
  const ctx=await mountBulkReview(1086,650,seed),{w,doc:d}=ctx,h=w.__harness;
  h.library=structuredClone(h.store.get('yingdu.library-cache.v1'));h.posts=0;h.patchCount=0;h.failPost=false;
  w.newmaxApp.files.readText=async()=>JSON.stringify({url:'http://127.0.0.1:18743',token:'isolated-temporary-only-aaaaaaaaaaaaaaaaaaa'});
  h.transcript={source:'manual',format:'json3',language:'en',raw:'测试原文',segments:[{start:0,end:3,text:'临时目录文稿完整保留'}]};
  w.fetch=async(url,options={})=>{
    const path=new URL(url).pathname;
    if(path==='/health')return {ok:true,json:async()=>({ok:true,workerRunning:true,background:true,temporaryVideos:true})};
    if(path==='/library')return {ok:true,json:async()=>structuredClone(h.library)};
    if(path.endsWith('/transcript'))return {ok:true,json:async()=>structuredClone(h.transcript)};
    if(path==='/videos'&&options.method==='POST'){
      h.posts++;await new Promise(r=>setTimeout(r,80));if(h.failPost)return {ok:false,json:async()=>({error:'隔离测试：本地存储暂不可写'})};
      const id=new URL(JSON.parse(options.body).url).searchParams.get('v');let v=h.library.videos.find(x=>x.id===id);const duplicate=!!v;
      if(!v){v={id,title:'正在获取视频信息…',url:'https://www.youtube.com/watch?v='+id,channelId:null,channelTitle:'临时视频',infoStatus:'pending',transcriptStatus:'none',temporary:true};h.library.videos.push(v);}else v.temporary=true;
      return {ok:true,json:async()=>({ok:true,video:structuredClone(v),duplicate})};
    }
    if(options.method==='PATCH'){
      h.patchCount++;h.library.videos.find(x=>x.id===path.split('/').at(-1)).temporary=false;
      return {ok:true,json:async()=>({ok:true,retainedVideos:true})};
    }
    throw new Error('隔离测试禁止未知网络：'+path);
  };
  ctx.reconnect=async()=>{d.querySelector('#connector-indicator').click();d.querySelector('[data-action="reconnect"]').click();await wait(()=>d.querySelector('#connector-settings-status').textContent.includes('在线')||d.querySelector('#connector-settings-status').textContent.includes('后台运行中'));d.querySelector('[data-action="close-dialog"]').click();};
  return ctx;
}
export async function exerciseTemporaryReview(ctx){
  const {w,doc:d}=ctx,h=w.__harness,$=s=>d.querySelector(s),click=s=>$(s).click();
  const original=JSON.stringify(h.store.get('yingdu.workspace.v1').records);
  click('[data-action="filter"][data-value="temporary"]');assert($('#video-list').textContent.includes('只读一条视频'),'空目录无引导');
  click('[data-action="add-video"]');assert($('#video-form [type="submit"]').disabled,'离线未禁用提交');click('[data-action="close-dialog"]');
  await ctx.reconnect();click('[data-action="add-video"]');
  const input=$('#video-url');input.value='https://youtube.com/@Example';$('#video-form').requestSubmit();await wait(()=>$('#dialog-error').textContent.includes('有效的 YouTube'));assert(h.posts===0,'无效URL发起请求');
  input.value='https://youtu.be/abcdefghijk?si=sample';h.failPost=true;$('#video-form').requestSubmit();await wait(()=>$('#dialog-error').textContent.includes('不可写'));assert(input.value.includes('youtu.be'),'失败清空输入');
  h.failPost=false;const before=h.posts;$('#video-form').requestSubmit();$('#video-form').requestSubmit();await wait(()=>!$('#app-dialog').open);
  assert(h.posts===before+1,'重复提交未保护');assert($('#reader').textContent.includes('正在获取视频标题'),'待获取状态不显示');
  assert(JSON.stringify(h.store.get('yingdu.workspace.v1').records)===original,'添加修改原阅读状态');
  const v=h.library.videos.find(v=>v.id==='abcdefghijk');Object.assign(v,{title:'临时测试：从故事理解知识',channelTitle:'真实格式来源',infoStatus:'ready',transcriptStatus:'ready',publishedAt:'2026-11-05T01:00:00Z'});
  await ctx.reconnect();await wait(()=>$('#reader').textContent.includes('临时目录文稿完整保留')||$('#reader').textContent.includes('全文一次解析'));
  assert($('#reader').textContent.includes(v.title),'标题没有刷新');click('[data-action="tab"][data-value="transcript"]');assert($('#reader').textContent.includes('临时目录文稿完整保留'),'字幕未复用阅读');
  click('[data-action="tab"][data-value="chat"]');assert($('#chat-input')&&$('[data-action="editorial"]'),'未复用对话与排版入口');
  click('[data-action="add-video"]');$('#video-url').value='https://youtube.com/watch?v=abcdefghijk&t=30';$('#video-form').requestSubmit();await wait(()=>!$('#app-dialog').open);assert(h.library.videos.filter(v=>v.id==='abcdefghijk').length===1,'重复URL生成多条');
  const seed=[...h.store.entries()];
  click('[data-action="remove-temporary"]');assert($('#dialog-body').textContent.includes('保留'),'移出未说明保留');click('[data-action="confirm-remove-temporary"]');await wait(()=>!$('#app-dialog').open);
  assert(!v.temporary&&h.library.videos.some(v=>v.id==='abcdefghijk'),'移出删除资料');assert($('#list-count').textContent==='0','移出后过滤未更新');
  assert(h.calls.length===0&&h.library.channels.length===2,'调用了AI或订阅变化');
  ctx.frame.style.width='640px';ctx.frame.style.height='560px';await wait(()=>w.innerWidth===640);click('[data-action="add-video"]');
  assert(d.documentElement.scrollWidth<=640&&$('#app-dialog').getBoundingClientRect().right<=640,'窄屏溢出');
  return {passed:true,evidence:'真实隔离UI通过临时目录空态、离线禁用、无效URL零请求、失败保留输入、重复提交保护、待获取→文稿显示、重复链接去重、对话/排版入口、移出保留资料与640×560表单；原记录保持、AI0。',seed};
}
export async function verifyTemporaryReload(ctx){
  await ctx.reconnect();const {doc:d,w}=ctx;d.querySelector('[data-action="filter"][data-value="temporary"]').click();
  const passed=d.querySelector('#list-count').textContent==='1'&&d.querySelector('#video-list').textContent.includes('临时测试');
  return {passed,evidence:'重新装载已保存的隔离store和连接器快照，临时归类仍显示1条；未订阅新频道、AI请求'+w.__harness.calls.length+'次。'};
}
