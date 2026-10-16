import {markdownTokens} from './markdown.mjs';

export function parseFrameTime(value){
  const text=String(value??'').trim();
  if(!/^\d{1,5}(?:\.\d{1,3})?$|^\d{1,3}:[0-5]\d(?:\.[0-9]{1,3})?$|^\d{1,2}:[0-5]\d:[0-5]\d(?:\.[0-9]{1,3})?$/.test(text))return null;
  const seconds=text.split(':').reduce((n,s)=>n*60+Number(s),0);
  return Number.isFinite(seconds)&&seconds>=0&&seconds<=43200?seconds:null;
}
export function frameTime(seconds){
  const total=Math.floor(seconds),h=Math.floor(total/3600),m=Math.floor(total%3600/60),s=String(total%60).padStart(2,'0');
  return h?`${h}:${String(m).padStart(2,'0')}:${s}`:`${m}:${s}`;
}
function tokenTimes(children=[]){
  const values=[];
  for(let i=0;i<children.length;i++){
    const t=children[i];
    if(t.type==='time_citation')values.push(t.meta.seconds);
    if(t.type==='link_open'){
      const end=children.findIndex((c,j)=>j>i&&c.type==='link_close');
      if(end>i){const label=children.slice(i+1,end).map(c=>c.content||'').join('').replace(/^\[|\]$/g,'');const n=parseFrameTime(label);if(n!==null&&label.includes(':'))values.push(n);i=end;}
    }
  }
  return values;
}
export function recommendFrames(body,{max=5,duration}={}){
  const text=String(body||''),lines=text.split('\n'),offsets=[0];
  for(const line of lines)offsets.push(offsets.at(-1)+line.length+1);
  const pool=[];let section='正文',heading=false;
  for(const token of markdownTokens(text)){
    if(token.type==='heading_open')heading=true;
    if(token.type==='heading_close')heading=false;
    if(token.type!=='inline'||!token.map)continue;
    const plain=(token.children||[]).filter(t=>['text','code_inline'].includes(t.type)).map(t=>t.content).join('').trim();
    if(heading){section=plain||section;continue;}
    const seconds=tokenTimes(token.children).find(n=>n>=0&&n<=43200&&(!Number.isFinite(duration)||n<duration)&&!pool.some(p=>Math.abs(p.seconds-n)<12));
    if(seconds===undefined||!plain)continue;
    pool.push({seconds,label:section,excerpt:plain.slice(0,110),offset:Math.min(text.length,offsets[token.map[1]])});
  }
  const limit=Math.max(1,Math.min(5,max));
  if(pool.length<=limit)return pool;
  // 按文章位置均匀覆盖，避免所有配图集中在开头；不是视觉语义识别。
  return Array.from({length:limit},(_,i)=>pool[Math.round(i*(pool.length-1)/(limit-1||1))]);
}
export function insertFrameMarkers(body,snapshot,items){
  if(body!==snapshot)throw new Error('正文已变化，原插入位置已失效。请重新推荐位置后再插入，已有候选图不会自动插入。');
  let output=body;const used=new Set();
  for(const item of [...items].sort((a,b)=>b.offset-a.offset)){
    if(!/^[a-zA-Z0-9-]+$/.test(item.assetId)||used.has(item.assetId)||!Number.isSafeInteger(item.offset)||item.offset<0||item.offset>body.length)throw new Error('截图插入位置无效，请重新推荐。');
    used.add(item.assetId);output=output.slice(0,item.offset)+`\n\n:::image ${item.assetId}\n\n`+output.slice(item.offset);
  }
  return output;
}
export function validFrameSource(value){
  return value?.type==='video-frame'&&/^[a-zA-Z0-9_-]{11}$/.test(value.videoId)&&typeof value.seconds==='number'&&Number.isFinite(value.seconds)&&value.seconds>=0&&value.seconds<=43200
    ?{type:'video-frame',videoId:value.videoId,seconds:value.seconds}:undefined;
}
