// Serialized into real Chrome by the mock-screen checks. Only devices, ASR and
// model streams are fake; the mounted interview, draft and voice controls are real.
export async function checkMockVoice(kind) {
  const design = kind === 'design', root = design ? '.dz-compose' : '.ci-composer';
  const input = document.querySelector(design ? '.dz-input' : '.ci-input');
  const panel = () => document.querySelector(root + ' .voice-panel');
  const mic = () => document.querySelector(root + ' .voice-mic');
  const send = () => document.querySelector(design ? '.dz-voice-send' : '.ci-send-now');
  const typed = () => document.querySelector(root + ' .ui-mode-switch[data-mode=typed], ' + root + ' .ui-mode-switch[data-mode=type]');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const require = (condition, label) => { if (!condition) throw Error(kind + ': ' + label); };
  const until = async (condition, label) => {
    for (let i = 0; i < 160; i++) { if (condition()) return; await sleep(25); }
    throw Error(kind + ': ' + label + ' — ' + document.querySelector(root)?.textContent + '; draft=' + input.value
      + '; capture=' + panel()?.dataset.capture + '; counts=' + JSON.stringify({captures:stats.captures,stops:stats.stops}));
  };
  // Finish any existing fake capture before installing this scenario's devices.
  typed()?.click();
  await until(() => !input.closest('[hidden]'), 'typed mode');
  input.value = ''; input.dispatchEvent(new Event('input'));
  const prefs = await import('/js/speech-preferences.js');
  const oldAuto = prefs.autoSendEnabled(), oldVoice = prefs.voicePreferences();
  prefs.saveAutoSend(false); prefs.saveVoicePreferences({ ...oldVoice, engine: 'system' });
  const original = { fetch: window.fetch, media: navigator.mediaDevices.getUserMedia, recorder: window.MediaRecorder,
    context: window.AudioContext, speak: speechSynthesis.speak, cancel: speechSynthesis.cancel };
  const stats = { captures: 0, stops: 0, plays: 0, cancels: 0, level: 0, words: '', asks: [] };
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, writable: true, value: async () => {
    stats.captures++;
    return { getTracks: () => [{ stop() { stats.stops++; }, addEventListener() {} }] };
  } });
  window.MediaRecorder = class extends EventTarget {
    static isTypeSupported() { return true; }
    constructor() { super(); this.mimeType = 'audio/webm'; }
    start() {}
    requestData() { const event = new Event('dataavailable'); event.data = new Blob(['fake audio']); this.dispatchEvent(event); }
    stop() { queueMicrotask(() => { this.requestData(); this.dispatchEvent(new Event('stop')); }); }
  };
  window.AudioContext = class {
    constructor() { this.state = 'running'; }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(samples) { samples.fill(stats.level); } }; }
    close() {}
  };
  speechSynthesis.speak = utterance => { stats.plays++; utterance.onstart?.(); };
  speechSynthesis.cancel = () => { stats.cancels++; };
  const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  window.fetch = async (url, options) => {
    if (String(url).includes('/api/asr')) return json({ text: stats.words });
    if (String(url) === '/api/interview/event') return json({ interjected: false });
    if (String(url) === (design ? '/api/design/turn' : '/api/interview/turn')) {
      const ask = JSON.parse(options.body); stats.asks.push(ask);
      return new Response(new ReadableStream({ start(controller) {
        ask.emit = (name, data) => controller.enqueue(new TextEncoder().encode('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n'));
        ask.finish = () => { ask.emit('done', {}); controller.close(); ask.closed = true; };
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    return original.fetch.call(window, url, options);
  };
  const speak = async words => { stats.words = words; stats.level = .08; await sleep(600); stats.level = 0; };
  const accept = index => stats.asks[index].emit('accepted', { said: stats.asks[index].said, requestId: stats.asks[index].requestId });
  const play = index => stats.asks[index].emit('token', { text: 'Here is the next question. ' });
  try {
    document.querySelector(root + ' .ui-mode-switch[data-mode=voice]').click();
    await until(() => stats.captures === 1 && panel().dataset.capture === 'recording', 'voice joined');
    await speak('The first answer.');
    await until(() => input.value === 'The first answer.' && !send().disabled, 'first final words');
    send().click(); await until(() => stats.asks.length === 1, 'first request');
    require(stats.captures === 1 && stats.stops === 0, 'sending closed the microphone');
    // Capture a correction while the previous request has not even been accepted.
    await speak('Actually, use one lock.');
    await until(() => input.value.includes('Actually, use one lock.'), 'words during acceptance');
    accept(0); play(0);
    await until(() => input.value === 'Actually, use one lock.', 'acceptance consumes only the sent prefix');
    await sleep(50); require(stats.plays === 0, 'old answer spoke over the correction');
    stats.asks[0].finish();
    await until(() => !send().disabled, 'first written reply complete');
    send().click(); await until(() => stats.asks.length === 2, 'correction sent');
    require(stats.asks[1].said === 'Actually, use one lock.', 'correction duplicated or lost');
    accept(1); play(1); await until(() => stats.plays === 1, 'actual playback');
    require(stats.captures === 1 && stats.stops === 0, 'playback closed the microphone');
    require(!mic().hidden && !mic().disabled && mic().getClientRects().length, 'microphone control hidden during playback');
    // Real VAD should stop audio before the final ASR result exists.
    const before = stats.cancels, at = performance.now();
    stats.words = 'Wait, check the caller first.'; stats.level = .08;
    await until(() => stats.cancels > before, 'speech interrupts playback');
    const interruptMs = performance.now() - at;
    require(interruptMs < 650, 'interruption waited for transcription');
    await sleep(400); stats.level = 0;
    await until(() => input.value === 'Wait, check the caller first.', 'first interruption words preserved');
    require(!panel().querySelector('.voice-transcript').hidden, 'interruption transcript hidden');
    play(1); await sleep(100);
    require(stats.plays === 1, 'future tokens restarted interrupted audio');
    require(stats.asks.length === 2, 'overlapping model requests');
    prefs.saveAutoSend(true);
    stats.asks[1].emit('error', { message: 'Synthetic reply failure' }); stats.asks[1].finish();
    await until(() => !send().disabled, 'failed reply settles');
    await sleep(2500);
    require(stats.asks.length === 2, 'failed reply automatically retried or submitted a follow-up');
    require(input.value === 'Wait, check the caller first.', 'failure erased the new words');
    require(panel().querySelector('.voice-state').textContent === 'Answer not sent' && !panel().querySelector('.voice-hint').textContent.includes('Sending'), 'failed reply still promises automatic sending');
    prefs.saveAutoSend(false);
    send().click(); await until(() => stats.asks.length === 3, 'interruption sent');
    require(stats.asks[2].said === 'Wait, check the caller first.', 'interruption duplicated or lost');
    accept(2); play(2); await until(() => stats.plays === 2, 'next reply plays');
    mic().click(); await until(() => stats.stops === 1, 'explicit mute closes capture');
    play(2); stats.asks[2].finish(); await sleep(100);
    require(stats.captures === 1 && stats.stops === 1, 'reply unmuted an explicitly muted microphone');
    return { captures: stats.captures, stops: stats.stops, turns: stats.asks.length, interruptMs: Math.round(interruptMs) };
  } finally {
    stats.level = 0;
    for (const ask of stats.asks) if (!ask.closed) ask.finish();
    typed()?.click();
    await sleep(150);
    window.fetch = original.fetch; navigator.mediaDevices.getUserMedia = original.media;
    window.MediaRecorder = original.recorder; window.AudioContext = original.context;
    speechSynthesis.speak = original.speak; speechSynthesis.cancel = original.cancel;
    prefs.saveAutoSend(oldAuto); prefs.saveVoicePreferences(oldVoice);
  }
}
