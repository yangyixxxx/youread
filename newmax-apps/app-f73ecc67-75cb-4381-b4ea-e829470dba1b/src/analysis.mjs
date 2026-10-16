import {transcriptText, splitTranscript, summaryPrompt, mergePrompt} from './core.mjs';

export const ANALYSIS_TIMEOUT_MS = 900000;
export function isContextLimitError(message = '') {
  return /context[_\s-]*(length|window|limit)|maximum context|too many tokens|prompt.{0,30}too long|input.{0,30}(too long|token limit)|上下文.{0,12}(超|限)|输入.{0,12}(超长|过长|超出|超限)/i.test(message);
}
export function compatibilityPlan(segments, parts = []) {
  const chunks = splitTranscript(segments);
  const completed = chunks.filter((_, i) => Boolean(parts[i])).length;
  return {chunks, completed, remaining:chunks.length-completed+(chunks.length>1?1:0)};
}

// 全文与兼容模式明确分开：任何错误都不自动重试或切换模式。
export async function generateAnalysis({title, segments, mode = 'full', parts = [], request, onProgress = () => {}, onPart = async () => {}}) {
  if (!segments?.length) throw new Error('没有可解析的文稿。');
  if (mode === 'full') {
    onProgress('正在全文解析 · 1 次请求 · 流式返回');
    return request(summaryPrompt(title, transcriptText(segments), 0, 1));
  }
  if (mode !== 'chunks') throw new Error('未知的解析方式。');
  const {chunks} = compatibilityPlan(segments, parts);
  if (chunks.length > 30) throw new Error('兼容模式最多支持 30 个分段，请使用支持长文的模型进行全文解析。');
  const saved = parts.slice(0, chunks.length);
  let last;
  for (let i=0; i<chunks.length; i++) {
    if (saved[i]) continue;
    onProgress(`正在兼容解析 ${i+1} / ${chunks.length} · 已完成分段会保存`);
    last = await request(summaryPrompt(title, chunks[i], i, chunks.length));
    saved[i] = last.text;
    await onPart(i, last.text);
  }
  if (chunks.length === 1) return last || {ok:true, text:saved[0]};
  onProgress('正在汇总完整分段解析');
  return request(mergePrompt(title, saved));
}
