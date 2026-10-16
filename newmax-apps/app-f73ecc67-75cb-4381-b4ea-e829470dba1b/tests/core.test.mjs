import test from 'node:test';
import assert from 'node:assert/strict';
import {escapeHTML,formatTime,normalizeChannel,videoURL,parseTranscript,transcriptText,splitTranscript,summaryPrompt,mergePrompt,chatPrompt,buildChatContext,filterVideos,markdown} from '../src/core.mjs';

test('频道 handle、UC ID 和频道链接规范化',()=>{
  assert.equal(normalizeChannel('@YouTube'),'https://www.youtube.com/@YouTube');
  assert.equal(normalizeChannel(' UCBR8-60-B28hp2BmDPdntcQ '),'https://www.youtube.com/channel/UCBR8-60-B28hp2BmDPdntcQ');
  assert.equal(normalizeChannel('https://youtube.com/@YouTube/videos'),'https://www.youtube.com/@YouTube');
});
test('拒绝视频、伪造域名、凭据和查询参数',()=>{
  for(const s of ['https://evil.test/@youtube','https://youtube.com.evil.test/@youtube','https://user@youtube.com/@youtube','https://youtube.com:1337/@youtube','https://youtube.com/watch?v=71ya_JC_IbM','https://youtube.com/@youtube?x=1','javascript:alert(1)',''])assert.throws(()=>normalizeChannel(s));
});
test('视频链接规范化和跳转安全',()=>{
  assert.equal(videoURL('https://youtu.be/71ya_JC_IbM?t=4'),'https://www.youtube.com/watch?v=71ya_JC_IbM');
  assert.equal(videoURL('https://youtube.com/shorts/71ya_JC_IbM'),'https://www.youtube.com/watch?v=71ya_JC_IbM');
  assert.equal(videoURL(''),'');assert.throws(()=>videoURL('https://evil.test/watch?v=71ya_JC_IbM'));assert.throws(()=>videoURL('javascript:alert(1)'));
});
test('SRT 多行与小时格式正确解析',()=>{
  const t=parseTranscript('1\n00:00:01,250 --> 00:00:04,000\n第一句话\n第二句话\n\n2\n01:02:03,100 --> 01:02:05,000\n另一个段落','a.srt');
  assert.equal(t.segments.length,2);assert.equal(t.segments[0].start,1.25);assert.equal(t.segments[0].text,'第一句话 第二句话');assert.equal(t.segments[1].start,3723.1);assert.equal(t.format,'srt');
});
test('VTT 忽略头、样式、注释和 cue 标识',()=>{
  const t=parseTranscript('WEBVTT\n\nNOTE not a cue\nignore\n\nSTYLE\n::cue { color:red }\n\nhello\n00:01.000 --> 00:04.000 align:start\n<c.green>hello &amp; world</c>\n\n00:04.000 --> 00:05.000\nNext','a.vtt');
  assert.equal(t.segments.length,2);assert.equal(t.segments[0].text,'hello & world');assert.equal(t.format,'vtt');
});
test('TXT 没有时间轴，不生成虚构时间',()=>{
  const t=parseTranscript('第一段\n\n第二段','notes.txt');assert.equal(t.segments[0].start,null);assert.equal(t.segments.length,2);assert.equal(t.format,'txt');assert.equal(transcriptText(t.segments),'第一段\n第二段');
});
test('拒绝空文稿、过长文稿和无效字幕',()=>{
  for(const [text,name] of [['','a.txt'],['x'.repeat(240001),'a.txt'],['not subtitle','a.srt'],['WEBVTT\ninvalid','']])assert.throws(()=>parseTranscript(text,name));
});
test('时间显示正确且无时间不显示伪造00:00',()=>{
  assert.equal(formatTime(null),'');assert.equal(formatTime(0),'0:00');assert.equal(formatTime(65.7),'1:05');assert.equal(formatTime(3723),'1:02:03');
});
test('长文分段不会丢失短行',()=>{
  const seg=Array.from({length:15},(_,i)=>({start:i,text:'字幕'+i+'x'.repeat(500)}));const chunks=splitTranscript(seg,1000);assert(chunks.length>1);assert(chunks.every(c=>c.length<=1000));for(let i=0;i<15;i++)assert(chunks.join('\n').includes('字幕'+i));
});
test('极长单行也能分段且不丢字',()=>{const chunks=splitTranscript([{start:null,text:'a'.repeat(21000)}]);assert.deepEqual(chunks.map(c=>c.length),[10000,10000,1000]);});
test('摘要提示包含当前标题与范围约束',()=>{const p=summaryPrompt('测试标题','[1:00] 原文',1,3);assert(p.includes('第 2/3 部分'));assert(p.includes('不能当作完整视频'));assert(p.includes('不编造'));assert(p.includes('[1:00] 原文'));});
test('分段汇总保留每段完整内容，不截断后面的观点',()=>{const parts=Array.from({length:24},(_,i)=>String(i)+':'+'.'.repeat(3000)+`末尾观点${i}`);const p=mergePrompt('测试',parts);for(const part of parts)assert(p.includes(part));assert(p.includes('第 24 部分'));});
test('短文问答传入全文，不混入其他视频',()=>{const p=chatPrompt('当前视频','为什么',[{start:2,text:'只有这段原文'}],'概览',[{role:'user',text:'上次问题'}]);assert.equal(p.scope,'完整文稿');assert(p.prompt.includes('只有这段原文'));assert(p.prompt.includes('上次问题'));assert(p.prompt.includes('不可信'));});
test('长文问答完整提供每一段，不再按关键词截取12000字符',()=>{const segments=Array.from({length:160},(_,i)=>({start:i*10,text:`第${i}段独立观点 `+'x'.repeat(180)}));const c=buildChatContext(segments,'任意问题');assert.equal(c.limited,false);assert.equal(c.scope,'完整文稿');assert.equal(c.text,transcriptText(segments));for(const s of segments)assert(c.text.includes(s.text));assert(c.text.length>12000);});
test('完整提供长解析和所有历史轮次，不截掉每条末尾',()=>{const analysis='解析'.repeat(4000)+'解析尾部';const history=Array.from({length:12},(_,i)=>({role:i%2?'assistant':'user',text:`第${i}轮`+'长文'.repeat(1000)+`末尾${i}`}));const p=chatPrompt('测试','问题',[{start:0,text:'a'.repeat(15000)+'字幕末尾'}],analysis,history);assert(p.prompt.includes(analysis));assert(p.prompt.includes('字幕末尾'));for(const h of history)assert(p.prompt.includes(h.text));});
test('过滤频道、标题、未读和收藏',()=>{const v=[{id:'1',channelId:'a',title:'学习',channelTitle:'测试'},{id:'2',channelId:'b',title:'coding',channelTitle:'test'}];const r={'1':{read:true,favorite:true}};assert.equal(filterVideos(v,r,'unread',null,'')[0].id,'2');assert.equal(filterVideos(v,r,'saved',null,'')[0].id,'1');assert.equal(filterVideos(v,r,'all','a','学习').length,1);assert.equal(filterVideos(v,r,'all',null,'CODING')[0].id,'2');});
test('Markdown 转义模型 HTML、引用变为安全按钮',()=>{const html=markdown('## 标题\n<script>alert(1)</script>\n**重点** [1:23]');assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));assert(html.includes('data-time="83"'));assert(html.includes('<strong>重点</strong>'));});
test('HTML 属性转义',()=>assert.equal(escapeHTML('"<&\''),'&quot;&lt;&amp;&#39;'));
