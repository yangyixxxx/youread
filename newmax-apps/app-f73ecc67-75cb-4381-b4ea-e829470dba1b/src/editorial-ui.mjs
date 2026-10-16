import {escapeHTML as esc} from './core.mjs';
import {articleSources,newArticle,validateArticle,layoutArticle,loadImage,normalizeUpload,renderArticlePage,pngBlob,zipFiles,downloadBlob,articleBlocks} from './editorial.mjs';

import {attachFramePicker} from './frame-picker.mjs';
import {validFrameSource} from './frame-plan.mjs';
import {canFetchCover,shouldFetchCover,fetchVideoCover,validCoverSource} from './cover.mjs';

let activeEditor=null;
const tick=()=>new Promise(r=>setTimeout(r,0));
export async function openEditorial({sdk,video,record,transcript,brand,frameApi}){
  if(activeEditor){activeEditor.focus();return;}
  if(!document.querySelector('#editorial-styles')){const link=document.createElement('link');link.id='editorial-styles';link.rel='stylesheet';link.href=new URL('./editorial.css',import.meta.url).href;document.head.append(link);}
  const opener=document.activeElement,sources=articleSources(video,record,transcript),key=`yingdu.editorial.${video.id}`;
  const root=document.createElement('dialog');root.className='editorial-dialog';root.setAttribute('aria-labelledby','editorial-title');activeEditor=root;
  root.innerHTML=`<header class="ed-header"><div><span class="ed-eyebrow">${esc(brand||'视频精读')} / 图文工坊</span><h2 id="editorial-title">把观点，排成一篇好读的图文。</h2></div><div class="ed-top-actions"><span id="ed-save-state" role="status">读取草稿中…</span><button class="button" data-ed="save" disabled>保存排版</button><button class="button quiet" data-ed="close">关闭 ×</button></div></header>
  <div class="ed-mobile-switch"><button data-ed="show-edit" aria-pressed="true">编辑内容</button><button data-ed="show-preview" aria-pressed="false">图片预览</button></div>
  <div id="ed-confirm" class="ed-confirm" hidden><span></span><button class="button" data-ed="cancel-confirm">保留当前内容</button><button class="button danger" data-ed="confirm">确认</button></div>
  <div id="ed-error" class="ed-error" role="alert" hidden></div>
  <div class="ed-workspace"><aside class="ed-sidebar"><fieldset id="ed-fields" disabled>
    <section class="ed-section"><div class="ed-section-heading"><span>01</span><h3>内容底稿</h3><span class="ed-local">本地排版 · 不调用 AI</span></div>
    <label class="ed-label" for="ed-source">复制自当前视频</label><div class="ed-source-row"><select id="ed-source">${sources.length?sources.map(s=>`<option value="${esc(s.id)}">${esc(s.label)}</option>`).join(''):'<option value="">手动输入</option>'}</select><button class="button" data-ed="apply-source" ${sources.length?'':'disabled'}>载入</button></div>
    <p class="ed-hint">只编辑排版副本，不会改动原解析或对话。载入不会重新生成。</p>
    <label class="ed-label" for="ed-title">文章标题</label><textarea id="ed-title" rows="2" placeholder="用一句完整的主张做标题"></textarea>
    <label class="ed-label" for="ed-byline">来源 / 署名</label><input id="ed-byline" placeholder="例如：频道名称 · 视频精读">
    <div id="ed-source-status" class="ed-hint"></div>
    <label class="ed-label" for="ed-body">正文 <span>Markdown</span></label><textarea id="ed-body" rows="14" spellcheck="false" placeholder="在这里写下你的图文内容…"></textarea>
    <div class="ed-inline-actions"><button class="button quiet" data-ed="page-break">＋ 手动分页</button><button class="button quiet" data-ed="inline-image">＋ 正文配图</button><button type="button" class="button quiet" data-frame="toggle" aria-expanded="false" aria-controls="ed-frame-panel">从视频取图</button></div><section id="ed-frame-panel" class="ed-frame-panel" aria-label="视频截图候选" hidden></section><div id="ed-frame-assets" class="ed-frame-assets"></div>
    <p class="ed-hint">## 分节标题 · **重点** · 独立 --- 分页。表格转为带列名的逐行文字，代码折行；外链图片不自动加载。完整内容会续页，不裁掉尾文。图片自动隐藏时间引用，底稿与阅读页跳转不受影响。</p></section>
    <section class="ed-section"><div class="ed-section-heading"><span>02</span><h3>纸面与配图</h3></div><div class="ed-controls"><label>页面比例<select id="ed-ratio"><option value="3:5">3:5 · 参考长页</option><option value="3:4">3:4 · 图文卡片</option><option value="9:16">9:16 · 竖屏</option></select></label><label>正文字号<select id="ed-font"><option value="36">36 · 紧凑</option><option value="40">40 · 标准</option><option value="44">44 · 大字</option></select></label></div>
    <label class="ed-label" for="ed-paper">纸面</label><select id="ed-paper"><option value="texture">暖白纸纹</option><option value="plain">暖白纯色</option><option value="white">纯白</option></select>
    <label class="ed-auto-cover"><input id="ed-auto-cover" type="checkbox" checked> 无封面时自动获取视频封面</label>
    <div class="ed-inline-actions"><button class="button" data-ed="fetch-cover">获取视频封面</button><button class="button quiet" data-ed="cover">上传替换</button><button class="button quiet" data-ed="remove-cover" hidden>移除封面</button></div><img id="ed-cover-preview" class="ed-cover-preview" alt="当前图文封面" hidden><p id="ed-cover-state" class="ed-hint" role="status">封面显示在标题下方、正文之前。</p><p class="ed-hint">仅下载视频封面图片，不调用 AI；保存排版后可离线复用。已有封面不会自动覆盖。</p>
    <input id="ed-image-file" type="file" accept="image/png,image/jpeg,image/webp" hidden><p class="ed-hint">配图仅保存在本机。PNG / JPEG / WebP，单张 ≤10 MB。请使用有权使用的图片。视频截图请点击「从视频取图」，不会自动抓取书封。</p></section>
    </fieldset></aside>
    <section class="ed-preview" aria-label="分页图片预览"><div class="ed-preview-toolbar"><div><strong id="ed-page-label">正在读取…</strong><span id="ed-dimensions">1080 × 1800 PNG</span></div><div class="ed-page-nav"><button class="button" data-ed="prev" aria-label="上一页" disabled>←</button><select id="ed-page-select" aria-label="选择预览页" disabled><option>1</option></select><button class="button" data-ed="next" aria-label="下一页" disabled>→</button></div></div>
    <div class="ed-stage" id="ed-stage"><div class="ed-empty">正在准备纸面…</div></div>
    <footer class="ed-export-bar"><span id="ed-preview-state" role="status">本地预览与导出使用同一画布</span><div><button class="button" data-ed="export-page" disabled>当前页 PNG</button><button class="button primary" data-ed="export-all" disabled>全部分页 ZIP ↓</button></div></footer></section></div>`;
  document.body.append(root);root.showModal();
  const $=s=>root.querySelector(s);
  let article=null,images={},texture=null,layout=null,page=0,dirty=false,busy=true,ready=false,renderTimer,revision=0,renderedRevision=-1,pendingAction=null,uploadTarget='inline',insertion=0;
  const frames=attachFramePicker({root,video,api:frameApi,getArticle:()=>article,setBody:body=>{$('#ed-body').value=body;modified();reflow();},changed:(id,image)=>{images[id]=image;}});
  let errorScope='',coverController=null,coverMessage='';
  const coverAvailable=canFetchCover(video);
  const error=(message,scope='operation')=>{errorScope=message?scope:'';$('#ed-error').textContent=message;$('#ed-error').hidden=!message;};
  const saveState=message=>{$('#ed-save-state').textContent=message;};
  const previewState=message=>{$('#ed-preview-state').textContent=message;};
  function controls(){
    $('#ed-fields').disabled=busy||!ready;
    for(const b of root.querySelectorAll('[data-ed]')){
      if(['close','confirm','cancel-confirm','show-edit','show-preview'].includes(b.dataset.ed))b.disabled=busy&&ready;
      else if(['export-page','export-all','prev','next'].includes(b.dataset.ed))b.disabled=busy||!layout||renderedRevision!==revision||!article?.body.trim()||(b.dataset.ed==='prev'&&page===0)||(b.dataset.ed==='next'&&page===layout?.pages.length-1);
      else b.disabled=busy||!ready;
    }
    $('[data-ed="apply-source"]').disabled=busy||!ready||!sources.length;
    $('#ed-page-select').disabled=busy||!layout||renderedRevision!==revision;
    $('#ed-auto-cover').disabled=busy||!ready||!coverAvailable;
    $('[data-ed="fetch-cover"]').disabled=busy||!ready||!coverAvailable||!!coverController;
    if(coverController)for(const action of ['save','cover','remove-cover','export-page','export-all'])$(`[data-ed="${action}"]`).disabled=true;
  }
  function readFields(){if(!article)return;article.title=$('#ed-title').value;article.byline=$('#ed-byline').value;article.body=$('#ed-body').value;article.ratio=$('#ed-ratio').value;article.fontSize=Number($('#ed-font').value);article.paper=$('#ed-paper').value;}
  function fillFields(){
    $('#ed-title').value=article.title;$('#ed-byline').value=article.byline;$('#ed-body').value=article.body;$('#ed-ratio').value=article.ratio;$('#ed-font').value=article.fontSize;$('#ed-paper').value=article.paper;
    if(sources.some(s=>s.id===article.sourceId))$('#ed-source').value=article.sourceId;
    $('#ed-source-status').textContent=article.sourceStatus?`来源标记：${article.sourceStatus}。该标记会出现在图片中。`:'';
    fillCover();
  }
  function modified(){readFields();dirty=true;revision++;saveState('有未保存修改');clearTimeout(renderTimer);previewState('排版更新中…');controls();frames.refresh();renderTimer=setTimeout(reflow,250);}
  function draw(){
    if(!layout)return;
    const canvas=renderArticlePage(layout,page,article,images,texture);canvas.setAttribute('role','img');canvas.setAttribute('aria-label',`图文第 ${page+1} 页，共 ${layout.pages.length} 页`);
    $('#ed-stage').replaceChildren(canvas);$('#ed-page-label').textContent=`第 ${page+1} 页 / 共 ${layout.pages.length} 页`;$('#ed-dimensions').textContent=`${layout.width} × ${layout.height} PNG`;
    $('#ed-page-select').replaceChildren(...layout.pages.map((_,i)=>new Option(String(i+1),String(i),false,i===page)));
    controls();
  }
  function reflow(){
    if(!ready||!root.open)return;
    try{
      const ctx=document.createElement('canvas').getContext('2d');
      layout=layoutArticle(article,(text,font)=>{ctx.font=font;return ctx.measureText(text).width;},images);
      renderedRevision=revision;page=Math.min(page,layout.pages.length-1);draw();
      previewState(article.body.trim()?`${layout.pages.length} 页 · 全文保留 · 本地导出`:'输入正文后即可导出');if(errorScope==='layout')error('');
    }catch(e){layout=null;renderedRevision=-1;$('#ed-stage').replaceChildren(Object.assign(document.createElement('div'),{className:'ed-empty',textContent:'无法完成排版，请修正上方错误。正文仍保留。'}));previewState('排版未完成，导出已暂停');error(e.message,'layout');controls();}
  }
  function confirmAction(message,fn,label='确认替换'){$('#ed-confirm span').textContent=message;$('[data-ed="confirm"]').textContent=label;$('#ed-confirm').hidden=false;pendingAction=fn;$('[data-ed="cancel-confirm"]').focus();}
  function close(){clearTimeout(renderTimer);coverController?.abort();coverController=null;frames.dispose();root.close();root.remove();activeEditor=null;opener?.focus();}
  function requestClose(){if(busy&&ready)return;if(dirty)confirmAction('排版尚未保存。关闭会丢失本次修改，原解析不受影响。',close,'放弃修改并关闭');else close();}
  async function save(){
    readFields();busy=true;controls();saveState('保存中…');error('');
    try{
      const copy=JSON.parse(JSON.stringify(article)),used=new Set(articleBlocks(copy.body).filter(b=>b.kind==='image').map(b=>b.id));if(copy.coverId)used.add(copy.coverId);
      copy.assets={};
      for(const id of used){
        const asset=article.assets[id];if(!asset)throw new Error(`配图 ${id} 缺失，请重新上传或移除标记后保存。`);
        const path=`editorial/images/${id}.json`;
        if(asset.dataUrl)await sdk.files.writeText(path,JSON.stringify(asset));
        const source=validFrameSource(asset.source)||validCoverSource(asset.source);
        copy.assets[id]={path,width:asset.width,height:asset.height,...(source?{source}:{})};
      }
      copy.savedAt=new Date().toISOString();await sdk.data.set(key,copy);dirty=false;saveState('已保存在本机');
    }catch(e){saveState('保存失败 · 修改仍在窗口中');error(`未保存：${e.message}`);}finally{busy=false;controls();}
  }
  async function exportImages(all){
    if(!layout||renderedRevision!==revision||busy)return;
    busy=true;controls();error('');
    try{
      const title=(article.title.trim()||'图文笔记').slice(0,80),files=[],indices=all?layout.pages.map((_,i)=>i):[page];
      for(const i of indices){previewState(`正在导出 ${i+1} / ${layout.pages.length} 页…`);await tick();const canvas=renderArticlePage(layout,i,article,images,texture);const blob=await pngBlob(canvas);
        if(all)files.push({name:`${String(i+1).padStart(3,'0')}.png`,bytes:new Uint8Array(await blob.arrayBuffer())});
        else downloadBlob(`${title}-${String(i+1).padStart(2,'0')}.png`,blob);
        canvas.width=0;canvas.height=0;
      }
      if(all)downloadBlob(`${title}-${layout.pages.length}页.zip`,zipFiles(files));
      previewState('已发起本地下载 · 请在下载位置查看文件');
    }catch(e){error(`导出失败：${e.message}。内容未修改，可以手动再试。`);previewState('导出未完成');}finally{busy=false;controls();}
  }
  async function upload(file){
    if(!file)return;busy=true;controls();error('');previewState('处理本地配图…');
    try{
      const asset=await normalizeUpload(file),id=crypto.randomUUID(),image=await loadImage(asset.dataUrl);article.assets[id]=asset;images[id]=image;
      if(uploadTarget==='cover'){article.coverId=id;coverMessage='';}
      else{const body=$('#ed-body');const marker=`\n\n:::image ${id}\n\n`;const pos=Math.min(insertion,body.value.length);body.value=body.value.slice(0,pos)+marker+body.value.slice(pos);body.selectionStart=body.selectionEnd=pos+marker.length;}
      modified();fillCover();reflow();
    }catch(e){error(e.message);previewState('配图未导入，原内容保留');}finally{busy=false;$('#ed-image-file').value='';controls();}
  }
  function fillCover(){
    $('[data-ed="remove-cover"]').hidden=!article.coverId;
    $('#ed-auto-cover').checked=coverAvailable&&article.autoCover!==false;
    const image=images[article.coverId],asset=article.assets[article.coverId],preview=$('#ed-cover-preview');
    preview.hidden=!image;if(image)preview.src=image.src;else preview.removeAttribute('src');
    const label=validCoverSource(asset?.source)?'视频封面已获取':'已设置封面';
    $('#ed-cover-state').textContent=coverMessage||(article.coverId?`${label} · ${asset?.width||image?.width} × ${asset?.height||image?.height} · 标题下方，完整比例`:
      !coverAvailable?'本地文稿无视频封面，可上传本地图片。':article.autoCover===false?'自动获取已关闭；可以手动获取或上传，标题下方展示。':'无封面，默认获取后放在标题下方；无图也可排版。');
  }
  async function getCover(){
    if(coverController||busy||!ready||!coverAvailable)return;
    const controller=new AbortController();coverController=controller;coverMessage='正在获取视频封面… 正文仍可编辑';fillCover();controls();
    try{
      const asset=await fetchVideoCover(video,{signal:controller.signal}),image=await loadImage(asset.dataUrl);
      if(!root.open||controller.signal.aborted||coverController!==controller)return;
      const id=crypto.randomUUID();article.assets[id]=asset;images[id]=image;article.coverId=id;coverMessage='';
      modified();fillCover();reflow();
    }catch(e){if(root.open&&!controller.signal.aborted&&coverController===controller){coverMessage=`${e.message} 正文与已有封面保留，可手动获取或上传。`;fillCover();}}
    finally{if(coverController===controller){coverController=null;if(root.open){fillCover();controls();}}}
  }
  root.addEventListener('cancel',e=>{e.preventDefault();requestClose();});
  root.addEventListener('keydown',e=>{e.stopPropagation();if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();if(ready&&!busy&&!coverController)save();}});
  root.addEventListener('input',e=>{if(['ed-title','ed-byline','ed-body'].includes(e.target.id))modified();});
  root.addEventListener('change',e=>{
    if(['ed-ratio','ed-font','ed-paper'].includes(e.target.id))modified();
    if(e.target.id==='ed-page-select'){page=Number(e.target.value);draw();$('#ed-stage').scrollTop=0;}
    if(e.target.id==='ed-image-file'&&!coverController)upload(e.target.files?.[0]);
    if(e.target.id==='ed-auto-cover'){
      article.autoCover=e.target.checked;
      if(!article.autoCover){coverController?.abort();coverController=null;coverMessage='';}
      modified();fillCover();if(shouldFetchCover(video,article))void getCover();
    }
  });
  root.addEventListener('click',async e=>{
    e.stopPropagation();const b=e.target.closest('[data-ed]');if(!b||b.disabled)return;
    const a=b.dataset.ed;
    if(a==='close'){requestClose();return;}
    if(a==='cancel-confirm'){$('#ed-confirm').hidden=true;pendingAction=null;return;}
    if(a==='confirm'){const fn=pendingAction;pendingAction=null;$('#ed-confirm').hidden=true;await fn?.();return;}
    if(a.startsWith('show-')){const preview=a==='show-preview';root.classList.toggle('ed-preview-mode',preview);$('[data-ed="show-preview"]').setAttribute('aria-pressed',String(preview));$('[data-ed="show-edit"]').setAttribute('aria-pressed',String(!preview));return;}
    if(busy||!ready)return;
    if(a==='save')await save();
    if(a==='prev'||a==='next'){page+=a==='next'?1:-1;draw();$('#ed-stage').scrollTop=0;}
    if(a==='export-page'||a==='export-all')await exportImages(a==='export-all');
    if(a==='cover'||a==='inline-image'){insertion=$('#ed-body').selectionStart;uploadTarget=a==='cover'?'cover':'inline';$('#ed-image-file').click();}
    if(a==='fetch-cover'){
      if(article.coverId)confirmAction('用当前视频封面替换这篇排版已有的封面？只有获取成功才替换，正文不变。',getCover,'获取并替换封面');
      else await getCover();
    }
    if(a==='remove-cover'){article.coverId='';article.autoCover=false;coverMessage='';fillCover();modified();}
    if(a==='page-break'){const body=$('#ed-body'),start=body.selectionStart,end=body.selectionEnd;body.setRangeText('\n\n---\n\n',start,end,'end');body.focus();modified();}
    if(a==='apply-source'){
      const source=sources.find(s=>s.id===$('#ed-source').value);if(!source)return;
      confirmAction('用所选来源替换当前排版标题与正文？原解析和对话不会改变。',()=>{const fresh=newArticle(video,source);article={...article,title:fresh.title,body:fresh.body,sourceId:fresh.sourceId,sourceStatus:fresh.sourceStatus};fillFields();page=0;modified();reflow();});
    }
  });
  try{
    const saved=await sdk.data.get(key);if(!root.open)return;
    article=saved?validateArticle(saved):newArticle(video,sources[0]);
    const used=new Set(articleBlocks(article.body).filter(b=>b.kind==='image').map(b=>b.id));if(article.coverId)used.add(article.coverId);
    for(const id of used){
      const asset=article.assets[id];if(!asset||asset.path!==`editorial/images/${id}.json`)throw new Error(`排版配图 ${id} 的保存记录无效。未改写原草稿。`);
      const raw=await sdk.files.readText(asset.path),data=JSON.parse(typeof raw==='string'?raw:raw.content);
      if(!/^data:image\/(jpeg|png|webp);base64,/.test(data.dataUrl||''))throw new Error('保存的配图不是本地图片数据。');
      images[id]=await loadImage(data.dataUrl);
    }
    try{texture=await loadImage(new URL('./assets/editorial-paper.png',import.meta.url).href);}catch{previewState('纸纹不可用，使用纯色纸面');}
    await document.fonts.ready;if(!root.open)return;
    ready=true;busy=false;fillFields();frames.refresh();saveState(saved?'已恢复本地排版':'尚未保存 · 原内容的副本');controls();reflow();
    if(shouldFetchCover(video,article))void getCover();
  }catch(e){busy=false;ready=false;error(`读取失败：${e.message} 请关闭后重开；为保护原稿，保存和导出已暂停。`);saveState('读取失败');$('#ed-stage').textContent='原解析和排版草稿未改动。';controls();}
}
