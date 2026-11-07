'use strict';

const { openAndSniff } = require('../browser/sniffer');
const { DownloadError } = require('../errors');

function selectFeishuMedia(candidates) {
  const usable = candidates.filter(item => !item.status || item.status < 400);
  return usable.find(item => item.kind === 'mp4') || usable.find(item => item.kind === 'hls');
}

async function resolveFeishu(context, job) {
  const result = await openAndSniff(context, job.url, { timeout: 90000, passiveMs: 20000 });
  const media = selectFeishuMedia(result.media);
  if (!media) throw new DownloadError('飞书页面未提供受支持的 MP4 或 HLS');
  return { media: { ...media, pageUrl: result.pageUrl }, title: result.title };
}

module.exports = { resolveFeishu, selectFeishuMedia };
