'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyMedia, createSniffer, detectAccessBlock } = require('../src/browser/sniffer');
const { sanitizeMediaHeaders, headersForRedirect } = require('../src/download/headers');
const { parseContentRange } = require('../src/download/http');

test('媒体识别综合 URL、Content-Type 与 resourceType', () => {
  assert.equal(classifyMedia('https://cdn.test/a.m3u8?sign=x'), 'hls');
  assert.equal(classifyMedia('https://cdn.test/video', 'application/vnd.apple.mpegurl'), 'hls');
  assert.equal(classifyMedia('https://cdn.test/video', 'video/mp4', 'media'), 'mp4');
  assert.equal(classifyMedia('blob:https://example.com/id', 'video/mp4'), null);
  assert.equal(classifyMedia('https://cdn.test/a.js', 'text/javascript'), null);
});

test('跨 origin 重定向剥离凭证，同 origin 保留', () => {
  const headers = {
    cookie: 'a', authorization: 'b', referer: 'https://a.test/page?sign=secret',
    'x-api-key': 'c', 'x-auth-token': 'd', 'x-test-header': 'preserved',
  };
  assert.deepEqual(headersForRedirect(headers, 'https://a.test/v', 'https://a.test/next'), headers);
  const next = headersForRedirect(headers, 'https://a.test/v', 'https://b.test/next');
  assert.equal(next.cookie, undefined);
  assert.equal(next.authorization, undefined);
  assert.equal(next.referer, 'https://a.test/');
  assert.equal(next['x-api-key'], undefined);
  assert.equal(next['x-auth-token'], undefined);
  assert.equal(next['x-test-header'], 'preserved');
});

test('请求头过滤浏览器 pseudo/sec/hop-by-hop 和注入', () => {
  const headers = sanitizeMediaHeaders({
    ':authority': 'bad', 'sec-fetch-site': 'bad', host: 'bad', connection: 'bad',
    cookie: 'ok', 'x-token': 'ok', 'x-bad': 'x\r\ny',
  });
  assert.deepEqual(headers, { cookie: 'ok', 'x-token': 'ok' });
});

test('sniffer dispose 解绑已有页面的全部监听器', () => {
  const { EventEmitter } = require('node:events');
  const page = new EventEmitter();
  const context = new EventEmitter();
  context.pages = () => [page];
  const sniffer = createSniffer(context);
  assert.equal(page.listenerCount('request'), 1);
  assert.equal(page.listenerCount('response'), 1);
  sniffer.dispose();
  assert.equal(page.listenerCount('request'), 0);
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(context.listenerCount('page'), 0);
});

test('Content-Range 严格解析', () => {
  assert.deepEqual(parseContentRange('bytes 10-19/100'), { start: 10, end: 19, total: 100 });
  assert.deepEqual(parseContentRange('bytes */100'), { start: null, end: null, total: 100 });
  assert.equal(parseContentRange('bytes nope'), null);
});

test('detectAccessBlock 识别 goods_detail 落地页与「前往购买」文案，正常页面放行', async () => {
  const goodsPage = {
    url: () => 'https://tenant.h5.xiaoeknow.com/v1/goods/goods_detail/p_demo',
    evaluate: async () => '',
  };
  assert.match(await detectAccessBlock(goodsPage), /商品详情页/);

  const buyPage = {
    url: () => 'https://tenant.h5.xiaoeknow.com/v4/course/alive/l_demo',
    evaluate: async () => '限时优惠 前往购买 立即订阅',
  };
  assert.match(await detectAccessBlock(buyPage), /购买/);

  const normalPage = {
    url: () => 'https://tenant.h5.xiaoeknow.com/p/course/video/v_demo',
    evaluate: async () => '课程正文与播放器',
  };
  assert.equal(await detectAccessBlock(normalPage), null);

  const closedPage = { url: () => { throw new Error('page closed'); }, evaluate: async () => '' };
  assert.equal(await detectAccessBlock(closedPage), null);
});
