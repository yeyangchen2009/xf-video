'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { main } = require('../src/cli');

const bin = path.resolve(__dirname, '../bin/xf-video.js');

test('两个命令别名共用可执行入口，help/version 正常', () => {
  for (const args of [['--version'], ['--help'], ['unknown']]) {
    const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
    if (args[0] === '--version') assert.equal(result.stdout.trim(), require('../package.json').version);
    if (args[0] === '--help') assert.match(result.stdout, /xfv get/);
    if (args[0] === 'unknown') assert.equal(result.status, 2);
  }
});

test('未知选项与互斥输出参数返回 2', async () => {
  assert.equal(await main(['get', 'https://example.com', '--unknown']), 2);
  assert.equal(await main(['get', 'https://example.com', '-o', 'x.mp4', '--output-dir', 'x']), 2);
  assert.equal(await main(['get', 'https://example.com', '--index', '1']), 2);
});

test('错误日志不会泄露 URL 签名和鉴权头', async () => {
  const { redact } = require('../src/utils/redact');
  const text = redact('https://user:pass@example.com/v.mp4?sign=secret#token Cookie: abc Authorization: Bearer xyz');
  assert.doesNotMatch(text, /secret|abc|xyz|user:pass/);
});

test('login 非法链接返回 2，合法链接调用浏览器登录并返回 0', async () => {
  assert.equal(await main(['login', 'not-a-url']), 2);
  assert.equal(await main(['login']), 2);

  const originalLoad = Module._load;
  let calledWith = null;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename?.endsWith(path.join('src', 'cli.js')) && request === './browser/session') {
      return { login: async (url, profileDir) => { calledWith = { url, profileDir }; } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const url = 'https://app8dgz7pal7696.h5.xiaoeknow.com/p/course/video/v_demo';
    const code = await main(['login', url]);
    assert.equal(code, 0);
    assert.equal(calledWith.url, url);
    assert.match(calledWith.profileDir, /[\\/].xf-video[\\/]profiles[\\/]default$/);
  } finally {
    Module._load = originalLoad;
  }
});

test('SIGINT 中断任务时返回 130，不被单任务 catch 吞成 1', async () => {
  const originalLoad = Module._load;
  const jobsPath = require.resolve('../src/jobs');
  const cachedJobs = require.cache[jobsPath];
  delete require.cache[jobsPath];
  Module._load = function (request, parent, isMain) {
    if (parent?.filename?.endsWith(path.join('src', 'jobs.js'))) {
      if (request === './browser/session') {
        return { withBrowser: async (_profileDir, _options, callback) => callback({}) };
      }
      if (request === './sites/feishu') {
        return {
          resolveFeishu: (_context, _job, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
              reject(options.signal.reason || new Error('下载已中止'));
            }, { once: true });
          }),
        };
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const pending = main(['get', 'https://tenant.feishu.cn/minutes/demo', '--site', 'feishu']);
    await new Promise(resolve => setImmediate(resolve));
    process.emit('SIGINT');
    assert.equal(await pending, 130);
  } finally {
    Module._load = originalLoad;
    delete require.cache[jobsPath];
    if (cachedJobs) require.cache[jobsPath] = cachedJobs;
  }
});
