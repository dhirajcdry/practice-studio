import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { filterTranscript, hasVoicedAudio } from '../../web/js/transcript-filter.js';

// Exercise the actual control without a microphone, server, or learner records.
const source = (await fs.readFile(new URL('../../web/js/voice.js', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replaceAll('export ', '');
class Element extends EventTarget {
  constructor() { super(); this.children = []; this.hidden = false; this.textContent = ''; this.classList = { toggle() {} }; }
  setAttribute(k, v) { this[k] = v; }
  append(...nodes) { this.children.push(...nodes); }
}
function harness({ signal = () => 0.08, meter = true, result = { ok: true, text: 'Hello world' }, permission = null, voiceOptions = {} } = {}) {
  let now = 0, stopped = 0;
  const timers = new Map(), requests = [], emitted = [];
  let timerId = 0;
  const interval = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, next: now + ms }); return id; };
  class Recorder extends EventTarget {
    static isTypeSupported() { return true; }
    constructor() { super(); this.mimeType = 'audio/webm'; }
    start() {}
    requestData() { const e = new Event('dataavailable'); e.data = new Blob(['audio']); this.dispatchEvent(e); }
    stop() { queueMicrotask(() => { this.requestData(); this.dispatchEvent(new Event('stop')); }); }
  }
  const window = new EventTarget();
  Object.assign(window, { MediaRecorder: Recorder, AudioContext: class {
    constructor() { if (!meter) throw new Error('No meter'); this.state = 'running'; }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(a) { a.fill(signal(now)); } }; }
    createMediaStreamSource() { return { connect() {} }; }
    close() {}
  } });
  const el = (_, props = {}, children = []) => {
    const e = new Element(); Object.assign(e, props); e.textContent = props.text || ''; e.children = (Array.isArray(children) ? children : [children]).filter(Boolean); return e;
  };
  const ctx = vm.createContext({
    window, MediaRecorder: Recorder, Blob, AbortController, filterTranscript, hasVoicedAudio,
    navigator: { mediaDevices: { getUserMedia: async () => { if (permission) await permission; return { getTracks: () => [{ stop() { stopped++; } }] }; } } },
    document: { createElementNS: () => new Element() },
    icon: () => new Element(),
    el, clear: (e) => { e.children = []; }, replace: (e, nodes) => { e.children = nodes.filter(Boolean); },
    transcribeAudio: async (_slug, blob, opts) => { requests.push({ blob, opts }); return typeof result === 'function' ? result(opts) : result; },
    logSessionEvent: async () => {},
    setInterval: interval, clearInterval: (id) => timers.delete(id),
    setTimeout: () => ++timerId, clearTimeout() {},
    Date: { now: () => now },
  });
  vm.runInContext(source + '\nthis.make = createVoiceControl;', ctx);
  const voice = ctx.make({ ...voiceOptions, getSlug: () => '', logTakes: false, onTranscript: (text) => emitted.push(text) });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { voice, window, requests, emitted, stopped: () => stopped, flush,
    async advance(ms) { const end = now + ms; while (now < end) { now += 100; for (const t of [...timers.values()]) if (t.next <= now) { t.next += t.ms; t.fn(); } await flush(); } },
  };
}

test('live preview appears before pause; final phrase is inserted only once', async () => {
  const h = harness(); await h.voice.start(); await h.advance(1700);
  assert.equal(h.voice.preview.textContent, 'Hello world');
  assert.equal(h.voice.preview.hidden, false);
  assert.equal(h.emitted.length, 0, 'partial recognition must not duplicate composer text');
  h.voice.stop(); await h.flush();
  assert.deepEqual(h.emitted, ['Hello world']);
  assert.equal(h.voice.preview.hidden, true);
  assert.equal(h.stopped(), 1);
  h.voice.dispose();
});

test('missing audio meter releases the microphone without transcribing unchecked audio', async () => {
  const h = harness({ meter: false }); await h.voice.start(); await h.advance(3100);
  assert.deepEqual(h.emitted, []);
  assert.equal(h.requests.length, 0);
  assert.equal(h.stopped(), 1);
  h.voice.stop(); await h.flush(); h.voice.dispose();
});

test('empty take shows compact notice; service errors retain their real cause', async () => {
  for (const result of [{ ok: false, kind: 'empty_transcript' }, { ok: false, kind: 'offline', message: 'Server offline' }]) {
    const h = harness({ result }); await h.voice.start(); await h.advance(1100); h.voice.stop(); await h.flush();
    const text = h.voice.status.children.map(e => e.textContent).join(' ');
    assert.match(text, result.kind === 'offline' ? /Some words need another pass/ : /No speech detected\. Try again\./);
    assert.equal(h.emitted.length, 0); h.voice.dispose();
  }
});

test('late preview after stop cannot replace or duplicate the final transcript', async () => {
  let resolvePreview;
  const h = harness({ result: (opts) => opts.filename.startsWith('preview') ? new Promise(r => { resolvePreview = r; }) : { ok: true, text: 'Final words' } });
  await h.voice.start(); await h.advance(1700); h.voice.stop(); await h.flush();
  resolvePreview({ ok: true, text: 'Stale partial' }); await h.flush();
  assert.deepEqual(h.emitted, ['Final words']); assert.equal(h.voice.preview.hidden, true); h.voice.dispose();
});

test('a delayed preview survives its phrase cut until final transcription arrives', async () => {
  let partial, final;
  const h = harness({ signal: now => now < 1200 ? .08 : 0,
    result: opts => new Promise(resolve => { if (opts.preview) partial = resolve; else final = resolve; }) });
  await h.voice.start(); await h.advance(2100);
  assert.equal(typeof final, 'function', 'the phrase must already have been cut');
  assert.equal(h.requests.find(r => r.opts.preview).opts.signal.aborted, false);
  partial({ok:true,text:'Provisional words'}); await h.flush();
  assert.equal(h.voice.preview.textContent, 'Provisional words');
  assert.deepEqual(h.emitted, []);
  final({ok:true,text:'Confirmed words'}); await h.flush();
  assert.deepEqual(h.emitted, ['Confirmed words']);
  assert.equal(h.voice.preview.hidden, true);
  h.voice.stop(); await h.flush(); h.voice.dispose();
});

test('pending phrase previews stay ordered and an empty final clears its provisional text', async () => {
  const partials = [], finals = [];
  const h = harness({ signal: now => now < 1200 || now > 2400 ? .08 : 0,
    result: opts => new Promise(resolve => (opts.preview ? partials : finals).push(resolve)) });
  await h.voice.start(); await h.advance(2100);
  partials[0]({ok:true,text:'First provisional'}); await h.flush();
  await h.advance(1600);
  assert.equal(finals.length, 1, 'first final is still pending');
  assert.equal(partials.length, 2, 'a later phrase can preview while the first final is pending');
  await h.advance(1000);
  assert.equal(partials.length, 2, 'only one preview may be in flight');
  partials[1]({ok:true,text:'Second provisional'}); await h.flush();
  assert.equal(h.voice.preview.textContent, 'First provisional Second provisional');
  h.voice.stop(); await h.flush();
  finals[1]({ok:true,text:'Second confirmed'}); await h.flush();
  assert.equal(h.voice.preview.textContent, 'First provisional Second confirmed');
  assert.deepEqual(h.emitted, []);
  finals[0]({ok:false,kind:'empty_transcript'}); await h.flush();
  assert.deepEqual(h.emitted, ['Second confirmed']);
  assert.equal(h.voice.preview.textContent, '');
  assert.equal(h.voice.preview.hidden, true); h.voice.dispose();
});

test('a preview from a previous take cannot reappear in the next take', async () => {
  let partial;
  const h = harness({ result: opts => opts.preview ? new Promise(resolve => { partial = resolve; }) : {ok:true,text:'Confirmed'} });
  await h.voice.start(); await h.advance(1100); h.voice.stop(); await h.flush();
  await h.voice.start();
  partial({ok:true,text:'Old provisional'}); await h.flush();
  assert.equal(h.voice.preview.hidden, true);
  assert.deepEqual(h.emitted, ['Confirmed']);
  h.voice.stop(); await h.flush(); h.voice.dispose();
});

test('finish disposal drains an in-flight transcription after detaching', async () => {
  let resolve;
  const h = harness({ result: () => new Promise(r => { resolve = r; }) });
  await h.voice.start(); await h.advance(1700); h.voice.stop();
  h.voice.dispose({ finish: true });
  await h.flush();
  resolve({ ok: true, text: 'Words after navigation' });
  await h.flush();
  assert.deepEqual(h.emitted, ['Words after navigation']);
});

test('blur stops the microphone, then finishing disposal preserves the completed phrase', async () => {
  const h = harness(); await h.voice.start(); await h.advance(1700);
  // The control listens to blur as the browser navigation/focus boundary.
  h.window.dispatchEvent(new Event('blur'));
  await h.flush();
  assert.deepEqual(h.emitted, ['Hello world']);
  h.voice.dispose({ finish: true });
  assert.equal(h.stopped(), 1);
});

test('disposing while permission is opening releases the eventual stream', async () => {
  let grant;
  const permission = new Promise(resolve => { grant = resolve; });
  const h = harness({ permission });
  const opening = h.voice.start();
  assert.equal(h.voice.isBusy(), true);
  h.voice.dispose({ finish: true });
  grant();
  await opening;
  assert.equal(h.stopped(), 1);
  assert.equal(h.voice.isBusy(), false);
  assert.equal(h.requests.length, 0);
});

test('recording navigation drains its tail and guards unload only until it finishes', async () => {
  let finish;
  const h = harness({ result: opts => opts.filename.startsWith('preview')
    ? { ok: true, text: 'preview' } : new Promise(resolve => { finish = resolve; }) });
  const guarded = () => {
    const event = new Event('beforeunload', { cancelable: true });
    h.window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(guarded(), false);
  await h.voice.start(); await h.advance(1700);
  assert.equal(guarded(), true);
  h.window.dispatchEvent(new Event('blur'));
  h.voice.dispose({ finish: true });
  await h.flush();
  assert.equal(guarded(), true);
  finish({ ok: true, text: 'The last words' }); await h.flush();
  assert.deepEqual(h.emitted, ['The last words']);
  assert.equal(guarded(), false);
  assert.equal(h.stopped(), 1);
});


test('silence and isolated typing bursts never reach ASR, even on Stop', async () => {
  for (const signal of [() => 0, now => now % 500 === 0 ? 0.1 : 0]) {
    const h = harness({ signal }); await h.voice.start(); await h.advance(14000);
    h.voice.stop(); await h.flush();
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.emitted, []); h.voice.dispose();
  }
});

test('noise transcripts cannot enter preview or composer; real short answers can', async () => {
  for (const text of ['[DOOR SLAMS]', '(keyboard clicking) Thanks.', 'Yes.', 'O(n).', 'Two pointers.']) {
    const h = harness({ result: { ok: true, text } });
    await h.voice.start(); await h.advance(1700);
    assert.equal(h.voice.preview.textContent, filterTranscript(text));
    h.voice.stop(); await h.flush();
    assert.deepEqual(h.emitted, filterTranscript(text) ? [text] : []); h.voice.dispose();
  }
});


test('continuous interview silence settles quietly and resumes only after draining', async () => {
  let settled = 0;
  const h = harness({ signal: () => 0, voiceOptions: { reportEmptyTake: false, onSettled: () => settled++ } });
  await h.voice.start(); await h.advance(1100); h.voice.stop(); await h.flush();
  assert.equal(h.voice.status.hidden, true, 'normal silent transitions do not warn');
  assert.equal(settled, 1);
  assert.equal(h.voice.isBusy(), false);
  h.voice.dispose();
});

test('continuous interview mode preserves service errors without requesting resume', async () => {
  let settled = 0;
  const h = harness({ result: { ok: false, kind: 'offline', message: 'Server offline' },
    voiceOptions: { reportEmptyTake: false, onSettled: () => settled++ } });
  await h.voice.start(); await h.advance(1100); h.voice.stop(); await h.flush();
  assert.match(h.voice.status.children.map(e => e.textContent).join(' '), /Some words need another pass/);
  assert.equal(settled, 0);
  h.voice.dispose();
});


test('interview resume callback waits for final transcription to drain', async () => {
  let finish, settled = 0;
  const h = harness({ result: () => new Promise(resolve => { finish = resolve; }),
    voiceOptions: { reportEmptyTake: false, onSettled: () => {
      assert.equal(h.voice.isBusy(), false);
      assert.deepEqual(h.emitted, ['Final answer']);
      settled++;
    } } });
  await h.voice.start(); await h.advance(1100); h.voice.stop(); await h.flush();
  assert.equal(h.voice.isBusy(), true);
  assert.equal(settled, 0);
  finish({ ok: true, text: 'Final answer' }); await h.flush();
  assert.equal(settled, 1);
  h.voice.dispose();
});

test('failed audio blocks later phrases, retries in original order, and retains unload guard', async () => {
  let finals = 0;
  const h = harness({ signal: now => now < 1200 || now > 2400 ? .08 : 0,
    result: opts => opts.preview ? {ok:true,text:'Partial'} : ++finals === 1
      ? {ok:false,kind:'offline',message:'Server offline'} : {ok:true,text: finals === 2 ? 'Second phrase' : 'First phrase'} });
  await h.voice.start(); await h.advance(3700); h.voice.stop(); await h.flush();
  assert.equal(h.voice.hasTranscriptionError(), true);
  assert.deepEqual(h.emitted, [], 'later words cannot jump the failed phrase');
  const leave = new Event('beforeunload', {cancelable:true}); h.window.dispatchEvent(leave);
  assert.equal(leave.defaultPrevented, true);
  await h.voice.start(); assert.equal(h.voice.isRecording(), false, 'new take cannot erase failed audio');
  await h.voice.retry(); await h.flush();
  assert.deepEqual(h.emitted, ['First phrase','Second phrase']);
  assert.equal(h.voice.hasTranscriptionError(), false);
  const safe = new Event('beforeunload', {cancelable:true}); h.window.dispatchEvent(safe);
  assert.equal(safe.defaultPrevented, false); h.voice.dispose();
});

test('retry during recording drains final words then retries without a second click', async () => {
  let finals = 0;
  const h = harness({signal:now=>now<1200||now>2400?.08:0,
    result: opts=>opts.preview?{ok:true,text:'Partial'}:++finals===1
      ? {ok:false,kind:'offline',message:'Offline'}:{ok:true,text:finals===2?'Second':'First'}});
  await h.voice.start(); await h.advance(3700);
  assert.equal(h.voice.hasTranscriptionError(), true);
  await h.voice.retry(); await h.flush();
  assert.deepEqual(h.emitted, ['First','Second']);
  assert.equal(h.voice.isBusy(), false); h.voice.dispose();
});

test('explicitly discarding failed audio releases later confirmed words', async () => {
  let finals = 0;
  const h = harness({signal:now=>now<1200||now>2400?.08:0,
    result: opts=>opts.preview?{ok:true,text:'Partial'}:++finals===1
      ? {ok:false,kind:'offline',message:'Offline'}:{ok:true,text:'Second'}});
  await h.voice.start(); await h.advance(3700); h.voice.stop(); await h.flush();
  h.voice.discardFailed();
  assert.deepEqual(h.emitted, ['Second']); assert.equal(h.voice.hasTranscriptionError(), false);
  h.voice.dispose();
});
