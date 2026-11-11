// 频道角标只表示资料库中的未读，不以同步成功状态冒充新内容。
export function channelUnreadCounts(videos,records){
  const counts=new Map(),seen=new Set();
  for(const video of videos){
    if(seen.has(video.id))continue;
    seen.add(video.id);
    if(video.channelId&&!records[video.id]?.read)counts.set(video.channelId,(counts.get(video.channelId)||0)+1);
  }
  return counts;
}
export function channelIndicator(status,unread=0){
  const count=Number.isSafeInteger(unread)&&unread>0?unread:0;
  const badge=count?`<span class="channel-unread" aria-label="${count} 条未读" title="${count} 条未读">${count}</span>`:'';
  const sync=status==='error'?'<span class="channel-sync error" role="img" aria-label="频道同步失败" title="同步失败，请在管理频道中重试">!</span>':
    ['pending','syncing'].includes(status)?'<span class="channel-sync" role="img" aria-label="频道正在同步" title="正在检查频道更新">↻</span>':'';
  return badge+sync;
}
