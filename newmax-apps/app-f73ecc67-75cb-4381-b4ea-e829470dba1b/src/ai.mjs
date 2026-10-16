// 自动模式不设置应用固定输出上限；真实预算由新版宿主与服务协议协商。
export const DEFAULT_OUTPUT_TOKENS = 'auto';
export const DEFAULT_TIMEOUT_MS = 900000;
export function outputTokens(value) {
  if (value === 'auto' || value == null || value === '') return 'auto';
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 'auto';
}
export function outputLabel(value) {
  const n = outputTokens(value);
  return n === 'auto' ? '自动预算（无应用固定上限）' : `${n.toLocaleString()} tokens（自定义）`;
}
export function waitTimeout(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 5000 && n <= 2147483647 ? n : DEFAULT_TIMEOUT_MS;
}
export function supportsBudget(ai) {
  return ai?.capabilities?.outputBudget === 'auto-v1' && ai?.capabilities?.completionMetadata === true;
}
export function resultMetadata(result = {}) {
  return {finishReason:result.finishReason ?? null, termination:result.termination || 'unknown', truncated:result.truncated ?? null,
    usage:result.usage || null, outputBudget:result.outputBudget || null, timeoutMs:result.timeoutMs || null};
}
export function aiErrorMessage(error, args = {}) {
  const raw = typeof error === 'string' ? error : error?.message || '模型请求失败，请检查配置。';
  const empty = /SSE 流中未拼出任何文本|No text could be reconstructed|模型未返回有效内容|empty response/i.test(raw);
  const context = `模型：${args.model || 'NewMax 默认模型'}；${outputLabel(args.maxTokens)}。`;
  return empty
    ? `模型响应未包含可用正文。${context}请结合服务端的结束原因诊断；仅凭空正文无法确定原因。原始错误：${raw}`
    : `${raw}（${context}）`;
}
export class AIResponseError extends Error {
  constructor(message, result) { super(message); this.name='AIResponseError'; this.result=result; }
}
export async function requestAIStream(ai, prompt, args = {}, onText = () => {}) {
  if (!supportsBudget(ai)) throw new Error('请更新并重启 NewMax，当前进程不支持自动预算与真实结束状态；本次未发送请求。');
  if (!['stream','onStreamDelta','onStreamDone'].every(k => typeof ai[k] === 'function')) {
    throw new Error('当前宿主没有完整流式接口，请更新并重启 NewMax；本次未发送请求，也不会自动改用非流式重试。');
  }
  const options = {...args, maxTokens:outputTokens(args.maxTokens), timeoutMs:waitTimeout(args.timeoutMs)};
  const streamId = `yingdu-${globalThis.crypto.randomUUID()}`;
  let text = '', settled = false;
  const unsubscribers = [];
  const result = await new Promise(resolve => {
    const finish = value => {
      if (settled) return;
      settled = true;
      for (const off of unsubscribers) { try { off(); } catch {} }
      const returned = typeof value?.text === 'string' ? value.text : '';
      // 最终事件可能只有状态；保留已经收到的正文。若明确回传更短正文，不能静默丢尾部或视为完成。
      const shorter = returned && text.length > returned.length && text.startsWith(returned);
      resolve({...value, ...(shorter ? {ok:false,termination:'unknown',truncated:null,error:'流式正文与结束结果不一致，已保留较完整正文。'} : {}), text:shorter || !returned ? text : returned});
    };
    try {
      unsubscribers.push(ai.onStreamDelta(event => {
        if (settled || event?.streamId !== streamId || typeof event.delta !== 'string' || !event.delta) return;
        text += event.delta;
        onText(text);
      }));
      unsubscribers.push(ai.onStreamDone(event => { if (event?.streamId === streamId) finish(event); }));
      // 宿主的Promise也返回最终结果，覆盖请求校验失败或done事件未送达，不发送第二次请求。
      Promise.resolve(ai.stream({prompt, ...options, streamId})).then(finish, error => finish({ok:false,termination:'error',error:error?.message || String(error)}));
    } catch (error) {
      finish({ok:false,termination:'error',error:error?.message || String(error)});
    }
  });
  return validateResult(result, options);
}

export async function requestAI(ai, prompt, args = {}) {
  // 必须在请求前拦截旧宿主，旧接口会把 auto 当成无效数并降到 1024。
  if (!supportsBudget(ai)) throw new Error('NewMax 当前进程尚未支持自动输出预算与结束状态。请在宿主更新构建后重启 NewMax，再重新打开映读；本次未发送模型请求。');
  const options = {...args, maxTokens:outputTokens(args.maxTokens), timeoutMs:waitTimeout(args.timeoutMs)};
  let result;
  try { result = await ai.chat({prompt, ...options}); }
  catch (error) { throw new AIResponseError(aiErrorMessage(error, options)); }
  return validateResult(result, options);
}
function validateResult(result, options) {
  const text = typeof result?.text === 'string' ? result.text : '';
  if (result?.ok && text.trim() && result.termination === 'stop' && result.truncated === false) return result;
  const reason = result?.termination === 'length' || result?.truncated === true ? '达到模型或服务输出边界，生成尚未完成。'
    : result?.termination === 'timeout' ? '等待超时，生成尚未确认完成。'
    : result?.termination === 'unknown' || (text && !result?.termination) ? '未收到可确认的正常结束状态，不能视为完整结果。'
    : '';
  const message = [reason, result?.error || (!text.trim() ? '模型未返回有效内容' : '')].filter(Boolean).join(' ');
  throw new AIResponseError(aiErrorMessage(message || '生成尚未确认完成。', options), {...result, text});
}
