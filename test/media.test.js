'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { run } = require('../src/exec');
const { downloadHls } = require('../src/download/ffmpeg');
const { resourceUrl } = require('../src/download/hls-proxy');
const { finalizeMedia, skipIfValid } = require('../src/download/finalize');
const { verifyMedia } = require('../src/download/verify');

const tools = { ffmpeg: process.env.XF_VIDEO_FFMPEG || 'ffmpeg', ffprobe: process.env.XF_VIDEO_FFPROBE || 'ffprobe' };
let root;
let server;
let origin;
let playlist;
let authorizedHits;

async function listen(handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  return instance;
}

test.before(async () => {
  await fsp.mkdir('F:/temp/xf-video-tests', { recursive: true });
  root = await fsp.mkdtemp('F:/temp/xf-video-tests/media-');
  const key = path.join(root, 'key.bin');
  await fsp.writeFile(key, crypto.randomBytes(16));
  await fsp.writeFile(path.join(root, 'keyinfo'), `key.bin\n${key}\n`);
  await run(tools.ffmpeg, [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100', '-t', '2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-hls_time', '1', '-hls_key_info_file', path.join(root, 'keyinfo'),
    '-hls_playlist_type', 'vod', path.join(root, 'index.m3u8'),
  ], { timeout: 60000 });
  authorizedHits = [];
  server = await listen((req, res) => {
    if (req.headers['x-test-auth'] !== 'allowed' || req.headers.authorization !== 'Bearer secret') {
      res.writeHead(401); res.end(); return;
    }
    authorizedHits.push(req.url);
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(root, path.basename(pathname));
    fs.createReadStream(file).on('error', () => { res.writeHead(404); res.end(); }).pipe(res);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  playlist = (await fsp.readFile(path.join(root, 'index.m3u8'), 'utf8'))
    .replace('URI="key.bin"', `URI="${origin}/key.bin?sign=private"`)
    .replace(/^([^#\s].+\.ts)$/gm, `${origin}/$1?sign=private`);
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

test('HLS 直连的清单、key、分片均携带鉴权', async () => {
  const target = path.join(root, 'direct.mp4');
  const downloaded = await downloadHls({
    kind: 'hls', url: `${origin}/index.m3u8?sign=private`,
    headers: { 'x-test-auth': 'allowed', authorization: 'Bearer secret' },
  }, target, tools, { timeout: 60000 });
  const final = await finalizeMedia(downloaded.file, target, tools, { timeout: 60000 });
  assert.equal(final.file, target);
});

test('HLS AES 的清单、key、分片均携带鉴权，短视频通过完整验收', async () => {
  const target = path.join(root, 'short.mp4');
  const downloaded = await downloadHls({ kind: 'hls', playlistText: playlist, baseUrl: origin, headers: {
    'x-test-auth': 'allowed', authorization: 'Bearer secret',
  } }, target, tools, { timeout: 60000 });
  const final = await finalizeMedia(downloaded.file, target, tools, { timeout: 60000 });
  assert.equal(final.file, target);
  assert.ok(final.duration > 0 && final.duration < 60);
  assert.ok(authorizedHits.some(url => url.includes('key.bin')));
  assert.ok(authorizedHits.some(url => url.includes('.ts')));
  const skipped = await skipIfValid(target, tools, { timeout: 60000 });
  assert.equal(skipped.skipped, true);
});

test('HLS 鉴权失败不会生成正式文件', async () => {
  const target = path.join(root, 'denied.mp4');
  await assert.rejects(downloadHls({ kind: 'hls', playlistText: playlist, baseUrl: origin, headers: {} }, target, tools, { timeout: 60000 }));
  await assert.rejects(fsp.access(target));
});

test('损坏文件不能通过验收或被误判为可跳过', async () => {
  const bad = path.join(root, 'bad.mp4');
  await fsp.writeFile(bad, 'not a movie');
  await assert.rejects(verifyMedia(bad, tools));
  await assert.rejects(skipIfValid(bad, tools), /未覆盖/);
});

test('HLS 相对 key 和分片按原始清单基址解析', async () => {
  const target = path.join(root, 'relative.mp4');
  const relative = (await fsp.readFile(path.join(root, 'index.m3u8'), 'utf8'))
    .replace('URI="key.bin"', 'URI="key.bin?sign=private"')
    .replace(/^([^#\s].+\.ts)$/gm, '$1?sign=private');
  const downloaded = await downloadHls({
    kind: 'hls', playlistText: relative, baseUrl: `${origin}/video/index.m3u8`,
    headers: { 'x-test-auth': 'allowed', authorization: 'Bearer secret' },
  }, target, tools, { timeout: 60000 });
  const final = await finalizeMedia(downloaded.file, target, tools, { timeout: 60000 });
  assert.equal(final.file, target);
});

test('HLS 跨 origin key 和分片不接收清单域的凭证', async t => {
  const otherHits = [];
  const other = await listen((req, res) => {
    otherHits.push(req.headers);
    const pathname = new URL(req.url, 'http://localhost').pathname;
    fs.createReadStream(path.join(root, path.basename(pathname)))
      .on('error', () => { res.writeHead(404); res.end(); }).pipe(res);
  });
  t.after(async () => {
    const closed = new Promise(resolve => other.close(resolve));
    other.closeAllConnections();
    await closed;
  });
  const otherOrigin = `http://127.0.0.1:${other.address().port}`;
  const crossOrigin = playlist.replaceAll(origin, otherOrigin);
  const target = path.join(root, 'cross-origin.mp4');
  const downloaded = await downloadHls({
    kind: 'hls', playlistText: crossOrigin, baseUrl: origin,
    headers: {
      'x-test-allowed': 'allowed', authorization: 'Bearer secret', cookie: 'session=secret',
      'x-api-key': 'secret', 'x-auth-token': 'secret', referer: `${origin}/page?sign=secret`,
    },
  }, target, tools, { timeout: 60000 });
  await finalizeMedia(downloaded.file, target, tools, { timeout: 60000 });
  assert.ok(otherHits.some(headers => headers));
  for (const headers of otherHits) {
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.cookie, undefined);
    assert.equal(headers['x-api-key'], undefined);
    assert.equal(headers['x-auth-token'], undefined);
    assert.equal(headers['x-test-allowed'], 'allowed');
    assert.equal(headers.referer, `${origin}/`);
  }
});

test('HLS 完整 206 清单仍由代理重写，且不向清单上游发送 Range', async t => {
  const playlistRanges = [];
  const special = await listen((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(root, path.basename(pathname));
    if (pathname.endsWith('.m3u8')) {
      playlistRanges.push(req.headers.range);
      const body = fs.readFileSync(file);
      res.writeHead(206, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': body.length,
        'Content-Range': `bytes 0-${body.length - 1}/${body.length}`,
      });
      res.end(body);
      return;
    }
    fs.createReadStream(file).on('error', () => { res.writeHead(404); res.end(); }).pipe(res);
  });
  t.after(async () => {
    const closed = new Promise(resolve => special.close(resolve));
    special.closeAllConnections();
    await closed;
  });
  const specialOrigin = `http://127.0.0.1:${special.address().port}`;
  const target = path.join(root, 'playlist-206.mp4');
  const downloaded = await downloadHls({
    kind: 'hls', url: `${specialOrigin}/index.m3u8`, headers: {},
  }, target, tools, { timeout: 60000 });
  await finalizeMedia(downloaded.file, target, tools, { timeout: 60000 });
  assert.ok(playlistRanges.length > 0);
  assert.ok(playlistRanges.every(value => value === undefined));
});

test('HLS 资源拒绝 file 等本地协议', () => {
  assert.throws(() => resourceUrl('file:///F:/private.mp4'), /只允许 HTTP\/HTTPS/);
  assert.throws(() => resourceUrl('relative.ts'), /相对资源地址/);
});

test('正式文件已存在时原子发布会失败且保留原文件', async () => {
  const target = path.join(root, 'short.mp4');
  const before = await fsp.readFile(target);
  const part = path.join(root, 'other.part.mp4');
  await fsp.copyFile(target, part);
  await assert.rejects(finalizeMedia(part, target, tools, { timeout: 60000 }), /未覆盖/);
  assert.deepEqual(await fsp.readFile(target), before);
});
