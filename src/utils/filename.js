'use strict';

const path = require('node:path');
const { UsageError } = require('../errors');

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function sanitizeFilename(value, fallback = 'video') {
  let name = String(value ?? '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  if (!name) name = fallback;
  return [...name].slice(0, 120).join('').replace(/[. ]+$/g, '') || fallback;
}

function buildArchiveFilename(info = {}) {
  const parts = [];
  if (info.date) parts.push(String(info.date).replace(/-/g, ''));
  if (info.video_name) parts.push(sanitizeFilename(info.video_name));
  let stem = parts.length ? parts.join('-') : 'video';
  if (info.sharer) stem += `@${sanitizeFilename(info.sharer)}`;
  if (info.planet_number) stem += `-${String(info.planet_number).replace(/[^\w-]/g, '_')}`;
  return sanitizeFilename(stem);
}

function resolveOutput(outputDir, name) {
  const stem = sanitizeFilename(name);
  const directory = path.resolve(outputDir);
  const target = path.resolve(directory, `${stem}.mp4`);
  if (path.dirname(target) !== directory) {
    throw new UsageError('输出文件名不能包含路径');
  }
  return target;
}

function parseIndices(value, total = Infinity) {
  if (value === undefined || value === null || value === '') return null;
  const result = [];
  const seen = new Set();
  for (const part of String(value).split(',')) {
    if (!/^\d+$/.test(part.trim())) throw new UsageError('--index 只接受逗号分隔的正整数');
    const index = Number(part);
    if (!Number.isSafeInteger(index) || index < 1 || index > total) {
      throw new UsageError(`序号超出范围: ${part}`);
    }
    if (!seen.has(index)) {
      seen.add(index);
      result.push(index);
    }
  }
  if (!result.length) throw new UsageError('--index 不能为空');
  return result;
}

module.exports = { sanitizeFilename, buildArchiveFilename, resolveOutput, parseIndices };
