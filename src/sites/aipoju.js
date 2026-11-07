'use strict';

const { DownloadError } = require('../errors');
const { createSniffer, isLoginPage } = require('../browser/sniffer');
const { buildArchiveFilename } = require('../utils/filename');

const BUTTON_PATTERN = /观看直播\/回放|观看回放|直播回放/;

async function extractCards(page) {
  return page.evaluate(pattern => {
    const re = new RegExp(pattern);
    const results = [];
    document.querySelectorAll('.ant-card').forEach(card => {
      if (!re.test(card.innerText || '')) return;
      const pick = selector => card.querySelector(selector)?.innerText.trim() || '';
      const info = { date: '', video_name: pick('.ant-card-body .fw-600'), sharer: pick('.ant-card-head-title .fw-600'), planet_number: '' };
      const date = card.querySelector('.ant-tag')?.innerText.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (date) info.date = date.slice(1).join('');
      const number = (card.innerText || '').match(/星球编号[：:\s]*(\d+)/);
      if (number) info.planet_number = number[1];
      results.push(info);
    });
    return results;
  }, BUTTON_PATTERN.source);
}

async function countAipoju(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (isLoginPage(page.url())) throw new DownloadError('aipoju 登录态已失效，请先执行 xfv login');
    await page.waitForTimeout(3000);
    return (await page.getByText(BUTTON_PATTERN).all()).length;
  } finally {
    await page.close().catch(() => {});
  }
}

async function resolveAipoju(context, job) {
  const page = await context.newPage();
  const sniffer = createSniffer(context);
  let targetPage = null;
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (isLoginPage(page.url())) throw new DownloadError('aipoju 登录态已失效，请先执行 xfv login');
    await page.waitForTimeout(3000);
    const cards = await extractCards(page);
    const buttons = await page.getByText(BUTTON_PATTERN).all();
    const index = job.index;
    if (!Number.isInteger(index) || index < 1 || index > buttons.length) {
      throw new DownloadError(`aipoju 序号超出范围（当前 ${buttons.length} 个回放）`);
    }
    const newPage = context.waitForEvent('page', { timeout: 20000 }).catch(() => null);
    const samePage = page.waitForURL(url => url.hostname === 'feishu.cn' || url.hostname.endsWith('.feishu.cn'), { timeout: 20000 }).then(() => page).catch(() => null);
    await buttons[index - 1].click({ timeout: 15000 });
    targetPage = await Promise.race([newPage, samePage]);
    if (!targetPage) throw new DownloadError('未检测到飞书页面打开');
    sniffer.watch(targetPage);
    await targetPage.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
    if (isLoginPage(targetPage.url())) throw new DownloadError('飞书登录态已失效，请对同一 profile 执行 xfv login');

    const { startPlayback } = require('../browser/session');
    const deadline = Date.now() + 90000;
    const activeAt = Date.now() + 20000;
    let played = false;
    while (!sniffer.candidates.length && Date.now() < deadline) {
      if (targetPage.isClosed()) throw new DownloadError('妙记被动嗅探期间页面被关闭');
      if (!played && Date.now() >= activeAt) {
        played = true;
        await startPlayback(targetPage);
      }
      await targetPage.waitForTimeout(1000);
    }
    await sniffer.drain();
    const media = sniffer.candidates.find(item => item.kind === 'mp4') || sniffer.candidates.find(item => item.kind === 'hls');
    if (!media) throw new DownloadError('aipoju 跳转后未嗅探到受支持的飞书媒体');
    if (!media.headers.cookie) {
      const cookies = await context.cookies([media.url]).catch(() => []);
      if (cookies.length) media.headers.cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    }
    const title = buildArchiveFilename(cards[index - 1] || {});
    return { media: { ...media, pageUrl: targetPage.url() }, title };
  } finally {
    sniffer.dispose();
    if (targetPage && targetPage !== page) await targetPage.close().catch(() => {});
    await page.close().catch(() => {});
  }
}

module.exports = { extractCards, countAipoju, resolveAipoju, buildArchiveFilename };
