import { openLearningNotes } from './learning.js';
import { createMockTimeControls, mockTimeReading } from './ui/mock-time.js';
import { createComposer, composerSend, bindComposerInput } from './ui/composer.js';
import { claimActionKey, hasOpenOverlay } from './keyboard.js';
import { showWorkspaceAction } from './workspace-tools.js';
import { registerActionAlias } from './coach-actions.js';
// Coding interviews own their identity and drafts, not a particular mounted panel.
// Navigation closes the microphone; only an explicit Pause stops the wall clock.
import { el, replace } from './dom.js';
import { readDraft, saveDraft, clearDraft, appendDraft, watchDraft, remainingDraft } from './drafts.js';
import { createVoicePanel, answerModeSwitch, micToggle, paintMicToggle, replayButton, interviewerSilentNote } from './ui/voice-panel.js';
import { createVoiceControl } from './voice.js';
import { createSpeaker, turnDecision } from './speech.js';
import { createSpeechStream } from './speech-stream.js';
import { submissionEditor } from './editor.js';
import { streamInterviewRequest } from './interview-transport.js';
import { formatClock, endInterviewArchive, pauseInterviewArchive } from './recorder.js';
import { conversationMessage, bindConversation, conversationSeparator, messageAction, thinkingRow, conversationText, appendConversationText } from './ui/conversation.js';
import { createCoachModelPicker } from './coach-model.js';
import { createSelect } from './ui/select.js';
import { icon } from './ui/icon.js';
import { createInterviewMode } from './interview-mode.js';
import { openReport } from './interview-report.js';
import { readSidebar, saveSidebar } from './sidebar-state.js';
import { debriefSections, ratingTone, interviewDuration, relativeInterviewDate, recordedPhaseTimes, modelLabel, signalLabel } from './interview-format.js';

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
  if (mounted?.slug === current.slug && mounted.interviewId === current.id) mounted.end();
  else {
    const destination = current.discipline === 'lld' ? `#/lld/${encodeURIComponent(current.slug)}/${current.id || ''}` : '#/p/' + encodeURIComponent(current.slug);
    if (location.hash === destination) announce();
    else location.hash = destination;
  }
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
const streamRequest = streamInterviewRequest;

/** Setup is a persistent inline card; starting is the only mutation. */
export function createInterviewSetup({ slug, title, discipline = 'coding', onStart = null, onCancel = null, targetLevel = 'L4', label = 'Mock interview', startLabel = 'Start', description = null }) {
  const saved = readSidebar(slug).setup || {};
  let minutes = saved.minutes || 45, mode = saved.mode || 'voice', modelPending = false, starting = false, disposed = false, levelTouched = false;
  let startRequestId = crypto.randomUUID();
  const rememberChoices = () => {
    saveSidebar(slug, { setup: { minutes, mode, targetLevel: level.value } });
    startRequestId = crypto.randomUUID();
  };
  const length = createSelect({ label: 'Interview length', compact: true, value: minutes,
    options: [30, 45, 60].map(n => [n, `${n} min`]), onChange: () => { minutes = Number(length.value); rememberChoices(); } });
  const answer = createSelect({ label: 'Answer mode', compact: true, value: mode,
    options: [['voice', 'Voice'], ['typed', 'Typed']], onChange: () => { mode = answer.value; rememberChoices(); } });
  const level = createSelect({ label: 'Target level', compact: true, value: saved.targetLevel || targetLevel,
    options: ['L3', 'L4', 'L5', 'L6'].map(x => [x, x]), onChange: () => { levelTouched = true; rememberChoices(); } });
  const begin = el('button', { class: 'btn btn--primary btn--lg ci-start', type: 'submit', text: startLabel });
  const setupActions = el('div', { class: 'ci-setup-actions' }, [
    onCancel ? el('button', { class: 'btn btn--quiet', type: 'button', text: 'Cancel', onclick: onCancel }) : null, begin,
  ]);
  const status = el('p', { class: 'dim', role: 'status', hidden: true });
  function paintPending() {
    begin.disabled = modelPending || starting; length.disabled = answer.disabled = level.disabled = starting;
    begin.textContent = starting ? 'Preparing…' : startLabel;
  }
  const picker = createCoachModelPicker({ compact: true, onPending: value => { modelPending = value; paintPending(); } });
  const dot = () => el('span', { class: 'ci-setup-dot', 'aria-hidden': 'true', text: '·' });
  const root = el('section', { class: 'ci-setup ui-inset' + (description ? ' ci-setup--featured ui-inset--roomy' : ''), 'aria-label': 'Start a mock interview' },
    el('form', { onsubmit: async event => {
      event.preventDefault();
      if (modelPending || starting || disposed) return;
      starting = true; paintPending(); status.hidden = true;
      const setup = { slug, title: title || label, discipline, targetLevel: level.value, minutes, mode, pending: true, fresh: true, startRequestId };
      try {
        await interviewJson('/api/learner/preferences', { targetLevel: { [discipline]: level.value } });
        if (disposed) return;
        if (onStart) await onStart(setup);
        else { remember(setup); announce(); }
        // A later explicit Start is a new interview; retries of this panel retain
        // the request ID already captured in setup.
        startRequestId = crypto.randomUUID();
      } catch (error) {
        if (!disposed) { status.textContent = error.message || 'Could not start this mock. Try again.'; status.hidden = false; }
      } finally { starting = false; if (!disposed) paintPending(); }
    } }, [
      el('div', { class: 'ci-setup-head' }, [el(description ? 'h2' : 'span', { class: 'ci-setup-title', text: label }), description ? null : setupActions]),
      description ? el('p', { class: 'dim ci-setup-description', text: description }) : null,
      el('div', { class: 'ci-setup-options' }, [length, dot(), answer, dot(), level, dot(), picker.root]), description ? setupActions : null, status,
    ]));
  interviewJson('/api/learner/preferences').then(({ preferences }) => {
    if (!disposed && !starting && !levelTouched && !saved.targetLevel) level.value = preferences?.targetLevel?.[discipline] || preferences?.targetLevel?.default || targetLevel;
  }).catch(() => {}); // Starting reports an unavailable preferences store; defaults remain usable.
  return { root, dispose: () => { disposed = true; picker.dispose(); length.dispose(); answer.dispose(); level.dispose(); } };
}
export function showInterviewSetup(entry) {
  if (current && !entry.fresh) { interviewAction(); return; }
  window.dispatchEvent(new CustomEvent('studio-interview-setup', { detail: entry }));
}

export function openInterviewRecord(slug, id) {
  window.dispatchEvent(new CustomEvent('studio-interview-open', { detail: { slug, id } }));
}

/** A live panel or a saved transcript. It deliberately implements the coach mount API. */
export function createInterviewPanel(entry, { id = null, embedded = false, contained = !embedded, onState = () => {}, onBack = () => {}, getCode = null, initialState = null } = {}) {
  const slug = entry.slug;
  const phases = entry.discipline === 'lld' ? [['clarify', 'Requirements'], ['approach', 'Design'], ['code', 'Implement'], ['test', 'Verify'], ['followup', 'Extend']] : [['clarify', 'Clarify'], ['approach', 'Approach'], ['code', 'Code'], ['test', 'Test'], ['followup', 'Follow-up']];
  if (initialState) remember(initialState);
  let state = id ? { slug, id } : { ...(activeInterview(slug) || {}) };
  let loading = true, loadFailed = false, draftReady = false;
  let visible = !embedded;
  let participating = !id || activeInterview(slug)?.id === id;
  let gone = false, busy = false, ending = false, micEnabled = false, interrupted = false;
  let lastSpeech = Date.now(), lastTyping = Date.now(), lastTick = 0, loud = false, pending = 0;
  let voice = null, speaker = null, voiceState = 'idle', replySpeech = null, sendingDraft = false;
  let resumeMicAfterDrain = false, modeDrain = false;
  let micOpening = false;
  let recovered = false, requestId = null, firstCode = null, phaseHintSent = false;
  let eventQueue = [];
  let lastOperation = null;
  const draftKey = () => 'interview:' + (state.id || slug);
  const queueKey = () => 'studio.interview.events:' + (state.id || slug);
  function saveEvents() { try { localStorage.setItem(queueKey(), JSON.stringify(eventQueue)); } catch { /* retain in memory */ } }
  function restoreEvents() { try { eventQueue = JSON.parse(localStorage.getItem(queueKey()) || '[]'); } catch { eventQueue = []; } }
  const requestKey = () => 'studio.interview.request:' + (state.id || slug);
  function rememberRequest(value) { try { if (value) localStorage.setItem(requestKey(), JSON.stringify(value)); else localStorage.removeItem(requestKey()); } catch { /* input remains a draft */ } }
  const code = () => getCode ? getCode() : submissionEditor(slug)?.getCode() ?? undefined;
  const clock = el('span', { class: 'ci-clock mono tnum', text: '45:00' });
  const timeControls = createMockTimeControls({ clock, extend: async change => {
    const result = await interviewJson('/api/interview/extend', { slug, interviewId: state.id, ...change });
    if (!gone) { mergeState(result.state); persist(); }
  }, onChange: () => { if (!gone) { paint(); if (!timeControls.saving) void modeControl.flush(); } } });
  const micLabel = el('span', { text: 'Your turn' });
  const pill = el('span', { class: 'ci-state' }, [micLabel]);
  const phasebar = el('ol', { class: 'ci-phases', 'aria-label': 'Interview phase' }, phases.map(([key, label]) =>
    el('li', { text: label, dataset: { phase: key } })));
  let unbindTools = () => {}, toolTarget = null;
  const log = el('div', { class: 'ci-log' + (contained ? ' ui-pane-scroll ui-inset' : ''), role: 'log', 'aria-label': 'Interview transcript', tabindex: '0' });
  const notice = el('div', { class: 'ci-notice ui-inset', role: 'status', hidden: true });
  const input = el('textarea', { class: 'coach-input ci-input', rows: '2', 'aria-label': 'Your interview answer', placeholder: 'Talk through your approach' });
  let partialWords = '';
  const voiceView = createVoicePanel({ transcriptClass: 'ci-live-words', onEdit: () => modeControl.select('typed') });
  const replayReply = text => {
    if (busy || speaker?.speaking) return;
    speaker?.say(text);
  };
  const inputSize = bindComposerInput(input);
  const send = composerSend(el('button', { class: 'btn btn--quiet ci-send', type: 'button', onclick: () => answer() }));
  const micButton = micToggle(() => {
    if (micEnabled && voice?.isBusy()) { micEnabled = false; resumeMicAfterDrain = false; voice.stop(); paint(); }
    else { micEnabled = true; openMic(); }
  });
  const interruptButton = el('button', { class: 'btn btn--secondary', type: 'button', text: 'Interrupt · Esc', hidden: true, onclick: interrupt });
  // Going quiet sends on its own; this sends now, finishing the last phrase's words first.
  const sendNow = composerSend(el('button', { class: 'btn btn--quiet ci-send-now', type: 'button', hidden: true, onclick: () => { recovered = false; answer(); } }));
  const pauseButton = el('button', { class: 'btn btn--icon icon-btn ci-pause', type: 'button', 'aria-label': 'Pause interview', onclick: togglePause }, icon('pause'));
  const endButton = el('button', { class: 'btn btn--quiet ci-finish', 'data-danger': 'true', type: 'button', text: 'Finish', onclick: finish });
  const back = el('button', { class: 'btn btn--quiet ws-mini', type: 'button', text: entry.discipline === 'lld' ? 'Back to interviews' : 'Back to coach', hidden: true, onclick: () => {
    if (!state.id || (state.debriefed && activeInterview(slug)?.id === state.id)) remember(null);
    onBack();
  } });
  let spokenReplies = state.mode === 'voice';
  const speechButton = el('button', { class: 'btn btn--icon icon-btn ci-speech', type: 'button', 'aria-label': 'Speak replies', 'aria-pressed': 'false', onclick: () => {
    spokenReplies = !spokenReplies; speechButton.setAttribute('aria-pressed', String(spokenReplies));
    if (!spokenReplies) speaker.cancel();
  } }, icon('speaker'));
  const modeStatus = el('span', { class: 'dim ci-mode-status', role: 'status', hidden: true });
  const modeRetry = el('button', { class: 'btn btn--quiet', type: 'button', text: 'Retry saving mode', hidden: true, onclick: () => modeControl.retry() });
  const typeLink = answerModeSwitch('typed', mode => modeControl.select(mode));
  const voiceLink = answerModeSwitch('voice', mode => modeControl.select(mode));
  const modeControl = createInterviewMode({ initial: state.mode,
    ready: () => !gone && !loading && !busy && !timeControls.saving && Boolean(state.id) && !state.endedAt && !state.debriefed,
    save: mode => interviewJson('/api/interview/mode', { slug, interviewId: state.id, mode }),
    onSelect: mode => {
      state.mode = mode; micEnabled = mode === 'voice'; resumeMicAfterDrain = false;
      modeDrain = Boolean(voice?.isBusy());
      recovered = Boolean(input.value.trim()) || modeDrain;
      // stop() drains the last phrase into the same saved draft. No submission here.
      voice?.stop(); spokenReplies = mode === 'voice'; replySpeech?.cancel(); speaker?.cancel();
      persist(); paint();
      if (mode === 'typed') { autosize(); input.focus(); }
    },
    onStatus: status => {
      if (gone) return;
      modeStatus.hidden = !status.pending;
      modeStatus.textContent = status.error ? 'Mode changed here; saving failed.' : status.pending ? 'Saving answer mode…' : '';
      modeRetry.hidden = !status.error;
      paint(); if (!status.pending) openMic();
    },
  });
  function mergeState(next) { state = { ...state, ...next, mode: modeControl.sync(next.mode) }; }
  const typed = el('div', { class: 'ci-typed' }, input);
  const voicePanel = el('div', { class: 'ci-voice', hidden: true }, [voiceView.root]);
  voiceView.setControls({ lead: [micButton], actions: [interruptButton, typeLink, sendNow] });
  // Session controls sit with the clock; the composer holds this turn only.
  const toolbar = el('div', { class: 'ci-toolbar' }, [timeControls.root, pauseButton, endButton, el('button', { class: 'btn btn--quiet ci-learning-notes', text: 'Learning notes', onclick: () => openLearningNotes(slug, entry.title) }), back]);
  const modelPicker = createCoachModelPicker({ compact: true });
  const composer = createComposer({ className: 'ci-composer ui-pane-controls', content: [typed, voicePanel],
    leading: [modelPicker.root, voiceLink], trailing: [speechButton, send], notices: [modeStatus, modeRetry] });
  const composerFooter = composer.querySelector('.ui-composer-footer');
  const pausedText = el('span', { class: 'ui-cluster-content' });
  const resume = el('button', { class: 'btn btn--primary', text: 'Resume', onclick: togglePause });
  const paused = el('div', { class: 'ci-paused ui-inset ui-cluster', hidden: true }, [pausedText, resume]);
  const feedback = el('section', { class: 'ci-feedback ci-debrief', hidden: true, 'aria-label': 'Interview feedback' });
  const transcript = el('details', { class: 'ci-transcript', hidden: true }, el('summary', { text: 'Conversation transcript' }));
  const root = el('aside', { class: contained ? 'card ci-panel ci-contained ui-pane' : embedded ? 'ci-panel ci-embedded' : 'card coach ci-panel', 'aria-label': entry.discipline === 'lld' ? 'LLD interviewer' : 'Coding interviewer' }, [
    el('div', { class: 'ci-live-header ui-toolbar' }, [
      el('div', { class: 'ci-header' }, [el('div', { class: 'ci-identity' }, [el('strong', { text: entry.title }), pill]), toolbar]),
      el('div', { class: 'ci-session-controls' }, [phasebar]),
    ]),
    paused, feedback, transcript, log, notice, composer,
  ]);
  const retry = el('button', { class: 'btn btn--quiet ws-mini', type: 'button', text: 'Retry reply', hidden: true, onclick: async () => {
    if (loading || busy || gone) return;
    if (loadFailed) { await boot(); return; }
    if (!lastOperation) return;
    const { action, extra } = lastOperation;
    const ok = await request(action === 'start' && state.id ? 'retry' : action, extra);
    if (ok) reconcileCompletion();
  } });
  notice.after(retry);
  const error = message => {
    notice.textContent = message || '';
    notice.hidden = !message;
    retry.hidden = !message || (!lastOperation && !loadFailed);
    retry.textContent = loadFailed ? 'Retry loading' : !state.id ? 'Retry start' : 'Retry reply';
  };
  const elapsed = () => state.id ? Math.max(0, Math.min(state.endedAt || Date.now(), state.pausedAt || Infinity) - Number(state.startedAt || Date.now()) - (state.pausedMs || 0)) : 0;
  function reconcileCompletion() {
    if (!state.debriefed || activeInterview(slug)?.id !== state.id) return;
    remember(null);
    window.dispatchEvent(new CustomEvent('studio-interview-finished'));
  }
  function persist() {
    const active = activeInterview(slug);
    if (state.id && !state.debriefed && active && (!active.id || active.id === state.id)) {
      remember({ ...state, turns: undefined, busy: undefined });
    }
    reconcileCompletion();
    if (state.id && entry.discipline !== 'lld') {
      const target = `interview:${slug}:${state.id}`;
      if (target !== toolTarget) { unbindTools(); toolTarget = target; unbindTools = registerActionAlias(target, slug); }
    }
    onState({ ...state, turns: undefined });
    syncHeaderControls();
  }
  function syncHeaderControls() {
    if (!embedded) return;
    const screenRail = root.closest('.view')?.querySelector('.ui-screen-header .ui-header-actions');
    const submit = screenRail?.querySelector('.ws-submit');
    if (submit) {
      submit.classList.toggle('btn--primary', state.debriefed);
      submit.classList.toggle('btn--secondary', !state.debriefed);
    }
    const live = visible && !state.debriefed && Boolean(screenRail);
    const learning = toolbar.querySelector('.ci-learning-notes') || screenRail?.querySelector('.ci-learning-notes');
    const overflow = screenRail?.querySelector('.ui-overflow-sources');
    if (learning && overflow && live) overflow.append(learning);
    else if (learning && !toolbar.contains(learning)) toolbar.append(learning);
    for (const nav of screenRail?.querySelectorAll('.pnav-btn') || []) nav.classList.toggle('ui-overflow-only', live);
    const destination = visible && !state.debriefed && screenRail ? screenRail : root.querySelector('.ci-header');
    if (destination && toolbar.parentElement !== destination) destination.prepend(toolbar);
  }
  function setDraft(text) {
    input.value = text; autosize();
    sendingDraft = true;
    try { saveDraft(draftKey(), text); } finally { sendingDraft = false; }
  }
  let unwatch = () => {};
  function restoreDraft() {
    draftReady = true;
    unwatch();
    input.value = readDraft(draftKey())?.text || '';
    recovered = Boolean(input.value);
    try { const saved = JSON.parse(localStorage.getItem(requestKey())); if (saved?.said === input.value.trim()) requestId = saved.requestId; } catch { /* no pending request */ }
    unwatch = watchDraft(draftKey(), text => {
      if (sendingDraft || gone) return;
      input.value = text; autosize(); recovered = Boolean(text); paint();
    });
  }
  function autosize() { inputSize.resize(); send.disabled = !input.value.trim() || busy || loading || loadFailed || !participating || Boolean(state.pausedAt) || Boolean(state.endedAt) || ending || !state.id; }
  input.addEventListener('input', () => { autosize(); lastTyping = Date.now(); requestId = null; setDraft(input.value); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey && !hasOpenOverlay()) {
      if (claimActionKey(event)) answer();
    }
  });
  function paint() {
    const isVoice = state.mode === 'voice';
    root.dataset.mode = state.mode || 'typed';
    typeLink.disabled = voiceLink.disabled = loading || loadFailed || timeControls.saving || ending || !state.id || Boolean(state.endedAt || state.debriefed);
    typeLink.hidden = Boolean(speaker?.speaking);
    composerFooter.hidden = isVoice;
    root.dataset.interviewId = state.id || '';
    root.dataset.debriefed = String(Boolean(state.debriefed));
    root.classList.toggle('is-complete', Boolean(state.debriefed));
    if (voice) voice.root.hidden = isVoice;
    typed.hidden = isVoice; send.hidden = isVoice; voicePanel.hidden = !isVoice; speechButton.hidden = isVoice || state.debriefed;
    composer.hidden = Boolean(state.debriefed); modelPicker.setBusy(busy);
    pauseButton.hidden = endButton.hidden = Boolean(state.debriefed);
    back.hidden = embedded ? !loadFailed && Boolean(state.id || busy) : !loadFailed && !state.debriefed && (Boolean(state.id) || busy);
    back.disabled = loading;
    back.textContent = state.id ? (entry.discipline === 'lld' ? 'Back to interviews' : 'Back to coach') : 'Cancel';
    replace(pauseButton, icon(state.pausedAt || !participating ? 'play' : 'pause'));
    pauseButton.setAttribute('aria-label', state.pausedAt || !participating ? 'Resume interview' : 'Pause interview');
    root.classList.toggle('is-paused', Boolean(state.pausedAt));
    paused.hidden = !state.pausedAt || Boolean(state.debriefed);
    pausedText.textContent = 'Paused at ' + formatClock(elapsed());
    resume.disabled = loading || loadFailed || busy || timeControls.saving || modeControl.saving || ending;
    pauseButton.hidden = Boolean(state.debriefed || state.pausedAt);
    pauseButton.disabled = loading || loadFailed || busy || timeControls.saving || modeControl.saving || ending || Boolean(state.endedAt) || !state.id;
    endButton.disabled = loading || loadFailed || timeControls.saving || ending || !state.id;
    send.disabled = !input.value.trim() || !participating || loading || loadFailed || busy || timeControls.saving || modeControl.saving || ending || Boolean(state.endedAt) || Boolean(state.pausedAt) || !state.id;
    input.disabled = !participating || loading || loadFailed || Boolean(state.pausedAt) || Boolean(state.endedAt) || ending;
    // A recovered answer waits for a decision: send it or edit it, then the mic reopens.
    const held = recovered && Boolean(input.value);
    micButton.hidden = loading || Boolean(state.pausedAt);
    paintMicToggle(micButton, voiceState === 'recording');
    micButton.disabled = held || !state.id || voiceState === 'working' || !participating || loading || loadFailed || modeControl.saving || ending || Boolean(state.endedAt) || Boolean(state.pausedAt);
    interruptButton.hidden = !speaker?.speaking;
    sendNow.hidden = !isVoice || Boolean(speaker?.speaking) || (busy && voiceState !== 'working')
      || !(input.value.trim() || partialWords);
    sendNow.disabled = !participating || loading || loadFailed || busy || timeControls.saving || modeControl.saving || ending || Boolean(state.endedAt) || Boolean(state.pausedAt) || !state.id;
    micLabel.textContent = loading ? 'Loading interview' : !state.id ? (busy ? 'Preparing interview' : 'Interview not started') : state.debriefed ? 'Debrief' : state.pausedAt || !participating ? 'Paused' : speaker?.speaking ? 'Interviewer speaking' : busy && voiceState !== 'recording' ? 'Interviewer is thinking…' : voiceState === 'working' ? 'Transcribing…' : voiceState === 'recording' ? 'Listening' : 'Your turn';
    pill.hidden = (isVoice && Boolean(state.id)) || micLabel.textContent === 'Your turn';
    for (const [index, item] of [...phasebar.children].entries()) {
      const done = index < phases.findIndex(([key]) => key === state.phase);
      item.classList.toggle('is-done', done);
      item.textContent = (done ? '✓ ' : '') + phases[index][1];
      if (item.dataset.phase === (state.phase || 'clarify')) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    }
    timeControls.update({ disabled: loading || loadFailed || busy || modeControl.saving || ending || !state.id || Boolean(state.endedAt), hidden: Boolean(state.debriefed) });
    const reading = mockTimeReading(state.minutes || 45, elapsed());
    const { remaining } = reading;
    clock.textContent = reading.text;
    timeControls.root.querySelector('button').setAttribute('aria-label', `${reading.text} ${reading.label}. Add time`);
    clock.setAttribute('aria-label', `${reading.text} ${reading.label}`);
    clock.dataset.urgency = remaining <= 120000 ? 'hard' : remaining <= 300000 ? 'med' : '';
    voiceView.update({state: voiceState, draft: input.value, partial: partialWords, busy, paused: !!state.pausedAt, held: held || (state.needsAttention && Boolean(input.value.trim()))});
    // Composer/status changes can resize the panel after a token was appended.
    // Reconcile before yielding: speech status can change between animation frames,
    // and deferring the scroll leaves a visible gap after the composer grows.
    if (following && !gone) revealLatest();
  }
  function scrollViewport() { return embedded && !contained ? root.closest('.interviews-view') : log; }
  // Follow is a user-intent latch. Geometry alone cannot distinguish a reader who
  // is near the bottom from a stream that just grew the footer by a few pixels.
  let following = true;
  let mayResume = false;
  let lastTop = 0;
  const atBottom = viewport => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1;
  const intent = (direction, distance = 1) => {
    if (!direction) return;
    following = false;
    mayResume = direction > 0;
    const viewport = scrollViewport();
    lastTop = viewport?.scrollTop || 0;
    if (mayResume && viewport && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= distance) following = true;
  };
  function followingLatest() {
    const viewport = scrollViewport();
    bindViewport();
    if (!viewport || !visible || state.debriefed) return false;
    if (!following && mayResume && atBottom(viewport)) following = true;
    return following;
  }
  const conversationView = bindConversation(log, { composer, viewport: scrollViewport, onJump: () => { following = true; mayResume = true; revealLatest(); } });
  let boundViewport = null;
  let viewportAbort = null;
  function bindViewport() {
    const viewport = scrollViewport();
    if (!viewport || boundViewport === viewport) return;
    viewportAbort?.abort();
    viewportAbort = new AbortController();
    const signal = viewportAbort.signal;
    boundViewport = viewport;
    lastTop = viewport.scrollTop;
    viewport.addEventListener('wheel', event => intent(event.deltaY, event.deltaMode === 0 ? Math.max(1, event.deltaY) : 1), { passive: true, signal });
    viewport.addEventListener('keydown', event => {
      if (event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (['PageUp', 'ArrowUp', 'Home'].includes(event.key)) intent(-1);
      if (event.key === 'End') { event.preventDefault(); intent(1, Infinity); revealLatest(); }
      if (['PageDown', 'ArrowDown'].includes(event.key)) intent(1);
      if (event.key === ' ') intent(event.shiftKey ? -1 : 1);
    }, { signal });
    let touchY = null;
    viewport.addEventListener('touchstart', event => { touchY = event.touches[0]?.clientY ?? null; following = false; mayResume = false; }, { passive: true, signal });
    viewport.addEventListener('touchmove', event => {
      const y = event.touches[0]?.clientY;
      if (touchY !== null && y !== undefined) intent(touchY - y);
      touchY = y ?? null;
    }, { passive: true, signal });
    let pointerY = null;
    viewport.addEventListener('pointerdown', event => {
      const box = viewport.getBoundingClientRect();
      if (event.clientX >= box.right - Math.max(16, viewport.offsetWidth - viewport.clientWidth)) {
        pointerY = event.clientY; following = false; mayResume = true; lastTop = viewport.scrollTop;
      }
    }, { passive: true, signal });
    viewport.addEventListener('pointermove', event => { if (event.buttons && pointerY !== null) { intent(event.clientY - pointerY); pointerY = event.clientY; } }, { passive: true, signal });
    viewport.addEventListener('pointerup', () => { pointerY = null; }, { signal });
    viewport.addEventListener('pointercancel', () => { pointerY = null; }, { signal });
    viewport.addEventListener('scroll', () => {
      const top = viewport.scrollTop;
      if (!following && mayResume && top > lastTop && atBottom(viewport)) following = true;
      lastTop = top;
    }, { passive: true, signal });
  }
  function revealLatest() {
    const viewport = scrollViewport();
    if (!viewport || !visible || state.debriefed) return;
    if (!embedded) { log.scrollTop = log.scrollHeight; return; }
    viewport.scrollTop = viewport.scrollHeight;
  }
  const shownCandidates = new Set();
  function candidate(text, request, at = elapsed(), destination = log) {
    if (request && shownCandidates.has(request)) return;
    if (request) shownCandidates.add(request);
    bubble('You', text, at, false, destination);
  }
  function bubble(who, text = '', atMs = elapsed(), debrief = false, destination = log) {
    const content = conversationText(text, { className: 'ci-text', user: who === 'You' });
    const node = conversationMessage({ speaker: who, user: who === 'You', body: content,
      stamp: atMs < 60000 ? 'At the start' : `${Math.floor(atMs / 60000)} min in`, dataset: { elapsed: atMs },
      className: `cmsg ci-entry${who === 'You' ? ' ci-candidate' : ''}${debrief ? ' ci-debrief' : ''}`,
      actions: who === 'Interviewer' ? [replayButton(() => content.dataset.markdown, replayReply)] : [],
    });
    const follow = destination === log && followingLatest();
    destination.append(node);
    if (follow) revealLatest();
    return content;
  }
  const chip = (text, tone = ratingTone(text)) => el('span', { class: 'ui-badge ui-badge--' + tone, text });
  // The tone comes from the raw signal: the displayed label can carry a difficulty suffix.
  const signalChip = (signal, fallback) => signal ? chip(signalLabel(signal, state.reportDifficulty), ratingTone(signal)) : chip(fallback);
  async function loadReport({ open = false } = {}) {
    try {
      const result = await interviewJson(detailUrl(slug, state.id));
      if (gone || !result.report) return;
      state.report = result.report;
      if (result.reportDifficulty) state.reportDifficulty = result.reportDifficulty;
      if (embedded || entry.discipline === 'lld') showFeedback(writtenDebrief);
      if (open && result.report.judgement) showReport();
    } catch { /* the saved debrief remains visible */ }
  }
  let writtenDebrief = '';
  function showReport() {
    // Every finished interview opens, including older ones whose debrief is prose.
    if (!state.report) return;
    openReport({ title: entry.title || slug, record: state, report: state.report, transcript: log, debriefText: writtenDebrief, followups: {
      load: async () => (await interviewJson(detailUrl(slug, state.id))).followups || [],
      send: (body, onEvent) => streamRequest('/api/interview/ask', { slug, interviewId: state.id, ...body }, onEvent),
    }, onRegrade: async () => {
      await streamRequest('/api/interview/regrade', { slug, interviewId: state.id, requestId: crypto.randomUUID() }, () => {});
      await loadReport({ open: true });
    } });
  }
  function showFeedback(text) {
    if (state.completionReason === 'no-response') {
      replace(feedback, [el('div', { class: 'ci-empty-session ui-inset ui-inset--roomy ui-stack' }, [
        el('div', { class: 'ci-empty-icon' }, icon('mic', 22)),
        el('h3', { text: 'No response recorded' }),
        el('p', { text: 'You ended this interview before answering. No report was generated.' }),
        el('div', { class: 'ci-score-meta dim', text: `${interviewDuration(state)} · ${state.mode === 'voice' ? 'Voice' : 'Typed'} · ${relativeInterviewDate(state.startedAt)}` }),
        el('button', { class: 'btn btn--secondary', type: 'button', text: 'Back to interviews', onclick: onBack }),
      ])]);
      feedback.hidden = false;
      transcript.hidden = false;
      if (log.parentNode !== transcript) transcript.append(log);
      const count = log.querySelectorAll('.ci-entry').length;
      transcript.querySelector('summary').textContent = `Show conversation · ${count} ${count === 1 ? 'turn' : 'turns'}`;
      return;
    }
    const judgement = state.report?.judgement;
    if (judgement) {
      const hero = el('div', { class: 'ci-score-hero ui-inset' }, [
        signalChip(judgement.signal, 'No signal recorded'),
        judgement.headline ? el('p', { text: judgement.headline }) : null,
        el('div', { class: 'ci-score-meta dim', text: `${interviewDuration(state)} · ${state.mode === 'voice' ? 'Voice' : 'Typed'} · ${relativeInterviewDate(state.startedAt)}${state.coachModel ? ' · ' + modelLabel(state.coachProvider, state.coachModel) : ''}` }),
      ]);
      const rows = el('div', { class: 'ci-mini-dims' }, judgement.dimensions.map(d => el('div', { class: 'ci-mini-dim' }, [
        el('span', { text: d.name }),
        el('span', { class: 'rp-meter', dataset: { tone: d.rating ? ratingTone(d.rating) : 'neutral' }, 'aria-hidden': 'true' },
          [1, 2, 3, 4].map(n => el('i', { class: n <= ({ Weak: 1, Mixed: 2, Solid: 3, Strong: 4 }[d.rating] || 0) ? 'is-on' : '' }))),
        el('span', { class: 'ci-mini-rating', text: d.rating || 'Not rated' }),
      ])));
      const openButton = el('button', { type: 'button', class: 'btn btn--primary ci-open-report', onclick: showReport }, [icon('report', 14), el('span', { text: 'Open full report' })]);
      replace(feedback, [hero, rows, openButton]);
      feedback.hidden = false;
      transcript.hidden = false;
      if (log.parentNode !== transcript) transcript.append(log);
      transcript.querySelector('summary').textContent = `Show conversation · ${log.querySelectorAll('.ci-entry').length} turns`;
      return;
    }
    writtenDebrief = text || '';
    const sections = debriefSections(text);
    const hire = sections.find(part => /^hire signal/i.test(part.heading));
    const hireParts = hire?.text.replace(/\*\*/g, '').match(/^(Strong hire|Lean hire|Lean no|No hire|Hire)\b\s*[—:–-]?\s*([\s\S]*)/i);
    const hero = el('div', { class: 'ci-score-hero ui-inset' }, [
      signalChip(hireParts?.[1] || state.hireSignal, 'Feedback'),
      hireParts?.[2] ? el('p', { text: hireParts[2] }) : hire ? conversationText(hire.text) : null,
      el('div', { class: 'ci-score-meta dim', text: `${interviewDuration(state)} · ${state.mode === 'voice' ? 'Voice' : 'Typed'} · ${relativeInterviewDate(state.startedAt)}${state.coachModel ? ' · ' + modelLabel(state.coachProvider, state.coachModel) : ''}` }),
    ]);
    const dimensions = el('div', { class: 'ci-dimensions' });
    const used = new Set(hire ? [hire] : []);
    for (const [pattern, label] of [[/^problem solving/i, 'Problem solving'], [/^coding/i, 'Coding'], [/^communication/i, 'Communication'], [/^testing/i, 'Testing']]) {
      const part = sections.find(section => pattern.test(section.heading));
      if (part) used.add(part);
      const match = part?.text.replace(/\*\*/g, '').match(/^(Strong|Solid|Mixed|Weak)\b\s*[—:–-]?\s*([\s\S]*)/i);
      const evidence = match?.[2] || part?.text || 'No evidence recorded.';
      const quote = el('div', { class: 'ci-evidence' + (/no evidence recorded/i.test(evidence) ? ' dim' : '') });
      // Link only to an actual recorded turn, never a fabricated timestamp.
      const time = evidence.match(/\b(\d{1,3}):(\d{2})\b/);
      if (time) {
        const at = (Number(time[1]) * 60 + Number(time[2])) * 1000;
        quote.append(el('button', { class: 'btn btn--quiet ci-evidence-time', text: time[0], onclick: () => {
          const turns = [...log.querySelectorAll('[data-elapsed]')];
          const target = turns.sort((a, b) => Math.abs(Number(a.dataset.elapsed) - at) - Math.abs(Number(b.dataset.elapsed) - at))[0];
          if (!target) return;
          transcript.open = true; target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          target.tabIndex = -1; target.focus({ preventScroll: true });
        } }));
      }
      // The timestamp is the button; don't repeat it in the quote.
      quote.append(conversationText(time ? evidence.replace(time[0], '').replace(/^\s*[:—–-]\s*/, '') : evidence));
      dimensions.append(el('section', { class: 'ci-dimension' }, [el('div', { class: 'ci-dimension-heading' }, [el('strong', { text: label }), chip(match?.[1] || 'Not rated')]), quote]));
    }
    const times = recordedPhaseTimes(state), total = times.reduce((sum, part) => sum + part.ms, 0);
    const phaseStats = el('div', { class: 'ci-phase-stats' }, [el('h3', { text: 'Time per phase' }),
      total ? el('div', { class: 'ci-phase-stack', 'aria-hidden': 'true' }, times.filter(part => part.ms > 0).map((part, index) => el('span', { style: `flex:${part.ms};opacity:${1 - index * .14}` }))) : null,
      el('div', { class: 'ci-phase-labels' }, times.map(part => el('span', { text: `${phases.find(([key]) => key === part.phase)?.[1] || part.phase} ${formatClock(part.ms)}` }))),
      Array.isArray(state.hints) ? el('p', { class: 'dim', text: `${state.hints.length} hints used` }) : null,
    ]);
    const extra = [];
    for (const part of sections) {
      if (used.has(part)) continue;
      if (/^time per phase/i.test(part.heading) && times.length) continue;
      if (/^hints used/i.test(part.heading) && Array.isArray(state.hints)) continue;
      extra.push(el('section', { class: 'ci-score-extra' }, [part.heading ? el('h3', { text: /practi[cs]e next|work on next|next steps/i.test(part.heading) ? 'What to work on next' : part.heading }) : null, conversationText(part.text)]));
    }
    const openWritten = state.report ? el('button', { type: 'button', class: 'btn btn--primary ci-open-report', onclick: showReport }, [icon('report', 14), el('span', { text: 'Open report and ask about it' })]) : null;
    replace(feedback, [hero, openWritten, dimensions, ...(times.length ? [phaseStats] : []), ...extra]);
    feedback.hidden = false;
    transcript.hidden = false;
    transcript.append(log);
    transcript.querySelector('summary').textContent = `Show conversation · ${log.querySelectorAll('.ci-entry').length} turns`;
  }
  function replay(turns = []) {
    const readingTop = scrollViewport()?.scrollTop || 0;
    shownCandidates.clear();
    const history = document.createDocumentFragment();
    let lastPhase = null;
    for (const turn of turns) {
      if (turn.phase && turn.phase !== lastPhase) {
        lastPhase = turn.phase; history.append(conversationSeparator(phases.find(([key]) => key === turn.phase)?.[1] || turn.phase, { phase: true, value: turn.phase }));
      }
      if (turn.kind === 'tool_action') { showWorkspaceAction(history, turn.action, { replay: true }); continue; }
      const at = turn.elapsedMs ?? Math.max(0, Date.parse(turn.at) - Number(state.startedAt));
      if (turn.said) candidate(turn.said, turn.requestId, at, history);
      if (['interviewer_silent', 'suppressed_filler'].includes(turn.kind) && turn.replyKind === 'turn') history.append(interviewerSilentNote());
      const asked = turn.asked ?? turn.reply;
      if (asked) {
        if ((embedded || entry.discipline === 'lld') && turn.kind === 'debrief') { showFeedback(asked); continue; }
        const debrief = turn.kind === 'debrief' || turn.replyKind === 'debrief';
        const target = bubble(debrief ? 'Debrief' : 'Interviewer', asked, at, debrief, history);
        if (turn.kind === 'partial') target.after(el('p', { class: 'dim', text: 'Reply interrupted before it finished.' }));
      }
    }
    if ((embedded || entry.discipline === 'lld') && state.debriefed && !feedback.childNodes.length) showFeedback('No feedback was recorded for this interview.');
    replace(log, history);
    transcript.querySelector('summary').textContent = `Show conversation · ${log.querySelectorAll('.ci-entry').length} turns`;
    if (following) revealLatest();
    else if (scrollViewport()) scrollViewport().scrollTop = readingTop;
  }
  async function openMic() {
    if (micOpening || !state.id || !participating || !visible || !micEnabled || modeControl.pending || loading || loadFailed || state.endedAt || gone || modeControl.saving || ending || state.pausedAt || state.debriefed || state.mode !== 'voice' || recovered || document.hidden) return;
    if (voice?.isBusy()) { resumeMicAfterDrain = voiceState === 'working'; return; }
    micOpening = true;
    try {
      resumeMicAfterDrain = false;
      void speaker?.prepare();
      await voice?.start();
      // Permission/device failures leave an explicit retry, never an automatic loop.
      if (!voice?.isBusy()) micEnabled = false;
      if (!gone) paint();
    } finally { micOpening = false; }
  }
  async function drainMic({ keepListening = false } = {}) {
    if (keepListening) { await voice?.flush(); return; }
    voice?.stop();
    // A final phrase is still being transcribed after tracks close. Its words must
    // join this answer (or the debrief), never spill silently into a later turn.
    const until = Date.now() + 65000;
    while (voice?.isBusy() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    if (voice?.isBusy()) throw Error('Still transcribing your last words. Try again when they appear.');
    if (voice?.hasTranscriptionError()) throw Error('Some recorded words need retrying. Retry or discard the failed audio before sending.');
  }
  speaker = createSpeaker({ onPlayback: value => voiceView.playback(value), onStateChange: () => {
    openMic();
    paint();
  } });
  voice = createVoiceControl({
    reportEmptyTake: false, onSettled: () => { if (modeDrain) { modeDrain = false; recovered = Boolean(input.value.trim()); if (!gone) { paint(); openMic(); } } else if (resumeMicAfterDrain) openMic(); },
    getSlug: () => slug, logTakes: false, recordingMode: 'think_aloud', getAttemptId: () => state.id, maxTakeMs: 60 * 60000,
    // One microphone pipeline in Voice mode. Each live phrase is archived by ASR,
    // and its text becomes a durable interview draft before it can be submitted.
    onState: next => { voiceState = next; if (next === 'idle') { loud = false; pending = 0; } if (!gone) paint(); },
    onPreview: text => { partialWords = text; if (!gone) paint(); },
    onTranscript: text => {
      lastSpeech = Date.now(); requestId = null;
      if (gone) { appendDraft(draftKey(), text); return; }
      setDraft(input.value + (input.value && !/\s$/.test(input.value) ? ' ' : '') + text);
      if (state.mode === 'voice' && (speaker.speaking || (busy && !interrupted))) interrupt();
      paint();
    },
    onLevel: value => {
      voiceView.level(value);
      loud = value.loud; pending = value.pending;
      if (loud) lastSpeech = Date.now();
      if (state.mode !== 'voice' || gone || recovered || ending || state.pausedAt) return;
      if (loud && (speaker.speaking || (busy && !interrupted))) interrupt();
      if (voiceView.automatic && !state.needsAttention && !voice.hasTranscriptionError() && turnDecision({ sinceLoud: value.sinceLoud, chars: input.value.trim().length, speaking: speaker.speaking, busy, pending }) === 'send') answer();
    },
  });
  // Keep microphone errors visible without showing dictation's second mode button.
  voicePanel.append(voice.status);
  function interrupt() {
    interrupted = true; replySpeech?.cancel(); speaker.cancel();
    openMic();
  }
  const keydown = event => {
    if (event.key === 'Escape' && speaker.speaking && !hasOpenOverlay() && claimActionKey(event)) interrupt();
  };
  window.addEventListener('keydown', keydown, true);

  async function request(action, extra = {}) {
    if (busy || timeControls.saving || modeControl.saving || gone) return false;
    if (action === 'event') extra = { ...extra, requestId: extra.requestId || crypto.randomUUID() };
    busy = true; interrupted = false; replySpeech = createSpeechStream(speaker);
    if (action !== 'event') state.needsAttention = false;
    if (action !== 'event') lastOperation = { action, extra };
    if (action !== 'event') { error(''); paint(); }
    const thinking = thinkingRow(); log.append(thinking);
    let target = null, accepted = false, stopped = false, debriefText = '', draftConsumed = false;
    const consumeDraft = () => {
      if (!extra.said || draftConsumed) return;
      draftConsumed = true;
      setDraft(remainingDraft(input.value, extra.said));
      requestId = null; rememberRequest(null);
    };
    const isDebrief = action === 'done' || (action === 'retry' && Boolean(state.endedAt));
    try {
      const result = await streamRequest(`/api/interview/${action}`, {
        slug, interviewId: state.id, code: code(), ...extra,
      }, (name, payload) => {
        if (name === 'action') { if (!gone) showWorkspaceAction(log, payload); }
        else if (name === 'interview') {
          const oldDraft = input.value;
          mergeState({ ...payload, pending: false });
          if (oldDraft) saveDraft(draftKey(), oldDraft);
          if (!gone) restoreDraft();
          persist(); announce();
          if (action === 'start') { loading = false; void openMic(); }
        } else if (name === 'accepted') {
          accepted = true;
          if (payload.state) { mergeState(payload.state); persist(); }
          if (payload.said && !gone) candidate(payload.said, payload.requestId);
          const delivered = new Set((extra.events || []).map(event => event.requestId));
          eventQueue = eventQueue.filter(event => !delivered.has(event.requestId)); saveEvents();
          consumeDraft();
          if (action === 'turn') void openMic();
        } else if (name === 'token') {
          thinking.remove();
          if (gone) return;
          target ??= bubble(isDebrief ? 'Debrief' : 'Interviewer', '', elapsed(), isDebrief);
          target.classList.add('ci-streaming');
          const follow = followingLatest();
          // The report arrives as JSON; show progress, not the raw structure.
          if (isDebrief) { debriefText += payload.text || ''; target.textContent = 'Writing your report…'; }
          else appendConversationText(target, payload.text || '');
          if (follow) revealLatest();
          // A reply to earlier words is shown, not spoken over the candidate's new ones.
          if ((action === 'turn' || action === 'event') && !interrupted && (loud || input.value.trim())) interrupt();
          if (spokenReplies && !interrupted && !isDebrief) {
            replySpeech.push(payload.text || '');
          }
        } else if (name === 'phase') state.phase = payload.phase;
        else if (name === 'broke-character') error('The interviewer’s reply was cut short because it began answering for you.');
        else if (name === 'done') {
          accepted = true;
          mergeState({ ...(payload.state || {}), ...(payload.phase ? { phase: payload.phase } : {}) });
          consumeDraft();
          if (isDebrief && state.completionReason === 'no-response') showFeedback('');
          if (isDebrief && target && (embedded || entry.discipline === 'lld') && state.debriefed) {
            showFeedback(debriefText);
            target.parentElement.remove();
            target = null;
          }
          if (isDebrief && target) {
            const follow = followingLatest();
            // The raw JSON stays in the record; the transcript only says how it ended.
            target.textContent = state.debriefed ? 'Report ready.' : 'The report stopped before it finished.';
            target.classList.remove('ci-streaming');
            if (follow) revealLatest();
          }
          stopped = Boolean(payload.stopped);
          if (action === 'turn' && !gone && payload.silent) {
            const follow = followingLatest();
            log.append(interviewerSilentNote({ live: true }));
            if (follow) revealLatest();
          }
          if (stopped) { state.needsAttention = true; lastOperation = { action, extra }; error('The reply stopped before it finished. You can retry it.'); }
          persist();
        }
        if (!gone) paint();
      });
      if (spokenReplies && !interrupted && !gone && !isDebrief) replySpeech.finish();
      if (result.state) { mergeState(result.state); persist(); }
      if (result.existing) {
        state.id = result.id; state.pending = false; persist();
        const saved = await interviewJson(detailUrl(slug, state.id));
        mergeState(saved); persist();
        if (!gone) { replay(saved.turns); restoreDraft(); recoverFailure(saved.turns); }
      }
      if (result.duplicate || result.skipped) {
        const saved = await interviewJson(detailUrl(slug, state.id));
        mergeState(saved); persist();
        if (!gone) replay(saved.turns);
        consumeDraft();
      }
      if (stopped) return false;
      if (action !== 'event' && !result.existing) lastOperation = null;
      return result.interjected === false || result.skipped ? 'suppressed' : accepted || result.existing || result.duplicate;
    } catch (failure) {
      replySpeech?.cancel();
      if (!gone && !(action === 'event' && failure.status === 409)) {
        lastOperation = { action, extra };
        state.needsAttention = true; onState({ ...state, turns: undefined });
        error(failure.message);
      }
      return false;
    } finally {
      thinking.remove();
      busy = false;
      if (!gone) { paint(); void modeControl.flush(); openMic(); }
    }
  }
  async function answer() {
    if (!participating || loading || loadFailed || busy || timeControls.saving || modeControl.saving || ending || state.endedAt || state.pausedAt || state.debriefed || !state.id || gone) return;
    // Lock while draining as onLevel can otherwise submit the same phrase twice.
    busy = true; paint();
    try { await drainMic({ keepListening: true }); } catch (failure) { error(failure.message); busy = false; paint(); return; }
    busy = false;
    const said = input.value.trim();
    if (!said) { openMic(); return; }
    requestId ||= crypto.randomUUID();
    setDraft(said); rememberRequest({ said, requestId });
    lastSpeech = Date.now(); recovered = false;
    await request('turn', { said, requestId, events: [...eventQueue] });
  }
  async function finish() {
    if (loading || loadFailed || ending || state.debriefed || !state.id || gone) return;
    ending = true; replySpeech?.cancel(); speaker.cancel(); paint();
    try {
      await drainMic();
      if (state.mode === 'typed') await endInterviewArchive();
      // An in-flight response owns its stream. Wait for it before requesting a debrief.
      while ((busy || timeControls.saving || modeControl.saving) && !gone) await new Promise(resolve => setTimeout(resolve, 50));
      if (gone) return;
      const said = input.value.trim();
      const extra = lastOperation?.action === 'done' ? lastOperation.extra
        : { said, requestId: crypto.randomUUID(), events: [...eventQueue] };
      const completed = await request('done', extra);
      if (completed && state.debriefed) {
        voice.stop(); speaker.cancel();
        reconcileCompletion();
        await loadReport({ open: true });
      }
    } catch (failure) { error(failure.message); }
    finally { ending = false; paint(); }
  }
  async function togglePause() {
    if (loading || loadFailed || busy || timeControls.saving || modeControl.saving || ending || state.endedAt || !state.id || gone) return;
    busy = true; replySpeech?.cancel(); speaker.cancel(); paint();
    try {
      await drainMic();
      const resuming = Boolean(state.pausedAt) || !participating;
      const result = await interviewJson(`/api/interview/${resuming ? 'resume' : 'pause'}`, { slug, interviewId: state.id });
      mergeState(result.state || result);
      participating = true;
      if (resuming) remember({ ...state, turns: undefined });
      persist();
      if (state.mode === 'typed') await pauseInterviewArchive(Boolean(state.pausedAt));
    } catch (failure) { error(failure.message); }
    finally { busy = false; paint(); void modeControl.flush(); openMic(); }
  }
  const metrics = () => ({ speaking: loud || pending > 0 || Boolean(speaker?.speaking) || Boolean(input.value.trim()), secondsSinceSpeech: (Date.now() - lastSpeech) / 1000, secondsSinceTyping: (Date.now() - lastTyping) / 1000 });
  const work = event => {
    if (!participating || event.detail?.slug !== slug || state.debriefed) return;
    const data = event.detail;
    if (data.type === 'typing') { lastTyping = Date.now(); return; }
    eventQueue.push({ ...data, ...metrics(), elapsedMs: elapsed(), requestId: crypto.randomUUID() }); saveEvents();
  };
  restoreEvents();
  window.addEventListener('studio-interview-work', work);
  const tick = async () => {
    if (loading || loadFailed || gone || !state.id || state.debriefed) return;
    paint();
    if (!participating || state.endedAt || state.pausedAt || state.needsAttention || busy || timeControls.saving || modeControl.saving || ending) return;
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
  function recoverFailure(turns = []) {
    const failed = [...turns].reverse().find(turn => ['error', 'partial', 'opening', 'turn', 'debrief', 'suppressed_filler', 'interviewer_silent'].includes(turn.kind));
    if (state.debriefed || !['error', 'partial'].includes(failed?.kind)) return;
    if (failed.requestId) {
      lastOperation = { action: 'retry', extra: { requestId: failed.requestId } };
    }
    error('The last reply did not finish. Your saved interview is still available.');
  }
  async function boot() {
    loading = true; loadFailed = false; error(''); paint();
    try {
      if (state.id) {
        const result = await interviewJson(detailUrl(slug, state.id));
        if (gone) return;
        mergeState({ ...(result.state || result), id: state.id });
        lastSpeech = state.lastSpeechAt || Date.now(); lastTyping = state.lastTypingAt || Date.now();
        spokenReplies = state.mode === 'voice';
        replay(result.turns); restoreDraft();
        recoverFailure(result.turns);
        if (participating && !state.debriefed && !activeInterview()) remember({ ...state, turns: undefined });
        persist(); paint();
        // GET waits for an existing turn before replaying it; restoring never asks the
        // model the same question again or resets the interview's start time.
      } else {
        restoreDraft();
        micEnabled = state.mode === 'voice'; spokenReplies = state.mode === 'voice';
        await request('start', { discipline: entry.discipline || 'coding', targetLevel: state.targetLevel || 'L4', minutes: state.minutes || 45, mode: state.mode || 'typed', fresh: Boolean(state.fresh), requestId: state.startRequestId || crypto.randomUUID() });
        // Typed input does not implicitly open a microphone. Voice mode owns its ASR pipeline.
      }
    } catch (failure) { if (!gone) { loadFailed = true; error(failure.message); } }
    finally { loading = false; if (!gone) { restoreScroll(); paint(); void modeControl.flush(); openMic(); } }
  }
  let restoredScroll = false;
  function restoreScroll() {
    if (gone || loading || !visible || restoredScroll) return;
    const host = scrollViewport();
    if (!host) return;
    bindViewport();
    const saved = readSidebar(slug).interviewScroll?.[state.id];
    if (Number.isFinite(saved)) {
      host.scrollTop = saved;
      following = atBottom(host);
      mayResume = !following;
    }
    lastTop = host.scrollTop;
    restoredScroll = true;
  }
  const scrollHost = scrollViewport;
  const rememberScroll = () => { const host = scrollHost(); if (host && state.id && restoredScroll) saveSidebar(slug, { interviewScroll: { ...(readSidebar(slug).interviewScroll || {}), [state.id]: host.scrollTop } }); };
  root.addEventListener('wheel', () => requestAnimationFrame(rememberScroll), { passive: true });
  const api = { root, slug, headerControls: toolbar, showReport,
    setVisible(on) {
      visible = on;
      syncHeaderControls();
      if (on) requestAnimationFrame(restoreScroll);
      if (!on) rememberScroll();
      if (!on) { micEnabled = false; resumeMicAfterDrain = false; voice.stop(); speaker.cancel(); }
    },
    get interviewId() { return state.id; }, focus: () => { if (state.mode !== 'voice') input.focus(); }, attach() {}, end: finish,
    resume() { const resumeWhenReady = () => { if (gone) return; if (loading) { setTimeout(resumeWhenReady, 50); return; } if (state.pausedAt || !participating) togglePause(); }; resumeWhenReady(); },
    beginAttempt() {}, endAttempt() {}, reviewAttempt() {},
    dispose() {
      unbindTools();
      const submit = toolbar.closest('.ui-screen-header')?.querySelector('.ws-submit');
      if (submit) { submit.classList.add('btn--primary'); submit.classList.remove('btn--secondary'); }
      const rail = toolbar.closest('.ui-screen-header');
      for (const nav of rail?.querySelectorAll('.pnav-btn') || []) nav.classList.remove('ui-overflow-only');
      rail?.querySelector('.ci-learning-notes')?.remove();
      toolbar.remove();
      inputSize.dispose(); modelPicker.dispose(); conversationView.dispose(); modeControl.dispose(); timeControls.dispose();
      if (gone) return;
      rememberScroll(); gone = true; viewportAbort?.abort(); unwatch(); clearInterval(timer);
      if (draftReady) saveDraft(draftKey(), input.value);
      replySpeech?.cancel(); speaker.dispose(); voice.dispose({ finish: true });
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('studio-interview-work', work);
      document.removeEventListener('visibilitychange', visibility);
      if (mounted === api) mounted = null;
    },
  };
  mounted = api; paint(); boot();
  return api;
}
