import {mountSidebarReview} from './sidebar-ui.mjs';
import {wait} from './bulk-read-ui.mjs';
const assert=(value,message)=>{if(!value)throw new Error(message);};
export function dragPane(ctx,id,delta,cancel=false){
  const {w,doc:d}=ctx,bar=d.querySelector('#'+id),x=bar.getBoundingClientRect().left;
  bar.dispatchEvent(new w.PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:17,clientX:x}));
  w.dispatchEvent(new w.PointerEvent('pointermove',{pointerId:17,clientX:x+delta}));
  if(cancel)w.dispatchEvent(new w.PointerEvent('pointercancel',{pointerId:17}));
  else w.dispatchEvent(new w.PointerEvent('pointerup',{pointerId:17,clientX:x+delta}));
}
export async function mountPaneReview(seed){
  const ctx=await mountSidebarReview(1400,seed);await wait(()=>ctx.doc.querySelector('#video-pane-resizer'));return ctx;
}
export async function exercisePanes(ctx){
  const {w,doc:d}=ctx,$=s=>d.querySelector(s),store=w.__harness.store;
  const before=JSON.stringify(store.get('yingdu.workspace.v1'));
  const widths=()=>[$('#sidebar').getBoundingClientRect().width,$('.video-pane').getBoundingClientRect().width];
  const layout=()=>store.get('yingdu.layout.v1');
  assert(JSON.stringify(widths())==='[192,345]','初始宽度错误');
  dragPane(ctx,'sidebar-resizer',108);dragPane(ctx,'video-pane-resizer',155);
  await wait(()=>layout()?.sidebarWidth===300&&layout()?.videoPaneWidth===500);
  assert(JSON.stringify(widths())==='[300,500]','两条拖拽未分别生效');
  dragPane(ctx,'video-pane-resizer',-100,true);await new Promise(r=>setTimeout(r,30));
  assert(JSON.stringify(widths())==='[300,500]'&&layout().videoPaneWidth===500,'取消改变保存值');
  $('#sidebar-resizer').dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true}));await wait(()=>layout().sidebarWidth===null);
  assert(JSON.stringify(widths())==='[192,500]','频道重置误改视频栏');
  $('#video-pane-resizer').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await wait(()=>layout().videoPaneWidth===null);
  assert(JSON.stringify(widths())==='[192,345]','视频重置失败');
  const bar=$('#video-pane-resizer');bar.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true}));await wait(()=>layout().videoPaneWidth===369);
  bar.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Home',bubbles:true}));await wait(()=>layout().videoPaneWidth===240);
  bar.dispatchEvent(new w.KeyboardEvent('keydown',{key:'End',bubbles:true}));await wait(()=>layout().videoPaneWidth===640);
  const normalSet=w.newmaxApp.data.set;w.newmaxApp.data.set=async(k,v)=>{if(k==='yingdu.layout.v1')throw new Error('隔离存储失败');return normalSet(k,v);};
  dragPane(ctx,'video-pane-resizer',-60);await wait(()=>$('#toast').textContent.includes('仅在本次窗口生效'));
  assert(layout().videoPaneWidth===640&&widths()[1]===580,'保存失败未保留旧值');w.newmaxApp.data.set=normalSet;
  dragPane(ctx,'sidebar-resizer',108);dragPane(ctx,'video-pane-resizer',-80);await wait(()=>layout().sidebarWidth===300&&layout().videoPaneWidth===500);
  const styleChecks=[];
  for(const id of ['sidebar-resizer','video-pane-resizer']){
    const el=$('#'+id);el.focus();const css=w.getComputedStyle(el),hit=w.getComputedStyle(el,':before');
    styleChecks.push({id,width:css.width,outline:css.outlineStyle,border:css.borderRightWidth,shadow:css.boxShadow,hit:hit.width});
    assert(css.width==='1px'&&css.outlineStyle==='none'&&css.boxShadow==='none'&&css.borderRightWidth==='0px'&&hit.width==='9px','分隔线仍有外框或命中范围过窄');
  }
  assert(w.getComputedStyle($('#sidebar')).borderRightWidth==='0px'&&w.getComputedStyle($('.video-pane')).borderRightWidth==='0px','父栏边界重复成双线');
  const reader=$('#reader'),readerNode=reader.firstElementChild;
  ctx.frame.style.width='861px';await wait(()=>w.innerWidth===861);await new Promise(r=>setTimeout(r,40));
  assert(reader.getBoundingClientRect().width>=360&&d.documentElement.scrollWidth===861,'窄桌面挤压正文或溢出');
  ctx.frame.style.width='640px';await wait(()=>w.innerWidth===640);await new Promise(r=>setTimeout(r,40));
  assert($('#sidebar-resizer').hidden&&$('#video-pane-resizer').hidden&&d.documentElement.scrollWidth===640,'移动布局未隐藏分隔');
  ctx.frame.style.width='1400px';await wait(()=>w.innerWidth===1400);await new Promise(r=>setTimeout(r,40));
  assert(JSON.stringify(widths())==='[300,500]'&&reader.firstElementChild===readerNode,'恢复桌面丢失偏好或重绘正文');
  assert(JSON.stringify(store.get('yingdu.workspace.v1'))===before&&w.__harness.calls.length===0,'调宽更改阅读数据或调用AI');
  return {passed:true,evidence:'双拖拽300/500、独立重置、视频栏键盘/取消/失败保护、两线1px无outline/阴影且9px命中、861px阅读>=360、640px双线隐藏、返回桌面恢复且正文节点未重建全部通过。',styleChecks,seed:[...store.entries()]};
}
