import test from 'node:test';
import assert from 'node:assert/strict';
import {transcriptText} from '../src/core.mjs';
import {generateAnalysis,compatibilityPlan,isContextLimitError} from '../src/analysis.mjs';
const segments=Array.from({length:160},(_,i)=>({start:i*30,text:`标记${i}:`+'完整文稿内容'.repeat(140)}));

test('长文默认只请求一次，原文中段、结尾、时间戳全部保留，不使用旧摘要替代',async()=>{
  const calls=[],parts=['旧分段一','旧分段二'];let saves=0;
  const result=await generateAnalysis({title:'全文测试',segments,parts,request:async p=>{calls.push(p);return {ok:true,text:'最终解析'};},onPart:async()=>{saves++;}});
  assert.equal(calls.length,1);assert.equal(saves,0);assert.equal(result.text,'最终解析');
  assert(calls[0].includes(transcriptText(segments)));assert(!calls[0].includes('旧分段一'));
  assert(!calls[0].includes('不能当作完整视频'));assert.deepEqual(parts,['旧分段一','旧分段二']);
});
test('全文不受兼容模式30段的限制',async()=>{
  let calls=0;
  await generateAnalysis({title:'超长测试',segments:[{start:null,text:'全文'.repeat(160000)}],request:async()=>{calls++;return {ok:true,text:'解析'};}});
  assert.equal(calls,1);
});
test('全文超限和SSE失败不自动分段，不清除旧进度',async()=>{
  for(const message of ['maximum context length exceeded','SSE 流中未拼出任何文本']){
    let calls=0;const parts=['保留'];
    await assert.rejects(generateAnalysis({title:'失败',segments,parts,request:async()=>{calls++;throw new Error(message);}}),new RegExp(message));
    assert.equal(calls,1);assert.deepEqual(parts,['保留']);
  }
});
test('兼容模式只处理剩余分段，完整摘要进入一次汇总',async()=>{
  const all=compatibilityPlan(segments);const parts=all.chunks.map((_,i)=>`旧摘要${i}`+'内容'.repeat(600)+'末尾');parts.pop();
  const before=[...parts],calls=[],saved=[];
  await generateAnalysis({title:'续接',segments,mode:'chunks',parts,request:async p=>{calls.push(p);return {ok:true,text:'新摘要末尾'};},onPart:async(i,text)=>saved.push([i,text])});
  assert.equal(calls.length,2);assert.equal(saved[0][0],all.chunks.length-1);
  assert(calls[1].includes(before[0]));assert(calls[1].includes('新摘要末尾'));
  assert.deepEqual(parts,before);
});
test('兼容分段第二次失败时，仅保存已完成段，不调用汇总',async()=>{
  let count=0;const saved=[];
  await assert.rejects(generateAnalysis({title:'失败续接',segments,mode:'chunks',request:async()=>{if(++count===2)throw new Error('故障');return {ok:true,text:'第1段'};},onPart:async(i,text)=>saved.push([i,text])}),/故障/);
  assert.equal(count,2);assert.deepEqual(saved,[[0,'第1段']]);
});
test('全部分段完成后只汇总，单段已有摘要无需请求',async()=>{
  const parts=compatibilityPlan(segments).chunks.map(()=> '已有');let calls=0;
  await generateAnalysis({title:'汇总',segments,parts,mode:'chunks',request:async()=>{calls++;return {text:'汇总'};}});
  assert.equal(calls,1);
  const result=await generateAnalysis({title:'短文',segments:[{start:null,text:'原文'}],parts:['已有解析'],mode:'chunks',request:async()=>{throw new Error('不应请求');}});
  assert.equal(result.text,'已有解析');
});
test('识别明确容量错误，不将SSE空正文误判为容量已超限',()=>{
  for(const message of ['maximum context length exceeded','context_length_exceeded','prompt is too long','输入超出限制','上下文长度超限'])assert(isContextLimitError(message));
  assert(!isContextLimitError('SSE 流中未拼出任何文本'));
});
test('空文稿或未知模式在请求前拒绝',async()=>{
  let count=0;const request=async()=>{count++;};
  await assert.rejects(generateAnalysis({segments:[],request}),/没有可解析/);
  await assert.rejects(generateAnalysis({segments,mode:'unknown',request}),/未知/);
  assert.equal(count,0);
});
