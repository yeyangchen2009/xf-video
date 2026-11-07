'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { run } = require('./exec');
const { dataHome, tempRoot } = require('./config');
const { launchBrowser } = require('./browser/session');
const { publicError } = require('./utils/redact');

async function checkWritable(directory) {
  await fsp.mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.xfv-write-${process.pid}-${Date.now()}`);
  await fsp.writeFile(probe, '', { flag: 'wx' });
  await fsp.unlink(probe);
}

async function doctor(options) {
  const checks = [];
  async function check(name, fn) {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail });
      console.log(`✓ ${name}${detail ? `: ${detail}` : ''}`);
    } catch (error) {
      checks.push({ name, ok: false, detail: publicError(error) });
      console.error(`✗ ${name}: ${publicError(error)}`);
    }
  }
  await check('Node.js', async () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 22) throw new Error('需要 Node.js 22 或更高版本');
    return process.version;
  });
  await check('FFmpeg', async () => (await run(options.tools.ffmpeg, ['-version'], { timeout: 15000 })).stdout.split(/\r?\n/)[0]);
  await check('FFprobe', async () => (await run(options.tools.ffprobe, ['-version'], { timeout: 15000 })).stdout.split(/\r?\n/)[0]);
  await check('用户数据目录', () => checkWritable(dataHome()).then(() => dataHome()));
  await check('默认输出目录', () => checkWritable(options.outputDir).then(() => options.outputDir));
  await check('Edge 启动', async () => {
    const root = tempRoot();
    await fsp.mkdir(root, { recursive: true });
    const profile = await fsp.mkdtemp(path.join(root, 'xfv-doctor-'));
    try {
      const context = await launchBrowser(profile, { edge: options.tools.edge, headless: true });
      await context.close();
      return '本机浏览器可用';
    } finally {
      await fsp.rm(profile, { recursive: true, force: true });
    }
  });
  return checks.every(item => item.ok) ? 0 : 1;
}

module.exports = { doctor, checkWritable };
