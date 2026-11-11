import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTimeCitation,timeCitations} from '../src/time-citations.mjs';
import {markdown} from '../src/markdown.mjs';
import {articleBlocks,newArticle,layoutArticle} from '../src/editorial.mjs';
import {recommendFrames} from '../src/frame-plan.mjs';

const screenshot='宣传负责形成期待，交付负责兑现期待。[9:38–10:45]\n\n## 冠军为什么还要上场\n\n过去的成绩仍然存在，却不一定能回答今天的问题。[10:48–11:20]\n\n极限挑战与新产品。[11:39–12:05][12:42–13:20]\n\n公开目标让行动更清楚。[13:23–13:59]\n\n承诺也会放大风险。[15:16–15:52] 尾文完整标记';
const text=blocks=>blocks.flatMap(b=>b.runs||[]).map(r=>r.text).join('');
test('截图中的六个范围完整变为可点击按钮，起点秒数正确',()=>{
  const html=markdown(screenshot);
  assert.equal((html.match(/data-action="cite"/g)||[]).length,6);
  for(const seconds of [578,648,699,762,803,916])assert(html.includes(`data-time="${seconds}"`));
  assert(html.includes('>9:38–10:45</button>'));assert(html.includes('尾文完整标记'));
});
test('范围分隔符、空格、相邻单点与小时范围共用校验',()=>{
  for(const dash of ['-','–','—','~','～','至','到']){
    assert.deepEqual(parseTimeCitation(`[ 9:38 ${dash} 10:45 ]`),{seconds:578,endSeconds:645});
    assert.equal([...timeCitations(`[ 9:38 ${dash} 10:45 ]`)].length,1);
  }
  assert.deepEqual(parseTimeCitation('1:02:03–1:04:05'),{seconds:3723,endSeconds:3845});
  assert.deepEqual([...timeCitations('[0:00][9:38–10:45][1:02:03–1:04:05]')].map(m=>m.seconds),[0,578,3723]);
  for(const invalid of ['9:99','1:60:00','10:45–9:38','9:38–10:99','9:38–1:60:00','9:38–','22','[9:38]说明'])assert.equal(parseTimeCitation(invalid),null,invalid);
});
test('截图范围在图文布局中全部隐藏，底稿不变且末尾完整',()=>{
  const a={...newArticle({title:'临时验证'},{text:screenshot}),paper:'plain'},before=JSON.stringify(a);
  const layout=layoutArticle(a,(s,f)=>Array.from(s).length*Number(f.match(/(\d+)px/)[1]));
  const output=layout.pages.flatMap(p=>p.commands).flatMap(c=>c.runs||[]).map(r=>r.text).join('');
  assert(!/\d+:\d+/.test(output));assert(output.endsWith('尾文完整标记'));assert.equal(JSON.stringify(a),before);
});
test('纯范围段落及列表不留空项，标题/引用/表格/纯时间链接全部过滤',()=>{
  const body='## 标题 [9:38–10:45]\n\n[10:48–11:20][11:39–12:05]\n\n- [12:42–13:20]\n- 保留正文 [13:23–13:59]\n\n> 引用 [15:16–15:52]\n\n|内容|时间|\n|---|---|\n|文字|[9:38–10:45]|\n\n[**9:38–10:45**](https://example.com) [[1:02:03–1:04:05]](https://example.com)\n\n尾文';
  const blocks=articleBlocks(body);
  assert.deepEqual(blocks.map(b=>text([b])),['标题','• 保留正文','引用','内容：文字； 时间：','尾文']);
});
test('正常时间叙述、无效范围、普通链接及代码保持原样',()=>{
  const body='会议在 9:38–10:45 进行。[10:45–9:38] [9:38–10:99] [资料](https://example.com)\n\n`[9:38–10:45]`\n\n```txt\n[9:38–10:45]\n```';
  const html=markdown(body),output=text(articleBlocks(body));
  assert(!html.includes('data-action="cite"'));
  for(const value of ['会议在 9:38–10:45 进行。','[10:45–9:38]','[9:38–10:99]','资料','[9:38–10:45]'])assert(output.includes(value),value);
  assert.equal((output.match(/\[9:38–10:45\]/g)||[]).length,2);
});
test('阅读外链保持原生链接，无嵌套按钮；截图推荐使用范围起点',()=>{
  const body='第一处依据。[9:38–10:45]\n\n第二处 [10:48–11:20](https://example.com)';
  const html=markdown(body);assert.equal((html.match(/data-action="cite"/g)||[]).length,1);assert(html.includes('>10:48–11:20</a>'));
  assert.deepEqual(recommendFrames(body).map(r=>r.seconds),[578,648]);
});
