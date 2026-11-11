import {test} from 'node:test';
import assert from 'node:assert/strict';
import {videoURL,filterVideos} from '../src/core.mjs';

test('单视频链接统一ID并清除跟踪/播放列表参数',()=>{
  for(const url of ['https://youtu.be/abcdefghijk?si=tracking','https://youtube.com/watch?v=abcdefghijk&list=example','https://m.youtube.com/shorts/abcdefghijk','https://youtube.com/live/abcdefghijk?t=60'])assert.equal(videoURL(url),'https://www.youtube.com/watch?v=abcdefghijk');
});
test('拒绝频道、播放列表、伪域名、凭据和重复视频参数',()=>{
  for(const url of ['https://youtube.com/@Example','https://youtube.com/playlist?list=x','https://youtube.com.evil.test/watch?v=abcdefghijk','http://youtube.com/watch?v=abcdefghijk','https://a@youtube.com/watch?v=abcdefghijk','https://youtube.com/watch?v=abcdefghijk&v=zzzzzzzzzzz'])assert.throws(()=>videoURL(url));
});
test('临时目录可与频道重叠、支持搜索，不漏入普通视频',()=>{
  const videos=[{id:'a',title:'测试甲',channelId:'c',channelTitle:'频道',temporary:true},{id:'b',title:'测试乙',channelId:'c',channelTitle:'频道'},{id:'d',title:'临时',temporary:true}];
  assert.deepEqual(filterVideos(videos,{},'temporary',null,'').map(v=>v.id),['a','d']);
  assert.deepEqual(filterVideos(videos,{},'temporary',null,'频道').map(v=>v.id),['a']);
  assert.equal(filterVideos(videos,{},'all','c','').length,2);
  assert.equal(filterVideos(videos,{},'all',null,'').length,3);
});
