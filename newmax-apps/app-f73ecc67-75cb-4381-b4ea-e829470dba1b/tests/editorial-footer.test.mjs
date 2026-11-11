import test from 'node:test';
import assert from 'node:assert/strict';
import {newArticle,validateArticle,articleFooterText,fitFooterText,renderArticlePage} from '../src/editorial.mjs';
const article=()=>newArticle({title:'测试标题',channelTitle:'测试来源'},{text:'完整原文'});
function draw(a,index=0){
  const calls=[],ctx={font:'',textAlign:'left',fillRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},measureText(text){return {width:Array.from(text).length*11};},fillText(text,x,y){calls.push({text,x,y,align:this.textAlign,font:this.font});}};
  const layout={width:1080,height:1800,pages:[{commands:[]},{commands:[]}]};
  renderArticlePage(layout,index,a,{},null,{getContext:()=>ctx});return {calls,ctx};
}
test('新草稿与旧草稿默认页脚视频精读，旧对象不被迁移改写',()=>{
  const fresh=article();assert.equal(fresh.footerText,'视频精读');
  const old={...fresh};delete old.footerText;const before=JSON.stringify(old);
  assert.equal(validateArticle(old).footerText,'视频精读');assert.equal(articleFooterText(old),'视频精读');assert.equal(JSON.stringify(old),before);
});
test('自定义及明确留空可序列化重载，不把空文字变回默认',()=>{
  for(const text of ['我的知识笔记','品牌 · 思考记录','']){
    const a={...article(),footerText:text};const saved=validateArticle(JSON.parse(JSON.stringify(a)));
    assert.equal(saved.footerText,text);assert.equal(articleFooterText(saved),text);assert.equal(saved.body,'完整原文');
  }
});
test('未完成与原文状态不能被自定义或空页脚隐藏，旧状态默认显示不变',()=>{
  for(const sourceStatus of ['未完成草稿 · 请勿视为完整解析','视频原文 · 未经编辑','旧解析 · 完整性未确认']){
    assert.equal(articleFooterText({...article(),sourceStatus}),sourceStatus);
    assert.equal(articleFooterText({...article(),sourceStatus,footerText:''}),sourceStatus);
    assert.equal(articleFooterText({...article(),sourceStatus,footerText:'我的笔记'}),sourceStatus+' · 我的笔记');
  }
});
test('图片每页左下显示自定义文字，右侧页码保持，原数据不变',()=>{
  const a={...article(),footerText:'创作实验室'},before=JSON.stringify(a);
  for(let i=0;i<2;i++){
    const {calls}=draw(a,i);assert.equal(calls[0].text,'创作实验室');assert.equal(calls[0].x,72);assert.equal(calls[0].align,'left');
    assert.equal(calls[1].text,`0${i+1} / 02`);assert.equal(calls[1].x,1008);assert.equal(calls[1].align,'right');
  }
  assert.equal(JSON.stringify(a),before);
});
test('留空不绘制默认标签，但仍绘制页码和强制来源标记',()=>{
  const a={...article(),footerText:''};assert.deepEqual(draw(a).calls.map(x=>x.text),['01 / 02']);
  a.sourceStatus='未完成草稿';assert.deepEqual(draw(a).calls.map(x=>x.text),['未完成草稿','01 / 02']);
});
test('超长页脚只在图片安全宽度省略，不压到页码、不截改保存内容',()=>{
  const text='非常长的自定义页脚😎'.repeat(1000),a={...article(),footerText:text},before=JSON.stringify(a);
  const {calls,ctx}=draw(a);assert.match(calls[0].text,/…$/);assert(ctx.measureText(calls[0].text).width+72<=1008-ctx.measureText(calls[1].text).width-24);
  assert.equal(a.footerText,text);assert.equal(JSON.stringify(a),before);
  assert.equal(fitFooterText('短文字',100,s=>s.length*10),'短文字');assert.equal(fitFooterText('任意',0,s=>s.length),'');
});
test('HTML及换行页脚只绘制安全文字，不影响源正文与来源',()=>{
  const a={...article(),footerText:'<script>示例</script>\n我的笔记'};
  assert.equal(draw(a).calls[0].text,'<script>示例</script> 我的笔记');assert.equal(a.body,'完整原文');assert(a.footerText.includes('\n'));
});
