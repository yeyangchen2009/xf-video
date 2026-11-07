'use strict';

const fsp = require('node:fs/promises');
const { constants } = require('node:fs');
const { DownloadError } = require('../errors');
const { metadataPath } = require('./http');
const { verifyMedia } = require('./verify');

async function finalizeMedia(part, target, tools, options = {}) {
  const result = await verifyMedia(part, tools, options);
  try {
    // Hard-link publication is atomic and never replaces an existing target.
    await fsp.link(part, target);
  } catch (error) {
    if (error.code === 'EEXIST') throw new DownloadError(`正式文件已存在，未覆盖: ${target}`);
    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
    try {
      await fsp.copyFile(part, target, constants.COPYFILE_EXCL);
    } catch (copyError) {
      if (copyError.code === 'EEXIST') throw new DownloadError(`正式文件已存在，未覆盖: ${target}`);
      throw copyError;
    }
    const [a, b] = await Promise.all([fsp.stat(part), fsp.stat(target)]);
    if (a.size !== b.size) throw new DownloadError('跨盘复制后文件大小不符');
  }
  await fsp.unlink(part);
  await fsp.rm(metadataPath(target), { force: true });
  return { ...result, file: target };
}

async function skipIfValid(target, tools, options = {}) {
  try {
    await fsp.access(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const result = await verifyMedia(target, tools, options);
    return { ...result, file: target, skipped: true };
  } catch (error) {
    throw new DownloadError(`正式文件已存在但未通过验收，未覆盖: ${target}；${error.message}`, { cause: error });
  }
}

module.exports = { finalizeMedia, skipIfValid };
