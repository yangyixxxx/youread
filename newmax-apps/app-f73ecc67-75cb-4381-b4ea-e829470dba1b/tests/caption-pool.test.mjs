import test from 'node:test';
import assert from 'node:assert/strict';
import {captionPoolText,poolCooling} from '../src/caption-pool.mjs';
test('未配置、配置中与未冷却不会冒充YouTube健康',()=>{
  assert.match(captionPoolText(null),/未配置/);
  const value={enabled:true,nodeCount:3,available:3};
  assert.match(captionPoolText(value),/已配置 3/);assert.match(captionPoolText(value),/付费备用未配置/);assert.doesNotMatch(captionPoolText(value),/在线|健康/);
  assert.equal(poolCooling(value),false);
});
test('所有出口冷却时明确暂停与恢复时刻，执行中不混淆为已暂停',()=>{
  const value={enabled:true,nodeCount:3,available:0,cooling:3,nextAvailableAt:Date.now()/1000+1800};
  assert.equal(poolCooling(value),true);assert.match(captionPoolText(value),/出口冷却中/);assert.match(captionPoolText(value),/最早/);
  value.running=true;assert.equal(poolCooling(value),false);assert.match(captionPoolText(value),/最多尝试3个节点/);
});
test('控制失败和单个冷却有明确文字，不自动改用付费',()=>{
  assert.match(captionPoolText({enabled:true,nodeCount:0,available:0,lastError:'无法连接Clash控制接口'}),/无法连接Clash控制接口/);
  assert.equal(poolCooling({enabled:true,nodeCount:0}),false);
  assert.match(captionPoolText({enabled:true,nodeCount:3,available:2,cooling:1}),/2 个未冷却/);
});
