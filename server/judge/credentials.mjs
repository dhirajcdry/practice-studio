// The three LeetCode cookies, read from the macOS keychain at request time.
//
// Hard rules, and the reason this file is small and boring:
//
//  * Credentials are read on demand and never cached to disk, never written to a config
//    file, never put in a log line, and never included in an error message.
//  * A `Credentials` instance refuses to serialise itself. `JSON.stringify(creds)`,
//    `console.log(creds)` and string interpolation all produce a redacted placeholder, so
//    a careless debug line somewhere else in the tree cannot leak a session cookie.
//  * A missing keychain entry is a normal state — "nothing stored yet" — not an error to
//    throw. `security` exits non-zero for a missing item and that is simply `null` here.

import { execFile } from 'node:child_process';

export const KEYCHAIN_ACCOUNT = 'studio';
export const KEYCHAIN_SERVICES = Object.freeze({
  session: 'studio-leetcode-session',
  csrf: 'studio-leetcode-csrf',
  cfClearance: 'studio-leetcode-cfclearance',
});

const REDACTED = '[redacted]';

/**
 * One `security find-generic-password -w` lookup.
 * Resolves to the secret, or null when the item does not exist / the tool is unavailable.
 * The underlying error is deliberately dropped: it carries nothing actionable, and the
 * one thing we must never do is echo a failed keychain call into a log.
 */
function findGenericPassword(service, { execFileImpl = execFile, account = KEYCHAIN_ACCOUNT } = {}) {
  return new Promise((resolve) => {
    execFileImpl(
      'security',
      ['find-generic-password', '-a', account, '-s', service, '-w'],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const value = String(stdout ?? '').trim();
        resolve(value === '' ? null : value);
      },
    );
  });
}

/**
 * The credential bundle. Holds the secrets, and knows how to build the two things that
 * need them — the Cookie header and the x-csrftoken header — without ever handing the raw
 * values back to anything that formats output.
 */
export class Credentials {
  constructor({ session, csrf, cfClearance }) {
    this.session = session ?? null;
    this.csrf = csrf ?? null;
    this.cfClearance = cfClearance ?? null;
  }

  /** A submit needs a session and a CSRF token. cf_clearance is helpful, not mandatory:
   *  if Cloudflare is not challenging today, its absence must not block the user. */
  get complete() {
    return typeof this.session === 'string' && this.session !== '' &&
      typeof this.csrf === 'string' && this.csrf !== '';
  }

  /** Which of the required items are not stored — for a plain-English message that names
   *  the service, never the value. */
  get missing() {
    const out = [];
    if (!this.session) out.push(KEYCHAIN_SERVICES.session);
    if (!this.csrf) out.push(KEYCHAIN_SERVICES.csrf);
    return out;
  }

  /** Every secret string, for the scrubber. Never rendered. */
  secrets() {
    return [this.session, this.csrf, this.cfClearance].filter(
      (v) => typeof v === 'string' && v.length >= 8,
    );
  }

  cookieHeader() {
    const parts = [];
    if (this.session) parts.push(`LEETCODE_SESSION=${this.session}`);
    if (this.csrf) parts.push(`csrftoken=${this.csrf}`);
    if (this.cfClearance) parts.push(`cf_clearance=${this.cfClearance}`);
    return parts.join('; ');
  }

  // --- the anti-leak surface -------------------------------------------------
  toJSON() {
    return REDACTED;
  }

  toString() {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return 'Credentials { <redacted> }';
  }
}

/**
 * Read all three items. Never throws — a machine with no keychain, no `security` binary,
 * or nothing stored yet all produce the same clean "no session stored" bundle.
 * @returns {Promise<Credentials>}
 */
export async function readCredentials({ execFileImpl = execFile, account = KEYCHAIN_ACCOUNT } = {}) {
  const [session, csrf, cfClearance] = await Promise.all([
    findGenericPassword(KEYCHAIN_SERVICES.session, { execFileImpl, account }),
    findGenericPassword(KEYCHAIN_SERVICES.csrf, { execFileImpl, account }),
    findGenericPassword(KEYCHAIN_SERVICES.cfClearance, { execFileImpl, account }),
  ]);
  return new Credentials({ session, csrf, cfClearance });
}

/**
 * Replace every secret with a placeholder. Applied to every message and stack that can
 * reach a log line or an HTTP response, as the last line of defence rather than the first.
 */
export function scrubSecrets(text, secrets) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const secret of secrets ?? []) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Scrub an error in place — message and stack both. Returns the same error. */
export function scrubError(err, secrets) {
  if (!err || typeof err !== 'object') return err;
  try {
    if (typeof err.message === 'string') err.message = scrubSecrets(err.message, secrets);
    if (typeof err.stack === 'string') err.stack = scrubSecrets(err.stack, secrets);
  } catch {
    // A frozen error object is not worth crashing a request over.
  }
  return err;
}
