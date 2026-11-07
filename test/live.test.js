'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

// The exported playlist helpers are pure, but xiaoe-live.js loads the browser
// session at module initialization. Keep this suite independent of npm install.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'playwright-core') return { chromium: {} };
  return originalLoad.call(this, request, parent, isMain);
};
let live;
try {
  live = require('../src/sites/xiaoe-live');
} finally {
  Module._load = originalLoad;
}
const { confusionDecode, rebuildM3u8, shouldUseStandardHls, STANDARD_HLS_GRACE_MS } = live;

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

function md5(value) {
  return crypto.createHash('md5').update(value, 'utf8').digest('hex');
}

// Synthetic inverse of confusionDecode. Non-base64 "!" bytes are reversible
// padding because confusionDecode copies them and Buffer's base64 decoder ignores them.
function encodeConfusion(playlist, appid, first = 'A', padding = 0) {
  const base64 = Buffer.from(playlist, 'utf8').toString('base64');
  const key = md5(md5(appid) + first);
  const start = ALPHA.indexOf(first) % 8;
  const codes = [...key.substr(start, start + 7)].map(char => char.charCodeAt(0));
  let body = '';
  let d = 0;
  for (const char of base64) {
    if (d === codes.length) d = 0;
    const decoded = ALPHA.indexOf(char);
    const encoded = (decoded + d + codes[d]) % ALPHA.length;
    body += ALPHA[encoded] + '!'.repeat(padding);
    d++;
  }
  return encodeURIComponent(first + body + `x${padding}y`);
}

const PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4,\n0001.ts\n#EXT-X-ENDLIST\n';
const APPID = 'synthetic-appid';
const FIXED_RAW = 'Ar!!X!!O!!%2B!!L!!u!!x!!V!!5!!J!!N!!Z!!7!!S!!D!!4!!E!!7!!W!!W!!S!!G!!5!!L!!6!!q!!O!!M!!2!!G!!h!!Y!!5!!L!!K!!o!!6!!%2F!!3!!%3D!!9!!h!!7!!d!!G!!o!!m!!0!!J!!m!!k!!p!!y!!I!!i!!x!!%2F!!T!!h!!I!!H!!%2F!!e!!3!!v!!O!!F!!j!!7!!R!!b!!o!!M!!q!!b!!9!!S!!j!!L!!5!!x2y';

test('confusionDecode 解码合成可逆算法的固定向量（含两位插入 padding）', () => {
  assert.equal(encodeConfusion(PLAYLIST, APPID, 'A', 2), FIXED_RAW);
  assert.deepEqual(confusionDecode(FIXED_RAW, APPID), Buffer.from(PLAYLIST, 'utf8'));
});

test('confusionDecode 支持无 padding 的合成向量并拒绝错误 appid', () => {
  const raw = encodeConfusion(PLAYLIST, APPID, 'Q', 0);
  assert.deepEqual(confusionDecode(raw, APPID), Buffer.from(PLAYLIST, 'utf8'));
  assert.throws(
    () => confusionDecode(FIXED_RAW, 'wrong-synthetic-appid'),
    { name: 'DownloadError', message: '解混淆结果不是有效 M3U8，appid 或算法可能不匹配' },
  );
});

test('rebuildM3u8 无签名时移除空 KEY、保留有效 KEY 并重写 TS 基址', () => {
  const input = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI=""',
    '#EXT-X-KEY:METHOD=AES-128, URI = ""',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    '#EXTINF:4,',
    '0001.ts?obsolete=signature',
    '#EXT-X-ENDLIST',
    '',
  ].join('\r\n');

  const result = rebuildM3u8(Buffer.from(input), 'https://cdn.invalid/live/');

  assert.equal(result, [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    '#EXTINF:4,',
    'https://cdn.invalid/live/0001.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n'));
  assert.equal(result.includes('URI=""'), false);
  assert.equal(result.includes('obsolete=signature'), false);
});

test('rebuildM3u8 给 TS 统一追加签名，但不修改非 TS 行', () => {
  const input = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?old=1"\n0001.ts?old=1\n#EXT-X-ENDLIST\n';
  const result = rebuildM3u8(input, '/live/', '?sig=synthetic');
  assert.equal(result, '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?old=1"\n/live/0001.ts?sig=synthetic\n#EXT-X-ENDLIST\n');
});

test('shouldUseStandardHls 仅在无 confusion、标准 m3u8 出现且超过宽限期时成立', () => {
  const standardAt = 1000;
  const base = {
    hasConfusion: false, standardHlsAt: standardAt,
    now: standardAt + STANDARD_HLS_GRACE_MS, graceMs: STANDARD_HLS_GRACE_MS,
  };
  assert.equal(shouldUseStandardHls(base), true);
  assert.equal(shouldUseStandardHls({ ...base, hasConfusion: true }), false);
  assert.equal(shouldUseStandardHls({ ...base, standardHlsAt: null }), false);
  assert.equal(shouldUseStandardHls({ ...base, now: standardAt + STANDARD_HLS_GRACE_MS - 1 }), false);
  assert.equal(shouldUseStandardHls({ ...base, graceMs: 0 }), true);
});

test('resolveXiaoeLive 截获标准 m3u8 且宽限期无 confusion 时回退标准嗅探', async () => {
  const path = require('node:path');
  const { EventEmitter } = require('node:events');
  const livePath = require.resolve('../src/sites/xiaoe-live');
  const cached = require.cache[livePath];
  delete require.cache[livePath];

  const page = new EventEmitter();
  const fakeResponse = {
    url: () => 'https://encrypt-k-vod.xet.tech/hash/playlist_eof.m3u8?sign=secret',
    headers: () => ({ 'content-type': 'application/vnd.apple.mpegurl' }),
    request: () => ({ resourceType: () => 'media', allHeaders: async () => ({}) }),
  };
  Object.assign(page, {
    url: () => 'https://tenant.h5.xiaoeknow.com/v4/course/alive/l_demo',
    goto: async () => queueMicrotask(() => page.emit('response', fakeResponse)),
    title: async () => '回放标题',
    isClosed: () => false,
    waitForTimeout: async () => {},
    close: async () => {},
    evaluate: async () => '正常回放页面',
    frames: () => [],
  });
  const context = { newPage: async () => page };

  const previousLoad = Module._load;
  let fallbackCalledWith = null;
  Module._load = function (request, parent, isMain) {
    if (request === 'playwright-core') return { chromium: {} };
    if (parent?.filename?.endsWith(path.join('src', 'sites', 'xiaoe-live.js')) && request === './xiaoe') {
      return {
        resolveXiaoe: async (ctx, job) => {
          fallbackCalledWith = { ctx, job };
          return { media: { kind: 'hls' }, title: '标准回退标题' };
        },
      };
    }
    return previousLoad.call(this, request, parent, isMain);
  };
  try {
    const reloaded = require('../src/sites/xiaoe-live');
    const job = { url: page.url() };
    const result = await reloaded.resolveXiaoeLive(context, job, { liveFallbackGraceMs: 0 });
    assert.equal(fallbackCalledWith.ctx, context);
    assert.equal(fallbackCalledWith.job, job);
    assert.equal(result.title, '标准回退标题');
    assert.equal(result.media.kind, 'hls');
  } finally {
    Module._load = previousLoad;
    delete require.cache[livePath];
    if (cached) require.cache[livePath] = cached;
  }
});
