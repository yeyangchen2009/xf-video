'use strict';

const fsp = require('node:fs/promises');
const readline = require('node:readline/promises');
const { chromium } = require('playwright-core');
const { DownloadError } = require('../errors');
const { publicError } = require('../utils/redact');

async function launchBrowser(profileDir, options = {}) {
  await fsp.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const launch = {
    headless: options.headless ?? false,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: false,
  };
  if (options.edge) launch.executablePath = options.edge;
  else launch.channel = 'msedge';
  try {
    return await chromium.launchPersistentContext(profileDir, launch);
  } catch (error) {
    throw new DownloadError(`无法启动 Edge；请确认浏览器已安装且 profile 未被其他实例占用: ${publicError(error)}`, { cause: error });
  }
}

async function withBrowser(profileDir, options, callback) {
  const context = await launchBrowser(profileDir, options);
  try {
    return await callback(context);
  } finally {
    await context.close().catch(() => {});
  }
}

async function login(url, profileDir, options = {}) {
  await withBrowser(profileDir, options, async context => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('请在打开的 Edge 中完成登录。完成后回到终端按 Enter；也可以直接关闭本次浏览器。');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let closed;
    const browserClosed = new Promise(resolve => {
      closed = () => resolve('closed');
      context.once('close', closed);
    });
    try {
      const answer = await Promise.race([
        rl.question('登录完成后按 Enter...').then(() => 'entered'),
        browserClosed,
      ]);
      console.log(answer === 'entered' ? '正在关闭浏览器并保存 profile。' : '浏览器已关闭。');
    } finally {
      context.off('close', closed);
      rl.close();
    }
  });
}

async function startPlayback(page) {
  let played = 0;
  for (const frame of page.frames()) {
    try {
      played += await frame.evaluate(() => {
        let count = 0;
        for (const video of document.querySelectorAll('video')) {
          try {
            video.muted = true;
            const promise = video.play();
            if (promise?.catch) promise.catch(() => {});
            count++;
          } catch {}
        }
        return count;
      });
    } catch {}
  }
  if (!played) {
    for (const selector of ['.vjs-big-play-button', '[class*="play-button"]', '[class*="playBtn"]', 'button[aria-label*="播放"]']) {
      try {
        const element = page.locator(selector).first();
        if (await element.count() && await element.isVisible()) {
          await element.click({ timeout: 3000 });
          played = 1;
          break;
        }
      } catch {}
    }
  }
  return played;
}

module.exports = { launchBrowser, withBrowser, login, startPlayback };
