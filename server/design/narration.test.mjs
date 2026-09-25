// The interviewer writes its own turn and no one else's.
//
// Two failures are possible and they pull in opposite directions, so both are held down
// here. Cutting too late lets the candidate read an answer they never gave. Cutting too
// early makes the interviewer mute the moment it says "the user uploads a photo" — a
// far more common sentence than any impersonation, and a bug that would be blamed on
// the model rather than on this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findImpersonation, impersonates, createNarrationFilter, salvageQuestion,
} from './narration.mjs';

/* ---- it cuts ---- */

test('the exact failure: a question, then the model answering as the candidate', () => {
  const text = [
    'How would you shard the notification table?',
    '',
    'USER: I\'d shard by user_id so all of a user\'s notifications land together.',
    '',
    'Good. And what happens to a celebrity account?',
  ].join('\n');
  const at = findImpersonation(text);
  assert.notEqual(at, -1, 'the impersonation was not caught');
  assert.equal(text.slice(0, at).trim(), 'How would you shard the notification table?');
});

test('every label a model reaches for when it starts scripting', () => {
  for (const name of ['User', 'user', 'Candidate', 'Me', 'Interviewee', 'You', 'Human', 'Dhiraj']) {
    assert.ok(impersonates(`Question?\n\n${name}: some answer I never gave\n`),
      `"${name}:" was not caught`);
  }
});

test('markdown dress does not smuggle it past', () => {
  for (const line of ['**User:** my answer', '> User: my answer', '- User: my answer', '  **Candidate**: x']) {
    assert.ok(impersonates(`Question?\n\n${line}\n`), `${JSON.stringify(line)} was not caught`);
  }
});

test('a stage direction is impersonation too — it puts words in the candidate', () => {
  for (const line of ['(candidate pauses)', '*You hesitate for a moment*', '[the candidate thinks]']) {
    assert.ok(impersonates(`Question?\n\n${line}\n`), `${JSON.stringify(line)} was not caught`);
  }
});

/* ---- it does not cut ---- */

test('"the user" in an ordinary sentence is not impersonation', () => {
  const fine = [
    'When the user uploads a photo, where does it go first?',
    'So the user: tapping refresh, what happens?',   // a colon mid-sentence
    'Walk me through what a user sees on a cold start.',
    'Users: there are 200M of them. How many are active?', // plural, mid-line topic label
  ];
  for (const text of fine) {
    assert.equal(findImpersonation(`${text}\n`), -1, `cut a clean line: ${JSON.stringify(text)}`);
  }
});

test('the interviewer labelling its own turn is not the candidate speaking', () => {
  assert.equal(findImpersonation('Interviewer: how would you shard that?\n'), -1);
});

test('a partial last line is never judged — the stream is still arriving', () => {
  // "Use" could become "Used by whom?" or "User: ...". Judging it now guesses.
  assert.equal(findImpersonation('How would you shard that?\n\nUse'), -1);
  assert.equal(findImpersonation('How would you shard that?\n\nUser'), -1);
  assert.equal(findImpersonation('How would you shard that?\n\nUser:'), -1,
    'judged a final line that has not been terminated yet');
});

/* ---- the stream filter ---- */

test('tokens flow until the break, and nothing after it is ever emitted', () => {
  const filter = createNarrationFilter();
  const shown = [];
  let trippedOn = null;
  for (const chunk of ['How would you ', 'shard that?\n', '\n', 'USER: by user_id\n', '\nGood, and hot keys?']) {
    const { text, tripped } = filter.push(chunk);
    shown.push(text);
    if (tripped) trippedOn = chunk;
  }
  assert.equal(trippedOn, 'USER: by user_id\n');
  const out = shown.join('');
  assert.equal(out.trim(), 'How would you shard that?');
  assert.ok(!out.includes('user_id'), 'the fabricated answer reached the candidate');
  assert.ok(!out.includes('hot keys'), 'the interviewer resumed after impersonating');
});

test('a token split across the label boundary is still caught', () => {
  const filter = createNarrationFilter();
  // The label arrives as "US" + "ER:" — no single chunk contains it.
  for (const chunk of ['Question?\n\n', 'US', 'ER', ': my answer\n']) filter.push(chunk);
  assert.ok(filter.tripped, 'a label split across tokens slipped through');
  assert.equal(filter.text(), 'Question?');
});

test('the label is never emitted character by character while the line is unfinished', () => {
  // This is how the CLI actually streams: small chunks, mid-line. The line-terminated
  // check alone is useless here — by the time "USER: I would shard…\n" is a complete
  // line, every character of it has already been sent and read.
  const reply = 'How would you shard that?\n\nUSER: I would shard by hash prefix.\n\nGood.';
  const filter = createNarrationFilter();
  let shown = '';
  for (let i = 0; i < reply.length; i += 4) {
    shown += filter.push(reply.slice(i, i + 4)).text;
  }
  shown += filter.flush();
  assert.match(shown, /How would you shard that\?/);
  assert.ok(!/U\s*S\s*E\s*R/.test(shown), `the label leaked: ${JSON.stringify(shown)}`);
  assert.ok(!shown.includes('hash prefix'), `the fabricated answer leaked: ${JSON.stringify(shown)}`);
});

test('holding back costs nothing when the line was never a label', () => {
  const reply = 'Users are 200M.\nWhat is the read rate?';
  const filter = createNarrationFilter();
  let shown = '';
  for (const ch of reply) shown += filter.push(ch).text;
  shown += filter.flush();
  assert.equal(shown, reply, 'text was held back and never released');
  assert.equal(filter.tripped, false);
});

test('a short final line is not swallowed', () => {
  const filter = createNarrationFilter();
  let out = '';
  for (const ch of 'Why?') out += filter.push(ch).text;
  out += filter.flush();
  assert.equal(out, 'Why?', 'the last line was swallowed');
});

test('a clean turn passes through byte for byte', () => {
  const answer = 'Let\'s start with scale. How many daily active users are we designing for?';
  const filter = createNarrationFilter();
  let out = '';
  for (const ch of answer) out += filter.push(ch).text;
  out += filter.flush();
  assert.equal(out, answer);
  assert.equal(filter.tripped, false);
});

/* ---- what is put back ---- */

test('a question that survived the cut is what the interview continues from', () => {
  assert.equal(
    salvageQuestion('Good. Now, how would you shard the notification table?'),
    'Good. Now, how would you shard the notification table?',
  );
  assert.equal(
    salvageQuestion('Let me push on that.\n\nWhat bounds the size of that cache?'),
    'What bounds the size of that cache?',
  );
});

test('nothing is invented when nothing usable survived', () => {
  assert.equal(salvageQuestion(''), null);
  assert.equal(salvageQuestion('Right, so the design is coming along.'), null,
    'a statement was passed off as a question');
});
