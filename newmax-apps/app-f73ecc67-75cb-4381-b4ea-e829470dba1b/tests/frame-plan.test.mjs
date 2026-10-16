import test from 'node:test';
import assert from 'node:assert/strict';
import {recommendFrames,parseFrameTime,frameTime,insertFrameMarkers,validFrameSource} from '../src/frame-plan.mjs';
import {articleBlocks,layoutArticle,newArticle} from '../src/editorial.mjs';

test('视频时间支持秒、分秒、时分秒，拒绝错误分秒、负数、非有限及超过12小时',()=>{
  for(const [s,n] of [['4:29',269],['1:02:03',3723],['22',22],['1:23.5',83.5],['12:00:00',43200]])assert.equal(parseFrameTime(s),n);
  for(const s of ['1:99','1:60:00','-1','Infinity','NaN','','12:00:01','1e3'])assert.equal(parseFrameTime(s),null,s);
  assert.equal(frameTime(3723),'1:02:03');assert.equal(frameTime(22),'0:22');
});
test('按段落时间引用定位，不以代码中的时间或封面替代',()=>{
  const text='## 背景\n\n故事开始。[0:22] [0:24]\n\n## 转折\n\n选择不同路径。[4:29]\n\n`[8:00]`\n\n```txt\n[9:00]\n```';
  const r=recommendFrames(text);assert.equal(r.length,2);assert.deepEqual(r.map(x=>x.seconds),[22,269]);assert.equal(r[1].label,'转折');assert(text.slice(0,r[0].offset).trimEnd().endsWith('[0:24]'));assert(!r[0].excerpt.includes('0:22'));
});
test('时间Markdown链接同样可推荐，正常时钟文字不作为依据',()=>{
  const r=recommendFrames('故事 [4:29](https://example.com)\n\n会议开始于 8:30。');assert.equal(r.length,1);assert.equal(r[0].seconds,269);
});
test('最多推荐5处，覆盖文章开头和结尾，不集中在头五段',()=>{
  const body=Array.from({length:20},(_,i)=>`## 第${i}节\n\n故事内容。[${i+1}:00]`).join('\n\n');
  const r=recommendFrames(body);assert.equal(r.length,5);assert.equal(r[0].seconds,60);assert.equal(r.at(-1).seconds,1200);assert(new Set(r.map(x=>x.offset)).size===5);
});
test('近似重复时间去重，已知视频时长外不推荐，无引用返回空',()=>{
  const r=recommendFrames('甲[0:10]\n\n乙[0:11]\n\n丙[0:40]\n\n丁[1:00]',{duration:60});assert.deepEqual(r.map(x=>x.seconds),[10,40]);assert.deepEqual(recommendFrames('一篇没有时间引用的文章'),[]);
});
test('多图逆序插入各自段落，不移动后续锚点或丢字，原解析不变',()=>{
  const body='第一段。[0:22]\n\n第二段。[4:29]\n\n末尾完整保留。';
  const rows=recommendFrames(body).map((x,i)=>({...x,assetId:'image-'+i}));const result=insertFrameMarkers(body,body,rows);
  assert(result.indexOf(':::image image-0')<result.indexOf('第二段'));assert(result.indexOf(':::image image-1')>result.indexOf('第二段'));assert(result.endsWith('末尾完整保留。'));
  assert.equal(articleBlocks(result).filter(b=>b.kind==='image').length,2);assert(!body.includes(':::image'));
});
test('正文变化后拒绝失效锚点，不静默插入错误段落',()=>{
  assert.throws(()=>insertFrameMarkers('新正文','旧正文',[{offset:1,assetId:'image'}]),/正文已变化/);
  for(const row of [{offset:-1,assetId:'image'},{offset:99,assetId:'image'},{offset:0,assetId:'../bad'}])assert.throws(()=>insertFrameMarkers('正文','正文',[row]),/位置无效/);
});
test('在光标处手动插图、多个相同位置及重复资产校验',()=>{
  assert.equal(insertFrameMarkers('甲乙','甲乙',[{offset:1,assetId:'a'}]),'甲\n\n:::image a\n\n乙');
  assert.throws(()=>insertFrameMarkers('甲乙','甲乙',[{offset:0,assetId:'a'},{offset:2,assetId:'a'}]),/位置无效/);
});
test('截图来源元数据仅保存视频ID与有效时间，无外部URL或凭据',()=>{
  assert.deepEqual(validFrameSource({type:'video-frame',videoId:'abcdefghijk',seconds:269,url:'secret'}),{type:'video-frame',videoId:'abcdefghijk',seconds:269});
  assert.equal(validFrameSource({type:'video-frame',videoId:'invalid',seconds:2}),undefined);assert.equal(validFrameSource({type:'video-frame',videoId:'abcdefghijk',seconds:NaN}),undefined);
});
test('截图进入原图文排版，等比续页并保留尾文，时间引用不印到画布',()=>{
  const body='正文。[0:22]\n\n长正文。'.repeat(80)+'\n\n最后一段。[4:29]';
  const rows=recommendFrames(body,{max:2}).map((r,i)=>({...r,assetId:'frame-'+i}));
  const article=newArticle({title:'截图排版'},{text:insertFrameMarkers(body,body,rows)});const measure=(s,f)=>Array.from(s).length*Number(f.match(/(\d+)px/)[1]);
  const layout=layoutArticle(article,measure,Object.fromEntries(rows.map(r=>[r.assetId,{width:1280,height:720}])));const commands=layout.pages.flatMap(p=>p.commands);
  assert.equal(commands.filter(c=>c.kind==='image').length,rows.length);assert(commands.filter(c=>c.kind==='image').every(c=>Math.abs(c.width/c.height-16/9)<.0001));
  const text=commands.filter(c=>c.runs).map(c=>c.runs.map(r=>r.text).join('')).join('');assert(text.endsWith('最后一段。'));assert(!text.includes('4:29'));assert(layout.pages.length>1);
});
