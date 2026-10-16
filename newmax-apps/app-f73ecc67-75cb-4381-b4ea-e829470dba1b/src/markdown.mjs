import MarkdownIt from './vendor/markdown-it.mjs';

// 仅负责展示：不改变保存正文，不执行 HTML，不加载远程图片。
const md = new MarkdownIt({html:false,breaks:false,linkify:false,typographer:false});
const esc = md.utils.escapeHtml;

// 仅扩展中文双星号强调：容忍结束前空格、标点后紧接正文。
// 在 inline 阶段处理，代码、转义和链接地址由原解析器跳过；不改源文。
md.inline.ruler.before('emphasis','cjk_strong',(state,silent) => {
  if (silent) return false;
  const start = state.pos;
  const src = state.src;
  if (src.slice(start,start+2) !== '**' || src[start-1] === '*' || src[start+2] === '*' || /\s/.test(src[start+2] || ' ')) return false;
  let end = -1;
  state.pos = start + 2;
  while (state.pos < state.posMax) {
    if (src[state.pos] === '\n') break;
    if (src.slice(state.pos,state.pos+2) === '**') {
      if (src[state.pos+2] !== '*') end = state.pos;
      break;
    }
    state.md.inline.skipToken(state);
  }
  state.pos = start;
  if (end < 0) return false;
  const content = src.slice(start+2,end);
  // 不跨行猜测、不改变普通英文强调规则，也不接管已经合法的双星号。
  if (!/\p{Script=Han}/u.test(content) || /[\r\n]/.test(content)) return false;
  state.pos = end;
  const closesNormally = state.scanDelims(end,true).can_close;
  state.pos = start;
  if (closesNormally) return false;
  if (!/[\p{P}\t  　]$/u.test(content)) return false;
  const children = [];
  state.md.inline.parse(content,state.md,state.env,children);
  const open = state.push('strong_open','strong',1); open.markup = '**';
  for (const child of children) { child.level += state.level; state.tokens.push(child); }
  const close = state.push('strong_close','strong',-1); close.markup = '**';
  state.pos = end + 2;
  return true;
});
md.validateLink = value => {
  try {
    if (!/^https?:\/\//i.test(value) || /[\u0000- \u007f]/.test(value)) return false;
    const url = new URL(value);
    return ['http:','https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
};
md.renderer.rules.link_open = (tokens,index,options,env,self) => {
  tokens[index].attrSet('target','_blank');
  tokens[index].attrSet('rel','noopener noreferrer');
  return self.renderToken(tokens,index,options);
};
md.renderer.rules.image = (tokens,index) => `<span class="md-image-note">［图片：${esc(tokens[index].content || '未加载')}］</span>`;
md.renderer.rules.table_open = () => '<div class="md-table-scroll" role="region" aria-label="表格，可横向滚动" tabindex="0"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';
function codeBlock(text,language='') {
  return `<div class="md-code-block"><div class="md-code-label">${esc(language || '代码')}</div><pre tabindex="0" aria-label="代码块，可横向滚动"><code>${esc(text)}</code></pre></div>\n`;
}
md.renderer.rules.fence = (tokens,index) => codeBlock(tokens[index].content,tokens[index].info.trim().split(/\s+/)[0]);
md.renderer.rules.code_block = (tokens,index) => codeBlock(tokens[index].content);

// 只转换普通正文 token：代码、HTML 标签和链接内不插入交互控件。
md.core.ruler.after('inline','time_citations',state => {
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    const output = [];
    let linkDepth = 0;
    for (const token of block.children) {
      if (token.type === 'link_open') linkDepth++;
      if (token.type === 'link_close') linkDepth--;
      if (token.type !== 'text' || linkDepth) { output.push(token); continue; }
      let at = 0;
      for (const match of token.content.matchAll(/\[((?:\d{1,3}:)?\d{1,2}:[0-5]\d)\]/g)) {
        const parts = match[1].split(':').map(Number);
        if (parts.length === 3 && parts[1] > 59) continue;
        if (match.index > at) {
          const before = new token.constructor('text','',0);
          before.content = token.content.slice(at,match.index); output.push(before);
        }
        const cite = new token.constructor('time_citation','button',0);
        cite.content = match[1]; cite.meta = {seconds:parts.reduce((a,b)=>a*60+b,0)};
        output.push(cite); at = match.index + match[0].length;
      }
      if (!at) output.push(token);
      else if (at < token.content.length) {
        const rest = new token.constructor('text','',0);
        rest.content = token.content.slice(at); output.push(rest);
      }
    }
    block.children = output;
  }
});
md.renderer.rules.time_citation = (tokens,index) => {
  const token = tokens[index];
  return `<button type="button" class="citation" data-action="cite" data-time="${token.meta.seconds}" aria-label="定位文稿 ${token.content}">${token.content}</button>`;
};

// 图文排版只读取语义 token，与阅读区共用安全/中文强调规则。
export function markdownTokens(text) { return md.parse(String(text ?? ''), {}); }

export function markdown(text) {
  return md.render(String(text ?? ''));
}
