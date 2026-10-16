import {normalizeUpload} from './editorial.mjs';

export const canFetchCover = video => !video?.local && /^[A-Za-z0-9_-]{11}$/.test(video?.id || '');
export const shouldFetchCover = (video, article) => canFetchCover(video) && !article.coverId && article.autoCover !== false;
export function validCoverSource(source) {
  if(source?.type !== 'youtube-cover' || !canFetchCover({id:source.videoId})) return null;
  if(!['maxresdefault','hqdefault'].includes(source.variant)) return null;
  return {type:'youtube-cover',videoId:source.videoId,variant:source.variant};
}

// 不使用正文外链或任意缩略图 URL；仅获取当前视频的固定封面资源。
export async function fetchVideoCover(video, {signal, fetchImpl=fetch, normalize=normalizeUpload, timeoutMs=15000}={}) {
  if(!canFetchCover(video)) throw new Error('当前内容没有可获取的 YouTube 视频封面，请上传本地图片。');
  const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
  const maxBytes=10*1024*1024;
  try {
    for(const variant of ['maxresdefault','hqdefault']) {
      controller.signal.throwIfAborted();
      const response=await fetchImpl(`https://i.ytimg.com/vi/${video.id}/${variant}.jpg`, {
        signal:controller.signal,mode:'cors',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error'
      });
      // 仅高清资源明确不存在时选择标准图；网络/权限/服务错误不自动重试。
      if(response.status===404 && variant==='maxresdefault'){await response.body?.cancel();continue;}
      if(!response.ok)throw new Error(`视频封面获取失败（HTTP ${response.status}），请稍后手动获取或上传图片。`);
      const type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
      if(!['image/jpeg','image/png','image/webp'].includes(type)){await response.body?.cancel();throw new Error('封面服务没有返回有效图片，原内容保留。');}
      if(Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel();throw new Error('视频封面超过 10 MB，已停止下载。');}
      if(!response.body)throw new Error('视频封面响应为空，请手动重试。');
      const reader=response.body.getReader(),chunks=[];let bytes=0;
      try {
        while(true){controller.signal.throwIfAborted();const part=await reader.read();if(part.done)break;
          bytes+=part.value.byteLength;
          if(bytes>maxBytes)throw new Error('视频封面超过 10 MB，已停止下载。');
          chunks.push(part.value);
        }
      } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
      controller.signal.throwIfAborted();
      const asset=await normalize(new File(chunks,`${video.id}-cover.jpg`,{type}));
      controller.signal.throwIfAborted();
      if(asset.width<200||asset.height<100)throw new Error('返回的封面尺寸异常，未用占位图替换封面。请上传图片或稍后重试。');
      return {...asset,source:{type:'youtube-cover',videoId:video.id,variant}};
    }
  } catch(error) {
    if(timedOut)throw new Error('视频封面获取超时，正文与旧封面保留。可手动获取或上传图片。');
    if(signal?.aborted)throw error;
    if(error instanceof TypeError)throw new Error('无法连接视频封面服务，请检查网络后手动获取，或上传本地图片。');
    throw error;
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
