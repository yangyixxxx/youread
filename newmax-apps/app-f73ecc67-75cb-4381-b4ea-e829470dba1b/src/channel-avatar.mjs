import {escapeHTML as esc} from './core.mjs';

export function safeAvatarURL(value){
  if(typeof value!=='string'||value.length>4096||/[\u0000- \u007f]/.test(value))return '';
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&/(^|\.)(ggpht\.com|googleusercontent\.com|ytimg\.com)$/.test(url.hostname)?url.href:'';
  }catch{return '';}
}
export function channelAvatar(channel,failed=new Set()){
  const url=safeAvatarURL(channel.avatar),letter=Array.from(String(channel.title||'').replace(/^@/,''))[0]?.toUpperCase()||'?';
  return `<span class="channel-avatar" aria-hidden="true"><span>${esc(letter)}</span>${url&&!failed.has(url)?`<img src="${esc(url)}" alt="" width="26" height="26" decoding="async" referrerpolicy="no-referrer">`:''}</span>`;
}
export function bindAvatarFallback(root,failed){
  const onError=event=>{
    const img=event.target;
    if(!img.matches?.('.channel-avatar img'))return;
    failed.add(img.src);
    img.remove();
  };
  root.addEventListener('error',onError,true);
  return ()=>root.removeEventListener('error',onError,true);
}
