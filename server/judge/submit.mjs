// One submission, start to finish. The whole judge flow lives here so it can be driven
// directly from a test with a stubbed fetch — no test in this directory ever touches the
// real judge, and this module is why that is possible without faking the HTTP layer.
//
// The sequence is exactly docs/API-CONTRACT-P2.md Phase 4:
//   read cookies → internal question_id → ONE POST /submit/ → poll /check/ → record.
//
// There is no retry anywhere in this file. Not on a challenge, not on a 5xx, not on a
// timeout. A failed submit reports and stops; the user decides whether to try again.

import { readCredentials, scrubError, scrubSecrets } from './credentials.mjs';
import { JudgeError, QuestionIdCache, postSubmission, pollSubmission, submissionUrl } from './client.mjs';
import { buildVerdict } from './verdict.mjs';
import { recordVerdict, logSubmitted, logVerdict, saveSubmittedCode } from './record.mjs';
import { isoWithOffset } from '../coach/sessions.mjs';

/** Slugs with a submission in flight. A second concurrent submit for the same problem is
 *  refused rather than queued — "one submission per explicit user action" has to hold even
 *  when the button is double-clicked. */
const inFlight = new Set();

export function isSubmitInFlight(slug) {
  return inFlight.has(slug);
}

/**
 * @returns {Promise<object>} the contract's 200 body
 * @throws {JudgeError} every failure, already scrubbed of credentials
 */
export async function submitToJudge({
  slug,
  code,
  fetchImpl = fetch,
  execFileImpl,
  questionIds,
  leetcode = null,
  sessionLog = null,
  homeRoot,
  sleep,
  now,
  pollOptions = {},
  lang = 'python3',
  log = console,
}) {
  if (typeof slug !== 'string' || slug === '') {
    throw new JudgeError(400, 'BAD_REQUEST', 'That submit request did not say which problem it was for.');
  }
  if (typeof code !== 'string' || code.trim() === '') {
    throw new JudgeError(
      400,
      'BAD_REQUEST',
      'There is no code to submit. Write a solution first — an empty submission would just burn a judge attempt.',
    );
  }

  if (inFlight.has(slug)) {
    throw new JudgeError(
      409,
      'SUBMIT_IN_FLIGHT',
      'A submission for this problem is already being judged. Wait for it to finish — Studio submits once per click, never twice.',
    );
  }

  // The guard goes up before anything async happens, so a double-clicked button cannot
  // slip a second submission through while the first is still reading the keychain.
  inFlight.add(slug);
  let secrets = [];
  try {
    const credentials = await readCredentials(execFileImpl ? { execFileImpl } : {});
    secrets = credentials.secrets();

    if (!credentials.complete) {
      throw new JudgeError(
        401,
        'NO_SESSION',
        'No LeetCode session is stored on this machine, so nothing can be submitted. ' +
          'Copy LEETCODE_SESSION, csrftoken and cf_clearance from your browser and paste them into Studio ' +
          `(keychain items missing: ${credentials.missing.join(', ')}).`,
      );
    }

    const cache = questionIds ?? new QuestionIdCache({ fetchImpl, leetcode });
    // The INTERNAL id. Never questionFrontendId.
    const questionId = await cache.get(slug);

    // === the one and only POST /submit/ ======================================
    const submissionId = await postSubmission({
      slug,
      code,
      questionId,
      credentials,
      fetchImpl,
      lang,
    });

    const submittedAt = isoWithOffset();
    const submittedLog = await logSubmitted(sessionLog, slug, {
      submissionId,
      questionId,
      lang,
      codeBytes: Buffer.byteLength(code, 'utf8'),
      submissionUrl: submissionUrl(submissionId),
    });

    const { check, polls } = await pollSubmission({
      submissionId,
      slug,
      credentials,
      fetchImpl,
      sleep,
      now,
      ...pollOptions,
    });

    const verdict = buildVerdict(check, submissionId);

    const verdictLog = await logVerdict(sessionLog, slug, verdict);
    // The exact bytes that earned this verdict, kept beside it — the editor buffer will
    // have moved on by the time anyone reads the history back.
    const codeFile = await saveSubmittedCode({ root: homeRoot, slug, submissionId, code });
    const meta = homeRoot
      ? await recordVerdict({ root: homeRoot, slug, verdict, at: isoWithOffset(), codeFile })
      : { written: false, reason: 'no workspace root configured' };

    for (const result of [submittedLog, verdictLog, meta]) {
      if (!result.written && result.reason) {
        log?.warn?.(`[judge] ${slug}: verdict recorded only partially — ${result.reason}`);
      }
    }

    return {
      ...verdict,
      submittedAt,
      polls,
      recorded: {
        sessionEvents: submittedLog.written && verdictLog.written,
        meta: meta.written,
        note: meta.written ? null : (meta.reason ?? null),
      },
    };
  } catch (err) {
    // Last line of defence: nothing that reaches a response or a log keeps a cookie value.
    throw scrubError(err, secrets);
  } finally {
    inFlight.delete(slug);
  }
}

export { scrubSecrets };
