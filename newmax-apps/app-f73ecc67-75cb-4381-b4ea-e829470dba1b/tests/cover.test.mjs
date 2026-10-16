import test from 'node:test';
import assert from 'node:assert/strict';
import {canFetchCover,shouldFetchCover,validCoverSource,fetchVideoCover} from '../src/cover.mjs';
import {newArticle,validateArticle,layoutArticle} from '../src/editorial.mjs';
const video={id:'lmYLF3keVmw',title:'封面验收标题',channelTitle:'测试来源'};
const normalize=async file=>{assert.equal(file.type,'image/jpeg');return {dataUrl:'data:image/jpeg;base64,dGVzdA==',width:1280,height:720};};
const image=()=>new Response(new Uint8Array([255,216,255,217]),{headers:{'content-type':'image/jpeg'}});

test('仅真实格式视频ID可获取，默认补空封面，不覆盖已有或手动移除的图',()=>{
  const article=newArticle(video,{text:'正文'});
  assert.ok(shouldFetchCover(video,article));assert.ok(shouldFetchCover(video,validateArticle(article)));
  assert.equal(shouldFetchCover(video,{...article,coverId:'saved'}),false);
  assert.equal(shouldFetchCover(video,{...article,autoCover:false}),false);
  for(const v of [{id:'../../bad'},{id:video.id,local:true},{id:'local-test'},null])assert.equal(canFetchCover(v),false);
});
test('高清封面固定URL、无凭据无referrer，来源可安全保存',async()=>{
  const calls=[];const asset=await fetchVideoCover(video,{normalize,fetchImpl:async(url,opts)=>{calls.push(url);assert.equal(opts.credentials,'omit');assert.equal(opts.referrerPolicy,'no-referrer');assert.equal(opts.redirect,'error');return image();}});
  assert.deepEqual(calls,[`https://i.ytimg.com/vi/${video.id}/maxresdefault.jpg`]);
  assert.deepEqual(validCoverSource(asset.source),{type:'youtube-cover',videoId:video.id,variant:'maxresdefault'});
  assert.equal(validCoverSource({...asset.source,videoId:'../escape'}),null);
  assert.equal(validCoverSource({...asset.source,variant:'evil'}),null);
  assert.equal(validCoverSource({type:'video-frame',videoId:video.id}),null);
});
test('仅高清404降为标准封面',async()=>{
  const calls=[];const asset=await fetchVideoCover(video,{normalize,fetchImpl:async url=>{calls.push(url);return calls.length===1?new Response('',{status:404}):image();}});
  assert.equal(calls.length,2);assert.ok(calls[1].endsWith('/hqdefault.jpg'));assert.equal(asset.source.variant,'hqdefault');
});
test('HTTP错误和网络失败不循环请求',async()=>{
  for(const status of [403,429,500]){let calls=0;await assert.rejects(fetchVideoCover(video,{normalize,fetchImpl:async()=>{calls++;return new Response('',{status});}}),new RegExp(`HTTP ${status}`));assert.equal(calls,1);}
  let calls=0;await assert.rejects(fetchVideoCover(video,{normalize,fetchImpl:async()=>{calls++;throw new TypeError('Failed to fetch');}}),/检查网络/);assert.equal(calls,1);
});
test('无效视频不联网；拒绝非图片、超大响应和占位小图',async()=>{
  await assert.rejects(fetchVideoCover({id:'local'},{fetchImpl:()=>assert.fail('不应联网')}),/没有可获取/);
  for(const response of [new Response('<html>',{headers:{'content-type':'text/html'}}),new Response('x',{headers:{'content-type':'image/jpeg','content-length':String(11*1024*1024)}}),new Response(new Uint8Array(10*1024*1024+1),{headers:{'content-type':'image/jpeg'}})]){
    await assert.rejects(fetchVideoCover(video,{normalize,fetchImpl:async()=>response}),/有效图片|10 MB/);
  }
  await assert.rejects(fetchVideoCover(video,{fetchImpl:async()=>image(),normalize:async()=>({width:120,height:90})}),/尺寸异常/);
});
test('取消及超时中止下载，不转标准图继续请求',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(fetchVideoCover(video,{signal:controller.signal,normalize,fetchImpl:async()=>{calls++;return image();}}));assert.equal(calls,0);
  await assert.rejects(fetchVideoCover(video,{normalize,timeoutMs:10,fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>{calls++;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})}),/超时/);assert.equal(calls,1);
});
test('标题/来源、封面、正文顺序正确，图片等比，停用选择与完整尾文保持',()=>{
  const article={...newArticle(video,{text:'正文开始。\n\n'+('保留完整内容。'.repeat(600))+'尾文保留。'}),coverId:'test-cover',autoCover:false,assets:{'test-cover':{width:1280,height:720}}};
  const copy=validateArticle(JSON.parse(JSON.stringify(article)));assert.equal(copy.autoCover,false);
  const result=layoutArticle(copy,(text)=>text.length*30,{'test-cover':{width:1280,height:720}}),commands=result.pages.flatMap(p=>p.commands),index=commands.findIndex(c=>c.kind==='image');
  assert.ok(index>0);assert.ok(commands.slice(0,index).some(c=>c.runs?.some(r=>r.text.includes('封'))));
  assert.equal(commands[index].width/commands[index].height,1280/720);
  assert.ok(commands.slice(index+1).flatMap(c=>c.runs||[]).map(r=>r.text).join('').endsWith('尾文保留。'));
  assert.ok(result.pages.length>1);
});
