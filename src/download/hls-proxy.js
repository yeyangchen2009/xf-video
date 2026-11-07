'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { DownloadError } = require('../errors');
const { sanitizeMediaHeaders, headersForRedirect } = require('./headers');
const { fetchWithRedirects, parseContentRange } = require('./http');

function resourceUrl(value, baseUrl) {
  let url;
  try { url = new URL(value, baseUrl || undefined); } catch {
    throw new DownloadError('HLS 含无效或缺少基址的相对资源地址');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new DownloadError('HLS 只允许 HTTP/HTTPS 资源');
  }
  return url.toString();
}

function rewritePlaylist(text, baseUrl, register) {
  return String(text).split(/\r?\n/).map(line => {
    if (line.startsWith('#')) {
      return line.replace(/URI=("[^"]*"|[^,\s]+)/g, (match, rawValue) => {
        const value = rawValue.startsWith('"') ? rawValue.slice(1, -1) : rawValue;
        if (!value) return match;
        return `URI="${register(resourceUrl(value, baseUrl))}"`;
      });
    }
    if (!line.trim()) return line;
    return register(resourceUrl(line.trim(), baseUrl));
  }).join('\n');
}

async function createHlsProxy(media, options = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const resources = new Map();
  const baseHeaders = sanitizeMediaHeaders(media.headers);
  const credentialUrl = media.url || media.baseUrl || 'http://127.0.0.1/';
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

  function register(url) {
    const id = crypto.randomBytes(32).toString('hex');
    resources.set(id, url);
    const extension = new URL(url).pathname.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] || '';
    return `/${token}/${id}${extension}`;
  }

  let initial;
  if (media.playlistText !== undefined) {
    const body = Buffer.from(rewritePlaylist(media.playlistText, media.baseUrl || media.url, register), 'utf8');
    initial = { body };
  } else {
    initial = { remote: resourceUrl(media.url) };
  }
  const initialPath = `/${token}/playlist.m3u8`;
  resources.set('playlist', initial);

  const server = http.createServer(async (request, response) => {
    try {
      const match = request.url === initialPath
        ? ['', 'playlist']
        : new URL(request.url, 'http://127.0.0.1').pathname.match(new RegExp(`^/${token}/([a-f0-9]{64})(?:\\.[A-Za-z0-9]{1,8})?$`));
      if (!match || !resources.has(match[1])) {
        response.writeHead(404).end();
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }
      const entry = resources.get(match[1]);
      if (entry.body) {
        response.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Content-Length': entry.body.length,
          'Cache-Control': 'no-store',
        });
        response.end(request.method === 'HEAD' ? undefined : entry.body);
        return;
      }

      const remote = typeof entry === 'string' ? entry : entry.remote;
      const headers = headersForRedirect(baseHeaders, credentialUrl, remote);
      const playlistPath = new URL(remote).pathname.toLowerCase().endsWith('.m3u8');
      if (request.headers.range && !playlistPath) headers.range = request.headers.range;
      const upstream = await fetchWithRedirects(remote, headers, { signal });
      const contentType = upstream.headers.get('content-type') || '';
      const isPlaylist = contentType.includes('mpegurl') || new URL(upstream.url).pathname.toLowerCase().endsWith('.m3u8');
      if (isPlaylist && [200, 206].includes(upstream.status)) {
        if (upstream.status === 206) {
          const range = parseContentRange(upstream.headers.get('content-range'));
          if (!range || range.start !== 0 || range.total === null || range.end + 1 !== range.total) {
            await upstream.body?.cancel();
            throw new DownloadError('HLS 清单返回了不完整的分段响应');
          }
        }
        const body = Buffer.from(rewritePlaylist(await upstream.text(), upstream.url, register), 'utf8');
        response.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        response.end(request.method === 'HEAD' ? undefined : body);
        return;
      }

      const forwarded = {};
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name);
        if (value !== null) forwarded[name] = value;
      }
      response.writeHead(upstream.status, forwarded);
      if (request.method === 'HEAD' || !upstream.body) {
        if (upstream.body) await upstream.body.cancel();
        response.end();
        return;
      }
      const body = Readable.fromWeb(upstream.body);
      body.once('error', () => response.destroy());
      response.once('close', () => body.destroy());
      body.pipe(response);
    } catch {
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}${initialPath}`,
    async close() {
      controller.abort();
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}

module.exports = { createHlsProxy, rewritePlaylist, resourceUrl };
