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
import { when } from './history.js';
import { createVoiceControl } from './voice.js';
import { createSpeaker, splitForSpeech, turnDecision, speechSupported } from './speech.js';

const VENDOR = new URL('../vendor/excalidraw/', import.meta.url).href;

let excalidrawPromise = null;

/** Resolves to the Excalidraw namespace, or rejects — callers must handle both. */
function loadExcalidraw() {
  if (excalidrawPromise) return excalidrawPromise;
  excalidrawPromise = (async () => {
    // Excalidraw fetches its handwriting fonts at runtime rather than importing them,
    // so it has to be told where they are before the component mounts.
    window.EXCALIDRAW_ASSET_PATH = VENDOR;
    if (!document.querySelector('link[data-excalidraw]')) {
      const link = el('link', { rel: 'stylesheet', href: `${VENDOR}excalidraw.css` });
      link.dataset.excalidraw = '1';
      document.head.append(link);
    }
    return import(`${VENDOR}excalidraw.mjs`);
  })().catch((error) => { excalidrawPromise = null; throw error; });
  return excalidrawPromise;
}

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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    let message = `The interviewer could not be reached (${res.status}).`;
    try { message = (await res.json())?.error?.message ?? message; } catch { /* keep it */ }
    throw new Error(message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // An SSE event is a block of field lines ended by a blank line.
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let name = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) name = line.slice(7).trim();
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      if (!data.length) continue;
      let payload;
      try { payload = JSON.parse(data.join('\n')); } catch { continue; }
      if (name === 'token') onToken(payload.text ?? '');
      else onEvent(name, payload);
    }
  }
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
function replayTurns(turns, entry) {
  for (const turn of turns ?? []) {
    if (turn.kind === 'debrief') {
      if (turn.asked) entry('d', turn.asked);
      continue;
    }
    if (turn.said) entry('a', turn.said);
    if (turn.asked) entry('q', turn.asked);
  }
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
    class: 'dzl-new', type: 'button', text: 'Start a new interview', onclick: () => onNew(),
  });

  const view = el('div', { class: 'dzl' }, [
    el('div', { class: 'dzl-head' }, [
      el('div', {}, [
        el('div', { class: 'mono dzl-kicker', text: 'System design' }),
        el('div', { class: 'dzl-lede', text: 'Your interviews, saved. Pick one up where you left it, or read one back.' }),
      ]),
      el('span', { class: 'spacer' }),
      newButton,
    ]),
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
    const node = el('div', { class: 'dzl-row' }, [
      el('div', { class: 'dzl-main' }, [
        el('div', { class: 'dzl-title', text: titleOf(item) }),
        el('div', { class: 'mono dzl-meta', text: metaOf(item) }),
        note,
      ]),
      action,
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
        'No interviews yet. The first one starts with a problem the interviewer picks.'));
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
          r.note.textContent = 'Resume starts a fresh thread — its own thread was not saved, so it will read the transcript to carry on.';
        }
      } else {
        // Only reachable if it was debriefed between the list call and this one — a
        // race, not a dead thread. The row already says "debriefed" in its meta line.
        r.note.hidden = false;
        r.note.textContent = 'Finished while this list was loading — open it to read the debrief.';
      }
    }
  })();

  return { destroy() { gone = true; } };
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

  const log = el('div', { class: 'dz-log' });

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
    replayTurns(data.turns, entry);
  }

  // An interview without a debrief is not a finished interview, and must not read like
  // one just because it is being viewed after the fact.
  if (!data.debriefed) {
    log.append(el('div', { class: 'dz-cut mono', text:
      'This interview was never debriefed, so there is no assessment of it. '
      + (!data.resumable ? 'Its interviewer thread is gone, so it cannot be continued.'
        : data.rebuilt ? 'It can still be resumed — the interviewer’s thread was not saved, so a fresh one will read the transcript to carry on.'
          : 'It can still be resumed.') }));
  }

  const canvasHost = el('div', { class: 'dz-canvas' },
    el('div', { class: 'dz-loading mono', text: 'Loading the board…' }));

  const view = el('div', { class: 'dz-view' }, [
    el('div', { class: 'dz-bar' }, [
      el('button', { class: 'dz-back linkbtn', type: 'button', text: '← Interviews', onclick: () => onBack() }),
      el('span', { class: 'mono dz-title dzr-prompt', text: titleOf(data) }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'mono dim', text: metaOf({ ...data, turns: data.turns?.length ?? 0 }) }),
    ]),
    el('div', { class: 'dz-split' }, [
      canvasHost,
      el('div', { class: 'dz-side' }, [
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
        theme: document.body.classList.contains('theme-light') ? 'light' : 'dark',
        viewModeEnabled: true,
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

  return { destroy() { gone = true; root = null; } };
}

/* ---------------- one interview, live ---------------- */

function mountInterview(host, { level = 'L4', minutes = 45, resumed = null, onBack }) {
  let interviewId = resumed?.id ?? null;
  let api = null;               // Excalidraw's imperative handle
  let elements = resumed?.elements ?? [];
  let phase = resumed?.phase ?? 'requirements';
  let busy = false;
  let destroyed = false;
  let debriefed = false;
  let sceneTimer = null;
  let startedAt = resumed?.startedAt ? Date.parse(resumed.startedAt) || Date.now() : null;
  let clockTimer = null;
  let speaker = null;
  let voice = null;
  // Two modes, not one toggle among four buttons. They are different interactions:
  // typed is a text box you submit, voice is a conversation where going quiet IS the
  // submit. Showing a Send button in voice mode would be a lie about how it works, so
  // the compose row is rebuilt rather than decorated.
  let mode = 'type';       // 'type' | 'voice'
  const isVoice = () => mode === 'voice';
  let speakBuffer = '';    // tokens not yet formed into a speakable sentence
  let turnTimer = null;

  if (resumed?.level) level = resumed.level;
  if (Number.isFinite(resumed?.minutes)) minutes = resumed.minutes;

  /* ---- the transcript column ---- */

  const log = el('div', { class: 'dz-log' });
  const clock = el('span', { class: 'mono dz-clock', text: '00:00' });
  const phaseBar = el('div', { class: 'dz-phases' }, PHASES.map(([id, label]) =>
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
    class: 'dz-input', rows: '3', placeholder: 'Answer out loud, or type here…',
    'aria-label': 'Your answer',
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); answer(); }
    },
  });

  const sendButton = el('button', { class: 'dz-send', type: 'button', text: 'Send', onclick: () => answer() });

  const micSlot = el('span', { class: 'dz-mic' });
  const status = el('div', { class: 'dz-status mono', text: '' });

  // The switch. Always visible, because the moment you want it is the moment voice
  // has just mangled a term and you need to type the correction — hunting for a
  // control then is worse than one control that is always there.
  const modeSwitch = el('div', { class: 'dz-modes', role: 'radiogroup', 'aria-label': 'How you answer' }, [
    ['type', 'Type'], ['voice', 'Voice'],
  ].map(([id, label]) => el('button', {
    class: 'dz-mode', type: 'button', role: 'radio', dataset: { mode: id },
    'aria-checked': String(id === 'type'), text: label,
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
  const voiceState = el('div', { class: 'dz-vstate mono' }, [
    el('i', { class: 'dz-vdot' }), el('span', { class: 'dz-vlabel', text: 'Starting…' }),
  ]);
  const voiceHeard = el('div', { class: 'dz-vheard', 'aria-live': 'polite' });
  const voicePanel = el('div', { class: 'dz-voice', hidden: true }, [
    voiceState,
    voiceHeard,
    el('div', { class: 'dz-vrow' }, [
      skipButton,
      el('span', { class: 'spacer' }),
      el('span', { class: 'mono dim dz-vhint', text: 'Stop talking to send' }),
    ]),
  ]);
  const typePanel = el('div', { class: 'dz-type' }, [
    input,
    el('div', { class: 'dz-actions' }, [micSlot, el('span', { class: 'spacer' }), status, sendButton]),
  ]);

  function paintVoice(label, tone = '') {
    voiceState.querySelector('.dz-vlabel').textContent = label;
    voiceState.dataset.tone = tone;
    // The live text is what you have said this turn; it is cleared when the turn is sent.
    voiceHeard.textContent = input.value.trim();
    voiceHeard.classList.toggle('empty', input.value.trim() === '');
  }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    for (const b of modeSwitch.querySelectorAll('.dz-mode')) {
      b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    }
    typePanel.hidden = isVoice();
    voicePanel.hidden = !isVoice();
    if (isVoice()) {
      paintVoice('Listening…');
      openMic();
    } else {
      // Leaving voice must silence it as well as close the microphone, or the
      // interviewer carries on talking to a text box.
      speaker?.cancel();
      speakBuffer = '';
      closeMic();
      input.focus();
    }
  }

  function interrupt() {
    speaker?.cancel();
    speakBuffer = '';
    openMic();
  }

  function openMic() {
    if (!isVoice() || destroyed || busy) return;
    if (speaker?.speaking) return;
    try { voice?.start?.(); } catch { /* the button still works */ }
  }

  function closeMic() {
    try { if (voice?.isRecording?.()) voice.stop(); } catch { /* noop */ }
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
    if (busy) return;
    busy = true;
    sendButton.disabled = true;
    doneButton.disabled = true;
    say('thinking…');
    if (isVoice()) paintVoice('Thinking…', 'think');
    const target = entry(kind);
    let cut = false;
    try {
      await streamPost(url, body, {
        onToken: (text) => {
          target.textContent += text;
          log.scrollTop = log.scrollHeight;
          if (!isVoice()) return;
          // Speak each sentence as it completes. Waiting for the whole question would
          // add its entire generation time to the silence before the interviewer talks.
          speakBuffer += text;
          const { ready, rest } = splitForSpeech(speakBuffer);
          speakBuffer = rest;
          for (const sentence of ready) speaker?.say(sentence);
        },
        onEvent: (name, payload) => {
          if (name === 'interview') {
            interviewId = payload.id;
            startedAt = Date.parse(payload.startedAt) || Date.now();
            tickClock();
          } else if (name === 'broke-character') {
            // Said out loud rather than swallowed. The turn is about to end short and
            // the candidate deserves the real reason.
            cut = true;
          } else if (name === 'error') {
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
      if (!target.textContent.trim() && !cut) target.textContent = '…';
      if (isVoice() && speakBuffer.trim()) { speaker?.say(speakBuffer); speakBuffer = ''; }
    } catch (error) {
      target.textContent = error.message;
      target.closest('.dz-entry')?.classList.add('dz-err');
    } finally {
      busy = false;
      sendButton.disabled = false;
      doneButton.disabled = false;
      say(isVoice() ? (speaker?.speaking ? 'speaking…' : 'listening…') : '');
      // If it is still talking the speaker's own state change reopens the microphone;
      // if it never spoke, nothing else will.
      if (isVoice() && !speaker?.speaking) openMic();
    }
  }

  async function answer() {
    const said = input.value.trim();
    if (!interviewId || busy) return;
    if (said) entry('a', said);
    input.value = '';
    if (isVoice()) paintVoice('Thinking…', 'think');
    await runTurn('/api/design/turn', { interviewId, said, phase, elements });
  }

  async function finish() {
    if (!interviewId || busy) return;
    await runTurn('/api/design/done', { interviewId, elements }, { kind: 'd' });
    debriefed = true;
    doneButton.disabled = true;
    doneButton.textContent = 'Debriefed';
    if (clockTimer) clearInterval(clockTimer);
  }

  function tickClock() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(() => {
      if (destroyed || !startedAt) return;
      const s = Math.floor((Date.now() - startedAt) / 1000);
      clock.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      clock.classList.toggle('over', s > minutes * 60);
    }, 1000);
  }

  /** The canvas changed. A cheap write, never a turn. */
  function onSceneChange(next) {
    elements = next;
    if (!interviewId) return;
    clearTimeout(sceneTimer);
    // Excalidraw fires this on every pointer move; one write per quiet second is plenty,
    // and the server drops the ones that mean nothing anyway.
    sceneTimer = setTimeout(() => {
      fetch('/api/design/scene', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ interviewId, elements }),
      }).catch(() => { /* the next change will carry it */ });
    }, 1000);
  }

  /* ---- layout ---- */

  const canvasHost = el('div', { class: 'dz-canvas' },
    el('div', { class: 'dz-loading mono', text: 'Loading the whiteboard…' }));

  const view = el('div', { class: 'dz-view' }, [
    el('div', { class: 'dz-bar' }, [
      el('button', { class: 'dz-back linkbtn', type: 'button', text: '← Interviews',
        title: 'Leave this interview open and go back — the clock stops', onclick: () => onBack() }),
      el('span', { class: 'mono dz-title', text: 'System design' }),
      el('span', { class: 'mono dim', text: level }),
      clock,
      el('span', { class: 'spacer' }),
      doneButton,
    ]),
    el('div', { class: 'dz-split' }, [
      canvasHost,
      el('div', { class: 'dz-side' }, [
        phaseBar,
        log,
        el('div', { class: 'dz-compose' }, [modeSwitch, typePanel, voicePanel]),
      ]),
    ]),
  ]);
  replace(host, view);

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
      getSlug: () => '',
      logTakes: false,
      onTranscript: (text) => {
        const gap = input.value === '' || /\s$/.test(input.value) ? '' : ' ';
        input.value += gap + text;
        // In voice mode there is no text box on screen, so this is the only way to see
        // that the transcriber is keeping up with you.
        if (isVoice()) paintVoice(speaker?.speaking ? 'Speaking…' : 'Listening…');
      },
      // Going quiet is what ends a turn. The analyser already computes this signal for
      // cutting phrases; a turn just has a much longer fuse. See speech.js.
      onLevel: ({ sinceLoud, pending }) => {
        if (!isVoice() || destroyed) return;
        const decision = turnDecision({
          sinceLoud,
          chars: input.value.trim().length,
          speaking: Boolean(speaker?.speaking),
          busy,
          pending,
        });
        if (decision === 'send') { closeMic(); answer(); }
      },
    });
    micSlot.append(voice.root);
  } catch { /* typing still works */ }

  // Voice mode needs a mouth and an ear. Without either it is offered and then fails
  // silently, which is worse than not offering it.
  if (!speechSupported() || !voice) {
    const button = modeSwitch.querySelector('[data-mode="voice"]');
    button.disabled = true;
    button.title = !voice
      ? 'This browser cannot record audio, so voice mode is unavailable.'
      : 'This browser has no speech synthesis, so the interviewer cannot talk.';
  }

  /* ---- boot ---- */

  (async () => {
    try {
      const ex = await loadExcalidraw();
      if (destroyed) return;
      const root = ex.createRoot(canvasHost);
      canvasHost.querySelector('.dz-loading')?.remove();
      root.render(ex.createElement(ex.Excalidraw, {
        theme: document.body.classList.contains('theme-light') ? 'light' : 'dark',
        excalidrawAPI: (instance) => { api = instance; },
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
      replayTurns(resumed.turns, (kind, text) => entry(kind, text));
      if (resumed.rebuilt) {
        // Said plainly: the model that answers next did not ask these questions. It is
        // reading the transcript above, same as the candidate can, not remembering it.
        log.append(el('div', { class: 'dz-cut mono', text:
          'The interviewer’s thread from earlier was not saved, so the next question '
          + 'comes from a fresh read of the transcript above rather than its own memory.' }));
      }
      log.scrollTop = log.scrollHeight;
      tickClock();
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
    await runTurn('/api/design/start', { level, minutes });
    input.focus();
  })();

  return {
    destroy() {
      destroyed = true;
      clearTimeout(sceneTimer);
      if (clockTimer) clearInterval(clockTimer);
      if (turnTimer) clearInterval(turnTimer);
      window.removeEventListener('keydown', onKey);
      // Leaving the screen must silence it. A voice still reading a question from a
      // page you have navigated away from is the worst bug this feature could have.
      speaker?.dispose?.();
      voice?.dispose?.();
      if (interviewId && busy) {
        navigator.sendBeacon?.('/api/design/stop', new Blob(
          [JSON.stringify({ interviewId })], { type: 'application/json' },
        ));
      }
      // Stop the clock on the way out. Without this an interview left open overnight
      // comes back eighteen hours in, past the end of its own phase machine.
      if (interviewId && !debriefed) {
        const body = JSON.stringify({ interviewId });
        const sent = navigator.sendBeacon?.('/api/design/pause', new Blob([body], { type: 'application/json' }));
        if (!sent) {
          fetch('/api/design/pause', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true,
          }).catch(() => { /* the clock is the only casualty */ });
        }
      }
      api = null;
    },
  };
}

/* ---------------- the route ---------------- */

/**
 * The design route. Opens on the library unless a particular interview was asked for,
 * either by argument or by the `#/design/<id>` hash this reads for itself.
 */
export function initDesign(host, { level = 'L4', minutes = 45, interviewId = null } = {}) {
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

  function startNew() {
    swap(() => mountInterview(host, { level, minutes, onBack: showLibrary }));
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
