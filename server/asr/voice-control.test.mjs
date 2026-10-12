import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the actual control without a microphone, server, or learner records.
const source = (await fs.readFile(new URL('../../web/js/voice.js', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replaceAll('export ', '');
class Element extends EventTarget {
  constructor() { super(); this.children = []; this.hidden = false; this.textContent = ''; this.classList = { toggle() {} }; }
  setAttribute(k, v) { this[k] = v; }
  append(...nodes) { this.children.push(...nodes); }
}
function harness({ meter = true, result = { ok: true, text: 'Hello world' } } = {}) {
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
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(a) { a.fill(0.08); } }; }
    createMediaStreamSource() { return { connect() {} }; }
    close() {}
  } });
  const el = (_, props = {}, children = []) => {
    const e = new Element(); Object.assign(e, props); e.textContent = props.text || ''; e.children = children.filter(Boolean); return e;
  };
  const ctx = vm.createContext({
    window, MediaRecorder: Recorder, Blob, AbortController,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped++; } }] }) } },
    document: { createElementNS: () => new Element() },
    el, clear: (e) => { e.children = []; }, replace: (e, nodes) => { e.children = nodes.filter(Boolean); },
    transcribeAudio: async (_slug, blob, opts) => { requests.push({ blob, opts }); return typeof result === 'function' ? result(opts) : result; },
    logSessionEvent: async () => {},
    setInterval: interval, clearInterval: (id) => timers.delete(id),
    setTimeout: () => ++timerId, clearTimeout() {},
    Date: { now: () => now },
  });
  vm.runInContext(source + '\nthis.make = createVoiceControl;', ctx);
  const voice = ctx.make({ getSlug: () => '', logTakes: false, onTranscript: (text) => emitted.push(text) });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { voice, requests, emitted, stopped: () => stopped, flush,
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

test('missing audio meter still sends recording rather than discarding every segment', async () => {
  const h = harness({ meter: false }); await h.voice.start(); await h.advance(3100);
  assert.deepEqual(h.emitted, ['Hello world']);
  h.voice.stop(); await h.flush(); h.voice.dispose();
});

test('empty take shows compact notice; service errors retain their real cause', async () => {
  for (const result of [{ ok: false, kind: 'empty_transcript' }, { ok: false, kind: 'offline', message: 'Server offline' }]) {
    const h = harness({ result }); await h.voice.start(); await h.advance(1100); h.voice.stop(); await h.flush();
    const text = h.voice.status.children.map(e => e.textContent).join(' ');
    assert.match(text, result.kind === 'offline' ? /Server offline/ : /No speech detected\. Try again\./);
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
