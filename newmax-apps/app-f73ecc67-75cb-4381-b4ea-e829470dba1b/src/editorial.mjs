import {markdownTokens} from './markdown.mjs';

export const PAGE_WIDTH = 1080;
export const PAGE_HEIGHTS = {'3:5':1800,'3:4':1440,'9:16':1920};
export const SERIF = '"SimSun", "Songti SC", "Noto Serif CJK SC", serif';
const SANS = '"Microsoft YaHei", "Segoe UI", sans-serif';
const validAssetId = id => /^[a-zA-Z0-9-]+$/.test(id || '');

export function articleSources(video, record = {}, transcript = '') {
  const sources = [];
  if(record.analysis) sources.push({id:'analysis',label:'已保存解析',text:record.analysis,status:record.analysisCompletion?'':'旧解析 · 完整性未确认'});
  if(record.analysisAttempt?.text) sources.push({id:'draft',label:'未完成解析草稿',text:record.analysisAttempt.text,status:'未完成草稿 · 请勿视为完整解析'});
  (record.messages || []).forEach((m,i)=>{if(m.role==='assistant' && m.text)sources.push({id:`reply-${i}`,label:`对话回复 ${i+1}`,text:m.text,status:m.incomplete?'未完成回复':''});});
  if(transcript) sources.push({id:'transcript',label:'视频原文',text:transcript,status:'视频原文 · 未经编辑'});
  return sources;
}
export function newArticle(video, source = {}) {
  let body = String(source.text || '');
  const heading = body.match(/^# ([^\n]+)\n*/);
  const title = heading ? heading[1].replace(/\*\*/g,'').trim() : video.title;
  if(heading)body=body.slice(heading[0].length);
  return {version:1,title:title||'未命名文章',byline:video.channelTitle||'视频阅读笔记',body,sourceId:source.id||'',sourceStatus:source.status||'',ratio:'3:5',fontSize:40,paper:'texture',coverId:'',assets:{}};
}
export function validateArticle(value) {
  if(!value || value.version!==1 || typeof value.title!=='string' || typeof value.body!=='string')throw new Error('排版草稿格式不正确，已暂停载入以保护原资料。');
  return {...value,byline:String(value.byline||''),sourceStatus:String(value.sourceStatus||''),ratio:PAGE_HEIGHTS[value.ratio]?value.ratio:'3:5',fontSize:[36,40,44].includes(value.fontSize)?value.fontSize:40,paper:['texture','plain','white'].includes(value.paper)?value.paper:'plain',assets:value.assets&&typeof value.assets==='object'?value.assets:{}};
}
function inlineRuns(tokens = []) {
  const runs=[];let bold=0,italic=0,strike=0;
  for(let i=0;i<tokens.length;i++){
    const t=tokens[i];
    // 图片没有回看交互，只过滤展示 token，不改编辑底稿或阅读区。
    if(t.type==='time_citation')continue;
    if(t.type==='link_open'){
      const end=tokens.findIndex((child,j)=>j>i&&child.type==='link_close');
      const label=tokens.slice(i+1,end).map(child=>child.content||'').join('').trim();
      const match=label.match(/^\[?((?:\d{1,3}:)?\d{1,2}:[0-5]\d)\]?$/);
      if(end>i&&match){
        const parts=match[1].split(':').map(Number);
        if(parts.length===2||parts[1]<60){i=end;continue;}
      }
    }
    if(t.type==='strong_open')bold++;
    else if(t.type==='strong_close')bold--;
    else if(t.type==='em_open')italic++;
    else if(t.type==='em_close')italic--;
    else if(t.type==='s_open')strike++;
    else if(t.type==='s_close')strike--;
    else if(t.type==='image')runs.push({text:`［图片未载入：${t.content||'请上传本地配图'}］`});
    else if(['text','code_inline','html_inline'].includes(t.type))runs.push({text:t.content,bold:bold>0,italic:italic>0,strike:strike>0,code:t.type==='code_inline'});
    else if(t.type==='hardbreak')runs.push({text:'\n'});
    else if(t.type==='softbreak')runs.push({text:' '});
  }
  // 去掉引用在边缘留下的空白，不触碰代码或正文词间空格。
  while(runs.length&&!runs[0].code&&!runs[0].text.trim())runs.shift();
  while(runs.length&&!runs.at(-1).code&&!runs.at(-1).text.trim())runs.pop();
  if(runs[0]&&!runs[0].code)runs[0].text=runs[0].text.trimStart();
  if(runs.at(-1)&&!runs.at(-1).code)runs.at(-1).text=runs.at(-1).text.trimEnd();
  return runs;
}
export function articleBlocks(body) {
  const tokens=markdownTokens(body),blocks=[],lists=[];
  let heading=0,quote=0,prefix='',table=null,row=null;
  for(const t of tokens){
    if(t.type==='heading_open')heading=Number(t.tag.slice(1));
    else if(t.type==='heading_close')heading=0;
    else if(t.type==='blockquote_open')quote++;
    else if(t.type==='blockquote_close')quote--;
    else if(t.type==='bullet_list_open')lists.push({ordered:false,count:0});
    else if(t.type==='ordered_list_open')lists.push({ordered:true,count:Number(t.attrGet('start')||1)-1});
    else if(t.type==='bullet_list_close'||t.type==='ordered_list_close')lists.pop();
    else if(t.type==='list_item_open'){const l=lists.at(-1);prefix=l?.ordered?`${++l.count}. `:'• ';}
    else if(t.type==='list_item_close')prefix='';
    else if(t.type==='table_open')table={rows:[]};
    else if(t.type==='tr_open')row=[];
    else if(t.type==='tr_close'){table?.rows.push(row);row=null;}
    else if(t.type==='table_close'){
      const [headers=[],...rows]=table.rows;
      for(const cells of rows)blocks.push({kind:'text',runs:[{text:cells.map((c,i)=>`${headers[i]||`列${i+1}`}：${c}`).join('； ')}]});
      if(!rows.length)blocks.push({kind:'text',runs:[{text:headers.join(' / ')}]});
      table=null;
    }else if(t.type==='inline'){
      const runs=inlineRuns(t.children);
      if(table){row?.push(runs.map(r=>r.text).join(''));continue;}
      const image=t.content.trim().match(/^:::image ([a-zA-Z0-9-]+)$/);
      if(image){blocks.push({kind:'image',id:image[1]});continue;}
      if(!runs.some(r=>r.text.trim())){prefix='';continue;}
      if(prefix)runs.unshift({text:prefix});
      blocks.push({kind:heading?'heading':'text',level:heading||undefined,runs,quote:quote>0,indent:Math.max(0,lists.length-1)*30});prefix='';
    }else if(t.type==='fence'||t.type==='code_block')blocks.push({kind:'code',runs:[{text:t.content.replace(/\n$/,''),code:true}]});
    else if(t.type==='hr')blocks.push({kind:'break'});
  }
  return blocks;
}
function font(size,run={}){return `${run.italic?'italic ':''}${run.heavy?'900':run.bold?'700':'400'} ${size}px ${run.code?'Consolas, monospace':SERIF}`;}
const graphemes=typeof Intl.Segmenter==='function'?new Intl.Segmenter('zh-CN',{granularity:'grapheme'}):null;
export function wrapRuns(runs,maxWidth,size,measure){
  const lines=[];let line=[],width=0;
  const flush=()=>{lines.push({runs:line,width});line=[];width=0;};
  for(const run of runs){
    // 尽量完整保留英文单词；超长词逐字续行，中文按字素换行。
    const units=String(run.text).match(/[A-Za-z0-9_]+(?:['’.-][A-Za-z0-9_]+)*|[^A-Za-z0-9_]+/gu)||[];
    for(const unit of units){
      const chunks=/^[A-Za-z0-9_]/.test(unit)&&measure(unit,font(size,run))<=maxWidth?[unit]:graphemes?Array.from(graphemes.segment(unit),s=>s.segment):Array.from(unit);
      for(const text of chunks){
        if(text==='\n'){flush();continue;}
        const w=measure(text,font(size,run));
        if(width+w>maxWidth && line.length){
          // 中文禁则：不要把句末标点丢到下一行开头，也不让前引号孤立在行尾。
          let carry=null;
          if(/^[，。！？；：、）》」』】〕…,.!?;:]/u.test(text)||/[（《「『【〔“‘(]$/u.test(line.at(-1).text)){
            const last=line.at(-1),chars=graphemes?Array.from(graphemes.segment(last.text),s=>s.segment):Array.from(last.text),tail=chars.pop();
            const tailWidth=measure(tail,font(size,last));
            if(tailWidth+w<=maxWidth){
              carry={...last,text:tail,width:tailWidth};
              if(chars.length){last.text=chars.join('');last.width=measure(last.text,font(size,last));}else line.pop();
              width=line.reduce((n,r)=>n+r.width,0);
            }
          }
          if(line.length)flush();
          if(carry){line.push(carry);width=carry.width;}
        }
        line.push({...run,text,width:w});width+=w;
      }
    }
  }
  if(line.length)flush();
  return lines;
}
export function layoutArticle(article,measure,imageSizes={}){
  const width=PAGE_WIDTH,height=PAGE_HEIGHTS[article.ratio]||1800,margin=72,bottom=height-115,bodySize=article.fontSize||40;
  const pages=[{commands:[]}];let page=pages[0],y=margin;
  const next=()=>{if(!page.commands.length)return;page={commands:[]};pages.push(page);y=margin;};
  const placeText=(runs,size,{heading=false,h1=false,indent=0,quote=false,code=false,gap=28}={})=>{
    const x=margin+indent+(quote?24:0),available=width-margin-x,manualBreak=runs.some(r=>r.text.includes('\n'));
    if(heading)runs=runs.map(r=>({...r,heavy:true}));
    let lines=wrapRuns(runs,available,size,measure);
    // 文章主标题和各级章节标题共用规则，避免H2仍按旧算法提前缩栏。
    // 只适度缩字号争取单行；长标题仍以基础字号占满栏宽，不压扁字形。
    if(heading&&!manualBreak&&lines.length>1){
      for(let candidate=size-1;candidate>=Math.ceil(size*.84);candidate--){
        const fitted=wrapRuns(runs,available,candidate,measure);
        if(fitted.length===1){size=candidate;lines=fitted;break;}
      }
    }
    const lineHeight=size*(heading?1.42:1.8);
    if(!lines.length)return;
    if(heading&&!manualBreak)for(const line of lines.slice(0,-1)){
      const count=line.runs.length-1,space=count>0?(available-line.width)/count:0;
      // 自动换行非末行两端对齐，限制过大字距；末行和手动换行不强拉满。
      if(count>0&&space>=0&&space<=size*.25){
        line.runs=line.runs.map((r,i)=>({...r,gapAfter:i<count?space:0}));line.width=available;
      }
    }
    if(heading && y+Math.min(lines.length,2)*lineHeight+bodySize*3.6>bottom)next();
    for(const line of lines){
      if(y+lineHeight>bottom)next();
      page.commands.push({kind:'text',runs:line.runs,x,y,size,lineHeight,quote,code,h1,width:line.width});y+=lineHeight;
    }
    y+=gap;
  };
  const placeImage=id=>{
    if(!validAssetId(id)||!imageSizes[id])throw new Error(`配图 ${id} 缺失或无法读取，请重新上传，或删除对应图片标记。`);
    const s=imageSizes[id],maxH=(bottom-margin)*.48,scale=Math.min((width-margin*2)/s.width,maxH/s.height);
    const w=s.width*scale,h=s.height*scale;
    if(y+h>bottom)next();
    page.commands.push({kind:'image',id,x:(width-w)/2,y,width:w,height:h});y+=h+36;
  };
  if(article.title.trim())placeText([{text:article.title,bold:true}],76,{heading:true,h1:true,gap:30});
  if(article.byline.trim())placeText([{text:article.byline}],26,{gap:22});
  if(article.sourceStatus)placeText([{text:article.sourceStatus}],25,{gap:26});
  if(article.coverId)placeImage(article.coverId);
  for(const b of articleBlocks(article.body)){
    if(b.kind==='break'){next();continue;}
    if(b.kind==='image'){placeImage(b.id);continue;}
    const size=b.kind==='heading'?(b.level<=2?50:44):b.kind==='code'?Math.max(28,bodySize-6):bodySize;
    placeText(b.runs.map(r=>({...r,bold:b.kind==='heading'||r.bold})),size,{heading:b.kind==='heading',h1:b.kind==='heading'&&b.level===1,indent:b.indent||0,quote:b.quote,code:b.kind==='code',gap:b.kind==='heading'?25:28});
  }
  if(pages.length>1&&!pages.at(-1).commands.length)pages.pop();
  return {width,height,pages};
}
export async function loadImage(src){
  return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('图片读取失败，请重新选择本地 PNG/JPEG/WebP。'));image.src=src;});
}
export async function normalizeUpload(file){
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('仅支持 PNG、JPEG、WebP 本地图片。');
  if(file.size>10*1024*1024)throw new Error('配图超过 10 MB，请先缩小图片。');
  const url=URL.createObjectURL(file);
  try{
    const image=await loadImage(url);
    if(image.width*image.height>40000000)throw new Error('配图超过 4000 万像素，请先缩小图片。');
    const scale=Math.min(1,1920/Math.max(image.width,image.height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
    return {dataUrl:canvas.toDataURL('image/jpeg',.92),width:canvas.width,height:canvas.height};
  }finally{URL.revokeObjectURL(url);}
}
export function renderArticlePage(layout,index,article,images={},texture=null,canvas=document.createElement('canvas')){
  canvas.width=layout.width;canvas.height=layout.height;
  const ctx=canvas.getContext('2d');ctx.fillStyle=article.paper==='white'?'#ffffff':'#fcfbf8';ctx.fillRect(0,0,canvas.width,canvas.height);
  if(article.paper==='texture'&&texture){ctx.save();ctx.globalAlpha=.3;ctx.drawImage(texture,0,0,canvas.width,canvas.height);ctx.restore();}
  ctx.textBaseline='top';ctx.fillStyle='#20221f';
  for(const c of layout.pages[index].commands){
    if(c.kind==='image'){ctx.drawImage(images[c.id],c.x,c.y,c.width,c.height);continue;}
    if(c.code){ctx.fillStyle='#efeee9';ctx.fillRect(c.x-10,c.y-5,layout.width-144+20,c.lineHeight);ctx.fillStyle='#20221f';}
    if(c.quote){ctx.fillStyle='#a7ac9b';ctx.fillRect(72,c.y,3,c.lineHeight);ctx.fillStyle='#3b4038';}
    let x=c.x;
    for(const r of c.runs){
      ctx.font=font(c.size,r);const textY=c.y+(c.lineHeight-c.size)*.35;
      // 系统宋体可能把900映射为700，细描边确保所有标题实际加重，预览/导出完全共用。
      if(r.heavy){ctx.save();ctx.strokeStyle=ctx.fillStyle;ctx.lineWidth=c.size*.012;ctx.lineJoin='round';ctx.strokeText(r.text,x,textY);ctx.restore();}
      ctx.fillText(r.text,x,textY);if(r.strike){ctx.fillRect(x,c.y+c.lineHeight*.45,r.width,1.5);}x+=r.width+(r.gapAfter||0);
    }
    ctx.fillStyle='#20221f';
  }
  const y=layout.height-76;ctx.strokeStyle='#d8d8d0';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(72,y-22);ctx.lineTo(layout.width-72,y-22);ctx.stroke();
  ctx.font=`22px ${SANS}`;ctx.fillStyle='#73776e';ctx.fillText(article.sourceStatus||'视频精读',72,y);
  ctx.textAlign='right';ctx.fillText(`${String(index+1).padStart(2,'0')} / ${String(layout.pages.length).padStart(2,'0')}`,layout.width-72,y);ctx.textAlign='left';
  return canvas;
}
export function pngBlob(canvas){return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('PNG 编码失败，请重试本地导出。')),'image/png'));}

// 无压缩 ZIP：PNG 本身已压缩，离线打包不依赖 CDN 或宿主私有接口。
const crcTable=Array.from({length:256},(_,n)=>{for(let j=0;j<8;j++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function crc32(bytes){let crc=0xffffffff;for(const b of bytes)crc=crcTable[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
export function zipFiles(files){
  const locals=[],central=[];let offset=0;
  for(const file of files){
    const name=new TextEncoder().encode(file.name),bytes=file.bytes,crc=crc32(bytes);
    if(name.length>65535||bytes.length>0xffffffff||offset+bytes.length>0xffffffff)throw new Error('导出体积超过 ZIP32 支持范围，请分别导出单页。');
    const h=new Uint8Array(30+name.length),v=new DataView(h.buffer);
    v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint32(14,crc,true);v.setUint32(18,bytes.length,true);v.setUint32(22,bytes.length,true);v.setUint16(26,name.length,true);h.set(name,30);
    locals.push(h,bytes);
    const c=new Uint8Array(46+name.length),cv=new DataView(c.buffer);
    cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x800,true);cv.setUint32(16,crc,true);cv.setUint32(20,bytes.length,true);cv.setUint32(24,bytes.length,true);cv.setUint16(28,name.length,true);cv.setUint32(42,offset,true);c.set(name,46);central.push(c);offset+=h.length+bytes.length;
  }
  if(files.length>65535)throw new Error('页数超过 ZIP32 支持范围，请分别导出。');
  const size=central.reduce((n,c)=>n+c.length,0),end=new Uint8Array(22),v=new DataView(end.buffer);
  v.setUint32(0,0x06054b50,true);v.setUint16(8,files.length,true);v.setUint16(10,files.length,true);v.setUint32(12,size,true);v.setUint32(16,offset,true);
  return new Blob([...locals,...central,end],{type:'application/zip'});
}
export function downloadBlob(name,blob){
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
