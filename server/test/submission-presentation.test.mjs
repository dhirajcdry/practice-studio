// Presentation facts and connector reads can be checked without a browser or judge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionPresentation, firstDifference } from '../../web/js/submission-presentation.js';
import { lineDiff } from '../../web/js/line-diff.js';
import { detailsViaConnector, submitViaConnector } from '../../web/js/leetcode-bridge.js';

test('rejected verdicts have tests, not runtime or memory tiles', () => {
  const result = submissionPresentation({
    accepted: false, runtimeMs: 0, memoryMb: 0, testsPassed: 79, testsTotal: 178,
    detailFile: 'submissions/1.json',
  });
  assert.deepEqual(result.metrics, []);
  assert.equal(result.tests, true);
  assert.equal(result.missing, "LeetCode didn't return this.");
});

test('old records and judge omissions have distinct explanations', () => {
  assert.equal(submissionPresentation({}).missing, 'Not kept for submissions before Oct 18');
  assert.equal(submissionPresentation({ details: {} }).missing, "LeetCode didn't return this.");
  assert.equal(submissionPresentation({ accepted: true }).metrics.length, 0);
});

test('first difference preserves common prefix and suffix including empty ranges', () => {
  assert.deepEqual(firstDifference('[1,2]', '[1,3]'), { start: 3, endExpected: 4, endActual: 4 });
  assert.deepEqual(firstDifference('ab', 'axb'), { start: 1, endExpected: 1, endActual: 2 });
  assert.deepEqual(firstDifference('same', 'same'), { start: 4, endExpected: 4, endActual: 4 });
});

test('line diff reconstructs both inputs with repeated lines and empty inputs', () => {
  for (const [before, after] of [['a\na\nb', 'a\nb\nc'], ['', 'a\n'], ['a', ''], ['x\ny', 'x\ny']]) {
    const diff = lineDiff(before, after);
    assert.equal(diff.filter(line => line.type !== 'added').map(line => line.text).join('\n'), before);
    assert.equal(diff.filter(line => line.type !== 'removed').map(line => line.text).join('\n'), after);
  }
});

test('details and submissions share transport but never operation state or wording', async () => {
  const listeners = new Set();
  const sent = [];
  globalThis.document = { documentElement: { dataset: { studioConnector: '1.2.0' } } };
  globalThis.location = { origin: 'http://127.0.0.1:4198' };
  globalThis.window = {
    addEventListener: (type, callback) => listeners.add(callback),
    removeEventListener: (type, callback) => listeners.delete(callback),
    postMessage: request => { sent.push(request); },
  };
  try {
    const reading = detailsViaConnector('two-sum', '1');
    const submitting = submitViaConnector({ slug: 'two-sum', code: 'pass' });
    assert.equal(sent[0].type, 'details');
    assert.equal(sent[0].code, undefined);
    assert.equal(sent[1].type, 'submit');
    assert.equal(sent[1].submissionId, undefined);
    for (const request of sent) {
      for (const listener of [...listeners]) listener({
        source: window, data: { source: 'studio-connector', id: request.id, result: null },
      });
    }
    const readResult = await reading;
    assert.equal(readResult.submissionState, undefined);
    assert.doesNotMatch(readResult.message, /submit/i);
    assert.equal((await submitting).submissionState, 'unknown');
    assert.equal(listeners.size, 0);
  } finally {
    delete globalThis.document;
    delete globalThis.location;
    delete globalThis.window;
  }
});
