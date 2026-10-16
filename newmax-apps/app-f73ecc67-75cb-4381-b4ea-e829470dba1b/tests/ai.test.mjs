import test from 'node:test';
import assert from 'node:assert/strict';
import {outputTokens,requestAI,waitTimeout} from '../src/ai.mjs';
const capabilities={outputBudget:'auto-v1',completionMetadata:true};
const success={ok:true,text:'正文',termination:'stop',truncated:false,finishReason:'stop'};
const sdk=chat=>({capabilities,chat});
test('默认自动预算，自定义正整数不受8000上限限制',()=>{
  for(const v of [undefined,null,'auto','',0,-1,1.2,'bad'])assert.equal(outputTokens(v),'auto');
  for(const v of [4000,8000,32768,142082])assert.equal(outputTokens(v),v);
  assert.equal(outputTokens('64000'),64000);
});
test('旧宿主必须在请求前拦截，避免auto被降到1024',async()=>{
  let count=0;await assert.rejects(requestAI({chat:async()=>{count++;return success;}},'文稿'),/重启 NewMax/);assert.equal(count,0);
});
test('默认auto与15分钟，不强制换模型',async()=>{
  const calls=[];const result=await requestAI(sdk(async a=>{calls.push(a);return success;}),'文稿');
  assert.equal(result.text,'正文');assert.deepEqual(calls,[{prompt:'文稿',maxTokens:'auto',timeoutMs:900000}]);
});
test('传递自定义大额度、模型和等待时间',async()=>{
  let got;await requestAI(sdk(async a=>{got=a;return success;}),'文稿',{model:'test',providerId:'isolated',maxTokens:64000,timeoutMs:1800000});
  assert.deepEqual(got,{prompt:'文稿',model:'test',providerId:'isolated',maxTokens:64000,timeoutMs:1800000});
});
for(const termination of ['length','timeout','unknown','error'])test(`${termination}保留部分正文与元数据，不重试`,async()=>{
  let count=0;const result={ok:false,text:'### 10. 她',termination,truncated:termination==='length'?true:null,finishReason:termination==='length'?'length':null,usage:{outputTokens:8000}};
  await assert.rejects(requestAI(sdk(async()=>{count++;return result;}),'文稿'),e=>{assert.equal(e.result.text,'### 10. 她');assert.deepEqual(e.result.usage,result.usage);return true;});assert.equal(count,1);
});
for(const result of [{ok:true,text:'部分正文'},{...success,text:' '},{ok:false,error:'SSE 流中未拼出任何文本'},{ok:true,reasoning:'思考不是正文'}])test('有ok标记也不能把未知结束/空正文当完整',async()=>{
  let count=0;await assert.rejects(requestAI(sdk(async()=>{count++;return result;}),'文稿'));assert.equal(count,1);
});
test('抛出的网络错误不重试',async()=>{let n=0;await assert.rejects(requestAI(sdk(async()=>{n++;throw new Error('网络断开');}),'文稿'),/网络断开/);assert.equal(n,1);});
test('默认等待15分钟且不再把较长等待压为3分钟',()=>{assert.equal(waitTimeout(undefined),900000);assert.equal(waitTimeout(1800000),1800000);assert.equal(waitTimeout(1),900000);});
