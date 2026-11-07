'use strict';

// ffmpeg `-progress pipe:1` 输出 key=value 块，每块以 progress=continue/end 收尾。
// 这里只解析 out_time/speed 两个时间字段，不接触任何 URL 或鉴权信息。
function formatProgressClock(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  const clock = /^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(text);
  if (clock) {
    const [, hours, minutes, seconds] = clock;
    return `${hours.padStart(2, '0')}:${minutes}:${seconds}`;
  }
  if (/^\d+$/.test(text)) {
    // out_time_us 为微秒；历史字段 out_time_ms 在部分构建中同样是微秒。
    const total = Math.floor(Number(text) / 1_000_000);
    if (!Number.isFinite(total) || total < 0) return null;
    const hours = String(Math.floor(total / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const seconds = String(total % 60).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }
  return null;
}

function createProgressParser(label, options = {}) {
  const intervalMs = options.intervalMs ?? 5000;
  const log = options.log ?? (line => console.log(line));
  let buffer = '';
  let block = new Map();
  let lastEmit = 0;
  let finished = false;

  function emit(force) {
    const now = Date.now();
    if (!force && now - lastEmit < intervalMs) return;
    const clock = formatProgressClock(block.get('out_time'))
      ?? formatProgressClock(block.get('out_time_us'))
      ?? formatProgressClock(block.get('out_time_ms'));
    if (!clock) return;
    lastEmit = now;
    const speed = block.get('speed');
    const speedText = speed && speed !== 'N/A' && speed.endsWith('x') ? `，速度 ${speed}` : '';
    log(`${label} 已处理 ${clock}${speedText}`);
  }

  return function onProgressChunk(chunk) {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      if (key !== 'progress') {
        block.set(key, value);
        continue;
      }
      if (value === 'end') {
        if (!finished) {
          finished = true;
          emit(true);
        }
      } else {
        emit(false);
      }
      block = new Map();
    }
  };
}

module.exports = { createProgressParser, formatProgressClock };
