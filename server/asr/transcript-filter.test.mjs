import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTranscript, hasVoicedAudio, isFillerReply } from '../../web/js/transcript-filter.js';

test('noise and short Whisper hallucinations are empty; real short answers survive', () => {
  for (const text of ['[typing] (keyboard clacking) (clicking) [TAPPING]', '(keyboard clicking) Thanks.', '[DOOR SLAMS]', 'Thank you.', 'you', 'Bye.', '♪ music ♪', '♪', '...', '', 'THANKS!', '[noise] Thank you for watching.']) {
    assert.equal(filterTranscript(text), '', text);
  }
  for (const text of ['Yes.', 'No.', 'O(n).', 'Two pointers.', 'O(n log n).', 'Thanks, I will use two pointers.', 'Return f(x).']) {
    assert.equal(filterTranscript(text), text, text);
  }
  assert.equal(filterTranscript('[typing] Two pointers. (clicking)'), 'Two pointers.');
});

test('audio requires duration, sustained signal, and energy together', () => {
  const speech = { voicedMs: 300, sustainedMs: 300, energy: 300 * 0.02 ** 2 };
  assert.equal(hasVoicedAudio(speech), true);
  assert.equal(hasVoicedAudio(), false);
  assert.equal(hasVoicedAudio({ ...speech, voicedMs: 100, sustainedMs: 100 }), false, 'single loud burst');
  assert.equal(hasVoicedAudio({ ...speech, sustainedMs: 100 }), false, 'separated typing spikes');
  assert.equal(hasVoicedAudio({ ...speech, energy: 300 * 0.005 ** 2 }), false, 'quiet signal');
});

test('only filler replies are suppressed, not questions following acknowledgements', () => {
  for (const text of ['Mm-hm.', 'Sure, take your time.', 'Okay.', 'Mm-hmm. Go ahead.', '']) assert.equal(isFillerReply(text), true, text);
  for (const text of ['Sure. What is the complexity?', 'What will you keep in the map?', 'It passed. What is the time complexity?']) assert.equal(isFillerReply(text), false, text);
});
