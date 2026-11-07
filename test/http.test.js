'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { downloadHttp, partPath, metadataPath } = require('../src/download/http');

const TEMP_ROOT = 'F:\\temp\\xf-video-tests';
const PAYLOAD = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');

async function makeTempDir(t) {
  await fsp.mkdir(TEMP_ROOT, { recursive: true });
  const directory = await fsp.mkdtemp(path.join(TEMP_ROOT, 'http-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function startServer(t, handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function targetIn(directory) {
  return path.join(directory, 'video.mp4');
}

async function writePartial(target, data) {
  await fsp.writeFile(partPath(target), data);
  await fsp.writeFile(metadataPath(target), JSON.stringify({ etag: '"test-v1"' }));
}

test('HTTP 200 下载完整正文并新建 part', async t => {
  const directory = await makeTempDir(t);
  const target = targetIn(directory);
  const requests = [];
  const origin = await startServer(t, (request, response) => {
    requests.push(request.headers);
    response.writeHead(200, { 'Content-Length': PAYLOAD.length });
    response.end(PAYLOAD);
  });

  const result = await downloadHttp({ url: `${origin}/video` }, target);

  assert.deepEqual(result, { file: partPath(target), bytes: PAYLOAD.length, resumed: false });
  assert.deepEqual(await fsp.readFile(partPath(target)), PAYLOAD);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].range, undefined);
});

test('已有 part 时按正确 206 Content-Range 续传并追加', async t => {
  const directory = await makeTempDir(t);
  const target = targetIn(directory);
  const prefix = PAYLOAD.subarray(0, 17);
  await writePartial(target, prefix);
  const requests = [];
  const origin = await startServer(t, (request, response) => {
    requests.push(request.headers);
    response.writeHead(206, {
      'Content-Length': PAYLOAD.length - prefix.length,
      'Content-Range': `bytes ${prefix.length}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
    });
    response.end(PAYLOAD.subarray(prefix.length));
  });

  const result = await downloadHttp({ url: `${origin}/video` }, target);

  assert.equal(requests[0].range, `bytes=${prefix.length}-`);
  assert.deepEqual(result, { file: partPath(target), bytes: PAYLOAD.length, resumed: true });
  assert.deepEqual(await fsp.readFile(partPath(target)), PAYLOAD);
});

test('服务器忽略 Range 返回 200 时截断 part 并从头写入', async t => {
  const directory = await makeTempDir(t);
  const target = targetIn(directory);
  const stale = Buffer.from('stale partial data that is longer than the replacement');
  await writePartial(target, stale);
  const requests = [];
  const origin = await startServer(t, (request, response) => {
    requests.push(request.headers);
    response.writeHead(200, { 'Content-Length': PAYLOAD.length });
    response.end(PAYLOAD);
  });

  const result = await downloadHttp({ url: `${origin}/video` }, target);

  assert.equal(requests[0].range, `bytes=${stale.length}-`);
  assert.equal(result.resumed, false);
  assert.equal(result.bytes, PAYLOAD.length);
  assert.deepEqual(await fsp.readFile(partPath(target)), PAYLOAD);
});

test('206 起点与本地长度不符时拒绝且不修改 part', async t => {
  const directory = await makeTempDir(t);
  const target = targetIn(directory);
  const original = Buffer.from('preserve-this-partial-file');
  await writePartial(target, original);
  const origin = await startServer(t, (request, response) => {
    response.writeHead(206, {
      'Content-Length': PAYLOAD.length,
      'Content-Range': `bytes 0-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
    });
    response.end(PAYLOAD);
  });

  await assert.rejects(
    downloadHttp({ url: `${origin}/video` }, target),
    { name: 'DownloadError', message: '服务器 Content-Range 与续传位置不符，未修改半成品' },
  );
  assert.deepEqual(await fsp.readFile(partPath(target)), original);
});

test('合法 416（文件长度等于服务端总长度）视为续传完成', async t => {
  const directory = await makeTempDir(t);
  const target = targetIn(directory);
  await writePartial(target, PAYLOAD);
  let seenRange;
  const origin = await startServer(t, (request, response) => {
    seenRange = request.headers.range;
    response.writeHead(416, { 'Content-Range': `bytes */${PAYLOAD.length}` });
    response.end();
  });

  const result = await downloadHttp({ url: `${origin}/video` }, target);

  assert.deepEqual(result, { file: partPath(target), bytes: PAYLOAD.length, resumed: true });
  assert.equal(seenRange, `bytes=${PAYLOAD.length}-`);
  assert.deepEqual(await fsp.readFile(partPath(target)), PAYLOAD);
});

test('非法 416（总长度不符）报错并保留 part', async t => {
  const directory = await makeTempDir(t);
  const target = targetIn(directory);
  const original = PAYLOAD.subarray(0, 11);
  await writePartial(target, original);
  const origin = await startServer(t, (request, response) => {
    response.writeHead(416, { 'Content-Range': `bytes */${PAYLOAD.length}` });
    response.end();
  });

  await assert.rejects(
    downloadHttp({ url: `${origin}/video` }, target),
    { name: 'DownloadError', message: '续传位置无效，已保留半成品，请检查后重试' },
  );
  assert.deepEqual(await fsp.readFile(partPath(target)), original);
});

test('中途断流保留已写数据，重跑后通过 206 完成续传', async t => {
  const directory = await makeTempDir(t);
  const target = targetIn(directory);
  const cut = 23;
  const requests = [];
  const origin = await startServer(t, (request, response) => {
    requests.push(request.headers);
    if (requests.length === 1) {
      response.writeHead(200, { 'Content-Length': PAYLOAD.length, Connection: 'close', ETag: '"test-v1"' });
      response.end(PAYLOAD.subarray(0, cut));
      return;
    }
    response.writeHead(206, {
      'Content-Length': PAYLOAD.length - cut,
      'Content-Range': `bytes ${cut}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
    });
    response.end(PAYLOAD.subarray(cut));
  });

  await assert.rejects(
    downloadHttp({ url: `${origin}/video` }, target),
    { name: 'DownloadError', message: `下载中断，已保留 ${cut} 字节供下次续传` },
  );
  assert.deepEqual(await fsp.readFile(partPath(target)), PAYLOAD.subarray(0, cut));

  const result = await downloadHttp({ url: `${origin}/video` }, target);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].range, `bytes=${cut}-`);
  assert.equal(requests[1]['if-range'], '"test-v1"');
  assert.equal(result.resumed, true);
  assert.equal(result.bytes, PAYLOAD.length);
  assert.deepEqual(await fsp.readFile(partPath(target)), PAYLOAD);
});

test('Content-Length 大于实际正文时报告中断并保留已写 part', async t => {
  const directory = await makeTempDir(t);
  const target = targetIn(directory);
  const received = PAYLOAD.subarray(0, 19);
  const origin = await startServer(t, (request, response) => {
    response.writeHead(200, { 'Content-Length': PAYLOAD.length, Connection: 'close' });
    response.end(received);
  });

  await assert.rejects(
    downloadHttp({ url: `${origin}/video` }, target),
    { name: 'DownloadError', message: `下载中断，已保留 ${received.length} 字节供下次续传` },
  );
  assert.deepEqual(await fsp.readFile(partPath(target)), received);
});

test('跨 origin 重定向剥离 Cookie 和 Authorization，但保留普通请求头', async t => {
  const directory = await makeTempDir(t);
  const target = targetIn(directory);
  const destinationRequests = [];
  const destination = await startServer(t, (request, response) => {
    destinationRequests.push(request.headers);
    response.writeHead(200, { 'Content-Length': PAYLOAD.length });
    response.end(PAYLOAD);
  });
  const sourceRequests = [];
  const source = await startServer(t, (request, response) => {
    sourceRequests.push(request.headers);
    response.writeHead(302, { Location: `${destination}/final.mp4` });
    response.end();
  });

  const result = await downloadHttp({
    url: `${source}/start.mp4`,
    headers: {
      Cookie: 'session=synthetic-only',
      Authorization: 'Bearer synthetic-only',
      'Proxy-Authorization': 'Basic synthetic-only',
      'X-Sign': 'sign-secret',
      'X-Auth': 'auth-secret',
      'X-Client-Secret': 'client-secret',
      'X-Credential': 'credential-secret',
      'X-Credentials': 'plural-credential-secret',
      'X-Tokens': 'plural-token-secret',
      'X-Test-Header': 'preserved',
    },
  }, target);

  assert.equal(result.bytes, PAYLOAD.length);
  assert.equal(sourceRequests[0].cookie, 'session=synthetic-only');
  assert.equal(sourceRequests[0].authorization, 'Bearer synthetic-only');
  assert.equal(destinationRequests.length, 1);
  assert.equal(destinationRequests[0].cookie, undefined);
  assert.equal(destinationRequests[0].authorization, undefined);
  assert.equal(destinationRequests[0]['proxy-authorization'], undefined);
  assert.equal(destinationRequests[0]['x-sign'], undefined);
  assert.equal(destinationRequests[0]['x-auth'], undefined);
  assert.equal(destinationRequests[0]['x-client-secret'], undefined);
  assert.equal(destinationRequests[0]['x-credential'], undefined);
  assert.equal(destinationRequests[0]['x-credentials'], undefined);
  assert.equal(destinationRequests[0]['x-tokens'], undefined);
  assert.equal(destinationRequests[0]['x-test-header'], 'preserved');
  assert.deepEqual(await fsp.readFile(partPath(target)), PAYLOAD);
});

test('无 Content-Length 的正常 200 响应按完整流接受', async t => {
  const directory = await makeTempDir(t);
  const target = targetIn(directory);
  const origin = await startServer(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'video/mp4' });
    response.end(PAYLOAD);
  });
  const result = await downloadHttp({ url: `${origin}/video` }, target);
  assert.equal(result.bytes, PAYLOAD.length);
  assert.deepEqual(await fsp.readFile(partPath(target)), PAYLOAD);
});

test('没有资源校验器的旧 part 从头下载，不盲目拼接', async t => {
  const directory = await makeTempDir(t);
  const target = targetIn(directory);
  await fsp.writeFile(partPath(target), PAYLOAD.subarray(0, 17));
  let seenRange;
  const origin = await startServer(t, (request, response) => {
    seenRange = request.headers.range;
    response.writeHead(200, { 'Content-Length': PAYLOAD.length });
    response.end(PAYLOAD);
  });
  const result = await downloadHttp({ url: `${origin}/video` }, target);
  assert.equal(seenRange, undefined);
  assert.equal(result.resumed, false);
  assert.deepEqual(await fsp.readFile(partPath(target)), PAYLOAD);
});

test('HTTP 总超时会中止 stalled 正文并保留已写数据', async t => {
  const directory = await makeTempDir(t);
  const target = targetIn(directory);
  const origin = await startServer(t, (request, response) => {
    response.writeHead(200, { 'Content-Length': PAYLOAD.length, ETag: '"test-v1"' });
    response.write(PAYLOAD.subarray(0, 19));
  });
  await assert.rejects(downloadHttp({ url: `${origin}/video` }, target, { timeout: 50 }), {
    name: 'DownloadError', message: '下载中断，已保留 19 字节供下次续传',
  });
  assert.deepEqual(await fsp.readFile(partPath(target)), PAYLOAD.subarray(0, 19));
});
