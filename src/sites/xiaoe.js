'use strict';

const { openAndSniff } = require('../browser/sniffer');
const { DownloadError } = require('../errors');

async function resolveXiaoe(context, job) {
  const result = await openAndSniff(context, job.url, { timeout: 90000 });
  const media = result.media.find(item => item.kind === 'hls' && item.status < 400);
  if (!media) throw new DownloadError('小鹅通页面未提供受支持的标准 HLS');
  return { media: { ...media, pageUrl: result.pageUrl }, title: result.title };
}

module.exports = { resolveXiaoe };
