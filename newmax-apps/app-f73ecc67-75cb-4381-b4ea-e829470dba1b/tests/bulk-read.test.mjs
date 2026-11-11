import test from 'node:test';
import assert from 'node:assert/strict';
import {unreadIds,captureRead,markRead,restoreRead} from '../src/bulk-read.mjs';
import {filterVideos} from '../src/core.mjs';

const videos=[{id:'a',title:'学习 A',channelId:'one'},{id:'b',title:'学习 B',channelId:'one'},{id:'c',title:'生活 C',channelId:'two'},{id:'d',title:'学习 D',channelId:'two',local:true}];
test('按频道与搜索/收藏/未读过滤后确定范围，不标记隐藏视频',()=>{
  const records={a:{read:false,favorite:true},b:{read:true},c:{read:false,favorite:true}};
  assert.deepEqual(unreadIds(filterVideos(videos,records,'all','one','学习'),records),['a']);
  assert.deepEqual(unreadIds(filterVideos(videos,records,'saved',null,''),records),['a','c']);
  assert.deepEqual(unreadIds(filterVideos(videos,records,'unread',null,'学习'),records),['a','d']);
});
test('全部视频范围包括本地文稿，只改变未读read，不改笔记/收藏/对话',()=>{
  const records={a:{read:false,favorite:true,analysis:'正文',messages:[{text:'问题'}]},b:{read:true,analysis:'已有'}};
  const original=structuredClone(records);
  const before=markRead(records,unreadIds(videos,records));
  assert.equal(before.length,3);assert.equal(records.d.read,true);
  assert.deepEqual(records.a,{...original.a,read:true});assert.deepEqual(records.b,original.b);
  restoreRead(records,before);assert.deepEqual(records,original);
});
test('去重、空范围、已读无操作，固定名单不带入后来视频',()=>{
  const records={b:{read:true}};
  const ids=unreadIds([...videos,videos[0]],records);
  const updated=[...videos,{id:'new'}];
  assert.deepEqual(ids,['a','c','d']);
  assert.equal(markRead(records,ids).length,3);assert.equal(records.new,undefined);
  assert.equal(markRead(records,ids).length,0);assert.deepEqual(markRead(records,[]),[]);
  assert.deepEqual(unreadIds(updated,records),['new']);
});
test('恢复仅read字段，保留操作后新收藏、解析和消息',()=>{
  const records={a:{read:false,analysis:'旧文'}};
  const old=markRead(records,['a','d']);
  records.a.analysis='新文';records.a.favorite=true;records.d.messages=['新消息'];
  restoreRead(records,old);
  assert.deepEqual(records.a,{read:false,analysis:'新文',favorite:true});
  assert.deepEqual(records.d,{messages:['新消息']});
});
test('不存在read属性与原本false分别恢复，不删除原本空记录',()=>{
  const records={a:{},b:{read:false}};const old=markRead(records,['a','b','c']);
  restoreRead(records,old);assert.deepEqual(records,{a:{},b:{read:false}});
});
test('撤销保存失败可恢复到已读，包括曾删除的新增记录',()=>{
  const records={a:{read:false}};const old=markRead(records,['a','c']);
  const rollback=captureRead(records,old.map(x=>x.id));
  restoreRead(records,old);assert.equal(records.c,undefined);
  restoreRead(records,rollback);assert.deepEqual(records,{a:{read:true},c:{read:true}});
});
test('模拟保存重载保留已读、解析、收藏和对话',()=>{
  const records={a:{read:false,analysis:'不能改',favorite:true,messages:[{text:'保留'}]}};
  markRead(records,['a','c']);const restored=JSON.parse(JSON.stringify({records}));
  assert.deepEqual(restored.records,records);assert.equal(restored.records.a.analysis,'不能改');
});
