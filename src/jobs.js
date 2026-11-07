'use strict';

const path = require('node:path');
const { UsageError, DownloadError } = require('./errors');
const { resolveOutput, sanitizeFilename, parseIndices } = require('./utils/filename');
const { publicError } = require('./utils/redact');
const { withBrowser } = require('./browser/session');
const { downloadHttp, partPath } = require('./download/http');
const { downloadHls } = require('./download/ffmpeg');
const { finalizeMedia, skipIfValid } = require('./download/finalize');
const { resolveXiaoe } = require('./sites/xiaoe');
const { resolveXiaoeLive } = require('./sites/xiaoe-live');
const { resolveFeishu } = require('./sites/feishu');
const { resolveAipoju, countAipoju } = require('./sites/aipoju');

const SITES = new Set(['auto', 'xiaoe', 'xiaoe-live', 'feishu', 'aipoju']);
const RESOLVERS = { xiaoe: resolveXiaoe, 'xiaoe-live': resolveXiaoeLive, feishu: resolveFeishu, aipoju: resolveAipoju };

function parseHttpUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new UsageError('请输入完整的 HTTP/HTTPS 链接'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new UsageError('链接只支持不含用户信息的 HTTP/HTTPS URL');
  }
  return url;
}

function detectSite(value) {
  const url = parseHttpUrl(value);
  const host = url.hostname.toLowerCase();
  if (host === 'aipoju.com' || host.endsWith('.aipoju.com')) return 'aipoju';
  if (host === 'feishu.cn' || host.endsWith('.feishu.cn')) return 'feishu';
  if (['xiaoeknow.com', 'xetlk.com', 'xetslk.com', 'xet.tech'].some(domain => host === domain || host.endsWith(`.${domain}`))) {
    return url.pathname.includes('/v4/course/alive/') ? 'xiaoe-live' : 'xiaoe';
  }
  throw new UsageError('无法识别站点，请使用 --site xiaoe、xiaoe-live、feishu 或 aipoju');
}

function validateJob(input, position = 0) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UsageError(`第 ${position + 1} 项任务必须是对象`);
  const allowed = new Set(['url', 'site', 'name', 'index', 'output']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new UsageError(`第 ${position + 1} 项含未知字段: ${key}`);
  parseHttpUrl(input.url);
  const site = input.site || 'auto';
  if (!SITES.has(site)) throw new UsageError(`第 ${position + 1} 项 site 无效`);
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) throw new UsageError(`第 ${position + 1} 项 name 不能为空`);
  if (input.index !== undefined && (!Number.isInteger(input.index) || input.index < 1)) throw new UsageError(`第 ${position + 1} 项 index 必须是正整数`);
  return { ...input, site };
}

function explicitTarget(value) {
  const resolved = path.resolve(value);
  if (path.extname(resolved).toLowerCase() !== '.mp4') throw new UsageError('-o 必须以 .mp4 结尾');
  const stem = sanitizeFilename(path.basename(resolved, '.mp4'));
  return path.join(path.dirname(resolved), `${stem}.mp4`);
}

function reserveOutput(reservations, target) {
  for (const file of [target, partPath(target)]) {
    const resolved = path.resolve(file);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (reservations.has(key)) throw new UsageError(`多个任务的正式文件或半成品路径冲突: ${target}`);
    reservations.add(key);
  }
}

async function runJobs(jobs, options) {
  if (!jobs.length) return [];
  const results = [];
  const reservations = new Set();
  for (const job of jobs) {
    if (job.output) reserveOutput(reservations, job.output);
  }
  await withBrowser(options.profileDir, { edge: options.tools.edge }, async context => {
    const expanded = [];
    for (const job of jobs) {
      const site = job.site === 'auto' ? detectSite(job.url) : job.site;
      if (site === 'aipoju' && !job.index) {
        const total = await countAipoju(context, job.url);
        if (!total) throw new DownloadError('aipoju 页面未找到回放卡片');
        for (let index = 1; index <= total; index++) expanded.push({ ...job, site, index });
      } else expanded.push({ ...job, site });
    }
    jobs = expanded;
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      try {
        const site = job.site === 'auto' ? detectSite(job.url) : job.site;
        if (site === 'aipoju' && !job.index) throw new UsageError('aipoju 任务必须指定 index');
        if (site !== 'aipoju' && job.index) throw new UsageError('index 只能用于 aipoju');
        if (job.output) {
          const skipped = await skipIfValid(job.output, options.tools, options);
          if (skipped) {
            console.log(`[${i + 1}/${jobs.length}] 已验收，跳过: ${path.basename(job.output)}`);
            results.push({ status: 'skipped', file: job.output });
            continue;
          }
        }
        console.log(`[${i + 1}/${jobs.length}] 正在识别 ${site} 媒体...`);
        const resolved = await RESOLVERS[site](context, job, options);
        const target = job.output || resolveOutput(options.outputDir, job.name || resolved.title);
        if (!job.output) reserveOutput(reservations, target);
        const skipped = await skipIfValid(target, options.tools, options);
        if (skipped) {
          console.log(`已验收，跳过: ${path.basename(target)}`);
          results.push({ status: 'skipped', file: target });
          continue;
        }
        const onProgress = (bytes, total) => {
          const mb = (bytes / 1024 / 1024).toFixed(1);
          console.log(total ? `已下载 ${mb} MB / ${(total / 1024 / 1024).toFixed(1)} MB` : `已下载 ${mb} MB`);
        };
        const downloaded = resolved.media.kind === 'mp4'
          ? await downloadHttp(resolved.media, target, { ...options, onProgress })
          : await downloadHls(resolved.media, target, options.tools, options);
        const final = await finalizeMedia(downloaded.file, target, options.tools, options);
        console.log(`完成: ${final.file}（${(final.duration / 60).toFixed(1)} 分钟）`);
        results.push({ status: 'ok', file: target });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        results.push({ status: 'failed', error: publicError(error) });
        console.error(`失败: ${publicError(error)}`);
        if (context.browser() && !context.browser().isConnected()) throw error;
      }
    }
  });
  return results;
}

function expandGet(url, options) {
  const site = options.site || 'auto';
  if (!SITES.has(site)) throw new UsageError('--site 值无效');
  const resolvedSite = site === 'auto' ? detectSite(url) : site;
  if (options.index && resolvedSite !== 'aipoju') throw new UsageError('--index 只能用于 aipoju');
  const indices = resolvedSite === 'aipoju' ? (parseIndices(options.index) || [null]) : [null];
  if (indices.length > 1 && options.output) throw new UsageError('多项下载不能使用 -o，请改用 --output-dir');
  if (resolvedSite === 'aipoju' && indices[0] === null && options.output) {
    throw new UsageError('aipoju 使用 -o 时必须通过 --index 指定单个回放');
  }
  return indices.map(index => validateJob({
    url, site, index: index || undefined,
    output: options.output ? explicitTarget(options.output) : undefined,
  }));
}

module.exports = { parseHttpUrl, detectSite, validateJob, expandGet, runJobs, explicitTarget, reserveOutput };
