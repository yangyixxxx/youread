// 只接受带时区的绝对日期或年月日，不把相对文案交给 Date.parse 猜测。
export function publicationMillis(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))return null;
  const ms=Date.parse(value);return Number.isFinite(ms)?ms:null;
}
export function sortVideosByPublication(videos) {
  return [...videos].sort((a,b)=>{
    const x=publicationMillis(a.publishedAt),y=publicationMillis(b.publishedAt);
    return x===null?(y===null?0:1):y===null?-1:y-x;
  });
}
export function publicationLabel(video,now=new Date()) {
  if(video.local)return '本地导入';
  const ms=publicationMillis(video.publishedAt);if(ms===null)return '日期未提供';
  const d=new Date(ms),day=video.datePrecision==='day'||!video.datePrecision;
  const label=d.toLocaleDateString('zh-CN',{year:d.getFullYear()!==now.getFullYear()?'numeric':undefined,month:'numeric',day:'numeric',...(day?{timeZone:'UTC'}:{})});
  return (video.datePrecision==='approximate'?'约 ':'')+label;
}
export function publicationTooltip(video) {
  if(video.local)return '本地导入文稿';
  const ms=publicationMillis(video.publishedAt);if(ms===null)return '尚未获取发布日期，按未知日期置于列表末尾';
  const d=new Date(ms);
  if(!video.datePrecision||video.datePrecision==='day')return d.toISOString().slice(0,10)+' · 仅提供日期，未提供精确时刻';
  return d.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})+(video.datePrecision==='approximate'?' · 由YouTube相对时间换算，等待详情校准':' · 发布时间（本地时区）');
}
