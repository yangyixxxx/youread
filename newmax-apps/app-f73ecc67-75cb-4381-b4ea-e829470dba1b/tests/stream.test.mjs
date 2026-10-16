import test from 'node:test';
import assert from 'node:assert/strict';
import {requestAIStream} from '../src/ai.mjs';
import {readFile} from 'node:fs/promises';

test('实际应用清单声明模型目录和流式生成权限，防止模拟SDK掩盖缺失权限',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../newmax.app.json',import.meta.url),'utf8'));
  assert.ok(manifest.permissions.includes('ai.chat'),'模型目录所需 ai.chat 权限必须声明');
  assert.ok(manifest.permissions.includes('ai.stream'),'流式解析和对话所需 ai.stream 权限必须声明');
});
test('宿主拒绝流式权限时保留原错误、释放监听且不自动重试',async()=>{
  const f=fixture(async()=>({ok:false,error:'Missing permission: ai.stream'}));
  await assert.rejects(requestAIStream(f.ai,'测试文稿'),e=>/Missing permission: ai.stream/.test(e.message)&&e.result.text==='');
  assert.equal(f.calls.length,1);assert.equal(f.deltas.size,0);assert.equal(f.dones.size,0);
});
const capabilities={outputBudget:'auto-v1',completionMetadata:true};
const normal={ok:true,termination:'stop',truncated:false,finishReason:'stop'};
function fixture(run){
  const deltas=new Set(),dones=new Set(),calls=[];
  const emit=(id,delta)=>deltas.forEach(fn=>fn({streamId:id,delta}));
  const done=(id,result)=>dones.forEach(fn=>fn({...result,streamId:id}));
  const ai={capabilities,onStreamDelta:fn=>{deltas.add(fn);return()=>deltas.delete(fn);},onStreamDone:fn=>{dones.add(fn);return()=>dones.delete(fn);},stream:async args=>{calls.push(args);return run(args,{emit,done,deltas,dones});}};
  return {ai,calls,deltas,dones};
}
test('先注册两类监听再请求，增量实时可见，完整参数不降额',async()=>{
  const seen=[];
  const f=fixture(async(a,{emit,done,deltas,dones})=>{
    assert.equal(deltas.size,1);assert.equal(dones.size,1);
    emit('other','不能混入');emit(a.streamId,'## 标题\n');assert.deepEqual(seen,['## 标题\n']);
    emit(a.streamId,'完整正文');done(a.streamId,{...normal,text:'## 标题\n完整正文'});
    return {...normal,text:'## 标题\n完整正文'};
  });
  const result=await requestAIStream(f.ai,'完整文稿',{providerId:'test',model:'mock',maxTokens:142082,timeoutMs:1800000},t=>seen.push(t));
  assert.equal(result.text,'## 标题\n完整正文');assert.equal(seen.length,2);assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].maxTokens,142082);assert.equal(f.calls[0].timeoutMs,1800000);assert.equal(f.calls[0].model,'mock');
  assert.equal(f.deltas.size,0);assert.equal(f.dones.size,0);
});
test('默认auto与15分钟，最终结果不重复追加',async()=>{
  const f=fixture(async(a,{emit,done})=>{emit(a.streamId,'正文');done(a.streamId,{...normal,text:'正文'});return {...normal,text:'正文'};});
  assert.equal((await requestAIStream(f.ai,'全文')).text,'正文');assert.equal(f.calls[0].maxTokens,'auto');assert.equal(f.calls[0].timeoutMs,900000);
});
for(const termination of ['length','timeout','unknown','error'])test(`流式${termination}保留增量与终止元数据，不重试`,async()=>{
  const f=fixture(async(a,{emit,done})=>{emit(a.streamId,'部分正文');const r={ok:false,termination,truncated:termination==='length'?true:null,usage:{outputTokens:123},error:'模拟失败'};done(a.streamId,r);return r;});
  await assert.rejects(requestAIStream(f.ai,'文稿'),e=>e.result.text==='部分正文'&&e.result.termination===termination&&e.result.usage.outputTokens===123);
  assert.equal(f.calls.length,1);assert.equal(f.deltas.size,0);assert.equal(f.dones.size,0);
});
test('IPC拒绝也保留已收到的正文并移除监听',async()=>{
  const f=fixture(async(a,{emit})=>{emit(a.streamId,'断线前正文');throw Error('连接断开');});
  await assert.rejects(requestAIStream(f.ai,'文稿'),e=>e.result.text==='断线前正文'&&/连接断开/.test(e.message));
  assert.equal(f.calls.length,1);assert.equal(f.deltas.size,0);assert.equal(f.dones.size,0);
});
test('没有done事件时使用同一请求Promise的最终结果',async()=>{
  const f=fixture(async(a,{emit})=>{emit(a.streamId,'部分');return {...normal,text:'部分及结尾'};});
  assert.equal((await requestAIStream(f.ai,'文稿')).text,'部分及结尾');assert.equal(f.dones.size,0);
});
test('终止事件没有text时保留全部已收到正文',async()=>{
  const f=fixture(async(a,{emit,done})=>{emit(a.streamId,'完整正文');done(a.streamId,normal);return normal;});
  assert.equal((await requestAIStream(f.ai,'文稿')).text,'完整正文');
});
test('空正文、缺失结束元数据和权限错误不能标为完成',async()=>{
  for(const result of [normal,{ok:true,text:'未知结束'},{ok:false,error:'权限不足'}]){
    const f=fixture(async()=>result);await assert.rejects(requestAIStream(f.ai,'文稿'));assert.equal(f.calls.length,1);assert.equal(f.dones.size,0);
  }
});
test('主进程能力或流式接口缺失时请求前阻断',async()=>{
  let n=0;for(const ai of [{stream:()=>n++},{capabilities,stream:()=>n++}])await assert.rejects(requestAIStream(ai,'文稿'),/重启 NewMax/);
  assert.equal(n,0);
});
test('更短最终正文保留完整增量并标记未知，不静默截断',async()=>{
  const f=fixture(async(a,{emit})=>{emit(a.streamId,'完整正文后半段');return {...normal,text:'完整正文'};});
  await assert.rejects(requestAIStream(f.ai,'文稿'),e=>e.result.text==='完整正文后半段'&&e.result.termination==='unknown');
});
test('不同streamId的结束和迟到事件不能串流',async()=>{
  const seen=[];
  const f=fixture(async(a,{emit,done})=>{done('other',{...normal,text:'别的视频'});emit(a.streamId,'本次正文');done(a.streamId,{...normal,text:'本次正文'});emit(a.streamId,'迟到');return {...normal,text:'本次正文'};});
  assert.equal((await requestAIStream(f.ai,'文稿',{},t=>seen.push(t))).text,'本次正文');assert.deepEqual(seen,['本次正文']);
});
test('连续请求采用不同ID，上一请求监听不残留',async()=>{
  const f=fixture(async(a,{emit})=>{emit(a.streamId,'正文');return {...normal,text:'正文'};});
  await requestAIStream(f.ai,'一');await requestAIStream(f.ai,'二');assert.notEqual(f.calls[0].streamId,f.calls[1].streamId);assert.equal(f.deltas.size,0);
});
test('第二个监听注册失败时清理第一个，不发送请求',async()=>{
  const f=fixture(async()=>normal);f.ai.onStreamDone=()=>{throw Error('监听失败');};
  await assert.rejects(requestAIStream(f.ai,'文稿'),/监听失败/);assert.equal(f.calls.length,0);assert.equal(f.deltas.size,0);
});
