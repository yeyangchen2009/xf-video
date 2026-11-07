'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { run } = require('../exec');
const { partPath } = require('./http');
const { createHlsProxy } = require('./hls-proxy');
const { createProgressParser } = require('./progress');

async function downloadHls(media, target, tools, options = {}) {
  const part = partPath(target);
  await fsp.mkdir(path.dirname(part), { recursive: true });
  // -progress 把 key=value 进度写到 stdout，由解析器节流后上报，避免长任务零输出。
  const args = ['-y', '-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1'];
  let proxy;
  try {
    // All remote requests go through a loopback proxy which scopes credentials
    // by origin. Signed URLs stay in memory and never appear in FFmpeg arguments.
    proxy = await createHlsProxy(media, options);
    args.push('-i', proxy.url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', part);
    await run(tools.ffmpeg, args, {
      label: 'FFmpeg HLS 下载', timeout: options.timeout || 7200000,
      signal: options.signal,
      onStdout: createProgressParser('FFmpeg HLS 下载', { intervalMs: options.progressIntervalMs }),
    });
    return { file: part };
  } finally {
    if (proxy) await proxy.close();
  }
}

module.exports = { downloadHls };
