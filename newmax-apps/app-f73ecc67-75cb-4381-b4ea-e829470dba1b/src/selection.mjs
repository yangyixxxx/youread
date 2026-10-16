// 以界面现有顺序为准；默认展示不改变阅读记录。
export function defaultSelection(channels, videos, previousId = null) {
  const channel = channels[0]?.id ?? null;
  if (channel) return {channel, selected: videos.find(v => v.channelId === channel)?.id ?? null};
  return {channel: null, selected: videos.some(v => v.id === previousId) ? previousId : null};
}

export function firstChannelVideo(videos, channel) {
  return videos.find(v => v.channelId === channel)?.id ?? null;
}
