// Turn-taking: the logic that decides when you have stopped talking.
//
// web/js/speech.js is a browser module, but the judgement in it is pure and is the part
// that can be wrong in a way nobody notices until it ruins an interview — sending your
// answer while you are drawing breath, or sitting in silence waiting for you to speak
// again. Those two failures pull in opposite directions, so both are pinned here.
//
// The audio path (getUserMedia, the RMS analyser, speechSynthesis) is not testable in
// Node and is not tested here; scripts/check-design.mjs covers that the controls exist
// and mount in a real browser.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  turnDecision, splitForSpeech, stripForSpeech, END_OF_TURN_MS,
} from '../../web/js/speech.js';

const base = { sinceLoud: 0, chars: 40, speaking: false, busy: false, pending: 0 };
const decide = (over) => turnDecision({ ...base, ...over });

/* ---- when the turn is over ---- */

test('going quiet after speaking ends the turn', () => {
  assert.equal(decide({ sinceLoud: END_OF_TURN_MS }), 'send');
  assert.equal(decide({ sinceLoud: END_OF_TURN_MS + 5000 }), 'send');
});

test('a breath is not the end of a turn', () => {
  // The pause that ends a dictation phrase is 700ms. A turn has to be much longer, or
  // the interviewer cuts in every time you pause to think mid-sentence.
  assert.equal(decide({ sinceLoud: 700 }), 'wait');
  assert.equal(decide({ sinceLoud: 1500 }), 'wait');
  assert.equal(decide({ sinceLoud: END_OF_TURN_MS - 1 }), 'wait');
  assert.ok(END_OF_TURN_MS >= 2000, 'the fuse is short enough to interrupt real thinking');
});

test('silence with nothing said is not a turn', () => {
  // Sitting quietly and thinking must never post an empty answer.
  assert.equal(decide({ sinceLoud: 60_000, chars: 0 }), 'wait');
  assert.equal(decide({ sinceLoud: 60_000, chars: 1 }), 'wait');
});

test('nothing is sent while the interviewer is still talking', () => {
  // The microphone is shut then, but a stale reading must not slip through either.
  assert.equal(decide({ sinceLoud: 10_000, speaking: true }), 'wait');
});

test('nothing is sent while a turn is already in flight', () => {
  assert.equal(decide({ sinceLoud: 10_000, busy: true }), 'wait');
});

test('a phrase still being transcribed holds the turn open', () => {
  // Otherwise the tail of your sentence lands after the send and is either lost or
  // glued to the front of your next answer.
  assert.equal(decide({ sinceLoud: 10_000, pending: 1 }), 'wait');
  assert.equal(decide({ sinceLoud: 10_000, pending: 0 }), 'send');
});

/* ---- speaking as the question is written ---- */

test('a completed sentence is spoken before the rest has arrived', () => {
  const { ready, rest } = splitForSpeech('Let us start with scale. How many daily active');
  assert.deepEqual(ready, ['Let us start with scale.']);
  assert.equal(rest.trim(), 'How many daily active');
});

test('an unfinished sentence is never spoken early', () => {
  const { ready, rest } = splitForSpeech('How would you shard');
  assert.deepEqual(ready, []);
  assert.equal(rest, 'How would you shard');
});

test('a decimal or an abbreviation is not a sentence end', () => {
  // "200M." mid-number would otherwise be read as a full stop and chop the sentence.
  const { ready } = splitForSpeech('We have 1.5M users and 99.9% uptime. What next');
  assert.deepEqual(ready, ['We have 1.5M users and 99.9% uptime.']);
});

test('questions and exclamations end sentences too', () => {
  const { ready } = splitForSpeech('Why that key? What bounds it! And then');
  assert.deepEqual(ready, ['Why that key?', 'What bounds it!']);
});

test('splitting loses nothing — every character is in ready or rest', () => {
  const text = 'One. Two? Three! And a tail';
  const { ready, rest } = splitForSpeech(text);
  const rebuilt = (ready.join(' ') + ' ' + rest.trim()).replace(/\s+/g, ' ').trim();
  assert.equal(rebuilt, text.replace(/\s+/g, ' ').trim());
});

/* ---- what gets read aloud ---- */

test('markdown is not read out as punctuation', () => {
  assert.equal(stripForSpeech('**Hot** partitions and `user_id`'), 'Hot partitions and user_id');
  assert.equal(stripForSpeech('## Scale\n- one\n- two'), 'Scale one two');
});

test('a code block is named, not spelled out', () => {
  assert.equal(
    stripForSpeech('Consider this:\n```python\nfor x in y: pass\n```\nWhat breaks?'),
    'Consider this: code block What breaks?',
  );
});

test('ordinary prose is left exactly as written', () => {
  const plain = 'How many daily active users are we designing for?';
  assert.equal(stripForSpeech(plain), plain);
});
