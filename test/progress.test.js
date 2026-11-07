'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProgressParser, formatProgressClock } = require('../src/download/progress');

test('formatProgressClock 支持 ffmpeg 时钟串与微秒整数，拒绝非法值', () => {
  assert.equal(formatProgressClock('00:12:34.560000'), '00:12:34');
  assert.equal(formatProgressClock('1:02:03'), '01:02:03');
  assert.equal(formatProgressClock('3723400000'), '01:02:03');
  assert.equal(formatProgressClock('0'), '00:00:00');
  assert.equal(formatProgressClock('not-a-clock'), null);
  assert.equal(formatProgressClock(undefined), null);
  assert.equal(formatProgressClock(null), null);
});

test('解析器在 progress 块收尾时上报处理时间与速度', () => {
  const lines = [];
  const parser = createProgressParser('FFmpeg HLS 下载', { intervalMs: 0, log: line => lines.push(line) });
  parser(Buffer.from('out_time=00:00:10.000000\nspeed=2.0x\nprogress=continue\n'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^FFmpeg HLS 下载 已处理 00:00:10，速度 2\.0x$/);
});

test('解析器按间隔节流，progress=end 强制收尾且只输出一次', () => {
  const lines = [];
  const parser = createProgressParser('整段解码验收', { intervalMs: 60000, log: line => lines.push(line) });
  const block = 'out_time_us=60000000\nout_time=00:01:00.000000\nspeed=1.0x\nprogress=continue\n';
  parser(Buffer.from(block));
  parser(Buffer.from(block));
  assert.equal(lines.length, 1);
  parser(Buffer.from('out_time=00:02:00.000000\nprogress=end\n'));
  parser(Buffer.from('out_time=00:03:00.000000\nprogress=end\n'));
  assert.equal(lines.length, 2);
  assert.match(lines[1], /00:02:00/);
});

test('解析器处理跨 chunk 截断与无时间字段的块', () => {
  const lines = [];
  const parser = createProgressParser('FFmpeg HLS 下载', { intervalMs: 0, log: line => lines.push(line) });
  const stream = 'frame=42\nout_time=00:00:05.000000\nspeed=N/A\nprogress=continue\n';
  for (const char of stream) parser(Buffer.from(char));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /已处理 00:00:05$/);

  const before = lines.length;
  parser(Buffer.from('frame=1\nprogress=continue\n'));
  assert.equal(lines.length, before);
});

test('解析器输出只含时间与速度，不携带 URL 或签名', () => {
  const lines = [];
  const parser = createProgressParser('FFmpeg HLS 下载', { intervalMs: 0, log: line => lines.push(line) });
  parser(Buffer.from('out_time=00:00:01.000000\nspeed=1.0x\nprogress=end\n'));
  assert.doesNotMatch(lines.join('\n'), /https?:|sign|token|cookie/i);
});
