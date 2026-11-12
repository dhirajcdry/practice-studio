import { relativeInterviewDate } from './interview-format.js';
import { createCoachModelPicker } from './coach-model.js';
import { screenHeader, paneHeader } from './ui/headers.js';
import { practiseFromMock } from './ui/button.js';
import { createMockTimeControls, mockTimeReading } from './ui/mock-time.js';
import { createComposer, composerSend, bindComposerInput, mountComposerDictation } from './ui/composer.js';
import { bindBoardTools, showWorkspaceAction } from './workspace-tools.js';
import { loadExcalidraw, boardTools } from './whiteboard.js';
import { initPractice, startPracticeFromMock } from './practice.js';
import { openLearningNotes } from './learning.js';
import { createInterviewSetup } from './interview.js';
import { mountTrackHome } from './track-home.js';
import { createInterviewMode } from './interview-mode.js';
// The system design interview: a whiteboard, and someone asking about it.
//
// The canvas is Excalidraw, vendored under web/vendor/excalidraw and loaded only when
// this screen opens — it is 8 MB, and no other route should pay for it.
//
// Three rules shape the interaction.
//
// DRAWING IS NOT SPEAKING. Excalidraw's onChange fires on every pointer move. Those go
// to the server as cheap snapshots and never wake the model. The interviewer sees the
// board on the next turn you actually take, which is also how a real interview works:
// they watch you draw and respond when you stop.
//
// THE CANDIDATE HOLDS THE FLOOR. Nothing here auto-sends. You answer when you press
// send or stop dictating, because an interviewer who interrupts your sentence because
// you paused to think is worse than no interviewer.
//
// AN INTERVIEW OUTLIVES THE TAB. A design interview is an hour of work, and nobody has
// a spare hour at the moment they want to practise. So this screen opens on the library
// of past interviews rather than on a new one: unfinished interviews are picked up where
// they were left, finished ones are re-read, and leaving the screen stops the clock
// instead of quietly charging you for the night.

import { el, replace } from './dom.js';
import { conversationMessage, bindConversation, conversationSeparator, thinkingRow, conversationText, setConversationText, appendConversationText } from './ui/conversation.js';
import { claimActionKey, hasOpenOverlay } from './keyboard.js';
import { installPaneResizer } from './ui/split-pane.js';
import { openReport } from './interview-report.js';
import { streamInterviewRequest } from './interview-transport.js';
import { onSettingsChange } from './settings.js';
import { createSelect } from './ui/select.js';
import { createBadge } from './ui/badge.js';
import { createSpeechStream } from './speech-stream.js';
import { createVoicePanel, answerModeSwitch, micToggle, paintMicToggle, replayButton, interviewerSilentNote } from './ui/voice-panel.js';
import { createVoiceControl } from './voice.js';
import { createSpeaker, turnDecision, speechSupported } from './speech.js';
import { designDraftNotice } from './design-draft.js';
import { readDraft, saveDraft, clearDraft, appendDraft, watchDraft, remainingDraft } from './drafts.js';

const PHASES = [
  ['requirements', 'Requirements'],
  ['entities', 'Entities'],
  ['api', 'API'],
  ['estimates', 'Estimates'],
  ['design', 'Design'],
  ['deepdive', 'Deep dive'],
  ['bottlenecks', 'Bottlenecks'],
];

const PHASE_LABELS = new Map(PHASES);

/** Read one SSE turn, calling back as tokens arrive. Mirrors the coach's stream. */
const STEP_IN_AFTER_MS = 60000, STEP_IN_COOLDOWN_MS = 120000;

async function streamPost(url, body, { onToken, onEvent }) {
  return streamInterviewRequest(url, body, (name, payload) => {
    if (name === 'token') onToken(payload.text ?? '');
    else onEvent(name, payload);
  });
}

/** A JSON call that throws with the server's own words rather than a status code. */
async function callJson(url, body = null) {
  const res = await fetch(url, body === null ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* handled below */ }
  if (!res.ok) throw new Error(payload?.error?.message ?? `The server answered ${res.status}.`);
  if (!payload) throw new Error('The server sent something that was not an interview.');
  return payload;
}

/** `#/design/<id>` → the id. Any other hash → null. */
export function designIdFromHash(hash = location.hash) {
  const match = /^#\/design\/([^/?#]+)$/.exec(hash || '');
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * What to call an interview in a list.
 *
 * The prompt is written by the interviewer on the opening turn, so an interview that was
 * abandoned before it answered has none. That says so, rather than inventing a title
 * from the id or the level — an untitled row is a real thing that happened.
 */
function titleOf(item) {
  const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : '';
  return prompt || 'No problem was set — this one was closed before the interviewer spoke';
}

function countLabel(n) {
  if (!Number.isFinite(n) || n <= 0) return 'no questions yet';
  return `${n} question${n === 1 ? '' : 's'}`;
}

/** Date · level · questions · whether it was graded. Every part of it is known, not guessed. */
function metaOf(item) {
  return [item.level?.toUpperCase(), item.startedAt ? relativeInterviewDate(item.startedAt) : 'Date not recorded', countLabel(item.turns)].filter(Boolean);
}

/** Put the transcript back on screen, in the order it was said. */
function replayTurns(turns, entry, log, beganAt) {
  let lastPhase = null;
  for (const turn of turns ?? []) {
    const start = typeof beganAt === 'number' ? beganAt : Date.parse(beganAt);
    const elapsedMs = turn.elapsedMs ?? (Number.isFinite(start) && Number.isFinite(Date.parse(turn.at)) ? Math.max(0, Date.parse(turn.at) - start) : undefined);
    if (log && turn.phase && turn.phase !== lastPhase) {
      lastPhase = turn.phase;
      log.append(conversationSeparator(PHASE_LABELS.get(lastPhase) || lastPhase, { phase: true, value: lastPhase }));
    }
    if (turn.kind === 'tool_action') { if (log) showWorkspaceAction(log, turn.action, { replay: true }); continue; }
    if (turn.kind === 'debrief') {
      if (turn.asked) entry('d', turn.asked.trim().startsWith('{') ? 'Report ready.' : turn.asked);
      continue;
    }
    if (turn.said) { entry('a', turn.said, elapsedMs); if (log?.lastElementChild && turn.phase) log.lastElementChild.dataset.phase = turn.phase; }
    if (['interviewer_silent', 'suppressed_filler'].includes(turn.kind) && turn.requestId && log) log.append(interviewerSilentNote());
    if (turn.asked) { entry('q', turn.asked, elapsedMs); if (log?.lastElementChild && turn.phase) log.lastElementChild.dataset.phase = turn.phase; }
  }
}

async function showDesignReport(id, transcript) {
  const data = await callJson(`/api/design/${id}`);
  if (!data.report) throw Error('No completed report was recorded.');
  return openReport({ title: data.prompt || 'System design', record: { ...data, discipline: 'design' }, report: data.report, transcript,
    debriefText: data.turns.find(t => t.kind === 'debrief')?.asked || '',
    followups: {
      load: async () => (await callJson(`/api/design/${id}`)).followups || [],
      send: (body, onEvent) => streamInterviewRequest('/api/design/ask', { ...body, interviewId: id }, onEvent),
    },
  });
}

/* ---------------- the library ---------------- */

/**
 * The System design home: next session, skills and problems (see track-home.js).
 * Preset topics start from their prompt alone; a prepared problem also names its slug,
 * which the server checks against the saved problem before the interview begins.
 */
function mountLibrary(host, { onNew, onOpen }) {
  let presets = new Set();
  const view = el('div', { class: 'dzl' });
  replace(host, view);
  return mountTrackHome(view, {
    discipline: 'design', title: 'System design',
    loadInterviews: async () => {
      const { interviews, topics } = await callJson('/api/design');
      presets = new Set((topics || []).map(topic => topic.slug));
      return { presetSlugs: presets, interviews: (interviews || []).map(item => ({
        id: item.id, slug: item.topicSlug, startedAt: item.startedAt, debriefed: item.debriefed,
        title: typeof item.prompt === 'string' && item.prompt.trim() ? item.prompt.trim() : titleOf(item),
      })) };
    },
    openInterview: item => onOpen(item.id),
    createNewMock: () => {
      const topicSelect = createSelect({ label: 'System design problem', value: '', options: [['', 'Choose for me · unseen'], ['Design a URL-shortening service.', 'URL shortener'], ['Design a messaging service for one-to-one conversations.', 'Messaging'], ['Design a cloud file-storage service.', 'File storage'], ['Design a personalized news-feed service.', 'News feed']] });
      const mock = createInterviewSetup({ slug: 'design-new-mock', discipline: 'design', label: 'Mock interview', description: 'Let the interviewer choose a fresh problem using your history, or pick a topic.', startLabel: 'Begin interview', onStart: async state => {
        const problem = topicSelect.value ? null : (await callJson('/api/mock/prepare', { discipline: 'design', targetLevel: state.targetLevel, minutes: state.minutes, requestId: state.startRequestId })).problem;
        onNew({ level: state.targetLevel, minutes: state.minutes, answerMode: state.mode, prompt: problem?.statement || topicSelect.value, problemSlug: problem?.slug, requestId: state.startRequestId });
      } });
      return { root: el('div', { class: 'ui-stack' }, [topicSelect, mock.root]), dispose() { topicSelect.dispose(); mock.dispose(); } };
    },
    startMock: (problem, state) => onNew({ level: state.targetLevel, minutes: state.minutes, answerMode: state.mode,
      prompt: problem.statement, problemSlug: presets.has(problem.slug) ? undefined : problem.slug, requestId: state.startRequestId }),
  });
}

/* ---------------- one interview, read back ---------------- */

/**
 * A finished (or abandoned) interview, read-only: the transcript and the final board.
 *
 * No input box, on purpose. The debrief graded what was said, and a screen that lets you
 * add to a graded interview is a screen that makes the grade a lie.
 */
function mountReview(host, data, { onBack }) {
  let gone = false;
  let root = null;
  let boardApi = null;
  const stopTheme = onSettingsChange(() => boardApi?.updateScene({ appState: { theme: document.body.classList.contains('is-dark') ? 'dark' : 'light' } }));

  const log = el('div', { class: 'dz-log ui-pane-scroll ui-inset', tabindex: '0', 'aria-label': 'Interview transcript' });

  const conversationView = bindConversation(log);
  const entry = (kind, text, elapsedMs) => {
    log.append(conversationMessage({ speaker: kind === 'q' ? 'Interviewer' : kind === 'a' ? 'You' : 'Debrief', user: kind === 'a', text, elapsedMs, className: `dz-entry dz-${kind}` }));
  };

  if (!data.turns?.length) {
    log.append(el('div', { class: 'dzl-empty' },
      'Nothing was said in this interview — it was closed before the first question.'));
  } else {
    replayTurns(data.turns, entry, log, data.startedAt);
  }

  // An interview without a debrief is not a finished interview, and must not read like
  // one just because it is being viewed after the fact.
  if (!data.debriefed) {
    log.append(el('div', { class: 'dz-cut mono', text:
      'This interview was never debriefed, so there is no assessment of it. '
      + (!data.resumable ? 'This interview cannot be continued.'
        : data.rebuilt ? 'Continues from the saved transcript.'
          : 'It can still be resumed.') }));
  }

  const phaseFilter = createSelect({ label: 'Transcript phase', value: '', options: [['', 'All phases'], ...PHASES], onChange: event => {
    for (const item of log.children) item.hidden = Boolean(event.target.value && item.dataset.phase !== event.target.value);
  } });
  const canvasHost = el('div', { class: 'dz-canvas ui-editor-surface' },
    el('div', { class: 'dz-loading mono', text: 'Loading the board…' }));
  const boardControls = boardTools(() => boardApi);

  const view = el('div', { class: 'dz-view ui-workspace' }, [
    screenHeader({ back: { onClick: onBack, label: 'Back to interviews', className: 'dz-back' }, crumb: 'Interviews', title: titleOf(data),
      badges: [createBadge(data.debriefed ? 'Debriefed' : 'In progress', data.debriefed ? 'good' : 'neutral')],
      meta: metaOf({ ...data, turns: data.turns?.length ?? 0 }),
      actions: {
        primary: data.debriefed ? { label: 'View report', variant: 'primary', onClick: () => showDesignReport(data.id, log).catch(error => entry('d', error.message)) } : null,
        secondary: [data.topicSlug ? { label: 'Learning notes', onClick: () => openLearningNotes(data.topicSlug, titleOf(data)) } : null,
          practiseFromMock({ variant: data.debriefed ? 'secondary' : 'primary', onClick: async event => {
            const button = event.currentTarget; button.disabled = true;
            try { await startPracticeFromMock({ discipline: 'design', slug: data.topicSlug, interviewId: data.id }); }
            catch (error) { button.disabled = false; entry('d', error.message); }
          } })],
      },
    }),
    el('div', { class: 'dz-split' }, [
      el('section', { class: 'ui-board-pane has-board-tools is-review' }, [paneHeader({ title: 'Whiteboard', tools: boardControls }), canvasHost]),
      el('div', { class: 'dz-side ui-pane' }, [
        paneHeader({ title: 'Transcript', tools: [phaseFilter] }),
        log,
      ]),
    ]),
  ]);
  replace(host, view);

  (async () => {
    // An empty board is a fact about the interview, so it is stated rather than left as
    // a blank rectangle that looks like a failed load. It also saves loading 8 MB.
    if (!data.elements?.length) {
      replace(canvasHost, el('div', { class: 'dz-loading mono' },
        'The board was empty — nothing was drawn in this interview.'));
      return;
    }
    try {
      const ex = await loadExcalidraw();
      if (gone) return;
      root = ex.createRoot(canvasHost);
      canvasHost.querySelector('.dz-loading')?.remove();
      root.render(ex.createElement(ex.Excalidraw, {
        theme: document.body.classList.contains('is-dark') ? 'dark' : 'light',
        viewModeEnabled: true,
        excalidrawAPI: (instance) => { boardApi = instance; },
        onChange: (_elements, appState) => boardControls.sync(appState?.zoom?.value),
        initialData: { elements: data.elements, scrollToContent: true },
        UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, export: false } },
      }));
    } catch {
      replace(canvasHost, el('div', { class: 'dz-loading mono' }, [
        'The board was drawn, but the whiteboard could not be loaded to show it. Run ',
        el('code', { text: 'node scripts/vendor-excalidraw.mjs' }), '.',
      ]));
    }
  })();

  return { destroy() { gone = true; conversationView.dispose(); stopTheme(); root?.unmount(); root = null; boardApi = null; } };
}

/* ---------------- one interview, live ---------------- */

function mountInterview(host, { level = 'L4', minutes = 45, prompt = null, problemSlug = null, answerMode = 'voice', requestId = crypto.randomUUID(), resumed = null, onBack }) {
  let interviewId = resumed?.id ?? null;
  let unbindTools = () => {}, toolTarget = null;
  function bindTools() {
    if (!interviewId || toolTarget === interviewId) return;
    unbindTools(); toolTarget = interviewId;
    unbindTools = bindBoardTools({ target: `design:${interviewId}`, getApi: () => api, getElements: () => elements, setElements: next => onSceneChange(next), save: persistScene, readOnly: () => destroyed || debriefed });
  }
  let boardRoot = null;
  const stopTheme = onSettingsChange(() => api?.updateScene({ appState: { theme: document.body.classList.contains('is-dark') ? 'dark' : 'light' } }));
  let api = null;               // Excalidraw's imperative handle
  let elements = resumed?.elements ?? [];
  let phase = resumed?.phase ?? 'requirements';
  let busy = false;
  let destroyed = false;
  let debriefed = false;
  let paused = false;
  let changingPause = false, modeDrain = false, finishing = false, draining = false;
  let pauseWhenIdle = false;
  let sceneTimer = null, sceneWrites = Promise.resolve();
  let startedAt = resumed?.startedAt ? Date.parse(resumed.startedAt) || Date.now() : null;
  let clockTimer = null;
  let speaker = null;
  let voice = null;
  // Two modes, not one toggle among four buttons. They are different interactions:
  // typed is a text box you submit, voice is a conversation where going quiet IS the
  // submit. A recovered draft is the exception: explicitly send or edit it first.
  let mode = 'type';       // 'type' | 'voice'
  const isVoice = () => mode === 'voice';
  let replySpeech = null;    // tokens not yet formed into a speakable sentence
  let turnTimer = null;

  if (resumed?.level) level = resumed.level;
  if (Number.isFinite(resumed?.minutes)) minutes = resumed.minutes;

  /* ---- the transcript column ---- */

  const log = el('div', { class: 'dz-log ui-pane-scroll ui-inset', tabindex: '0', 'aria-label': 'Interview transcript' });
  let following = true, lastLogTop = 0;
  log.addEventListener('wheel', event => { if (event.deltaY < 0) following = false; }, { passive: true });
  log.addEventListener('scroll', () => {
    if (log.scrollTop < lastLogTop) following = false;
    if (log.scrollHeight - log.scrollTop - log.clientHeight <= 1) following = true;
    lastLogTop = log.scrollTop;
  });
  let pausedElapsed = 0;
  const clock = el('span', { class: 'mono dz-clock' });
  const timeControls = createMockTimeControls({ clock, extend: async change => {
    const result = await callJson('/api/design/extend', { interviewId, ...change });
    if (!destroyed) { minutes = result.state.minutes; paintClock(); }
  }, onChange: () => { if (!destroyed) { paintDraft(); if (!timeControls.saving) void modeControl.flush(); } } });
  function paintTimeControls() {
    timeControls.update({ disabled: !interviewId || busy || timeControls.saving || draining || modeControl.saving || changingPause || finishing, hidden: debriefed });
  }
  const pauseButton = el('button', { class: 'btn btn--quiet dz-pause', type: 'button', text: 'Pause',
    title: 'Pause the timer and microphone without ending your interview', disabled: true, onclick: () => togglePause() });
  const phaseBar = el('div', { class: 'dz-phases', role: 'group', 'aria-label': 'Interview phase' }, PHASES.map(([id, label]) =>
    el('button', {
      class: 'btn btn--quiet dz-phase', type: 'button', dataset: { phase: id },
      'aria-pressed': String(id === phase),
      text: label,
      title: `Tell the interviewer you have moved on to ${label.toLowerCase()}`,
      onclick: () => { phase = id; paintPhases(); },
    })));

  function paintPhases() {
    for (const button of phaseBar.querySelectorAll('.dz-phase')) {
      button.setAttribute('aria-pressed', String(button.dataset.phase === phase));
    }
  }

  const input = el('textarea', {
    class: 'dz-input', rows: '3', placeholder: 'Talk through your approach',
    'aria-label': 'Your answer',
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.altKey && !hasOpenOverlay() && claimActionKey(e)) answer();
    },
  });
  let pendingRequest = null;
  const rememberRequest = value => { pendingRequest = value; if (interviewId) { const key = 'design-request:' + interviewId; value ? localStorage.setItem(key, JSON.stringify(value)) : localStorage.removeItem(key); } };
  try { pendingRequest = JSON.parse(localStorage.getItem('design-request:' + resumed?.id)); } catch { /* no saved request */ }
  const draft = readDraft(resumed?.id ? 'design:' + resumed.id : '');
  if (draft?.text) input.value = draft.text;
  input.addEventListener('input', () => { if (interviewId) saveDraft('design:' + interviewId, input.value); paintDraft(); });

  const inputSize = bindComposerInput(input);
  const sendButton = composerSend(el('button', { class: 'btn btn--quiet dz-send', type: 'button', onclick: () => answer() }));

  const micSlot = el('span', { class: 'dz-mic' });
  const status = el('div', { class: 'dz-status mono', role: 'status', text: '' });

  // Always a click away, because the moment you want it is the moment voice has
  // just mangled a term. For a single word, clicking the words is quicker still.
  const typeLink = answerModeSwitch('type', setMode);
  const voiceLink = answerModeSwitch('voice', setMode);

  // Speaking cuts playback immediately; the button and Escape remain alternatives.
  const skipButton = el('button', {
    class: 'btn btn--secondary', type: 'button', hidden: true, text: 'Interrupt · Esc',
    title: 'Stop the interviewer and start answering (Esc)',
    onclick: () => interrupt(),
  });

  /** What voice mode shows instead of a text box: state, and your words as they land. */
  let captureState = 'idle', partialWords = '', speechInterrupted = false, replyFailed = false;
  let candidateLoud = false, phrasesPending = 0, lastActivity = Date.now(), lastStepIn = 0;
  const voiceView = createVoicePanel({ onEdit: () => setMode('type') });
  const replayReply = text => {
    if (busy || speaker?.speaking) return;
    speaker?.say(text);
  };
  let pendingDraft = Boolean(input.value.trim());
  let micMuted = false;
  const micButton = micToggle(() => {
    if (voice?.isRecording?.()) { micMuted = true; closeMic(); }
    else { micMuted = false; openMic(); }
    paintVoice();
  });
  function paintDraft() { paintVoice(); paintTimeControls(); sendButton.disabled = !input.value.trim() || busy || paused || draining; }
  let writingDraft = false;
  const unwatchDraft = interviewId ? watchDraft('design:' + interviewId, text => {
    if (writingDraft) return;
    input.value = text; inputSize.resize();
    pendingDraft = Boolean(text.trim());
    if (pendingDraft && isVoice()) closeMic();
    paintDraft();
  }) : () => {};
  const sendVoice = composerSend(el('button', { class: 'btn btn--quiet dz-voice-send', type: 'button', onclick: () => answer() }));
  const voicePanel = el('div', { class: 'dz-voice', hidden: true }, [voiceView.root]);
  voiceView.setControls({ lead: [micButton], actions: [skipButton, typeLink, sendVoice] });
  const typePanel = el('div', { class: 'dz-type' }, input);
  const typeActions = el('div', { class: 'dz-actions' }, [micSlot, status, sendButton]);

  function paintVoice() {
    // The microphone is held shut until a recovered answer is sent or edited, so going quiet sends nothing.
    const held = designDraftNotice({ text: input.value, pending: pendingDraft, mode }).visible;
    const speaking = Boolean(speaker?.speaking);
    voiceView.update({state: captureState, draft: input.value, partial: partialWords, busy, sending: draining, paused, held: held || (replyFailed && Boolean(input.value.trim()))});
    sendVoice.hidden = speaking || !(input.value.trim() || partialWords);
    sendVoice.disabled = busy || timeControls.saving || draining || paused || changingPause || modeControl.saving || modeControl.pending;
    typeLink.hidden = speaking;
    micButton.disabled = held || !voice || draining || paused || changingPause || modeControl.pending || captureState === 'working';
    paintMicToggle(micButton, captureState === 'recording');
  }

  function setMode(next) { if (!debriefed && !destroyed && !finishing) modeControl.select(next === 'voice' ? 'voice' : 'typed'); }
  function applyMode(next) {
    mode = next === 'voice' ? 'voice' : 'type';
    view.dataset.mode = mode;
    composer.querySelector('.ui-composer-footer').hidden = isVoice();
    typePanel.hidden = isVoice(); typeActions.hidden = isVoice(); voicePanel.hidden = !isVoice(); inputSize.resize();
    micMuted = false;
    modeDrain = Boolean(voice?.isBusy());
    pendingDraft = pendingDraft || Boolean(input.value.trim()) || modeDrain;
    voice?.stop(); speechInterrupted = true; replySpeech?.cancel(); speaker?.cancel();
    paintDraft();
    if (isVoice()) { voicePanel.append(micSlot); paintVoice(); }
    else { typeActions.prepend(micSlot); say(''); input.focus(); }
  }
  const modeStatus = el('span', { class: 'dim', role: 'status', hidden: true });
  const modeRetry = el('button', { class: 'btn btn--quiet', text: 'Retry saving mode', hidden: true, onclick: () => modeControl.retry() });
  const modeControl = createInterviewMode({ initial: resumed ? resumed.mode || 'typed' : answerMode,
    ready: () => Boolean(interviewId) && !busy && !timeControls.saving && !draining && !destroyed && !debriefed && !changingPause,
    save: mode => callJson('/api/design/mode', { interviewId, mode }),
    onSelect: applyMode,
    onStatus: state => {
      modeStatus.hidden = !state.pending; modeStatus.textContent = state.error ? 'Mode changed here; saving failed.' : 'Saving answer mode…';
      modeRetry.hidden = !state.error;
      paintDraft();
      sendButton.disabled = !input.value.trim() || busy || timeControls.saving || draining || state.saving || paused || changingPause;
      doneButton.disabled = busy || timeControls.saving || draining || state.saving || paused || changingPause || !interviewId;
      if (!state.pending) openMic();
    },
  });

  function interrupt() {
    micMuted = false; speechInterrupted = true; replySpeech?.cancel(); speaker?.cancel();
    openMic();
  }

  function openMic() {
    if (micMuted || !isVoice() || !interviewId || modeControl.pending || destroyed || draining || finishing || debriefed || paused || changingPause || designDraftNotice({ text: input.value, pending: pendingDraft, mode }).blocksMic) return;
    void speaker?.prepare();
    try { voice?.start?.(); } catch { /* the button still works */ }
  }

  function closeMic() {
    try { if (voice?.isRecording?.()) voice.stop(); } catch { /* noop */ }
  }
  async function drainMic({ keepListening = false } = {}) {
    draining = true; if (!keepListening) closeMic(); paintDraft(); sendButton.disabled = true;
    try {
      if (keepListening) { await voice?.flush(); return !destroyed; }
      const deadline = Date.now() + 65000;
      while (voice?.isBusy() && !destroyed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (voice?.isBusy()) { say('Still transcribing your last words. Send again when they appear.'); return false; }
      if (voice?.hasTranscriptionError()) { say('Retry or discard the failed audio before sending.'); return false; }
      return !destroyed;
    } catch (error) { say(error.message); return false; }
    finally { draining = false; if (!destroyed) { paintDraft(); sendButton.disabled = !input.value.trim() || busy || paused; } }
  }
  const doneButton = el('button', {
    class: 'btn btn--quiet dz-done', type: 'button', text: 'Finish', 'data-danger': 'true',
    onclick: () => finish(),
  });

  function say(what) { status.textContent = what; }

  /** One entry in the transcript. Returns the node so tokens can stream into it. */
  let replaying = false;
  let lastEntryPhase = null;
  function entry(kind, text = '', elapsedMs = replaying ? undefined : paused ? pausedElapsed : startedAt ? Math.max(0, Date.now() - startedAt) : undefined) {
    if (!replaying && kind !== 'd' && phase !== lastEntryPhase) {
      log.append(conversationSeparator(PHASE_LABELS.get(phase) || phase, { phase: true, value: phase }));
      lastEntryPhase = phase;
    }
    const body = conversationText(text, { className: 'dz-body', user: kind === 'a' });
    const node = conversationMessage({ speaker: kind === 'q' ? 'Interviewer' : kind === 'a' ? 'You' : 'Debrief', user: kind === 'a', body, elapsedMs,
      className: `dz-entry dz-${kind}`, dataset: { phase }, actions: kind === 'q' ? [replayButton(() => body.dataset.markdown, replayReply)] : [] });
    node.hidden = Boolean(livePhaseFilter.value && phase !== livePhaseFilter.value);
    log.append(node);
    if (kind === 'a') following = true;
    if (following) log.scrollTop = log.scrollHeight;
    return body;
  }

  /* ---- turns ---- */

  async function runTurn(url, body, { kind = 'q', idle = false } = {}) {
    if (busy || timeControls.saving || modeControl.saving || destroyed || debriefed || paused || changingPause) return false;
    busy = true; speechInterrupted = false; replySpeech = createSpeechStream(speaker);
    if (!idle) replyFailed = false;
    paintDraft();
    pauseButton.disabled = true;
    practise.disabled = true;
    sendButton.disabled = true;
    doneButton.disabled = true;
    if (!idle) say('thinking…');
    if (isVoice() && !idle) paintVoice('Thinking…', 'think');
    // An answer may be met with silence, so its bubble waits for words to put in it.
    const thinking = thinkingRow(); log.append(thinking);
    const answering = url === '/api/design/turn';
    let target = answering ? null : entry(kind), silent = false;
    const reply = () => (target ??= entry(kind));
    let cut = false, draftConsumed = false;
    let succeeded = false;
    let failed = false;
    try {
      await streamPost(url, body, {
        onToken: (text) => {
          thinking.remove();
      if (target) target.dataset.streaming = 'false';
          if (destroyed) return;
          const follow = following;
          if (kind === 'd') setConversationText(reply(), 'Writing your report…');
          else { appendConversationText(reply(), text); reply().dataset.streaming = 'true'; }
          if (follow) log.scrollTop = log.scrollHeight;
          // A reply to earlier words is shown, not spoken over the candidate's new ones.
          if (answering && !speechInterrupted && (candidateLoud || input.value.trim())) interrupt();
          if (!isVoice() || kind === 'd' || speechInterrupted) return;
          // Speak each sentence as it completes. Waiting for the whole question would
          // add its entire generation time to the silence before the interviewer talks.
          replySpeech.push(text);
        },
        onEvent: (name, payload) => {
          if (name === 'action') { if (!destroyed) showWorkspaceAction(log, payload); return; }
          if (name === 'interview') {
            interviewId = payload.id; bindTools();
            if (input.value) saveDraft('design:' + interviewId, input.value);
            modeControl.sync(payload.mode);
            startedAt = Date.parse(payload.startedAt) || Date.now();
            tickClock();
          } else if (name === 'accepted') {
            lastActivity = Date.now();
            if (body.said && !draftConsumed) {
              draftConsumed = true;
              input.value = remainingDraft(input.value, body.said); inputSize.resize();
              writingDraft = true;
              try { if (input.value) saveDraft('design:' + interviewId, input.value); else clearDraft('design:' + interviewId); }
              finally { writingDraft = false; }
              pendingDraft = false; paintDraft();
            }
            if (answering) openMic();
          } else if (name === 'done') {
            succeeded = !payload.broke && !payload.stoppedReason; silent = Boolean(payload.silent);
            if (kind === 'd' && succeeded) setConversationText(reply(), 'Report ready.');
          } else if (name === 'phase' && PHASE_LABELS.has(payload.phase)) {
            phase = payload.phase; paintPhases();
          } else if (name === 'broke-character') {
            // Said out loud rather than swallowed. The turn is about to end short and
            // the candidate deserves the real reason.
            cut = true;
          } else if (name === 'error') {
            failed = true;
            setConversationText(reply(), payload.message);
            reply().closest('.dz-entry')?.classList.add('dz-err');
          }
        },
      });
      if (cut) {
        const note = el('div', { class: 'dz-cut mono' },
          reply().textContent.trim()
            ? 'The interviewer started writing your answer, so the turn was cut there. The question above stands.'
            : 'The interviewer started writing your answer, so the turn was cut. Say something and it will ask again.');
        reply().after(note);
      }
      if (!succeeded && !failed) {
        failed = true;
        reply().closest('.dz-entry')?.classList.add('dz-err');
        appendConversationText(reply(), '\n\nThe connection ended before this turn finished. Your interview is still open.');
      }
      if (!silent && !idle && !reply().textContent.trim() && !cut) setConversationText(reply(), 'No response was received.');
      if (silent && !idle && !destroyed) {
        const follow = following;
        log.append(interviewerSilentNote({ live: true }));
        if (follow) log.scrollTop = log.scrollHeight;
      }
      if (!destroyed && !speechInterrupted && isVoice() && kind !== 'd') replySpeech.finish();
    } catch (error) {
      replySpeech?.cancel();
      failed = true;
      setConversationText(reply(), error.message);
      reply().closest('.dz-entry')?.classList.add('dz-err');
    } finally {
      thinking.remove();
      if (target) target.dataset.streaming = 'false';
      replyFailed = failed;
      busy = false;
      paintDraft();
      sendButton.disabled = !input.value.trim();
      doneButton.disabled = paused;
      pauseButton.disabled = !interviewId || debriefed;
      practise.disabled = !interviewId;
      void modeControl.flush();
      if (pauseWhenIdle) { pauseWhenIdle = false; if (!paused && !destroyed) togglePause(); }
      say(isVoice() ? (speaker?.speaking ? 'speaking…' : 'listening…') : '');
      if (isVoice() && kind !== 'd') openMic();
    }
    if (succeeded && !failed && body.requestId === pendingRequest?.requestId) rememberRequest(null);
    if (failed && !destroyed) reply().after(el('button', { class: 'btn btn--quiet', text: 'Retry response', onclick: async event => {
      event.currentTarget.disabled = true;
      if (kind === 'd') await finish(); else await runTurn(url, body, { kind });
    } }));
    return succeeded && !failed;
  }

  async function answer() {
    if (!interviewId || busy || timeControls.saving || draining || modeControl.saving || debriefed || destroyed || paused || changingPause) return;
    if (!(await drainMic({ keepListening: true }))) return;
    await modeControl.flush();
    const said = input.value.trim();
    const request = pendingRequest?.said === said ? pendingRequest : { said, requestId: crypto.randomUUID() };
    if (said && request !== pendingRequest) entry('a', said);
    rememberRequest(request);
    // Clear only on server acceptance. A network failure before acceptance keeps the draft.
    if (isVoice()) paintVoice('Thinking…', 'think');
    await runTurn('/api/design/turn', { interviewId, ...request, phase, elements, mode: mode === 'type' ? 'typed' : 'voice' });
  }

  async function finish() {
    if (!interviewId || busy || timeControls.saving || draining || modeControl.saving || debriefed || destroyed || paused || changingPause) return;
    if (!(await drainMic())) return;
    await modeControl.flush();
    const said = input.value.trim();
    const request = pendingRequest?.said === said ? pendingRequest : { said, requestId: crypto.randomUUID() };
    if (said && request !== pendingRequest) entry('a', said);
    rememberRequest(request);
    finishing = true;
    const completed = await runTurn('/api/design/done', { interviewId, elements, ...request }, { kind: 'd' });
    finishing = false;
    if (!completed || destroyed) return;
    const saved = await callJson(`/api/design/${interviewId}`);
    if (!saved.debriefed) { say('The report did not finish. You can retry.'); return; }
    debriefed = true;
    view.classList.add('is-complete');
    closeMic();
    speaker?.cancel();
    view.querySelector('.dz-compose').hidden = true;
    phaseBar.querySelectorAll('button').forEach(button => { button.disabled = true; });
    api?.updateScene({ appState: { viewModeEnabled: true } });
    doneButton.disabled = true;
    doneButton.textContent = 'View report';
    doneButton.removeAttribute('data-danger');
    doneButton.classList.replace('btn--quiet', 'btn--primary');
    view.querySelector('.ui-header-actions').append(doneButton);
    doneButton.disabled = false;
    doneButton.onclick = () => showDesignReport(interviewId, log).catch(error => say(error.message));
    await showDesignReport(interviewId, log).catch(error => say(error.message));
    pauseButton.hidden = true; paintTimeControls();
    if (clockTimer) clearInterval(clockTimer);
  }

  function paintPaused() {
    paintDraft();
    pauseButton.textContent = paused ? 'Resume' : 'Pause';
    pauseButton.setAttribute('aria-label', paused ? 'Resume interview' : 'Pause interview');
    pauseButton.setAttribute('aria-pressed', String(paused));
    clock.classList.toggle('paused', paused);
    paintClock();
    input.disabled = paused;
    sendButton.disabled = !input.value.trim() || paused || busy;
    doneButton.disabled = paused || busy;
    typeLink.disabled = paused;
    voiceLink.disabled = paused || !speechSupported() || !voice;
    phaseBar.querySelectorAll('button').forEach(button => { button.disabled = paused; });
    if (voice) voice.root.hidden = paused;
    api?.updateScene({ appState: { viewModeEnabled: paused } });
    say(paused ? 'Paused' : '');
    if (isVoice()) paintVoice();
  }

  async function togglePause() {
    if (!interviewId || busy || timeControls.saving || changingPause || destroyed || debriefed) return;
    changingPause = true;
    pauseButton.disabled = true;
    closeMic(); replySpeech?.cancel(); speaker?.cancel();
    try {
      if (paused) {
        const result = await callJson('/api/design/resume', { interviewId });
        startedAt = Date.parse(result.startedAt);
        minutes = result.minutes;
        paused = false;
      } else {
        const result = await callJson('/api/design/pause', { interviewId });
        paused = true;
        pausedElapsed = result.spentMs;
      }
      if (!destroyed) paintPaused();
    } catch (error) { say(`Could not ${paused ? 'resume' : 'pause'}: ${error.message}`); }
    finally { changingPause = false; pauseButton.disabled = false; paintTimeControls(); }
    if (!paused) openMic();
  }

  const onVisibility = () => {
    if (!document.hidden || paused || debriefed || destroyed) return;
    if (busy) pauseWhenIdle = true;
    else togglePause();
  };
  const onPageHide = () => destroy();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  // Total quiet sends no turn, so offer the interviewer the chance a real one would have.
  // Coding mocks get the same offer from the idle tick; it may still choose silence.
  function offerStepIn() {
    const now = Date.now();
    if (busy || timeControls.saving || draining || replyFailed || debriefed || !interviewId || changingPause || modeControl.pending || modeControl.saving || speaker?.speaking || candidateLoud || phrasesPending > 0 || input.value.trim()) return;
    if (now - lastActivity < STEP_IN_AFTER_MS || now - lastStepIn < STEP_IN_COOLDOWN_MS) return;
    lastStepIn = now;
    void runTurn('/api/design/turn', { interviewId, said: '', phase, elements, mode: mode === 'type' ? 'typed' : 'voice' }, { idle: true });
  }
  function paintClock() {
    const reading = mockTimeReading(minutes, paused ? pausedElapsed : startedAt ? Math.max(0, Date.now() - startedAt) : 0);
    clock.textContent = reading.text;
    timeControls.root.querySelector('button').setAttribute('aria-label', `${reading.text} ${reading.label}. Add time`);
    clock.classList.toggle('over', reading.remaining <= 0);
  }
  function tickClock() {
    paintClock(); paintTimeControls();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(() => {
      if (destroyed || !startedAt || paused) return;
      paintClock();
      offerStepIn();
    }, 1000);
  }

  /** The canvas changed. A cheap write, never a turn. */
  function onSceneChange(next) {
    elements = next; lastActivity = Date.now();
    if (!interviewId || debriefed) return;
    clearTimeout(sceneTimer);
    // Excalidraw fires this on every pointer move; one write per quiet second is plenty,
    // and the server drops the ones that mean nothing anyway.
    sceneTimer = setTimeout(() => { persistScene().catch(error => say(`Board save failed: ${error.message}`)); }, 1000);
  }
  function persistScene() {
    if (!interviewId || debriefed) return sceneWrites;
    const snapshot = structuredClone(elements), id = interviewId;
    // Older autosaves finish first. Branching awaits the latest captured board,
    // rather than racing an earlier in-flight request that could become last on disk.
    sceneWrites = sceneWrites.catch(() => {}).then(() => callJson('/api/design/scene', { interviewId: id, elements: snapshot }));
    return sceneWrites;
  }

  /* ---- layout ---- */

  const canvasHost = el('div', { class: 'dz-canvas ui-editor-surface' },
    el('div', { class: 'dz-loading mono', text: 'Loading the whiteboard…' }));
  const boardControls = boardTools(() => api);
  const livePhaseFilter = createSelect({ label: 'Transcript phase', value: '', options: [['', 'All phases'], ...PHASES], onChange: event => {
    for (const item of log.children) item.hidden = Boolean(event.target.value && item.dataset.phase !== event.target.value);
  } });
  const practise = practiseFromMock({ variant: 'secondary',  disabled: !interviewId, onClick: async event => {
    const button = event.currentTarget; button.disabled = true;
    try {
      clearTimeout(sceneTimer);
      if (interviewId && !debriefed) await persistScene();
      await startPracticeFromMock({ discipline: 'design', interviewId });
    } catch (error) { button.disabled = false; modeStatus.hidden = false; modeStatus.textContent = error.message; }
  } });

  const modelPicker = createCoachModelPicker({ compact: true });
  const composer = createComposer({ className: 'dz-compose ui-pane-controls', content: [typePanel, voicePanel], leading: [modelPicker.root, voiceLink], trailing: [typeActions], notices: [modeStatus, modeRetry] });
  const view = el('div', { class: 'dz-view ui-workspace' }, [
    screenHeader({ back: { onClick: onBack, label: 'Back to interviews', className: 'dz-back' }, crumb: 'Interviews', title: 'System design', meta: [level],
      status: timeControls.root, actions: { secondary: [pauseButton, doneButton, { label: 'Learning notes', onClick: async () => { if (!interviewId) return; try { const saved = await callJson(`/api/design/${interviewId}`); if (saved.topicSlug) openLearningNotes(saved.topicSlug, titleOf(saved)); else entry('d', 'No problem notes are associated with this interview.'); } catch (error) { entry('d', error.message); } } }], overflow: [practise] } }),
    el('div', { class: 'dz-split' }, [
      el('section', { class: 'ui-board-pane has-board-tools' }, [paneHeader({ title: 'Whiteboard', tools: boardControls }), canvasHost]),
      el('div', { class: 'dz-side ui-pane' }, [
        paneHeader({ title: 'Interview', tools: [livePhaseFilter] }),
        el('div', { class: 'dz-phase-actions' }, phaseBar),
        log,
        composer,
      ]),
    ]),
  ]);
  replace(host, view);

  const conversationView = bindConversation(log, { composer, onJump: () => { following = true; } });
  const disposeSplit = installPaneResizer(view.querySelector('.dz-split'), { storageKey: 'studio.workspace-split.design.v1', label: 'Whiteboard and interviewer' });
  const onKey = (e) => {
    if (e.key === 'Escape' && speaker?.speaking && !hasOpenOverlay() && claimActionKey(e)) interrupt();
  };
  window.addEventListener('keydown', onKey);

  // Dictation, reusing the control the coach panel already uses. Speech lands in the
  // box and is never auto-sent: pausing to think is not finishing a sentence, and an
  // interviewer that cuts in on a pause is worse than one that waits.
  //
  // getSlug returns '' on purpose. There is no problem slug here, and the ASR route
  // treats an empty one as "do not file a transcript" — which is right, because this
  // interview keeps its own record under design/<id>/. Passing null would serialise as
  // the string "null", which passes the slug check and would file into problems/null/.
  speaker = createSpeaker({
    onPlayback: value => voiceView.playback(value),
    onStateChange: (speaking) => {
      skipButton.hidden = !speaking;
      openMic();
      say(speaking ? 'speaking…' : isVoice() ? 'listening…' : '');
      paintVoice();
    },
  });

  try {
    voice = createVoiceControl({
      reportEmptyTake: false, maxTakeMs: 60 * 60000,
      onSettled: () => { if (modeDrain) { modeDrain = false; pendingDraft = Boolean(input.value.trim()); if (!destroyed) { paintDraft(); openMic(); } } },
      getSlug: () => '',
      logTakes: false,
      onState: (state) => {
        captureState = state;
        if (!isVoice() || destroyed) return;
        paintVoice();
      },
      onPreview: text => { partialWords = text; if (!destroyed) paintVoice(); },
      onTranscript: (text) => {
        if (destroyed) {
          if (interviewId) appendDraft('design:' + interviewId, text);
          return;
        }
        const gap = input.value === '' || /\s$/.test(input.value) ? '' : ' ';
        input.value += gap + text; inputSize.resize();
        writingDraft = true;
        try { if (interviewId) saveDraft('design:' + interviewId, input.value); }
        finally { writingDraft = false; }
        if (isVoice() && (speaker?.speaking || (busy && !speechInterrupted))) interrupt();
        // Preserve the explicit-send barrier while the final voice phrase drains.
        paintDraft();
        // In voice mode there is no text box on screen, so this is the only way to see
        // that the transcriber is keeping up with you.
        if (isVoice()) paintVoice();
      },
      // Going quiet is what ends a turn. The analyser already computes this signal for
      // cutting phrases; a turn just has a much longer fuse. See speech.js.
      onLevel: value => {
        voiceView.level(value); const {sinceLoud,pending} = value;
        candidateLoud = Boolean(value.loud); phrasesPending = pending || 0;
        if (candidateLoud) lastActivity = Date.now();
        if (isVoice() && !destroyed && !paused && candidateLoud && (speaker?.speaking || (busy && !speechInterrupted))) interrupt();
        if (!voiceView.automatic || replyFailed || voice.hasTranscriptionError() || !isVoice() || modeControl.pending || destroyed || pendingDraft) return;
        const decision = turnDecision({
          sinceLoud,
          chars: input.value.trim().length,
          speaking: Boolean(speaker?.speaking),
          busy: busy || timeControls.saving || draining,
          pending,
        });
        if (decision === 'send') answer();
      },
    });
    mountComposerDictation(composer, voice);
    micSlot.append(voice.root);
    voice.root.classList.add('voice-control--external-preview');
  } catch { /* typing still works */ }

  // Voice mode needs a mouth and an ear. Without either it is offered and then fails
  // silently, which is worse than not offering it.
  if (!speechSupported() || !voice) {
    const button = voiceLink;
    button.disabled = true;
    button.title = !voice
      ? 'This browser cannot record audio, so voice mode is unavailable.'
      : 'This browser has no speech synthesis, so the interviewer cannot talk.';
    const reason = el('p', { id: 'voice-unavailable', class: 'dim', text: button.title });
    button.setAttribute('aria-describedby', reason.id);
    voiceLink.after(reason);
  }

  applyMode(modeControl.value);

  /* ---- boot ---- */

  (async () => {
    try {
      const ex = await loadExcalidraw();
      if (destroyed) return;
      boardRoot = ex.createRoot(canvasHost);
      canvasHost.querySelector('.dz-loading')?.remove();
      boardRoot.render(ex.createElement(ex.Excalidraw, {
        theme: document.body.classList.contains('is-dark') ? 'dark' : 'light',
        excalidrawAPI: (instance) => { api = instance; bindTools(); },
        onChange: (next, appState) => { boardControls.sync(appState?.zoom?.value); onSceneChange(next); },
        // Resuming means finding the room as you left it, so the saved scene is the
        // board's starting state rather than something drawn back onto an empty one.
        initialData: elements.length ? { elements, scrollToContent: true } : null,
        UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, export: false } },
      }));
    } catch (error) {
      replace(canvasHost, el('div', { class: 'dz-loading mono' }, [
        'The whiteboard could not be loaded from web/vendor/excalidraw. ',
        'Run ', el('code', { text: 'node scripts/vendor-excalidraw.mjs' }), '. ',
        'The interview still works — describe the design in words.',
      ]));
    }

    if (destroyed) return;

    if (resumed) {
      // Everything that was said, back in the log, before the candidate is invited to
      // add to it. The clock is already shifted by the server, so it reads as time spent.
      replaying = true;
      replayTurns(resumed.turns, (kind, text, elapsedMs) => entry(kind, text, elapsedMs), log, resumed.startedAt);
      replaying = false; lastEntryPhase = resumed.turns?.at(-1)?.phase || phase;
      if (resumed.rebuilt) {
        // Said plainly: the model that answers next did not ask these questions. It is
        // reading the transcript above, same as the candidate can, not remembering it.
        log.append(el('div', { class: 'dz-cut mono', text:
          'Continues from the saved transcript.' }));
      }
      log.scrollTop = log.scrollHeight;
      tickClock();
      pauseButton.disabled = false;
      say(isVoice() ? 'listening…' : '');
      input.focus();
      openMic();
      return;
    }

    // The browser check mounts this screen to prove the board loads from disk. It must
    // not start an interview to do that — that would reach the real CLI and spend a turn.
    if (new URLSearchParams(location.search).has('nointerview')) {
      say('ready');
      return;
    }
    await runTurn('/api/design/start', { level, minutes, prompt, problemSlug, requestId, mode: mode === 'type' ? 'typed' : 'voice' });
    input.focus();
  })();

  function destroy() {
      if (destroyed) return;
      destroyed = true;
      disposeSplit(); conversationView.dispose();
      inputSize.dispose(); modelPicker.dispose(); unwatchDraft(); timeControls.dispose();
      clearTimeout(sceneTimer);
      if (clockTimer) clearInterval(clockTimer);
      if (turnTimer) clearInterval(turnTimer);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      // Leaving the screen must silence it. A voice still reading a question from a
      // page you have navigated away from is the worst bug this feature could have.
      unbindTools(); modeControl.dispose(); replySpeech?.cancel(); speaker?.dispose?.();
      voice?.dispose?.({ finish: true });
      // Stop the clock on the way out. Without this an interview left open overnight
      // comes back eighteen hours in, past the end of its own phase machine.
      if (interviewId && !debriefed && !paused) {
        const body = JSON.stringify({ interviewId });
        const sent = navigator.sendBeacon?.('/api/design/pause', new Blob([body], { type: 'application/json' }));
        if (!sent) {
          fetch('/api/design/pause', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true,
          }).catch(() => { /* the clock is the only casualty */ });
        }
      }
      stopTheme();
      boardRoot?.unmount();
      boardRoot = null;
      api = null;
  }
  return { destroy };
}

/* ---------------- the route ---------------- */

/**
 * The design route. Opens on the library unless a particular interview was asked for,
 * either by argument or by the `#/design/<id>` hash this reads for itself.
 */
export function initDesign(host, { level = 'L4', minutes = 45, interviewId = null } = {}) {
  const route = location.hash.split('/');
  if (route[2] === 'practice') return initPractice(host, { slug: route[3], id: route[4] });
  let screen = null;
  let gone = false;

  function swap(build) {
    screen?.destroy?.();
    screen = null;
    if (gone) return;
    screen = build();
  }

  function showLibrary() {
    swap(() => mountLibrary(host, { onNew: startNew, onOpen: open }));
  }

  function startNew(options = {}) {
    swap(() => mountInterview(host, { level, minutes, ...options, onBack: showLibrary }));
  }

  function waiting(text) {
    replace(host, el('div', { class: 'dzl' }, el('div', { class: 'dzl-empty mono', text })));
    return { destroy() {} };
  }

  function failed(message) {
    replace(host, el('div', { class: 'dzl' }, el('div', { class: 'dzl-empty' }, [
      message, ' ',
      el('button', { class: 'btn btn--quiet linkbtn', type: 'button', text: 'Back to all interviews', onclick: showLibrary }),
    ])));
    return { destroy() {} };
  }

  /** Open one interview: resume it if it can still be continued, otherwise read it. */
  async function open(id) {
    swap(() => waiting('Opening the interview…'));
    let detail;
    try {
      detail = await callJson(`/api/design/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!gone) swap(() => failed(`That interview could not be opened. ${error.message}`));
      return;
    }
    if (gone) return;

    if (!detail.resumable) {
      swap(() => mountReview(host, detail, { onBack: showLibrary }));
      return;
    }

    let resumed;
    try {
      // Resume before mounting: it is the call that shifts the clock, and a screen that
      // painted first would spend its first seconds showing yesterday's elapsed time.
      resumed = await callJson('/api/design/resume', { interviewId: id });
    } catch (error) {
      if (!gone) swap(() => failed(`That interview could not be resumed. ${error.message}`));
      return;
    }
    if (gone) return;
    swap(() => mountInterview(host, { level, minutes, resumed, onBack: showLibrary }));
  }

  const wanted = interviewId ?? designIdFromHash();
  // `?nointerview=1` is the browser check's hook (scripts/check-design.mjs): mount the
  // interview screen, with its whiteboard, without starting a turn. It skips the library
  // because what that check exists to prove is that 8 MB of vendored Excalidraw really
  // loads from disk, and the library does not load it.
  if (!wanted && new URLSearchParams(location.search).has('nointerview')) startNew();
  else if (wanted) open(wanted);
  else showLibrary();

  return {
    destroy() {
      gone = true;
      screen?.destroy?.();
      screen = null;
    },
  };
}
