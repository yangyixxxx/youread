import test from 'node:test';
import assert from 'node:assert/strict';
import {channelUnreadCounts,channelIndicator} from '../src/navigation.mjs';
import {paneBounds,paneWidths,normalizeSidebarWidth,normalizePaneWidth} from '../src/sidebar-resize.mjs';
import {markRead,restoreRead} from '../src/bulk-read.mjs';
const videos=[{id:'a',channelId:'one'},{id:'b',channelId:'one'},{id:'c',channelId:'two'}];
test('频道只统计真实未读并去重，不受其它频道影响',()=>{
  const records={a:{read:true},c:{read:false}};
  assert.deepEqual([...channelUnreadCounts([...videos,videos[1]],records)],[['one',1],['two',1]]);
});
test('批量已读后隐藏角标，撤销后恢复数量，不改正文',()=>{
  const records={a:{read:false,analysis:'保留'}};const old=markRead(records,['a','b']);
  assert.equal(channelIndicator('ready',channelUnreadCounts(videos,records).get('one')),'');
  restoreRead(records,old);assert.equal(channelUnreadCounts(videos,records).get('one'),2);assert.equal(records.a.analysis,'保留');
});
test('正常同步无绿点，未读只显示数量，有同步失败仍明确独立标识',()=>{
  assert.equal(channelIndicator('ready',0),'');assert.equal(channelIndicator('ready'),'');
  assert.match(channelIndicator('ready',3),/3 条未读/);assert.doesNotMatch(channelIndicator('ready',3),/status-dot/);
  assert.match(channelIndicator('error',0),/频道同步失败/);assert.doesNotMatch(channelIndicator('error',0),/channel-unread/);
  assert.match(channelIndicator('syncing',0),/频道正在同步/);assert.match(channelIndicator('error',2),/2 条未读/);
});
test('不把无效或注入数值作为角标HTML',()=>{
  for(const count of [NaN,Infinity,-1,0,1.5,'<img src=x>',true])assert.equal(channelIndicator('ready',count),'');
});
test('默认宽度保持原桌面大小，最小窗口切回抽屉',()=>{
  assert.deepEqual(paneWidths({},2560),{sidebarWidth:192,videoPaneWidth:345,mobile:false});
  assert.deepEqual(paneWidths({},1000),{sidebarWidth:167,videoPaneWidth:274,mobile:false});
  assert.deepEqual(paneWidths({sidebarWidth:320,videoPaneWidth:600},640),{sidebarWidth:207,videoPaneWidth:640,mobile:true});
  assert.equal(paneWidths({},860).mobile,true);assert.equal(paneWidths({},861).mobile,false);
});
test('两栏自定义上下限及无效存储值安全回退',()=>{
  assert.equal(normalizeSidebarWidth(900),400);assert.equal(normalizeSidebarWidth(10),160);assert.equal(normalizeSidebarWidth(255.7),256);
  assert.equal(normalizePaneWidth(900,'videoPaneWidth'),640);assert.equal(normalizePaneWidth(10,'videoPaneWidth'),240);
  for(const v of [null,undefined,'320',{},NaN,Infinity,true]){
    assert.equal(normalizeSidebarWidth(v),null);assert.equal(normalizePaneWidth(v,'videoPaneWidth'),null);
  }
});
test('联合约束保留360px阅读区，临时收缩不改变已保存偏好',()=>{
  const preferences={sidebarWidth:400,videoPaneWidth:640};
  for(const w of [861,900,1000,1100,1101,1400,2560]){
    const widths=paneWidths(preferences,w);
    assert.ok(widths.sidebarWidth>=160&&widths.videoPaneWidth>=240);
    assert.ok(w-widths.sidebarWidth-widths.videoPaneWidth-2>=360);
    assert.ok(widths.sidebarWidth<=paneBounds('sidebarWidth',widths,w).max);
    assert.ok(widths.videoPaneWidth<=paneBounds('videoPaneWidth',widths,w).max);
  }
  assert.deepEqual(paneWidths(preferences,2560),{...preferences,mobile:false});
  assert.deepEqual(preferences,{sidebarWidth:400,videoPaneWidth:640});
});
test('旧的频道宽度独立保留，视频列表取当前默认值',()=>{
  assert.deepEqual(paneWidths({sidebarWidth:320},2560),{sidebarWidth:320,videoPaneWidth:345,mobile:false});
});
test('一栏重置不重置另一栏，键盘边界考虑另一栏实时宽度',()=>{
  assert.deepEqual(paneWidths({sidebarWidth:null,videoPaneWidth:500},1600),{sidebarWidth:192,videoPaneWidth:500,mobile:false});
  assert.deepEqual(paneWidths({sidebarWidth:320,videoPaneWidth:null},1600),{sidebarWidth:320,videoPaneWidth:345,mobile:false});
  const widths=paneWidths({sidebarWidth:300,videoPaneWidth:280},1000);
  assert.equal(paneBounds('sidebarWidth',widths,1000).max,358);
  assert.equal(paneBounds('videoPaneWidth',widths,1000).max,338);
});
