'use strict';

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}

class DownloadError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'DownloadError';
    this.exitCode = 1;
    if (options?.code) this.code = options.code;
  }
}

module.exports = { UsageError, DownloadError };
