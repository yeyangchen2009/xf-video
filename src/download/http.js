'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { DownloadError } = require('../errors');
const { sanitizeMediaHeaders, headersForRedirect } = require('./headers');

function partPath(target) {
  if (!target.endsWith('.mp4')) throw new DownloadError('输出目标必须是 .mp4');
  return target.slice(0, -4) + '.part.mp4';
}

function metadataPath(target) {
  if (!target.endsWith('.mp4')) throw new DownloadError('输出目标必须是 .mp4');
  return target.slice(0, -4) + '.part.json';
}

async function readResumeMetadata(target) {
  try {
    const value = JSON.parse(await fsp.readFile(metadataPath(target), 'utf8'));
    const strongEtag = typeof value.etag === 'string' && value.etag && !value.etag.startsWith('W/');
    const validator = strongEtag ? value.etag : value.lastModified;
    return typeof validator === 'string' && validator ? { validator } : null;
  } catch {
    return null;
  }
}

async function writeResumeMetadata(target, response) {
  const metadata = {
    etag: response.headers.etag || undefined,
    lastModified: response.headers['last-modified'] || undefined,
  };
  await fsp.writeFile(metadataPath(target), JSON.stringify(metadata), { mode: 0o600 });
}

function requestSignal(options) {
  const signals = [];
  if (options.signal) signals.push(options.signal);
  if (Number.isFinite(options.timeout) && options.timeout > 0) {
    signals.push(AbortSignal.timeout(Math.max(1, Math.floor(options.timeout))));
  }
  if (!signals.length) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function parseContentRange(value) {
  const match = /^bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/i.exec(value || '');
  if (!match) return null;
  return {
    start: match[1] === undefined ? null : Number(match[1]),
    end: match[2] === undefined ? null : Number(match[2]),
    total: match[3] === '*' ? null : Number(match[3]),
  };
}

async function fetchWithRedirects(url, headers, options = {}) {
  let current = url;
  let currentHeaders = { ...headers };
  for (let count = 0; count <= 5; count++) {
    const response = await fetch(current, {
      headers: currentHeaders,
      redirect: 'manual',
      signal: options.signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) throw new DownloadError('媒体重定向缺少 Location');
    if (response.body) await response.body.cancel();
    const next = new URL(location, current).toString();
    if (!/^https?:\/\//i.test(next)) throw new DownloadError('媒体重定向协议不受支持');
    currentHeaders = headersForRedirect(currentHeaders, current, next);
    current = next;
  }
  throw new DownloadError('媒体重定向次数过多');
}

function requestOnce(url, headers, signal) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.get(parsed, { headers }, resolve);
    const abort = () => request.destroy(signal?.reason || new Error('下载已中止'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    request.once('close', () => signal?.removeEventListener('abort', abort));
    request.once('error', reject);
  });
}

async function requestWithRedirects(url, headers, options = {}) {
  let current = url;
  let currentHeaders = { ...headers };
  for (let count = 0; count <= 5; count++) {
    const response = await requestOnce(current, currentHeaders, options.signal);
    if (![301, 302, 303, 307, 308].includes(response.statusCode)) return response;
    const location = response.headers.location;
    response.resume();
    if (!location) throw new DownloadError('媒体重定向缺少 Location');
    const next = new URL(location, current).toString();
    if (!/^https?:\/\//i.test(next)) throw new DownloadError('媒体重定向协议不受支持');
    currentHeaders = headersForRedirect(currentHeaders, current, next);
    current = next;
  }
  throw new DownloadError('媒体重定向次数过多');
}

async function downloadHttp(media, target, options = {}) {
  const part = partPath(target);
  await fsp.mkdir(path.dirname(part), { recursive: true });
  const have = await fsp.stat(part).then(stat => stat.size).catch(error => {
    if (error.code === 'ENOENT') return 0;
    throw error;
  });
  const headers = sanitizeMediaHeaders(media.headers);
  const resumeRequested = have > 0 && !options.forceFull;
  if (resumeRequested) {
    const metadata = await readResumeMetadata(target);
    if (!metadata) return downloadHttp(media, target, { ...options, forceFull: true });
    headers.range = `bytes=${have}-`;
    headers['if-range'] = metadata.validator;
  }

  const signal = requestSignal(options);
  const response = await requestWithRedirects(media.url, headers, { signal });
  if (response.statusCode === 416) {
    const range = parseContentRange(response.headers['content-range']);
    response.resume();
    if (resumeRequested && range?.total === have) return { file: part, bytes: have, resumed: true };
    throw new DownloadError('续传位置无效，已保留半成品，请检查后重试');
  }
  if (![200, 206].includes(response.statusCode)) {
    response.resume();
    throw new DownloadError(`媒体下载返回 HTTP ${response.statusCode}`);
  }

  let append = false;
  let expectedTotal = null;
  if (response.statusCode === 206) {
    const range = parseContentRange(response.headers['content-range']);
    const expectedStart = resumeRequested ? have : 0;
    if (!range || range.start !== expectedStart) {
      response.resume();
      throw new DownloadError('服务器 Content-Range 与续传位置不符，未修改半成品');
    }
    append = resumeRequested;
    expectedTotal = range.total;
  } else {
    const rawLength = response.headers['content-length'];
    if (rawLength !== undefined && /^\d+$/.test(rawLength)) expectedTotal = Number(rawLength);
  }
  const metadataWrite = writeResumeMetadata(target, response);

  let written = have && append ? have : 0;
  let lastLog = 0;
  const output = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
  try {
    await new Promise((resolve, reject) => {
      let sourceError;
      const fail = error => {
        if (!sourceError) sourceError = error || new Error('响应正文提前结束');
        response.destroy();
        output.end();
      };
      const abort = () => fail(signal?.reason);
      metadataWrite.catch(fail);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      response.on('data', chunk => {
        written += chunk.length;
        const now = Date.now();
        if (options.onProgress && now - lastLog > 2000) {
          lastLog = now;
          options.onProgress(written, expectedTotal);
        }
      });
      response.once('aborted', () => fail(new Error('服务器提前断开连接')));
      response.once('error', fail);
      response.once('end', () => {
        if (response.complete) output.end();
        else fail(new Error('响应正文长度不足'));
      });
      response.once('close', () => signal?.removeEventListener('abort', abort));
      output.once('error', error => {
        response.destroy();
        signal?.removeEventListener('abort', abort);
        reject(error);
      });
      output.once('finish', () => {
        signal?.removeEventListener('abort', abort);
        if (sourceError) reject(sourceError);
        else metadataWrite.then(resolve, reject);
      });
      response.pipe(output, { end: false });
    });
  } catch (error) {
    throw new DownloadError(`下载中断，已保留 ${written} 字节供下次续传`, { cause: error });
  }
  if (expectedTotal !== null && written !== expectedTotal) {
    throw new DownloadError(`下载长度不符：${written}/${expectedTotal} 字节，已保留半成品`);
  }
  return { file: part, bytes: written, resumed: append };
}

module.exports = { downloadHttp, fetchWithRedirects, parseContentRange, partPath, metadataPath };
