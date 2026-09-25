// Tiny HTTP helpers. No framework, on purpose.

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

export function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return null;
  // IPv6 literal: [::1]:4173
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    if (end === -1) return null;
    return hostHeader.slice(1, end).toLowerCase();
  }
  const colon = hostHeader.indexOf(':');
  const host = colon === -1 ? hostHeader : hostHeader.slice(0, colon);
  return host.toLowerCase();
}

export function isLoopbackHostname(name) {
  if (!name) return false;
  return LOOPBACK_HOSTNAMES.has(name.toLowerCase());
}

/**
 * Blunt DNS-rebinding and any cross-origin page poking at us.
 * `Host` must be loopback; `Origin`/`Referer`, when present, must be loopback too.
 * Returns null when acceptable, otherwise a plain-English reason.
 */
export function checkLoopback(req) {
  const host = hostnameOf(req.headers.host);
  if (!isLoopbackHostname(host)) {
    return 'This server only answers requests addressed to localhost.';
  }

  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return 'This request came from an origin that could not be understood.';
    }
    if (!isLoopbackHostname(parsed.hostname)) {
      return 'This server only accepts requests from pages served on localhost.';
    }
  }

  const referer = req.headers.referer;
  if (typeof referer === 'string' && referer !== '') {
    let parsed;
    try {
      parsed = new URL(referer);
      if (!isLoopbackHostname(parsed.hostname)) {
        return 'This server only accepts requests from pages served on localhost.';
      }
    } catch {
      // A malformed Referer is not worth rejecting a request over.
    }
  }

  return null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/i;

/** Slugs come off a URL. Anything that is not a plain slug is rejected before it touches a path. */
export function isSafeSlug(value) {
  return typeof value === 'string' && SLUG_RE.test(value) && !value.includes('..');
}
