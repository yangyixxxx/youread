import {escapeHTML as esc,formatTime,normalizeChannel,videoURL,parseTranscript,transcriptText,chatPrompt,filterVideos,markdown} from './core.mjs';
import {ANALYSIS_TIMEOUT_MS,compatibilityPlan,generateAnalysis,isContextLimitError} from './analysis.mjs';
import {defaultSelection,firstChannelVideo} from './selection.mjs';
import {openEditorial} from './editorial-ui.mjs';
import {channelAvatar,bindAvatarFallback} from './channel-avatar.mjs';

import {outputTokens,outputLabel,waitTimeout,supportsBudget,resultMetadata,requestAIStream} from './ai.mjs';

// 不继续沿用早期版本写入的 4000/8000；保留旧字段，仅新设置 outputBudget 生效。
function selectedBudget(){return outputTokens(state.outputBudget?.maxTokens);}
function selectedTimeout(){return waitTimeout(state.outputBudget?.timeoutMs);}
let runtimeCapabilities=null;
function runtimeNotice(){return supportsBudget({capabilities:runtimeCapabilities})?'':'<div class="notice error" role="status">NewMax 当前进程尚未加载新版输出接口。请在更新构建后重启 NewMax，再重新打开映读。为避免旧接口偷偷降到 1024，本版本不会向旧宿主提交 AI 请求；已有资料仍可阅读。</div>';}
function budgetInfo(meta){const b=meta?.outputBudget;if(!b)return '';return `<div class="analysis-footer">实际请求预算：${b.maxTokens==null?'服务默认（数值未知）':esc(String(b.maxTokens))+' tokens'}${b.contextWindow?' · 配置上下文 '+esc(String(b.contextWindow))+' tokens':''}${b.inputTokens!=null?' · 输入计数 '+esc(String(b.inputTokens)):''}${b.limitation?'<br>'+esc(b.limitation):''}</div>`;}
function completionNotice(r){return r.analysis&&!r.analysisCompletion?'<div class="notice" role="status">旧解析 · 完整性未确认：历史接口未保存结束原因，不能保证这篇解析已经写完。原文完整保留；重新生成需你明确点击。</div>':budgetInfo(r.analysisCompletion);}
function attemptView(attempt){
  if(!attempt)return '';
  return `<section class="incomplete-output" aria-label="未完成草稿"><div class="notice error" role="status"><strong>未完成草稿${attempt.text?' · 已保留收到的正文':' · 本次没有可用正文'}</strong><p>${esc(attempt.error||'生成未确认完成。')} 不自动重试，手动重试可能产生费用。</p><details class="attempt-details"><summary>生成详情</summary><p>${esc(attempt.stage||'本次生成')} · 结束原因：${esc(attempt.finishReason||attempt.termination||'未知')} · ${clockDate(attempt.at)}</p>${budgetInfo(attempt)}</details><button class="inline-link" data-action="settings">调整模型 / 输出额度</button></div>${attempt.text?`<div class="prose">${markdown(attempt.text)}</div>`:''}</section>`;
}
function previousAnalysisView(r){
  if(!r.analysis)return '';
  return `<details class="analysis-backup"><summary>查看上次解析（本次成功后替换）</summary>${completionNotice(r)}<div class="prose">${markdown(r.analysis)}</div></details>`;
}

const sdk = window.newmaxApp;
const $ = s => document.querySelector(s);
const DATA_KEY = 'yingdu.workspace.v1';
const failedAvatars=new Set();
bindAvatarFallback($('#channel-list'),failedAvatars);
const emptyLibrary = () => ({channels:[],videos:[],settings:{intervalMinutes:30,autoCaptions:true},lastSync:null});
let library = emptyLibrary();
let state = {records:{},imports:[],model:'',selectedId:null};
const view = {filter:'all',channel:null,query:'',tab:'overview',transcriptQuery:'',selected:null,online:false,connecting:true,librarySignature:'',transcriptLoading:false,transcriptError:'',activeAI:null,aiProgress:'',aiError:'',chatDrafts:{},syncBusy:false};
let connection = null, models = [], saveQueue = Promise.resolve(), ready = false, pollBusy = false, toastTimer, connectionError = '', storeBroken = false;
const transcriptCache = new Map();
let pendingSelection = 'startup';
// 只补全尚未完成的默认选择；手动导航后不由后台刷新重选。
function applyPendingSelection(){
  if(!pendingSelection)return false;
  const next=pendingSelection==='startup'
    ?defaultSelection(library.channels,allVideos(),state.selectedId)
    :{channel:view.channel,selected:firstChannelVideo(allVideos(),view.channel)};
  const changed=view.channel!==next.channel||view.selected!==next.selected;
  view.channel=next.channel;view.selected=next.selected;
  if(next.channel&&next.selected)pendingSelection=null;
  if(changed){view.tab='overview';view.transcriptQuery='';view.transcriptLoading=false;view.transcriptError='';view.aiError='';$('.workspace').classList.toggle('show-reader',!!next.selected);}
  return changed;
}
const icons = {
  library:'▤',unread:'◷',saved:'☆',book:'▥'
};
function allVideos(){return [...state.imports,...library.videos].filter((v,i,a)=>a.findIndex(x=>x.id===v.id)===i);}
function selectedVideo(){return allVideos().find(v=>v.id===view.selected);}
function record(id){return state.records[id] ||= {read:false,favorite:false,messages:[],analysis:'',summaryParts:[]};}
function currentTranscript(id=view.selected){return transcriptCache.get(id) || null;}
function textCount(t){return t?.segments?.reduce((n,s)=>n+s.text.length,0)||0;}
function shortDate(value){if(!value)return '日期未提供';const d=new Date(value);return Number.isNaN(d.valueOf())?'日期未提供':d.toLocaleDateString('zh-CN',{month:'short',day:'numeric'});}
function clockDate(value){if(!value)return '尚未同步';const d=new Date(value);return Number.isNaN(d.valueOf())?'尚未同步':d.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});}
function toast(message){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,4400);}
function globalError(message){$('#global-error').textContent=message;$('#global-error').hidden=!message;}
async function persist(){
  if(storeBroken)throw new Error('本地资料读取失败，暂时禁止写入以保护原数据。请重新打开应用。');
  const snapshot=JSON.parse(JSON.stringify(state));
  const task=saveQueue.catch(()=>{}).then(()=>sdk.data.set(DATA_KEY,snapshot));
  saveQueue=task;
  try{await task;globalError('');}catch(e){globalError('本地保存失败，当前改动尚未保存。请保留此窗口并检查应用数据权限。');throw new Error('本地保存失败，请稍后重试。');}
}
function safeImage(url){try{const u=new URL(url);return u.protocol==='https:'&&/(^|\.)ytimg\.com$/.test(u.hostname)?esc(u.href):'';}catch{return '';}}
function statusTag(v){
  const r=state.records[v.id];if(r?.analysisAttempt)return '<span class="tag error">解析未完成</span>';if(r?.analysis)return `<span class="tag ai">✦ ${r.analysisCompletion?'已解析':'已有笔记 · 待核验'}</span>`;
  if(transcriptCache.has(v.id)||v.transcriptStatus==='ready')return '<span class="tag ready">文稿就绪</span>';
  if(['fetching','pending'].includes(v.transcriptStatus))return '<span class="tag">获取字幕中</span>';
  if(['error','unavailable'].includes(v.transcriptStatus))return '<span class="tag error">字幕待处理</span>';
  return '<span class="tag">待获取字幕</span>';
}
function connectorStatusHTML(){
  if(view.connecting)return '正在连接本地服务…<br>已保存的文稿与笔记仍可阅读。';
  if(view.online)return `${view.background?'● 本地连接器后台运行中，无需保留终端。':'● 本地连接器在线（诊断运行模式）。'}<br>关闭映读不会停止检查；可在下方停止后台更新。`;
  return '○ 本地连接器未连接，本地文稿仍可阅读。<br>请稍等自动连接，或运行静默启动脚本。若仍离线，请查看 connector/background.log。';
}
function updateConnectorStatus(){
  const status=$('#connector-settings-status');if(!status)return;
  status.className=`notice ${view.online||view.connecting?'':'error'}`;
  status.innerHTML=connectorStatusHTML();
  const stop=$('[data-action="stop-connector"]');if(stop)stop.disabled=!view.online||view.connecting;
  for(const id of ['#sync-interval','#auto-captions']){const el=$(id);if(el)el.disabled=!view.online;}
}
function renderNavigation(){
  const videos=allVideos();
  const opts=[['all','全部视频',videos.length],['unread','稍后阅读',videos.filter(v=>!state.records[v.id]?.read).length],['saved','我的收藏',videos.filter(v=>state.records[v.id]?.favorite).length]];
  $('#library-nav').innerHTML=opts.map(([id,title,n])=>`<button class="nav-item ${view.filter===id&&!view.channel?'active':''}" data-action="filter" data-value="${id}"><span class="nav-symbol">${icons[id==='all'?'library':id]}</span><span>${title}</span><span class="count">${n}</span></button>`).join('');
  $('#channel-list').innerHTML=library.channels.length?library.channels.map(c=>`<button class="channel-item ${view.channel===c.id?'active':''}" data-action="channel" data-id="${esc(c.id)}" title="${esc(c.title)}">${channelAvatar(c,failedAvatars)}<span class="channel-name">${esc(c.title)}</span><span class="status-dot ${c.status==='error'?'error':''}" title="${esc(c.status==='error'?'同步失败':c.status==='ready'?'已订阅':'同步中')}"></span></button>`).join(''):'<p class="sidebar-empty">还没有订阅频道<br>添加你想持续阅读的创作者</p>';
  $('#connector-indicator').innerHTML=`<span class="status-dot ${view.online?'':'offline'}"></span>${view.connecting?'正在连接…':view.online?'本地连接器在线':'连接器离线'}<small>设置 ↗</small>`;
  updateConnectorStatus();
}
function renderList(){
  const channel=library.channels.find(c=>c.id===view.channel);
  if(view.channel&&!channel)view.channel=null;
  const title=channel?.title||({all:'全部视频',unread:'稍后阅读',saved:'我的收藏'}[view.filter]);
  const videos=filterVideos(allVideos(),state.records,view.filter,view.channel,view.query);
  $('#list-title').innerHTML=`${esc(title)} <span id="list-count">${videos.length}</span>`;
  $('#list-meta').innerHTML=`<span>${view.query?'搜索结果':view.channel?'此频道的近期视频':'按发现时间排列'}</span><span>${videos.filter(v=>!state.records[v.id]?.read).length} 个未读</span>`;
  $('#sync-button').disabled=!view.online||view.syncBusy||!library.channels.length;
  $('#sync-button').innerHTML=view.syncBusy?'<span class="spin">↻</span>':'↻';
  if(!videos.length){
    const hasAny=allVideos().length>0;
    $('#video-list').innerHTML=`<div class="list-empty"><div class="empty-circle">${view.filter==='saved'?'☆':'▤'}</div><h3>${view.query?'没有找到相关视频':hasAny?'这里暂时没有视频':library.channels.length?'正在等候频道内容':'订阅你的第一个频道'}</h3><p>${view.query?'试试其他关键词，或清空当前筛选。':hasAny?'试试切换频道或返回全部视频。':library.channels.length?'连接器将检查近期视频。同步失败时可在频道管理中查看原因。':'把喜欢的创作者放在这里，更新的视频会成为你的下一份阅读材料。'}</p>${hasAny||view.query?'<button class="button subtle" data-action="clear-filters">查看全部视频</button>':library.channels.length?'<button class="button subtle" data-action="channels">查看同步状态</button>':'<button class="button subtle" data-action="add-channel">＋ 订阅频道</button>'}</div>`;
  }else $('#video-list').innerHTML=videos.map(v=>{
    const r=state.records[v.id]||{};const img=safeImage(v.thumbnail);
    return `<button class="video-item ${view.selected===v.id?'selected':''}" data-action="select-video" data-id="${esc(v.id)}" aria-pressed="${view.selected===v.id}"><div class="video-row"><div class="video-thumb">${img?`<img src="${img}" alt="" loading="lazy" referrerpolicy="no-referrer">`:'▤'}${v.duration?`<span class="duration">${formatTime(v.duration)}</span>`:''}</div><div class="video-info"><h3>${esc(v.title)}</h3><div class="video-byline"><span>${esc(v.channelTitle||'本地文稿')}</span>${r.favorite?'<span>★</span>':''}</div></div></div><div class="video-item-bottom">${statusTag(v)}<span>${r.read?'已读':'● 未读'}</span><span class="time-ago">${v.local?'本地导入':shortDate(v.publishedAt)}</span></div></button>`;
  }).join('');
  $('#list-footer').textContent=view.online?`每 ${library.settings.intervalMinutes} 分钟检查 · ${library.lastSync?'上次 '+clockDate(library.lastSync):'尚未同步'}`:'本地文稿可继续阅读 · 连接器离线';
}
const bookArt=`<svg class="welcome-art" viewBox="0 0 220 155" fill="none" aria-hidden="true"><ellipse cx="109" cy="134" rx="91" ry="8" fill="#e9eddf"/><path d="M40 44Q78 32 109 48V128Q75 112 40 122Z" fill="#f3f4e9" stroke="#a9b89a" stroke-width="1.3"/><path d="M109 48Q143 30 181 42V120Q146 112 109 128Z" fill="#fffefa" stroke="#a9b89a" stroke-width="1.3"/><path d="M109 53V127" stroke="#a9b89a"/><path d="M49 58Q76 49 97 57M49 68Q76 59 97 67M49 78Q76 69 87 74M121 61Q146 51 170 57M121 71Q146 61 170 67M121 81Q144 72 162 76M121 91Q144 82 161 86" stroke="#ced7bf" stroke-width="3" stroke-linecap="round"/><rect x="61" y="84" width="31" height="22" rx="4" fill="#dbe5cb"/><path d="M73 90L82 96L73 101Z" fill="#91a776"/><path d="M156 31V53L163 47L170 50V30" fill="#c1cfae"/><path d="M190 63l3-8 3 8 8 3-8 3-3 8-3-8-8-3 8-3Z" fill="#c6d2b5"/><circle cx="37" cy="85" r="3" fill="#c2cfb0"/><path d="M48 29l3-6 3 6 6 3-6 3-3 6-3-6-6-3 6-3Z" fill="#dbdcc6"/></svg>`;
function welcome(){return `<div class="reader-welcome">${bookArt}<span class="welcome-kicker">WATCH LESS. UNDERSTAND MORE.</span><h2>把视频，读成自己的知识。</h2><p class="welcome-description">让字幕成为文稿，让观点清晰可见。<br>从一个频道开始，用阅读和对话深入理解。</p><div class="welcome-actions"><button class="button primary" data-action="add-channel">＋ 订阅一个频道</button><button class="button quiet" data-action="import-new">或导入文稿 ↗</button></div><div class="steps"><div class="step"><div class="step-number">01 / COLLECT</div><strong>订阅感兴趣的频道</strong>在本机检查视频更新</div><div class="step"><div class="step-number">02 / READ</div><strong>从字幕到核心观点</strong>带时间戳的文稿解析</div><div class="step"><div class="step-number">03 / THINK</div><strong>用对话深入理解</strong>追问，让知识真正留下</div></div></div><div class="welcome-bottom">本地资料库 <span> · </span> 由你选择的 AI 模型辅助阅读</div>`;}
function readerHeader(v){
  const r=record(v.id),t=currentTranscript(v.id);
  return `<div class="reader-head"><div class="reader-topline"><div class="reader-breadcrumb"><button class="button quiet reader-back" data-action="back">‹ 视频列表</button>${esc(v.channelTitle||'本地文稿')} <span> / </span> 视频精读</div><div class="reader-actions"><button class="button quiet" data-action="toggle-read">${r.read?'✓ 已读':'◷ 标记已读'}</button><button class="button ${r.favorite?'subtle':'quiet'}" data-action="favorite" aria-pressed="${!!r.favorite}">${r.favorite?'★ 已收藏':'☆ 收藏'}</button>${v.local?`<button class="button quiet" data-action="remove-local" ${view.activeAI?.id===v.id?'disabled':''}>移除</button>`:''}</div></div><h2 class="reader-title">${esc(v.title)}</h2><div class="reader-metadata"><span>${v.local?'本地导入':shortDate(v.publishedAt)}</span>${v.duration?`<span>◷ ${formatTime(v.duration)}</span>`:''}<span>${t?`${t.segments.length} 段文稿 · ${textCount(t).toLocaleString()} 字符`:v.transcriptStatus==='ready'?'字幕已就绪':'等待文稿'}</span>${v.url?`<a href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">在 YouTube 打开 ↗</a>`:''}</div></div><div class="tabs" role="tablist" aria-label="阅读模式">${[['overview','概览解析','✦'],['transcript','视频文稿','≡'],['chat','阅读对话','◌']].map(([id,name,icon])=>`<button role="tab" aria-selected="${view.tab===id}" class="tab ${view.tab===id?'active':''}" data-action="tab" data-value="${id}">${icon} ${name}${id==='chat'&&r.messages?.length?`<small>${r.messages.length}</small>`:''}</button>`).join('')}<button class="tab editorial-entry" data-action="editorial" ${view.activeAI?.id===v.id?'disabled title="请等待当前生成结束后再排版"':''}>▧ 图文排版 ↗</button></div>`;
}
function missingTranscript(v){
  if(view.transcriptLoading)return '<div class="notice">正在读取已保存的文稿…<div class="loading-bar"><span></span></div></div>';
  const fetching=['fetching','pending'].includes(v.transcriptStatus);
  const err=view.transcriptError||v.transcriptError;
  return `<div class="analysis-empty"><div class="mini-icon">≡</div><h3>${fetching?'正在获取视频字幕':'先为这条视频准备文稿'}</h3><p>${fetching?'连接器正在检查可用的人工字幕与自动字幕。你可以先阅读其他视频，完成后这里会自动更新。':'获取 YouTube 中的可用字幕，或导入你已有的 SRT、VTT、TXT 文件。没有字幕的视频不会凭空生成内容。'}</p>${err?`<div class="notice error">${esc(err)}</div>`:''}<div class="welcome-actions" style="margin-top:12px">${!v.local?`<button class="button primary" data-action="fetch-transcript" ${!view.online||fetching?'disabled':''}>${fetching?'获取中…':'获取字幕'}</button>`:''}<button class="button" data-action="import-current">导入文稿</button></div>${!view.online&&!v.local?'<p class="privacy">连接器未启动，仍可导入本地文稿。<button class="inline-link" data-action="settings">查看连接方法</button></p>':''}</div>`;
}
function overview(v){
  const r=record(v.id),t=currentTranscript(v.id),busy=view.activeAI?.id===v.id;
  const error=view.aiError&&view.aiError.id===v.id?view.aiError.text:'';
  if(!t)return missingTranscript(v);
  const {chunks,completed,remaining}=compatibilityPlan(t.segments,r.summaryParts);
  const live=busy&&view.activeAI.type==='analysis';
  const draft=!live&&r.analysisAttempt;
  const progress=busy&&!live?'<div class="notice" role="status">阅读对话正在输出，可切换到阅读对话查看。</div>':'';
  const err=error&&(!draft?.error||!error.endsWith(draft.error))?`<div class="notice error" role="alert">${esc(error)}<br>已有解析与分段进度保留。应用不会自动重试或切换模式；失败请求与手动重试均可能产生费用。<br><button class="inline-link" data-action="settings">调整模型 / 输出额度</button></div>`:'';
  const compatibility=`<details class="notice" ${(!r.analysis&&completed)||isContextLimitError(error)?'open':''}><summary>兼容分段 · 仅在模型无法处理全文时使用${completed?`（已保存 ${completed} / ${chunks.length} 段）`:''}</summary><p>${completed?'旧分段进度已保留，全文解析不会删除它们。继续兼容任务时跳过已完成分段。':'不确定模型容量时优先尝试全文；应用不会自动切段。'}兼容任务剩余 ${remaining} 次请求${chunks.length>1?'（包含一次汇总）':''}，可能增加等待和费用。</p><button class="button quiet" data-action="analyze-chunks" ${view.activeAI?'disabled':''}>${completed?'继续已有分段':'使用兼容分段'}</button></details>`;
  const intro=`<div class="section-intro"><span>✦ AI 阅读笔记</span>${r.analysis||r.analysisAttempt?'<button class="button quiet" data-action="export-analysis">导出笔记与草稿 ↗</button>':'<span>全文优先 · 单次请求</span>'}</div>${runtimeNotice()}`;
  // 只有一个主正文位：生成中 → 未完成草稿 / 已保存解析，旧结果只在折叠区备用。
  if(live)return `${intro}<div class="analysis-output">${streamView(v,'analysis')}</div>${previousAnalysisView(r)}`;
  const actions=`<div class="welcome-actions"><button class="button subtle" data-action="tab" data-value="chat">围绕这篇文稿追问 →</button><button class="button quiet" data-action="${r.analysis?'regenerate':'analyze'}" ${view.activeAI?'disabled':''}>${r.analysis?'重新全文解析':'重新全文生成'}</button></div>`;
  if(draft?.text)return `${intro}${progress}${err}<div class="analysis-output">${attemptView(draft)}</div>${actions}${previousAnalysisView(r)}${compatibility}`;
  const failed=err+(draft?attemptView(draft):'');
  if(r.analysis)return `${intro}${progress}${failed}<div class="analysis-output">${completionNotice(r)}<div class="prose">${markdown(r.analysis)}</div></div><div class="analysis-footer">${esc(r.analysisModel||'AI')} · ${r.analysisMode==='full'?'全文单次解析':r.analysisMode==='chunks'?'兼容分段汇总':'已有解析'} · ${clockDate(r.analysisAt)} · 依据文稿生成，请结合原文核验。</div>${actions}${compatibility}`;
  return `${intro}${progress}${failed}<div class="analysis-empty"><div class="mini-icon">✦</div><h3>一次读完全文，连贯理解观点。</h3><p>将完整文稿整理成一篇连贯的精读文章：从核心问题切入，展开观点、例证与应用边界，再回到原文追问。不切段，不额外调用汇总。</p><button class="button primary" data-action="analyze" ${view.activeAI?'disabled':''}>${busy?'解析中…':'✦ 全文一次解析'}</button><p class="privacy">完整文稿 ${transcriptText(t.segments).length.toLocaleString()} 字符（含时间戳）· 1 次请求 · 最长等待 ${Math.round(selectedTimeout()/60000)} 分钟。<br>模型容量由服务商决定；输入超限时会提示，不自动切段。文稿会发送给当前模型，可能产生费用。</p></div>${compatibility}<div class="outline-preview"><div><strong>01 问题引入</strong><p>这条视频试图改变什么认识</p></div><div><strong>02 观点展开</strong><p>讲清推理、例证与关键限定</p></div><div><strong>03 应用与边界</strong><p>区分原文结论与应用推演</p></div><div><strong>04 追问与回看</strong><p>带着具体问题返回原文</p></div></div><div class="status-line">当前模型：<button class="inline-link" data-action="settings">${esc(modelLabel())}</button> · ${esc(outputLabel(selectedBudget()))}</div>`;
}
function transcriptView(v){
  const t=currentTranscript(v.id);if(!t)return missingTranscript(v);
  return `<div class="transcript-toolbar"><input id="transcript-search" type="search" aria-label="搜索当前文稿" placeholder="在文稿中查找…" value="${esc(view.transcriptQuery)}"><button class="button quiet" data-action="export-transcript">↓ 导出</button><button class="button quiet" data-action="import-current" ${view.activeAI?.id===v.id?'disabled':''}>替换文稿</button></div><div class="transcript-count" id="transcript-count"></div><div id="transcript-segments"></div>`;
}
function renderSegments(){
  const target=$('#transcript-segments');if(!target)return;
  const t=currentTranscript();if(!t)return;
  const q=view.transcriptQuery.toLowerCase();
  const rows=t.segments.map((s,i)=>({...s,i})).filter(s=>!q||s.text.toLowerCase().includes(q));
  $('#transcript-count').textContent=`${rows.length} / ${t.segments.length} 段 · ${t.source==='import'?'本地导入':t.source==='automatic'?'YouTube 自动字幕':'YouTube 人工字幕'} · ${t.language||'原文'}${t.segments[0]?.start===null?' · 无时间轴':''}`;
  target.innerHTML=rows.length?rows.map(s=>{
    let text=esc(s.text);if(q){const original=s.text;let out='',at=0;const lower=original.toLowerCase();let n;while((n=lower.indexOf(q,at))>=0){out+=esc(original.slice(at,n))+'<mark>'+esc(original.slice(n,n+q.length))+'</mark>';at=n+q.length;}text=out+esc(original.slice(at));}
    return `<div class="transcript-row" id="segment-${s.i}"><button class="timestamp" data-action="timestamp" data-time="${s.start??''}" ${s.start===null||!selectedVideo()?.url?'disabled':''} aria-label="从 ${formatTime(s.start)||'本段'} 打开原视频">${formatTime(s.start)||String(s.i+1).padStart(2,'0')}</button><p>${text}</p></div>`;
  }).join(''):'<div class="small-empty">这篇文稿中没有匹配内容，试试其他关键词。</div>';
}
function modelLabel(){if(!state.model)return '跟随 NewMax 默认模型';const m=models.find(x=>`${x.providerId}::${x.model}`===state.model);return m?`${m.providerName} / ${m.model}`:'已选模型（当前不可用）';}
function chatView(v){
  const r=record(v.id),t=currentTranscript(v.id),busy=view.activeAI?.id===v.id;
  if(!t)return `<div class="reader-content">${missingTranscript(v)}</div>`;
  const messages=r.messages||[],live=busy&&view.activeAI.type==='chat';
  const draft=!live&&r.chatAttempt;
  const history=messages.map(m=>m.role==='user'?`<div class="chat-message user">${esc(m.text)}</div>`:`<div class="chat-message assistant"><div class="message-label">✦ 阅读助手 <span>· ${esc(m.scope||'当前文稿')}</span></div><div class="prose">${markdown(m.text)}</div></div>`).join('');
  const empty=!messages.length&&!live&&!draft?`<div class="chat-empty"><div class="section-intro">READ BETWEEN THE LINES</div><h3>带着问题，读得更深。</h3><p>这里的对话只围绕当前视频。你可以澄清一个观点、追问论据，或者让助手帮你建立知识之间的联系。</p><div class="suggestions">${['这条视频最重要的三个观点是什么？','作者用了哪些例子支持观点？','这篇内容有哪些值得质疑的地方？'].map(s=>`<button data-action="suggest" data-value="${esc(s)}">${esc(s)} ↗</button>`).join('')}</div></div>`:'';
  const current=live?streamView(v,'chat'):draft?`${draft.question?`<div class="chat-message user">${esc(draft.question)}</div>`:''}<div class="chat-message assistant"><div class="message-label">✦ 阅读助手 <span>· 本次回答未完成</span></div>${attemptView(draft)}</div>`:'';
  const error=view.aiError?.id===v.id&&(!draft?.error||view.aiError.text!==draft.error)?`<div class="notice error">${esc(view.aiError.text)}<br>问题已保留，可以编辑后手动重试。应用不会自动重试；失败请求和手动重试均可能产生费用。<br><button class="inline-link" data-action="settings">调整模型 / 输出额度</button></div>`:'';
  return `<div class="chat-shell"><div class="chat-messages" id="chat-messages">${runtimeNotice()}${history}${empty}${current}${busy&&!live?'<div class="notice" role="status">解析正在输出，可切换到概览查看。</div>':''}${error}</div><div class="chat-composer"><div class="composer-box"><textarea id="chat-input" placeholder="围绕这篇文稿提问…" aria-label="向当前视频提问" ${view.activeAI?'disabled':''}>${esc(live?'':view.chatDrafts[v.id]||'')}</textarea><div class="composer-tools"><span>↵ 发送 · Shift + ↵ 换行</span><button class="button primary" data-action="send-chat" ${view.activeAI?'disabled':''}>${busy?'回答中…':'发送 ↑'}</button></div></div><div class="composer-hint"><span>完整文稿、解析与对话 · 超限时明确报错，不静默截取 · 云端请求可能产生费用</span><button class="model-button" data-action="settings">${esc(modelLabel())} ⌄</button></div></div></div>`;
}
function renderReader(){
  const v=selectedVideo();
  const old=$('.reader-content')?.scrollTop||0;
  const oldChat=$('#chat-messages'),chatTop=oldChat?.scrollTop||0;
  const followChat=!oldChat||oldChat.scrollHeight-chatTop-oldChat.clientHeight<64;
  if(!v){$('#reader').innerHTML=view.channel?'<div class="reader-welcome"><h2>这个频道暂时没有视频</h2><p class="welcome-description">近期内容同步完成后会显示在这里。<br>你也可以切换频道，或在频道管理中查看同步状态。</p><button class="button subtle" data-action="channels">查看同步状态</button></div>':welcome();return;}
  $('#reader').innerHTML=readerHeader(v)+(view.tab==='chat'?chatView(v):`<div class="reader-content">${view.tab==='overview'?overview(v):transcriptView(v)}</div>`);
  if(view.tab==='transcript')renderSegments();
  if($('.reader-content'))$('.reader-content').scrollTop=old;
  if($('#chat-messages'))$('#chat-messages').scrollTop=followChat?$('#chat-messages').scrollHeight:chatTop;
}
function render(){renderNavigation();renderList();renderReader();}
async function api(path,method='GET',body){
  if(!connection)throw new Error('连接器未连接，请先运行启动脚本。');
  const res=await fetch(connection.url+path,{method,headers:{Authorization:`Bearer ${connection.token}`,...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000),cache:'no-store'});
  const result=await res.json();if(!res.ok)throw new Error(result.error||'连接器请求失败，请检查连接状态。');return result;
}
async function connect(manual=false){
  view.connecting=true;renderNavigation();
  try{
    const raw=await sdk.files.readText('connector/connection.json');
    const cfg=JSON.parse(typeof raw==='string'?raw:raw?.content??'');
    if(!cfg||cfg.url!=='http://127.0.0.1:18743'||typeof cfg.token!=='string'||cfg.token.length<32)throw new Error('连接配置无效，请重新启动连接器。');
    connection=cfg;await refreshLibrary();connectionError='';
    if(manual)toast('本地连接器已连接');
  }catch(e){view.online=false;connectionError='无法连接本地服务。请运行 start-connector-silent.vbs 静默启动，再点击重新连接；已有资料保留。';if(manual)toast(connectionError);}
  finally{view.connecting=false;renderNavigation();renderList();if(selectedVideo()&&!currentTranscript())renderReader();}
}
async function refreshLibrary(){
  const health=await api('/health');
  if(!health.ok||!health.workerRunning)throw new Error('连接器后台检查未就绪，请检查运行日志。');
  view.background=health.background===true;
  const fresh=await api('/library');
  if(!Array.isArray(fresh.channels)||!Array.isArray(fresh.videos))throw new Error('连接器返回的数据格式不正确。');
  view.online=true;
  const signature=JSON.stringify(fresh);
  if(signature!==view.librarySignature){library=fresh;view.librarySignature=signature;const selectionChanged=applyPendingSelection();await sdk.data.set('yingdu.library-cache.v1',fresh);renderNavigation();renderList();
    if(selectionChanged)renderReader();
    const v=selectedVideo();if(v?.transcriptStatus==='ready'&&!currentTranscript(v.id))await loadTranscript(v.id);else if(v&&!currentTranscript(v.id))renderReader();
    if($('#app-dialog').open&&$('#channel-manager'))renderChannelManager();
  }
  renderNavigation();
  if(fresh.error)globalError(fresh.error);
}
async function loadTranscript(id){
  if(transcriptCache.has(id))return;
  if(view.selected===id){view.transcriptLoading=true;view.transcriptError='';renderReader();}
  try{
    let t=await sdk.data.get(`yingdu.transcript.${id}`);
    if(!t&&view.online&&library.videos.find(v=>v.id===id)?.transcriptStatus==='ready')t=await api(`/videos/${encodeURIComponent(id)}/transcript`);
    if(t?.segments?.length){transcriptCache.set(id,t);await sdk.data.set(`yingdu.transcript.${id}`,t);}
  }catch(e){if(view.selected===id)view.transcriptError='文稿读取失败，请重试或手动导入。';}
  finally{if(view.selected===id){view.transcriptLoading=false;renderReader();}}
}
async function selectVideo(id){
  pendingSelection=null;
  view.selected=id;state.selectedId=id;view.tab='overview';view.transcriptQuery='';view.aiError='';view.transcriptError='';record(id).read=true;
  $('.workspace').classList.add('show-reader');$('#sidebar').classList.remove('open');render();await persist();await loadTranscript(id);
}
function dialog(title,description,body){
  const d=$('#app-dialog');$('#dialog-body').innerHTML=`<button class="icon-button dialog-close" data-action="close-dialog" aria-label="关闭弹窗">×</button><h2 id="dialog-title">${title}</h2><p class="dialog-description">${description}</p>${body}`;
  if(!d.open)d.showModal();
}
function closeDialog(){ $('#app-dialog').close(); }
function dialogError(text){const el=$('#dialog-error');if(el)el.textContent=text;else toast(text);}
function addChannelDialog(){dialog('订阅一个频道','把持续关注的创作者加入资料库。连接器会检查近期视频，并尝试获取可用字幕。',`<form id="channel-form"><label class="field">YouTube 频道<input id="channel-url" name="channel" placeholder="@频道名 或 https://youtube.com/@…" required autofocus autocomplete="off"><small>支持 @handle、频道主页链接和 UC 频道 ID，不支持视频链接。</small></label>${!view.online?'<div class="notice error">连接器未连接。请先启动本地连接器。<button type="button" class="inline-link" data-action="settings">查看启动方法</button></div>':'<div class="notice">首次读取最多 20 条近期视频，自动尝试最新 3 条新视频的字幕。无字幕或访问受限时可手动导入。不会自动发起 AI 请求。</div>'}<div id="dialog-error" class="dialog-error" role="alert"></div><div class="dialog-actions"><button type="button" class="button" data-action="close-dialog">取消</button><button id="channel-submit" type="submit" class="button primary" ${!view.online?'disabled':''}>订阅并检查更新</button></div></form>`);}
function importDialog(current=false){
  const v=current?selectedVideo():null;
  if(v&&view.activeAI?.id===v.id){toast('请等待当前 AI 请求结束后再替换文稿。');return;}
  dialog(v?'为当前视频导入文稿':'导入一篇视频文稿',v?'替换文稿会清除旧解析与对话，避免内容错配；视频和收藏状态保留。':'没有连接器也能开始阅读。导入 SRT / VTT 字幕，或粘贴 TXT 正文。',`<form id="import-form" data-video="${v?esc(v.id):''}"><label class="field">文稿标题<input id="import-title" required maxlength="180" value="${esc(v?.title||'')}" placeholder="例如：如何建立长期学习习惯" ${v?'readonly':''}></label>${!v?'<label class="field">YouTube 视频链接（可选）<input id="import-url" placeholder="用于点击时间戳打开原视频"></label>':''}<div class="file-picker"><label for="import-file">选择字幕文件 · SRT / VTT / TXT，最大 2 MB</label><input type="file" id="import-file" accept=".srt,.vtt,.txt,text/plain,text/vtt"></div><label class="field">文稿内容<textarea id="import-text" required placeholder="选择文件后内容会显示在这里，也可以直接粘贴…"></textarea><small>最多 24 万字符。纯文本没有时间戳，不会伪造视频定位。</small></label><div id="dialog-error" class="dialog-error" role="alert"></div><div class="dialog-actions"><button type="button" class="button" data-action="close-dialog">取消</button><button class="button primary" id="import-submit" type="submit">${v?'替换并保存文稿':'保存并开始阅读'}</button></div></form>`);
}
function renderChannelManager(){
  const el=$('#channel-manager');if(!el)return;
  el.innerHTML=library.channels.length?library.channels.map(c=>`<div class="manage-channel"><div class="manage-channel-top"><span class="channel-avatar">${esc(c.title.replace(/^@/,'').slice(0,1))}</span><div><strong>${esc(c.title)}</strong><small>${c.status==='ready'?'✓ 已订阅':c.status==='error'?'同步失败':c.status==='pending'?'等待同步':'正在同步'} · ${clockDate(c.lastSync)}</small></div><button class="button quiet" data-action="sync-channel" data-id="${esc(c.id)}" ${view.online?'':'disabled'}>刷新</button><button class="button quiet danger-text" data-action="unsubscribe" data-id="${esc(c.id)}" ${view.online?'':'disabled'}>取消订阅</button></div>${c.error?`<div class="notice error">${esc(c.error)}</div>`:''}</div>`).join(''):'<div class="small-empty">暂未订阅频道。添加一个感兴趣的创作者开始。</div>';
}
function channelsDialog(){dialog('管理订阅频道','这里的订阅保存在本机，不会修改你的 YouTube 账号。取消订阅仅停止更新，已有视频与阅读笔记会保留。','<div id="channel-manager"></div><div class="dialog-actions"><button class="button primary" data-action="add-channel">＋ 添加频道</button></div>');renderChannelManager();}
function settingsDialog(){
  dialog('阅读与同步设置','模型使用 NewMax 当前配置；应用不保存任何模型密钥。',`<div id="connector-settings-status" class="notice ${view.online?'':'error'}" role="status">${connectorStatusHTML()}</div><div class="settings-section"><h3>自动静默运行</h3><p class="dialog-description">登录自启由 Windows 当前用户启动项管理，无需保留终端。连接器每次只运行一份，不会自动生成 AI 解析。</p><details><summary>手动启动与自启管理</summary><p class="dialog-description">异常离线时双击静默启动脚本；本窗口每 5 秒检查连接状态。</p><div class="script-path">C:/Users/admin/.newmax/apps/app-f73ecc67-75cb-4381-b4ea-e829470dba1b/start-connector-silent.vbs</div><p class="dialog-description">同一目录中：enable-connector-autostart.cmd 启用登录自启；disable-connector-autostart.cmd 取消登录自启（不立即停止当前进程）。启动失败日志位于本应用数据目录 connector/background.log。</p></details><div class="dialog-actions" style="margin-top:10px"><button class="button" data-action="reconnect">重新连接</button><button class="button quiet" data-action="stop-connector" ${view.online?'':'disabled'}>停止后台更新</button></div></div><form id="settings-form"><div class="settings-section"><h3>自动同步</h3><label class="setting-row"><div>检查间隔<small>仅在连接器运行时生效</small></div><select id="sync-interval" ${view.online?'':'disabled'}>${[5,15,30,60,120,360,1440].map(n=>`<option value="${n}" ${library.settings.intervalMinutes===n?'selected':''}>${n<60?n+' 分钟':n/60+' 小时'}</option>`).join('')}</select></label><label class="setting-row"><div>自动获取新视频字幕<small>每次最多尝试 3 条；不下载视频媒体</small></div><input id="auto-captions" type="checkbox" ${library.settings.autoCaptions?'checked':''} ${view.online?'':'disabled'}></label></div><div class="settings-section"><label class="field">解析与对话模型<select id="model-select"><option value="">跟随 NewMax 默认模型</option>${models.map(m=>`<option value="${esc(m.providerId+'::'+m.model)}" ${state.model===m.providerId+'::'+m.model?'selected':''}>${esc(m.providerName+' / '+m.model)}</option>`).join('')}</select><small>点击“生成解析”或“发送”才提交文稿。云端模型可能产生费用；应用不自动重试或换模型。</small></label>${runtimeNotice()}<label class="field">输出预算<select id="output-mode"><option value="auto" ${selectedBudget()==='auto'?'selected':''}>自动（不设应用固定上限）</option><option value="custom" ${selectedBudget()!=='auto'?'selected':''}>自定义输出上限</option></select><small>自动使用服务默认或根据已配置上下文与输入计数分配剩余空间；不是无限输出，也不会把 192K 全部用作输出。旧版 4000/8000 设置不再生效。</small></label><label class="field" id="custom-output-field" ${selectedBudget()==='auto'?'hidden':''}>自定义 tokens<input id="output-tokens" type="number" min="1" step="1" value="${selectedBudget()==='auto'?'':selectedBudget()}" placeholder="输入所需上限，不再限制为 8000"><small>受模型自身能力限制，服务拒绝时不会自动降低额度重试。</small></label><label class="field">单次最长等待（分钟）<input id="wait-minutes" type="number" min="1" max="35791" step="1" value="${Math.round(selectedTimeout()/60000)}" required><small>默认 15 分钟；等待超时不保证远端取消。生成或重试均可能产生费用。</small></label></div><div id="dialog-error" class="dialog-error" role="alert"></div><div class="dialog-actions"><button type="button" class="button" data-action="close-dialog">关闭</button><button type="submit" class="button primary">保存设置</button></div></form>`);
}
async function modelArgs(){
  runtimeCapabilities=null;
  const catalog=await sdk.ai.listModels();models=catalog?.models||[];runtimeCapabilities=catalog?.capabilities||null;
  if(!supportsBudget({capabilities:runtimeCapabilities}))throw new Error('请先更新并重启 NewMax，当前进程尚未支持自动预算与真实结束状态。本次未发送模型请求。');
  const maxTokens=selectedBudget(),timeoutMs=selectedTimeout(),selection=state.model;
  if(!selection)return {maxTokens,timeoutMs};
  const m=models.find(m=>`${m.providerId}::${m.model}`===selection);
  if(!m)throw new Error('已选模型当前不可用，请到设置中选择可用模型或跟随默认。');
  return {providerId:m.providerId,model:m.model,maxTokens,timeoutMs};
}
function streamStatus(task){return task.text?`正在输出 · 已收到 ${task.text.length.toLocaleString()} 字符`:'等待首段正文 · 模型可能正在思考';}
function streamView(v,type){
  const task=view.activeAI;if(task?.id!==v.id||task.type!==type)return '';
  return `${type==='chat'?`<div class="chat-message user">${esc(task.question||'')}</div>`:''}<section id="live-stream" class="live-stream${type==='chat'?' chat-message assistant':''}" data-video="${esc(v.id)}" aria-label="正在生成的${type==='chat'?'回答':'解析'}" aria-busy="true">${type==='chat'?'<div class="message-label">✦ 阅读助手 <span>· 当前文稿</span></div>':''}<div class="stream-heading" role="status"><span class="stream-dot" aria-hidden="true"></span><span id="stream-status">${esc(streamStatus(task))}</span><span class="stream-stage">${esc(view.aiProgress)}</span></div><div id="stream-body" class="prose streaming-prose">${task.text?markdown(task.text):''}</div></section>`;
}
function renderStream(task){
  const root=$('#live-stream');if(view.activeAI!==task||view.selected!==task.id||root?.dataset.video!==task.id)return;
  const scroll=$('#chat-messages'),follow=scroll&&scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<64;
  $('#stream-status').textContent=streamStatus(task);$('#stream-body').innerHTML=task.text?markdown(task.text):'';
  if(follow)scroll.scrollTop=scroll.scrollHeight;
}
async function callAI(prompt,args){
  const task=view.activeAI;task.text='';task.stage=view.aiProgress;
  if(view.selected===task.id)renderReader();
  let paintTimer=null,saveTimer=null,lastSave=0;
  const checkpoint=()=>{
    saveTimer=null;if(view.activeAI!==task||!task.text)return;
    lastSave=Date.now();const key=task.type==='chat'?'chatAttempt':'analysisAttempt';
    record(task.id)[key]={text:task.text,stage:task.stage,mode:task.mode,question:task.question,termination:'unknown',truncated:null,finishReason:null,at:new Date().toISOString(),error:'流式生成期间保存的草稿；尚未收到正常结束确认。若窗口已关闭，可手动重新请求，可能产生费用。'};
    // persist 内部串行保存快照，最终结果会排在中途草稿之后。
    persist().catch(()=>{});
  };
  try{
    return await requestAIStream({capabilities:runtimeCapabilities,stream:options=>sdk.ai.stream(options),onStreamDelta:sdk.ai.onStreamDelta,onStreamDone:sdk.ai.onStreamDone},prompt,args,text=>{
      if(view.activeAI!==task)return;task.text=text;
      if(!paintTimer)paintTimer=setTimeout(()=>{paintTimer=null;renderStream(task);},80);
      if(!lastSave)checkpoint();else if(!saveTimer)saveTimer=setTimeout(checkpoint,Math.max(0,1500-(Date.now()-lastSave)));
    });
  }finally{clearTimeout(paintTimer);clearTimeout(saveTimer);}
}
async function analyze(mode='full'){
  const v=selectedVideo(),t=currentTranscript();if(!v||!t||view.activeAI)return;
  const r=record(v.id);
  const previous={analysis:r.analysis,analysisModel:r.analysisModel,analysisAt:r.analysisAt,analysisMode:r.analysisMode,analysisCompletion:r.analysisCompletion,analysisAttempt:r.analysisAttempt};
  view.activeAI={id:v.id,type:'analysis',mode,text:''};view.aiError='';view.aiProgress='正在准备文稿与模型…';renderReader();
  // 从文末点击重新生成时回到同一个正文位，后续增量不抢用户滚动位置。
  if($('.reader-content'))$('.reader-content').scrollTop=0;
  try{
    const args=await modelArgs();
    const result=await generateAnalysis({title:v.title,segments:t.segments,mode,parts:r.summaryParts||[],
      request:prompt=>callAI(prompt,args),
      onProgress:message=>{view.aiProgress=message;view.activeAI.text='';if(view.selected===v.id)renderReader();},
      onPart:async(index,text)=>{r.summaryParts ||= [];r.summaryParts[index]=text;await persist();}
    });
    r.analysis=result.text;r.analysisMode=mode;
    r.analysisCompletion=result.termination==='stop'?resultMetadata(result):null;
    r.analysisAttempt=null;
    r.analysisModel=`${result.providerId||args.providerId||'当前模型'} / ${result.model||args.model||'默认'}`;
    r.analysisAt=new Date().toISOString();await persist();toast(r.analysisCompletion?'完整解析已保存':'已有分段已载入，完整性未确认');
  }catch(e){
    Object.assign(r,previous);
    if(e.result){r.analysisAttempt={...resultMetadata(e.result),text:e.result.text||'',error:e.message,stage:view.aiProgress,mode,at:new Date().toISOString()};}
    const hint=isContextLimitError(e.message)?'模型报告输入或上下文超限。请更换支持长文的模型，或手动选择下方兼容分段。':'';
    view.aiError={id:v.id,text:`${mode==='full'?'全文解析':'兼容分段解析'}未完成。${hint}${e.message||'请检查模型配置后重试。'}`};
    try{await persist();}catch{}
  }
  finally{view.activeAI=null;view.aiProgress='';renderList();if(view.selected===v.id)renderReader();}
}
async function sendChat(){
  const v=selectedVideo(),t=currentTranscript();if(!v||!t||view.activeAI)return;
  const question=(view.chatDrafts[v.id]||'').trim();if(!question){toast('先写下想了解的问题。');$('#chat-input')?.focus();return;}
  const r=record(v.id);const built=chatPrompt(v.title,question,t.segments,(r.analysisCompletion?'':'【以下旧解析完整性未确认，仅作参考】\n')+(r.analysis||''),r.messages||[]);
  view.activeAI={id:v.id,type:'chat',question,text:''};view.aiProgress=`正在根据${built.scope}回答 · 流式返回`;view.aiError='';renderReader();
  try{const args=await modelArgs();const response=await callAI(built.prompt,args);r.messages ||= [];r.messages.push({role:'user',text:question,at:new Date().toISOString()},{role:'assistant',text:response.text,scope:built.scope,completion:resultMetadata(response),at:new Date().toISOString()});r.chatAttempt=null;view.chatDrafts[v.id]='';await persist();}
  catch(e){if(e.result){r.chatAttempt={...resultMetadata(e.result),text:e.result.text||'',error:e.message,stage:'阅读对话',question,at:new Date().toISOString()};try{await persist();}catch{}}view.aiError={id:v.id,text:e.message||'回答失败，请检查模型配置后重试。'};}
  finally{view.activeAI=null;view.aiProgress='';if(view.selected===v.id)renderReader();}
}
function download(name,text,type='text/plain;charset=utf-8'){
  const blob=new Blob([text],{type});const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download=name.replace(/[<>:"/\\|?*]/g,'_');a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);
}
async function dispatch(action,el){
  const id=el?.dataset.id,value=el?.dataset.value;
  switch(action){
    case 'menu':$('#sidebar').classList.toggle('open');break;
    case 'back':$('.workspace').classList.remove('show-reader');break;
    case 'filter':pendingSelection=null;view.filter=value;view.channel=null;$('#sidebar').classList.remove('open');$('.workspace').classList.remove('show-reader');renderNavigation();renderList();break;
    case 'channel':{
      view.channel=id;view.filter='all';view.query='';$('#video-search').value='';pendingSelection='channel';applyPendingSelection();
      $('#sidebar').classList.remove('open');$('.workspace').classList.toggle('show-reader',!!view.selected);render();
      if(view.selected)await loadTranscript(view.selected);break;
    }
    case 'clear-filters':pendingSelection=null;view.filter='all';view.channel=null;view.query='';$('#video-search').value='';renderNavigation();renderList();break;
    case 'select-video':await selectVideo(id);break;
    case 'tab':view.tab=value;view.aiError='';renderReader();break;
    case 'close-dialog':closeDialog();break;
    case 'add-channel':addChannelDialog();break;
    case 'channels':channelsDialog();break;
    case 'settings':settingsDialog();break;
    case 'reconnect':el.disabled=true;try{await connect(true);}finally{if(el.isConnected)el.disabled=false;}break;
    case 'stop-connector':dialog('停止后台更新？','将停止当前连接器，已有资料保留。如果已配置登录自启，下次登录 Windows 仍会启动；永久停用请运行取消自启脚本。当前未保存的设置不会提交。','<div class="dialog-actions"><button class="button" data-action="settings">取消</button><button class="button danger" data-action="confirm-stop-connector">停止连接器</button></div>');break;
    case 'confirm-stop-connector':el.disabled=true;await api('/shutdown','POST',{});view.online=false;view.connecting=false;settingsDialog();renderNavigation();renderList();toast('已请求停止后台更新，已有资料保留');break;
    case 'import-new':importDialog(false);break;
    case 'import-current':importDialog(true);break;
    case 'sync':case 'sync-channel':{
      if(!view.online)return;view.syncBusy=true;renderList();try{await api('/sync','POST',action==='sync-channel'?{channelId:id}:view.channel?{channelId:view.channel}:{});toast('已加入频道更新队列');await refreshLibrary();}finally{view.syncBusy=false;renderList();}break;
    }
    case 'unsubscribe':{
      const c=library.channels.find(x=>x.id===id);if(!c)return;
      dialog('停止订阅这个频道？',`将停止检查「${esc(c.title)}」的更新。已有视频、文稿、解析与对话全部保留。`,`<div class="dialog-actions"><button class="button" data-action="channels">保留订阅</button><button class="button danger" data-action="confirm-unsubscribe" data-id="${esc(id)}">停止订阅</button></div>`);break;
    }
    case 'confirm-unsubscribe':el.disabled=true;await api(`/channels/${encodeURIComponent(id)}`,'DELETE');await refreshLibrary();channelsDialog();toast('已停止更新，已有资料保留');break;
    case 'favorite':{const v=selectedVideo();if(v){record(v.id).favorite=!record(v.id).favorite;await persist();render();}break;}
    case 'toggle-read':{const v=selectedVideo();if(v){record(v.id).read=!record(v.id).read;await persist();render();}break;}
    case 'fetch-transcript':{const v=selectedVideo();if(v){el.disabled=true;await api(`/videos/${encodeURIComponent(v.id)}/transcript`,'POST',{});await refreshLibrary();toast('已加入字幕获取队列');}break;}
    case 'timestamp':{const v=selectedVideo();if(v?.url&&el.dataset.time!==''){const u=new URL(v.url);u.searchParams.set('t',Math.floor(Number(el.dataset.time))+'s');window.open(u.href,'_blank','noopener,noreferrer');}break;}
    case 'cite':{const t=currentTranscript();if(!t)return;const sec=Number(el.dataset.time);let idx=0;for(let i=0;i<t.segments.length;i++)if(t.segments[i].start!==null&&t.segments[i].start<=sec)idx=i;view.tab='transcript';view.transcriptQuery='';renderReader();const row=$(`#segment-${idx}`);row?.classList.add('active');row?.scrollIntoView({block:'center'});break;}
    case 'analyze':await analyze('full');break;
    case 'regenerate':dialog('重新全文解析？','将完整文稿一次提交给当前模型，可能产生费用。成功后替换现有解析；失败保留旧结果，对话与旧分段均保留。','<div class="dialog-actions"><button class="button" data-action="close-dialog">取消</button><button class="button primary" data-action="confirm-regenerate">全文一次解析</button></div>');break;
    case 'confirm-regenerate':closeDialog();await analyze('full');break;
    case 'analyze-chunks':{
      const t=currentTranscript(),v=selectedVideo();if(!t||!v||view.activeAI)return;
      const plan=compatibilityPlan(t.segments,record(v.id).summaryParts);
      if(plan.chunks.length>30){toast('兼容模式最多支持 30 段，请选择支持长文的模型进行全文解析。');return;}
      dialog('使用兼容分段解析？',`按原分段方式处理；已保存 ${plan.completed} / ${plan.chunks.length} 段，本次最多 ${plan.remaining} 次请求${plan.chunks.length>1?'（含汇总）':''}。不重复提交已完成分段。成功后替换现有解析，失败保留旧结果；可能产生费用。`,'<div class="dialog-actions"><button class="button" data-action="close-dialog">取消</button><button class="button primary" data-action="confirm-chunks">确认并处理剩余分段</button></div>');break;
    }
    case 'confirm-chunks':closeDialog();await analyze('chunks');break;
    case 'send-chat':await sendChat();break;
    case 'suggest':view.chatDrafts[view.selected]=value;$('#chat-input').value=value;$('#chat-input').focus();break;
    case 'export-transcript':{const v=selectedVideo(),t=currentTranscript();if(v&&t)download(v.title+(t.format==='json3'?'.txt':'.'+t.format),t.format==='json3'?transcriptText(t.segments):t.raw||transcriptText(t.segments));break;}
    case 'editorial':{const v=selectedVideo();if(!v||view.activeAI?.id===v.id)return;await openEditorial({sdk,video:v,record:record(v.id),transcript:currentTranscript(v.id)?transcriptText(currentTranscript(v.id).segments):'',brand:$('#brand-name').textContent,frameApi:api});break;}
    case 'export-analysis':{const v=selectedVideo(),r=record(v.id);download(v.title+'.md',`# ${v.title}\n\n${v.url||'本地文稿'}\n\n${r.analysisCompletion?'已确认正常结束':'旧解析完整性未确认'}\n\n${r.analysis||''}${r.analysisAttempt?`\n\n## 未完成草稿\n\n${r.analysisAttempt.error}\n\n${r.analysisAttempt.text}`:''}`);break;}
    case 'remove-local':{const v=selectedVideo();if(!v?.local||view.activeAI?.id===v.id)return;dialog('移除这篇本地文稿？',`将删除「${esc(v.title)}」的导入文稿、解析、对话与收藏。此操作不能撤销。`,`<div class="dialog-actions"><button class="button" data-action="close-dialog">保留文稿</button><button class="button danger" data-action="confirm-remove-local" data-id="${esc(v.id)}">删除本地文稿</button></div>`);break;}
    case 'confirm-remove-local':{const v=state.imports.find(v=>v.id===id);if(!v||view.activeAI?.id===id)return;el.disabled=true;const previous=JSON.parse(JSON.stringify(state));state.imports=state.imports.filter(v=>v.id!==id);delete state.records[id];if(state.selectedId===id)state.selectedId=null;try{await persist();}catch(e){state=previous;throw e;}try{await sdk.data.delete(`yingdu.transcript.${id}`);}catch{}transcriptCache.delete(id);view.selected=null;closeDialog();render();toast('本地文稿已移除');break;}
  }
}
document.addEventListener('click',e=>{
  const el=e.target.closest('[data-action]');if(!el||el.disabled)return;
  e.preventDefault();dispatch(el.dataset.action,el).catch(error=>{dialogError(error.message||'操作未完成，请重试。');if(el.isConnected)el.disabled=false;});
});
document.addEventListener('input',e=>{
  if(e.target.id==='video-search'){pendingSelection=null;view.query=e.target.value;renderList();}
  if(e.target.id==='transcript-search'){view.transcriptQuery=e.target.value;renderSegments();}
  if(e.target.id==='chat-input')view.chatDrafts[view.selected]=e.target.value;
});
document.addEventListener('change',async e=>{
  if(e.target.id==='output-mode')$('#custom-output-field').hidden=e.target.value==='auto';
  if(e.target.id==='import-file'){
    const file=e.target.files?.[0];if(!file)return;
    try{if(!/\.(srt|vtt|txt)$/i.test(file.name))throw new Error('请选择 SRT、VTT 或 TXT 文件。');if(file.size>2*1024*1024)throw new Error('文件超过 2 MB，请拆分后导入。');const content=await file.text();$('#import-text').value=content;$('#import-text').dataset.filename=file.name;if(!$('#import-title').value)$('#import-title').value=file.name.replace(/\.[^.]+$/,'');dialogError('');}catch(e){dialogError(e.message);}
  }
});
document.addEventListener('keydown',e=>{
  if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!$('#app-dialog').open){e.preventDefault();$('#video-search').focus();}
  if(e.target.id==='chat-input'&&e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendChat();}
});
document.addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target;const submit=form.querySelector('[type=submit]');if(submit?.disabled)return;
  try{
    if(form.id==='channel-form'){
      const url=normalizeChannel($('#channel-url').value);submit.disabled=true;submit.textContent='正在添加…';
      const response=await api('/channels','POST',{url});await refreshLibrary();closeDialog();toast(response.duplicate?'这个频道已经在订阅库中':'频道已加入，正在检查近期视频');
    }else if(form.id==='import-form'){
      const title=$('#import-title').value.trim();if(!title)throw new Error('请填写文稿标题。');
      const url=$('#import-url')?videoURL($('#import-url').value):'';
      const transcript=parseTranscript($('#import-text').value,$('#import-text').dataset.filename||'');
      submit.disabled=true;const id=form.dataset.video||`local-${crypto.randomUUID()}`;
      if(!form.dataset.video)state.imports.unshift({id,title,url,channelId:'local',channelTitle:'本地文稿',publishedAt:new Date().toISOString(),duration:transcript.segments.at(-1)?.end,thumbnail:'',transcriptStatus:'ready',local:true});
      const r=record(id);r.analysis='';r.analysisCompletion=null;r.analysisAttempt=null;r.chatAttempt=null;r.summaryParts=[];r.messages=[];r.read=true;
      await sdk.data.set(`yingdu.transcript.${id}`,transcript);transcriptCache.set(id,transcript);await persist();closeDialog();await selectVideo(id);view.tab='transcript';renderReader();toast('文稿已保存在本机');
    }else if(form.id==='settings-form'){
      const maxTokens=$('#output-mode').value==='auto'?'auto':Number($('#output-tokens').value);
      if(maxTokens!=='auto'&&(!Number.isSafeInteger(maxTokens)||maxTokens<1))throw new Error('自定义输出上限请输入正整数，或选择自动。');
      const minutes=Number($('#wait-minutes').value);
      if(!Number.isInteger(minutes)||minutes<1||minutes>35791)throw new Error('等待时间请输入 1 至 35791 之间的整数分钟。');
      submit.disabled=true;
      if(view.online)await api('/settings','PATCH',{intervalMinutes:Number($('#sync-interval').value),autoCaptions:$('#auto-captions').checked});
      state.model=$('#model-select').value;state.outputBudget={maxTokens,timeoutMs:minutes*60000};await persist();if(view.online)await refreshLibrary();closeDialog();renderReader();toast('设置已保存');
    }
  }catch(err){dialogError(err.message||'操作失败，请重试。');}
  finally{if(submit?.isConnected){submit.disabled=false;if(form.id==='channel-form')submit.textContent='订阅并检查更新';}}
});
function applyBrand(bootstrap){
  const b=bootstrap?.app||bootstrap||{};
  if(b.name){$('#brand-name').textContent=b.name;document.title=b.name+' · 视频阅读工作台';}
  const iconURL=bootstrap?.iconUrl||b.iconUrl;
  if(iconURL){$('#brand-icon').textContent='';const img=document.createElement('img');img.src=iconURL;img.alt='';$('#brand-icon').append(img);}
}
async function init(){
  render();
  if(!sdk){globalError('请在 NewMax 的应用窗口中打开此应用，普通浏览器没有本地保存与 AI 接口。');view.connecting=false;render();return;}
  try{
    const saved=await sdk.data.get(DATA_KEY);if(saved){if(typeof saved!=='object'||!saved.records||!Array.isArray(saved.imports))throw new Error('数据格式不正确');state={...state,...saved};}
    const cached=await sdk.data.get('yingdu.library-cache.v1');if(cached?.channels&&cached?.videos)library=cached;
    applyPendingSelection();
    for(const [id,r] of Object.entries(state.records))if(r.chatAttempt?.question)view.chatDrafts[id]=r.chatAttempt.question;
  }catch(e){storeBroken=true;globalError('本地资料加载失败。为保护已有数据，写入已暂停；请重新打开应用。');}
  try{applyBrand(await sdk.app.getBootstrap());sdk.app.onChanged?.(applyBrand);}catch{}
  try{const catalog=await sdk.ai.listModels();models=catalog.models||[];runtimeCapabilities=catalog.capabilities||null;}catch{}
  ready=true;render();if(view.selected)await loadTranscript(view.selected);await connect();
  setInterval(async()=>{if(!ready||pollBusy)return;pollBusy=true;try{if(view.online)await refreshLibrary();else await connect();}catch{view.online=false;renderNavigation();renderList();}finally{pollBusy=false;}},5000);
}
init();
