import {mountBulkReview,wait} from './bulk-read-ui.mjs';
function assert(ok,text){if(!ok)throw new Error(text);}
export async function mountSidebarReview(width=1000,seed){
  const ctx=await mountBulkReview(width,640,seed);await wait(()=>ctx.doc.querySelector('#sidebar-resizer'));return ctx;
}
export function dragSidebar(ctx,delta,cancel=false){
  const {doc:d,w}=ctx,bar=d.querySelector('#sidebar-resizer'),x=bar.getBoundingClientRect().left+3;
  bar.dispatchEvent(new w.PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:7,clientX:x}));
  w.dispatchEvent(new w.PointerEvent('pointermove',{pointerId:7,clientX:x+delta}));
  if(cancel)w.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  else w.dispatchEvent(new w.PointerEvent('pointerup',{pointerId:7,clientX:x+delta}));
}
export async function exerciseSidebarReview(ctx){
  const {doc:d,w,ids}=ctx,store=w.__harness.store,$=s=>d.querySelector(s);
  const width=()=>$('#sidebar').getBoundingClientRect().width;
  const readBefore=JSON.stringify(store.get('yingdu.workspace.v1'));
  assert($('[data-action="channel"][data-id="one"] .channel-unread').textContent==='2','初始频道未读数错误');
  $('[data-action="mark-all-read"]').click();$('[data-action="confirm-bulk-read"]').click();await wait(()=>!$('#app-dialog').open);
  assert(!$('[data-action="channel"][data-id="one"] .channel-unread'),'全部已读仍有角标');
  assert($('[data-action="channel"][data-id="two"] .channel-unread').textContent==='1','误改其他频道');
  $('[data-action="undo-bulk-read"]').click();await wait(()=>$('[data-action="channel"][data-id="one"] .channel-unread')?.textContent==='2');
  const recordsBefore=JSON.stringify(store.get('yingdu.workspace.v1'));
  dragSidebar(ctx,133);await wait(()=>store.get('yingdu.layout.v1')?.sidebarWidth===300);
  assert(width()===300,'拖拽尺寸错误');
  dragSidebar(ctx,-80,true);await new Promise(r=>setTimeout(r,50));assert(width()===300&&store.get('yingdu.layout.v1').sidebarWidth===300,'取消拖拽仍保存');
  const bar=$('#sidebar-resizer');bar.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await wait(()=>store.get('yingdu.layout.v1').sidebarWidth===308);
  bar.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Home',bubbles:true}));await wait(()=>store.get('yingdu.layout.v1').sidebarWidth===160);
  bar.dispatchEvent(new w.KeyboardEvent('keydown',{key:'End',bubbles:true}));await wait(()=>store.get('yingdu.layout.v1').sidebarWidth===364);
  bar.dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true}));await wait(()=>store.get('yingdu.layout.v1').sidebarWidth===null);assert(width()===167,'恢复默认失败');
  const goodSet=w.newmaxApp.data.set;
  w.newmaxApp.data.set=async(k,v)=>{if(k==='yingdu.layout.v1')throw new Error('隔离布局存储失败');return goodSet(k,v);};
  dragSidebar(ctx,100);await wait(()=>$('#toast').textContent.includes('仅在本次窗口生效'));
  assert(store.get('yingdu.layout.v1').sidebarWidth===null&&width()===267,'失败错误地保存了宽度');
  w.newmaxApp.data.set=goodSet;
  bar.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await wait(()=>width()===167);await new Promise(r=>setTimeout(r,30));
  assert(JSON.stringify(store.get('yingdu.workspace.v1'))===recordsBefore,'调宽改动阅读资料');
  assert(w.__harness.calls.length===0,'不应调用AI');
  return {passed:true,evidence:'真实隔离UI：未读2→标记后隐藏→撤销恢复；拖拽167→300、Esc取消、方向键308、Home160/End364、双击/Enter复原；保存失败保留旧布局且明确仅本窗口生效，阅读资料不变、AI0。',seed:[...store.entries()]};
}
