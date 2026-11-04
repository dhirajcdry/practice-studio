import test from 'node:test';
import assert from 'node:assert/strict';

const speechUrl = new URL('../../web/js/speech.js', import.meta.url);
let speech;

class FakeAudio {
  set src(value) { this._src = value; }
  get src() { return this._src || ''; }
  play() { setTimeout(() => this.onended?.(), 0); return Promise.resolve(); }
  pause() { this.onended?.(); }
  removeAttribute() { this._src = ''; }
}

test.before(async () => {
  globalThis.window = { Audio: FakeAudio };
  globalThis.URL.createObjectURL = () => 'blob:fake';
  globalThis.URL.revokeObjectURL = () => {};
  globalThis.fetch = async (url) => url.endsWith('/status')
    ? { ok: true, json: async () => ({ available: true }) }
    : { ok: true, blob: async () => new Blob(['audio']) };
  speech = await import(speechUrl);
});

test('cleanup keeps names and numbers while dropping links, URLs, tables and code', () => {
  assert.equal(speech.stripForSpeech('See [Dr. Ada](https://example.com) in https://x.test.\n| Name | Score |\n| --- | --- |\n| Ada | 42 |\n```js\nfoo()\n```'), 'See Dr. Ada in Name, Score, Ada, 42,');
});

test('sentence splitter holds abbreviations and decimals across chunks', () => {
  assert.deepEqual(speech.splitForSpeech('Use e.g. 1.5'), { ready: [], rest: 'Use e.g. 1.5' });
  assert.deepEqual(speech.splitForSpeech('Use e.g. 1.5 here. Next'), { ready: ['Use e.g. 1.5 here.'], rest: ' Next' });
  assert.deepEqual(speech.splitForSpeech('Ask Dr. Smith. Then'), { ready: ['Ask Dr. Smith.'], rest: ' Then' });
  assert.deepEqual(speech.splitForSpeech('Use e.'), { ready: [], rest: 'Use e.' });
  assert.deepEqual(speech.splitForSpeech('```js\nvalue.\n``` Next.'), { ready: [], rest: '```js\nvalue.\n``` Next.' });
});

test('sentence splitter respects punctuation inside fenced code', () => {
  assert.deepEqual(speech.splitForSpeech('Explain this: ```js\nif (x) { return 1; }\n``` Then continue. '), {
    ready: ['Explain this: ```js\nif (x) { return 1; }\n``` Then continue.'], rest: ' '
  });
  assert.deepEqual(speech.splitForSpeech('First sentence. ```js\nvalue.\n``` Second'), {
    ready: ['First sentence.'], rest: ' ```js\nvalue.\n``` Second'
  });
});

test('cancel prevents deferred natural synthesis and stale callbacks from reopening playback', async () => {
  let release;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/status')) return { ok: true, json: async () => ({ available: true }) };
    await new Promise(resolve => { release = resolve; });
    return { ok: true, blob: async () => new Blob(['audio']) };
  };
  const states = [];
  const speaker = speech.createSpeaker({ onStateChange: s => states.push(s) });
  speaker.say('Deferred.');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function', 'synthesis must actually be pending');
  speaker.cancel();
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(speaker.speaking, false);
  assert.deepEqual(states.at(-1), false);
  speaker.dispose();
  globalThis.fetch = async (url) => url.endsWith('/status')
    ? { ok: true, json: async () => ({ available: true }) }
    : { ok: true, blob: async () => new Blob(['audio']) };
});

test('natural synthesis failure falls back and continues with queued sentence', async () => {
  const spoken = [];
  globalThis.fetch = async (url) => url.endsWith('/status')
    ? { ok: true, json: async () => ({ available: true }) }
    : { ok: false };
  globalThis.window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  globalThis.window.speechSynthesis = { speak: u => spoken.push(u), cancel() {}, getVoices() { return []; } };
  const speaker = speech.createSpeaker();
  speaker.say('First. Second.');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(spoken[0]?.text, 'First.');
  spoken[0].onend();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(spoken[1]?.text, 'Second.');
  speaker.dispose();
  delete globalThis.window.speechSynthesis;
  delete globalThis.window.SpeechSynthesisUtterance;
  globalThis.fetch = async (url) => url.endsWith('/status')
    ? { ok: true, json: async () => ({ available: true }) }
    : { ok: true, blob: async () => new Blob(['audio']) };
});

test('speaker reports prepare, natural speaking, idle and supports cancellation', async () => {
  const states = [];
  const speaker = speech.createSpeaker({ onPlayback: state => states.push(state) });
  speaker.say('Hello world.');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(states.map(s => s.phase), ['preparing', 'speaking', 'idle']);
  assert.equal(states[1].engine, 'natural');
  speaker.dispose();
});

test('natural failure falls back to system, and missing engines report error', async () => {
  globalThis.fetch = async () => ({ ok: false });
  const states = [];
  globalThis.window.speechSynthesis = { speak(u) { u.onstart?.(); }, cancel() {}, getVoices() { return []; } };
  globalThis.window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  const speaker = speech.createSpeaker({ onPlayback: state => states.push(state) });
  speaker.say('Fallback.');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(states.some(s => s.engine === 'system' && s.phase === 'speaking'));
  speaker.dispose();
  delete globalThis.window.speechSynthesis;
  delete globalThis.window.SpeechSynthesisUtterance;
  const failed = [];
  const noEngine = speech.createSpeaker({ onPlayback: state => failed.push(state) });
  noEngine.say('No engine.');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(failed.at(-1).phase, 'error');
  noEngine.cancel();
});


test('system captions wait for actual start and ignore callbacks after interruption', async () => {
  let utterance;
  globalThis.window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  globalThis.window.speechSynthesis = { speak(u) { utterance = u; }, cancel() {}, getVoices() { return []; } };
  const states = [], speaker = speech.createSpeaker({preferences:()=>({engine:'system',speed:1}),onPlayback:s=>states.push(s)});
  speaker.say('A queued question.');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(speaker.playback.phase, 'preparing');
  assert.equal(speaker.speaking, true, 'microphone is gated while system playback prepares');
  utterance.onstart(); assert.equal(speaker.playback.phase, 'speaking');
  speaker.cancel();
  utterance.onstart(); utterance.onerror();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(speaker.playback.phase, 'idle');
  assert.equal(speaker.speaking, false);
  speaker.dispose(); delete globalThis.window.speechSynthesis; delete globalThis.window.SpeechSynthesisUtterance;
});

test('prepare only checks availability and shares it with the first utterance', async () => {
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    return url.endsWith('/status') ? { ok: true, json: async () => ({available:true}) }
      : { ok: true, blob: async () => new Blob(['audio']) };
  };
  const speaker = speech.createSpeaker({preferences:()=>({engine:'natural',speed:1})});
  await speaker.prepare(); await speaker.prepare();
  assert.deepEqual(calls, ['/api/tts/status']);
  assert.equal(speaker.speaking, false);
  speaker.say('First sentence.');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(calls, ['/api/tts/status', '/api/tts']);
  speaker.dispose();
});
