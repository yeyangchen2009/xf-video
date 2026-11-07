'use strict';

const { spawn } = require('node:child_process');
const { DownloadError } = require('./errors');
const { publicError } = require('./utils/redact');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options.spawn,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill();
      finish(new DownloadError(`${options.label || command} 执行超时`));
    }, options.timeout || 120000);
    timeout.unref();

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(result);
    }
    function onAbort() {
      child.kill();
      finish(new DownloadError('操作已中断'));
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (options.input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
    }
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > 65536) stdout = stdout.slice(-65536);
      if (options.onStdout) options.onStdout(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 65536) stderr = stderr.slice(-65536);
      if (options.onStderr) options.onStderr(chunk.toString());
    });
    child.on('error', error => finish(new DownloadError(
      `无法执行 ${options.label || command}: ${publicError(error)}`, { cause: error },
    )));
    child.on('close', (code, signal) => {
      if (code !== 0) {
        const detail = stderr.trim().slice(-3000);
        return finish(new DownloadError(
          `${options.label || command} 失败（退出码 ${code ?? signal}）${detail ? `: ${publicError(detail)}` : ''}`,
        ));
      }
      finish(null, { code, stdout, stderr });
    });
  });
}

module.exports = { run };
