// 在实际应用窗口中运行的隔离交互；不接入真实频道、网络或AI。
export async function mountBulkReview(width=1000,height=700,seed){
  const prefix='bulk-read-review-';
  const ids=['a','b','c','d'].map(x=>prefix+x);
  const [a,b,c,d]=ids;
  const video=(id,title,channelId)=>({id,title,channelId,channelTitle:channelId==='one'?'临时频道一':'临时频道二',transcriptStatus:'none'});
  const initial=[['yingdu.workspace.v1',{records:{[a]:{read:false,favorite:true,analysis:'原解析必须保留',messages:[{role:'user',text:'原对话'}]},[c]:{read:false},[d]:{read:true,favorite:true}},imports:[],model:''}],['yingdu.library-cache.v1',{channels:[{id:'one',title:'临时频道一',status:'ready'},{id:'two',title:'临时频道二',status:'ready'}],videos:[video(a,'学习 A','one'),video(b,'学习 B','one'),video(c,'生活 C','two'),video(d,'学习 D','two')],settings:{intervalMinutes:30,autoCaptions:false},lastSync:null}]];
  window.__yingduIsolatedSeed=seed||initial;
  const frame=document.createElement('iframe');frame.id='bulk-read-review-frame';frame.style=`position:fixed;inset:10px auto auto 10px;width:${width}px;height:${height}px;border:1px solid #ddd;z-index:200;background:white;box-sizing:content-box`;
  frame.src=new URL('./ui-harness.html',import.meta.url);document.body.append(frame);
  await wait(()=>frame.contentWindow?.__harness&&frame.contentDocument.querySelector('[data-action="mark-all-read"]'));
  await new Promise(r=>setTimeout(r,120));
  delete window.__yingduIsolatedSeed;
  return {frame,w:frame.contentWindow,doc:frame.contentDocument,ids,initial};
}
export async function wait(test){for(let i=0;i<150;i++){if(await test())return;await new Promise(r=>setTimeout(r,20));}throw new Error('等待UI状态超时');}
function assert(value,message){if(!value)throw new Error(message);}
export async function exerciseBulkReview(ctx){
  const {w,doc,ids}=ctx,[a,b,c,d]=ids,h=w.__harness;
  const $=s=>doc.querySelector(s), click=s=>{const el=$(s);assert(el&&!el.disabled,'控件不可用：'+s);el.click();};
  const records=()=>h.store.get('yingdu.workspace.v1').records;
  const initial=JSON.stringify(records());
  click('[data-action="mark-all-read"]');assert($('#dialog-body').textContent.includes('2 条未读'),'确认数量错误');click('[data-action="close-dialog"]');
  assert(JSON.stringify(records())===initial,'取消不能修改资料');
  let writes=0,fail=false;const baseSet=w.newmaxApp.data.set;
  w.newmaxApp.data.set=async(k,v)=>{if(k==='yingdu.workspace.v1'){writes++;await new Promise(r=>setTimeout(r,70));if(fail)throw new Error('隔离保存失败');}return baseSet(k,v);};
  click('[data-action="mark-all-read"]');const confirm=$('[data-action="confirm-bulk-read"]');confirm.click();confirm.click();
  await wait(()=>!$('#app-dialog').open);
  assert(writes===1,'重复点击重复写入');assert(records()[a].read&&records()[b].read&&!records()[c].read&&records()[d].read,'频道范围错误');
  assert(records()[a].analysis==='原解析必须保留'&&records()[a].messages[0].text==='原对话'&&records()[a].favorite,'正文或收藏被改');
  click('[data-action="undo-bulk-read"]');await wait(()=>!$('[data-action="undo-bulk-read"]'));
  assert(!records()[a].read&&!records()[b]?.read,'撤销未恢复');
  fail=true;const persisted=JSON.stringify(records());click('[data-action="mark-all-read"]');click('[data-action="confirm-bulk-read"]');
  await wait(()=>$('#dialog-error')?.textContent.includes('保存失败'));
  assert(JSON.stringify(records())===persisted,'失败写入资料');assert($('[data-action="confirm-bulk-read"]').disabled===false,'失败无法重试');
  fail=false;click('[data-action="confirm-bulk-read"]');await wait(()=>!$('#app-dialog').open);
  // 手动修改当前视频两次，撤销不能把后续明确的已读选择覆盖。
  click('[data-action="toggle-read"]');await wait(()=>records()[a].read===false);click('[data-action="toggle-read"]');await wait(()=>records()[a].read===true);
  click('[data-action="undo-bulk-read"]');await wait(()=>!$('[data-action="undo-bulk-read"]'));
  assert(records()[a].read&&!records()[b]?.read,'撤销覆盖了手动选择');
  // 全库搜索只标记匹配未读；无匹配时禁用。
  click('[data-action="filter"][data-value="all"]');$('#video-search').value='不存在的内容';$('#video-search').dispatchEvent(new w.Event('input',{bubbles:true}));assert($('[data-action="mark-all-read"]').disabled,'空列表未禁用');
  $('#video-search').value='学习 B';$('#video-search').dispatchEvent(new w.Event('input',{bubbles:true}));click('[data-action="mark-all-read"]');
  assert($('#dialog-body').textContent.includes('搜索「学习 B」')&&$('#dialog-body').textContent.includes('1 条未读'),'搜索范围未说明');click('[data-action="confirm-bulk-read"]');await wait(()=>!$('#app-dialog').open);
  assert(records()[b].read&&!records()[c].read,'搜索误改其他视频');
  $('#video-search').value='';$('#video-search').dispatchEvent(new w.Event('input',{bubbles:true}));
  click('[data-action="filter"][data-value="unread"]');assert($('#list-count').textContent==='1','未读过滤数量错误');
  click('[data-action="mark-all-read"]');click('[data-action="confirm-bulk-read"]');await wait(()=>!$('#app-dialog').open);
  assert($('#list-count').textContent==='0'&&$('[data-action="mark-all-read"]').disabled,'未读清空后状态错误');
  assert(h.calls.length===0,'不应调用AI');
  return {passed:true,evidence:'临时频道2条确认/取消、一次保存防重复、失败回滚与重试、撤销及手动修改保护、全库搜索1条、未读清空与空列表禁用全部通过；AI调用0。',seed:[...h.store.entries()]};
}
