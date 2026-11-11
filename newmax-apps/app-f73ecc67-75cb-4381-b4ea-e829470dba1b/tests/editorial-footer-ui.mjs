// 实际顶层编辑器交互；只读生产资料，仅写唯一临时草稿，不联网或调用AI。
import {openEditorial} from '../src/editorial-ui.mjs';
import {newArticle,crc32} from '../src/editorial.mjs';
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
async function wait(check){for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,25));}throw new Error('等待页脚UI状态超时');}
export let currentFooterReview=null;
const blobURL=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});
export async function mountFooterReview(){
  assert(!document.querySelector('.editorial-dialog'),'已有排版窗口，请保留其中未保存内容');
  const sdk=window.newmaxApp,cap=await sdk.capabilities?.inspect();assert(cap?.version==='host-capabilities-v1','未确认运行主进程能力');
  const id='footer-review-'+crypto.randomUUID(),key='yingdu.editorial.'+id;
  const body='# 页脚验收文章\n\n第一页完整文字。\n\n---\n\n第二页完整文字。尾文唯一标记';
  const record={analysis:body,analysisCompletion:{termination:'stop'},analysisAttempt:{text:'# 未完成文章\n\n草稿内容不能冒充完整解析'},messages:[{role:'assistant',text:body.replace('第一页','换源后第一页')}]};
  const video={id,title:'临时页脚验收',channelTitle:'临时来源',local:true,url:''};
  const ctx={sdk,id,key,record,recordBefore:JSON.stringify(record),video,draws:[],downloads:[],stage:'mount',failSave:false,aiCalls:0};
  currentFooterReview=ctx;
  ctx.workspaceBefore=JSON.stringify(await sdk.data.get('yingdu.workspace.v1'));
  const legacy={...newArticle(video,{id:'analysis',text:body}),paper:'plain',autoCover:false};delete legacy.footerText;
  await sdk.data.set(key,legacy);
  ctx.originalDraw=CanvasRenderingContext2D.prototype.fillText;
  ctx.drawHook=function(text,x,y,...args){if(this.canvas.width===1080&&x===72&&y===this.canvas.height-76)ctx.draws.push(String(text));return ctx.originalDraw.call(this,text,x,y,...args);};
  CanvasRenderingContext2D.prototype.fillText=ctx.drawHook;
  ctx.originalClick=HTMLAnchorElement.prototype.click;
  ctx.downloadHook=function(){if(this.href.startsWith('blob:')&&/\.(png|zip)$/i.test(this.download)){ctx.downloads.push({name:this.download,promise:fetch(this.href).then(r=>r.blob())});return;}return ctx.originalClick.call(this);};
  HTMLAnchorElement.prototype.click=ctx.downloadHook;
  ctx.proxy={data:{get:async k=>{assert(k===key,'禁止读取其它排版资料');return sdk.data.get(k);},set:async(k,value)=>{assert(k===key,'禁止写入其它资料');if(ctx.failSave)throw new Error('隔离保存失败');return sdk.data.set(k,value);}},files:{readText:async()=>{throw new Error('测试没有配图');},writeText:async()=>{throw new Error('测试不得写图片');}},ai:{chat:async()=>{ctx.aiCalls++;throw new Error('禁止AI');},stream:async()=>{ctx.aiCalls++;throw new Error('禁止AI');}}};
  ctx.open=async()=>{await openEditorial({sdk:ctx.proxy,video,record,transcript:'',brand:'映读 · 临时页脚验收'});ctx.root=document.querySelector('.editorial-dialog');assert(ctx.root,'编辑器未打开');await wait(()=>!ctx.root.querySelector('#ed-fields').disabled);};
  ctx.close=async()=>{if(!ctx.root?.isConnected)return;ctx.root.querySelector('[data-ed="close"]').click();if(!ctx.root.querySelector('#ed-confirm').hidden)ctx.root.querySelector('[data-ed="confirm"]').click();await wait(()=>!ctx.root.isConnected);};
  ctx.set=async(value)=>{const field=ctx.root.querySelector('#ed-footer');const before=ctx.root.querySelector('#ed-stage canvas');field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));assert(ctx.root.querySelector('[data-ed="export-page"]').disabled,'更新期间未禁止导出');await wait(()=>ctx.root.querySelector('#ed-stage canvas')!==before&&!ctx.root.querySelector('[data-ed="export-page"]').disabled);};
  await ctx.open();assert(ctx.root.querySelector('#ed-footer').value==='视频精读'&&ctx.draws.at(-1)==='视频精读','旧稿默认页脚不兼容');
  return ctx;
}
export async function exerciseFooterReview(ctx){
  const $=s=>ctx.root.querySelector(s),custom='我的知识笔记 · 映读';
  ctx.stage='edit-save';await ctx.set(custom);assert(ctx.draws.at(-1)===custom,'预览页脚未替换');
  $('[data-ed="save"]').click();await wait(()=>$('#ed-save-state').textContent==='已保存在本机');assert((await ctx.sdk.data.get(ctx.key)).footerText===custom,'真实SDK未保存页脚');
  await ctx.close();await ctx.open();assert($('#ed-footer').value===custom&&ctx.draws.at(-1)===custom,'重开未恢复页脚');
  ctx.stage='export';const snapshots=[$('#ed-stage canvas').toDataURL('image/png')];$('[data-ed="next"]').click();snapshots.push($('#ed-stage canvas').toDataURL('image/png'));assert(ctx.draws.at(-1)===custom,'第二页未使用同一页脚');$('[data-ed="prev"]').click();
  $('[data-ed="export-page"]').click();await wait(()=>ctx.downloads.length===1&&!$('[data-ed="export-all"]').disabled);
  const png=await ctx.downloads[0].promise;assert(await blobURL(png)===snapshots[0],'PNG与预览不一致');
  $('[data-ed="export-all"]').click();await wait(()=>ctx.downloads.length===2&&!$('[data-ed="export-all"]').disabled);
  const zip=await ctx.downloads[1].promise,bytes=new Uint8Array(await zip.arrayBuffer()),view=new DataView(bytes.buffer);let offset=0,pages=0;
  while(offset+30<=bytes.length&&view.getUint32(offset,true)===0x04034b50){const size=view.getUint32(offset+18,true),name=view.getUint16(offset+26,true),extra=view.getUint16(offset+28,true),start=offset+30+name+extra;const data=bytes.slice(start,start+size);assert(crc32(data)===view.getUint32(offset+14,true),'ZIP页CRC错误');assert(await blobURL(new Blob([data],{type:'image/png'}))===snapshots[pages],'ZIP页与预览不一致');pages++;offset=start+size;}
  assert(pages===2,'分页ZIP遗漏页面');ctx.exportResult={pngBytes:png.size,zipBytes:zip.size,pages};
  ctx.stage='blank-save';const beforeBlank=ctx.draws.length;await ctx.set('');assert(ctx.draws.length===beforeBlank,'空页脚仍绘制了左下文字');
  $('[data-ed="save"]').click();await wait(()=>$('#ed-save-state').textContent==='已保存在本机');await ctx.close();await ctx.open();assert($('#ed-footer').value===''&&(await ctx.sdk.data.get(ctx.key)).footerText==='','空页脚重开变回默认');
  await ctx.set(custom);$('[data-ed="save"]').click();await wait(()=>$('#ed-save-state').textContent==='已保存在本机');
  ctx.stage='failure';await ctx.set('失败不能覆盖已保存文字');ctx.failSave=true;$('[data-ed="save"]').click();await wait(()=>!$('#ed-error').hidden&&$('#ed-error').textContent.includes('隔离保存失败'));await new Promise(r=>setTimeout(r,350));assert(!$('#ed-error').hidden&&(await ctx.sdk.data.get(ctx.key)).footerText===custom,'失败覆盖旧草稿或错误被清除');ctx.failSave=false;await ctx.close();await ctx.open();
  ctx.stage='source-status';$('#ed-source').value='draft';$('[data-ed="apply-source"]').click();$('[data-ed="confirm"]').click();await wait(()=>ctx.draws.at(-1)?.includes('未完成草稿'));
  await ctx.set('');assert(ctx.draws.at(-1).includes('未完成草稿'),'清空页脚隐藏未完成状态');
  await ctx.set(custom);$('#ed-source').value='reply-0';$('[data-ed="apply-source"]').click();$('[data-ed="confirm"]').click();await wait(()=>$('#ed-body').value.includes('换源后第一页')&&!$('[data-ed="export-page"]').disabled);assert($('#ed-footer').value===custom&&ctx.draws.at(-1)===custom,'载入来源重置页脚');
  ctx.stage='long';const long='长页脚😎'.repeat(150);await ctx.set(long);assert(ctx.draws.at(-1).endsWith('…')&&$('#ed-footer').value===long,'长页脚未安全省略或改写输入');await ctx.set(custom);
  ctx.stage='ready';assert(JSON.stringify(ctx.record)===ctx.recordBefore,'修改了来源解析');assert(JSON.stringify(await ctx.sdk.data.get('yingdu.workspace.v1'))===ctx.workspaceBefore,'修改了生产workspace');assert(ctx.aiCalls===0,'调用了AI');
  return {passed:true,evidence:'真实页脚input即时重绘、旧稿默认兼容、真实SDK保存关闭重开、自定义与空值保持、保存失败不覆盖、未完成状态保留、换源不重置、长页脚省略、两页PNG/ZIP逐页与预览一致及CRC通过；来源record/生产workspace不变，AI0。',...ctx.exportResult};
}
export async function cleanupFooterReview(ctx){
  await ctx.close();
  if(CanvasRenderingContext2D.prototype.fillText===ctx.drawHook)CanvasRenderingContext2D.prototype.fillText=ctx.originalDraw;
  if(HTMLAnchorElement.prototype.click===ctx.downloadHook)HTMLAnchorElement.prototype.click=ctx.originalClick;
  const saved=await ctx.sdk.data.get(ctx.key);assert(ctx.key==='yingdu.editorial.'+ctx.id&&ctx.id.startsWith('footer-review-')&&saved?.title==='页脚验收文章','临时草稿身份不符，未删除');await ctx.sdk.data.delete(ctx.key);
  assert(JSON.stringify(await ctx.sdk.data.get('yingdu.workspace.v1'))===ctx.workspaceBefore,'生产阅读资料已改变');
  if(currentFooterReview===ctx)currentFooterReview=null;
  return {passed:true,evidence:'已按唯一UUID和标题核验后删除临时SDK草稿；绘制/下载拦截恢复，未改生产解析、订阅或排版。'};
}
