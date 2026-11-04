import { createComposer, composerSend, bindComposerInput } from './ui/composer.js';
import { bindBoardTools, showWorkspaceAction } from './workspace-tools.js';
import { loadExcalidraw } from './whiteboard.js';
import { createPracticeLauncher, initPractice, startPracticeFromMock } from './practice.js';
import { openLearningNotes } from './learning.js';
import { createLearnerSummary } from './learner.js';
import { createInterviewSetup } from './interview.js';
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
import { installPaneResizer } from './ui/split-pane.js';
import { openReport } from './interview-report.js';
import { streamInterviewRequest } from './interview-transport.js';
import { onSettingsChange } from './settings.js';
import { createSelect } from './ui/select.js';
import { when } from './history.js';
import { createSpeechStream } from './speech-stream.js';
import { createVoicePanel } from './ui/voice-panel.js';
import { createVoiceControl } from './voice.js';
import { createSpeaker, turnDecision, speechSupported } from './speech.js';
import { designDraftNotice } from './design-draft.js';
import { readDraft, saveDraft, clearDraft, appendDraft, watchDraft } from './drafts.js';

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
  const bits = [];
  bits.push(item.startedAt ? when(item.startedAt) : 'date not recorded');
  if (item.level) bits.push(item.level);
  bits.push(countLabel(item.turns));
  bits.push(item.debriefed ? 'debriefed' : 'no debrief');
  return bits.join('  ·  ');
}

/** Put the transcript back on screen, in the order it was said. */
function replayTurns(turns, entry, log) {
  for (const turn of turns ?? []) {
    if (turn.kind === 'tool_action') { if (log) showWorkspaceAction(log, turn.action, { replay: true }); continue; }
    if (turn.kind === 'debrief') {
      if (turn.asked) entry('d', turn.asked.trim().startsWith('{') ? 'Report ready.' : turn.asked);
      continue;
    }
    if (turn.said) entry('a', turn.said);
    if (turn.asked) entry('q', turn.asked);
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
 * Every interview there has ever been, newest first.
 *
 * The list endpoint cannot say whether an unfinished interview can actually be picked
 * back up — that depends on a CLI thread only GET /api/design/:id knows about. So rows
 * are painted at once with "Open", which is true of every interview, and the unfinished
 * ones are upgraded to "Resume" as each detail call comes back. At no instant does a row
 * offer something that would fail.
 */
function mountLibrary(host, { onNew, onOpen }) {
  let gone = false;

  const list = el('div', { class: 'dzl-list' });
  const newButton = el('button', {
    class: 'dzl-new', type: 'button', text: 'Start a new mock', onclick: () => { setup.hidden = false; newButton.hidden = true; topicSelect.focus(); },
  });
  const topicSelect = createSelect({ label: 'System design problem', value: '', options: [['', 'Choose for me · unseen'], ['Design a URL-shortening service.', 'URL shortener'], ['Design a messaging service for one-to-one conversations.', 'Messaging'], ['Design a cloud file-storage service.', 'File storage'], ['Design a personalized news-feed service.', 'News feed']] });
  const mock = createInterviewSetup({ slug: 'design-new-mock', discipline: 'design', label: 'A mock shaped by your practice', startLabel: 'Begin interview', onStart: async state => {
    const problem = topicSelect.value ? null : (await callJson('/api/mock/prepare', { discipline: 'design', targetLevel: state.targetLevel, minutes: state.minutes, requestId: state.startRequestId })).problem;
    if (!gone) onNew({ level: state.targetLevel, minutes: state.minutes, answerMode: state.mode, prompt: problem?.statement || topicSelect.value, problemSlug: problem?.slug, requestId: state.startRequestId });
  } });
  const learner = createLearnerSummary('design');
  const practice = createPracticeLauncher({ discipline: 'design', problems: [
    { slug: 'design-url-shortener', title: 'URL shortener', statement: 'Design a URL-shortening service.' },
    { slug: 'design-messaging', title: 'Messaging', statement: 'Design a messaging service for one-to-one conversations.' },
    { slug: 'design-file-storage', title: 'File storage', statement: 'Design a cloud file-storage service.' },
    { slug: 'design-news-feed', title: 'News feed', statement: 'Design a personalized news-feed service.' },
  ] });
  const setup = el('div', { class: 'dz-setup ui-stack', hidden: true }, [
    el('h2', { text: 'Set up your interview' }),
    el('p', { text: 'Let the interviewer choose a fresh problem using your history, or pick a specific topic.' }),
    topicSelect, mock.root,
    el('button', { class: 'btn btn--quiet', type: 'button', text: 'Cancel', onclick: () => { setup.hidden = true; newButton.hidden = false; newButton.focus(); } }),
  ]);

  const view = el('div', { class: 'dzl' }, [
    el('div', { class: 'dzl-head' }, [
      el('div', {}, [
        el('div', { class: 'mono dzl-kicker', text: 'System design' }),
        el('div', { class: 'dzl-lede', text: 'Your interviews, saved. Pick one up where you left it, or read one back.' }),
      ]),
      el('span', { class: 'spacer' }),
      newButton,
    ]),
    setup, practice.root, learner.root,
    list,
  ]);
  replace(host, view);

  replace(list, el('div', { class: 'dzl-empty mono', text: 'Looking for past interviews…' }));

  function row(item) {
    const action = el('button', {
      class: 'dzl-go', type: 'button', text: item.debriefed ? 'Open' : 'Read',
      title: item.debriefed ? 'Read the transcript and the board' : 'Read what there is so far',
      onclick: () => onOpen(item.id),
    });
    const note = el('div', { class: 'dzl-note', hidden: true });
    const node = el('div', { class: 'dzl-row ui-inset ui-inset--roomy ui-cluster' }, [
      el('div', { class: 'dzl-main ui-cluster-content' }, [
        el('div', { class: 'dzl-title', text: titleOf(item) }),
        el('div', { class: 'mono dzl-meta', text: metaOf(item) }),
        note,
      ]),
      el('div', { class: 'ui-cluster' }, [item.topicSlug ? el('button', { class: 'btn btn--quiet', text: 'Learning notes', onclick: () => openLearningNotes(item.topicSlug, titleOf(item)) }) : null,
        el('button', { class: 'btn btn--quiet', text: 'Practise from this mock', onclick: async event => {
          const button = event.currentTarget; button.disabled = true;
          try { await startPracticeFromMock({ discipline: 'design', slug: item.topicSlug, interviewId: item.id }); }
          catch (error) { note.hidden = false; note.textContent = error.message; button.disabled = false; }
        } }), action]),
    ]);
    return { node, action, note };
  }

  (async () => {
    let interviews;
    try {
      ({ interviews } = await callJson('/api/design'));
    } catch (error) {
      if (gone) return;
      replace(list, el('div', { class: 'dzl-empty' }, [
        'The saved interviews could not be read. ', error.message,
      ]));
      return;
    }
    if (gone) return;

    const items = [...(interviews ?? [])].reverse();   // the store lists oldest first
    if (!items.length) {
      replace(list, el('div', { class: 'dzl-empty' },
        'No interviews yet. Choose a problem to start your first interview.'));
      return;
    }

    const rows = items.map((item) => ({ item, ...row(item) }));
    replace(list, rows.map((r) => r.node));

    // Only the unfinished ones need asking about, and only the recent ones are plausibly
    // still resumable — a thread the CLI forgot months ago is not worth a round trip.
    for (const r of rows.filter((x) => !x.item.debriefed).slice(0, 20)) {
      if (gone) return;
      let detail;
      try { detail = await callJson(`/api/design/${encodeURIComponent(r.item.id)}`); } catch { continue; }
      if (gone) return;
      if (detail.resumable) {
        r.action.textContent = 'Resume';
        r.action.classList.add('on');
        r.action.title = 'Carry on from where you stopped — the clock picks up too';
        if (detail.rebuilt) {
          // The thread that asked these questions is gone; a new one reads the
          // transcript instead. True either way, so it is said either way.
          r.note.hidden = false;
          r.note.textContent = 'Continues from the saved transcript.';
        }
      } else {
        // Only reachable if it was debriefed between the list call and this one — a
        // race, not a dead thread. The row already says "debriefed" in its meta line.
        r.note.hidden = false;
        r.note.textContent = 'Finished while this list was loading — open it to read the debrief.';
      }
    }
  })();

  return { destroy() { gone = true; topicSelect.dispose(); mock.dispose(); learner.dispose(); practice.dispose(); } };
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

  const entry = (kind, text) => {
    log.append(el('div', { class: `dz-entry dz-${kind}` }, [
      el('span', { class: 'mono dz-who', text: kind === 'q' ? 'Interviewer' : kind === 'a' ? 'You' : 'Debrief' }),
      el('div', { class: 'dz-body', text }),
    ]));
  };

  if (!data.turns?.length) {
    log.append(el('div', { class: 'dzl-empty' },
      'Nothing was said in this interview — it was closed before the first question.'));
  } else {
    replayTurns(data.turns, entry, log);
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

  const canvasHost = el('div', { class: 'dz-canvas ui-editor-surface' },
    el('div', { class: 'dz-loading mono', text: 'Loading the board…' }));

  const view = el('div', { class: 'dz-view ui-workspace' }, [
    el('div', { class: 'dz-bar' }, [
      el('button', { class: 'dz-back linkbtn', type: 'button', text: '← Interviews', onclick: () => onBack() }),
      el('span', { class: 'mono dz-title dzr-prompt', text: titleOf(data) }),
      data.topicSlug ? el('button', { class: 'btn btn--quiet', text: 'Learning notes', onclick: () => openLearningNotes(data.topicSlug, titleOf(data)) }) : null,
      el('button', { class: 'btn btn--secondary', text: 'Practise from this mock', onclick: async event => {
        const button = event.currentTarget; button.disabled = true;
        try { await startPracticeFromMock({ discipline: 'design', slug: data.topicSlug, interviewId: data.id }); }
        catch (error) { button.disabled = false; entry('d', error.message); }
      } }),
      data.report ? el('button', { class: 'btn btn--secondary', text: 'View report', onclick: () => showDesignReport(data.id, log).catch(error => entry('d', error.message)) }) : null,
      el('span', { class: 'spacer' }),
      el('span', { class: 'mono dim', text: metaOf({ ...data, turns: data.turns?.length ?? 0 }) }),
    ]),
    el('div', { class: 'dz-split' }, [
      canvasHost,
      el('div', { class: 'dz-side ui-pane' }, [
        el('div', { class: 'dz-phases' }, el('span', { class: 'dz-phase', 'aria-pressed': 'true',
          text: PHASE_LABELS.get(data.phase) ?? 'Read-only' })),
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

  return { destroy() { gone = true; stopTheme(); root?.unmount(); root = null; boardApi = null; } };
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
  const clock = el('span', { class: 'mono dz-clock', text: '00:00' });
  const pauseButton = el('button', { class: 'dz-pause', type: 'button', text: 'Pause',
    title: 'Pause the timer and microphone without ending your interview', disabled: true, onclick: () => togglePause() });
  const phaseBar = el('div', { class: 'dz-phases', role: 'group', 'aria-label': 'Interview phase' }, PHASES.map(([id, label]) =>
    el('button', {
      class: 'dz-phase', type: 'button', dataset: { phase: id },
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
    class: 'dz-input', rows: '3', placeholder: 'Explain your approach, assumptions, and trade-offs…',
    'aria-label': 'Your answer',
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); answer(); }
    },
  });
  let pendingRequest = null;
  const rememberRequest = value => { pendingRequest = value; if (interviewId) { const key = 'design-request:' + interviewId; value ? localStorage.setItem(key, JSON.stringify(value)) : localStorage.removeItem(key); } };
  try { pendingRequest = JSON.parse(localStorage.getItem('design-request:' + resumed?.id)); } catch { /* no saved request */ }
  const draft = readDraft(resumed?.id ? 'design:' + resumed.id : '');
  if (draft?.text) input.value = draft.text;
  input.addEventListener('input', () => { if (interviewId) saveDraft('design:' + interviewId, input.value); });

  const inputSize = bindComposerInput(input);
  const sendButton = composerSend(el('button', { class: 'dz-send', type: 'button', onclick: () => answer() }));

  const micSlot = el('span', { class: 'dz-mic' });
  const status = el('div', { class: 'dz-status mono', role: 'status', text: '' });

  // The switch. Always visible, because the moment you want it is the moment voice
  // has just mangled a term and you need to type the correction — hunting for a
  // control then is worse than one control that is always there.
  const modeSwitch = el('div', { class: 'dz-modes', role: 'radiogroup', 'aria-label': 'How you answer' }, [
    ['type', 'Type'], ['voice', 'Voice'],
  ].map(([id, label]) => el('button', {
    class: 'dz-mode', type: 'button', role: 'radio', dataset: { mode: id },
    'aria-checked': String(id === 'type'), tabindex: id === 'type' ? '0' : '-1', text: label,
    onkeydown: (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'type' : event.key === 'End' ? 'voice' : id === 'type' ? 'voice' : 'type';
      const button = modeSwitch.querySelector(`[data-mode="${next}"]`);
      if (!button.disabled) { setMode(next); button.focus(); }
    },
    onclick: () => setMode(id),
  })));

  // Interrupting has to be deliberate: the microphone is shut while it talks, so it
  // cannot hear you cut in. One key is the honest substitute for talking over someone.
  const skipButton = el('button', {
    class: 'dz-skip', type: 'button', hidden: true, text: 'Interrupt',
    title: 'Stop the interviewer and start answering (Esc)',
    onclick: () => interrupt(),
  });

  /** What voice mode shows instead of a text box: state, and your words as they land. */
  let captureState = 'idle', partialWords = '', speechInterrupted = false;
  const voiceView = createVoicePanel({ onEdit: () => setMode('type'), onReplay: text => { pendingDraft = Boolean(input.value.trim()) || Boolean(voice?.isBusy()); closeMic(); speaker?.say(text); } });
  let pendingDraft = Boolean(input.value.trim());
  const draftTail = el('span', { class: 'dz-draft-tail' });
  const draftSend = el('button', { class: 'dz-send', type: 'button', text: 'Send', onclick: () => answer() });
  const draftNotice = el('div', { class: 'dz-draft dz-cut mono', hidden: true }, [
    draftTail, draftSend,
    el('button', { class: 'dz-skip', type: 'button', text: 'Edit', onclick: () => setMode('type') }),
  ]);
  function paintDraft() {
    const notice = designDraftNotice({ text: input.value, pending: pendingDraft, mode });
    draftNotice.hidden = !notice.visible;
    draftTail.textContent = notice.tail;
    draftTail.title = input.value.trim();
    micSlot.hidden = isVoice() && !draftNotice.hidden;
    // The mic is held shut until the recovered answer is sent or edited, so going quiet sends nothing.
    voiceView.update({state: captureState, draft: input.value, partial: partialWords, busy, sending: draining, paused});
    draftSend.disabled = busy || draining || modeControl.saving || paused || changingPause;
  }
  let writingDraft = false;
  const unwatchDraft = interviewId ? watchDraft('design:' + interviewId, text => {
    if (writingDraft) return;
    input.value = text; inputSize.resize();
    pendingDraft = Boolean(text.trim());
    if (pendingDraft && isVoice()) closeMic();
    paintDraft();
  }) : () => {};
  const sendVoice = el('button', {class:'btn btn--primary btn--sm',type:'button',text:'Send',onclick:()=>answer()});
  const voicePanel = el('div', { class: 'dz-voice', hidden: true }, [
    voiceView.root,
    draftNotice,
    el('div', { class: 'dz-vrow' }, [
      skipButton,
      el('span', { class: 'spacer' }),
      sendVoice,
    ]),
  ]);
  const typePanel = el('div', { class: 'dz-type' }, input);
  const typeActions = el('div', { class: 'dz-actions' }, [micSlot, status, sendButton]);

  function paintVoice(label, tone = '') {
    voiceView.update({state: captureState, draft: input.value, partial: partialWords, busy, sending: draining, paused});
    sendVoice.hidden = !input.value.trim() || pendingDraft || Boolean(speaker?.speaking);
    sendVoice.disabled = busy || draining || paused || modeControl.pending;
  }

  function setMode(next) { if (!debriefed && !destroyed && !finishing) modeControl.select(next === 'voice' ? 'voice' : 'typed'); }
  function applyMode(next) {
    mode = next === 'voice' ? 'voice' : 'type';
    for (const b of modeSwitch.querySelectorAll('.dz-mode')) {
      b.setAttribute('aria-checked', String(b.dataset.mode === mode));
      b.tabIndex = b.dataset.mode === mode ? 0 : -1;
    }
    typePanel.hidden = isVoice(); typeActions.hidden = isVoice(); voicePanel.hidden = !isVoice(); inputSize.resize();
    modeDrain = Boolean(voice?.isBusy());
    pendingDraft = pendingDraft || Boolean(input.value.trim()) || modeDrain;
    voice?.stop(); speechInterrupted = true; replySpeech?.cancel(); speaker?.cancel();
    paintDraft();
    if (isVoice()) { voicePanel.append(micSlot); paintVoice(pendingDraft ? 'Unsent answer — send or edit' : 'Microphone off'); }
    else { typeActions.prepend(micSlot); say(''); input.focus(); }
  }
  const modeStatus = el('span', { class: 'dim', role: 'status', hidden: true });
  const modeRetry = el('button', { class: 'btn btn--quiet', text: 'Retry saving mode', hidden: true, onclick: () => modeControl.retry() });
  const modeControl = createInterviewMode({ initial: resumed ? resumed.mode || 'typed' : answerMode,
    ready: () => Boolean(interviewId) && !busy && !draining && !destroyed && !debriefed && !changingPause,
    save: mode => callJson('/api/design/mode', { interviewId, mode }),
    onSelect: applyMode,
    onStatus: state => {
      modeStatus.hidden = !state.pending; modeStatus.textContent = state.error ? 'Mode changed here; saving failed.' : 'Saving answer mode…';
      modeRetry.hidden = !state.error;
      paintDraft();
      sendButton.disabled = busy || draining || state.saving || paused || changingPause;
      doneButton.disabled = busy || draining || state.saving || paused || changingPause || !interviewId;
      if (!state.pending) openMic();
    },
  });

  function interrupt() {
    speechInterrupted = true; replySpeech?.cancel(); speaker?.cancel();
    openMic();
  }

  function openMic() {
    if (!isVoice() || !interviewId || modeControl.pending || destroyed || busy || draining || debriefed || paused || changingPause || designDraftNotice({ text: input.value, pending: pendingDraft, mode }).blocksMic) return;
    if (speaker?.speaking) return;
    void speaker?.prepare();
    try { voice?.start?.(); } catch { /* the button still works */ }
  }

  function closeMic() {
    try { if (voice?.isRecording?.()) voice.stop(); } catch { /* noop */ }
  }
  async function drainMic() {
    draining = true; closeMic(); paintDraft(); sendButton.disabled = true;
    try {
      const deadline = Date.now() + 65000;
      while (voice?.isBusy() && !destroyed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (voice?.isBusy()) { say('Still transcribing your last words. Send again when they appear.'); return false; }
      if (voice?.hasTranscriptionError()) { say('Retry or discard the failed audio before sending.'); return false; }
      return !destroyed;
    } finally { draining = false; if (!destroyed) { paintDraft(); sendButton.disabled = busy || paused; } }
  }
  const doneButton = el('button', {
    class: 'dz-done', type: 'button', text: 'Done — debrief me',
    onclick: () => finish(),
  });

  function say(what) { status.textContent = what; }

  /** One entry in the transcript. Returns the node so tokens can stream into it. */
  function entry(kind, text = '') {
    const body = el('div', { class: 'dz-body', text });
    const node = el('div', { class: `dz-entry dz-${kind}` }, [
      el('span', { class: 'mono dz-who', text: kind === 'q' ? 'Interviewer' : kind === 'a' ? 'You' : 'Debrief' }),
      body,
    ]);
    log.append(node);
    log.scrollTop = log.scrollHeight;
    return body;
  }

  /* ---- turns ---- */

  async function runTurn(url, body, { kind = 'q' } = {}) {
    if (busy || modeControl.saving || destroyed || debriefed || paused || changingPause) return false;
    busy = true; speechInterrupted = false; replySpeech = createSpeechStream(speaker);
    paintDraft();
    pauseButton.disabled = true;
    practise.disabled = true;
    sendButton.disabled = true;
    doneButton.disabled = true;
    say('thinking…');
    if (isVoice()) paintVoice('Thinking…', 'think');
    const target = entry(kind);
    let cut = false;
    let succeeded = false;
    let failed = false;
    try {
      await streamPost(url, body, {
        onToken: (text) => {
          if (destroyed) return;
          const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
          target.textContent = kind === 'd' ? 'Writing your report…' : target.textContent + text;
          if (follow) log.scrollTop = log.scrollHeight;
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
            voiceView.sent(body.said);
            if (input.value.trim() === body.said) {
              input.value = ''; inputSize.resize(); clearDraft('design:' + interviewId); pendingDraft = false; paintDraft();
            }
          } else if (name === 'done') {
            succeeded = !payload.broke && !payload.stoppedReason;
            if (kind === 'd' && succeeded) target.textContent = 'Report ready.';
          } else if (name === 'phase' && PHASE_LABELS.has(payload.phase)) {
            phase = payload.phase; paintPhases();
          } else if (name === 'broke-character') {
            // Said out loud rather than swallowed. The turn is about to end short and
            // the candidate deserves the real reason.
            cut = true;
          } else if (name === 'error') {
            failed = true;
            target.textContent = payload.message;
            target.closest('.dz-entry')?.classList.add('dz-err');
          }
        },
      });
      if (cut) {
        const note = el('div', { class: 'dz-cut mono' },
          target.textContent.trim()
            ? 'The interviewer started writing your answer, so the turn was cut there. The question above stands.'
            : 'The interviewer started writing your answer, so the turn was cut. Say something and it will ask again.');
        target.after(note);
      }
      if (!succeeded && !failed) {
        failed = true;
        target.closest('.dz-entry')?.classList.add('dz-err');
        target.textContent += '\nThe connection ended before this turn finished. Your interview is still open.';
      }
      if (!target.textContent.trim() && !cut) target.textContent = 'No response was received.';
      if (kind !== 'd' && succeeded) voiceView.reply(target.textContent);
      if (!destroyed && !speechInterrupted && isVoice() && kind !== 'd') replySpeech.finish();
    } catch (error) {
      replySpeech?.cancel();
      failed = true;
      target.textContent = error.message;
      target.closest('.dz-entry')?.classList.add('dz-err');
    } finally {
      busy = false;
      paintDraft();
      sendButton.disabled = false;
      doneButton.disabled = paused;
      pauseButton.disabled = !interviewId || debriefed;
      practise.disabled = !interviewId;
      void modeControl.flush();
      if (pauseWhenIdle) { pauseWhenIdle = false; if (!paused && !destroyed) togglePause(); }
      say(isVoice() ? (speaker?.speaking ? 'speaking…' : 'listening…') : '');
      // If it is still talking the speaker's own state change reopens the microphone;
      // if it never spoke, nothing else will.
      if (isVoice() && kind !== 'd' && !speaker?.speaking) openMic();
    }
    if (succeeded && !failed && body.requestId === pendingRequest?.requestId) rememberRequest(null);
    if (failed && !destroyed) target.after(el('button', { class: 'btn btn--quiet', text: 'Retry response', onclick: async event => {
      event.currentTarget.disabled = true;
      if (kind === 'd') await finish(); else await runTurn(url, body, { kind });
    } }));
    return succeeded && !failed;
  }

  async function answer() {
    if (!interviewId || busy || draining || modeControl.saving || debriefed || destroyed || paused || changingPause) return;
    if (!(await drainMic())) return;
    await modeControl.flush();
    const said = input.value.trim();
    if (/^(?:done|i['’]?m done)[.!]?$/i.test(said)) { await finish(); return; }
    const request = pendingRequest?.said === said ? pendingRequest : { said, requestId: crypto.randomUUID() };
    if (said && request !== pendingRequest) entry('a', said);
    rememberRequest(request);
    // Clear only on server acceptance. A network failure before acceptance keeps the draft.
    if (isVoice()) paintVoice('Thinking…', 'think');
    await runTurn('/api/design/turn', { interviewId, ...request, phase, elements, mode: mode === 'type' ? 'typed' : 'voice' });
  }

  async function finish() {
    if (!interviewId || busy || draining || modeControl.saving || debriefed || destroyed || paused || changingPause) return;
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
    closeMic();
    speaker?.cancel();
    view.querySelector('.dz-compose').hidden = true;
    phaseBar.querySelectorAll('button').forEach(button => { button.disabled = true; });
    api?.updateScene({ appState: { viewModeEnabled: true } });
    doneButton.disabled = true;
    doneButton.textContent = 'View report';
    doneButton.disabled = false;
    doneButton.onclick = () => showDesignReport(interviewId, log).catch(error => say(error.message));
    await showDesignReport(interviewId, log).catch(error => say(error.message));
    pauseButton.hidden = true;
    if (clockTimer) clearInterval(clockTimer);
  }

  function paintPaused() {
    paintDraft();
    pauseButton.textContent = paused ? 'Resume' : 'Pause';
    pauseButton.setAttribute('aria-label', paused ? 'Resume interview' : 'Pause interview');
    pauseButton.setAttribute('aria-pressed', String(paused));
    clock.classList.toggle('paused', paused);
    clock.title = paused ? 'Interview paused — time away is not counted' : 'Active interview time';
    input.disabled = paused;
    sendButton.disabled = paused || busy;
    doneButton.disabled = paused || busy;
    modeSwitch.querySelectorAll('button').forEach(button => {
      button.disabled = paused || (button.dataset.mode === 'voice' && (!speechSupported() || !voice));
    });
    phaseBar.querySelectorAll('button').forEach(button => { button.disabled = paused; });
    if (voice) voice.root.hidden = paused;
    api?.updateScene({ appState: { viewModeEnabled: paused } });
    say(paused ? 'Paused' : '');
    if (isVoice() && paused) paintVoice('Paused');
  }

  async function togglePause() {
    if (!interviewId || busy || changingPause || destroyed || debriefed) return;
    changingPause = true;
    pauseButton.disabled = true;
    closeMic(); replySpeech?.cancel(); speaker?.cancel();
    try {
      if (paused) {
        const result = await callJson('/api/design/resume', { interviewId });
        startedAt = Date.parse(result.startedAt);
        paused = false;
      } else {
        const result = await callJson('/api/design/pause', { interviewId });
        paused = true;
        const seconds = Math.floor(result.spentMs / 1000);
        clock.textContent = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
      }
      if (!destroyed) paintPaused();
    } catch (error) { say(`Could not ${paused ? 'resume' : 'pause'}: ${error.message}`); }
    finally { changingPause = false; pauseButton.disabled = false; }
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

  let deadlineAttempted = false;
  function tickClock() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(() => {
      if (destroyed || !startedAt || paused) return;
      const s = Math.floor((Date.now() - startedAt) / 1000);
      clock.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      clock.classList.toggle('over', s > minutes * 60);
      if (s >= minutes * 60 && !deadlineAttempted && !busy && !debriefed) { deadlineAttempted = true; finish().catch(error => say(error.message)); }
    }, 1000);
  }

  /** The canvas changed. A cheap write, never a turn. */
  function onSceneChange(next) {
    elements = next;
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
  const practise = el('button', { class: 'btn btn--quiet', text: 'Practise from this mock', disabled: !interviewId, onclick: async event => {
    const button = event.currentTarget; button.disabled = true;
    try {
      clearTimeout(sceneTimer);
      if (interviewId && !debriefed) await persistScene();
      await startPracticeFromMock({ discipline: 'design', interviewId });
    } catch (error) { button.disabled = false; modeStatus.hidden = false; modeStatus.textContent = error.message; }
  } });

  const view = el('div', { class: 'dz-view ui-workspace' }, [
    el('div', { class: 'dz-bar' }, [
      el('button', { class: 'dz-back linkbtn', type: 'button', text: '← Interviews',
        title: 'Leave this interview open and go back — the clock stops', onclick: () => onBack() }),
      el('span', { class: 'mono dz-title', text: 'System design' }),
      el('span', { class: 'mono dim', text: level }),
      clock,
      pauseButton,
      practise,
      el('span', { class: 'spacer' }),
      doneButton,
    ]),
    el('div', { class: 'dz-split' }, [
      canvasHost,
      el('div', { class: 'dz-side ui-pane' }, [
        el('div', { class: 'dz-panel-heading ui-toolbar' }, [
          el('strong', { text: 'Interview' }),
          el('span', { text: 'Board included with each answer' }),
        ]),
        phaseBar,
        log,
        createComposer({ className: 'dz-compose ui-pane-controls', content: [typePanel, voicePanel], leading: [modeSwitch], trailing: [typeActions], notices: [modeStatus, modeRetry] }),
      ]),
    ]),
  ]);
  replace(host, view);

  const disposeSplit = installPaneResizer(view.querySelector('.dz-split'), { storageKey: 'studio.workspace-split.design.v1', label: 'Whiteboard and interviewer' });
  const onKey = (e) => {
    if (e.key === 'Escape' && speaker?.speaking) { e.preventDefault(); interrupt(); }
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
      if (speaking) {
        // Shut the microphone while it talks. Echo cancellation helps, but a loop where
        // the interviewer transcribes its own question as your answer is not a risk
        // worth taking for the sake of shouting over it.
        closeMic();
        say('speaking…');
      } else if (isVoice() && !busy) {
        openMic();
        say('listening…');
      }
    },
  });

  try {
    voice = createVoiceControl({
      onSettled: () => { if (modeDrain) { modeDrain = false; pendingDraft = Boolean(input.value.trim()); if (!destroyed) { paintDraft(); openMic(); } } },
      getSlug: () => '',
      logTakes: false,
      onState: (state) => {
        captureState = state;
        if (!isVoice() || destroyed) return;
        const labels = { opening: 'Allow microphone access…', recording: 'Listening…', working: 'Transcribing…', idle: 'Microphone off' };
        paintVoice(labels[state] || 'Microphone off', state === 'recording' ? 'listen' : '');
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
        // Preserve the explicit-send barrier while the final voice phrase drains.
        paintDraft();
        // In voice mode there is no text box on screen, so this is the only way to see
        // that the transcriber is keeping up with you.
        if (isVoice()) paintVoice(speaker?.speaking ? 'Speaking…' : 'Listening…');
      },
      // Going quiet is what ends a turn. The analyser already computes this signal for
      // cutting phrases; a turn just has a much longer fuse. See speech.js.
      onLevel: value => {
        voiceView.level(value); const {sinceLoud,pending} = value;
        if (!voiceView.automatic || voice.hasTranscriptionError() || !isVoice() || modeControl.pending || destroyed || pendingDraft) return;
        const decision = turnDecision({
          sinceLoud,
          chars: input.value.trim().length,
          speaking: Boolean(speaker?.speaking),
          busy: busy || draining,
          pending,
        });
        if (decision === 'send') { closeMic(); answer(); }
      },
    });
    micSlot.append(voice.root);
    voice.root.classList.add('voice-control--external-preview');
  } catch { /* typing still works */ }

  // Voice mode needs a mouth and an ear. Without either it is offered and then fails
  // silently, which is worse than not offering it.
  if (!speechSupported() || !voice) {
    const button = modeSwitch.querySelector('[data-mode="voice"]');
    button.disabled = true;
    button.title = !voice
      ? 'This browser cannot record audio, so voice mode is unavailable.'
      : 'This browser has no speech synthesis, so the interviewer cannot talk.';
    const reason = el('p', { id: 'voice-unavailable', class: 'dim', text: button.title });
    button.setAttribute('aria-describedby', reason.id);
    modeSwitch.after(reason);
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
        onChange: (next) => onSceneChange(next),
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
      replayTurns(resumed.turns, (kind, text) => { if (kind === 'a') voiceView.sent(text); else if (kind === 'q') voiceView.reply(text); return entry(kind,text); }, log);
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
      disposeSplit();
      inputSize.dispose(); unwatchDraft();
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
      el('button', { class: 'linkbtn', type: 'button', text: 'Back to all interviews', onclick: showLibrary }),
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
