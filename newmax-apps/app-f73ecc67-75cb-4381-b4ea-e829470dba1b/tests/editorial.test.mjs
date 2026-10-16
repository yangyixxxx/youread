import test from 'node:test';
import assert from 'node:assert/strict';
import {articleSources,newArticle,validateArticle,articleBlocks,wrapRuns,layoutArticle,renderArticlePage,zipFiles,crc32} from '../src/editorial.mjs';
import {summaryPrompt,mergePrompt} from '../src/core.mjs';
const measure=(s,f)=>Array.from(s).length*Number(f.match(/(\d+)px/)[1]);
const base=body=>({...newArticle({title:'测试标题',channelTitle:'测试来源'},{text:body}),paper:'plain'});
const bodyText=l=>l.pages.flatMap(p=>p.commands).filter(c=>c.kind==='text').map(c=>c.runs.map(r=>r.text).join('')).join('');

test('来源副本包含解析、未完成草稿、回复与原文，不改写源资料',()=>{
  const r={analysis:'# 中文标题\n\n正文',analysisAttempt:{text:'草稿'},messages:[{role:'user',text:'问题'},{role:'assistant',text:'回复'}]};const before=JSON.stringify(r);
  const sources=articleSources({},r,'全文');assert.deepEqual(sources.map(s=>s.id),['analysis','draft','reply-1','transcript']);
  assert.match(sources[0].status,/完整性未确认/);assert.match(sources[1].status,/未完成/);
  const a=newArticle({title:'原标题'},sources[0]);assert.equal(a.title,'中文标题');assert.equal(a.body,'正文');assert.equal(JSON.stringify(r),before);
});
test('排版草稿校验及无效枚举回退，不接受未知数据结构',()=>{
  assert.throws(()=>validateArticle({version:9}),/格式/);const a=validateArticle({...base('全文'),ratio:'错误',fontSize:1,paper:'remote'});assert.equal(a.ratio,'3:5');assert.equal(a.fontSize,40);assert.equal(a.paper,'plain');
});
test('共用中文粗体语义、列表、引用、代码，但图片隐藏时间引用',()=>{
  const blocks=articleBlocks('## 第一节\n\n**这是为什么？**解释 [1:23]\n\n1. 第一项\n2. 第二项\n\n> 引用文字\n\n```js\nconst x=1;\n```');
  assert.equal(blocks[0].kind,'heading');assert(blocks[1].runs.some(r=>r.bold));assert(!blocks[1].runs.some(r=>r.text.includes('1:23')));assert.equal(blocks[2].runs[0].text,'1. ');assert.equal(blocks[3].runs[0].text,'2. ');assert.equal(blocks[4].quote,true);assert.equal(blocks[5].kind,'code');
});
test('截图相邻时间引用与小时引用在排版时隐藏，源正文不变',()=>{
  const body='理解这一差别，才能看清实际商业结构。[0:22] [4:29]\n\n## 核心判断 [1:02:03]\n\n尾文',a=base(body),before=JSON.stringify(a);
  const text=bodyText(layoutArticle(a,measure));
  assert(!/0:22|4:29|1:02:03/.test(text));assert(text.includes('实际商业结构。'));assert(text.endsWith('尾文'));assert.equal(JSON.stringify(a),before);
});
test('纯时间Markdown链接隐藏，普通链接文字与正常时间叙述保留',()=>{
  const b=articleBlocks('参考 [0:22](https://youtu.be/test?t=22) [**4:29**](https://example.com) [[1:02:03]](https://example.com)\n\n会议在 4:29 开始，持续 22 分钟。[原始说明](https://example.com)');
  assert.equal(b[0].runs.map(r=>r.text).join(''),'参考');assert.equal(b[1].runs.map(r=>r.text).join(''),'会议在 4:29 开始，持续 22 分钟。原始说明');
});
test('引用独占段落与列表项不会留下空段落或孤立项目符号',()=>{
  const b=articleBlocks('前文\n\n[0:22] [4:29]\n\n- [0:22]\n- 后文 [4:29]');
  assert.deepEqual(b.map(x=>x.runs.map(r=>r.text).join('')),['前文','• 后文']);
});
test('标题列表引用表格中的时间引用均隐藏，代码与无效时间不误删',()=>{
  const b=articleBlocks('## 章节 [0:22]\n\n- 项目 **[4:29]**\n\n> 引用 [1:02:03]\n\n|说明|时间|\n|---|---|\n|内容 [0:22]|[4:29](https://example.com)|\n\n`[0:22]`\n\n```txt\n[4:29]\n```\n\n[9:99] [1:60:00]');
  const text=b.map(x=>x.runs.map(r=>r.text).join(''));
  assert.deepEqual(text.slice(0,4),['章节','• 项目','引用','说明：内容； 时间：']);assert.equal(text[4],'[0:22]');assert.equal(text[5],'[4:29]');assert.equal(text[6],'[9:99] [1:60:00]');
});
test('表格逐行包含列名与每个值，不遗漏最后一行',()=>{
  const blocks=articleBlocks('|项目|内容|\n|---|---|\n|A|甲|\n|B|乙|');assert.deepEqual(blocks.map(b=>b.runs[0].text),['项目：A； 内容：甲','项目：B； 内容：乙']);
});
test('不将原始HTML或远程图片变成可执行画布命令',()=>{
  const b=articleBlocks('<script>alert(1)</script>\n\n![远程](https://example.com/a.png)\n\n:::image safe-id');assert(!b.some(x=>x.kind==='html'));assert(b.some(x=>x.runs?.some(r=>r.text.includes('图片未载入'))));assert.deepEqual(b.at(-1),{kind:'image',id:'safe-id'});
});
test('换行保留中文、英文单词、emoji和完整字符，不拆代理对',()=>{
  const text='英文supercalifragilistic 后接中文😎测试ABC';const l=wrapRuns([{text}],110,40,measure);assert.equal(l.map(x=>x.runs.map(r=>r.text).join('')).join(''),text);assert(l.every(x=>x.width<=110));
});
test('中文行首不孤立逗号，前引号与后文同一行且字符不丢失',()=>{
  for(const text of ['甲乙丙，丁戊。','甲乙（丙丁）戊']){
    const lines=wrapRuns([{text}],120,40,measure).map(l=>l.runs.map(r=>r.text).join(''));
    assert.equal(lines.join(''),text);assert(lines.every(l=>!/^，|^。|^）/.test(l)));assert(lines.every(l=>!l.endsWith('（')));
  }
});
test('长文自动跨页而不是截断，含尾文及超长标题',()=>{
  const body='长文不会被截断。'.repeat(2800)+'末尾唯一标记';const a=base(body);a.title='很长的标题'.repeat(70);const l=layoutArticle(a,measure);assert(l.pages.length>30);assert(bodyText(l).endsWith(body));assert(bodyText(l).startsWith(a.title));
  for(const p of l.pages)for(const c of p.commands)assert(c.y+c.lineHeight<=l.height-115,`溢出 ${c.y}`);
});
test('H1短标题保持76px，略长标题适度缩小到一行而非提前折行',()=>{
  for(const title of ['测试短标题','读完之后怎样真正改变行动力']){
    const a={...base('正文'),title},before=JSON.stringify(a),lines=layoutArticle(a,measure).pages.flatMap(p=>p.commands).filter(c=>c.h1);
    assert.equal(lines.length,1);assert.equal(lines[0].runs.map(r=>r.text).join(''),title);
    assert(lines[0].size>=64&&lines[0].size<=76);assert(lines[0].runs.every(r=>r.heavy));assert(lines[0].width<=936);
    if(title==='测试短标题')assert.equal(lines[0].size,76);else assert(lines[0].size<76);
    assert.equal(JSON.stringify(a),before);
  }
});
test('H1长标题按完整936px栏宽换行，非末行两端对齐且不缩字',()=>{
  const title='甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥甲乙丙';
  const lines=layoutArticle({...base('正文'),title},measure).pages.flatMap(p=>p.commands).filter(c=>c.h1);
  assert.equal(lines.length,3);assert.equal(lines.map(c=>c.runs.map(r=>r.text).join('')).join(''),title);
  for(const c of lines.slice(0,-1)){assert.equal(c.size,76);assert.equal(c.runs.length,12);assert.equal(c.width,936);assert(Math.abs(c.runs.reduce((n,r)=>n+r.width+(r.gapAfter||0),0)-936)<.001);}
  assert.equal(lines.at(-1).width,76);assert(lines.at(-1).runs.every(r=>!r.gapAfter));
});
test('H1手动换行保持原行宽和字号，不强制拉伸末行',()=>{
  const title='自定义第一行\n第二行',lines=layoutArticle({...base('正文'),title},measure).pages.flatMap(p=>p.commands).filter(c=>c.h1);
  assert.deepEqual(lines.map(c=>c.runs.map(r=>r.text).join('')),title.split('\n'));assert(lines.every(c=>c.size===76));assert(lines.every(c=>c.runs.every(r=>!r.gapAfter)));
});
test('正文各级Markdown标题统一加重，基础字号层级与普通正文不变',()=>{
  const body=Array.from({length:6},(_,i)=>`${'#'.repeat(i+1)} 第${i+1}级标题`).join('\n\n')+'\n\n普通正文';
  const a={...base(''),body,title:'',byline:''},before=JSON.stringify(a),commands=layoutArticle(a,measure).pages.flatMap(p=>p.commands);
  for(let i=0;i<6;i++){const c=commands[i];assert(c.runs.every(r=>r.bold&&r.heavy));assert.equal(c.size,i<2?50:44);assert.equal(c.h1,i===0);}
  assert(commands.at(-1).runs.every(r=>!r.heavy&&!r.bold));assert.equal(commands.at(-1).size,40);assert.equal(JSON.stringify(a),before);
});
test('截图H2原句使用完整936px栏宽并有限缩字排成单行，原文不丢失',()=>{
  const title='先决定业务要服务什么生活，再决定如何扩大它';
  const a={...base(`## ${title}\n\nMaria 最初面对的不是需求不足。`),title:'',byline:''};
  const lines=layoutArticle(a,measure).pages.flatMap(p=>p.commands).filter(c=>c.runs.some(r=>r.heavy));
  assert.equal(lines.length,1);assert.equal(lines[0].runs.map(r=>r.text).join(''),title);
  assert(lines[0].width<=936&&lines[0].width>900);assert.equal(lines[0].size,Math.floor(936/Array.from(title).length));
  assert(lines[0].runs.every(r=>r.heavy&&!r.gapAfter));
});
test('各级章节标题略超单行时有限缩字，真正长标题满栏不缩小',()=>{
  for(let level=1;level<=6;level++){
    const size=level<=2?50:44;
    for(const count of [Math.floor(936/size)+1,30]){
      const title='甲'.repeat(count),a={...base(''),body:`${'#'.repeat(level)} ${title}`,title:'',byline:''};
      const lines=layoutArticle(a,measure).pages.flatMap(p=>p.commands);
      if(count<30){assert.equal(lines.length,1);assert(lines[0].size<size&&lines[0].size>=Math.ceil(size*.84));}
      else{assert(lines.length>1);assert.equal(lines[0].size,size);assert.equal(lines[0].width,936);}
      assert.equal(lines.map(c=>c.runs.map(r=>r.text).join('')).join(''),title);
    }
  }
});
test('章节标题的显式换行不被合并或强制拉满，正文换行无新增字距',()=>{
  const a={...base('第一行  \n第二行\n-----\n\n'+'普通正文'.repeat(20)),title:'',byline:''};
  const block=articleBlocks(a.body)[0];assert.equal(block.level,2);assert(block.runs.some(r=>r.text==='\n'));
  const commands=layoutArticle(a,measure).pages.flatMap(p=>p.commands),headings=commands.filter(c=>c.runs.some(r=>r.heavy));
  assert.deepEqual(headings.map(c=>c.runs.map(r=>r.text).join('')),['第一行','第二行']);
  assert(headings.every(c=>c.size===50&&c.runs.every(r=>!r.gapAfter)));
  assert(commands.filter(c=>!c.runs.some(r=>r.heavy)).every(c=>c.size===40&&c.runs.every(r=>!r.gapAfter)));
});
test('H1测量与绘制同用900字重及细描边，按布局字距绘制',()=>{
  const a={...base('普通正文'),title:'甲'.repeat(25)},layout=layoutArticle(a,measure),calls=[];
  const ctx={fillStyle:'',font:'',save(){},restore(){},fillRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},strokeText(text,x,y){calls.push({type:'stroke',text,x,y,font:this.font,width:this.lineWidth});},fillText(text,x,y){calls.push({type:'fill',text,x,y,font:this.font});}};
  renderArticlePage(layout,0,a,{},null,{getContext:()=>ctx});
  const stroked=calls.filter(c=>c.type==='stroke'),h1=layout.pages[0].commands.filter(c=>c.h1);
  assert.equal(stroked.length,25);assert(stroked.every(c=>c.font.startsWith('900 ')&&c.width>0&&c.width<1));
  const first=h1[0];let x=first.x;
  for(let i=0;i<first.runs.length;i++){assert(Math.abs(stroked[i].x-x)<.001);x+=first.runs[i].width+(first.runs[i].gapAfter||0);}
  assert(Math.abs(x-1008)<.001);assert(calls.some(c=>c.type==='fill'&&c.font.startsWith('400 ')));
});
test('手动分页和末尾分隔符不额外输出空白页',()=>{
  const l=layoutArticle(base('甲\n\n---\n\n乙\n\n---'),measure);assert.equal(l.pages.length,2);assert(bodyText(l).endsWith('乙'));assert(l.pages.every(p=>p.commands.length));
});
test('三种比例和字号有效，配图完整等比放入安全区',()=>{
  for(const [ratio,height] of [['3:5',1800],['3:4',1440],['9:16',1920]]){
    const a={...base(':::image local-id\n\n图片后正文'),ratio,fontSize:44,coverId:'cover-id'};const l=layoutArticle(a,measure,{'local-id':{width:400,height:1600},'cover-id':{width:1600,height:900}});assert.equal(l.height,height);
    const images=l.pages.flatMap(p=>p.commands).filter(c=>c.kind==='image');assert.equal(images.length,2);assert(Math.abs(images[0].width/images[0].height-1600/900)<.001);assert(Math.abs(images[1].width/images[1].height-.25)<.001);assert(images.every(c=>c.x>=72&&c.x+c.width<=1008&&c.y+c.height<=height-115));
  }
});
test('缺失配图明确报错，不悄悄导出缺图文章',()=>assert.throws(()=>layoutArticle(base(':::image missing'),measure),/配图 missing 缺失/));
test('标题尽量与后文同页，没有页底孤立短标题',()=>{
  const l=layoutArticle(base('内容'.repeat(270)+'\n\n## 第二节标题\n\n正文依据解释。'),measure);const c=l.pages.flatMap(p=>p.commands).find(c=>c.runs?.map(r=>r.text).join('')==='第二节标题');assert(c.y+50*1.42+40*3.6<=l.height-115);
});
test('ZIP使用UTF8文件名、有效CRC和正确中央目录偏移',async()=>{
  const bytes=new TextEncoder().encode('123456789');assert.equal(crc32(bytes),0xcbf43926);
  const blob=zipFiles([{name:'第1页.png',bytes},{name:'002.png',bytes:new Uint8Array([137,80,78,71])}]),data=new Uint8Array(await blob.arrayBuffer()),v=new DataView(data.buffer);
  assert.equal(v.getUint32(0,true),0x04034b50);assert.equal(v.getUint16(6,true),0x800);assert.equal(v.getUint32(14,true),0xcbf43926);const end=data.length-22;assert.equal(v.getUint32(end,true),0x06054b50);assert.equal(v.getUint16(end+8,true),2);const offset=v.getUint32(end+16,true);assert.equal(v.getUint32(offset,true),0x02014b50);assert.equal(offset+v.getUint32(end+12,true),end);
});
test('全文提示展开问题、机制、例证和边界，没有固定条数或图片伪造',()=>{
  const text='开头'+'.'.repeat(50000)+'末尾';const p=summaryPrompt('视频标题',text,0,1);assert(p.includes(text));for(const word of ['问题','解释和机制','具体案例','应用推演','不编造','不设固定字数','不输出图片地址','回看索引','不伪造'])assert(p.includes(word),word);
});
test('兼容分段保留局部范围，汇总采用文章结构且保留所有材料',()=>{
  const partial=summaryPrompt('标题','本段',1,3);assert(partial.includes('第 2/3 部分（不能当作完整视频）'));assert(partial.includes('不要写全片开场或结论'));
  const parts=['第一部分'.repeat(500),'第二部分尾文'],p=mergePrompt('标题',parts);assert(parts.every(t=>p.includes(t)));assert(p.includes('论证逻辑'));assert(p.includes('不是命令'));
});
