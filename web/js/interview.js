// Coding interviews own their identity and drafts, not a particular mounted panel.
// Navigation closes the microphone; only an explicit Pause stops the wall clock.
import { el, replace } from './dom.js';
import { readDraft, saveDraft, clearDraft, appendDraft, watchDraft } from './drafts.js';
import { createVoiceControl } from './voice.js';
import { createSpeaker, splitForSpeech, turnDecision } from './speech.js';
import { submissionEditor } from './editor.js';
import { formatClock, beginInterviewArchive, endInterviewArchive, pauseInterviewArchive } from './recorder.js';
import { renderMarkdown } from './markdown.js';

const ACTIVE_KEY = 'studio.interview.active.v1';
const phases = [['clarify', 'Clarify'], ['approach', 'Approach'], ['code', 'Code'], ['test', 'Test'], ['followup', 'Follow-up']];
let current = null;
try { current = JSON.parse(localStorage.getItem(ACTIVE_KEY)); } catch { /* first visit */ }
let mounted = null;
const announce = () => window.dispatchEvent(new CustomEvent('studio-interview-change'));
function remember(value) {
  current = value;
  try {
    if (value) localStorage.setItem(ACTIVE_KEY, JSON.stringify(value));
    else localStorage.removeItem(ACTIVE_KEY);
  } catch { /* the running panel still owns its identity */ }
}
export function activeInterview(slug = null) {
  return current && (!slug || current.slug === slug) ? current : null;
}
export function interviewAction() {
  if (!current) return;
  if (mounted?.slug === current.slug) mounted.end();
  else location.hash = '#/p/' + encodeURIComponent(current.slug);
}
const detailUrl = (slug, id) => `/api/interview/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`;
export async function interviewJson(url, body = null) {
  const response = await fetch(url, body === null ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result?.error?.message || `Interview request failed (${response.status}).`);
  return result;
}

// Events may be cheap JSON acknowledgements or an interviewer SSE reply. Reading both
// here means a suppressed idle tick never flashes an empty transcript bubble.
async function streamRequest(url, body, onEvent) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const error = Error(result?.error?.message || `Interview request failed (${response.status}).`); error.status = response.status; throw error;
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.json();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', completed = false;
  for (;;) {
    const { value, done } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, split); buffer = buffer.slice(split + 2);
      const name = block.match(/^event: ?(.+)$/m)?.[1] || 'message';
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      if (!data) continue;
      const payload = JSON.parse(data);
      if (name === 'error') throw Error(payload.message || 'The interviewer could not finish this turn.');
      if (name === 'done') completed = true;
      onEvent(name, payload);
    }
    if (done) break;
  }
  if (!completed) throw Error('The connection ended. Your saved interview is still open.');
  return { interjected: true };
}

/** Start stays in the familiar toolbar; the choice is made before any microphone opens. */
export function showInterviewSetup({ slug, title, silent }) {
  if (current) { interviewAction(); return; }
  if (document.querySelector('.ci-setup')) return;
  const minutes = el('select', { 'aria-label': 'Interview duration' }, [30, 45, 60].map(n =>
    el('option', { value: String(n), selected: n === 45, text: `${n} minutes` })));
  let mode = 'typed', enabled = true;
  function segmented(label, choices, initial, change) {
    const group = el('div', { class: 'seg ci-segment', role: 'group', 'aria-label': label });
    for (const [value, text] of choices) group.append(el('button', {
      type: 'button', text, 'aria-pressed': String(value === initial), onclick: event => {
        for (const button of group.children) button.setAttribute('aria-pressed', String(button === event.currentTarget));
        change(value);
      },
    }));
    return group;
  }
  const modes = segmented('Answer mode', [['typed', 'Typed'], ['voice', 'Voice']], mode, value => { mode = value; });
  const interviewer = segmented('Interviewer', [['on', 'On'], ['off', 'Off']], 'on', value => {
    enabled = value === 'on'; modes.hidden = !enabled;
  });
  const begin = el('button', { class: 'ws-run', type: 'submit', text: 'Begin interview' });
  const dialog = el('dialog', { class: 'ci-setup', 'aria-labelledby': 'ci-setup-title' },
    el('form', { onsubmit: event => {
      event.preventDefault();
      dialog.close(); dialog.remove();
      if (!enabled) { silent({ minutes: Number(minutes.value) }); return; }
      remember({ slug, title, minutes: Number(minutes.value), mode, pending: true });
      announce();
    } }, [
      el('h2', { id: 'ci-setup-title', text: 'Start interview' }),
      el('label', { class: 'ci-field' }, ['Duration', minutes]),
      el('div', { class: 'ci-field' }, [el('span', { text: 'Interviewer' }), interviewer]),
      modes,
      el('div', { class: 'ci-actions' }, [el('button', { class: 'ws-mini', type: 'button', text: 'Cancel', onclick: () => { dialog.close(); dialog.remove(); } }), begin]),
    ]));
  dialog.addEventListener('cancel', () => dialog.remove());
  document.body.append(dialog); dialog.showModal();
}

export function openInterviewRecord(slug, id) {
  window.dispatchEvent(new CustomEvent('studio-interview-open', { detail: { slug, id } }));
}

/** A live panel or a saved transcript. It deliberately implements the coach mount API. */
export function createInterviewPanel(entry, { id = null, onBack = () => {} } = {}) {
  const slug = entry.slug;
  let state = { ...(activeInterview(slug) || {}), ...(id ? { id } : {}) };
  let gone = false, busy = false, ending = false, micEnabled = false, interrupted = false;
  let lastSpeech = Date.now(), lastTyping = Date.now(), lastTick = 0, loud = false, pending = 0;
  let voice = null, speaker = null, voiceState = 'idle', speechTail = '', sendingDraft = false;
  let recovered = false, requestId = null, firstCode = null, phaseHintSent = false;
  let eventQueue = [];
  let lastOperation = null;
  const draftKey = () => 'interview:' + (state.id || slug);
  const queueKey = () => 'studio.interview.events:' + (state.id || slug);
  function saveEvents() { try { localStorage.setItem(queueKey(), JSON.stringify(eventQueue)); } catch { /* retain in memory */ } }
  function restoreEvents() { try { eventQueue = JSON.parse(localStorage.getItem(queueKey()) || '[]'); } catch { eventQueue = []; } }
  const requestKey = () => 'studio.interview.request:' + (state.id || slug);
  function rememberRequest(value) { try { if (value) localStorage.setItem(requestKey(), JSON.stringify(value)); else localStorage.removeItem(requestKey()); } catch { /* input remains a draft */ } }
  const code = () => submissionEditor(slug)?.getCode() ?? undefined;
  const clock = el('span', { class: 'ci-clock mono tnum', text: '45:00' });
  const model = el('span', { class: 'ci-model mono dim' });
  const micLabel = el('span', { text: 'Your turn' });
  const meter = el('span', { class: 'ci-meter', 'aria-hidden': 'true' }, el('i'));
  const pill = el('span', { class: 'ci-state mono' }, [meter, micLabel]);
  const phasebar = el('ol', { class: 'ci-phases', 'aria-label': 'Interview phase' }, phases.map(([key, label]) =>
    el('li', { text: label, dataset: { phase: key } })));
  const log = el('div', { class: 'ci-log', role: 'log', 'aria-label': 'Interview transcript', tabindex: '0' });
  const notice = el('div', { class: 'ci-notice', role: 'status', hidden: true });
  const input = el('textarea', { class: 'coach-input ci-input', rows: '2', 'aria-label': 'Your interview answer', placeholder: 'Talk through your approach…' });
  const liveWords = el('div', { class: 'ci-live-words', 'aria-live': 'polite' });
  const send = el('button', { class: 'ws-run', text: 'Send', type: 'button', onclick: () => answer() });
  const recovery = el('button', { class: 'ws-mini', type: 'button', text: 'Send saved answer', hidden: true, onclick: () => { recovered = false; answer(); } });
  const micButton = el('button', { class: 'ws-mini', type: 'button', text: 'Enable microphone', onclick: () => { micEnabled = true; openMic(); } });
  const interruptButton = el('button', { class: 'ws-mini', type: 'button', text: 'Interrupt · Esc', hidden: true, onclick: interrupt });
  const pauseButton = el('button', { class: 'ws-mini', type: 'button', text: 'Pause', onclick: togglePause });
  const endButton = el('button', { class: 'ws-mini', type: 'button', text: 'End', onclick: finish });
  const back = el('button', { class: 'ws-mini', type: 'button', text: 'Back to coach', hidden: true, onclick: () => { if (!state.id) remember(null); onBack(); } });
  let spokenReplies = state.mode === 'voice';
  const speechButton = el('button', { class: 'ws-mini', type: 'button', text: 'Speak replies', 'aria-pressed': 'false', onclick: () => {
    spokenReplies = !spokenReplies; speechButton.setAttribute('aria-pressed', String(spokenReplies));
    if (!spokenReplies) speaker.cancel();
  } });
  const typed = el('div', { class: 'ci-typed' }, [input, el('div', { class: 'ci-actions' }, send)]);
  const hint = el('p', { class: 'ci-interrupt-hint dim', text: 'Hold Esc to interrupt' });
  try { hint.hidden = localStorage.getItem('studio.interview.interrupt-seen') === '1'; } catch { /* show once */ }
  const voicePanel = el('div', { class: 'ci-voice', hidden: true }, [liveWords, recovery, hint, el('div', { class: 'ci-actions' }, [micButton, interruptButton])]);
  const composer = el('div', { class: 'ci-composer' }, [typed, voicePanel]);
  const root = el('aside', { class: 'card coach ci-panel', 'aria-label': 'Coding interviewer' }, [
    el('div', { class: 'ci-header' }, [el('div', { class: 'ci-identity' }, [el('strong', { text: 'Interviewer' }), model]), clock]),
    phasebar,
    el('div', { class: 'ci-toolbar' }, [pill, el('span', { class: 'spacer' }), speechButton, pauseButton, endButton, back]),
    log, notice, composer,
  ]);
  const retry = el('button', { class: 'ws-mini', type: 'button', text: 'Retry reply', hidden: true, onclick: async () => {
    if (!lastOperation || busy) return;
    const { action, extra } = lastOperation;
    const ok = await request(action === 'start' && state.id ? 'turn' : action, extra);
    if (ok && state.debriefed && activeInterview(slug)?.id === state.id) { remember(null); window.dispatchEvent(new CustomEvent('studio-interview-finished')); }
  } });
  notice.after(retry);
  const error = message => { notice.textContent = message || ''; notice.hidden = !message; retry.hidden = !message || !lastOperation; };
  const elapsed = () => Math.max(0, Math.min(state.endedAt || Date.now(), state.pausedAt || Infinity) - Number(state.startedAt || Date.now()) - (state.pausedMs || 0));
  function persist() {
    if (state.id && !state.debriefed && activeInterview(slug)) remember({ ...state, turns: undefined, busy: undefined });
  }
  function setDraft(text) {
    input.value = text; liveWords.textContent = text;
    sendingDraft = true;
    try { saveDraft(draftKey(), text); } finally { sendingDraft = false; }
  }
  let unwatch = () => {};
  function restoreDraft() {
    unwatch();
    input.value = readDraft(draftKey())?.text || ''; liveWords.textContent = input.value;
    recovered = Boolean(input.value);
    try { const saved = JSON.parse(localStorage.getItem(requestKey())); if (saved?.said === input.value.trim()) requestId = saved.requestId; } catch { /* no pending request */ }
    unwatch = watchDraft(draftKey(), text => {
      if (sendingDraft || gone) return;
      input.value = text; liveWords.textContent = text; recovered = Boolean(text); paint();
    });
  }
  input.addEventListener('input', () => { lastTyping = Date.now(); requestId = null; setDraft(input.value); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); answer(); }
  });
  function paint() {
    const isVoice = state.mode === 'voice';
    root.dataset.mode = state.mode || 'typed';
    root.dataset.interviewId = state.id || '';
    root.dataset.debriefed = String(Boolean(state.debriefed));
    typed.hidden = isVoice; voicePanel.hidden = !isVoice; speechButton.hidden = isVoice || state.debriefed;
    composer.hidden = Boolean(state.debriefed);
    pauseButton.hidden = endButton.hidden = Boolean(state.debriefed);
    back.hidden = !state.debriefed && (Boolean(state.id) || busy);
    back.textContent = state.id ? 'Back to coach' : 'Cancel';
    pauseButton.textContent = state.pausedAt ? 'Resume' : 'Pause';
    pauseButton.disabled = busy || ending || !state.id;
    endButton.disabled = ending || !state.id;
    send.disabled = busy || ending || Boolean(state.pausedAt) || !state.id;
    input.disabled = Boolean(state.pausedAt) || ending;
    recovery.hidden = !recovered || !input.value;
    recovery.disabled = busy || ending || Boolean(state.pausedAt);
    micButton.hidden = voiceState === 'recording' || voiceState === 'working';
    micButton.disabled = busy || ending || Boolean(state.pausedAt);
    interruptButton.hidden = !speaker?.speaking;
    micLabel.textContent = state.debriefed ? 'Debrief' : state.pausedAt ? 'Paused' : speaker?.speaking ? 'Speaking' : busy ? 'Thinking' : voiceState === 'recording' ? 'Listening' : 'Your turn';
    model.textContent = [state.coachProvider, state.coachModel].filter(Boolean).join(' · ');
    for (const item of phasebar.children) {
      if (item.dataset.phase === (state.phase || 'clarify')) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    }
    const remaining = Math.max(0, (state.minutes || 45) * 60000 - elapsed());
    clock.textContent = formatClock(remaining);
    clock.dataset.urgency = remaining <= 120000 ? 'hard' : remaining <= 300000 ? 'med' : '';
    liveWords.textContent = input.value;
  }
  function bubble(who, text = '', atMs = elapsed(), debrief = false) {
    const content = el('div', { class: 'ci-text', text });
    const node = el('article', { class: `ci-entry${who === 'You' ? ' ci-candidate' : ''}${debrief ? ' ci-debrief' : ''}` }, [
      el('div', { class: 'ci-who mono' }, [el('span', { text: who }), el('span', { class: 'dim', text: formatClock(atMs) })]), content,
    ]);
    log.append(node); log.scrollTop = log.scrollHeight;
    return content;
  }
  function replay(turns = []) {
    replace(log, []);
    for (const turn of turns) {
      const at = turn.elapsedMs ?? Math.max(0, Date.parse(turn.at) - Number(state.startedAt));
      if (turn.said) bubble('You', turn.said, at);
      const asked = turn.asked ?? turn.reply;
      if (asked) {
        const target = bubble(turn.kind === 'debrief' ? 'Debrief' : 'Interviewer', asked, at, turn.kind === 'debrief');
        if (turn.kind === 'debrief') replace(target, renderMarkdown(asked));
      }
    }
  }
  function openMic() {
    if (!micEnabled || gone || busy || ending || state.pausedAt || state.debriefed || state.mode !== 'voice' || speaker?.speaking || recovered || document.hidden) return;
    voice?.start();
  }
  async function drainMic() {
    voice?.stop();
    // A final phrase is still being transcribed after tracks close. Its words must
    // join this answer (or the debrief), never spill silently into a later turn.
    const until = Date.now() + 65000;
    while (voice?.isBusy() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    if (voice?.isBusy()) throw Error('Still transcribing your last words. Try again when they appear.');
  }
  speaker = createSpeaker({ onStateChange: speaking => {
    if (speaking) voice?.stop();
    else openMic();
    paint();
  } });
  voice = createVoiceControl({
    getSlug: () => slug, logTakes: false, recordingMode: 'think_aloud', getAttemptId: () => state.id, maxTakeMs: 60 * 60000,
    // One microphone pipeline in Voice mode. Each live phrase is archived by ASR,
    // and its text becomes a durable interview draft before it can be submitted.
    onState: next => { voiceState = next; if (next === 'idle') { loud = false; pending = 0; } if (!gone) paint(); },
    onTranscript: text => {
      lastSpeech = Date.now(); requestId = null;
      if (gone) { appendDraft(draftKey(), text); return; }
      setDraft(input.value + (input.value && !/\s$/.test(input.value) ? ' ' : '') + text);
      paint();
    },
    onLevel: value => {
      loud = value.loud; pending = value.pending;
      if (loud) lastSpeech = Date.now();
      meter.classList.toggle('is-loud', loud);
      if (state.mode !== 'voice' || gone || recovered || ending || state.pausedAt) return;
      if (turnDecision({ sinceLoud: value.sinceLoud, chars: input.value.trim().length, speaking: speaker.speaking, busy, pending }) === 'send') answer();
    },
  });
  // Keep microphone errors visible without showing dictation's second mode button.
  voicePanel.append(voice.status);
  function interrupt() {
    interrupted = true; speechTail = ''; speaker.cancel();
    try { localStorage.setItem('studio.interview.interrupt-seen', '1'); } catch { /* optional hint */ }
    hint.hidden = true;
    openMic();
  }
  const keydown = event => {
    if (event.key === 'Escape' && speaker.speaking) { event.preventDefault(); event.stopPropagation(); interrupt(); }
  };
  window.addEventListener('keydown', keydown, true);

  async function request(action, extra = {}) {
    if (busy || gone) return false;
    busy = true; interrupted = false; speechTail = '';
    if (action !== 'event') lastOperation = { action, extra };
    if (action !== 'event') { error(''); paint(); }
    let target = null, accepted = false;
    try {
      const result = await streamRequest(`/api/interview/${action}`, {
        slug, interviewId: state.id, code: code(), ...extra,
      }, (name, payload) => {
        if (name === 'interview') {
          const oldDraft = input.value;
          state = { ...state, ...payload, pending: false };
          if (oldDraft) saveDraft(draftKey(), oldDraft);
          restoreDraft(); persist(); announce();
        } else if (name === 'accepted') {
          accepted = true;
          const delivered = new Set((extra.events || []).map(event => event.requestId));
          eventQueue = eventQueue.filter(event => !delivered.has(event.requestId)); saveEvents();
          if (extra.said && input.value === extra.said) { setDraft(''); clearDraft(draftKey()); requestId = null; rememberRequest(null); }
        } else if (name === 'token') {
          if (gone) return;
          target ??= bubble(action === 'done' ? 'Debrief' : 'Interviewer', '', elapsed(), action === 'done');
          const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
          target.textContent += payload.text || '';
          if (follow) log.scrollTop = log.scrollHeight;
          if (spokenReplies && !interrupted && action !== 'done') {
            speechTail += payload.text || '';
            const split = splitForSpeech(speechTail); speechTail = split.rest;
            for (const sentence of split.ready) speaker.say(sentence);
          }
        } else if (name === 'phase') state.phase = payload.phase;
        else if (name === 'broke-character') error('The interviewer’s reply was cut short because it began answering for you.');
        else if (name === 'done') {
          accepted = true;
          state = { ...state, ...(payload.state || {}), ...(payload.phase ? { phase: payload.phase } : {}) };
          if (extra.said && input.value === extra.said) { setDraft(''); clearDraft(draftKey()); requestId = null; rememberRequest(null); }
          if (action === 'done') {
            state.debriefed = true;
            state.endedAt ||= Date.now();
            if (target) replace(target, renderMarkdown(target.textContent));
          }
          persist();
        }
        if (!gone) paint();
      });
      if (speechTail.trim() && spokenReplies && !interrupted && !gone) speaker.say(speechTail);
      if (result.state) { state = { ...state, ...result.state }; persist(); }
      if (result.existing) {
        state.id = result.id; state.pending = false; persist();
        const saved = await interviewJson(detailUrl(slug, state.id));
        state = { ...state, ...saved }; replay(saved.turns); restoreDraft();
      }
      if (result.duplicate) {
        const saved = await interviewJson(detailUrl(slug, state.id)); replay(saved.turns);
        if (extra.said && input.value === extra.said) { setDraft(''); clearDraft(draftKey()); }
      }
      return result.interjected === false ? 'suppressed' : accepted || result.existing || result.duplicate;
    } catch (failure) {
      if (!gone && !(action === 'event' && failure.status === 409)) error(failure.message);
      return false;
    } finally {
      busy = false;
      if (!gone) { paint(); openMic(); }
    }
  }
  async function answer() {
    if (busy || ending || state.pausedAt || state.debriefed || !state.id || gone) return;
    // Lock while draining as onLevel can otherwise submit the same phrase twice.
    busy = true; paint();
    try { await drainMic(); } catch (failure) { error(failure.message); busy = false; paint(); return; }
    busy = false;
    const said = input.value.trim();
    if (!said) { openMic(); return; }
    requestId ||= crypto.randomUUID();
    setDraft(said); rememberRequest({ said, requestId });
    lastSpeech = Date.now(); recovered = false;
    bubble('You', said);
    await request('turn', { said, requestId, events: [...eventQueue] });
  }
  async function finish() {
    if (ending || state.debriefed || !state.id || gone) return;
    ending = true; speaker.cancel(); paint();
    try {
      await drainMic();
      if (state.mode === 'typed') await endInterviewArchive();
      // An in-flight response owns its stream. Wait for it before requesting a debrief.
      while (busy && !gone) await new Promise(resolve => setTimeout(resolve, 50));
      if (gone) return;
      const said = input.value.trim();
      if (said) bubble('You', said);
      const completed = await request('done', { said, requestId: requestId || crypto.randomUUID(), events: [...eventQueue] });
      if (completed) {
        voice.stop(); speaker.cancel();
        if (activeInterview(slug)?.id === state.id) remember(null);
        // Keep the debrief visible until Back to coach; the toolbar can start again.
        window.dispatchEvent(new CustomEvent('studio-interview-finished'));
      }
    } catch (failure) { error(failure.message); }
    finally { ending = false; paint(); }
  }
  async function togglePause() {
    if (busy || ending || !state.id) return;
    busy = true; speaker.cancel(); paint();
    try {
      await drainMic();
      const result = await interviewJson(`/api/interview/${state.pausedAt ? 'resume' : 'pause'}`, { slug, interviewId: state.id });
      state = { ...state, ...(result.state || result) }; persist();
      if (state.mode === 'typed') await pauseInterviewArchive(Boolean(state.pausedAt));
    } catch (failure) { error(failure.message); }
    finally { busy = false; paint(); openMic(); }
  }
  const metrics = () => ({ speaking: loud || pending > 0 || Boolean(speaker?.speaking) || Boolean(input.value.trim()), secondsSinceSpeech: (Date.now() - lastSpeech) / 1000, secondsSinceTyping: (Date.now() - lastTyping) / 1000 });
  const work = event => {
    if (event.detail?.slug !== slug || state.debriefed) return;
    const data = event.detail;
    if (data.type === 'typing') { lastTyping = Date.now(); return; }
    eventQueue.push({ ...data, ...metrics(), elapsedMs: elapsed(), requestId: crypto.randomUUID() }); saveEvents();
  };
  window.addEventListener('studio-interview-work', work);
  const tick = async () => {
    if (gone || !state.id || state.debriefed) return;
    paint();
    if (state.pausedAt || busy || ending) return;
    if (elapsed() >= (state.minutes || 45) * 60000) { finish(); return; }
    if (Date.now() - lastTick < 5000) return;
    lastTick = Date.now();
    const buffer = code();
    firstCode ??= buffer;
    if (!phaseHintSent && typeof buffer === 'string' && buffer.length > (firstCode?.length || 0) + 80) {
      phaseHintSent = true; eventQueue.push({ type: 'phase_hint', phase: 'code' });
    }
    const event = eventQueue[0] || { type: 'idle' };
    const result = await request('event', { event: { ...event, ...metrics() } });
    // Suppressed events are recorded/queued by the server, so do not resend verdicts.
    if (result !== false && eventQueue[0] === event) { eventQueue.shift(); saveEvents(); }
    return result;
  };
  const timer = setInterval(tick, 1000);
  const visibility = () => { if (document.hidden) voice.stop(); };
  document.addEventListener('visibilitychange', visibility);
  async function boot() {
    try {
      if (state.id) {
        const result = await interviewJson(detailUrl(slug, state.id));
        state = { ...state, ...(result.state || result), id: state.id };
        lastSpeech = state.lastSpeechAt || Date.now(); lastTyping = state.lastTypingAt || Date.now();
        spokenReplies = state.mode === 'voice';
        replay(result.turns); restoreDraft(); restoreEvents();
        const failed = result.turns?.at(-1);
        if (failed?.kind === 'error') {
          const candidate = result.turns.find(turn => turn.kind === 'candidate' && turn.requestId === failed.requestId);
          lastOperation = { action: state.endedAt ? 'done' : 'turn', extra: { said: candidate?.said || '', requestId: failed.requestId || crypto.randomUUID() } };
          error('The last reply did not finish. Your answer is saved.');
        }
        if (!state.debriefed && !activeInterview()) remember({ ...state, turns: undefined });
        persist(); paint();
        // GET waits for an existing turn before replaying it; restoring never asks the
        // model the same question again or resets the interview's start time.
      } else {
        restoreDraft();
        micEnabled = state.mode === 'voice'; spokenReplies = state.mode === 'voice';
        const started = await request('start', { minutes: state.minutes || 45, mode: state.mode || 'typed', requestId: crypto.randomUUID() });
        if (started && state.id && state.mode === 'typed' && !gone) await beginInterviewArchive(state.id);
      }
      if (!gone) { paint(); openMic(); }
    } catch (failure) { if (!gone) error(failure.message); }
  }
  const api = { root, slug, focus: () => { if (state.mode !== 'voice') input.focus(); }, attach() {}, end: finish,
    beginAttempt() {}, endAttempt() {}, reviewAttempt() {},
    dispose() {
      if (gone) return;
      gone = true; unwatch(); clearInterval(timer);
      saveDraft(draftKey(), input.value);
      speaker.dispose(); voice.dispose({ finish: true });
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('studio-interview-work', work);
      document.removeEventListener('visibilitychange', visibility);
      if (mounted === api) mounted = null;
    },
  };
  mounted = api; paint(); boot();
  return api;
}
