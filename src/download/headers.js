'use strict';

const BLOCKED_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade',
  'keep-alive', 'proxy-connection', 'accept-encoding', 'range', 'if-range',
]);
const REDIRECT_SENSITIVE = new Set([
  'cookie', 'authorization', 'proxy-authorization', 'x-api-key',
  'x-auth-token', 'x-access-token', 'x-amz-security-token',
]);
const SENSITIVE_HEADER_PATTERN = /(?:^|-)(?:tokens?|api-keys?|apikeys?|signatures?|signs?|auths?|credentials?|secrets?)(?:-|$)/i;

function sanitizeMediaHeaders(input = {}) {
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(input || {})) {
    const name = rawName.toLowerCase();
    const value = String(rawValue ?? '');
    if (name.startsWith(':') || name.startsWith('sec-') || BLOCKED_HEADERS.has(name)) continue;
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\r\n]/.test(value)) continue;
    headers[name] = value;
  }
  return headers;
}

function headersForRedirect(headers, fromUrl, toUrl) {
  const next = { ...headers };
  if (new URL(fromUrl).origin !== new URL(toUrl).origin) {
    for (const name of Object.keys(next)) {
      if (REDIRECT_SENSITIVE.has(name) || SENSITIVE_HEADER_PATTERN.test(name)) {
        delete next[name];
      }
    }
    if (next.referer) next.referer = `${new URL(fromUrl).origin}/`;
  }
  return next;
}

module.exports = { sanitizeMediaHeaders, headersForRedirect };
