'use strict';

const SENSITIVE_QUERY = /([?&](?:sign|sig|token|auth|key|signature|x-[a-z-]*signature|x-amz-security-token|cookie|session)[^=]*=)[^&#\s]+/gi;
const SENSITIVE_HEADER = /\b(cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-access-token|x-amz-security-token)\s*[:=]\s*([^\r\n]*?)(;?)(?=\s*(?:\b(?:cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-access-token|x-amz-security-token)\s*[:=]|$))/gim;

function redactUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/[a-f0-9]{64}(?=\/|\.|$)/gi, '/REDACTED');
    return url.toString();
  } catch {
    return String(value);
  }
}

function redact(value) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, match => {
      const trailing = match.match(/[),.;!\]}]+$/)?.[0] || '';
      return redactUrl(match.slice(0, match.length - trailing.length)) + trailing;
    })
    .replace(SENSITIVE_HEADER, '$1: <redacted>$3')
    .replace(SENSITIVE_QUERY, '$1<redacted>');
}

function publicError(error) {
  return redact(error?.message || error || '未知错误');
}

module.exports = { redact, redactUrl, publicError };
