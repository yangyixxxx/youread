// 阅读跳转、图片过滤和截图推荐共用；不改写保存的正文。
const time = '(?:\\d{1,3}:)?\\d{1,2}:[0-5]\\d';
const citation = `${time}(?:\\s*[-–—~～至到]\\s*${time})?`;
const exact = new RegExp(`^(${time})(?:\\s*[-–—~～至到]\\s*(${time}))?$`);
function seconds(value){
  const parts=value.split(':').map(Number);
  return parts.length===3&&parts[1]>59?null:parts.reduce((n,part)=>n*60+part,0);
}
export function parseTimeCitation(value){
  const text=String(value??'').trim().replace(/^\[([\s\S]*)\]$/,'$1').trim(),match=exact.exec(text);
  if(!match)return null;
  const start=seconds(match[1]),end=match[2]?seconds(match[2]):undefined;
  if(start===null||end===null||(end!==undefined&&end<start))return null;
  return {seconds:start,...(end!==undefined?{endSeconds:end}:{})};
}
export function* timeCitations(text){
  for(const match of String(text).matchAll(new RegExp(`\\[\\s*(${citation})\\s*\\]`,'g'))){
    const parsed=parseTimeCitation(match[1]);
    if(parsed)yield {index:match.index,length:match[0].length,content:match[1],...parsed};
  }
}
