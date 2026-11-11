// 只保存/恢复阅读标记，绝不回滚整条记录上的新笔记、收藏或对话。
export function unreadIds(videos, records) {
  return [...new Set(videos.map(v=>v.id))].filter(id=>!records[id]?.read);
}
export function captureRead(records, ids) {
  return [...new Set(ids)].map(id=>({id,exists:Object.hasOwn(records,id),hadRead:Object.hasOwn(records[id]||{},'read'),read:records[id]?.read}));
}
export function markRead(records, ids) {
  const targets=[...new Set(ids)].filter(id=>!records[id]?.read);
  const previous=captureRead(records,targets);
  for(const id of targets)(records[id] ||= {}).read=true;
  return previous;
}
export function restoreRead(records, previous) {
  for(const item of previous){
    const r=records[item.id] ||= {};
    if(item.hadRead)r.read=item.read;else delete r.read;
    if(!item.exists&&Object.keys(r).length===0)delete records[item.id];
  }
}
