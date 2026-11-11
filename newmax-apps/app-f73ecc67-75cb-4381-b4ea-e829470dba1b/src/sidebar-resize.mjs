export const SIDEBAR_LAYOUT_KEY='yingdu.layout.v1';
const limits={sidebarWidth:{min:160,max:400},videoPaneWidth:{min:240,max:640}};
const viewportWidth=value=>Number.isFinite(value)&&value>0?value:1024;
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
export function normalizePaneWidth(value,key){
  const bound=limits[key];
  return bound&&typeof value==='number'&&Number.isFinite(value)?clamp(Math.round(value),bound.min,bound.max):null;
}
export const normalizeSidebarWidth=value=>normalizePaneWidth(value,'sidebarWidth');
export function paneWidths(preferences={},viewport){
  const w=viewportWidth(viewport),mobile=w<=860;
  if(mobile)return {sidebarWidth:207,videoPaneWidth:w,mobile};
  const available=w-360-2; // 两条1px分隔线，至少360px阅读空间。
  const sidebarWidth=clamp(normalizeSidebarWidth(preferences.sidebarWidth)??(w<=1100?167:192),160,Math.min(400,available-240));
  const videoPaneWidth=clamp(normalizePaneWidth(preferences.videoPaneWidth,'videoPaneWidth')??(w>=1400?345:w>1100?310:274),240,Math.min(640,available-sidebarWidth));
  return {sidebarWidth,videoPaneWidth,mobile};
}
export function paneBounds(key,widths,viewport){
  const bound=limits[key],other=key==='sidebarWidth'?'videoPaneWidth':'sidebarWidth';
  return {min:bound.min,max:Math.max(bound.min,Math.min(bound.max,Math.floor(viewportWidth(viewport)-360-2-widths[other])))};
}
export function setupSidebarResize({document:doc,window:win,load,save,onError=()=>{}}){
  const sidebar=doc.querySelector('#sidebar'),video=doc.querySelector('.video-pane');if(!sidebar||!video)return;
  video.id ||= 'video-pane';
  const panes=[{key:'sidebarWidth',pane:sidebar,id:'sidebar-resizer',label:'频道栏'},
    {key:'videoPaneWidth',pane:video,id:'video-pane-resizer',label:'视频列表'}];
  for(const item of panes){
    const bar=doc.createElement('div');item.bar=bar;bar.className='pane-resizer';bar.id=item.id;bar.tabIndex=0;
    bar.setAttribute('role','separator');bar.setAttribute('aria-orientation','vertical');bar.setAttribute('aria-controls',item.pane.id);
    bar.setAttribute('aria-label','调整'+item.label+'宽度');bar.title=`拖拽调整${item.label}宽度；方向键微调，双击或 Enter 恢复本栏默认宽度`;
    item.pane.after(bar);
  }
  let preferences={sidebarWidth:null,videoPaneWidth:null},touched=false,drag=null,queue=Promise.resolve();
  function apply(){
    const widths=paneWidths(preferences,win.innerWidth);
    for(const item of panes){
      const {bar,pane,key}=item,b=paneBounds(key,widths,win.innerWidth);
      bar.hidden=widths.mobile;
      if(widths.mobile)pane.style.removeProperty('width');else pane.style.width=widths[key]+'px';
      bar.setAttribute('aria-valuemin',String(b.min));bar.setAttribute('aria-valuemax',String(b.max));
      bar.setAttribute('aria-valuenow',String(widths[key]));bar.setAttribute('aria-valuetext',widths[key]+' 像素');
    }
  }
  function commit(){
    const value={...preferences};
    queue=queue.catch(()=>{}).then(()=>save(value)).catch(()=>onError('栏宽未能保存，仅在本次窗口生效；请检查本地存储后重试。'));
  }
  function end(cancel=false){
    if(!drag)return;
    const {original,id,item}=drag;drag=null;
    doc.body.classList.remove('resizing-panes');item.bar.classList.remove('is-dragging');
    try{if(item.bar.hasPointerCapture(id))item.bar.releasePointerCapture(id);}catch{}
    if(cancel){preferences=original;apply();}else commit();
  }
  for(const item of panes){
    const {bar,key,pane}=item;
    bar.addEventListener('pointerdown',event=>{
      if(event.button!==0||paneWidths(preferences,win.innerWidth).mobile||drag)return;
      event.preventDefault();touched=true;bar.focus();
      drag={id:event.pointerId,x:event.clientX,width:pane.getBoundingClientRect().width,original:{...preferences},item};
      try{bar.setPointerCapture(event.pointerId);}catch{}
      bar.classList.add('is-dragging');doc.body.classList.add('resizing-panes');
    });
    bar.addEventListener('lostpointercapture',()=>{if(drag?.item===item)end(true);});
    bar.addEventListener('dblclick',()=>{if(bar.hidden)return;end(true);touched=true;preferences[key]=null;apply();commit();});
    bar.addEventListener('keydown',event=>{
      if(bar.hidden||drag)return;
      const widths=paneWidths(preferences,win.innerWidth),b=paneBounds(key,widths,win.innerWidth),step=event.shiftKey?24:8;
      if(event.key==='ArrowLeft')preferences[key]=Math.max(b.min,widths[key]-step);
      else if(event.key==='ArrowRight')preferences[key]=Math.min(b.max,widths[key]+step);
      else if(event.key==='Home')preferences[key]=b.min;
      else if(event.key==='End')preferences[key]=b.max;
      else if(event.key==='Enter')preferences[key]=null;
      else return;
      event.preventDefault();touched=true;apply();commit();
    });
  }
  win.addEventListener('pointermove',event=>{
    if(!drag||event.pointerId!==drag.id)return;
    const key=drag.item.key,b=paneBounds(key,paneWidths(preferences,win.innerWidth),win.innerWidth);
    preferences[key]=clamp(Math.round(drag.width+event.clientX-drag.x),b.min,b.max);apply();
  });
  win.addEventListener('pointerup',event=>{if(drag?.id===event.pointerId)end();});
  win.addEventListener('pointercancel',event=>{if(drag?.id===event.pointerId)end(true);});
  win.addEventListener('blur',()=>end(true));
  win.addEventListener('keydown',event=>{if(event.key==='Escape'&&drag){event.preventDefault();end(true);}});
  win.addEventListener('resize',()=>{end(true);apply();});
  apply();
  Promise.resolve().then(load).then(value=>{
    if(!touched){preferences={sidebarWidth:normalizeSidebarWidth(value?.sidebarWidth),videoPaneWidth:normalizePaneWidth(value?.videoPaneWidth,'videoPaneWidth')};apply();}
  }).catch(()=>onError('栏宽读取失败，暂用默认宽度；阅读资料不受影响。'));
}
