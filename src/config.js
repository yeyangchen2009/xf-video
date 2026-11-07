'use strict';

const os = require('node:os');
const path = require('node:path');
const { UsageError } = require('./errors');

function dataHome(env = process.env) {
  return path.resolve(env.XF_VIDEO_HOME || path.join(os.homedir(), '.xf-video'));
}

function resolveProfile(options = {}, env = process.env) {
  if (options.profile && options.profileDir) {
    throw new UsageError('--profile 与 --profile-dir 不能同时使用');
  }
  if (options.profileDir) return path.resolve(options.profileDir);
  const name = options.profile || 'default';
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) || name === '.' || name === '..') {
    throw new UsageError('profile 名称只能包含字母、数字、点、下划线和连字符');
  }
  return path.join(dataHome(env), 'profiles', name);
}

function resolveTools(options = {}, env = process.env) {
  return {
    edge: options.edge || env.XF_VIDEO_EDGE || undefined,
    ffmpeg: options.ffmpeg || env.XF_VIDEO_FFMPEG || 'ffmpeg',
    ffprobe: options.ffprobe || env.XF_VIDEO_FFPROBE || 'ffprobe',
  };
}

function resolveOutputDir(options = {}, cwd = process.cwd()) {
  return path.resolve(cwd, options.outputDir || 'downloads');
}

function tempRoot(env = process.env) {
  return path.resolve(env.XF_VIDEO_TEMP || os.tmpdir());
}

module.exports = { dataHome, resolveProfile, resolveTools, resolveOutputDir, tempRoot };
