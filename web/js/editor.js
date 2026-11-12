// The code workspace: a Monaco editor bound to the working buffer, a Run button,
// and the results panel from run.js — pinned beside the statement so reading and
// writing happen in the same glance.
//
// Two rules shape this file.
//
//   1. The buffer is the one irreplaceable thing here. Every keystroke is
//      mirrored to localStorage before anything else is attempted, so a server
//      that is down, old, or mid-restart cannot cost a line of code. The save
//      state is always shown honestly — "saved to disk" and "kept in this
//      browser" are never allowed to look the same.
//   2. The editor is a keyboard trap by design: main.js owns a global key map
//      (j/k/s/a/Enter) that would fire while typing, so keydown is stopped at the
//      workspace boundary and re-implemented here for the few keys that matter.
//
// Monaco is vendored under web/vendor/monaco — no CDN, no build step. If it
// fails to load for any reason the workspace falls back to a plain textarea and
// keeps working; losing syntax colour is survivable, losing the editor is not.

import { el, clear, replace } from './dom.js';
import { createPythonEditorControls, mountPythonEditor } from './python-editor.js';
export { loadMonaco, monacoThemeFor } from './python-editor.js';
import { loadCode, saveCode, readDraft, writeDraft, fallbackStub, logSessionEvent, api } from './api.js';
import { registerActionHandlers, createMonacoTutor, createTextareaTutor } from './coach-actions.js';
import { createRunPanel, summaryLine } from './run.js';
import { createSubmitPanel, submitLine } from './submit.js';
import { neetcodeMismatch } from './neetcode-shape.js';
import { celebrate } from './celebrate.js';
import { onChord, chordLabel } from './shortcuts.js';
import { icon } from './ui/icon.js';
import { claimActionKey, hasOpenOverlay, isTextEntry } from './keyboard.js';

const SAVE_DEBOUNCE_MS = 900;
const DRAFT_DEBOUNCE_MS = 300;
const SAVE_RETRY_MS = 5000;
const FOCUS_KEY = 'studio.editor.focus.v1';
const PANEL_KEY = 'studio.editor.panel.v1';

/* --------------------------------- helpers -------------------------------- */

function clockOf(iso) {
  if (!iso) return '';
  const when = new Date(iso);
  if (isNaN(when.getTime())) return '';
  return when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The save indicator. Wording is the whole point: "kept in this browser" and
 *  "saved" must never be mistaken for each other. */
const SAVE_STATES = {
  loading: { tone: 'dim', text: 'Loading…' },
  stub: { tone: 'dim', text: 'Starter code — nothing saved yet' },
  clean: { tone: 'ok', text: 'Saved' },
  dirty: { tone: 'dim', text: 'Editing…' },
  saving: { tone: 'dim', text: 'Saving…' },
  local: { tone: 'warn', text: 'Browser only' },
  failed: { tone: 'bad', text: 'Not saved' },
};

/* -------------------------------- workspace -------------------------------- */

let active = null;

/**
 * Build the workspace for one problem. Returns the element to place in the DOM;
 * everything else (loading, autosave, teardown) is handled internally.
 */
export function mountWorkspace(entry, options = {}) {
  if (active) active.dispose();

  const slug = entry.slug;
  let premium = false;
  let neetcodeShape = null;
  let contentReady = !options.contentPromise;
  let editor = null;
  let loaded = null;            // last value known to match the server; null = none does
  let stubCode = null;          // the starter, while we still have it
  let saveState = 'loading';
  let saveDetail = '';
  let savedAt = null;
  let touched = false;          // the stub is never written back; only real edits are
  let saveTimer = null;
  let saveChain = Promise.resolve();
  let draftTimer = null;
  let retryTimer = null;
  let disposed = false;
  let lane = 'run';             // which results lane is open; the other is a stub
  let tutor = null;             // the tutor's marks and edits, once the editor exists
  const releaseChords = [];

  /* ---- chrome ---- */

  const statusEl = el('span', { class: 'ws-status mono' });
  const runLabel = el('span', { text: 'Run' });
  const runButton = el('button', {
    class: 'btn btn--secondary ws-run', type: 'button',
    title: "Run against the example cases on this machine (⌘')",
    onclick: () => doRun(),
  }, [runLabel, el('kbd', { text: "⌘'" })]);

  // Reset throws away everything you wrote, so it asks once. A single stray click on a
  // small button in a toolbar is not enough intent to delete a solution — and the button
  // sits next to Run and Submit, which are clicked constantly.
  let resetArmed = null;

  function disarmReset() {
    if (resetArmed) clearTimeout(resetArmed);
    resetArmed = null;
    revertButton.classList.remove('is-arming');
    revertLabel.textContent = 'Reset code';
    revertButton.title = 'Put LeetCode\'s starter code back. What you wrote is not kept.';
  }

  // It lives in the file row, beside the file it resets, and away from Run and Submit.
  const revertLabel = el('span', { class: 'ws-reset-label', text: 'Reset code' });
  const revertButton = el('button', {
    class: 'btn btn--icon editor-tool ws-reset', type: 'button', hidden: true,
    title: 'Put LeetCode\'s starter code back. What you wrote is not kept.',
    onclick: () => {
      if (stubCode === null || !editor) return;
      if (!resetArmed) {
        revertButton.classList.add('is-arming');
        revertLabel.textContent = 'Discard your code?';
        revertButton.title = 'Click again to replace what you wrote with the starter.';
        // Disarms itself, so a click you walked away from is not still loaded.
        resetArmed = setTimeout(disarmReset, 4000);
        return;
      }
      disarmReset();
      editor.setValue(stubCode);
      onEdit();
      editor.focus();
    },
  }, [icon('reset', 14), revertLabel]);

  const editorControls = createPythonEditorControls();

  // Hiding the sidebar must never be one-way. Shown only while it is closed.
  const sidebarButton = el('button', {
    class: 'btn btn--icon icon-btn editor-open-sidebar', type: 'button',
    'aria-label': `Show sidebar · ${chordLabel('coach')}`,
    title: `Show sidebar (${chordLabel('coach')})`,
    onclick: () => window.dispatchEvent(new CustomEvent('studio:open-coach')),
  }, [icon('sidebar', 16)]);

  // Two collapses, one button each, and the same chord from anywhere on the page.
  // There used to be a Problem button *and* a Focus button doing opposite halves of the
  // same job; hiding the statement IS focus mode, so there is one of them now.
  const probButton = el('button', {
    class: 'btn btn--quiet ws-mini prob-toggle', type: 'button', 'aria-pressed': 'true',
    title: `Show or hide the problem statement (${chordLabel('problem')})`,
    onclick: () => setProblemHidden(!isProblemHidden()),
  }, [el('span', { class: 'ws-problabel', text: 'Problem' }), el('kbd', { text: chordLabel('problem') })]);

  // Submit is a different act from Run and is built to read as one: its own button, its
  // own colour, its own panel. ⌘↵ sends it, because that is the key his hands already
  // reach for; ⌘' runs. The confirmation that a submission is deliberate lives in
  // doSubmit, not in an extra modifier nobody remembers.
  const submitLabel = el('span', { text: 'Submit' });
  const submitButton = el('button', {
    class: 'btn btn--primary ws-submit', type: 'button', disabled: !contentReady,
    title: 'Send this code to LeetCode and run every hidden test (⌘↵)',
    onclick: () => doSubmit(),
  }, [submitLabel, el('kbd', { text: '⌘↵' })]);

  options.contentPromise?.then((result) => {
    if (disposed) return;
    contentReady = result.ok === true;
    premium = result.content?.isPaidOnly === true;
    neetcodeShape = premium ? result.content?.neetcodeShape : null;
    const starter = result.content?.codeSnippets?.find(s => s.langSlug === 'python3')?.code;
    if (starter) stubCode = starter;
    paintNeetCodeNotice();
    submitButton.disabled = !contentReady;
    if (premium) {
      submitLabel.textContent = 'Submit on NeetCode';
      submitButton.title = 'Send this code to NeetCode’s judge through the Studio Connector (⌘↵)';
    }
  }).catch(() => {});

  const noticeEl = el('div', { class: 'ws-notice ui-inset ui-cluster', hidden: true });
  const shapeNotice = el('div', { class: 'ws-notice ui-inset ui-cluster warn', hidden: true, role: 'status' });
  const host = el('div', { class: 'ws-host' });

  const panel = createRunPanel({ slug, getCode: () => (editor ? editor.getValue() : ''), onCollapse: () => setResultsHidden(true), onEvent: onRunEvent });
  const judge = createSubmitPanel({
    slug,
    getCode: () => (editor ? editor.getValue() : ''),
    // Premium problems are judged on neetcode.io (docs/SUBMITTING.md).
    getTarget: () => (premium ? 'neetcode' : 'leetcode'),
    getMismatch: currentMismatch,
    neetcodeSlug: entry.neetcodeSlug || entry.slug,
    onEvent: (event) => {
      onSubmitEvent(event);
      // onSubmitEvent puts the plain "Submit" label back; a premium problem keeps its own.
      if (premium && event.type !== 'start') submitLabel.textContent = 'Submit on NeetCode';
    },
    // A wrong answer hands back the exact input that broke. It belongs in the local
    // cases, not just on screen.
    onUseFailingCase: (detail) => {
      panel.addFailingCase(detail);
      // The case it died on is now in the local editor, so that is the lane to be in.
      showResults('run');
    },
  });

  // The verdict and the local results each keep their own label, because "3 example
  // cases passed here" and "64 hidden tests passed on LeetCode" must never be readable
  // as the same sentence.
  //
  // They are also never both open. They used to stack, so one submission left its
  // verdict — headline, stats, percentiles, resubmit button — sitting on top of every
  // local run for the rest of the session, and pressing Run landed you on last
  // submission's news instead of what you just asked for. The pane shows the lane you
  // asked for; the other collapses to one line that says what it is holding, so
  // nothing is lost and one click brings it back.
  const judgeStub = el('button', {
    class: 'btn btn--quiet ws-stub', type: 'button', hidden: true,
    onclick: () => showResults('judge'),
  });
  const runStub = el('button', {
    class: 'btn btn--quiet ws-stub', type: 'button', hidden: true,
    onclick: () => showResults('run'),
  });
  const runLane = el('div', { class: 'ws-lane' }, panel.root);
  const judgeLane = el('div', { class: 'ws-lane', hidden: true }, judge.root);
  const results = el('div', { class: 'ws-results' }, [
    judgeStub, judgeLane, runStub, runLane,
  ]);

  // The cursor position rides in the file tab row. A status bar under the results said
  // "Python 3 · UTF-8 · 4 spaces", which never change, and cost a row of editor height.
  // Only there while the tutor has lines marked: what they are, and one click to clear them.
  const marksCount = el('span', { class: 'tutor-chip-n' });
  const marksChip = el('button', {
    class: 'btn btn--quiet tutor-chip', type: 'button', hidden: true,
    title: 'Clear the lines your tutor marked',
    onclick: () => { tutor?.clearMarks(); },
  }, [icon('report', 15), marksCount, icon('close', 15)]);
  function paintMarks(count) {
    marksChip.hidden = count === 0;
    marksCount.textContent = `${count} tutor mark${count === 1 ? '' : 's'}`;
    marksChip.setAttribute('aria-label', `Clear ${count} tutor mark${count === 1 ? '' : 's'}`);
  }
  const editorTabs = el('div', { class: 'editor-tabs' }, [
    el('span', { class: 'editor-file' }, [el('span', { class: 'file-language', text: 'PY' }), el('span', { text: 'solution.py' })]),
    el('span', { class: 'editor-meta' }, [
      marksChip,
      el('span', { class: 'editor-path mono', text: `problems/${slug}/solution.py` }),
      editorControls.root,
      revertButton,
      sidebarButton,
    ]),
  ]);
  const root = el('section', { class: 'card ws' }, [
    editorTabs,
    noticeEl,
    shapeNotice,
    host,
    el('div', { class: 'ws-bar' }, [
      el('span', { class: 'mono dim ws-title', text: 'Python' }),
      // Keep the problem identifiable when its statement is hidden.
      el('span', { class: 'ws-probtitle', text: entry.title || slug }),
      statusEl,
      el('span', { class: 'spacer' }),
      probButton,
      // Run, then Submit. Run is the one pressed fifty times an hour and Submit is the one
      // that leaves the machine, so the safe one comes first and the irreversible one sits
      // on its own at the end.
      runButton,
      submitButton,
    ]),
    results,
  ]);

  if (options.headerActions) {
    options.headerActions({ run: runButton, submit: submitButton, reset: revertButton, status: statusEl });
    // The screen rail owns these controls in the three-pane coding workspace.
    root.append(el('div', { hidden: true }, probButton));
    root.querySelector('.ws-bar').remove();
  }

  /* ---- save state ---- */

  function paintStatus() {
    const preset = SAVE_STATES[saveState] || SAVE_STATES.dirty;
    clear(statusEl);
    statusEl.dataset.tone = preset.tone;
    let label = preset.text;
    if (saveState === 'clean' && savedAt) label = 'Saved ' + clockOf(savedAt);
    statusEl.append(el('span', { text: label }));
    // The reason only belongs in the bar when there is no notice carrying it.
    if (saveDetail && saveState === 'failed') statusEl.append(el('span', { class: 'ws-status-why', text: saveDetail }));
    if (saveState === 'failed') {
      statusEl.append(el('button', { class: 'btn btn--quiet ws-retry', type: 'button', text: 'Retry', onclick: () => flush() }));
    }
    const nothingToReset = stubCode === null || !editor || editor.getValue() === stubCode;
    if (nothingToReset && resetArmed) disarmReset();
    revertButton.hidden = nothingToReset;
  }

  function setSave(state, detail = '') {
    saveState = state; saveDetail = detail; paintStatus();
  }

  function flush() {
    if (disposed || !editor || !touched) return Promise.resolve(true);
    const code = editor.getValue();
    const task = saveChain.catch(() => false).then(() => persistCode(code));
    saveChain = task;
    return task;
  }

  async function persistCode(code) {
    // Nothing the user wrote, nothing to write. This is what keeps an untouched
    // stub from ever being PUT back over the server's copy.
    if (code === loaded && saveState !== 'failed') { if (!disposed) setSave('clean'); return true; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    setSave('saving');
    const result = await saveCode(slug, code);
    if (disposed) return result.ok === true;
    if (result.ok) {
      loaded = code;
      savedAt = result.updatedAt || new Date().toISOString();
      setSave(editor.getValue() === code ? 'clean' : 'dirty');
      return true;
    }
    if (result.kind === 'unavailable') {
      // A server without the endpoint is a real state, not a transient error.
      setSave('local', result.source === 'mock' ? '' : 'this server has no save endpoint');
      return false;
    }
    setSave('failed', result.message || '');
    retryTimer = setTimeout(() => { retryTimer = null; flush(); }, SAVE_RETRY_MS);
    return false;
  }

  function onEdit() {
    if (!editor) return;
    touched = true;
    window.dispatchEvent(new CustomEvent('studio-interview-work', { detail: { slug, type: 'typing' } }));
    paintNeetCodeNotice();
    if (saveState !== 'failed' && saveState !== 'local') setSave('dirty');
    else paintStatus();

    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => writeDraft(slug, editor.getValue()), DRAFT_DEBOUNCE_MS);

    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flush(), SAVE_DEBOUNCE_MS);
  }

  function flushNow() {
    clearTimeout(draftTimer);
    if (editor && touched) writeDraft(slug, editor.getValue());
    clearTimeout(saveTimer);
    return flush();
  }

  function currentMismatch() {
    if (!premium || !editor) return null;
    const mismatch = neetcodeMismatch(editor.getValue(), neetcodeShape);
    if (!mismatch) return null;
    return { ...mismatch, fix: mismatch.rename && editor.kind === 'monaco' ? renameNeetCodeMethod : null };
  }

  function renameNeetCodeMethod() {
    const mismatch = currentMismatch();
    if (!mismatch?.rename || editor.kind !== 'monaco') return;
    const { instance } = editor.raw;
    const model = instance.getModel();
    const start = model.getPositionAt(mismatch.rename.start);
    const end = model.getPositionAt(mismatch.rename.end);
    instance.pushUndoStop();
    instance.executeEdits('neetcode-method-name', [{
      range: { startLineNumber: start.lineNumber, startColumn: start.column,
        endLineNumber: end.lineNumber, endColumn: end.column },
      text: mismatch.rename.to,
    }]);
    instance.pushUndoStop();
    editor.focus();
  }

  function paintNeetCodeNotice() {
    const mismatch = currentMismatch();
    shapeNotice.hidden = !mismatch;
    replace(shapeNotice, mismatch ? [
      el('span', { class: 'ws-noticebody', text: mismatch.message }),
      ...(mismatch.fix ? [el('button', { class: 'btn btn--quiet ws-mini', type: 'button',
        text: "Use NeetCode's name", onclick: mismatch.fix })] : []),
    ] : []);
  }

  /* ---- notices ---- */

  function showNotice({ tone = '', head, body, actions = [] }) {
    noticeEl.hidden = false;
    noticeEl.className = 'ws-notice ' + tone;
    replace(noticeEl, [
      el('span', { class: 'mono ws-noticehead', text: head }),
      el('span', { class: 'ws-noticebody', text: body }),
      ...actions.map(a => el('button', { class: 'btn btn--quiet ws-mini', type: 'button', text: a.label, onclick: a.onClick })),
      el('button', { class: 'btn btn--icon ws-noticex', type: 'button', 'aria-label': 'Dismiss', onclick: () => { noticeEl.hidden = true; } }, icon('close')),
    ]);
  }

  /* ---- run ---- */

  function doRun() {
    if (panel.isRunning()) return;
    flushNow();                       // the file on disk should match what ran
    // Asking for results is asking to see them. Leaving the pane collapsed meant pressing
    // Run and watching nothing happen, then having to open the panel yourself.
    showResults('run');
    panel.run();
  }

  function onRunEvent(event) {
    if (event.type === 'result') {
      const result = event.shaped;
      window.dispatchEvent(new CustomEvent('studio-interview-work', { detail: {
        slug, type: 'run_result', ...result?.summary,
        firstFailingCase: (() => { const item = result?.cases?.find(item => !item.passed); return item ? Object.fromEntries(Object.entries(item).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 2000) : value])) : null; })(),
        error: result?.message || result?.traceback || null,
      } }));
    }
    if (event.type === 'start') {
      runButton.disabled = true;
      runLabel.textContent = 'Running';
      runButton.classList.add('busy');
    } else {
      runButton.disabled = false;
      runLabel.textContent = 'Run';
      runButton.classList.remove('busy');
      results.scrollTop = 0;
    }
    // Keep the collapsed line honest about what it is holding.
    showLane(lane);
  }

  /* ---- submit ---- */

  // Reached from the Submit button or ⌘↵ in the workspace, and from nothing else — no
  // timer, no retry path, no batching. That is what keeps "one submission per explicit
  // user action" true rather than aspirational; a keystroke he aimed at the code is an
  // explicit action, one aimed at another box or a second attempt fired by the app is not.
  // scripts/check-submit-keys.mjs holds the ⌘↵ boundary.
  function doSubmit() {
    if (!contentReady || !editor || judge.isBusy()) return;
    // Premium problems are submitted on NeetCode through the Studio Connector, in the
    // same panel. Only when the Connector is missing or too old to do that (an old one
    // would send it to LeetCode instead) does it fall back to copy-and-open, and the
    // panel says why. That check happens here, inside the gesture, because a popup
    // opened after an await gets blocked.
    if (currentMismatch()) {
      showResults('judge');
      judge.submit(); // The panel guard also covers its own resubmit button.
      return;
    }
    const blocker = premium ? judge.blocker() : '';
    if (blocker) {
      const code = editor.getValue();
      window.open(`https://neetcode.io/problems/${encodeURIComponent(entry.neetcodeSlug || entry.slug)}/question`, '_blank', 'noopener,noreferrer');
      showResults('judge');
      judge.explain(blocker, 'Studio opened the problem on NeetCode and copied your code instead: paste it into NeetCode’s editor and submit there. Studio has not submitted it.');
      Promise.resolve().then(() => navigator.clipboard.writeText(code)).then(() => {
        if (!disposed) showNotice({ head: 'Code copied — paste it into NeetCode and submit there', body: '' });
      }).catch(() => {
        if (!disposed) showNotice({ head: 'NeetCode opened', body: 'Copy your code and paste it into NeetCode to submit.' });
      });
      results.scrollTop = 0;
      return;
    }
    flushNow();                       // what is judged should be what is on disk
    showResults('judge');
    judge.submit();
    results.scrollTop = 0;
  }

  function onSubmitEvent(event) {
    if (event.type === 'result') window.dispatchEvent(new CustomEvent('studio-interview-work', { detail: {
      slug, type: 'verdict', verdict: event.shaped?.headline || event.shaped?.status,
      status: event.shaped?.status, accepted: event.shaped?.status === 'accepted',
    } }));
    const busy = event.type === 'start';
    submitButton.disabled = busy;
    submitButton.classList.toggle('busy', busy);
    submitLabel.textContent = busy ? 'Judging' : 'Submit';
    if (!busy) results.scrollTop = 0;
    showLane(lane);
    if (event.type === 'result' && event.shaped?.status === 'accepted') celebrate({ origin: submitButton.getBoundingClientRect() });
  }

  /* ---- the two collapses ---- */

  // `aria-pressed` tracks whether the pane is SHOWING, so the button reads as a pane that
  // is on rather than a hide-action that is stuck down.
  const isProblemHidden = () => document.body.classList.contains('hide-problem');
  const isResultsHidden = () => document.body.classList.contains('hide-results');

  function remember(key, on) {
    try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* noop */ }
  }

  function setProblemHidden(on) {
    document.body.classList.toggle('hide-problem', on);
    probButton.setAttribute('aria-pressed', String(!on));
    remember(FOCUS_KEY, on);
    // The editor is a fixed-size canvas that does not notice its box changed.
    if (editor) setTimeout(() => editor.layout?.(), 0);
  }

  function setResultsHidden(on) {
    document.body.classList.toggle('hide-results', on);
    remember(PANEL_KEY, on);
    if (editor) setTimeout(() => editor.layout?.(), 0);
  }

  /**
   * Show one lane and collapse the other to its one-line stub.
   *
   * The stub is only offered when there is something behind it. A lane that has never
   * produced anything gets no line, because "Submission" with nothing after it invites a
   * click that opens an empty box.
   */
  function showLane(which) {
    lane = which;
    const onJudge = which === 'judge';
    const verdict = judge.lastResult();
    const local = panel.lastResult();

    judgeLane.hidden = !onJudge;
    runLane.hidden = onJudge;

    // Judging and Running each replace their lane's contents, so a lane that is working
    // has something to show even before it has a result.
    judgeStub.hidden = onJudge || (!verdict && !judge.isBusy());
    runStub.hidden = !onJudge;

    if (!judgeStub.hidden) {
      replace(judgeStub, [
        el('span', { class: 'mono ws-stubmark', text: 'Submission' }),
        el('span', { class: 'ws-stubline', text: judge.isBusy() ? `Judging on ${judge.targetName?.() || 'LeetCode'}…` : submitLine(verdict) }),
      ]);
      judgeStub.dataset.tone = verdict?.tone ?? '';
    }
    if (!runStub.hidden) {
      replace(runStub, [
        el('span', { class: 'mono ws-stubmark', text: 'Local run' }),
        el('span', {
          class: 'ws-stubline',
          text: panel.isRunning() ? 'Running…' : (summaryLine(local) || 'your test cases'),
        }),
      ]);
      runStub.dataset.tone = local && !panel.isRunning() ? (local.tone ?? '') : '';
    }
  }

  /** Bring one lane's results into view — expanded, opened, and scrolled to the top. */
  function showResults(which = 'run') {
    showLane(which);
    results.classList.add('open');
    setResultsHidden(false);
    results.scrollTop = 0;
  }

  const stored = (key) => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };
  setProblemHidden(stored(FOCUS_KEY));
  setResultsHidden(stored(PANEL_KEY));

  releaseChords.push(onChord('problem', () => setProblemHidden(!isProblemHidden())));
  releaseChords.push(onChord('results', () => setResultsHidden(!isResultsHidden())));

  /* ---- keyboard ---- */

  // main.js listens on document and would act on j/k/s/a/Enter while typing.
  // The code area is where that map stops — and only the code area, so that
  // Escape can hand the keyboard back by moving focus to the toolbar.
  root.addEventListener('keydown', (event) => {
    if (host.contains(event.target)) event.stopPropagation();
    if (hasOpenOverlay() || isTextEntry(event.target)) return;
    const meta = (event.metaKey || event.ctrlKey) && !event.altKey;
    // ⌘↵ submits, ⌘' runs. ⌘⇧↵ stays a submit alias so the old binding still works.
    if (meta && event.key === 'Enter') { if (claimActionKey(event)) doSubmit(); return; }
    if (meta && event.key === "'") { if (claimActionKey(event)) doRun(); return; }
    if (meta && (event.key === 's' || event.key === 'S')) { if (claimActionKey(event)) flushNow(); return; }
    if (event.key === 'Escape' && editor && editor.hasFocus()) {
      event.preventDefault();
      editor.blur();
      runButton.focus();
    }
  });

  function onDocumentKey(event) {
    if (disposed || !document.body.contains(root)) return;
    // Inside the workspace, the listener above has already acted.
    if (root.contains(event.target)) return;
    // ⌘↵ sends code to a real judge, and this workspace stays mounted under the report,
    // Settings and the reference drawer. So only with nothing focused or from the
    // statement beside the code: every other box on the page has its own ⌘↵.
    if (hasOpenOverlay() || isTextEntry(event.target) || event.altKey) return;
    if (event.target !== document.body && !event.target.closest?.('.pcol, .ui-screen-header')) return;
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      if (claimActionKey(event)) doSubmit(); return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "'") {
      if (claimActionKey(event)) doRun(); return;
    }
    // No bare letters here any more. `f` and `p` toggled panes only while the cursor
    // happened to be nowhere, and typed themselves the rest of the time; both moved to
    // chords in shortcuts.js, which work whether or not you are typing.
  }
  document.addEventListener('keydown', onDocumentKey);

  const onToggleResults = () => setResultsHidden(!isResultsHidden());
  window.addEventListener('studio:toggle-results', onToggleResults);

  function onHide() { if (document.visibilityState === 'hidden') flushNow(); }
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flushNow);

  /* ---- boot ---- */

  async function boot() {
    host.append(el('div', { class: 'ws-loading' }, el('div', { class: 'mono dim', text: 'Opening the editor…' })));
    setSave('loading');

    const [result] = await Promise.all([loadCode(slug, entry)]);
    if (disposed) return;

    // A fresh buffer can wait for the mirror; existing work must open immediately.
    if (result.ok && result.isStub && options.contentPromise) {
      const problem = await options.contentPromise.catch(() => null);
      if (disposed) return;
      const starter = problem?.content?.codeSnippets?.find(s => s.langSlug === 'python3')?.code;
      if (starter) { result.code = starter; result.stub = starter; }
    }
    const draft = readDraft(slug);
    let text = '';
    let restored = false;

    if (result.ok) {
      text = result.code;
      // The starter, kept whether or not the buffer already is it — Reset needs it most
      // once you have written over it.
      stubCode = result.stub ?? (result.isStub ? result.code : null);
      loaded = result.code;
      savedAt = result.updatedAt;
      // An unsynced draft that disagrees with the server always wins. Losing
      // work to a stale server copy is the one unrecoverable mistake here.
      if (draft && draft.code !== result.code && draft.savedAt && draft.savedAt !== draft.syncedAt) {
        text = draft.code;
        restored = true;
      }
      setSave(result.source === 'mock' ? 'local' : (result.isStub ? 'stub' : 'clean'));
    } else {
      // Nothing on the server matches this buffer, so `loaded` stays null and
      // every save attempt below is a real attempt.
      stubCode = result.stub ?? fallbackStub(slug, entry);
      text = draft ? draft.code : stubCode;
      setSave('local', result.kind === 'unavailable' ? 'this server has no save endpoint' : (result.message || ''));
    }

    if (text === '') text = fallbackStub(slug, entry);

    clear(host);
    editor = mountPythonEditor(host, text, {
      controls: editorControls, onChange: onEdit,
      onRun: doRun, onSubmit: doSubmit, onSave: flushNow,
      onEscape: () => { editor.blur(); runButton.focus(); },
    });
    const { error: failure } = await editor.ready;
    if (disposed) return;
    paintNeetCodeNotice();
    tutor = editor.kind === 'monaco'
      ? createMonacoTutor(editor.raw.instance, editor.raw.monaco, { onMarksChange: paintMarks })
      : createTextareaTutor(editor.raw.area, { onEdit });
    paintStatus();

    if (failure) {
      showNotice({
        tone: 'warn',
        head: 'Plain editor',
        body: 'Monaco could not be loaded from web/vendor/monaco, so this is a plain text box. Everything else — autosave, Run, results — works exactly the same.',
      });
    } else if (restored) {
      showNotice({
        tone: 'warn',
        head: 'Draft restored',
        body: 'This browser had unsaved changes that differ from the copy on disk. Yours are loaded and nothing was overwritten.',
        actions: [{
          label: 'Load the copy on disk instead',
          onClick: () => { editor.setValue(result.code); onEdit(); noticeEl.hidden = true; },
        }],
      });
    } else if (!result.ok) {
      showNotice({
        tone: 'warn',
        head: 'Not saving to disk',
        body: result.kind === 'unavailable'
          ? 'This server has no endpoint for the working buffer yet. Your code is kept in this browser and syncs the moment it does.'
          : (result.message || 'The working buffer could not be read.') + ' Your code is kept in this browser.',
      });
    } else if (result.source === 'mock') {
      showNotice({
        tone: 'warn',
        head: 'Browser only',
        body: 'The studio server is not running, so this buffer lives in this browser and nothing is written to ~/LeetCodeTutor yet.',
      });
    }
  }

  boot();

  /* ---- the tutor's hands (coach-actions.js) ---- */

  const notReady = () => ({ ok: false, message: 'The editor is still opening; try again in a moment.' });
  const unregisterActions = registerActionHandlers(slug, {
    markLines: (args) => (tutor ? tutor.markLines(args) : notReady()),
    clearMarks: () => (tutor ? tutor.clearMarks() : { ok: true, message: 'There were no marks to clear.' }),
    async editCode(args, action) {
      if (!tutor || !editor) return notReady();
      const isStub = stubCode !== null && editor.getValue() === stubCode;
      const result = tutor.editCode(args, { isStub, actionId: action?.id ?? null });
      if (!result.ok) return result;
      // The next run_code reads solution.py from disk, so this cannot wait for the
      // debounce. Same path as ⌘S: browser mirror first, then the real save.
      if (!await flushNow()) return { ok: false, message: 'The editor changed, but saving failed. The draft is visible; use editor Undo to revert.' };
      logSessionEvent(slug, 'coach_edited_code', {
        why: String(args?.why ?? '').slice(0, 4000), added: result.added, removed: result.removed,
      }).catch(() => {});
      return { ok: true, message: result.message };
    },
    async undoEdit(actionId) {
      if (!tutor) return notReady();
      const result = tutor.undoEdit(actionId);
      if (result.ok && !await flushNow()) return { ok: false, message: 'Undo changed the editor, but saving failed.' };
      return result;
    },
    async openPanel(which) {
      const kind = which === 'solution' || which === 'article' ? which : null;
      if (!kind) return { ok: false, message: 'panel must be "solution" or "article".' };
      if (kind === 'solution' && entry.hasPythonSolution === false) {
        return { ok: false, message: 'Studio has no reference solution for this problem.' };
      }
      if (kind === 'article' && entry.hasArticle === false) {
        return { ok: false, message: 'Studio has no article for this problem.' };
      }
      // Loaded when needed: problem.js imports this file.
      const problem = await import('./problem.js');
      if (problem.isDrawerOpen() && problem.drawerKind() === kind) {
        return { ok: true, message: `The ${kind} is already open.` };
      }
      // Not awaited: it logs revealed_* itself once the panel has actually loaded.
      problem.openPanel(entry, kind);
      return { ok: true, message: `Opened the ${kind} panel.` };
    },
    refreshCases(select) {
      if (disposed) return;
      showResults('run');
      panel.reloadCases({ select });
    },
    showTutorRun(raw) {
      if (disposed || panel.isRunning()) return;
      showResults('run');
      panel.showTutorRun(raw);
    },
  });

  active = {
    root,
    slug,
    focus: () => editor && editor.focus(),
    getCode: () => editor?.getValue() ?? null,
    async loadSubmission(code) {
      if (!editor) return 'The editor is still opening.';
      if (editor.getValue() === code) return 'The editor already contains this code.';
      const before = editor.getValue();
      writeDraft(slug, before);
      const saved = await saveCode(slug, before);
      if (!saved.ok || saved.source === 'mock') return 'The current buffer could not be saved. Nothing was replaced.';
      if (editor.getValue() !== before) return 'The buffer changed while saving. Nothing was replaced.';
      editor.raw.instance?.pushUndoStop();
      editor.setValue(code);
      editor.raw.instance?.pushUndoStop();
      onEdit();
      return null;
    },
    addFailingCase: detail => { panel.addFailingCase(detail); showResults('run'); },
    jumpToLine: line => {
      if (editor?.raw.instance) { editor.raw.instance.revealLineInCenter(line); editor.raw.instance.setPosition({ lineNumber: line, column: 1 }); editor.focus(); }
      else if (editor?.raw.area) { const area = editor.raw.area; const at = area.value.split('\n').slice(0, line - 1).join('\n').length; area.focus(); area.setSelectionRange(at, at); }
    },
    run: doRun,
    /** Save now if there is anything unsaved; resolves when the save has finished. */
    flushSave() {
      clearTimeout(draftTimer);
      if (editor && touched) writeDraft(slug, editor.getValue());
      clearTimeout(saveTimer);
      return flush();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(draftTimer); clearTimeout(saveTimer); clearTimeout(retryTimer);
      // Leaving the page mid-debounce must not strand an edit in the browser:
      // mirror it locally AND make one last attempt at the real save.
      if (editor && touched) {
        const code = editor.getValue();
        try { writeDraft(slug, code); } catch { /* noop */ }
        if (code !== loaded) saveChain.catch(() => false).then(() => saveCode(slug, code)).catch(() => {});
      }
      document.removeEventListener('keydown', onDocumentKey);
      for (const release of releaseChords) release();
      window.removeEventListener('studio:toggle-results', onToggleResults);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flushNow);
      unregisterActions();
      tutor?.dispose();
      panel.dispose();
      judge.dispose();
      if (editor) editor.dispose();
      if (active && active.root === root) active = null;
    },
  };
  return root;
}

/**
 * Get the buffer for `slug` onto disk before something reads it there (the coach reads
 * the SAVED solution.py; the editor saves on a 900 ms debounce).
 *
 * Bounded and quiet: resolves true when a save finished (or nothing needed saving), false
 * when this problem is not open, the save failed, or it took longer than `capMs`. Never
 * throws, never hangs the caller.
 */
export async function flushEditorSave(slug, capMs = 2000) {
  if (!active || active.slug !== slug || typeof active.flushSave !== 'function') return false;
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(active.flushSave()).then(saved => saved !== false, () => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), capMs); }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Wide page only makes sense while the workspace is up. */
export function enableWideLayout(on) {
  document.body.classList.toggle('ws-wide', on);
  if (!on) document.body.classList.remove('hide-problem', 'hide-results');
}

// Leaving the problem screen tears the workspace down. This listener is
// registered at import time, which is before main.js registers its own, so it
// runs first and the class is gone before the next screen paints.
window.addEventListener('hashchange', () => {
  if (!/^#\/p\//.test(location.hash)) {
    enableWideLayout(false);
    if (active) active.dispose();
  }
});

/**
 * Contract-shaped entry point, for wiring from main.js instead of problem.js.
 * `mountEl` is emptied and given the workspace for whatever problem the hash
 * currently names.
 */
export function init(mountEl, apiState) {
  const match = /^#\/p\/(.+)$/.exec(location.hash);
  if (!match) return null;
  const slug = decodeURIComponent(match[1]);
  enableWideLayout(true);
  replace(mountEl, mountWorkspace({ slug, title: slug }));
  return active;
}

export function submissionEditor(slug) {
  return active?.slug === slug ? active : null;
}
