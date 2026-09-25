// The keychain read and the anti-leak surface. No `security` binary is ever invoked: the
// child_process call is injected.

import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import {
  Credentials,
  KEYCHAIN_SERVICES,
  readCredentials,
  scrubError,
  scrubSecrets,
} from '../credentials.mjs';
import { FAKE_CF, FAKE_CSRF, FAKE_SECRETS, FAKE_SESSION, emptyKeychain, keychainWith } from './helpers.mjs';

test('all three items are read from the right keychain services', async () => {
  const seen = [];
  const creds = await readCredentials({
    execFileImpl: (bin, args, opts, cb) => {
      seen.push({ bin, args });
      return keychainWith()(bin, args, opts, cb);
    },
  });
  assert.equal(creds.session, FAKE_SESSION);
  assert.equal(creds.csrf, FAKE_CSRF);
  assert.equal(creds.cfClearance, FAKE_CF);
  assert.equal(creds.complete, true);

  assert.deepEqual(seen.map((s) => s.bin), ['security', 'security', 'security']);
  const services = seen.map((s) => s.args[s.args.indexOf('-s') + 1]).sort();
  assert.deepEqual(services, Object.values(KEYCHAIN_SERVICES).sort());
  for (const { args } of seen) {
    assert.ok(args.includes('-w'), 'reads the password only');
    assert.equal(args[args.indexOf('-a') + 1], 'studio');
  }
});

test('a failed keychain lookup is "nothing stored", never a throw', async () => {
  const creds = await readCredentials({ execFileImpl: emptyKeychain() });
  assert.equal(creds.session, null);
  assert.equal(creds.complete, false);
  assert.deepEqual(creds.missing, [KEYCHAIN_SERVICES.session, KEYCHAIN_SERVICES.csrf]);
});

test('a missing `security` binary is also "nothing stored"', async () => {
  const creds = await readCredentials({
    execFileImpl: (bin, args, opts, cb) => cb(Object.assign(new Error('spawn security ENOENT'), { code: 'ENOENT' })),
  });
  assert.equal(creds.complete, false);
});

test('cf_clearance alone missing still counts as a usable session', async () => {
  const creds = await readCredentials({ execFileImpl: keychainWith({ cf: null }) });
  assert.equal(creds.complete, true);
  assert.deepEqual(creds.missing, []);
  assert.doesNotMatch(creds.cookieHeader(), /cf_clearance/);
});

test('the cookie header carries exactly the three cookies the protocol needs', async () => {
  const creds = await readCredentials({ execFileImpl: keychainWith() });
  assert.equal(
    creds.cookieHeader(),
    `LEETCODE_SESSION=${FAKE_SESSION}; csrftoken=${FAKE_CSRF}; cf_clearance=${FAKE_CF}`,
  );
});

test('a Credentials object cannot be serialised, inspected or interpolated into a leak', () => {
  const creds = new Credentials({ session: FAKE_SESSION, csrf: FAKE_CSRF, cfClearance: FAKE_CF });
  const renders = [
    JSON.stringify(creds),
    JSON.stringify({ creds }),
    `${creds}`,
    inspect(creds),
    inspect({ nested: creds }, { depth: 5 }),
  ];
  for (const rendered of renders) {
    for (const secret of FAKE_SECRETS) {
      assert.equal(rendered.includes(secret), false, `leaked via ${rendered.slice(0, 40)}`);
    }
  }
});

test('scrubSecrets replaces every occurrence and ignores short strings', () => {
  const creds = new Credentials({ session: FAKE_SESSION, csrf: FAKE_CSRF, cfClearance: 'short' });
  const text = `cookie: LEETCODE_SESSION=${FAKE_SESSION}; csrftoken=${FAKE_CSRF}; again ${FAKE_SESSION}`;
  const scrubbed = scrubSecrets(text, creds.secrets());
  assert.equal(scrubbed.includes(FAKE_SESSION), false);
  assert.equal(scrubbed.includes(FAKE_CSRF), false);
  assert.match(scrubbed, /\[redacted\]/);
  // A trivially short "secret" must not turn every log line into redaction soup.
  assert.equal(creds.secrets().includes('short'), false);
});

test('scrubError cleans the stack as well as the message', () => {
  const err = new Error(`boom ${FAKE_SESSION}`);
  err.stack = `Error: boom ${FAKE_SESSION}\n    at somewhere`;
  scrubError(err, [FAKE_SESSION]);
  assert.equal(err.message.includes(FAKE_SESSION), false);
  assert.equal(err.stack.includes(FAKE_SESSION), false);
});
