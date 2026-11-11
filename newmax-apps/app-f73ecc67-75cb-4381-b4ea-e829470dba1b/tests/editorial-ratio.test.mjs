import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_PAGE_RATIO,newArticle,validateArticle,layoutArticle} from '../src/editorial.mjs';
const measure=(text,font)=>Array.from(text).length*Number(font.match(/(\d+)px/)[1]);
const textOf=layout=>layout.pages.flatMap(p=>p.commands).filter(c=>c.kind==='text').map(c=>c.runs.map(r=>r.text).join('')).join('');

test('新排版默认3:4及1080×1440，不依赖旧默认长页',()=>{
  const a=newArticle({title:'标题'},{text:'正文'});
  assert.equal(DEFAULT_PAGE_RATIO,'3:4');assert.equal(a.ratio,'3:4');
  const l=layoutArticle(a,measure);assert.equal(l.width,1080);assert.equal(l.height,1440);
});
test('缺失或无效比例的校验与直接排版统一回退3:4',()=>{
  for(const ratio of [undefined,'错误']){
    const a={...newArticle({title:'标题'},{text:'正文'}),ratio};
    assert.equal(validateArticle(a).ratio,'3:4');assert.equal(layoutArticle(a,measure).height,1440);
  }
});
test('已有有效比例与原文完全保留，不自动迁移用户草稿',()=>{
  for(const [ratio,height] of [['3:5',1800],['3:4',1440],['9:16',1920]]){
    const a={...newArticle({title:'旧标题'},{text:'旧正文'}),ratio},before=JSON.stringify(a);
    const validated=validateArticle(a);assert.equal(validated.ratio,ratio);assert.equal(layoutArticle(validated,measure).height,height);assert.equal(JSON.stringify(a),before);
  }
});
test('长页切3:4增加页数，字号完整文字及安全区保留',()=>{
  const a={...newArticle({title:'保留标题'},{text:'完整正文不压缩也不裁切。'.repeat(500)+'末尾唯一标记'}),ratio:'3:5'};
  const long=layoutArticle(a,measure),short=layoutArticle({...a,ratio:'3:4'},measure);
  assert(short.pages.length>long.pages.length);assert.equal(textOf(short),textOf(long));assert(textOf(short).endsWith('末尾唯一标记'));
  for(const page of short.pages)for(const c of page.commands){assert(c.y>=72);assert(c.y+c.lineHeight<=1440-115);if(!c.h1&&c.size!==26)assert.equal(c.size,40);}
});
