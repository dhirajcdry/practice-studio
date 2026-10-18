import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeaker } from '../../web/js/speech.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(t, { available = true, fail = false, deferred = false } = {}) {
  const original = { window: globalThis.window, fetch: globalThis.fetch };
  const requests = [], plays = [], spoken = [], states = [];
  let release;
  class Audio {
    play() { plays.push(this); return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute() { this.src = ''; }
  }
  globalThis.window = { Audio, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: { getVoices: () => [], speak: u => spoken.push(u), cancel() {} } };
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('status')) return { ok: true, json: async () => ({ available }) };
    requests.push(JSON.parse(options.body));
    if (deferred) await new Promise(resolve => { release = resolve; });
    if (fail) throw Error('failed');
    return { ok: true, blob: async () => new Blob(['wav']) };
  };
  t.after(() => { globalThis.window = original.window; globalThis.fetch = original.fetch; });
  const speaker = createSpeaker({ onStateChange: state => states.push(state), preferences: () => ({ engine: 'natural', voice: 'af_heart', speed: 1 }) });
  t.after(() => speaker.dispose());
  return { speaker, requests, plays, spoken, states, release: () => release?.() };
}
test('natural queue prefetches one sentence and holds echo gate across playback', async t => {
  const h = harness(t);
  h.speaker.say('**First** sentence. Second sentence. Third sentence.');
  assert.equal(h.speaker.speaking, true);
  await tick();
  assert.deepEqual(h.requests.map(r => r.text), ['First sentence.', 'Second sentence.']);
  assert.equal(h.plays.length, 1);
  h.plays[0].onended(); await tick();
  assert.equal(h.requests.length, 3); assert.equal(h.plays.length, 2);
  assert.deepEqual(h.states, [true]);
  h.plays[1].onended(); await tick(); h.plays[2].onended(); await tick();
  assert.deepEqual(h.states, [true, false]);
});
test('cancel drops prefetched audio and stops current playback immediately', async t => {
  const h = harness(t); h.speaker.say('First. Second.'); await tick();
  h.speaker.cancel(); await tick();
  assert.equal(h.plays[0].paused, true); assert.equal(h.plays.length, 1);
  assert.equal(h.speaker.speaking, false);
  h.speaker.say('New turn.'); await tick(); assert.equal(h.plays.length, 2);
});
test('cancel during synthesis never plays late results', async t => {
  const h = harness(t, { deferred: true }); h.speaker.say('First.'); await tick();
  h.speaker.cancel(); h.release(); await tick();
  assert.equal(h.plays.length, 0); assert.equal(h.spoken.length, 0);
});
for (const options of [{ available: false }, { fail: true }]) test('system fallback preserves sentence order ' + JSON.stringify(options), async t => {
  const h = harness(t, options); h.speaker.say('First. Second.'); await tick();
  assert.equal(h.spoken[0].text, 'First.'); h.spoken[0].onend(); await tick();
  assert.equal(h.spoken[1].text, 'Second.'); h.spoken[1].onend(); await tick();
  assert.deepEqual(h.states, [true, false]);
});
test('audio failure falls back for the same sentence', async t => {
  const h = harness(t); h.speaker.say('First.'); await tick();
  h.plays[0].onerror(); await tick(); assert.equal(h.spoken[0].text, 'First.');
});
