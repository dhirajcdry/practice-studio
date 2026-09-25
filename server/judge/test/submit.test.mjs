// The submit flow, end to end, against a STUBBED fetch.
//
// NOTHING in this file makes a real submission. Every `fetchImpl` is a scripted stub and
// several tests assert on the exact number of calls that were made, so a regression that
// introduced a retry loop would fail here rather than at LeetCode.

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { submitToJudge } from '../submit.mjs';
import { QuestionIdCache } from '../client.mjs';
import { SessionLog } from '../../coach/sessions.mjs';
import {
  ACCEPTED_CHECK,
  FAKE_CF,
  FAKE_CSRF,
  FAKE_SECRETS,
  FAKE_SESSION,
  collectingLog,
  emptyKeychain,
  htmlResponse,
  jsonResponse,
  keychainWith,
  response,
  stubFetch,
} from './helpers.mjs';

const CODE = 'class Solution:\n    def twoSum(self, nums, target):\n        return [0, 1]\n';

async function tmpRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'studio-judge-'));
}

const noSleep = async () => {};
const ids = { get: async () => '1' };

/** Standard harness: real keychain values stubbed, fetch scripted, clock frozen. */
function harness({ fetchImpl, homeRoot, questionIds = ids, pollOptions, now, leetcode }) {
  const log = collectingLog();
  return {
    log,
    run: (over = {}) =>
      submitToJudge({
        slug: 'two-sum',
        code: CODE,
        fetchImpl,
        execFileImpl: keychainWith(),
        questionIds,
        leetcode,
        sessionLog: new SessionLog({ root: homeRoot }),
        homeRoot,
        sleep: noSleep,
        now,
        pollOptions,
        log,
        ...over,
      }),
  };
}

// --- the happy path ---------------------------------------------------------

test('an accepted submission: one POST, polled to SUCCESS, recorded everywhere', async () => {
  const root = await tmpRoot();
  const fetchImpl = stubFetch({
    '/submit/': jsonResponse({ submission_id: 2081220750 }),
    '/check/': (n) => (n <= 2 ? jsonResponse({ state: 'PENDING' }) : jsonResponse(ACCEPTED_CHECK)),
  });
  const { run, log } = harness({ fetchImpl, homeRoot: root });

  const result = await run();

  assert.equal(result.ok, true);
  assert.equal(result.accepted, true);
  assert.equal(result.verdict, 'Accepted');
  assert.equal(result.statusCode, 10);
  assert.equal(result.passed, 64);
  assert.equal(result.total, 64);
  assert.equal(result.runtime, '3 ms');
  assert.equal(result.memory, '20.4 MB');
  assert.equal(result.runtimePercentile, 53.86);
  assert.equal(result.submissionId, 2081220750);
  assert.equal(result.submissionUrl, 'https://leetcode.com/submissions/detail/2081220750/');
  assert.equal(result.failure, null);

  // Exactly one submission. Ever.
  assert.equal(fetchImpl.countOf('/submit/'), 1);

  // The verified request shape.
  const submit = fetchImpl.calls.find((c) => c.url.includes('/submit/'));
  assert.equal(submit.url, 'https://leetcode.com/problems/two-sum/submit/');
  assert.equal(submit.method, 'POST');
  assert.deepEqual(JSON.parse(submit.body), {
    lang: 'python3',
    question_id: '1',
    test_mode: false,
    typed_code: CODE,
    judge_type: 'large',
  });
  assert.equal(submit.headers['x-csrftoken'], FAKE_CSRF);
  assert.equal(submit.headers.referer, 'https://leetcode.com/problems/two-sum/');
  assert.equal(submit.headers.origin, 'https://leetcode.com');
  assert.match(submit.headers.cookie, /LEETCODE_SESSION=/);
  assert.match(submit.headers.cookie, /csrftoken=/);
  assert.match(submit.headers.cookie, /cf_clearance=/);

  // cf_clearance is bound to the UA that minted it: same UA on every single request.
  const uas = new Set(fetchImpl.calls.map((c) => c.headers['user-agent']));
  assert.equal(uas.size, 1);
  assert.match([...uas][0], /Mozilla\/5\.0/);

  // Session events.
  const sessions = await new SessionLog({ root }).readSessions('two-sum');
  const types = sessions.flatMap((s) => s.events.map((e) => e.type));
  assert.deepEqual(types, ['submitted', 'verdict']);
  const verdictEvent = sessions[0].events[1];
  assert.equal(verdictEvent.data.accepted, true);
  assert.equal(verdictEvent.data.submissionId, 2081220750);

  // meta.json.
  const meta = JSON.parse(await fsp.readFile(path.join(root, 'problems', 'two-sum', 'meta.json'), 'utf8'));
  assert.equal(meta.submissions.length, 1);
  assert.equal(meta.submissions[0].verdict, 'Accepted');
  assert.equal(meta.submissions[0].accepted, true);
  assert.equal(meta.submissions[0].runtimeMs, 3);
  assert.equal(meta.submissions[0].memoryMb, 20.4);
  assert.equal(meta.submissions[0].testsPassed, 64);
  assert.equal(result.recorded.meta, true);
  assert.equal(result.recorded.sessionEvents, true);

  assert.equal(log.text(), '');
});

test('the INTERNAL question id is sent, not the displayed number, and it is cached', async () => {
  const root = await tmpRoot();
  let contentCalls = 0;
  const leetcode = {
    async getContent() {
      contentCalls += 1;
      // /api/problems/all/ §1.6: internal 4369 vs displayed 3996.
      return { question: { questionId: '4369', questionFrontendId: '3996' } };
    },
  };
  const fetchImpl = stubFetch({
    '/submit/': jsonResponse({ submission_id: 5 }),
    '/check/': jsonResponse(ACCEPTED_CHECK),
  });
  const { run } = harness({
    fetchImpl,
    homeRoot: root,
    leetcode,
    questionIds: new QuestionIdCache({ fetchImpl, leetcode }),
  });

  await run({ slug: 'even-number-of-knight-moves' });
  const first = JSON.parse(fetchImpl.calls.find((c) => c.url.includes('/submit/')).body);
  assert.equal(first.question_id, '4369');
  assert.notEqual(first.question_id, '3996');

  await run({ slug: 'even-number-of-knight-moves' });
  assert.equal(contentCalls, 1, 'the internal id is cached per slug');
});

test('a non-accepted verdict is recorded too, with the judge\'s own failure detail', async () => {
  const root = await tmpRoot();
  const fetchImpl = stubFetch({
    '/submit/': jsonResponse({ submission_id: 77 }),
    '/check/': jsonResponse({
      state: 'SUCCESS',
      status_code: 11,
      status_msg: 'Wrong Answer',
      run_success: true,
      total_correct: 34,
      total_testcases: 57,
      last_testcase: '[3,2,4]\n6',
      code_output: '[0,1]',
      expected_output: '[1,2]',
    }),
  });
  const { run } = harness({ fetchImpl, homeRoot: root });

  const result = await run();
  assert.equal(result.accepted, false);
  assert.equal(result.failure.kind, 'wrong_answer');
  assert.equal(result.failure.expectedOutput, '[1,2]');
  assert.equal(fetchImpl.countOf('/submit/'), 1, 'a wrong answer must never trigger a resubmit');

  const meta = JSON.parse(await fsp.readFile(path.join(root, 'problems', 'two-sum', 'meta.json'), 'utf8'));
  assert.equal(meta.submissions[0].verdict, 'Wrong Answer');
  assert.equal(meta.submissions[0].accepted, false);
});

test('meta.json is merged, never clobbered', async () => {
  const root = await tmpRoot();
  const dir = path.join(root, 'problems', 'two-sum');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      schemaVersion: 1,
      slug: 'two-sum',
      title: 'Two Sum',
      difficulty: 'Easy',
      firstSeen: '2026-07-01',
      handWrittenNote: 'keep me',
      submissions: [{ at: '2026-07-01', verdict: 'Accepted', note: 'by hand' }],
    }, null, 2),
    'utf8',
  );

  const fetchImpl = stubFetch({
    '/submit/': jsonResponse({ submission_id: 2081220750 }),
    '/check/': jsonResponse(ACCEPTED_CHECK),
  });
  await harness({ fetchImpl, homeRoot: root }).run();

  const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.handWrittenNote, 'keep me');
  assert.equal(meta.title, 'Two Sum');
  assert.equal(meta.firstSeen, '2026-07-01');
  assert.equal(meta.submissions.length, 2);
  assert.equal(meta.submissions[0].note, 'by hand');
  assert.equal(meta.submissions[1].submissionId, 2081220750);
});

test('an unparseable meta.json is left untouched and reported, not overwritten', async () => {
  const root = await tmpRoot();
  const dir = path.join(root, 'problems', 'two-sum');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'meta.json'), '{ "submissions": [ {', 'utf8');

  const fetchImpl = stubFetch({
    '/submit/': jsonResponse({ submission_id: 1 }),
    '/check/': jsonResponse(ACCEPTED_CHECK),
  });
  const { run, log } = harness({ fetchImpl, homeRoot: root });
  const result = await run();

  assert.equal(result.accepted, true, 'a recording problem must not fail the submission');
  assert.equal(result.recorded.meta, false);
  assert.equal(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'), '{ "submissions": [ {');
  assert.match(log.text(), /could not be parsed/);
});

// --- failure states ---------------------------------------------------------

test('an HTML sign-in page instead of JSON surfaces as 401 SESSION_EXPIRED', async () => {
  const root = await tmpRoot();
  const fetchImpl = stubFetch({
    '/submit/': htmlResponse('<html><body>Sign in to LeetCode</body></html>', { status: 403 }),
  });
  const { run } = harness({ fetchImpl, homeRoot: root });

  const err = await run().then(() => null, (e) => e);
  assert.ok(err, 'must reject');
  assert.equal(err.status, 401);
  assert.equal(err.code, 'SESSION_EXPIRED');
  assert.match(err.message, /re-paste/i);
  assert.doesNotMatch(err.message, /JSON/i, 'never a JSON parse error');
  assert.equal(fetchImpl.countOf('/submit/'), 1, 'no automatic retry after an auth failure');
});

test('a Cloudflare challenge surfaces as 503 JUDGE_UNREACHABLE, not a parse error', async () => {
  const root = await tmpRoot();
  const fetchImpl = stubFetch({
    '/submit/': htmlResponse('<html><head><title>Just a moment...</title></head></html>', {
      status: 403,
      headers: { 'cf-mitigated': 'challenge' },
    }),
  });
  const err = await harness({ fetchImpl, homeRoot: root }).run().then(() => null, (e) => e);
  assert.equal(err.status, 503);
  assert.equal(err.code, 'JUDGE_UNREACHABLE');
  assert.match(err.message, /cf_clearance/);
  assert.equal(fetchImpl.countOf('/submit/'), 1);
});

test('a login redirect surfaces as SESSION_EXPIRED', async () => {
  const root = await tmpRoot();
  const fetchImpl = stubFetch({
    '/submit/': response('', { status: 302, headers: { location: 'https://leetcode.com/accounts/login/' } }),
  });
  const err = await harness({ fetchImpl, homeRoot: root }).run().then(() => null, (e) => e);
  assert.equal(err.code, 'SESSION_EXPIRED');
  assert.equal(err.status, 401);
});

test('a JSON CSRF rejection is reported as a stale token, not a mystery', async () => {
  const root = await tmpRoot();
  const fetchImpl = stubFetch({
    '/submit/': jsonResponse({ detail: 'CSRF Failed: CSRF token missing or incorrect.' }, { status: 403 }),
  });
  const err = await harness({ fetchImpl, homeRoot: root }).run().then(() => null, (e) => e);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'SESSION_EXPIRED');
  assert.match(err.message, /csrftoken/);
});

test('HTTP 429 surfaces as RATE_LIMITED and never retries', async () => {
  const root = await tmpRoot();
  const fetchImpl = stubFetch({
    '/submit/': jsonResponse({ detail: 'slow down' }, { status: 429 }),
  });
  const err = await harness({ fetchImpl, homeRoot: root }).run().then(() => null, (e) => e);
  assert.equal(err.status, 429);
  assert.equal(err.code, 'RATE_LIMITED');
  assert.match(err.message, /never resubmit automatically/i);
  assert.equal(fetchImpl.countOf('/submit/'), 1);
});

test('a poll that never finishes times out, names the submission and links to it', async () => {
  const root = await tmpRoot();
  const fetchImpl = stubFetch({
    '/submit/': jsonResponse({ submission_id: 999 }),
    '/check/': jsonResponse({ state: 'PENDING' }),
  });
  let clock = 0;
  const { run } = harness({
    fetchImpl,
    homeRoot: root,
    now: () => (clock += 1000),
    pollOptions: { ceilingMs: 10000 },
  });

  const err = await run().then(() => null, (e) => e);
  assert.equal(err.status, 504);
  assert.equal(err.code, 'JUDGE_TIMEOUT');
  assert.equal(err.submissionId, 999);
  assert.equal(err.submissionUrl, 'https://leetcode.com/submissions/detail/999/');
  assert.match(err.message, /999/);
  assert.match(err.message, /will not resubmit/i);
  assert.equal(fetchImpl.countOf('/submit/'), 1, 'a timeout must never resubmit');
  // Bounded, human-paced polling: ~1 poll/s against a 10 s ceiling.
  assert.ok(fetchImpl.countOf('/check/') <= 12, `polled ${fetchImpl.countOf('/check/')} times`);
});

test('the judge reporting state FAILURE is an infra error that still names the submission', async () => {
  const root = await tmpRoot();
  const fetchImpl = stubFetch({
    '/submit/': jsonResponse({ submission_id: 31337 }),
    '/check/': jsonResponse({ state: 'FAILURE' }),
  });
  const err = await harness({ fetchImpl, homeRoot: root }).run().then(() => null, (e) => e);
  assert.equal(err.code, 'JUDGE_UNREACHABLE');
  assert.match(err.message, /31337/);
});

test('an expired session detected mid-poll is SESSION_EXPIRED, not a crash', async () => {
  const root = await tmpRoot();
  const fetchImpl = stubFetch({
    '/submit/': jsonResponse({ submission_id: 4 }),
    '/check/': htmlResponse('<html>Sign in</html>', { status: 403 }),
  });
  const err = await harness({ fetchImpl, homeRoot: root }).run().then(() => null, (e) => e);
  assert.equal(err.code, 'SESSION_EXPIRED');
});

test('no keychain entry is a clean "no session stored" state, and nothing is submitted', async () => {
  const root = await tmpRoot();
  const fetchImpl = stubFetch({});
  const err = await submitToJudge({
    slug: 'two-sum',
    code: CODE,
    fetchImpl,
    execFileImpl: emptyKeychain(),
    questionIds: ids,
    homeRoot: root,
    sleep: noSleep,
  }).then(() => null, (e) => e);

  assert.equal(err.status, 401);
  assert.equal(err.code, 'NO_SESSION');
  assert.match(err.message, /studio-leetcode-session/);
  assert.match(err.message, /paste/i);
  assert.equal(fetchImpl.calls.length, 0, 'no network call without credentials');
});

test('a missing cf_clearance alone does not block a submission', async () => {
  const root = await tmpRoot();
  const fetchImpl = stubFetch({
    '/submit/': jsonResponse({ submission_id: 8 }),
    '/check/': jsonResponse(ACCEPTED_CHECK),
  });
  const result = await submitToJudge({
    slug: 'two-sum',
    code: CODE,
    fetchImpl,
    execFileImpl: keychainWith({ cf: null }),
    questionIds: ids,
    sessionLog: new SessionLog({ root }),
    homeRoot: root,
    sleep: noSleep,
  });
  assert.equal(result.accepted, true);
  const cookie = fetchImpl.calls[0].headers.cookie;
  assert.doesNotMatch(cookie, /cf_clearance/);
});

test('empty code is refused before any network call', async () => {
  const fetchImpl = stubFetch({});
  const err = await submitToJudge({
    slug: 'two-sum',
    code: '   \n',
    fetchImpl,
    execFileImpl: keychainWith(),
    questionIds: ids,
    sleep: noSleep,
  }).then(() => null, (e) => e);
  assert.equal(err.status, 400);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a network failure is JUDGE_UNREACHABLE and does not resubmit', async () => {
  const root = await tmpRoot();
  const fetchImpl = stubFetch({ '/submit/': new TypeError('fetch failed') });
  const err = await harness({ fetchImpl, homeRoot: root }).run().then(() => null, (e) => e);
  assert.equal(err.status, 503);
  assert.equal(err.code, 'JUDGE_UNREACHABLE');
  assert.equal(fetchImpl.countOf('/submit/'), 1);
});

test('a second concurrent submit for the same problem is refused, not queued', async () => {
  const root = await tmpRoot();
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = stubFetch({
    '/submit/': async () => { await gate; return jsonResponse({ submission_id: 3 }); },
    '/check/': jsonResponse(ACCEPTED_CHECK),
  });
  const { run } = harness({ fetchImpl, homeRoot: root });

  const first = run();
  const second = await run().then(() => null, (e) => e);
  assert.equal(second.status, 409);
  assert.equal(second.code, 'SUBMIT_IN_FLIGHT');
  release();
  await first;
  assert.equal(fetchImpl.countOf('/submit/'), 1);
});

// --- credentials never leak -------------------------------------------------

test('no credential appears in any error message, stack or log line, in any failure state', async () => {
  const root = await tmpRoot();
  const scenarios = {
    'html auth failure': { '/submit/': htmlResponse(`<html>signed out ${FAKE_SESSION}</html>`, { status: 403 }) },
    'cloudflare challenge': {
      '/submit/': htmlResponse('<html>Just a moment...</html>', { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
    },
    'rate limited': { '/submit/': jsonResponse({ detail: `too fast ${FAKE_CSRF}` }, { status: 429 }) },
    'server error': { '/submit/': jsonResponse({ detail: 'boom' }, { status: 500 }) },
    // A transport error whose message echoes back the request it was given — the nastiest
    // realistic leak path, since a thrown TypeError can carry anything.
    'transport error': { '/submit/': new TypeError(`connect failed sending cookie ${FAKE_CF}`) },
    'poll timeout': {
      '/submit/': jsonResponse({ submission_id: 1 }),
      '/check/': jsonResponse({ state: 'PENDING' }),
    },
    'judge failure': {
      '/submit/': jsonResponse({ submission_id: 1 }),
      '/check/': jsonResponse({ state: 'FAILURE', detail: FAKE_SESSION }),
    },
  };

  for (const [name, plan] of Object.entries(scenarios)) {
    let clock = 0;
    const fetchImpl = stubFetch(plan);
    const log = collectingLog();
    const err = await submitToJudge({
      slug: 'two-sum',
      code: CODE,
      fetchImpl,
      execFileImpl: keychainWith(),
      questionIds: ids,
      sessionLog: new SessionLog({ root }),
      homeRoot: root,
      sleep: noSleep,
      now: () => (clock += 2000),
      pollOptions: { ceilingMs: 6000 },
      log,
    }).then(() => null, (e) => e);

    assert.ok(err, `${name} must reject`);
    const haystack = [err.message, err.stack, JSON.stringify({ ...err }), log.text()].join('\n');
    for (const secret of FAKE_SECRETS) {
      assert.equal(
        haystack.includes(secret),
        false,
        `${name}: a credential leaked into an error or log`,
      );
    }
  }
});

test('a successful submission writes no credential into the session log or meta.json', async () => {
  const root = await tmpRoot();
  const fetchImpl = stubFetch({
    '/submit/': jsonResponse({ submission_id: 2081220750 }),
    '/check/': jsonResponse(ACCEPTED_CHECK),
  });
  const { run, log } = harness({ fetchImpl, homeRoot: root });
  const result = await run();

  const onDisk = [
    JSON.stringify(result),
    log.text(),
    await fsp.readFile(path.join(root, 'problems', 'two-sum', 'meta.json'), 'utf8'),
    JSON.stringify(await new SessionLog({ root }).readSessions('two-sum')),
  ].join('\n');

  for (const secret of FAKE_SECRETS) {
    assert.equal(onDisk.includes(secret), false, 'a credential reached disk or the response');
  }
});
