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

test('a phrase made only of video sign-offs is dropped; real speech around them is kept', () => {
  for (const text of ['you have a good time, and I will see you in the next', 'I\'ll see you in the next video.', 'Thanks for watching, and see you in the next one!',
    'Please like and subscribe.', 'Subtitles by the Amara.org community', 'Bye. See you in the next video. Have a great day.']) {
    assert.equal(filterTranscript(text), '', text);
  }
  for (const text of ['Thanks, have a good day.', 'See you next time.', 'Thank you for listening.', 'Like.', 'Have a good time.',
    'We will see in the next step whether the heap is needed.', 'I will see you in the next round, thanks.',
    'So, first of all, to make sure that you have a good time, and I will see you in the next make sure that we are aligned on the input.']) {
    assert.equal(filterTranscript(text), text, text);
  }
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
  for (const text of ['Mm-hm.', 'Sure, take your time.', 'Okay.', 'Mm-hmm. Go ahead.', 'Take your time and keep thinking out loud.', 'Recorded.', '']) assert.equal(isFillerReply(text), true, text);
  for (const text of ['Sure. What is the complexity?', 'What will you keep in the map?', 'It passed. What is the time complexity?', 'Okay, go ahead.', 'Go ahead.', 'Okay, go ahead with that.']) assert.equal(isFillerReply(text), false, text);
});
