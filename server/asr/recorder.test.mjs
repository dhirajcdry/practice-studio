import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = (await fs.readFile(new URL('../../web/js/recorder.js', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replaceAll('export ', '');
const stateSource = (await fs.readFile(new URL('../../web/js/attempt-state.js', import.meta.url), 'utf8')).replaceAll('export ', '');
function harness(saved = null, denied = false, transcribe = null) {
  const timers = [];
  let now = 10_000, slug = 'two-sum', closed = 0, starts = 0;
  const events = [], audio = [], reviews = [], values = new Map();
  if (saved) values.set('studio.attempt.v1', JSON.stringify(saved));
  const el = (_, props = {}, children = []) => ({ ...props, children, textContent: props.text || '',
    dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, remove() {} });
  class Recorder {
    static isTypeSupported() { return true; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => { this.ondataavailable({ data: new Blob(['speech']) }); this.onstop(); });
    }
  }
  const window = new EventTarget(); window.MediaRecorder = Recorder;
  const ctx = vm.createContext({ window, MediaRecorder: Recorder, Blob, el,
    Date: class extends Date { static now() { return now; } },
    navigator: { mediaDevices: { getUserMedia: async () => {
      if (denied) throw Error('permission denied');
      return { getTracks: () => [{ stop() { closed++; } }] };
    } } },
    localStorage: { getItem: k => values.get(k) || null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) },
    transcribeAudio: async (slug, _blob, options) => { audio.push({ slug, ...options }); return transcribe ? transcribe() : { ok: true, text: 'my reasoning' }; },
    logSessionEvent: async (slug, type, data) => { events.push({ slug, type, data }); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  });
  vm.runInContext(stateSource + '\n' + source + '\nthis.make = createRecorder;', ctx);
  const recorder = ctx.make({ getSlug: () => slug, getTitle: s => s === 'two-sum' ? 'Two Sum' : s,
    onAttemptStart: () => starts++, onAttemptEnd: detail => reviews.push(detail) });
  const settle = async () => { for (let i=0;i<20;i++) await Promise.resolve(); };
  return { recorder, events, audio, reviews, window, settle, values, timers,
    advance(ms) { now += ms; }, navigate(to) { slug = to; recorder.refresh(); },
    allow() { denied = false; }, starts: () => starts, closed: () => closed };
}

test('navigation retains the attempt and files all speech/review under its original slug', async () => {
  const h = harness(); await h.recorder.start(); h.advance(2000);
  const saved = JSON.parse(h.values.get('studio.attempt.v1'));
  h.navigate('contains-duplicate');
  assert.equal(h.recorder.isLive(), true);
  assert.equal(h.closed(), 0);
  await h.recorder.stop();
  assert.equal(h.audio[0].slug, 'two-sum');
  assert.equal(h.audio[0].attemptId, saved.attemptId);
  assert.equal(h.reviews[0].slug, 'two-sum');
  assert.equal(h.reviews[0].spokenMs, 2000);
  assert.equal(h.events.filter(e=>e.type==='attempt_ended').length, 1);
  assert.equal(h.values.has('studio.attempt.v1'), false);
});

test('denied automatic resume remains the same attempt when permission is granted', async () => {
  const saved = { attemptId: 'original', slug: 'two-sum', title: 'Two Sum', startedAt: 1000, savedMs: 3000 };
  const h = harness(saved, true); h.recorder.restore(); await h.settle();
  assert.equal(h.recorder.isLive(), true);
  assert.equal(h.recorder.isRecording(), false);
  assert.equal(h.starts(), 0);
  assert.equal(h.events.filter(e=>e.type==='attempt_resumed').length, 1);
  h.allow(); await h.recorder.start();
  assert.equal(h.starts(), 0);
  assert.equal(JSON.parse(h.values.get('studio.attempt.v1')).attemptId, 'original');
  await h.recorder.stop();
  assert.equal(h.reviews[0].attemptId, 'original');
  assert.equal(h.reviews[0].elapsedMs, 9000);
});

test('stale attempt closes once without opening audio, starting a thread or reviewing', () => {
  const h = harness({ attemptId: 'stale', slug: 'two-sum', startedAt: -30_000_000, savedMs: 100 });
  h.recorder.restore(); h.recorder.restore();
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].data.stale, true);
  assert.equal(h.starts(), 0);
  assert.equal(h.reviews.length, 0);
  assert.equal(h.recorder.isLive(), false);
});


test('stop finishes after 60 seconds even when a transcription is wedged', async () => {
  let finishUpload;
  const upload = new Promise(resolve => { finishUpload = resolve; });
  const h = harness(null, false, () => upload);
  await h.recorder.start(); h.advance(2000);
  const stopping = h.recorder.stop();
  await h.settle();
  assert.equal(h.events.some(e => e.type === 'attempt_ended'), false);
  const deadline = h.timers.find(t => t.ms === 60_000);
  assert.ok(deadline);
  deadline.fn();
  await stopping;
  assert.equal(h.recorder.isLive(), false);
  assert.equal(h.events.filter(e => e.type === 'attempt_ended').length, 1);
  finishUpload({ ok: true, text: 'late reasoning' });
  await h.settle();
  assert.equal(h.events.filter(e => e.type === 'attempt_ended').length, 1);
});
