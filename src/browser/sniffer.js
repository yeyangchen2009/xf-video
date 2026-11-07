'use strict';

const { DownloadError } = require('../errors');
const { startPlayback } = require('./session');

function classifyMedia(url, contentType = '', resourceType = '') {
  if (!/^https?:\/\//i.test(url)) return null;
  let pathname;
  try { pathname = new URL(url).pathname.toLowerCase(); } catch { return null; }
  const type = String(contentType).toLowerCase();
  if (pathname.endsWith('.m3u8') || type.includes('mpegurl')) return 'hls';
  if (pathname.endsWith('.mp4') || type.startsWith('video/mp4')) return 'mp4';
  if (resourceType === 'media' && type.startsWith('video/')) return 'video';
  return null;
}

function createSniffer(context, options = {}) {
  const candidates = [];
  const byUrl = new Map();
  const pending = new Set();
  const pages = new Map();

  function capture(request, response) {
    const kind = classifyMedia(request.url(), response?.headers()['content-type'], request.resourceType());
    if (!kind) return;
    let item = byUrl.get(request.url());
    if (!item) {
      item = { url: request.url(), kind, headers: {}, status: 0, order: candidates.length };
      byUrl.set(item.url, item);
      candidates.push(item);
    } else if (item.kind !== 'hls' && kind === 'hls') item.kind = kind;
    if (response) item.status = response.status();
    const task = request.allHeaders().then(headers => {
      item.headers = { ...headers };
    }).catch(() => {}).finally(() => pending.delete(task));
    pending.add(task);
  }

  function watch(page) {
    if (pages.has(page)) return;
    const onRequest = request => capture(request, null);
    const onResponse = response => capture(response.request(), response);
    pages.set(page, { onRequest, onResponse });
    page.on('request', onRequest);
    page.on('response', onResponse);
  }
  if (options.watchExisting !== false) for (const page of context.pages()) watch(page);
  context.on('page', watch);
  return {
    candidates,
    watch,
    async drain() { await Promise.allSettled([...pending]); },
    dispose() {
      context.off('page', watch);
      for (const [page, handlers] of pages) {
        page.off('request', handlers.onRequest);
        page.off('response', handlers.onResponse);
      }
      pages.clear();
    },
  };
}

async function enrichHeaders(context, media) {
  if (!media || media.headers.cookie) return;
  try {
    const cookies = await context.cookies([media.url]);
    if (cookies.length) media.headers.cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  } catch {}
}

function isLoginPage(url) {
  return /login(?:\/auth)?|\/login/i.test(new URL(url).pathname);
}

const ACCESS_BLOCK_HINT = '若账号已购买，请先对同一 profile 执行 xfv login 刷新登录态；未购买的内容无法下载';

// 未授权时小鹅通服务端会把播放页重写到 /v1/goods/goods_detail/ 商品页，
// 页面只有「前往购买」、没有任何 video 元素。返回可读原因，检测失败时返回 null。
async function detectAccessBlock(page) {
  let url;
  try { url = page.url(); } catch { return null; }
  let pathname;
  try { pathname = new URL(url).pathname; } catch { return null; }
  if (pathname.includes('goods_detail')) {
    return '页面跳转到商品详情页，当前账号无播放权限或登录态已失效';
  }
  let text = '';
  try {
    text = await page.evaluate(() => (document.body && document.body.innerText) || '');
  } catch { return null; }
  if (text.includes('前往购买')) return '页面要求购买后才能播放，当前账号无权限';
  return null;
}

async function openAndSniff(context, url, options = {}) {
  const sniffer = createSniffer(context, { watchExisting: false });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeout || 60000 });
    if (isLoginPage(page.url())) throw new DownloadError('登录态已失效，请先对同一 profile 执行 xfv login');
    const blockReason = await detectAccessBlock(page);
    if (blockReason) throw new DownloadError(`${blockReason}。${ACCESS_BLOCK_HINT}`);
    const deadline = Date.now() + (options.timeout || 90000);
    const passiveUntil = Date.now() + (options.passiveMs ?? 20000);
    let nextPlay = passiveUntil;
    while (!sniffer.candidates.length && Date.now() < deadline) {
      if (page.isClosed()) throw new DownloadError('媒体嗅探期间页面被关闭');
      if (options.active !== false && Date.now() >= nextPlay) {
        await startPlayback(page);
        nextPlay = Date.now() + 20000;
      }
      await page.waitForTimeout(1000);
    }
    await sniffer.drain();
    if (!sniffer.candidates.length) throw new DownloadError('未嗅探到可下载的 MP4 或 HLS 媒体');
    for (const media of sniffer.candidates) await enrichHeaders(context, media);
    const title = await page.title().catch(() => 'video');
    return { media: sniffer.candidates, title, pageUrl: page.url() };
  } finally {
    await sniffer.drain();
    sniffer.dispose();
    await page.close().catch(() => {});
  }
}

module.exports = { classifyMedia, createSniffer, openAndSniff, isLoginPage, detectAccessBlock, ACCESS_BLOCK_HINT };
