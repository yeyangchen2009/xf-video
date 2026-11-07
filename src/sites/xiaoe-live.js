'use strict';

const crypto = require('node:crypto');
const { DownloadError } = require('../errors');
const { startPlayback } = require('../browser/session');
const { classifyMedia, isLoginPage, detectAccessBlock, ACCESS_BLOCK_HINT } = require('../browser/sniffer');
const { fetchWithRedirects } = require('../download/http');
const { sanitizeMediaHeaders } = require('../download/headers');
const { resolveXiaoe } = require('./xiaoe');

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

// 新型直播回放（形态 A）不发 confusion_index，直接请求明文标准 m3u8。
// 截获标准 HLS 后再给混淆形态一个宽限期，仍无 confusion 即判定回退标准嗅探。
const STANDARD_HLS_GRACE_MS = 15000;
const STANDARD_HLS_CODE = 'XIAOE_STANDARD_HLS';

function shouldUseStandardHls({ hasConfusion, standardHlsAt, now, graceMs = STANDARD_HLS_GRACE_MS }) {
  return !hasConfusion && standardHlsAt !== null && now - standardHlsAt >= graceMs;
}

function standardHlsError() {
  return new DownloadError('回放未使用 confusion 混淆清单，按标准 HLS 形态处理', { code: STANDARD_HLS_CODE });
}

function md5(value) {
  return crypto.createHash('md5').update(value, 'utf8').digest('hex');
}

function confusionDecode(raw, appid) {
  const e = decodeURIComponent(raw);
  if (e.length < 4 || !/^\d$/.test(e[e.length - 2])) throw new DownloadError('混淆清单格式无效');
  const padding = Number(e[e.length - 2]);
  const first = e[0];
  const index = ALPHA.indexOf(first);
  if (index < 0) throw new DownloadError('混淆清单首字符无效');
  const key = md5(md5(appid) + first);
  const start = index % 8;
  const codes = [...key.substr(start, start + 7)].map(char => char.charCodeAt(0));
  const body = e.slice(1, -3);
  let output = '';
  let d = 0;
  for (let p = 0; p < body.length; p++) {
    if (d === codes.length) d = 0;
    const value = ALPHA.indexOf(body[p]);
    if (value < 0) throw new DownloadError('混淆清单包含未知字符');
    let decoded = value - d - codes[d];
    d++;
    while (decoded < 0) decoded += 65;
    output += ALPHA[decoded];
    if (padding) {
      output += body.slice(p + 1, p + 1 + padding);
      p += padding;
    }
  }
  const result = Buffer.from(output, 'base64');
  if (!result.subarray(0, 64).includes(Buffer.from('#EXTM3U'))) {
    throw new DownloadError('解混淆结果不是有效 M3U8，appid 或算法可能不匹配');
  }
  return result;
}

function rebuildM3u8(real, tsBase, tsQuery = '') {
  const lines = real.toString('utf8').split(/\r?\n/);
  const output = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY') && line.replace(/ /g, '').includes('URI=""')) continue;
    if (/^.+\.ts(?:\?.*)?$/.test(line)) {
      const name = line.split('?', 1)[0];
      output.push(tsBase + name + (tsQuery || ''));
    } else output.push(line);
  }
  return output.join('\n').replace(/\n*$/, '\n');
}

async function captureLive(context, job, options = {}) {
  const page = await context.newPage();
  const confusion = [];
  let tsUrl = null;
  let standardHlsAt = null;
  page.on('response', response => {
    const url = response.url();
    if (url.includes('confusion_index') && !confusion.some(item => item.url === url)) {
      confusion.push({ url, request: response.request() });
    }
    if (!tsUrl && /\d+_\d+_\d+\.ts$/.test(new URL(url).pathname)) tsUrl = url;
    if (standardHlsAt === null && !url.includes('confusion_index')) {
      try {
        if (classifyMedia(url, response.headers()['content-type'], response.request().resourceType()) === 'hls') {
          standardHlsAt = Date.now();
        }
      } catch {}
    }
  });
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (isLoginPage(page.url())) throw new DownloadError('小鹅通登录态已失效，请先执行 xfv login');
    const blockReason = await detectAccessBlock(page);
    if (blockReason) throw new DownloadError(`${blockReason}。${ACCESS_BLOCK_HINT}`);
    const deadline = Date.now() + 120000;
    const graceMs = options.liveFallbackGraceMs ?? STANDARD_HLS_GRACE_MS;
    let nextPlay = Date.now() + 10000;
    while ((!confusion.length || !tsUrl) && Date.now() < deadline) {
      if (page.isClosed()) throw new DownloadError('回放嗅探期间页面被关闭');
      if (shouldUseStandardHls({ hasConfusion: confusion.length > 0, standardHlsAt, now: Date.now(), graceMs })) {
        throw standardHlsError();
      }
      if (Date.now() >= nextPlay) {
        await startPlayback(page);
        nextPlay = Date.now() + 20000;
      }
      await page.waitForTimeout(1000);
    }
    if (!confusion.length || !tsUrl) {
      if (standardHlsAt !== null) throw standardHlsError();
      throw new DownloadError('未同时截获 confusion_index 和真实 TS 请求');
    }
    const confusionUrl = confusion[0].url;
    const appid = confusionUrl.split('/confusion_index')[0].replace(/\/$/, '').split('/').pop();
    const parsedTs = new URL(tsUrl);
    const tsBase = parsedTs.origin + parsedTs.pathname.slice(0, parsedTs.pathname.lastIndexOf('/') + 1);
    const headers = sanitizeMediaHeaders(await confusion[0].request.allHeaders().catch(() => ({})));
    const response = await fetchWithRedirects(confusionUrl, headers, { signal: options.signal });
    if (response.status !== 200) throw new DownloadError(`混淆清单返回 HTTP ${response.status}`);
    let raw = await response.text();
    const marker = '[xiaoe]';
    if (raw.includes(marker)) raw = raw.slice(raw.indexOf(marker) + marker.length);
    const real = confusionDecode(raw, appid);
    return {
      playlistText: rebuildM3u8(real, tsBase, parsedTs.search),
      baseUrl: response.url,
      headers,
      title: await page.title().catch(() => 'video'),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function resolveXiaoeLive(context, job, options = {}) {
  try {
    const result = await captureLive(context, job, options);
    return {
      media: {
        kind: 'hls', url: result.baseUrl, baseUrl: result.baseUrl,
        playlistText: result.playlistText, headers: result.headers,
      },
      title: result.title,
    };
  } catch (error) {
    // 形态 A 标准 HLS 回放与混淆回放共用 /v4/course/alive/ 路径，
    // 按页面实际发出的媒体请求回退到标准小鹅通嗅探，而非只凭 URL 定死适配器。
    if (error?.code === STANDARD_HLS_CODE) {
      console.log('检测到标准 HLS 型直播回放，自动切换标准小鹅通嗅探...');
      return resolveXiaoe(context, job);
    }
    throw error;
  }
}

module.exports = {
  confusionDecode, rebuildM3u8, resolveXiaoeLive,
  shouldUseStandardHls, STANDARD_HLS_GRACE_MS, STANDARD_HLS_CODE,
};
