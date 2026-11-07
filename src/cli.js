'use strict';

const fsp = require('node:fs/promises');
const { parseArgs } = require('node:util');
const { UsageError } = require('./errors');
const { resolveProfile, resolveTools, resolveOutputDir } = require('./config');
const { publicError } = require('./utils/redact');
const { resolveOutput } = require('./utils/filename');

const HELP = `xf-video：小鹅通与飞书授权视频下载器

用法：
  xfv doctor [--output-dir 目录]
  xfv login <页面链接> [--profile 名称 | --profile-dir 目录]
  xfv get <页面链接> [--site auto|xiaoe|xiaoe-live|feishu|aipoju]
         [--index 1,3] [-o 文件.mp4 | --output-dir 目录]
  xfv batch <jobs.json> [--offset 0] [--limit N] [--output-dir 目录]

通用选项：
  --profile 名称       持久登录 profile，默认 default
  --profile-dir 目录  使用指定的已有浏览器 profile
  --edge 路径         本机 Edge 可执行文件
  --ffmpeg 路径       本机 FFmpeg，默认从 PATH 查找
  --ffprobe 路径      本机 FFprobe，默认从 PATH 查找

只下载本人已有权限的内容。登录由用户本人在浏览器中完成。
`;

function optionsSpec(command) {
  const common = {
    profile: { type: 'string' }, 'profile-dir': { type: 'string' },
    edge: { type: 'string' }, ffmpeg: { type: 'string' }, ffprobe: { type: 'string' },
    'output-dir': { type: 'string' }, timeout: { type: 'string' },
  };
  if (command === 'get') return {
    ...common, site: { type: 'string', default: 'auto' }, index: { type: 'string' },
    o: { type: 'string' },
  };
  if (command === 'batch') return { ...common, offset: { type: 'string' }, limit: { type: 'string' } };
  return common;
}

function commandOptions(values) {
  if (values.o && values['output-dir']) throw new UsageError('-o 与 --output-dir 不能同时使用');
  const timeout = values.timeout === undefined ? 7200000 : Number(values.timeout) * 1000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new UsageError('--timeout 必须是正数秒');
  return {
    profileDir: resolveProfile({ profile: values.profile, profileDir: values['profile-dir'] }),
    tools: resolveTools({ edge: values.edge, ffmpeg: values.ffmpeg, ffprobe: values.ffprobe }),
    outputDir: resolveOutputDir({ outputDir: values['output-dir'] }),
    output: values.o,
    site: values.site,
    index: values.index,
    timeout,
  };
}

function onePosition(positionals, command) {
  if (positionals.length !== 1) throw new UsageError(`${command} 需要一个位置参数`);
  return positionals[0];
}

function nonNegative(value, name, defaultValue) {
  if (value === undefined) return defaultValue;
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} 必须是非负整数`);
  return Number(value);
}

async function dispatch(command, positionals, values, signal) {
  const options = commandOptions(values);
  options.signal = signal;
  if (command === 'doctor') {
    if (positionals.length) throw new UsageError('doctor 不接受位置参数');
    const { doctor } = require('./doctor');
    return doctor(options);
  }
  if (command === 'login') {
    const url = onePosition(positionals, command);
    const { parseHttpUrl } = require('./jobs');
    parseHttpUrl(url);
    const { login } = require('./browser/session');
    await login(url, options.profileDir, { edge: options.tools.edge });
    return 0;
  }
  const { expandGet, validateJob, runJobs, explicitTarget, detectSite } = require('./jobs');
  if (command === 'get') {
    const jobs = expandGet(onePosition(positionals, command), options);
    const results = await runJobs(jobs, options);
    return results.some(result => result.status === 'failed') ? 1 : 0;
  }
  if (command === 'batch') {
    const file = onePosition(positionals, command);
    let data;
    try { data = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (error) {
      throw new UsageError(`无法读取 manifest: ${publicError(error)}`);
    }
    if (!Array.isArray(data)) throw new UsageError('manifest 顶层必须是 JSON 数组');
    const jobs = data.map(validateJob);
    for (const job of jobs) {
      if (!job.name) throw new UsageError('batch 中每项都必须提供 name');
      const site = job.site === 'auto' ? detectSite(job.url) : job.site;
      if (site === 'aipoju' && !job.index) throw new UsageError('batch 中每个 aipoju 任务必须指定单个 index');
      if (site !== 'aipoju' && job.index) throw new UsageError('index 只能用于 aipoju');
      job.output = resolveOutput(options.outputDir, job.name);
    }
    const offset = nonNegative(values.offset, '--offset', 0);
    const limit = nonNegative(values.limit, '--limit', jobs.length);
    if (values.limit !== undefined && limit < 1) throw new UsageError('--limit 必须是正整数');
    const results = await runJobs(jobs.slice(offset, offset + limit), options);
    const ok = results.filter(result => result.status === 'ok').length;
    const skipped = results.filter(result => result.status === 'skipped').length;
    const failed = results.filter(result => result.status === 'failed').length;
    console.log(`汇总：成功 ${ok}，跳过 ${skipped}，失败 ${failed}`);
    return failed ? 1 : 0;
  }
  throw new UsageError(`未知命令: ${command}`);
}

async function main(argv) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    console.log(HELP);
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(require('../package.json').version);
    return 0;
  }
  const command = argv[0];
  if (!['doctor', 'login', 'get', 'batch'].includes(command)) {
    console.error(`xfv: 未知命令 ${command}\n\n${HELP}`);
    return 2;
  }
  const controller = new AbortController();
  let interrupted = false;
  const onSigint = () => { interrupted = true; controller.abort(); };
  process.once('SIGINT', onSigint);
  try {
    const { values, positionals } = parseArgs({
      args: argv.slice(1), options: optionsSpec(command), allowPositionals: true, strict: true,
    });
    return await dispatch(command, positionals, values, controller.signal);
  } catch (error) {
    if (interrupted || controller.signal.aborted) return 130;
    const code = error.exitCode || (error.code?.startsWith?.('ERR_PARSE_ARGS') ? 2 : 1);
    console.error(`xfv: ${publicError(error)}`);
    return code;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

module.exports = { main, dispatch, commandOptions, HELP };
