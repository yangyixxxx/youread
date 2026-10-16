import test from 'node:test';
import assert from 'node:assert/strict';
import {safeAvatarURL,channelAvatar,bindAvatarFallback} from '../src/channel-avatar.mjs';
const url='https://yt3.googleusercontent.com/avatar=s160';

test('只允许可信HTTPS图片域，拒绝脚本、本地路径、用户信息与非标准端口',()=>{
  for(const value of [url,'https://yt3.ggpht.com/a','https://i.ytimg.com/a'])assert.equal(safeAvatarURL(value),value);
  for(const value of ['javascript:alert(1)','http://yt3.ggpht.com/a','file:///a','https://yt3.ggpht.com.evil.test/a','https://a:b@yt3.ggpht.com/a','https://yt3.ggpht.com:999/a','https://yt3.ggpht.com/\na',null])assert.equal(safeAvatarURL(value),'');
});
test('头像与字母底图同尺寸，不发送referrer，图片不重复朗读频道名',()=>{
  const html=channelAvatar({title:'@Alex',avatar:url});assert.match(html,/<img /);assert.match(html,/referrerpolicy="no-referrer"/);assert.match(html,/alt="" width="26" height="26"/);assert.match(html,/<span>A<\/span>/);assert.match(html,/aria-hidden="true"/);
});
test('无头像与加载失败地址使用字母占位，转义标题和地址',()=>{
  assert(!channelAvatar({title:'甲频道'}).includes('<img'));
  assert(!channelAvatar({title:'A',avatar:url},new Set([url])).includes('<img'));
  assert.match(channelAvatar({title:'<evil>',avatar:'https://yt3.ggpht.com/a?x="x'}),/&lt;/);
  assert.match(channelAvatar({title:''}),/>\?<\/span>/);
  assert.match(channelAvatar({title:'😎频道'}),/>😎<\/span>/);
});
test('捕获图片加载失败后移除破图并记忆失败，不影响其他图片',()=>{
  let listener,capture,removed=false,unbound=false;const failed=new Set();
  const root={addEventListener:(type,fn,flag)=>{assert.equal(type,'error');listener=fn;capture=flag;},removeEventListener:(type,fn,flag)=>{unbound=type==='error'&&fn===listener&&flag===true;}};
  const off=bindAvatarFallback(root,failed);assert.equal(capture,true);
  listener({target:{matches:()=>false,remove:()=>{throw Error('不应删除其他图片');}}});
  listener({target:{matches:()=>true,src:url,remove:()=>removed=true}});
  assert(removed);assert(failed.has(url));off();assert(unbound);
});
