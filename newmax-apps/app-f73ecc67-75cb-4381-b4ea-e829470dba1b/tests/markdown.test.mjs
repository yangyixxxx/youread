import test from 'node:test';
import assert from 'node:assert/strict';
import {markdown} from '../src/core.mjs';

test('标题、段落、强调和分隔线使用 Markdown 语义',()=>{
  const html=markdown('# 一级\n\n## 二级\n\n### 三级\n\n正文第一行\n续行\n\n**重点**、*斜体*、~~删除~~和 `inline`\n\n---');
  for(const tag of ['h1','h2','h3','strong','em','s','code','hr'])assert(html.includes('<'+tag));
  assert(html.includes('<p>正文第一行\n续行</p>'));
});
test('有序、无序与嵌套列表不是伪段落',()=>{
  const html=markdown('1. 第一项\n   - 子项甲\n   - 子项乙\n2. 第二项');
  assert(html.includes('<ol>'));assert(html.includes('<ul>'));assert.equal((html.match(/<li>/g)||[]).length,4);
});
test('引用、对齐表格、代码块有独立的可访问滚动容器',()=>{
  const html=markdown('> 引用 **原话**\n\n| 方法 | 效果 |\n| :--- | ---: |\n| 回忆 | 可靠 |\n\n```js\nconst sample = "<script>[0:30]</script>";\n```');
  assert(html.includes('<blockquote>'));assert(html.includes('<table>'));assert(html.includes('text-align:right'));assert(html.includes('aria-label="表格，可横向滚动" tabindex="0"'));assert(html.includes('<pre tabindex="0"'));
  assert(html.includes('&lt;script&gt;[0:30]&lt;/script&gt;'));assert(!html.includes('data-action="cite"'));
});
test('正文和表格的时间戳仍可跳转，链接和行内代码不嵌按钮',()=>{
  const html=markdown('**[1:23]** [1:02:03] [99:99] `[0:30]` [观看 [0:30]](https://example.com)\n\n| 时间 |\n| --- |\n| [0:30] |');
  assert.equal((html.match(/data-action="cite"/g)||[]).length,3);
  for(const n of [83,3723,30])assert(html.includes(`data-time="${n}"`));
  assert(html.includes('<code>[0:30]</code>'));assert(html.includes('>观看 [0:30]</a>'));assert(html.includes('[99:99]'));
});
test('原始 HTML、脚本与事件属性均作为文字，不执行',()=>{
  const html=markdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n<svg onload=alert(3)></svg>\n\n<iframe src="https://evil.test"></iframe>');
  assert(!/<(?:script|img|svg|iframe)[\s>]/i.test(html));assert(html.includes('&lt;script&gt;'));assert(html.includes('&lt;img'));
});
test('只允许 HTTP(S) 外链且禁止新窗口获得 opener',()=>{
  const html=markdown('[安全](https://example.com/?x=1&y=2)\n\n[脚本](javascript:alert(1))\n\n[混淆](jav&#x61;script:alert(1))\n\n[文件](file:///C:/test)\n\n[邮件](mailto:private@example.com)\n\n[相对](//evil.test)');
  assert.equal((html.match(/<a /g)||[]).length,1);assert(html.includes('target="_blank"'));assert(html.includes('rel="noopener noreferrer"'));assert(html.includes('href="https://example.com/?x=1&amp;y=2"'));
});
test('图片只显示说明，不发出远程资源请求',()=>{
  const html=markdown('![示意图](https://example.com/tracker.png)');
  assert(!html.includes('<img'));assert(!html.includes('src='));assert(html.includes('［图片：示意图］'));
});
test('恶意围栏语言和代码中 Markdown 不转成 HTML',()=>{
  const html=markdown('```"><img/src=x/onerror=alert(1)>\n**不是强调**\n[0:30]\n```');
  assert(!html.includes('<img'));assert(!html.includes('<strong>'));assert(!html.includes('data-time'));assert(html.includes('**不是强调**'));
});
test('长 Markdown 没有显示长度截断且保持源字符串不变',()=>{
  const text='# 完整笔记\n\n'+Array.from({length:4000},(_,i)=>`- 观点${i}：完整正文。`).join('\n')+'\n\n最后一段标识';
  const copy=text;const html=markdown(text);assert.equal(text,copy);assert.equal((html.match(/<li>/g)||[]).length,4000);assert(html.includes('最后一段标识'));
});
test('截图八条中文问题的标点与结束空格正确加粗',()=>{
  const questions = [
    ['收入究竟是什么口径？ ','2200万美元对应多长时间？'],
    ['转型成功有多少依赖已有积累？ ','已有高价服务受众。'],
    ['直接结账实验是否公平可比？','两组是否具有相同的流量来源？'],
    ['如何判断瓶颈真的是流量？','如果问题其实是需求不足。'],
    ['广告扩张的停止条件是什么？ ','获客成本上升时怎样停止？'],
    ['“快速制作”如何保证客户结果？ ','有没有完成率、实际效果？'],
    ['高频内容与邮件是否损害长期关系？','除了退订率，还监测什么？'],
    ['“每周工作两天”如何统计？ ','是否包含清晨写作？']
  ];
  const source = questions.map(([q,body],i)=>`${i+1}. **${q}**${body}`).join('\n');
  const html = markdown(source);
  assert.equal((html.match(/<strong>/g)||[]).length,8);
  assert.equal((html.match(/<li>/g)||[]).length,8);
  for (const [q,body] of questions) assert(html.includes(`<strong>${q}</strong>${body}`));
  assert(!html.includes('**'));
  assert(source.includes('**收入究竟是什么口径？ **'));
});
test('中文粗体兼容不碰代码、转义星号、链接地址和未闭合标记',()=>{
  const html = markdown('`**问题？ **正文`\n\n```md\n**问题？**正文\n```\n\n\\*\\*问题？\\*\\*正文\n\n[链接](https://example.com/**问题？**正文)\n\n**问题？\n\n**English? **body\n\n***中文问题？***正文');
  assert(html.includes('<code>**问题？ **正文</code>'));
  assert(!html.includes('<strong>'));
  assert(html.includes('**问题？**正文'));
  assert(html.includes('href="https://example.com/'));
  assert(html.includes('**English? **body'));
});
test('兼容强调中的代码、斜体、链接与时间引用仍保持各自语义',()=>{
  const html=markdown('**中文 `**代码**` 与 *斜体* [链接](https://example.com/a**b) [0:30]？ **后文');
  assert(html.includes('<strong>中文 <code>**代码**</code> 与 <em>斜体</em>'));
  assert(html.includes('href="https://example.com/a**b"'));
  assert(html.includes('data-time="30"'));
  assert(html.includes('？ </strong>后文'));
});
test('流式闭合后原位加粗，不跨段落错误配对或吞掉尾文',()=>{
  for(const tail of ['', '*'])assert(!markdown('**中文问题？ '+tail).includes('<strong>'));
  assert(markdown('**中文问题？ **后文').includes('<strong>中文问题？ </strong>后文'));
  assert(!markdown('**中文问题？\n下一行 **正文').includes('<strong>'));
  assert(!markdown('**中文问题？\n\n另一段 **正文').includes('<strong>'));
  assert(markdown('**正常** 与 **问题？**后文 **其他**。').includes('<strong>问题？</strong>后文'));
});
test('中文兼容仍转义HTML且不加载图片',()=>{
  const html=markdown('**中文 <script>alert(1)</script> ![图片](https://example.com/a.png)？ **后文');
  assert(html.includes('<strong>'));assert(html.includes('&lt;script&gt;'));
  assert(!/<(?:script|img)\b/.test(html));assert(html.includes('［图片：图片］'));
});

test('不完整草稿、空值、未闭合代码围栏仍可显示',()=>{
  assert.equal(markdown(null),'');assert.equal(markdown(''),'');assert(markdown('### 10. 她').includes('<h3>10. 她</h3>'));
  assert(markdown('```text\n未完成正文').includes('未完成正文'));
});
