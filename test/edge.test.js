'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require('playwright-core');
const { openAndSniff } = require('../src/browser/sniffer');

const execFileAsync = promisify(execFile);
const TEMP_ROOT = 'F:\\temp\\xf-video-tests';
const edgeOnly = {
  skip: process.env.npm_lifecycle_event === 'test:edge' ? false : '仅通过 npm run test:edge 独立运行',
  timeout: 90000,
};

async function makeTempDir(t, prefix) {
  await fsp.mkdir(TEMP_ROOT, { recursive: true });
  const directory = await fsp.mkdtemp(path.join(TEMP_ROOT, prefix));
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
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function withEdge(profileDir, callback) {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'msedge',
    headless: true,
    viewport: { width: 800, height: 600 },
    acceptDownloads: false,
    args: ['--disable-background-networking', '--no-first-run', '--no-default-browser-check'],
  });
  try {
    return await callback(context);
  } finally {
    await context.close().catch(() => {});
  }
}

async function hasSyntheticSession(page) {
  return page.evaluate(() => document.cookie
    .split(';')
    .some(part => part.trim() === 'xfv_edge_probe=present'));
}

test('本机 Edge 持久 profile 跨两个独立浏览器上下文保存登录态', edgeOnly, async t => {
  const directory = await makeTempDir(t, 'edge-profile-');
  const profileDir = path.join(directory, 'profile');
  const origin = await startServer(t, (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/login') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'xfv_edge_probe=present; Max-Age=3600; Path=/; SameSite=Lax',
      });
      response.end('<title>Local login</title><p>complete</p>');
      return;
    }
    if (pathname === '/check') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<title>Local check</title>');
      return;
    }
    response.writeHead(404).end();
  });

  const firstLaunch = await withEdge(profileDir, async context => {
    const page = context.pages()[0] || await context.newPage();
    try {
      await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
      return await hasSyntheticSession(page);
    } finally {
      await page.close();
    }
  });
  assert.equal(firstLaunch, true);

  const secondLaunch = await withEdge(profileDir, async context => {
    const page = context.pages()[0] || await context.newPage();
    try {
      await page.goto(`${origin}/check`, { waitUntil: 'domcontentloaded' });
      return await hasSyntheticSession(page);
    } finally {
      await page.close();
    }
  });
  assert.equal(secondLaunch, true);
});

test('本机 Edge 在 iframe 原生预加载中被动嗅探多候选并 drain 请求头', edgeOnly, async t => {
  const directory = await makeTempDir(t, 'edge-media-');
  const moviePath = path.join(directory, 'tiny.mp4');
  await execFileAsync(process.env.XF_VIDEO_FFMPEG || 'ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=5:d=1',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', moviePath,
  ], { timeout: 30000, windowsHide: true });
  const movie = await fsp.readFile(moviePath);

  const origin = await startServer(t, (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<title>Local passive video</title><iframe src="/frame"></iframe>');
      return;
    }
    if (pathname === '/frame') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end([
        '<video muted preload="auto" src="/media/one.mp4"></video>',
        '<video muted preload="auto" src="/media/two.mp4"></video>',
      ].join(''));
      return;
    }
    if (pathname === '/media/one.mp4' || pathname === '/media/two.mp4') {
      let start = 0;
      let end = movie.length - 1;
      let status = 200;
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
      if (range) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), end);
        status = 206;
      }
      if (start > end || start >= movie.length) {
        response.writeHead(416, { 'Content-Range': `bytes */${movie.length}` }).end();
        return;
      }
      const body = movie.subarray(start, end + 1);
      const headers = {
        'Content-Type': 'video/mp4',
        'Content-Length': body.length,
        'Accept-Ranges': 'bytes',
      };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${movie.length}`;
      response.writeHead(status, headers);
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    response.writeHead(404).end();
  });

  const result = await withEdge(path.join(directory, 'profile'), async context => {
    return openAndSniff(context, origin, {
      active: true,
      passiveMs: 30000,
      timeout: 20000,
      navigationTimeout: 10000,
    });
  });

  assert.equal(result.media.length, 2);
  assert.deepEqual(
    result.media.map(media => new URL(media.url).pathname).sort(),
    ['/media/one.mp4', '/media/two.mp4'],
  );
  for (const media of result.media) {
    assert.equal(media.kind, 'mp4');
    assert.ok(media.status === 200 || media.status === 206);
    assert.equal(typeof media.headers.accept, 'string');
    assert.ok(Object.keys(media.headers).length > 0);
  }
});
