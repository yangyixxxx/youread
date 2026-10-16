import {escapeHTML as esc} from './core.mjs';
import {loadImage} from './editorial.mjs';
import {recommendFrames,parseFrameTime,frameTime,insertFrameMarkers,validFrameSource} from './frame-plan.mjs';

// 只调用本地连接器；候选推荐不请求模型，勾选后才修改排版副本。
export function attachFramePicker({root,video,api,getArticle,setBody,changed}){
  const $=s=>root.querySelector(s),host=$('#ed-frame-panel');
  const supported=/^[A-Za-z0-9_-]{11}$/.test(video.id||'')&&!video.local&&typeof api==='function';
  let rows=[],snapshot='',opened=false,fetching=false,disposed=false,timer=null,error='',status='',requestSerial=0;
  const stale=()=>getArticle()?.body!==snapshot;
  const chosen=()=>rows.filter(r=>r.selected&&r.status==='ready'&&r.image);
  function refreshAssets(){
    const article=getArticle();if(!article)return;
    const assets=Object.entries(article.assets||{}).filter(([id,a])=>validFrameSource(a.source)&&article.body.split('\n').some(line=>line.trim()===`:::image ${id}`));
    $('#ed-frame-assets').innerHTML=assets.length?`<strong>已插入视频截图</strong>${assets.map(([id,a])=>`<div class="ed-frame-asset"><span>视频画面 · ${esc(frameTime(a.source.seconds))}</span><button type="button" class="button quiet" data-frame="locate" data-asset="${esc(id)}">定位</button><button type="button" class="button quiet" data-frame="remove" data-asset="${esc(id)}">移除</button></div>`).join('')}`:'';
  }
  function render(){
    if(disposed)return;
    host.hidden=!opened;
    $('[data-frame="toggle"]').setAttribute('aria-expanded',String(opened));
    if(!opened){refreshAssets();return;}
    host.innerHTML=`<div class="ed-frame-heading"><strong>从视频取图</strong><button type="button" class="button quiet" data-frame="hide">收起</button></div>
      <p class="ed-hint">按正文时间引用推荐位置，不代表自动识别了画面。获取时读取视频媒体，消耗网络流量，不调用 AI。只处理可正常访问的视频；请确认截图使用权。</p>
      ${supported?'': '<p class="ed-frame-warning">当前内容不在可取帧的视频库中。请订阅对应频道后从视频进入，或使用「正文配图」上传本地截图。</p>'}
      <div class="ed-inline-actions"><button type="button" class="button" data-frame="recommend" ${fetching?'disabled':''}>重新推荐位置</button><button type="button" class="button quiet" data-frame="manual" ${fetching||rows.length>=5?'disabled':''}>＋ 当前光标位置</button></div>
      ${error?`<p class="ed-frame-warning" role="alert">${esc(error)}</p>`:''}
      ${stale()&&rows.length?'<p class="ed-frame-warning">正文已改变，请重新推荐位置；已获取的截图不会自动插入错位段落。</p>':''}
      <p class="ed-frame-status" role="status">${esc(status||(!rows.length?'未找到时间引用，可在正文放置光标后手动添加。':'先调整时间点，再获取候选截图。'))}</p>
      <div class="ed-frame-cards">${rows.map((r,i)=>`<article class="ed-frame-card" data-frame-row="${i}"><strong>${esc(r.label)}</strong><p class="ed-frame-excerpt">${esc(r.excerpt||'插入在当前光标位置')}</p><label class="ed-frame-time">视频时间（分:秒 / 时:分:秒）<input data-frame-time="${i}" value="${esc(r.time)}" aria-label="第${i+1}张截图时间" ${fetching?'disabled':''}></label>
      <div class="ed-frame-picture">${r.status==='ready'&&r.dataUrl?`<img src="${esc(r.dataUrl)}" alt="${esc(frameTime(r.seconds))} 的视频截图">`:`<span>${esc(r.status==='running'?'正在读取视频画面…':r.status==='pending'&&fetching?'排队等待取帧…':r.status==='error'?'截图未获取':'待获取视频画面')}</span>`}</div>
      ${r.error?`<p class="ed-frame-warning">${esc(r.error)}</p>`:''}<label class="ed-frame-check"><input type="checkbox" data-frame-select="${i}" ${r.selected?'checked':''} ${r.status!=='ready'?'disabled':''}>将这张截图插入对应段落</label></article>`).join('')}</div>
      <div class="ed-frame-actions"><button type="button" class="button" data-frame="fetch" ${!supported||!rows.length||fetching||stale()?'disabled':''}>${fetching?'正在取图…':rows.some(r=>r.status==='ready')?'获取待处理截图':'获取候选截图'}</button><button type="button" class="button primary" data-frame="insert" ${fetching||stale()||!chosen().length?'disabled':''}>插入所选 ${chosen().length} 张</button></div>
      <p class="ed-hint">每次最多5张，可调整时间后再取图。失败不自动重试；关闭编辑器停止等待，但不保证后台任务已取消。未插入的候选不会进入导出图片。</p>`;
    refreshAssets();
  }
  function recommend(){
    const previous=rows.filter(r=>r.status==='ready');
    snapshot=getArticle().body;
    rows=recommendFrames(snapshot,{duration:video.duration}).map(r=>({...r,time:frameTime(r.seconds),selected:false,status:'idle'}));
    // 重新规划位置时可复用同一时间的已获取画面，不额外联网。
    for(const row of rows){const prior=previous.find(r=>r.seconds===row.seconds);if(prior)Object.assign(row,{status:'ready',dataUrl:prior.dataUrl,image:prior.image,selected:prior.selected});}
    error='';status=rows.length?`推荐 ${rows.length} 处 · 可修改时间，获取后逐张挑选。`:'';render();
  }
  async function applyJob(job,targets){
    if(disposed)return;
    if(!job||!Array.isArray(job.items))throw new Error('连接器截图结果格式不正确，请重启连接器后重试。');
    for(const item of job.items){
      const row=targets.find(r=>r.seconds===item.seconds);if(!row)continue;
      if(item.status==='ready'&&row.status!=='ready'){
        if(typeof item.dataUrl!=='string'||item.dataUrl.length>4*1024*1024||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(item.dataUrl)){
          row.status='error';row.error='截图数据无效，未插入正文。';continue;
        }
        try{
          const image=await loadImage(item.dataUrl);
          if(disposed)return;
          if(!image.width||image.width>4096||image.height>4096)throw new Error('截图尺寸无效。');
          Object.assign(row,{status:'ready',dataUrl:item.dataUrl,image,selected:true,error:''});
        }catch(e){row.status='error';row.error=e.message;}
      }else if(item.status==='error'){row.status='error';row.error=item.error||'无法读取该时刻画面，请调整时间后手动重试。';}
      else if(row.status!=='ready'&&['pending','running'].includes(item.status))row.status=item.status;
    }
  }
  async function fetchFrames(){
    if(fetching||disposed||stale())return;
    const targets=rows.filter(r=>r.status!=='ready');
    if(!targets.length){status='候选截图已就绪，可以勾选插入；如需重新截图，请先修改时间。';render();return;}
    const seen=new Set();
    for(const row of rows){
      const seconds=parseFrameTime(row.time);
      if(seconds===null||(Number.isFinite(video.duration)&&seconds>=video.duration)){error='请输入有效视频时间，且须小于视频时长（例如 4:29）。';render();return;}
      if(seen.has(seconds)){error='候选时间重复，请选择不同时间点。';render();return;}seen.add(seconds);row.seconds=seconds;
    }
    fetching=true;error='';status='正在检查本地连接器…';const serial=++requestSerial;render();
    const stillActive=()=>!disposed&&serial===requestSerial;
    const fail=e=>{if(!stillActive())return;fetching=false;error=e.message||'截图获取失败，请检查连接器后手动重试。';status='已获取的候选保留，正文未修改。';render();};
    try{
      const health=await api('/health');if(!stillActive())return;
      if(health?.capabilities?.videoFrames!==true)throw new Error(health?.frameReason||'当前连接器不支持视频截图，请更新并重启连接器。仍可上传本地配图。');
      for(const row of targets){row.status='pending';row.error='';}
      status='正在提交取帧任务…';render();
      const response=await api(`/videos/${video.id}/frames`,'POST',{times:targets.map(r=>r.seconds)});
      if(!stillActive())return;
      if(!/^[a-zA-Z0-9_-]{1,100}$/.test(response?.job?.id||''))throw new Error('连接器未返回有效截图任务。');
      const jobId=response.job.id,start=Date.now();
      const update=async job=>{
        await applyJob(job,targets);if(!stillActive())return;
        const done=rows.filter(r=>r.status==='ready').length;
        if(['done','error'].includes(job.status)){
          fetching=false;
          for(const row of targets)if(['pending','running'].includes(row.status)){row.status='error';row.error=job.error||'本次未返回截图，请手动重试。';}
          status=`已获取 ${done} / ${rows.length} 张 · 勾选后插入正文。`;
          if(job.status==='error')error=job.error||'取帧任务未完成，已成功截图保留。';render();return;
        }
        if(Date.now()-start>600000)throw new Error('等待截图超过10分钟，已停止等待。后台任务可能仍在运行，未自动重试。');
        status=job.status==='queued'?'正在排队，连接器完成当前任务后开始取图…':`正在取图 · 已完成 ${done} / ${rows.length} 张`;render();
        timer=setTimeout(async()=>{try{const res=await api(`/frame-jobs/${jobId}`);if(stillActive())await update(res.job);}catch(e){fail(e);}},1200);
      };
      await update(response.job);
    }catch(e){fail(e);}
  }
  async function insert(){
    if(fetching||stale()||disposed)return;
    const selected=chosen();if(!selected.length)return;
    const article=getArticle(),items=selected.map(r=>({...r,assetId:crypto.randomUUID()}));
    try{
      const body=insertFrameMarkers(article.body,snapshot,items);
      for(const item of items){article.assets[item.assetId]={dataUrl:item.dataUrl,width:item.image.width,height:item.image.height,source:{type:'video-frame',videoId:video.id,seconds:item.seconds}};changed(item.assetId,item.image);}
      setBody(body);rows=[];snapshot=body;status=`已插入 ${items.length} 张截图。请保存排版，原解析未改动。`;error='';render();
    }catch(e){error=e.message;render();}
  }
  root.addEventListener('change',e=>{
    if(e.target.dataset.frameTime!==undefined){const row=rows[Number(e.target.dataset.frameTime)];if(!row||fetching)return;row.time=e.target.value;row.status='idle';row.image=null;row.dataUrl='';row.selected=false;row.error='';error='';const card=e.target.closest('.ed-frame-card');card.querySelector('.ed-frame-picture').innerHTML='<span>时间已修改，请重新获取画面</span>';const check=card.querySelector('[data-frame-select]');check.checked=false;check.disabled=true;card.querySelector('.ed-frame-warning')?.remove();const insertButton=$('[data-frame="insert"]');insertButton.disabled=fetching||stale()||!chosen().length;insertButton.textContent=`插入所选 ${chosen().length} 张`;}
    if(e.target.dataset.frameSelect!==undefined){const row=rows[Number(e.target.dataset.frameSelect)];if(row)row.selected=e.target.checked;render();}
  });
  root.addEventListener('click',e=>{
    const b=e.target.closest('[data-frame]');if(!b||b.disabled)return;
    const action=b.dataset.frame;e.stopPropagation();
    if(action==='toggle'){opened=!opened;if(opened&&!rows.length){recommend();}else render();if(opened)host.scrollIntoView({block:'start'});}
    if(action==='hide'){opened=false;render();}
    if(action==='recommend'&&!fetching)recommend();
    if(action==='manual'&&!fetching&&rows.length<5){
      if(stale()){rows=[];snapshot=getArticle().body;}
      rows.push({offset:$('#ed-body').selectionStart,label:'手动选择位置',excerpt:'插入在添加时的正文光标位置',time:'0:00',seconds:0,status:'idle',selected:false});status='调整视频时间后，点击获取候选截图。';error='';render();
    }
    if(action==='fetch')void fetchFrames();
    if(action==='insert')void insert();
    if(action==='locate'){
      const marker=`:::image ${b.dataset.asset}`,body=$('#ed-body'),at=body.value.indexOf(marker);if(at>=0){body.focus();body.setSelectionRange(at,at+marker.length);}
    }
    if(action==='remove'){
      const id=b.dataset.asset;if(!/^[a-zA-Z0-9-]+$/.test(id))return;
      const article=getArticle();setBody(article.body.split('\n').filter(line=>line.trim()!==`:::image ${id}`).join('\n'));refreshAssets();render();
    }
  });
  return {refresh(){if(!disposed)render();},dispose(){disposed=true;requestSerial++;clearTimeout(timer);}};
}
