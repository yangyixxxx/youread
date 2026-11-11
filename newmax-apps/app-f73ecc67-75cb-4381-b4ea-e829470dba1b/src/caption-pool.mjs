// 只展示连接器报告，不从节点数量推断代理或YouTube服务健康。
export function poolCooling(pool){return pool?.enabled===true&&pool.nodeCount>0&&pool.available===0&&!pool.running;}
export function captionPoolText(pool){
  if(!pool?.enabled)return '字幕专用节点池未配置；付费备用未配置。';
  const summary=`Clash专用节点池 · 已配置 ${Number(pool.nodeCount)||0} 个节点`;
  if(pool.running)return summary+' · 正在获取，遇限流最多尝试3个节点，间隔20秒。';
  if(poolCooling(pool)){
    const next=Number(pool.nextAvailableAt);
    const at=Number.isFinite(next)&&next>0?new Date(next*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'';
    return summary+' · 出口冷却中'+(at?'，最早 '+at+' 后可再获取':'')+'；本次已暂停，付费备用未配置。';
  }
  if(pool.lastError)return summary+' · '+pool.lastError;
  return summary+` · ${Number(pool.available)||0} 个未冷却；429自动冷却并有限轮换，不改全局出口。付费备用未配置。`;
}
