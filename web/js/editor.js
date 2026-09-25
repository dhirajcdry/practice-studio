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
import { getSettings, onSettingsChange } from './settings.js';
import { loadCode, saveCode, readDraft, writeDraft, fallbackStub, api } from './api.js';
import { createRunPanel, summaryLine } from './run.js';
import { createSubmitPanel, submitLine } from './submit.js';
import { onChord, chordLabel } from './shortcuts.js';

const MONACO_BASE = new URL('../vendor/monaco/vs', import.meta.url).href;
const SAVE_DEBOUNCE_MS = 900;
const DRAFT_DEBOUNCE_MS = 300;
const SAVE_RETRY_MS = 5000;
const FOCUS_KEY = 'studio.editor.focus.v1';
const PANEL_KEY = 'studio.editor.panel.v1';

/* ------------------------------ Monaco loading ----------------------------- */

let monacoPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = src;
    tag.onload = () => resolve();
    tag.onerror = () => reject(new Error('could not load ' + src));
    document.head.append(tag);
  });
}

/** Resolves to the monaco namespace, or rejects — callers must handle both. */
function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = (async () => {
    if (!window.require) {
      window.MonacoEnvironment = { baseUrl: MONACO_BASE.replace(/\/vs$/, '') };
      await loadScript(MONACO_BASE + '/loader.js');
    }
    if (!window.require || typeof window.require.config !== 'function') {
      throw new Error('the Monaco loader did not initialise');
    }
    window.require.config({ paths: { vs: MONACO_BASE } });
    const monaco = await new Promise((resolve, reject) => {
      const bail = setTimeout(() => reject(new Error('Monaco took too long to load')), 15000);
      try {
        window.require(['vs/editor/editor.main'], () => { clearTimeout(bail); resolve(window.monaco); });
      } catch (error) { clearTimeout(bail); reject(error); }
    });
    if (!monaco) throw new Error('Monaco loaded but exposed nothing');
    defineTheme(monaco);
    return monaco;
  })().catch(error => { monacoPromise = null; throw error; });
  return monacoPromise;
}

/** The same palette as the hand-written highlighter in highlight.js. */
/** Which Monaco theme belongs to which page theme. Light themes share one. */
export function monacoThemeFor(theme) {
  if (theme === 'blueprint') return 'studio-blueprint';
  if (theme === 'phosphor') return 'studio-phosphor';
  if (theme === 'slate') return 'studio-slate';
  return 'studio-light';
}

/**
 * The find widget, the go-to-line box, the hover — Monaco's own chrome.
 *
 * A theme that only names `editor.*` gets the code right and leaves every widget at the
 * `vs-dark` factory grey, so ⌘F opened a slab of Visual Studio Code inside a hand-set
 * page. These are the colours that chrome is actually built from, expressed once and
 * given a palette per theme, so a widget belongs to the theme it opened in.
 *
 * @param {{ground:string, raised:string, ink:string, dim:string, edge:string, accent:string,
 *           match:string, matchDim:string, hoverWash:string, onAccent:string}} p
 */
function widgetColors(p) {
  return {
    'editorWidget.background': p.raised,
    'editorWidget.foreground': p.ink,
    'editorWidget.border': p.edge,
    'editorWidget.resizeBorder': p.accent,
    'widget.border': p.edge,
    'widget.shadow': '#00000059',
    'input.background': p.ground,
    'input.foreground': p.ink,
    'input.border': p.edge,
    'input.placeholderForeground': p.dim,
    // The three toggles that were the only visible part of the broken widget.
    'inputOption.activeBackground': `${p.accent}2E`,
    'inputOption.activeBorder': p.accent,
    'inputOption.activeForeground': p.ink,
    'inputOption.hoverBackground': p.hoverWash,
    'focusBorder': p.accent,
    'icon.foreground': p.dim,
    'toolbar.hoverBackground': p.hoverWash,
    'toolbar.activeBackground': p.hoverWash,
    'badge.background': p.accent,
    'badge.foreground': p.onAccent,
    // What ⌘F is for: the hit you are on, and the ones you are not.
    'editor.findMatchBackground': p.match,
    'editor.findMatchBorder': p.accent,
    'editor.findMatchHighlightBackground': p.matchDim,
    'editor.findRangeHighlightBackground': p.hoverWash,
    'editorOverviewRuler.findMatchForeground': p.accent,
    'list.hoverBackground': p.hoverWash,
    'list.activeSelectionBackground': `${p.accent}2E`,
    'list.activeSelectionForeground': p.ink,
    'scrollbarSlider.shadow': '#00000000',
  };
}

/** Monaco cannot read CSS variables, so each visual theme needs its own definition. */
function defineTheme(monaco) {
  // Blueprint: cyan on navy. Syntax hues are pulled toward the drafting palette so the
  // editor reads as part of the page rather than a window cut into it.
  monaco.editor.defineTheme('studio-blueprint', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'DCEEFF' },
      { token: 'comment', foreground: '5E86A8', fontStyle: 'italic' },
      { token: 'string', foreground: '8FE3C0' },
      { token: 'number', foreground: 'F2C86B' },
      { token: 'keyword', foreground: '5FD3F3' },
      { token: 'type', foreground: 'A9D2F5' },
      { token: 'predefined', foreground: 'A9D2F5' },
      { token: 'identifier', foreground: 'DCEEFF' },
      { token: 'delimiter', foreground: '7FA6C4' },
      { token: 'operator', foreground: '7FA6C4' },
    ],
    colors: {
      'editor.background': '#0F2237',
      'editor.foreground': '#DCEEFF',
      'editorGutter.background': '#0F2237',
      'editorLineNumber.foreground': '#3E6688',
      'editorLineNumber.activeForeground': '#5FD3F3',
      'editor.lineHighlightBackground': '#14293F',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#5FD3F3',
      'editor.selectionBackground': '#5FD3F333',
      ...widgetColors({
        ground: '#0B1B2C', raised: '#14304A', ink: '#DCEEFF', dim: '#7FA6C4',
        edge: '#2A5477', accent: '#5FD3F3', onAccent: '#0F2237',
        match: '#5FD3F34D', matchDim: '#5FD3F326', hoverWash: '#5FD3F31A',
      }),
    },
  });

  // Phosphor: one hue, brightness doing the work — which is what a real tube did.
  monaco.editor.defineTheme('studio-phosphor', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: '7EFFA8' },
      { token: 'comment', foreground: '3F7A55', fontStyle: 'italic' },
      { token: 'string', foreground: 'FFC24B' },
      { token: 'number', foreground: 'FFC24B' },
      { token: 'keyword', foreground: 'CFFFDF', fontStyle: 'bold' },
      { token: 'type', foreground: 'A8FFC8' },
      { token: 'predefined', foreground: 'A8FFC8' },
      { token: 'identifier', foreground: '7EFFA8' },
      { token: 'delimiter', foreground: '4E9468' },
      { token: 'operator', foreground: '4E9468' },
    ],
    colors: {
      'editor.background': '#08130C',
      'editor.foreground': '#7EFFA8',
      'editorGutter.background': '#08130C',
      'editorLineNumber.foreground': '#2E5C40',
      'editorLineNumber.activeForeground': '#7EFFA8',
      'editor.lineHighlightBackground': '#0C1D12',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#FFC24B',
      'editor.selectionBackground': '#7EFFA82E',
      // One hue doing the work here too: the widget is a brighter patch of the same tube.
      ...widgetColors({
        ground: '#061009', raised: '#0E2415', ink: '#7EFFA8', dim: '#4E9468',
        edge: '#245437', accent: '#FFC24B', onAccent: '#08130C',
        match: '#FFC24B4D', matchDim: '#7EFFA82E', hoverWash: '#7EFFA81A',
      }),
    },
  });

  // Slate: the light theme's palette, re-lit. Same hue for each token so the code reads
  // the same way in both modes — only the ground and the contrast change.
  monaco.editor.defineTheme('studio-slate', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'E8EAED' },
      { token: 'comment', foreground: '727A85', fontStyle: 'italic' },
      { token: 'string', foreground: '8FD9AE' },
      { token: 'number', foreground: 'E3B457' },
      { token: 'keyword', foreground: 'C7A0E8' },
      { token: 'keyword.flow', foreground: 'C7A0E8' },
      { token: 'type', foreground: '86C2EC' },
      { token: 'type.identifier', foreground: '86C2EC' },
      { token: 'predefined', foreground: '86C2EC' },
      { token: 'identifier', foreground: 'E8EAED' },
      { token: 'delimiter', foreground: '9AA1AB' },
      { token: 'operator', foreground: '9AA1AB' },
    ],
    colors: {
      'editor.background': '#15181C',
      'editor.foreground': '#E8EAED',
      'editorGutter.background': '#15181C',
      'editorLineNumber.foreground': '#4A5058',
      'editorLineNumber.activeForeground': '#E8EAED',
      'editor.lineHighlightBackground': '#1B1E22',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#FF8256',
      'editor.selectionBackground': '#E8EAED26',
      'editor.inactiveSelectionBackground': '#E8EAED14',
      'editorIndentGuide.background1': '#FFFFFF12',
      'editorIndentGuide.activeBackground1': '#FFFFFF2E',
      'editorWhitespace.foreground': '#FFFFFF18',
      'editorBracketMatch.background': '#00000000',
      ...widgetColors({
        ground: '#101317', raised: '#1F2429', ink: '#E8EAED', dim: '#9AA1AB',
        edge: '#343A42', accent: '#FF8256', onAccent: '#15181C',
        match: '#FF82564D', matchDim: '#FF825626', hoverWash: '#FFFFFF12',
      }),
    },
  });

  monaco.editor.defineTheme('studio-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: '111111' },
      { token: 'comment', foreground: '9a9a9a', fontStyle: 'italic' },
      { token: 'string', foreground: '2E6B4F' },
      { token: 'string.escape', foreground: '2E6B4F' },
      { token: 'number', foreground: '93650B' },
      { token: 'keyword', foreground: '7A3E8F' },
      { token: 'keyword.flow', foreground: '7A3E8F' },
      { token: 'type', foreground: '1E5A8A' },
      { token: 'type.identifier', foreground: '1E5A8A' },
      { token: 'predefined', foreground: '1E5A8A' },
      { token: 'identifier', foreground: '111111' },
      { token: 'delimiter', foreground: '6E6E6E' },
      { token: 'operator', foreground: '6E6E6E' },
    ],
    colors: {
      'editor.background': '#FFFFFF',
      'editor.foreground': '#111111',
      'editorGutter.background': '#FFFFFF',
      'editorLineNumber.foreground': '#C9C9C9',
      'editorLineNumber.activeForeground': '#111111',
      'editor.lineHighlightBackground': '#F7F7F7',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#111111',
      'editor.selectionBackground': '#1111111F',
      'editor.inactiveSelectionBackground': '#1111110D',
      'editor.selectionHighlightBackground': '#11111112',
      'editor.wordHighlightBackground': '#11111110',
      'editor.wordHighlightStrongBackground': '#11111110',
      'editorIndentGuide.background1': '#0000000F',
      'editorIndentGuide.activeBackground1': '#00000026',
      'editorWhitespace.foreground': '#00000018',
      'editorBracketMatch.background': '#00000000',
      'editorBracketMatch.border': '#00000040',
      'editorRuler.foreground': '#0000000D',
      'scrollbarSlider.background': '#00000016',
      'scrollbarSlider.hoverBackground': '#00000026',
      'scrollbarSlider.activeBackground': '#00000036',
      'editorOverviewRuler.border': '#00000000',
      'editorError.foreground': '#B33A1A',
      'editorWarning.foreground': '#93650B',
      ...widgetColors({
        ground: '#FFFFFF', raised: '#F7F7F7', ink: '#111111', dim: '#6E6E6E',
        edge: '#00000022', accent: '#C4401C', onAccent: '#FFFFFF',
        match: '#C4401C40', matchDim: '#C4401C1F', hoverWash: '#0000000D',
      }),
    },
  });
}

const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Defaults for someone typing algorithms all day: four spaces, no minimap,
 *  and nothing that pops up over the code while they are thinking. */
function editorOptions() {
  return {
    language: 'python',
    theme: monacoThemeFor(getSettings().theme),
    automaticLayout: true,
    fontFamily: MONO_STACK,
    fontSize: getSettings().codeSize,
    lineHeight: 22,
    tabSize: 4,
    insertSpaces: true,
    detectIndentation: false,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    renderLineHighlight: 'line',
    renderWhitespace: 'selection',
    lineNumbersMinChars: 3,
    glyphMargin: false,
    folding: true,
    padding: { top: 14, bottom: 18 },
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    bracketPairColorization: { enabled: false },
    guides: { indentation: true, highlightActiveIndentation: false, bracketPairs: false },
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false, alwaysConsumeMouseWheel: false },
    // Nothing appears over the code uninvited. Ctrl+Space still summons it.
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    acceptSuggestionOnEnter: 'off',
    wordBasedSuggestions: 'off',
    tabCompletion: 'off',
    parameterHints: { enabled: false },
    hover: { enabled: false },
    lightbulb: { enabled: false },
    occurrencesHighlight: 'off',
    selectionHighlight: false,
    codeLens: false,
    contextmenu: true,
    fixedOverflowWidgets: true,
  };
}

/* ------------------------------ editor adapters ---------------------------- */

/** Plain-textarea stand-in with the same tiny interface, used when Monaco is
 *  unavailable. Tab inserts four spaces; nothing else is clever. */
function textareaEditor(host, initial) {
  const area = el('textarea', {
    class: 'ws-fallback', spellcheck: 'false', autocomplete: 'off',
    autocapitalize: 'off', autocorrect: 'off', 'aria-label': 'Python solution',
  });
  area.value = initial;
  host.append(area);
  let changed = () => {};
  area.addEventListener('input', () => changed());
  area.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const { selectionStart: start, selectionEnd: end, value } = area;
    area.value = value.slice(0, start) + '    ' + value.slice(end);
    area.selectionStart = area.selectionEnd = start + 4;
    changed();
  });
  return {
    kind: 'textarea',
    getValue: () => area.value,
    setValue: (value) => { area.value = value; },
    focus: () => area.focus(),
    blur: () => area.blur(),
    hasFocus: () => document.activeElement === area,
    onChange: (fn) => { changed = fn; },
    // The same three verbs Monaco's adapter answers to, so the settings watcher never
    // has to ask which editor it got. Two of them have nothing to do here.
    setFontSize: (px) => { area.style.fontSize = `${px}px`; },
    setTheme: () => {},
    layout: () => {},
    dispose: () => area.remove(),
  };
}

function monacoEditor(monaco, host, initial, { onRun, onSubmit, onSave, onEscape }) {
  const instance = monaco.editor.create(host, { ...editorOptions(), value: initial });
  let changed = () => {};
  instance.onDidChangeModelContent(() => changed());

  const KeyMod = monaco.KeyMod, KeyCode = monaco.KeyCode;
  // ⌘↵ submits and ⌘' runs. LeetCode has these the other way round, and matching it was
  // the wrong call twice over: ⌘' is the key he actually reaches for to run, and ⌘↵ is
  // the one his hands expect to submit. The tool should fit the hands using it.
  instance.addCommand(KeyMod.CtrlCmd | KeyCode.Enter, () => onSubmit());
  instance.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter, () => onSubmit());
  instance.addCommand(KeyMod.CtrlCmd | KeyCode.Quote, () => onRun());
  instance.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => onSave());
  // Escape hands the keyboard back to the app; a second Escape then leaves the page.
  instance.addCommand(KeyCode.Escape, () => onEscape());

  return {
    kind: 'monaco',
    getValue: () => instance.getValue(),
    setValue: (value) => {
      // pushEditOperations keeps the undo stack, so a restore is reversible.
      const model = instance.getModel();
      if (!model) return;
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
    },
    focus: () => instance.focus(),
    blur: () => { const node = host.querySelector('textarea'); if (node) node.blur(); },
    hasFocus: () => instance.hasTextFocus(),
    onChange: (fn) => { changed = fn; },
    setFontSize: (px) => instance.updateOptions({ fontSize: px }),
    setTheme: (name) => monaco.editor.setTheme(name),
    // Monaco measures its container once and caches it; a collapsed pane or a resized
    // column has to say so.
    layout: () => instance.layout(),
    // The standalone editor owns the model it created from `value`; disposing the
    // model separately makes Monaco throw on the way out.
    dispose: () => instance.dispose(),
  };
}

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
  let editor = null;
  let loaded = null;            // last value known to match the server; null = none does
  let stubCode = null;          // the starter, while we still have it
  let saveState = 'loading';
  let saveDetail = '';
  let savedAt = null;
  let touched = false;          // the stub is never written back; only real edits are
  let saveTimer = null;
  let draftTimer = null;
  let retryTimer = null;
  let disposed = false;
  let lane = 'run';             // which results lane is open; the other is a stub
  const releaseChords = [];

  /* ---- chrome ---- */

  const statusEl = el('span', { class: 'ws-status mono' });
  const runLabel = el('span', { text: 'Run' });
  const runButton = el('button', {
    class: 'ws-run', type: 'button',
    title: "Run against the example cases on this machine (⌘')",
    onclick: () => doRun(),
  }, [runLabel]);

  // Reset throws away everything you wrote, so it asks once. A single stray click on a
  // small button in a toolbar is not enough intent to delete a solution — and the button
  // sits next to Run and Submit, which are clicked constantly.
  let resetArmed = null;

  function disarmReset() {
    if (resetArmed) clearTimeout(resetArmed);
    resetArmed = null;
    revertButton.classList.remove('is-arming');
    revertButton.textContent = 'Reset';
    revertButton.title = 'Put LeetCode\'s starter code back. What you wrote is not kept.';
  }

  const revertButton = el('button', {
    class: 'ws-mini ws-reset', type: 'button', hidden: true, text: 'Reset',
    title: 'Put LeetCode\'s starter code back. What you wrote is not kept.',
    onclick: () => {
      if (stubCode === null || !editor) return;
      if (!resetArmed) {
        revertButton.classList.add('is-arming');
        revertButton.textContent = 'Discard your code?';
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
  });

  // Two collapses, one button each, and the same chord from anywhere on the page.
  // There used to be a Problem button *and* a Focus button doing opposite halves of the
  // same job; hiding the statement IS focus mode, so there is one of them now.
  const probButton = el('button', {
    class: 'ws-mini prob-toggle', type: 'button', 'aria-pressed': 'true',
    title: `Show or hide the problem statement (${chordLabel('problem')})`,
    onclick: () => setProblemHidden(!isProblemHidden()),
  }, [el('span', { class: 'ws-problabel', text: 'Problem' }), el('kbd', { text: chordLabel('problem') })]);

  // Submit is a different act from Run and is built to read as one: its own button, its
  // own colour, its own panel. ⌘↵ sends it, because that is the key his hands already
  // reach for; ⌘' runs. The confirmation that a submission is deliberate lives in
  // doSubmit, not in an extra modifier nobody remembers.
  const submitLabel = el('span', { text: 'Submit' });
  const submitButton = el('button', {
    class: 'ws-submit', type: 'button',
    title: 'Send this code to LeetCode and run every hidden test (⌘↵)',
    onclick: () => doSubmit(),
  }, [submitLabel]);

  const noticeEl = el('div', { class: 'ws-notice', hidden: true });
  const host = el('div', { class: 'ws-host' });

  const panel = createRunPanel({ slug, getCode: () => (editor ? editor.getValue() : ''), onEvent: onRunEvent });
  const judge = createSubmitPanel({
    slug,
    getCode: () => (editor ? editor.getValue() : ''),
    onEvent: onSubmitEvent,
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
    class: 'ws-stub', type: 'button', hidden: true,
    onclick: () => showResults('judge'),
  });
  const runStub = el('button', {
    class: 'ws-stub', type: 'button', hidden: true,
    onclick: () => showResults('run'),
  });
  const runLane = el('div', { class: 'ws-lane' }, [
    // "Local run" stays: it is what stops these results being read as LeetCode's
    // verdict. The sentence explaining what local means does not need to be permanent.
    el('div', { class: 'rr-lane' }, [
      el('span', { class: 'mono rr-lanemark', text: 'Local run' }),
    ]),
    panel.root,
  ]);
  const judgeLane = el('div', { class: 'ws-lane', hidden: true }, judge.root);
  const results = el('div', { class: 'ws-results' }, [
    judgeStub, judgeLane, runStub, runLane,
  ]);

  const root = el('section', { class: 'card ws' }, [
    el('div', { class: 'ws-bar' }, [
      el('span', { class: 'mono dim ws-title', text: 'Python' }),
      // Focus mode hides the heading, so the toolbar carries the title instead —
      // never be in an editor without knowing which problem it belongs to.
      el('span', { class: 'ws-probtitle', text: entry.title || slug, title: entry.title || slug }),
      statusEl,
      el('span', { class: 'spacer' }),
      revertButton,
      probButton,
      // Run, then Submit. Run is the one pressed fifty times an hour and Submit is the one
      // that leaves the machine, so the safe one comes first and the irreversible one sits
      // on its own at the end.
      runButton,
      submitButton,
    ]),
    noticeEl,
    host,
    results,
  ]);

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
      statusEl.append(el('button', { class: 'ws-retry', type: 'button', text: 'Retry', onclick: () => flush() }));
    }
    const nothingToReset = stubCode === null || !editor || editor.getValue() === stubCode;
    if (nothingToReset && resetArmed) disarmReset();
    revertButton.hidden = nothingToReset;
  }

  function setSave(state, detail = '') {
    saveState = state; saveDetail = detail; paintStatus();
  }

  async function flush() {
    // Nothing the user wrote, nothing to write. This is what keeps an untouched
    // stub from ever being PUT back over the server's copy.
    if (disposed || !editor || !touched) return;
    const code = editor.getValue();
    if (code === loaded && saveState !== 'failed') { setSave('clean'); return; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    setSave('saving');
    const result = await saveCode(slug, code);
    if (disposed) return;
    if (result.ok) {
      loaded = code;
      savedAt = result.updatedAt || new Date().toISOString();
      setSave(editor.getValue() === code ? 'clean' : 'dirty');
      return;
    }
    if (result.kind === 'unavailable') {
      // A server without the endpoint is a real state, not a transient error.
      setSave('local', result.source === 'mock' ? '' : 'this server has no save endpoint');
      return;
    }
    setSave('failed', result.message || '');
    retryTimer = setTimeout(() => { retryTimer = null; flush(); }, SAVE_RETRY_MS);
  }

  function onEdit() {
    if (!editor) return;
    touched = true;
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
    flush();
  }

  /* ---- notices ---- */

  function showNotice({ tone = '', head, body, actions = [] }) {
    noticeEl.hidden = false;
    noticeEl.className = 'ws-notice ' + tone;
    replace(noticeEl, [
      el('span', { class: 'mono ws-noticehead', text: head }),
      el('span', { class: 'ws-noticebody', text: body }),
      ...actions.map(a => el('button', { class: 'ws-mini', type: 'button', text: a.label, onclick: a.onClick })),
      el('button', { class: 'ws-noticex', type: 'button', 'aria-label': 'Dismiss', text: '×', onclick: () => { noticeEl.hidden = true; } }),
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

  // Reached from the Submit button or ⌘↵, and from nothing else — no timer, no retry
  // path, no batching. That is what keeps "one submission per explicit user action"
  // true rather than aspirational; a keystroke he pressed is an explicit action, a
  // second attempt fired by the app on his behalf would not be.
  function doSubmit() {
    if (judge.isBusy()) return;
    flushNow();                       // what is judged should be what is on disk
    showResults('judge');
    judge.submit();
    results.scrollTop = 0;
  }

  function onSubmitEvent(event) {
    const busy = event.type === 'start';
    submitButton.disabled = busy;
    submitButton.classList.toggle('busy', busy);
    submitLabel.textContent = busy ? 'Judging' : 'Submit';
    if (!busy) results.scrollTop = 0;
    showLane(lane);
  }

  /* ---- the two collapses ---- */

  // `aria-pressed` tracks whether the pane is SHOWING, so the button reads as a pane that
  // is on rather than a hide-action that is stuck down.
  const isProblemHidden = () => document.body.classList.contains('hide-problem');
  const isResultsHidden = () => document.body.classList.contains('hide-results');

  function setProblemHidden(on) {
    document.body.classList.toggle('hide-problem', on);
    probButton.setAttribute('aria-pressed', String(!on));
    try { localStorage.setItem(FOCUS_KEY, on ? '1' : '0'); } catch { /* noop */ }
    // The editor is a fixed-size canvas that does not notice its box changed.
    if (editor) setTimeout(() => editor.layout?.(), 0);
  }

  function setResultsHidden(on) {
    document.body.classList.toggle('hide-results', on);
    try { localStorage.setItem(PANEL_KEY, on ? '1' : '0'); } catch { /* noop */ }
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
        el('span', { class: 'ws-stubline', text: judge.isBusy() ? 'Judging on LeetCode…' : submitLine(verdict) }),
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
    const meta = event.metaKey || event.ctrlKey;
    // ⌘↵ submits, ⌘' runs. ⌘⇧↵ stays a submit alias so the old binding still works.
    if (meta && event.key === 'Enter') { event.preventDefault(); doSubmit(); return; }
    if (meta && event.key === "'") { event.preventDefault(); doRun(); return; }
    if (meta && (event.key === 's' || event.key === 'S')) { event.preventDefault(); flushNow(); return; }
    if (event.key === 'Escape' && editor && editor.hasFocus()) {
      event.preventDefault();
      editor.blur();
      runButton.focus();
    }
  });

  function onDocumentKey(event) {
    if (disposed || !document.body.contains(root)) return;
    if (host.contains(document.activeElement)) return;
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault(); doSubmit(); return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "'") {
      event.preventDefault(); doRun(); return;
    }
    // No bare letters here any more. `f` and `p` toggled panes only while the cursor
    // happened to be nowhere, and typed themselves the rest of the time; both moved to
    // chords in shortcuts.js, which work whether or not you are typing.
  }
  document.addEventListener('keydown', onDocumentKey);

  // The slider and the theme move the RUNNING editor, not just the next one created.
  //
  // This used to call editor.updateOptions(), which neither adapter has ever had — so
  // every settings change threw here, on the first line, and the two lines under it
  // never ran. The font size did not move and the editor kept the theme it was born
  // with while the page around it changed. Silent, because a listener that throws takes
  // nothing else down with it.
  const stopWatchingSettings = onSettingsChange((settings) => {
    if (!editor) return;
    editor.setFontSize?.(settings.codeSize);
    editor.setTheme?.(monacoThemeFor(settings.theme));
    requestAnimationFrame(() => editor.layout?.());
  });

  function onHide() { if (document.visibilityState === 'hidden') flushNow(); }
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flushNow);

  /* ---- boot ---- */

  async function boot() {
    host.append(el('div', { class: 'ws-loading' }, el('div', { class: 'mono dim', text: 'Opening the editor…' })));
    setSave('loading');

    const [result] = await Promise.all([loadCode(slug, entry)]);
    if (disposed) return;

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
    let failure = null;
    try {
      const monaco = await loadMonaco();
      if (disposed) return;
      editor = monacoEditor(monaco, host, text, {
        onRun: doRun,
        onSubmit: doSubmit,
        onSave: flushNow,
        onEscape: () => { editor.blur(); runButton.focus(); },
      });
    } catch (error) {
      failure = error;
      editor = textareaEditor(host, text);
    }
    editor.onChange(onEdit);
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

  active = {
    root,
    focus: () => editor && editor.focus(),
    run: doRun,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(draftTimer); clearTimeout(saveTimer); clearTimeout(retryTimer);
      // Leaving the page mid-debounce must not strand an edit in the browser:
      // mirror it locally AND make one last attempt at the real save.
      if (editor && touched) {
        const code = editor.getValue();
        try { writeDraft(slug, code); } catch { /* noop */ }
        if (code !== loaded) { try { saveCode(slug, code); } catch { /* noop */ } }
      }
      document.removeEventListener('keydown', onDocumentKey);
      for (const release of releaseChords) release();
      stopWatchingSettings();
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flushNow);
      panel.dispose();
      judge.dispose();
      if (editor) editor.dispose();
      if (active && active.root === root) active = null;
    },
  };
  return root;
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
