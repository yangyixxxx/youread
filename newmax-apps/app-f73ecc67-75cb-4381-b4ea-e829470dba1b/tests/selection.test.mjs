import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSelection,firstChannelVideo} from '../src/selection.mjs';

const channels=[{id:'first'},{id:'second'}];
const videos=[{id:'other',channelId:'second'},{id:'first-video',channelId:'first'},{id:'next-video',channelId:'first'}];
test('启动选择首频道的首视频，不恢复其他频道历史选择',()=>{
  assert.deepEqual(defaultSelection(channels,videos,'other'),{channel:'first',selected:'first-video'});
});
test('同频道历史选择也不覆盖列表第一条',()=>{
  assert.equal(defaultSelection(channels,videos,'next-video').selected,'first-video');
});
test('遵循频道和视频的显示顺序，不另行排序',()=>{
  assert.deepEqual(defaultSelection([...channels].reverse(),videos),{channel:'second',selected:'other'});
  assert.equal(defaultSelection(channels,[...videos].reverse()).selected,'next-video');
});
test('首频道为空时保留频道，不能显示其他频道内容',()=>{
  assert.deepEqual(defaultSelection(channels,[videos[0]],'other'),{channel:'first',selected:null});
});
test('同步首次返回内容后能补选首视频',()=>{
  assert.equal(defaultSelection(channels,[]).selected,null);
  assert.equal(defaultSelection(channels,videos).selected,'first-video');
});
test('没有订阅时保留有效本地选择，失效选择显示空状态',()=>{
  assert.deepEqual(defaultSelection([],videos,'other'),{channel:null,selected:'other'});
  assert.deepEqual(defaultSelection([],videos,'missing'),{channel:null,selected:null});
  assert.deepEqual(defaultSelection([],[]),{channel:null,selected:null});
});
test('频道切换只选择该频道的首条，没有内容返回空',()=>{
  assert.equal(firstChannelVideo(videos,'first'),'first-video');
  assert.equal(firstChannelVideo(videos,'empty'),null);
});
test('默认选择不修改资料或数组顺序',()=>{
  const before=JSON.stringify({channels,videos});
  defaultSelection(channels,videos,'other');firstChannelVideo(videos,'first');
  assert.equal(JSON.stringify({channels,videos}),before);
});
