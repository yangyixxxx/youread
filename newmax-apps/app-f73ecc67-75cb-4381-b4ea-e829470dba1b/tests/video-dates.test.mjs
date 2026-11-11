import test from 'node:test';
import assert from 'node:assert/strict';
import {publicationMillis,sortVideosByPublication,publicationLabel,publicationTooltip} from '../src/video-dates.mjs';
import {filterVideos} from '../src/core.mjs';
import {defaultSelection} from '../src/selection.mjs';
const v=(id,publishedAt,extra={})=>({id,publishedAt,channelId:'channel',title:id,...extra});
const now=new Date('2026-11-05T01:00:00Z');
test('按发布时间最新在前，未知日期置后、相同时间稳定且不修改原数组',()=>{
  const input=[v('old','2026-02-20T00:00:00Z'),v('unknown',null),v('new','2026-11-05T00:00:00Z'),v('tie','2026-11-05T00:00:00Z'),v('invalid','1 hour ago')];
  const original=JSON.stringify(input);
  assert.deepEqual(sortVideosByPublication(input).map(x=>x.id),['new','tie','old','unknown','invalid']);assert.equal(JSON.stringify(input),original);
  assert.equal(publicationMillis(null),null);assert.equal(publicationMillis('bad'),null);assert.equal(publicationMillis(''),null);
});
test('频道、搜索、收藏、未读过滤保持同一发布时间顺序，默认选择最新',()=>{
  const sorted=sortVideosByPublication([v('old','2026-02-20'),v('other','2026-11-06',{channelId:'other'}),v('new','2026-11-05')]);
  const records={old:{read:false,favorite:true},new:{read:false,favorite:true}};
  for(const filter of ['all','unread','saved'])assert.deepEqual(filterVideos(sorted,records,filter,'channel','').map(x=>x.id),['new','old']);
  assert.deepEqual(filterVideos(sorted,records,'all','channel','new').map(x=>x.id),['new']);
  assert.equal(defaultSelection([{id:'channel'}],sorted).selected,'new');
});
test('近似时间明确标记、悬停可见完整时刻；日期精度不伪造时分',()=>{
  const video=v('new','2026-11-05T00:00:00Z',{datePrecision:'approximate'});
  assert.match(publicationLabel(video,now),/^约 /);assert.match(publicationTooltip(video),/相对时间换算/);
  video.datePrecision='second';assert.doesNotMatch(publicationLabel(video,now),/约/);assert.match(publicationTooltip(video),/发布时间/);
  video.datePrecision='day';assert.match(publicationTooltip(video),/仅提供日期/);assert.doesNotMatch(publicationTooltip(video),/00:00/);
  assert.match(publicationLabel(v('old','2025-11-05'),now),/2025/);
  assert.equal(publicationLabel(v('unknown',null),now),'日期未提供');assert.equal(publicationLabel(v('local',null,{local:true}),now),'本地导入');
});
test('补齐未知日期后重新排序，重载可恢复、未知输入不当作时间',()=>{
  const input=[v('old','2026-05-10'),v('new',null)];input[1].publishedAt='2026-11-05T00:00:00Z';
  assert.deepEqual(sortVideosByPublication(JSON.parse(JSON.stringify(input))).map(x=>x.id),['new','old']);
  for(const value of [1,true,'1小时前','2026-11-05T00:00:00','0','yesterday'])assert.equal(publicationMillis(value),null);
});
