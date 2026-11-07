'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const {
  sanitizeFilename,
  buildArchiveFilename,
  parseIndices,
  resolveOutput,
} = require('../src/utils/filename');
const { redact, redactUrl, publicError } = require('../src/utils/redact');

// jobs.js only needs Playwright for browser execution, not for these pure functions.
// Supply an inert module while loading so this suite also runs before npm install.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'playwright-core') return { chromium: {} };
  return originalLoad.call(this, request, parent, isMain);
};
let jobs;
try {
  jobs = require('../src/jobs');
} finally {
  Module._load = originalLoad;
}
const { detectSite, validateJob, expandGet, reserveOutput } = jobs;

test('sanitizeFilename 清理非法字符、空白、尾部点号与 Windows 保留名', () => {
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitizeFilename('  多处   空白  合并  '), '多处 空白 合并');
  assert.equal(sanitizeFilename('a\tb\nc'), 'a b c');
  assert.equal(sanitizeFilename('name...   '), 'name');
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename('com1.txt'), '_com1.txt');
  assert.equal(sanitizeFilename(''), 'video');
  assert.equal(sanitizeFilename(null, 'fallback'), 'fallback');
});

test('sanitizeFilename 按 Unicode 码点限制为 120 字符', () => {
  const result = sanitizeFilename('😀'.repeat(121));
  assert.equal([...result].length, 120);
  assert.equal(result, '😀'.repeat(120));
});

test('buildArchiveFilename 按日期、视频名、分享者、星球号组合并清理', () => {
  assert.equal(buildArchiveFilename({
    date: '2026-11-06',
    video_name: '课程/第一讲',
    sharer: 'Alice:Bob',
    planet_number: '42',
  }), '20261106-课程_第一讲@Alice_Bob-42');
  assert.equal(buildArchiveFilename(), 'video');
  assert.equal(buildArchiveFilename({ sharer: 'Alice' }), 'video@Alice');
});

test('parseIndices 保序去重并支持空白', () => {
  assert.equal(parseIndices(undefined), null);
  assert.equal(parseIndices(null), null);
  assert.equal(parseIndices(''), null);
  assert.deepEqual(parseIndices('3, 1,3,2'), [3, 1, 2]);
  assert.deepEqual(parseIndices('1,2', 2), [1, 2]);
});

test('parseIndices 拒绝非正整数、空项、越界与不安全整数', () => {
  for (const value of ['0', '-1', '1.5', 'a', '1,', '1,,2', ' ']) {
    assert.throws(() => parseIndices(value), { name: 'UsageError' }, `应拒绝 ${JSON.stringify(value)}`);
  }
  assert.throws(() => parseIndices('3', 2), { name: 'UsageError', message: '序号超出范围: 3' });
  assert.throws(() => parseIndices('9007199254740992'), { name: 'UsageError' });
});

test('redactUrl 与 redact 移除 URL 用户信息、查询和 hash', () => {
  assert.equal(
    redactUrl('https://user:pass@example.invalid/path?token=url-secret#fragment'),
    'https://example.invalid/path',
  );
  const loopbackToken = 'a'.repeat(64);
  const loopbackId = 'b'.repeat(64);
  assert.equal(
    redactUrl(`http://127.0.0.1:1234/${loopbackToken}/${loopbackId}.m3u8?sign=url-secret`),
    'http://127.0.0.1:1234/REDACTED/REDACTED.m3u8',
  );
  const cleaned = redact('url=https://user:pass@example.invalid/path?token=url-secret#fragment,');
  assert.equal(cleaned, 'url=https://example.invalid/path,');
  for (const secret of ['user', 'pass', 'url-secret', 'fragment']) {
    assert.equal(cleaned.includes(secret), false, `不应保留 ${secret}`);
  }
  assert.equal(redact('?token=query-secret&ok=1'), '?token=<redacted>&ok=1');
  assert.equal(publicError(new Error('failure ?auth=private')), 'failure ?auth=<redacted>');
});

test('redact 按行移除 Cookie、Authorization 与其他敏感请求头', () => {
  const cleaned = redact([
    'Cookie: cookie-secret',
    'Authorization="Bearer header-secret"',
    'X-Api-Key: api-secret',
    'X-Auth-Token: auth-token-secret',
    'X-Access-Token: access-token-secret',
    'X-Amz-Security-Token: amz-token-secret',
    'Proxy-Authorization: proxy-secret',
  ].join('\n'));
  assert.equal(cleaned, [
    'Cookie: <redacted>',
    'Authorization: <redacted>',
    'X-Api-Key: <redacted>',
    'X-Auth-Token: <redacted>',
    'X-Access-Token: <redacted>',
    'X-Amz-Security-Token: <redacted>',
    'Proxy-Authorization: <redacted>',
  ].join('\n'));
  assert.equal(redact('?sig=query-secret&ok=1'), '?sig=<redacted>&ok=1');
});

test('redact 脱敏完整 Cookie 值，包括分号后的键值对', () => {
  const cleaned = redact('Cookie: cookie-secret; session=another-secret');
  assert.equal(cleaned, 'Cookie: <redacted>');
  assert.doesNotMatch(cleaned, /cookie-secret|another-secret/);
});

test('batch 名称清理发生在路径拼接前，不能逃出输出目录', () => {
  const result = resolveOutput('D:/safe-output', '../../outside');
  assert.equal(path.dirname(result), path.resolve('D:/safe-output'));
  assert.equal(path.basename(result), '.._.._outside.mp4');
});

test('输出预留拒绝动态重名以及正式文件与 part 的交叉冲突', () => {
  const reservations = new Set();
  reserveOutput(reservations, 'D:/safe/foo.mp4');
  assert.throws(() => reserveOutput(reservations, 'D:/safe/foo.mp4'), /路径冲突/);
  assert.throws(() => reserveOutput(reservations, 'D:/safe/foo.part.mp4'), /路径冲突/);
});

test('detectSite 识别支持的域名与小鹅通直播路径', () => {
  const cases = [
    ['https://aipoju.com/list', 'aipoju'],
    ['https://tenant.aipoju.com/list', 'aipoju'],
    ['https://feishu.cn/docx/1', 'feishu'],
    ['https://tenant.feishu.cn/minutes/1', 'feishu'],
    ['https://XIAOFEISHU.invalid/', null],
    ['https://app.xiaoeknow.com/course/1', 'xiaoe'],
    ['https://app.xiaoeknow.com/v4/course/alive/123', 'xiaoe-live'],
    ['https://app.xetlk.com/course/1', 'xiaoe'],
    ['https://app.xetslk.com/v4/course/alive/123', 'xiaoe-live'],
    ['https://app.xet.tech/course/1', 'xiaoe'],
  ];
  for (const [url, expected] of cases) {
    if (expected === null) assert.throws(() => detectSite(url), { name: 'UsageError' });
    else assert.equal(detectSite(url), expected);
  }
});

test('detectSite 拒绝相似恶意域名、非法 URL、非 HTTP 协议和用户信息', () => {
  for (const url of [
    'https://aipoju.com.example.invalid/list',
    'not a URL',
    'file:///F:/video.mp4',
    'https://user:pass@aipoju.com/list',
  ]) {
    assert.throws(() => detectSite(url), { name: 'UsageError' });
  }
});

test('validateJob 设置默认 site 并保留合法字段', () => {
  const input = {
    url: 'https://tenant.example.invalid/course/1',
    name: 'lesson',
    index: 2,
    output: 'F:\\temp\\xf-video-tests\\lesson.mp4',
  };
  assert.deepEqual(validateJob(input), { ...input, site: 'auto' });
  assert.deepEqual(
    validateJob({ url: input.url, site: 'xiaoe' }),
    { url: input.url, site: 'xiaoe' },
  );
});

test('validateJob 拒绝结构、字段、URL、site、name 和 index 错误', () => {
  for (const input of [null, [], 'job', 1]) {
    assert.throws(() => validateJob(input, 3), { name: 'UsageError', message: '第 4 项任务必须是对象' });
  }
  const url = 'https://tenant.example.invalid/course/1';
  const invalid = [
    { url, extra: true },
    { url: 'javascript:alert(1)' },
    { url, site: 'unknown' },
    { url, name: '   ' },
    { url, name: 1 },
    { url, index: 0 },
    { url, index: 1.5 },
    { url, index: '1' },
  ];
  for (const input of invalid) assert.throws(() => validateJob(input), { name: 'UsageError' });
});

test('expandGet 展开 aipoju 序号、保序去重并自动识别站点', () => {
  const url = 'https://tenant.aipoju.com/replays';
  assert.deepEqual(expandGet(url, { site: 'auto', index: '2,1,2' }), [
    { url, site: 'auto', index: 2, output: undefined },
    { url, site: 'auto', index: 1, output: undefined },
  ]);
});

test('expandGet 为单项任务生成清理后的显式输出路径', () => {
  const url = 'https://tenant.example.invalid/course/1';
  const output = 'F:\\temp\\xf-video-tests\\clip:part.mp4';
  assert.deepEqual(expandGet(url, { site: 'xiaoe', output }), [
    {
      url,
      site: 'xiaoe',
      index: undefined,
      output: 'F:\\temp\\xf-video-tests\\clip_part.mp4',
    },
  ]);
});

test('expandGet 拒绝非法 site、非 aipoju 序号及不合法的多项输出', () => {
  const aipoju = 'https://tenant.aipoju.com/replays';
  const ordinary = 'https://tenant.example.invalid/course/1';
  const output = 'F:\\temp\\xf-video-tests\\out.mp4';
  assert.throws(() => expandGet(ordinary, { site: 'bad' }), { name: 'UsageError' });
  assert.throws(() => expandGet(ordinary, { site: 'xiaoe', index: '1' }), { name: 'UsageError' });
  assert.throws(() => expandGet(aipoju, { index: '1,2', output }), { name: 'UsageError' });
  assert.throws(() => expandGet(aipoju, { output }), { name: 'UsageError' });
  assert.throws(() => expandGet(aipoju, { index: '0' }), { name: 'UsageError' });
});
