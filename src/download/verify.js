'use strict';

const fsp = require('node:fs/promises');
const { run } = require('../exec');
const { DownloadError } = require('../errors');
const { createProgressParser } = require('./progress');

async function verifyMedia(file, tools, options = {}) {
  const stat = await fsp.stat(file);
  if (!stat.isFile() || stat.size === 0) throw new DownloadError('媒体文件为空');
  console.log('正在校验媒体结构（FFprobe）...');
  let probe;
  try {
    probe = await run(tools.ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration:stream=codec_type',
      '-of', 'json', file,
    ], { label: 'FFprobe', timeout: 60000, signal: options.signal });
  } catch (error) {
    throw new DownloadError(`媒体结构验收失败: ${error.message}`, { cause: error });
  }
  let info;
  try { info = JSON.parse(probe.stdout); } catch { throw new DownloadError('FFprobe 返回了无效信息'); }
  const duration = Number(info.format?.duration);
  if (!info.streams?.some(stream => stream.codec_type === 'video') || !Number.isFinite(duration) || duration <= 0) {
    throw new DownloadError('媒体缺少有效视频流或时长');
  }
  console.log('正在整段解码验收，耗时约等于视频时长，期间仅周期性上报处理进度...');
  await run(tools.ffmpeg, [
    '-v', 'error', '-xerror', '-nostats', '-progress', 'pipe:1',
    '-i', file, '-f', 'null', '-',
  ], {
    label: '整段解码验收', timeout: options.timeout || 7200000, signal: options.signal,
    onStdout: createProgressParser('整段解码验收', { intervalMs: options.progressIntervalMs }),
  });
  return { duration, bytes: stat.size };
}

module.exports = { verifyMedia };
