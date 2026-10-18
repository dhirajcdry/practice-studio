// The coach panel — a streaming conversation beside the editor (ARCHITECTURE.md §5,
// API-CONTRACT-P2.md Phase 3).
//
// The hard rule from the architecture: **solving must never depend on the coach.**
// So every failure here is contained to this one card. A missing `claude` binary, a
// server that predates Phase 3, a dropped connection mid-answer — each shows a plain
// sentence inside the panel and changes nothing about the editor, the runner, or the
// reference panels.
//
// Everything the coach writes is untrusted model output. Prose goes through the same
// escape-by-default markdown renderer the NeetCode articles use; ```mermaid, ```svg,
// ```viz and ```image blocks go through illustrator.js, which validates or sanitises
// before drawing. No innerHTML is assigned anywhere in this file.

import { el, clear, replace } from './dom.js';
import { renderMarkdown, renderUserText, looksLikeCode } from './markdown.js';
import { splitDiagramBlocks, renderDiagram } from './illustrator.js';
import { streamCoachMessage, api } from './api.js';
import { createVoiceControl } from './voice.js';
import { createCoachModelPicker } from './coach-model.js';
import { flushRecorder } from './recorder.js';
import { flushEditorSave } from './editor.js';
import {
  studioToolName, actionStatus, receiptGlyph, receiptSummary, canUndo, undoAction,
} from './coach-actions.js';
import { readAttempt, resumeDecision } from './attempt-state.js';
import { renderHistory } from './history.js';
import { onChord, chordLabel } from './shortcuts.js';
import { readDraft, saveDraft, clearDraft, appendDraft, watchDraft } from './drafts.js';
import {
  startRun, runFor, watch, stopRun, markSeen, dismissRun, runsElsewhere, onRunsChange, adopt,
} from './coachruns.js';

const OPEN_KEY = 'studio.coach.open.v1';

/* ============================== shaping (pure) ============================== */

/**
 * Turn any outcome of `streamCoachMessage` into the notice the panel shows.
 *
 * `hadText` matters: a stream that dropped after two paragraphs is a different
 * event from one that never started, and telling them apart is the difference
 * between "try again" and "the answer above is incomplete".
 *
 * @param {object} result
 * @param {boolean} hadText whether any token arrived before the failure
 * @returns {{tone:string, head:string, body:string, retry:boolean}|null} null when nothing is wrong
 */
export function shapeCoachOutcome(result, hadText = false) {
  if (result && result.ok === true) {
    if (!hadText) {
      return {
        tone: 'warn',
        head: 'The coach finished without saying anything',
        body: 'The turn completed but no text came back. That is usually a session that ended early — asking again normally fixes it.',
        retry: true,
      };
    }
    return null;
  }

  const kind = result?.kind || 'server';
  const message = result?.message || 'The coach stopped for a reason it did not explain.';

  const PRESETS = {
    coach: { tone: 'err', head: 'The coach could not answer', retry: true },
    unavailable: { tone: 'warn', head: 'This server has no coach yet', retry: false },
    offline: { tone: 'warn', head: 'The studio server is not answering', retry: true },
    timeout: { tone: 'warn', head: 'The coach went quiet', retry: true },
    cancelled: { tone: '', head: 'Stopped', retry: false },
    truncated: { tone: 'warn', head: 'The answer was cut off', retry: true },
    server: { tone: 'err', head: 'The coach request failed', retry: true },
  };
  const preset = PRESETS[kind] || PRESETS.server;

  const tail = kind === 'cancelled' || kind === 'unavailable'
    ? ''
    : ' Everything else in Studio is unaffected — the editor, the runner and the reference panels all still work.';

  return { tone: preset.tone, head: preset.head, body: message + tail, retry: preset.retry };
}

/** What a Studio tool line says when no receipt covers it. Its arguments are never shown. */
const STUDIO_TOOL_LINES = {
  get_state: 'Looked at your cases and runs',
  add_case: 'Added a case', update_case: 'Changed a case', remove_case: 'Removed a case',
  run_code: 'Ran your code', mark_lines: 'Marked lines', clear_marks: 'Cleared its marks',
  edit_code: 'Edited your code', open_panel: 'Opened a reference panel', save_note: 'Saved a note',
};

/** "Read" + "problems/two-sum/NOTES.md" → one quiet line, never a wall of JSON. */
export function toolLine(name, summary) {
  const studio = studioToolName(name);
  if (studio) return STUDIO_TOOL_LINES[studio];
  const verb = {
    Read: 'Read', Write: 'Wrote', Edit: 'Edited', Glob: 'Looked for',
    Grep: 'Searched', LS: 'Listed', TodoWrite: 'Planned',
  }[name] || name;
  const detail = String(summary || '').trim();
  return detail ? `${verb} ${detail}` : verb;
}

/* ============================== rendering ============================== */

/**
 * Render one coach message: prose through the article renderer, diagrams through
 * the illustrator, in the order they were written.
 *
 * While a message is streaming this runs on every frame, so a finished diagram is
 * kept in `cache` and re-attached rather than parsed and laid out again — without
 * it, a drawing near the top of a long answer flickers for as long as the coach
 * keeps typing. The cache belongs to one message; a second copy of the same
 * diagram in the same message is drawn fresh rather than stolen from the first.
 *
 * `live` marks a reply that is arriving now. Only a live reply may start painting a
 * Codex picture by itself; a replayed one looks its pictures up and offers a button.
 */
export function renderCoachText(target, text, cache = null, { slug = null, live = false } = {}) {
  clear(target);
  const segments = splitDiagramBlocks(text);
  if (!segments.length) return target;
  const usedThisPass = new Set();
  for (const segment of segments) {
    if (segment.type === 'markdown') { target.append(renderMarkdown(segment.text)); continue; }
    const key = segment.complete ? `${segment.lang}::${segment.code}` : null;
    if (cache && key && cache.has(key) && !usedThisPass.has(key)) {
      usedThisPass.add(key);
      target.append(cache.get(key));
      continue;
    }
    const node = renderDiagram(segment.lang, segment.code, { complete: segment.complete, slug, live });
    if (cache && key && !usedThisPass.has(key)) { cache.set(key, node); usedThisPass.add(key); }
    target.append(node);
  }
  return target;
}

/**
 * How many tool lines each receipt hides, by bare tool name. A Studio tool call arrives
 * twice — as an ordinary tool line and as an action — and the receipt is the one worth
 * reading.
 */
export function coveredTools(actions) {
  const counts = new Map();
  for (const a of actions || []) {
    const name = studioToolName(a?.tool);
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

/** Hide the tool lines in `toolsEl` that a receipt already says. */
function coverToolLines(toolsEl, actions) {
  const left = coveredTools(actions);
  for (const line of toolsEl.querySelectorAll('.cmsg-tool[data-tool]')) {
    const name = line.dataset.tool;
    const n = left.get(name) || 0;
    line.hidden = n > 0;
    if (n > 0) left.set(name, n - 1);
  }
}

/**
 * One thing the tutor did in Studio, as a line in its reply.
 *
 * `ui` is the panel's own state for it (an undo in flight, its error, or that it was
 * undone); `onUndo` only on a live reply — a replayed thread shows what happened, and
 * offers nothing to press.
 */
function receiptRow(action, { ui = {}, onUndo = null, settled = false } = {}) {
  let status = ui.undone ? 'undone' : actionStatus(action);
  // The turn is over and nobody ever answered for this one: it was not done, and saying
  // "working…" forever would claim otherwise.
  if (settled && status === 'pending') {
    status = 'failed';
    action = { ...action, message: action.message || 'Studio did not apply this one (the problem was not open in this tab when it arrived).' };
  }
  const tool = studioToolName(action.tool) || '';
  const summary = receiptSummary(action);
  const undoable = !!onUndo && !ui.undone && canUndo(action);
  const why = status === 'failed' ? String(action.message || '').trim() : '';
  return el('div', { class: `cmsg-receipt is-${status}`, 'data-tool': tool }, [
    el('span', { class: 'cr-glyph', 'aria-hidden': 'true', text: receiptGlyph(tool) }),
    el('span', { class: 'cr-text', text: summary, title: summary }),
    status === 'pending' ? el('span', { class: 'cr-state', text: 'working…' }) : null,
    status === 'failed' ? el('span', { class: 'cr-state', text: 'not done' }) : null,
    status === 'undone' ? el('span', { class: 'cr-state', text: 'Undone' }) : null,
    undoable
      ? el('button', {
        class: 'cr-undo', type: 'button', disabled: !!ui.busy,
        title: tool === 'edit_code' ? 'Put your code back as it was before this edit' : 'Put your test cases back as they were',
        text: ui.busy ? 'Undoing…' : 'Undo', onclick: onUndo,
      })
      : null,
    why ? el('div', { class: 'cr-why', text: why }) : null,
    ui.error ? el('div', { class: 'cr-why', text: ui.error }) : null,
  ]);
}

function noticeBlock({ tone = '', head, body, actions = [] }) {
  return el('div', { class: 'state ' + tone }, [
    el('h3', { text: head }),
    el('p', { text: body }),
    actions.length
      ? el('div', { class: 'acts' }, actions.map(a => el('button', { class: 'act', type: 'button', text: a.label, onclick: a.onClick })))
      : null,
  ]);
}

const STARTERS = [
  { label: 'Where do I start?', text: 'I have read the problem and I am not sure where to start. Ask me one question that would unblock me — do not give me the approach.' },
  { label: 'Check my approach', text: 'Here is the approach I am about to write. Tell me where it breaks before I spend twenty minutes on it.' },
  { label: 'Why is this wrong?', text: 'My code fails one of the example cases. Point me at the reasoning error rather than the fix.' },
  { label: 'Trace my code', text: 'Trace what my current code does on Example 1 as a step-by-step ```viz illustration with frames, using the real values. If it goes wrong, stop on the step where it diverges. Then say in one sentence what I am missing — do not write the fix.' },
  { label: 'Picture it', text: 'Give me one ```image that will make this problem\'s core idea stick in an interview: a concrete metaphor, not a diagram of the solution. Then tie it back to the algorithm in two sentences, without revealing more than I have already worked out.' },
];

/* ============================== the panel ============================== */

// An attempt's next thread belongs to the problem, not to whichever panel happens
// to be mounted. Restoring only the label/flag never stops or clears a surviving run.
const attemptThreads = new Map();
function attemptThread(slug) {
  if (!attemptThreads.has(slug)) attemptThreads.set(slug, { pending: false, live: false });
  const state = attemptThreads.get(slug);
  const saved = readAttempt();
  if (saved?.slug === slug && resumeDecision(saved) === 'resume') state.live = true;
  return state;
}
function reviewOptions({ attemptId, spokenMs = 0, elapsedMs = 0 }) {
  const mins = Math.max(1, Math.round(elapsedMs / 60_000));
  const spoke = spokenMs > 0
    ? `${Math.floor(spokenMs / 60_000)}:${String(Math.round(spokenMs / 1000) % 60).padStart(2, '0')} spoken`
    : 'nothing spoken';
  return { kind: 'attempt-review', attemptId,
    lead: `Attempt ended · ${mins} min · ${spoke} — reviewing it end to end.` };
}

/**
 * Build the coach for one problem.
 *
 * @param {{slug:string, title?:string}} entry
 * @returns {{root:HTMLElement, focus:() => void, dispose:() => void}}
 */
export function createCoachPanel(entry) {
  const slug = entry.slug;
  // The panel does not own the turn — coachruns.js does, so that leaving this problem
  // does not kill the answer. `detachRun` unsubscribes; it never stops anything.
  let detachRun = null;
  let shownRun = null;
  let streaming = false;
  let disposed = false;
  let turns = 0;
  // Set when an attempt opens, consumed by the first turn of that attempt, so the CLI
  // starts a fresh session rather than resuming the previous attempt's reasoning.
  const thread = attemptThread(slug);
  // Set when a past conversation is chosen from the history view; consumed by the next
  // turn, so continuing one is an explicit act rather than a lasting mode.
  let resumeSessionId = null;

  const log = el('div', { class: 'coach-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Coach conversation' });
  const stateLabel = el('span', { class: 'coach-state mono dim', text: thread.live ? 'Attempt in progress' : 'Ready' });

  const input = el('textarea', {
    class: 'coach-input', rows: '2', spellcheck: 'true',
    placeholder: 'Ask the coach —  ⌘↵ to send',
    'aria-label': 'Message the coach',
  });
  const restoredDraft = readDraft(slug);
  if (restoredDraft?.text) input.value = restoredDraft.text;
  let ghost = '';

  // The provisional words of the phrase still being spoken, shown at the end of the box.
  // Once anything is typed after them they are yours, and are never cut out again —
  // searching for them elsewhere could delete words you typed yourself.
  function committed() {
    const value = input.value;
    if (!ghost) return value;
    if (value.endsWith(ghost)) return value.slice(0, -ghost.length);
    ghost = '';
    return value;
  }

  const sendLabel = el('span', { text: 'Ask' });
  const sendButton = el('button', { class: 'ws-run coach-send', type: 'button', onclick: () => submit() },
    [sendLabel, el('kbd', { text: '⌘↵' })]);

  const stopButton = el('button', {
    class: 'ws-mini coach-stop', type: 'button', hidden: true, text: 'Stop',
    onclick: () => stopRun(slug),
  });

  const voice = createVoiceControl({
    getSlug: () => slug,
    onPreview: text => {
      if (disposed) return;
      input.value = committed();
      ghost = '';
      if (text) {
        const gap = input.value === '' || /\s$/.test(input.value) ? '' : ' ';
        ghost = gap + text;
        input.value += ghost;
      }
      autosize();
      if (document.activeElement === input) {
        input.setSelectionRange(input.value.length, input.value.length);
      }
    },
    // Dictation lands phrase by phrase while you are still speaking, so it joins the
    // sentence with a space rather than starting a new paragraph — it should read like
    // typing, because that is what it is standing in for.
    onTranscript: (text, meta) => {
      if (disposed) { appendDraft(slug, text); return; }
      const existing = input.value;
      const gap = existing === '' || /\s$/.test(existing) ? '' : ' ';
      input.value = existing + gap + text;
      saveDraft(slug, committed());
      autosize();
      // Focus is NOT taken here: you may be reading your code while you talk, and
      // stealing the caret mid-sentence is how a shortcut turns into a typo.
      if (document.activeElement === input) {
        input.setSelectionRange(input.value.length, input.value.length);
      }
      log.scrollTop = log.scrollHeight;
    },
    onState: (state) => {
      sendButton.disabled = state !== 'idle' || streaming || changingModel;
      if (state === 'recording') stateLabel.textContent = 'Listening';
      else if (state === 'working') stateLabel.textContent = 'Transcribing';
      else if (!streaming) stateLabel.textContent = thread.live ? 'Attempt in progress' : 'Ready';
    },
  });

  // One row: microphone, then the send controls. The mic used to sit on its own line
  // above them, which gave the composer three stacked rows to say two things.
  const composer = el('div', { class: 'coach-compose' }, [
    input,
    el('div', { class: 'coach-actions' }, [
      api.demo ? null : voice.root,
      el('span', { class: 'spacer' }),
      stopButton,
      sendButton,
    ]),
    api.demo ? null : voice.status,
  ]);

  const closeButton = el('button', {
    class: 'ws-mini coach-hide', type: 'button',
  }, ['Hide', el('kbd', { text: chordLabel('coach') })]);
  closeButton.addEventListener('click', () => setOpen(false));

  // The record of the teaching lives with the teaching, not in a separate screen.
  const history = el('div', { class: 'coach-history', hidden: true });

  const tabChat = el('button', { class: 'coach-tab mono', type: 'button', 'aria-pressed': 'true', text: 'Chat' });
  const tabHistory = el('button', { class: 'coach-tab mono', type: 'button', 'aria-pressed': 'false', text: 'History' });

  function showTab(name) {
    const onHistory = name === 'history';
    history.hidden = !onHistory;
    log.hidden = onHistory;
    composer.hidden = onHistory;
    tabChat.setAttribute('aria-pressed', String(!onHistory));
    tabHistory.setAttribute('aria-pressed', String(onHistory));
    if (onHistory) {
      renderHistory(history, {
        slug,
        onResume: (past) => {
          resumeSessionId = past.sessionId;
          thread.pending = false;
          showTab('chat');
          replayThread(past);
          input.focus();
        },
      });
    }
  }

  tabChat.addEventListener('click', () => showTab('chat'));
  tabHistory.addEventListener('click', () => showTab('history'));

  let changingModel = false;
  const modelPicker = createCoachModelPicker({ compact: true, onPending: pending => {
    changingModel = pending;
    sendButton.disabled = pending || streaming || voice.isBusy();
  } });

  const root = el('section', { class: 'card coach', 'aria-label': 'Coach' }, [
    el('div', { class: 'coach-identity' }, [
      el('div', { class: 'coach-identity-row' }, [
        el('span', { class: 'coach-eyebrow mono', text: 'Your practice partner' }),
        api.demo ? null : modelPicker.root,
      ]),
      el('div', { class: 'coach-title', text: 'Keep your train of thought.' }),
      el('div', { class: 'coach-context', 'aria-label': 'Context available with each question',
        title: 'Each question includes your current code, recent runs and available transcripts. Microphone recording starts only when you choose it.' }, [
        el('span', { text: 'Code + changes' }),
        el('span', { text: 'Run results' }),
        el('span', { text: 'Saved speech' }),
      ]),
    ]),
    el('div', { class: 'ws-bar coach-bar' }, [
      el('span', { class: 'coach-tabs' }, [tabChat, tabHistory]),
      el('span', { class: 'coach-sep', 'aria-hidden': 'true' }),
      stateLabel,
      el('span', { class: 'spacer' }),
      closeButton,
    ]),
    log,
    history,
    composer,
  ]);

  /* ---- log helpers ---- */

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(180, Math.max(46, input.scrollHeight)) + 'px';
  }
  const unwatchDraft = watchDraft(slug, text => {
    // Saving committed text must leave the visible provisional phrase in place.
    if (committed() !== text) { input.value = text; ghost = ''; autosize(); }
  });
  input.addEventListener('input', autosize);
  input.addEventListener('input', () => saveDraft(slug, committed()));
  input.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain') || '';
    const fences = input.value.slice(0, input.selectionStart).match(/```/g) || [];
    if (!/[\r\n]/.test(text) || fences.length % 2 || !looksLikeCode(text)) return;
    event.preventDefault();
    input.setRangeText('```python\n' + text.replace(/[\r\n]+$/, '') + '\n```\n', input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  function atBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  }

  // Follow the stream until the user scrolls away, then stop until they come back.
  //
  // `following` may only be changed by a scroll the USER caused. Deriving it from
  // position after every scroll event looked simpler and was wrong: a streaming answer
  // re-renders its whole body between frames, and for the instant the old body is gone
  // the box has almost no content, so the browser clamps scrollTop and fires a scroll of
  // its own. That synthetic scroll reads as "at the bottom", flips following back to
  // true, and the very next frame yanks the view back down. Scrolling up during a stream
  // was therefore undone within ~16ms, every time — the "I can't scroll, it's stuck" bug.
  //
  // So: a real input event arms the check, and only then does position decide. Wheel,
  // touch, keyboard and scrollbar-drag are all of them, and scrolling back to the bottom
  // by any of those resumes following.
  // The window, rather than a single event, because one flick of a trackpad keeps
  // scrolling long after the last wheel event — and a scrollbar drag scrolls between
  // pointermoves. Both are the user; neither would survive a one-shot flag.
  const INTENT_MS = 800;
  let following = true;
  let armedUntil = 0;
  const arm = () => { armedUntil = performance.now() + INTENT_MS; };
  for (const type of ['touchmove', 'keydown', 'pointerdown']) {
    log.addEventListener(type, arm, { passive: true });
  }
  // Upward wheel stops the follow on the spot, without waiting for the scroll event it
  // causes. Scroll events are delivered a frame late, and a paint landing inside that
  // frame would drag the view to the bottom first — at which point the position rule
  // would agree we are following and the scroll up would be gone before it was seen.
  log.addEventListener('wheel', (event) => {
    arm();
    if (event.deltaY < 0) following = false;
  }, { passive: true });
  // Only while a button is held: a bare mouse-over is not an intent to scroll, and
  // arming on hover would hand the position rule straight back to the re-render.
  log.addEventListener('pointermove', (event) => { if (event.buttons) arm(); }, { passive: true });
  log.addEventListener('scroll', () => {
    if (performance.now() > armedUntil) return; // our own re-render, not him
    following = atBottom();
  }, { passive: true });

  function scrollDown(force = false) {
    if (force || following) log.scrollTop = log.scrollHeight;
  }

  function showEmptyState() {
    replace(log, el('div', { class: 'coach-empty' }, [
      el('div', { class: 'coach-starters' }, STARTERS.map(starter => el('button', {
        class: 'chip', type: 'button', text: starter.label,
        onclick: () => { input.value = starter.text; saveDraft(slug, input.value); autosize(); input.focus(); },
      }))),
    ]));
  }

  /**
   * A line from the app, not from either party. Used when an attempt ends: the coach is
   * about to speak without anyone having typed, and pretending otherwise would put words
   * in his mouth in his own conversation.
   */
  function addNote(text) {
    if (log.querySelector('.coach-empty')) clear(log);
    const note = el('div', { class: 'cmsg-note mono dim', text });
    log.append(note);
    scrollDown(true);
    return note;
  }

  // Roles are `you` and `reply` — NOT `coach`. `.cmsg.coach` also matched the panel's own
  // `.coach` rule, which is `display:flex; height:100%; overflow:hidden`. Every answer was
  // therefore forced to exactly the height of the log and clipped there, with nothing left
  // for the log to scroll: the answer looked cut off mid-sentence and the wheel did
  // nothing. A message and the panel it sits in must not share a class name.
  function addMessage(role, text = '') {
    const bodyEl = el('div', { class: 'cmsg-body rich' });
    const message = el('div', { class: 'cmsg ' + role }, [
      el('div', { class: 'mono dim cmsg-who', text: role === 'you' ? 'You' : 'Coach' }),
      bodyEl,
    ]);
    if (log.querySelector('.coach-empty')) clear(log);
    log.append(message);
    if (role === 'you') bodyEl.append(renderUserText(text));
    scrollDown(true);
    return { message, bodyEl };
  }

  /**
   * Put a past conversation back on screen, then continue it.
   *
   * Resuming used to set the session id and print one line saying so, which left the
   * panel empty: the thread you had just chosen was invisible, the coach appeared to
   * have forgotten it, and clicking Resume twice simply stacked a second line. You
   * cannot continue a conversation you cannot read.
   *
   * The log is CLEARED first. Appending would splice the old thread onto whatever was
   * on screen and imply the coach can see both, when the CLI is resuming exactly one.
   */
  function replayThread(thread) {
    clear(log);
    for (const turn of thread.turns || []) {
      if (turn.ask && turn.ask.trim()) addMessage('you', turn.ask);
      else if (turn.kind === 'attempt-review') addNote('Attempt review');
      const said = (turn.answer || '').trim() !== '';
      const worked = (Array.isArray(turn.tools) && turn.tools.length > 0)
        || (Array.isArray(turn.actions) && turn.actions.length > 0);
      if (!said && !worked) {
        // Killed before it got a word out. An empty card under a "Coach" heading reads
        // as an answer you failed to scroll to.
        addNote(turn.stopped ? 'Stopped before the coach answered' : 'The coach said nothing');
        continue;
      }
      const { message: card, bodyEl } = addMessage('reply');
      const acted = Array.isArray(turn.actions) ? turn.actions.filter(a => a && a.tool) : [];
      if (worked) {
        const tools = el('div', { class: 'cmsg-tools' });
        for (const line of turn.tools) {
          // Stored as "<name> <summary>". A Studio tool's line is said plainly, never its arguments.
          const name = studioToolName(String(line).split(' ')[0]);
          tools.append(el('div', {
            class: 'cmsg-tool mono dim', 'data-tool': name, text: name ? toolLine(name) : line,
          }));
        }
        coverToolLines(tools, acted);
        card.insertBefore(tools, bodyEl);
      }
      if (acted.length) {
        card.insertBefore(el('div', { class: 'cmsg-receipts' }, acted.map(a => receiptRow(a, { settled: true }))), bodyEl);
      }
      renderCoachText(bodyEl, turn.answer || '', new Map(), { slug, live: false });
      // An answer that was cut short is shown as one rather than passed off as whole.
      if (turn.stopped) card.append(el('div', { class: 'cmsg-note mono dim', text: 'Stopped before it finished' }));
    }
    const when = String(thread.startedAt || '').slice(0, 16).replace('T', ' ');
    addNote(`Continuing this conversation${when ? ` from ${when}` : ''} — what you ask next goes into it.`);
    following = true;
    scrollDown(true);
  }

  /* ---- one turn ---- */

  function setBusy(on, label) {
    streaming = on;
    sendButton.disabled = on || voice.isBusy() || changingModel;
    modelPicker.setBusy(on);
    sendLabel.textContent = on ? 'Asking' : 'Ask';
    sendButton.classList.toggle('busy', on);
    stopButton.hidden = !on;
    if (label) stateLabel.textContent = label;
  }

  /**
   * Show a run, live or already finished, and keep showing it as it arrives.
   *
   * Called from two places, which is the whole point: right after starting a turn, and
   * again when the panel is re-mounted on a problem whose answer has been streaming in
   * the background while you were somewhere else.
   *
   * @param {boolean} printAsk whether the question still needs putting on screen —
   *   false when submit() has just drawn it, true when re-attaching to a run in flight
   */
  function attachRun(run, { printAsk = true } = {}) {
    if (shownRun === run) return;   // already on screen; re-attaching would duplicate it
    shownRun = run;
    if (detachRun) { detachRun(); detachRun = null; }

    if (printAsk) {
      if (run.review) addNote(run.lead || 'Attempt ended. Reviewing it end to end.');
      else if (run.ask) addMessage('you', run.ask);
    }

    const { message: card, bodyEl } = addMessage('reply');
    const toolsEl = el('div', { class: 'cmsg-tools' });
    card.insertBefore(toolsEl, bodyEl);
    const receiptsEl = el('div', { class: 'cmsg-receipts' });
    card.insertBefore(receiptsEl, bodyEl);
    const receiptUi = new Map();     // action id → { busy, error, undone }
    const thinking = el('div', { class: 'coach-thinking mono dim' }, [el('i'), el('span', { text: 'Thinking' })]);

    let painted = 0;                 // how many tool lines are already on screen
    const diagrams = new Map();      // finished drawings, kept across frames
    let painting = false;
    let paintedAt = 0;
    // Every paint rebuilds the whole message body, which is fine at four frames a second
    // and miserable at sixty: the text under the cursor is replaced mid-selection and the
    // box reflows constantly. The stream is prose, not an animation.
    const PAINT_MS = 220;

    const paintTools = () => {
      for (; painted < run.tools.length; painted++) {
        const t = run.tools[painted];
        toolsEl.append(el('div', {
          class: 'cmsg-tool mono dim', 'data-tool': studioToolName(t.name), text: toolLine(t.name, t.summary),
        }));
      }
      coverToolLines(toolsEl, [...(run.actions?.values() ?? [])]);
    };

    const undo = async (action) => {
      const id = String(action.id);
      if (receiptUi.get(id)?.busy) return;
      receiptUi.set(id, { busy: true });
      paintReceipts();
      const result = await undoAction(action);
      receiptUi.set(id, result.ok ? { undone: true } : { error: result.message });
      paintReceipts();
    };

    // Rebuilt whole on every change: a handful of lines, and replace() swaps them in one go.
    const paintReceipts = () => {
      const list = [...(run.actions?.values() ?? [])];
      replace(receiptsEl, list.map(a => receiptRow(a, {
        ui: receiptUi.get(String(a.id)) || {},
        onUndo: () => undo(a),
        settled: run.done,
      })));
      coverToolLines(toolsEl, list);
    };

    const render = () => {
      // Reading three paragraphs back: hold that exact offset across the rebuild, or the
      // sentence being read moves under the eye every time a token lands.
      const keep = following ? -1 : log.scrollTop;
      renderCoachText(bodyEl, run.text, diagrams, { slug, live: true });
      if (following) log.scrollTop = log.scrollHeight;
      else if (keep >= 0) log.scrollTop = keep;
      paintedAt = performance.now();
    };

    const paint = () => {
      if (painting) return;
      painting = true;
      const wait = Math.max(0, PAINT_MS - (performance.now() - paintedAt));
      setTimeout(() => requestAnimationFrame(() => {
        painting = false;
        if (disposed) return;
        render();
      }), wait);
    };

    const finish = () => {
      thinking.remove();
      paintTools();
      paintReceipts();
      renderCoachText(bodyEl, run.text, diagrams, { slug, live: true });
      if (run.text.trim() === '') bodyEl.remove();

      const outcome = shapeCoachOutcome(run.result, run.text.trim() !== '');
      if (outcome) {
        card.append(noticeBlock({
          tone: outcome.tone,
          head: outcome.head,
          body: outcome.body,
          actions: outcome.retry
            ? [{ label: 'Ask again', onClick: () => { input.value = run.ask; saveDraft(slug, input.value); autosize(); input.focus(); } }]
            : [],
        }));
      }

      setBusy(false, outcome && outcome.tone === 'err' ? 'Not available' : thread.live ? 'Attempt in progress' : 'Ready');
      resumeSessionId = null;
      markSeen(slug);
      if (detachRun) { detachRun(); detachRun = null; }
      scrollDown();
    };

    // Whatever has already arrived, before subscribing to the rest.
    paintTools();
    paintReceipts();
    if (run.text) render(); else card.append(thinking);

    if (run.done) { finish(); return; }

    setBusy(true, run.review ? 'Reviewing the attempt' : 'Thinking');
    detachRun = watch(slug, (event) => {
      if (disposed) return;
      if (event === 'token') { thinking.remove(); paint(); return; }
      if (event === 'tool') { paintTools(); scrollDown(); return; }
      if (event === 'action') { paintReceipts(); scrollDown(); return; }
      if (event === 'done') finish();
    });
  }

  async function submit({ ask = null, kind = null, attemptId = null, newThread = false, lead = null } = {}) {
    if (streaming || voice.isBusy() || changingModel) return;
    const review = kind === 'attempt-review';
    const message = ask !== null ? ask : input.value.trim();
    if (!review && message === '') { input.focus(); return; }

    if (!review) {
      input.value = '';
      clearDraft(slug);
      autosize();
    }
    // attachRun owns both the question/review note and the reply. startRun announces
    // synchronously, so showPendingRun may attach before the explicit call below.
    // Printing the question here as well would display the same submission twice.

    turns++;
    following = true; // a new question always follows, whatever was scrolled last time
    setBusy(true, 'Thinking');

    // Get the in-flight take onto disk before the question goes out. Otherwise the words
    // that prompted the question are still inside the recorder, and the coach answers as
    // though they were never said. Bounded inside flushRecorder — this cannot hang.
    if (!review) {
      try {
        stateLabel.textContent = 'Saving what you said';
        await flushRecorder();
      } catch { /* speech is a bonus input; never let it block a question */ }
    }
    // The coach reads solution.py from disk, and the editor saves on a debounce: typing
    // and asking straight away would otherwise send the code from a second ago. Bounded
    // (2 s) and quiet inside flushEditorSave — a slow save cannot hold the question.
    await flushEditorSave(slug).catch(() => false);

    const run = startRun({
      slug,
      title: entry.title || slug,
      message,
      kind,
      attemptId,
      newThread: newThread || thread.pending,
      resumeSessionId,
      lead,
    });
    thread.pending = false;
    attachRun(run, { printAsk: true });
  }

  /* ---- keyboard ---- */

  // main.js owns a global map (j/k/s/a/Enter) that would fire while typing here,
  // exactly as it would in the editor. This is where that map stops.
  root.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); submit(); return; }
    if (event.key === 'Escape' && document.activeElement === input) { event.preventDefault(); input.blur(); }
  });

  showEmptyState();
  autosize();

  return {
    root,
    focus: () => input.focus(),
    isStreaming: () => streaming,
    slug,
    attach: attachRun,
    turnCount: () => turns,

    /** A new attempt is a new conversation: clear the panel and drop the resumed thread. */
    beginAttempt() {
      // A new attempt is a new conversation, so the previous turn is genuinely
      // unwanted — this is the one place that stops a run rather than letting it finish.
      stopRun(slug);
      thread.pending = true;
      thread.live = true;
      resumeSessionId = null;
      showTab('chat');
      showEmptyState();
      stateLabel.textContent = 'Attempt in progress';
    },

    endAttempt() {
      thread.live = false;
      if (!streaming && !voice.isBusy()) stateLabel.textContent = 'Ready';
    },

    /** The attempt ended. Ask for the end-to-end review, with no typed question. */
    reviewAttempt(detail = {}) {
      thread.live = false;
      setOpen(true);
      return submit({ ...reviewOptions(detail), ask: '', newThread: thread.pending });
    },
    /**
     * Leaving the problem. The run is NOT stopped: it keeps going in the background and
     * this panel simply stops listening. Come back and mountCoach re-attaches to it.
     */
    dispose() {
      if (disposed) return;
      disposed = true;
      if (detachRun) { detachRun(); detachRun = null; }
      // Voice may finish outstanding phrases asynchronously; the callback above
      // updates this same draft key as each phrase arrives.
      unwatchDraft();
      saveDraft(slug, committed());
      voice.dispose({ finish: true });
      modelPicker.dispose();
    },
  };
}

/* ============================== mounting ============================== */

let active = null;
let launcher = null;

function readOpen() {
  try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
}

function writeOpen(open) {
  try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* private browsing */ }
}

/** A background answer for the problem on screen, shown as soon as there is room for it. */
function showPendingRun() {
  if (!active || !isOpen()) return;
  const run = runFor(active.slug);
  if (run) active.attach(run, { printAsk: true });
}

/** Open or close the panel. The editor keeps its width when the coach is away. */
export function setOpen(open, { focus = true } = {}) {
  document.body.classList.toggle('coach-open', open);
  writeOpen(open);
  if (launcher) launcher.setAttribute('aria-pressed', String(open));
  // Only when *you* opened it. Restoring a panel that was open last time must not
  // silently capture the keyboard — the editor is the reason the screen exists, and
  // typing that lands in the composer looks exactly like broken shortcuts.
  if (open && focus && active) setTimeout(() => active.focus(), 60);
  if (open) showPendingRun();
}

export function isOpen() {
  return document.body.classList.contains('coach-open');
}

/**
 * A standing note about answers being written for problems you are not looking at.
 *
 * Without it, a background turn is invisible: you would have to remember that you asked
 * something on Trapping Rain Water twenty minutes ago and go back to check. Clicking a
 * row goes there — which is the whole point of letting the turn outlive the panel.
 */
let runsChip = null;
// Set by the indicator: following it means "show me that answer", not "go to that page".
let openOnMount = false;

function ensureRunsChip() {
  if (runsChip && document.body.contains(runsChip)) return runsChip;
  runsChip = el('div', { class: 'coach-runs', hidden: true });
  document.body.append(runsChip);
  onRunsChange(paintRunsChip);
  // A turn adopted from the server after a reload lands here rather than at mount time,
  // so the panel has to be told to look again when one appears.
  onRunsChange(showPendingRun);
  paintRunsChip();
  return runsChip;
}

function paintRunsChip() {
  if (!runsChip) return;
  const raw = /^#\/p\/([^/?]+)/.exec(location.hash)?.[1];
  let here = null;
  try { here = raw ? decodeURIComponent(raw) : null; } catch { /* malformed route */ }
  const others = runsElsewhere(here);
  runsChip.hidden = others.length === 0;
  // Two actions, so two buttons — the row cannot be one button with another inside it.
  // Following it goes to the answer; the × takes the note away and nothing else.
  replace(runsChip, others.map((run) => el('div', { class: 'coach-run mono' }, [
    el('button', {
      class: 'coach-run-go', type: 'button',
      title: run.done ? 'The answer is waiting on that problem' : 'Still being written',
      onclick: () => {
        openOnMount = true;
        if (location.hash === `#/p/${run.slug}`) { setOpen(true); showPendingRun(); }
        else location.hash = `#/p/${run.slug}`;
      },
    }, [
      el('span', { class: 'coach-run-dot' + (run.done ? ' is-done' : '') }),
      el('span', { class: 'coach-run-title', text: run.title }),
      el('span', { class: 'coach-run-state', text: run.done ? 'answer ready' : 'writing…' }),
    ]),
    el('button', {
      class: 'coach-run-x', type: 'button', text: '×',
      'aria-label': `Hide this note about ${run.title}`,
      // Said plainly, because a × next to something still being written looks like a
      // cancel and is not one.
      title: run.done
        ? 'Hide this. The answer stays on that problem.'
        : 'Hide this. The coach keeps writing.',
      onclick: () => dismissRun(run.slug),
    }),
  ])));
}

window.addEventListener('hashchange', paintRunsChip);

function ensureLauncher() {
  if (launcher && document.body.contains(launcher)) return launcher;
  launcher = el('button', {
    class: 'coach-launch', type: 'button', 'aria-pressed': 'false',
    onclick: () => setOpen(!isOpen()),
  }, [el('span', { text: 'Coach' }), el('kbd', { text: chordLabel('coach') })]);
  document.body.append(launcher);
  return launcher;
}

/**
 * Mount the coach for one problem and return the element to place in the DOM.
 * Called by problem.js, which owns the problem screen.
 */
let adoption = null;
export function mountCoach(entry) {
  if (active) active.dispose();
  const panel = createCoachPanel(entry);
  active = panel;
  ensureLauncher();
  ensureRunsChip();
  setOpen(openOnMount || readOpen(), { focus: false });
  openOnMount = false;

  // The server may still be writing an answer this page has never seen — the tab was
  // reloaded, or this is a second tab. Ask once; anything found announces itself and
  // arrives through showPendingRun.
  if (!adoption) adoption = adopt().catch(() => { adoption = null; });

  // An answer that was still arriving when you left, or that finished while you were
  // away. It goes on screen once the panel is open — attaching into a hidden panel would
  // mark it read and take the indicator away without anyone having seen it.
  showPendingRun();

  return panel.root;
}

/** A new attempt owns a fresh thread even if its panel is temporarily absent. */
export function coachBeginAttempt(slug) {
  const thread = attemptThread(slug);
  thread.pending = true;
  thread.live = true;
  if (active?.slug === slug) active.beginAttempt();
  else stopRun(slug);
}

/** Route the review to the attempt, using the same payload with or without a panel. */
export function coachReviewAttempt(detail) {
  const thread = attemptThread(detail.slug);
  thread.live = false;
  if (active?.slug === detail.slug) active.endAttempt();
  if (!detail.attemptId || !detail.spokenMs) return;
  if (active?.slug === detail.slug) return active.reviewAttempt(detail);
  ensureRunsChip();
  // The review reads the saved code too; same bounded flush as a typed question.
  return flushEditorSave(detail.slug).catch(() => false).then(() => {
    const run = startRun({ slug: detail.slug, title: detail.title || detail.slug,
      ...reviewOptions(detail), newThread: thread.pending });
    thread.pending = false;
    return run;
  });
}

export function teardownCoach() {
  if (active) { active.dispose(); active = null; }
  document.body.classList.remove('coach-open');
  if (launcher) { launcher.remove(); launcher = null; }
}

// ⌘\ toggles the panel. It used to be a bare `c`, which meant it worked only while the
// cursor was nowhere and typed a letter the rest of the time — including into the coach's
// own composer, which is the one place you are guaranteed to be typing.
onChord('coach', () => { if (active) setOpen(!isOpen()); });

window.addEventListener('hashchange', () => {
  if (!/^#\/p\//.test(location.hash)) teardownCoach();
});

/**
 * Contract-shaped entry point, for wiring from main.js instead of problem.js.
 * `mountEl` is emptied and given the coach for whatever problem the hash names.
 */
export function init(mountEl, apiState) {
  const match = /^#\/p\/(.+)$/.exec(location.hash);
  if (!match) return null;
  const slug = decodeURIComponent(match[1]);
  replace(mountEl, mountCoach({ slug, title: slug }));
  return active;
}

export { api };
