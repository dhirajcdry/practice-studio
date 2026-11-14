import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { filterTranscript, hasVoicedAudio } from '../../web/js/transcript-filter.js';
import { watchPresence, AWAY_HEAD } from '../../web/js/voice-loop.js';

// Exercise the actual control without a microphone, server, or learner records.
const source = (await fs.readFile(new URL('../../web/js/voice.js', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replaceAll('export ', '');
class Element extends EventTarget {
  constructor() { super(); this.children = []; this.hidden = false; this.textContent = ''; this.classList = { toggle() {} }; }
  setAttribute(k, v) { this[k] = v; }
  append(...nodes) { this.children.push(...nodes); }
}
function harness({ signal = () => 0.08, meter = true, result = { ok: true, text: 'Hello world' }, permission = null, voiceOptions = {} } = {}) {
  let now = 0, stopped = 0, opened = 0, contexts = 0, closedContexts = 0, focused = true, hidden = false;
  const timers = new Map(), requests = [], emitted = [], starts = [], levels = [];
  let timerId = 0;
  const interval = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, next: now + ms }); return id; };
  class Recorder extends EventTarget {
    static isTypeSupported() { return true; }
    constructor() { super(); this.mimeType = 'audio/webm'; }
    start() { starts.push(now); }
    requestData() { const e = new Event('dataavailable'); e.data = new Blob(['audio']); this.dispatchEvent(e); }
    stop() { queueMicrotask(() => { this.requestData(); this.dispatchEvent(new Event('stop')); }); }
  }
  const window = new EventTarget();
  Object.assign(window, { MediaRecorder: Recorder, AudioContext: class {
    constructor() { if (!meter) throw new Error('No meter'); this.state = 'running'; contexts++; }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(a) { a.fill(signal(now)); } }; }
    createMediaStreamSource() { return { connect() {} }; }
    close() { closedContexts++; }
  } });
  // Presence is the real shared watcher (voice-loop.js) over a page whose focus and
  // visibility the test controls, dispatching the events a browser would.
  const document = Object.assign(new EventTarget(), { createElementNS: () => new Element(), hasFocus: () => focused,
    get hidden() { return hidden; }, get visibilityState() { return hidden ? 'hidden' : 'visible'; } });
  const el = (_, props = {}, children = []) => {
    const e = new Element(); Object.assign(e, props); e.textContent = props.text || ''; e.children = (Array.isArray(children) ? children : [children]).filter(Boolean); return e;
  };
  const ctx = vm.createContext({
    window, MediaRecorder: Recorder, Blob, AbortController, queueMicrotask, filterTranscript, hasVoicedAudio,
    watchPresence: fn => watchPresence(fn, { win: window, doc: document }), AWAY_HEAD,
    navigator: { mediaDevices: { getUserMedia: async () => { opened++; if (permission) await permission; return { getTracks: () => [{ stop() { stopped++; } }] }; } } },
    document,
    icon: () => new Element(),
    el, clear: (e) => { e.children = []; }, replace: (e, nodes) => { e.children = nodes.filter(Boolean); },
    transcribeAudio: async (_slug, blob, opts) => { requests.push({ blob, opts, at: now }); return typeof result === 'function' ? result(opts) : result; },
    logSessionEvent: async () => {},
    setInterval: interval, clearInterval: (id) => timers.delete(id),
    setTimeout: () => ++timerId, clearTimeout() {},
    Date: { now: () => now },
  });
  vm.runInContext(source + '\nthis.make = createVoiceControl;', ctx);
  const voice = ctx.make({ onLevel: (value) => levels.push({ at: now, ...value }), ...voiceOptions, getSlug: () => '', logTakes: false, onTranscript: (text) => emitted.push(text) });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { voice, window, requests, emitted, starts, levels, stopped: () => stopped, opened: () => opened, liveContexts: () => contexts - closedContexts, flush,
    blur() { focused = false; window.dispatchEvent(new Event('blur')); },
    hide() { hidden = true; focused = false; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('blur')); },
    async back() { hidden = false; focused = true; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); await new Promise(r => setTimeout(r, 5)); await flush(); },
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

test('flushing an answer transcribes it without closing capture or losing the next phrase', async () => {
  const h = harness(); await h.voice.start(); await h.advance(1100);
  await h.voice.flush();
  assert.deepEqual(h.emitted, ['Hello world']);
  assert.equal(h.voice.isRecording(), true);
  assert.equal(h.stopped(), 0, 'sending an answer must not release the device');
  await h.advance(1100); await h.voice.flush();
  assert.deepEqual(h.emitted, ['Hello world', 'Hello world']);
  assert.equal(h.stopped(), 0);
  h.voice.stop(); await h.flush(); h.voice.dispose();
  assert.equal(h.stopped(), 1);
});

test('continuous speech is not relearned as background noise across phrase boundaries', async () => {
  let loud = true;
  const h = harness({signal: () => loud ? .08 : 0});
  await h.voice.start(); await h.advance(40000);
  loud = false; await h.advance(1000);
  assert.equal(h.requests.filter(request => !request.opts.preview).length, 3,
    'two hard-capped phrases and the final tail must all reach ASR');
  assert.equal(h.emitted.length, 3);
  assert.equal(h.stopped(), 0);
  h.voice.stop(); await h.flush(); h.voice.dispose();
});

test('a flush waits for its own final ASR result while a new utterance stays live', async () => {
  const finals = [];
  const h = harness({ result: opts => opts.preview ? {ok:true,text:'Preview'} : new Promise(resolve => finals.push(resolve)) });
  await h.voice.start(); await h.advance(1100);
  let ready = false;
  const first = h.voice.flush().then(() => { ready = true; }); await h.flush();
  assert.equal(ready, false);
  await h.advance(1100);
  const second = h.voice.flush(); await h.flush();
  assert.equal(finals.length, 2);
  finals[0]({ok:true,text:'The first answer'}); await first;
  assert.deepEqual(h.emitted, ['The first answer']);
  assert.equal(h.voice.isRecording(), true);
  finals[1]({ok:true,text:'A new interruption'}); await second;
  assert.deepEqual(h.emitted, ['The first answer', 'A new interruption']);
  assert.equal(h.stopped(), 0);
  h.voice.stop(); await h.flush(); h.voice.dispose();
});

test('flush rejects failed transcription and keeps the audio for explicit retry', async () => {
  let failed = true;
  const h = harness({result: () => failed ? {ok:false,kind:'offline',message:'Offline'} : {ok:true,text:'Recovered words'}});
  await h.voice.start(); await h.advance(1100);
  await assert.rejects(h.voice.flush(), /Retry or discard/);
  assert.equal(h.voice.hasTranscriptionError(), true);
  assert.deepEqual(h.emitted, []);
  failed = false; await h.voice.retry(); await h.flush();
  assert.deepEqual(h.emitted, ['Recovered words']);
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
  // Another window in front is the browser's away boundary (voice-loop.js presence).
  h.blur();
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
  h.blur();
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

const finals = h => h.requests.filter(request => !request.opts.preview);

test('a long monologue is cut at a gap between words, not mid-word, and still hard-capped', async () => {
  const dip = harness({ signal: now => now > 13000 && now <= 13300 ? 0 : .08 });
  await dip.voice.start(); await dip.advance(13500);
  assert.equal(finals(dip).length, 1);
  assert.ok(finals(dip)[0].at > 13000, 'no cut while every frame is speech');
  dip.voice.stop(); await dip.flush(); dip.voice.dispose();
  const solid = harness();
  await solid.voice.start(); await solid.advance(17900);
  assert.equal(finals(solid).length, 0, 'uninterrupted sound waits for a word gap');
  await solid.advance(300);
  assert.equal(finals(solid).length, 1, 'but never past the hard cap');
  solid.voice.stop(); await solid.flush(); solid.voice.dispose();
});

test('long thinking silence before an answer is not sent ahead of it', async () => {
  const h = harness({ signal: now => now > 8000 && now <= 9500 ? .08 : 0 });
  await h.voice.start(); await h.advance(11000);
  assert.equal(finals(h).length, 1);
  const phraseStart = h.starts.filter(at => at <= 8000).at(-1);
  assert.ok(8000 - phraseStart <= 3200, `leading silence was ${8000 - phraseStart} ms`);
  assert.deepEqual(h.emitted, ['Hello world']);
  h.voice.stop(); await h.flush(); h.voice.dispose();
});

test('restarting a silent phrase does not reset the end-of-turn silence clock', async () => {
  const h = harness({ signal: now => now <= 1500 ? .08 : 0 });
  await h.voice.start(); await h.advance(9000);
  assert.ok(h.starts.length >= 3, 'silent phrases were restarted');
  assert.ok(Math.max(...h.levels.map(l => l.sinceLoud)) >= 6000, 'silence keeps counting across restarts');
  h.voice.stop(); await h.flush(); h.voice.dispose();
});

// Away (page hidden or another window in front): release now, keep the words, resume on return.
test('leaving mid-take releases the tracks, keeps the heard words, and resumes on return', async () => {
  const h = harness(); await h.voice.start(); await h.advance(1700);
  h.blur();
  assert.equal(h.stopped(), 1, 'tracks stop the moment the window loses focus');
  assert.equal(h.voice.awaitingReturn(), true);
  await h.flush();
  assert.deepEqual(h.emitted, ['Hello world'], 'words heard before leaving drain into the draft');
  assert.equal(h.voice.isBusy(), false);
  assert.equal(h.voice.status.children[0]?.text, AWAY_HEAD, 'the status says why the mic is off, not "nothing heard"');
  await h.advance(5000);
  assert.equal(h.opened(), 1, 'nothing reacquires while away');
  await h.back();
  assert.equal(h.opened(), 2, 'returning resumes with no click');
  assert.equal(h.voice.isRecording(), true);
  assert.equal(h.voice.awaitingReturn(), false);
  assert.equal(h.voice.status.hidden, true);
  h.voice.dispose();
});

test('a start while away is held, not attempted, and the surface decides on return', async () => {
  let returned = 0;
  const h = harness({ voiceOptions: { onReturn: () => returned++ } });
  h.hide();
  await h.voice.start();
  assert.equal(h.opened(), 0, 'no microphone is opened for a hidden page');
  assert.equal(h.voice.isBusy(), false);
  assert.equal(h.voice.awaitingReturn(), true);
  await h.back();
  assert.equal(returned, 1, 'onReturn lets the surface re-run its own gate');
  assert.equal(h.opened(), 0);
  h.voice.dispose();
});

test('stopping on purpose while away cancels the held take', async () => {
  const h = harness(); await h.voice.start(); await h.advance(1700);
  h.hide(); await h.flush();
  h.voice.stop();
  assert.equal(h.voice.awaitingReturn(), false);
  await h.back();
  assert.equal(h.opened(), 1, 'a pause, mode change or finish while away is not undone by returning');
  h.voice.dispose();
});

test('returning while the last phrase still drains resumes once it settles', async () => {
  let finish;
  const h = harness({ result: opts => opts.filename.startsWith('preview') ? { ok: true, text: 'p' } : new Promise(resolve => { finish = resolve; }) });
  await h.voice.start(); await h.advance(1700);
  h.blur(); await h.back();
  assert.equal(h.opened(), 1, 'still transcribing: not reopened yet');
  finish({ ok: true, text: 'Last words' }); await h.flush();
  assert.deepEqual(h.emitted, ['Last words']);
  assert.equal(h.opened(), 2);
  assert.equal(h.voice.isRecording(), true);
  h.voice.dispose();
});

test('five away/return cycles leave exactly one live stream and one meter', async () => {
  const h = harness({ signal: () => 0 }); await h.voice.start(); await h.advance(300);
  for (let i = 0; i < 5; i++) {
    if (i % 2) h.hide(); else h.blur();
    await h.flush();
    assert.equal(h.opened() - h.stopped(), 0, `away #${i + 1}: no live track`);
    await h.back();
    assert.equal(h.voice.isRecording(), true, `return #${i + 1}: listening`);
  }
  assert.equal(h.opened(), 6);
  assert.equal(h.opened() - h.stopped(), 1);
  assert.equal(h.liveContexts(), 1);
  h.voice.dispose();
  assert.equal(h.opened() - h.stopped(), 0);
  assert.equal(h.liveContexts(), 0);
});

// A return (or a reload restoring a draft) must not let going quiet send old words.
test('after a return the quiet countdown is armed only by new speech', async () => {
  let level = 0.08;
  const h = harness({ signal: () => level }); await h.voice.start(); await h.advance(1700);
  assert.equal(h.levels.at(-1).armed, true, 'a fresh take counts down as before');
  h.blur(); level = 0; await h.flush();
  await h.back();
  const back = h.levels.length;
  await h.advance(5000);
  const quiet = h.levels.slice(back);
  assert.ok(quiet.length > 0 && quiet.every(l => l.armed === false), 'returning and staying quiet never arms the send');
  assert.ok(quiet.at(-1).sinceLoud >= 2200, 'well past the quiet window');
  level = 0.08; await h.advance(1500); level = 0; await h.advance(4000);
  assert.equal(h.levels.at(-1).armed, true, 'new speech arms it again');
  assert.ok(h.levels.at(-1).sinceLoud >= 2200);
  h.voice.dispose();
});

test('requireFreshSpeech holds a restored draft until you speak again', async () => {
  let level = 0;
  const h = harness({ signal: () => level });
  h.voice.requireFreshSpeech(); await h.voice.start(); await h.advance(3000);
  assert.ok(h.levels.length > 0 && h.levels.every(l => l.armed === false));
  level = 0.08; await h.advance(1500);
  assert.equal(h.levels.at(-1).armed, true);
  h.voice.dispose();
});
