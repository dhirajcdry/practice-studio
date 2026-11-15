import { cleanupChrome } from './chrome-cleanup.mjs';
// Every app shortcut, in every state the page can be in, with real keys.
//
//   node scripts/check-shortcut-matrix.mjs
//
// Written after ⌘F broke every shortcut for the rest of the session. Monaco's find widget
// is a `role="dialog"` that stays in the DOM, laid out, after it closes. The app's "is a
// dialog open?" test counted it, so after one ⌘F the page believed a dialog was open
// forever: Run, Submit, Save, the pane chords, J/K, S/A and ⌥R all went dead, even after
// Escape, even after clicking elsewhere. The same guard had quietly swallowed shortcuts
// before, each time in a state nobody had a check for.
//
// So this check is one table. STATES are the things that can be open or focused, each set
// up with real key presses and clicks (Input.dispatchKeyEvent / dispatchMouseEvent), and
// SHORTCUTS are the keys. Each state names which shortcuts must fire there; every other
// shortcut must not. Escape is checked separately in ESCAPES: it must close the innermost
// thing and leave focus somewhere sane.
//
// Adding a shortcut means adding a row to SHORTCUTS: the check reads the app's own
// registry (`listShortcuts()` in web/js/keyboard.js) and fails on any registered shortcut
// this table does not know. Adding an overlay or a focusable surface means adding a row to
// STATES with what must still work there.
//
// Nothing here can reach a judge or a model: `?simsubmit=` and `?simrun=` are api.js's
// canned results, the scratch server has no network, and the coach binaries do not exist.

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { startScratch, requireFreePort } from './check-scratch.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SERVER_PORT = Number(process.env.STUDIO_CHECK_PORT) || 4231;
const DEBUG_PORT = SERVER_PORT + 5255;
const SLUG = 'contains-duplicate';
const ONLY = process.env.MATRIX_ONLY ? new RegExp(process.env.MATRIX_ONLY) : null;

/* ------------------------------------------------------------------ the keys */

// `id` matches the app's registry. `effect` names how the page shows that it acted.
// `sameAs` is a key whose handler, gate and owner are identical to another row's (⌘← and
// ⌘→ are one entry with two directions): it is listed so the registry check knows it, and
// tested through that row.
const SHORTCUTS = [
  { id: 'run', label: "⌘'", key: "'", code: 'Quote', vk: 222, mod: 4, effect: 'run' },
  { id: 'submit', label: '⌘↵', key: 'Enter', code: 'Enter', vk: 13, mod: 4, effect: 'submit' },
  { id: 'save', label: '⌘S', key: 's', code: 'KeyS', vk: 83, mod: 4, effect: 'claimed' },
  { id: 'toggle-problem', label: '⌘B', key: 'b', code: 'KeyB', vk: 66, mod: 4, effect: 'problemPane' },
  { id: 'toggle-results', label: '⌘J', key: 'j', code: 'KeyJ', vk: 74, mod: 4, effect: 'resultsPane' },
  { id: 'toggle-coach', label: '⌘\\', key: '\\', code: 'Backslash', vk: 220, mod: 4, effect: 'coachPane' },
  { id: 'neighbour-problem', label: '⌘→', key: 'ArrowRight', code: 'ArrowRight', vk: 39, mod: 4, effect: 'navigate' },
  { id: 'step-problem', label: 'J', key: 'j', code: 'KeyJ', vk: 74, mod: 0, text: 'j', effect: 'navigate' },
  { id: 'reference-tab', label: 'S', key: 's', code: 'KeyS', vk: 83, mod: 0, text: 's', effect: 'tab' },
  { id: 'shuffle', label: 'R', key: 'r', code: 'KeyR', vk: 82, mod: 0, text: 'r', effect: 'shuffle' },
  { id: 'search', label: '/', key: '/', code: 'Slash', vk: 191, mod: 0, text: '/', effect: 'search' },
  { id: 'attempt', label: '⌥R', key: '®', code: 'KeyR', vk: 82, mod: 1, effect: 'claimed' },
];
// Registered ids that are tested through another row, or only on another screen.
const COVERED_ELSEWHERE = {
  // Catalog-only movement and Enter: CATALOG below.
  'catalog-step': 'CATALOG', 'catalog-open': 'CATALOG',
  // Escape is not a column: ESCAPES checks what it closes and where focus goes.
  'back': 'ESCAPES',
};

const ALL = SHORTCUTS.map(s => s.id);
const PANES = ['toggle-problem', 'toggle-results', 'toggle-coach'];
// What must fire, by kind of focus. Anything not listed must not fire.
const PROFILE = {
  // Nothing typed into: every shortcut belongs to the app.
  free: ALL,
  // Typing code (Monaco, the fallback textarea, Monaco's find box): command chords work;
  // letters, / and ⌘←/→ are text editing.
  code: ['run', 'submit', 'save', ...PANES],
  // Monaco's replace box owns ⌘↵ (Replace All); its quick-input pickers own the Enter family.
  editorField: ['run', 'save', ...PANES],
  // A test-case field is part of the workspace: ⌘↵ still submits from it.
  workspaceField: ['run', 'submit', 'save', ...PANES],
  // A text field outside the workspace (composer, search, a rename): it owns ⌘↵ (send),
  // and letters are typing. Every other command chord still works.
  field: ['run', 'save', ...PANES],
  // A focused select keeps letters and / for its type-ahead, as a native select does.
  chooser: ALL.filter(id => !['step-problem', 'reference-tab', 'shuffle', 'search'].includes(id)),
  // A modal dialog or an open menu holds the keyboard; nothing behind it acts.
  modal: [],
  // Focus inside the Video tab's cross-origin player: the browser delivers keys to that
  // frame and Studio never sees them. The one legitimate exception (docs/UI.md); the tab
  // says "The player has the keyboard. Click outside it to use Studio shortcuts."
  player: [],
};

/* ---------------------------------------------------------------- the states */

const ED = 'monaco.editor.getEditors()[0]';
const focusEditor = { js: `${ED}.focus(); ${ED}.setPosition({ lineNumber: 3, column: 9 })` };
const cmd = (key, code, vk, extra = {}) => ({ key, code, vk, mod: 4, ...extra });
const FIND = cmd('f', 'KeyF', 70, { wait: 400 }); // the widget slides in; clicks wait for it
const ESC = { key: 'Escape', code: 'Escape', vk: 27, mod: 0 };
const inEditorText = `${ED}.hasTextFocus()`;
const findOpen = `!!document.querySelector('.monaco-editor .find-widget.visible')`;
const findClosed = `!!document.querySelector('.monaco-editor .find-widget') && !document.querySelector('.monaco-editor .find-widget.visible')`;
const activeIs = sel => `!!document.activeElement?.matches?.(${JSON.stringify(sel)})`;
const bodyFocused = `document.activeElement === document.body`;
// ⌥R in an earlier row may have left the sidebar on Interviews (its setup); Chat is the rest state.
const openCoach = { js: `window.dispatchEvent(new Event('studio:open-coach')); setTimeout(() => [...document.querySelectorAll('.coach-tab')].find(t => t.textContent.trim() === 'Chat')?.click(), 100)`, wait: 500 };
const openReport = { js: `(async () => {
  const { openReport } = await import('/js/interview-report.js');
  openReport({ title: 'Check', record: { id: 'matrix', discipline: 'coding', slug: '${SLUG}' },
    report: { judgement: null, facts: { durationMs: 0, phases: [], hints: 0, runs: [], verdicts: [], candidateTurns: 0, candidateWords: 0 } } });
})()`, wait: 300 };
const VIDEO_TAB = '.problem-tabs [role=tab][data-panel="video"]';
const openVideo = [{ click: VIDEO_TAB }, { js: `(async () => { for (let i = 0; i < 100 && !document.querySelector('.video-player.is-ready'); i++) await new Promise(r => setTimeout(r, 100)); })()` }];
const focusVideoTab = { js: `document.querySelector('.problem-tabs [role=tab][data-panel="video"]').focus()` };
const dirtyBuffer = { js: `${ED}.executeEdits('matrix', [{ range: new monaco.Range(3, 1, 3, 1), text: '        # mine\\n' }])`, wait: 200 };

// `steps`: real input first, JS only where no real gesture can reach the state.
// `expect`: proves the state is what the row says before anything is pressed.
const STATES = [
  { id: 'editor', what: 'typing in the editor', steps: [focusEditor], expect: inEditorText, fires: 'code' },
  { id: 'body', what: 'nothing focused', steps: [{ js: 'document.activeElement?.blur?.()' }], expect: bodyFocused, fires: 'free' },
  { id: 'statement-click', what: 'after clicking the statement', steps: [{ click: '#ref-problem p' }], expect: `!document.activeElement.closest('.monaco-editor')`, fires: 'free' },
  { id: 'run-button', what: 'the Run button focused', steps: [{ js: `document.querySelector('.ws-run').focus()` }], expect: activeIs('.ws-run'), fires: 'free' },
  { id: 'esc-out-of-editor', what: 'after Esc out of the editor', steps: [focusEditor, ESC], expect: activeIs('.ws-run'), fires: 'free' },

  // Monaco's find widget: the bug this check exists for.
  { id: 'find-open', what: 'Find open, typing in it', steps: [focusEditor, FIND, { text: 'len' }], expect: `${findOpen} && !!document.activeElement.closest('.find-widget')`, fires: 'code' },
  { id: 'find-closed-esc', what: 'Find closed with Escape', steps: [focusEditor, FIND, { text: 'len' }, ESC], expect: `${findClosed} && ${inEditorText}`, fires: 'code' },
  { id: 'find-closed-x', what: 'Find closed with its close button', steps: [focusEditor, FIND, { click: '.find-widget .codicon-widget-close' }], expect: findClosed, fires: 'code' },
  { id: 'find-open-back-to-code', what: 'Find open, clicked back into the code', steps: [focusEditor, FIND, { click: '.monaco-editor .view-line' }], expect: `${findOpen} && ${inEditorText}`, fires: 'code' },
  { id: 'find-open-clicked-away', what: 'Find open, then clicked the statement', steps: [focusEditor, FIND, { click: '#ref-problem p' }], expect: `${findOpen} && !document.activeElement.closest('.monaco-editor')`, fires: 'free' },
  { id: 'find-closed-clicked-away', what: 'Find opened and closed, then clicked the statement', steps: [focusEditor, FIND, ESC, { click: '#ref-problem p' }], expect: `${findClosed} && !document.activeElement.closest('.monaco-editor')`, fires: 'free' },
  { id: 'find-closed-button', what: 'Find opened and closed, then a toolbar button', steps: [focusEditor, FIND, ESC, { js: `document.querySelector('.ws-run').focus()` }], expect: `${findClosed} && ${activeIs('.ws-run')}`, fires: 'free' },
  { id: 'replace-open', what: 'Replace open, typing in its replace box', steps: [focusEditor, cmd('f', 'KeyF', 70, { mod: 5 }), { js: `${ED}.trigger('matrix', 'editor.action.startFindReplaceAction')`, wait: 200 }, { js: `document.querySelector('.find-widget .replace-part textarea, .find-widget .replace-part input').focus()` }], expect: `!!document.activeElement.closest('.replace-part')`, fires: 'editorField' },
  { id: 'replace-closed', what: 'Replace closed with Escape', steps: [focusEditor, { js: `${ED}.trigger('matrix', 'editor.action.startFindReplaceAction')`, wait: 200 }, ESC], expect: `${findClosed} && ${inEditorText}`, fires: 'code' },

  // Monaco's other widgets.
  { id: 'suggest-open', what: 'the suggest list open', steps: [focusEditor, { text: 'con' }, { js: `${ED}.trigger('matrix', 'editor.action.triggerSuggest', {})`, wait: 500 }], expect: `!!document.querySelector('.monaco-editor .suggest-widget.visible') && ${inEditorText}`, fires: 'code' },
  { id: 'suggest-closed', what: 'the suggest list closed with Escape', steps: [focusEditor, { text: 'con' }, { js: `${ED}.trigger('matrix', 'editor.action.triggerSuggest', {})`, wait: 500 }, ESC], expect: `!document.querySelector('.monaco-editor .suggest-widget.visible') && ${inEditorText}`, fires: 'code' },
  { id: 'command-palette', what: "Monaco's command palette (F1) open", steps: [focusEditor, { key: 'F1', code: 'F1', vk: 112, mod: 0 }, { wait: 300 }], expect: `!!document.activeElement.closest('.quick-input-widget')`, fires: 'editorField' },
  { id: 'command-palette-closed', what: 'the command palette closed with Escape', steps: [focusEditor, { key: 'F1', code: 'F1', vk: 112, mod: 0 }, { wait: 300 }, ESC], expect: inEditorText, fires: 'code' },
  { id: 'context-menu', what: "the editor's context menu open", steps: [focusEditor, { js: `${ED}.trigger('matrix', 'editor.action.showContextMenu', {})`, wait: 300 }], expect: `!!document.activeElement.closest('.monaco-editor') && !${inEditorText}`, fires: 'code' },
  { id: 'context-menu-closed', what: 'the context menu closed with Escape', steps: [focusEditor, { js: `${ED}.trigger('matrix', 'editor.action.showContextMenu', {})`, wait: 300 }, ESC], expect: inEditorText, fires: 'code' },

  // The workspace around the code.
  { id: 'testcase', what: 'a test-case field', steps: [{ click: '.tc-input' }], expect: activeIs('.tc-input'), fires: 'workspaceField' },
  { id: 'results-tab', what: 'a results tab focused', steps: [{ click: '.rr-tab' }], expect: activeIs('.rr-tab'), fires: 'free' },
  { id: 'splitter', what: 'a pane splitter focused', steps: [{ js: `document.querySelector('[role=separator]').focus()` }], expect: activeIs('[role=separator]'), fires: 'free' },
  { id: 'rail', what: 'a workspace rail button clicked', steps: [{ click: '.workspace-rail [data-pane=results]' }, { click: '.workspace-rail [data-pane=results]' }], expect: activeIs('.workspace-rail button'), fires: 'free' },
  { id: 'wrap-toggle', what: 'after toggling wrap', steps: [{ click: '.editor-wrap' }, { click: '.editor-wrap' }], expect: activeIs('.editor-wrap'), fires: 'free' },
  { id: 'wrap-toggle-code', what: 'after toggling wrap, back in the code', steps: [{ click: '.editor-wrap' }, { click: '.editor-wrap' }, focusEditor], expect: inEditorText, fires: 'code' },
  { id: 'solution-tab', what: 'the Solution tab showing', steps: [{ click: '.problem-tabs [data-panel=solution]' }], expect: `document.querySelector('#ref-problem').hidden`, fires: 'free' },
  { id: 'problem-tab', what: 'a problem-pane tab focused', steps: [{ click: '.problem-tabs [data-panel=problem]' }], expect: activeIs('.problem-tabs [role=tab]'), fires: 'free' },
  { id: 'reset-toast', what: 'after Reset, its toast showing, back in the code', steps: [focusEditor, dirtyBuffer, { click: '.ws-reset' }], expect: `${inEditorText} && ${ED}.getValue().indexOf('# mine') < 0 && !!document.querySelector('.fx-toast--note.is-in')`, fires: 'code' },
  { id: 'reset-toast-body', what: 'after Reset, its toast showing, nothing focused', steps: [focusEditor, dirtyBuffer, { click: '.ws-reset' }, { js: 'document.activeElement?.blur?.()' }], expect: `${bodyFocused} && !!document.querySelector('.fx-toast--note.is-in')`, fires: 'free' },

  // The Video tab's player (the local fake, never YouTube).
  { id: 'video-tab', what: 'the Video tab, its tab button focused', steps: [...openVideo, focusVideoTab], expect: `${activeIs(VIDEO_TAB)} && !!document.querySelector('.video-player.is-ready')`, fires: 'free' },
  { id: 'video-esc', what: 'Esc from the Video tab (back to Problem)', steps: [...openVideo, focusVideoTab, ESC], expect: `!document.querySelector('#ref-problem').hidden && ${activeIs('.problem-tabs [role=tab]')}`, fires: 'free' },
  { id: 'video-iframe', what: 'focus inside the video player (iframe)', steps: [...openVideo, { click: 'iframe.video-player', wait: 300 }], expect: `document.activeElement?.tagName === 'IFRAME' && /Click outside it/.test(document.querySelector('.video-focus-note')?.textContent || '')`, fires: 'player' },
  { id: 'video-clicked-out', what: 'the player, then one click outside it', steps: [...openVideo, { click: 'iframe.video-player', wait: 300 }, { click: '.video-meta' }], expect: `document.activeElement?.tagName !== 'IFRAME'`, fires: 'free' },
  { id: 'video-left-by-tab', what: 'the player, then the Problem tab clicked', steps: [...openVideo, { click: 'iframe.video-player', wait: 300 }, { click: '.problem-tabs [data-panel=problem]' }], expect: `!document.querySelector('#ref-problem').hidden && document.activeElement?.tagName !== 'IFRAME'`, fires: 'free' },
  { id: 'video-pane-collapsed', what: 'the player, then the problem pane collapsed', steps: [...openVideo, { click: 'iframe.video-player', wait: 300 }, { click: '.workspace-rail [data-pane=problem]' }], expect: `document.body.classList.contains('hide-problem') && document.activeElement?.tagName !== 'IFRAME'`, fires: 'free' },
  { id: 'video-route-away', what: 'the player, then another problem and back', steps: [...openVideo, { click: 'iframe.video-player', wait: 300 }, { js: `location.hash = '#/p/two-sum'`, wait: 1200 }, { js: `location.hash = '#/p/${SLUG}'` }, { ready: true }, { js: 'document.activeElement?.blur?.()' }], expect: bodyFocused, fires: 'free' },

  // The sidebar.
  { id: 'composer', what: 'the coach composer', steps: [openCoach, { click: '.coach-input' }], expect: activeIs('.coach-input'), fires: 'field' },
  { id: 'coach-tab', what: 'a sidebar tab focused', steps: [openCoach, { click: '.coach-tab' }], expect: activeIs('.coach-tab'), fires: 'free' },
  { id: 'coach-tab-submissions', what: 'the Submissions tab open', steps: [openCoach, { click: '.coach-tab:nth-child(3)' }], expect: activeIs('.coach-tab'), fires: 'free' },
  { id: 'coach-log', what: 'the coach conversation focused', steps: [openCoach, { js: `document.querySelector('.coach-log').focus()` }], expect: activeIs('.coach-log'), fires: 'free' },
  { id: 'model-menu', what: 'the coach model menu open', steps: [openCoach, { click: '.coach-compose .ui-select-button' }, { wait: 200 }], expect: `[...document.querySelectorAll('[role=menu]')].some(n => !n.hidden && n.getClientRects().length)`, fires: 'modal' },
  { id: 'model-menu-closed', what: 'the coach model menu closed with Escape', steps: [openCoach, { click: '.coach-compose .ui-select-button' }, { wait: 200 }, ESC], expect: `![...document.querySelectorAll('[role=menu]')].some(n => !n.hidden && n.getClientRects().length) && ${activeIs('.coach-compose .ui-select-button')}`, fires: 'chooser' },

  // The header and the overlays.
  { id: 'search', what: 'the header search box', steps: [{ js: `document.querySelector('#q').focus()` }], expect: activeIs('#q'), fires: 'field' },
  { id: 'settings', what: 'Settings open', steps: [{ click: '.set-settings' }, { wait: 200 }], expect: `!!document.querySelector('aside.settings')`, fires: 'modal' },
  { id: 'settings-editor-behind', what: 'Settings open, focus left on the editor', steps: [focusEditor, { js: `document.querySelector('.set-settings').click()`, wait: 200 }, focusEditor], expect: `!!document.querySelector('aside.settings') && ${inEditorText}`, fires: 'modal' },
  { id: 'settings-closed', what: 'Settings closed with Escape', steps: [{ click: '.set-settings' }, { wait: 200 }, ESC], expect: `!document.querySelector('aside.settings')`, fires: 'free' },
  { id: 'settings-closed-code', what: 'Settings closed, back in the code', steps: [{ click: '.set-settings' }, { wait: 200 }, ESC, focusEditor], expect: `!document.querySelector('aside.settings') && ${inEditorText}`, fires: 'code' },
  { id: 'theme-change', what: 'after switching light/dark (editor re-themed)', steps: [{ click: '.set-daynight' }, { wait: 200 }, focusEditor], expect: inEditorText, fires: 'code' },
  { id: 'report', what: 'a report sheet open', steps: [openReport], expect: `!!document.querySelector('dialog[open]')`, fires: 'modal' },
  { id: 'report-closed', what: 'a report sheet closed with Escape', steps: [openReport, ESC, { wait: 200 }], expect: `!document.querySelector('dialog[open]')`, fires: 'free' },
  { id: 'report-closed-code', what: 'a report sheet closed, back in the code', steps: [openReport, ESC, { wait: 200 }, focusEditor], expect: `!document.querySelector('dialog[open]') && ${inEditorText}`, fires: 'code' },

  // Lifecycle.
  { id: 'after-run', what: 'after a run finished', steps: [focusEditor, cmd("'", 'Quote', 222), { idle: true }], expect: inEditorText, fires: 'code' },
  { id: 'after-run-button', what: 'after pressing Run (focused, Space)', steps: [{ js: `document.querySelector('.ws-run').focus()` }, { key: ' ', code: 'Space', vk: 32, mod: 0, text: ' ' }, { idle: true }], expect: activeIs('.ws-run'), fires: 'free' },
  { id: 'after-run-click', what: 'after clicking Run with the mouse', steps: [{ click: '.ws-run' }, { idle: true }], expect: `!document.activeElement.closest('.monaco-editor')`, fires: 'free' },
  { id: 'after-submit', what: 'after a submission finished', steps: [focusEditor, cmd('Enter', 'Enter', 13), { idle: true }], expect: inEditorText, fires: 'code' },
  { id: 'route-away-and-back', what: 'after opening another problem and coming back', steps: [{ js: `location.hash = '#/p/two-sum'`, wait: 1200 }, { js: `location.hash = '#/p/${SLUG}'` }, { ready: true }, focusEditor], expect: inEditorText, fires: 'code' },
  { id: 'catalog-and-back', what: 'after the catalog and back', steps: [{ js: `location.hash = '#/'`, wait: 800 }, { js: `location.hash = '#/p/${SLUG}'` }, { ready: true }, { js: 'document.activeElement?.blur?.()' }], expect: bodyFocused, fires: 'free' },
];

// The same page with Monaco unavailable: the plain textarea must behave like the editor.
const FALLBACK_STATES = [
  { id: 'fallback-editor', what: 'typing in the plain editor', steps: [{ js: `document.querySelector('.ws-fallback').focus()` }], expect: activeIs('.ws-fallback'), fires: 'code' },
  { id: 'fallback-body', what: 'nothing focused (plain editor)', steps: [{ js: 'document.activeElement?.blur?.()' }], expect: bodyFocused, fires: 'free' },
  { id: 'fallback-esc', what: 'after Esc out of the plain editor', steps: [{ js: `document.querySelector('.ws-fallback').focus()` }, ESC], expect: activeIs('.ws-run'), fires: 'free' },
];

// An accepted submission plays the celebration; it must not hold the keyboard.
const CELEBRATION_STATES = [
  { id: 'celebration', what: 'the Accepted celebration playing', steps: [focusEditor, cmd('Enter', 'Enter', 13), { idle: true }, { wait: 300 }], expect: `!!document.querySelector('.fx-toast') && ${inEditorText}`, fires: 'code' },
];

// Escape closes the innermost thing and leaves focus where it is useful.
const ESCAPES = [
  { what: 'the editor', steps: [focusEditor], after: activeIs('.ws-run') },
  { what: 'Find', steps: [focusEditor, FIND], after: `${findClosed} && ${inEditorText}` },
  { what: 'the suggest list', steps: [focusEditor, { text: 'con' }, { js: `${ED}.trigger('matrix', 'editor.action.triggerSuggest', {})`, wait: 500 }], after: `!document.querySelector('.monaco-editor .suggest-widget.visible') && ${inEditorText}` },
  { what: 'a selection in the editor', steps: [focusEditor, { js: `${ED}.setSelection(new monaco.Selection(1, 1, 2, 4))` }], after: `${inEditorText} && ${ED}.getSelection().isEmpty()` },
  { what: 'the command palette', steps: [focusEditor, { key: 'F1', code: 'F1', vk: 112, mod: 0 }, { wait: 300 }], after: inEditorText },
  { what: 'Settings', steps: [{ click: '.set-settings' }, { wait: 200 }], after: `!document.querySelector('aside.settings') && ${activeIs('.set-settings')}` },
  { what: 'the model menu', steps: [openCoach, { click: '.coach-compose .ui-select-button' }, { wait: 200 }], after: `![...document.querySelectorAll('[role=menu]')].some(n => !n.hidden && n.getClientRects().length) && ${activeIs('.coach-compose .ui-select-button')}` },
  { what: 'a report sheet', steps: [openReport], after: `!document.querySelector('dialog[open]')` },
  { what: 'the Solution tab', steps: [{ click: '.problem-tabs [data-panel=solution]' }, { js: 'document.activeElement?.blur?.()' }], after: `!document.querySelector('#ref-problem').hidden && location.hash === '#/p/${SLUG}'` },
  // Esc from the Video tab's button returns to Problem, pauses the player and leaves
  // focus on the selected tab button; Esc inside the player belongs to the player.
  { what: 'the Video tab', steps: [...openVideo, focusVideoTab], after: `!document.querySelector('#ref-problem').hidden && !document.querySelector('iframe.video-player')?.getClientRects().length && ${activeIs('.problem-tabs [role=tab]')}` },
  { what: 'inside the video player (Studio must not act)', steps: [...openVideo, { click: 'iframe.video-player', wait: 300 }], after: `document.querySelector('#ref-problem').hidden && location.hash === '#/p/${SLUG}' && document.activeElement?.tagName === 'IFRAME'` },
  { what: 'the coach composer', steps: [openCoach, { click: '.coach-input' }], after: `!document.activeElement.matches('.coach-input') && location.hash === '#/p/${SLUG}'` },
  { what: 'the search box', steps: [{ js: `document.querySelector('#q').focus()` }], after: `!document.activeElement.matches('#q') && location.hash === '#/p/${SLUG}'` },
];

// The catalog's own keys.
const CATALOG = [
  { what: 'J moves the selection', hash: '#/', steps: [{ js: 'document.activeElement?.blur?.()' }], press: { key: 'j', code: 'KeyJ', vk: 74, mod: 0, text: 'j' }, after: `!!document.querySelector('.prow.sel')` },
  { what: 'Enter opens the selected problem', hash: '#/', steps: [{ js: 'document.activeElement?.blur?.()' }, { key: 'j', code: 'KeyJ', vk: 74, mod: 0, text: 'j' }], press: { key: 'Enter', code: 'Enter', vk: 13, mod: 0, text: '\r' }, after: `location.hash.startsWith('#/p/')` },
  { what: 'J in the search box types', hash: '#/', steps: [{ js: `document.querySelector('#q').focus()` }], press: { key: 'j', code: 'KeyJ', vk: 74, mod: 0, text: 'j' }, after: `document.querySelector('#q').value === 'j' && !document.querySelector('.prow.sel')` },
  { what: 'J with Settings open does nothing', hash: '#/', steps: [{ click: '.set-settings' }, { wait: 200 }], press: { key: 'j', code: 'KeyJ', vk: 74, mod: 0, text: 'j' }, after: `!document.querySelector('.prow.sel')` },
];

// The other screens that mount the shared Python editor. Run and Save are theirs; the
// coding-only keys (panes, J/K, /) must not act there. `claimed` is the honest signal on
// these screens: the dispatcher prevents a key exactly when it runs the shortcut.
const LLD_ID = '1760000000000-00000031';
const SCREEN_SHORTCUTS = [
  { id: 'run', label: "⌘'", key: "'", code: 'Quote', vk: 222, mod: 4, effect: 'claimed' },
  { id: 'save', label: '⌘S', key: 's', code: 'KeyS', vk: 83, mod: 4, effect: 'claimed' },
  // No Submit here: in a document ⌘↵ is Monaco's own (insert line below), checked below
  // by asserting that no 'submit' is registered on these screens.
  { id: 'toggle-problem', label: '⌘B', key: 'b', code: 'KeyB', vk: 66, mod: 4, effect: 'claimed' },
  { id: 'step-problem', label: 'J', key: 'j', code: 'KeyJ', vk: 74, mod: 0, text: 'j', effect: 'navigate' },
  { id: 'search', label: '/', key: '/', code: 'Slash', vk: 191, mod: 0, text: '/', effect: 'search' },
];
const SCREEN_PROFILE = {
  python: ['run', 'save'],
  // A composer owns ⌘↵ itself (sends the answer); Run and Save still belong to the screen.
  pythonField: ['run', 'save'],
};
const screenStates = (prefix, { editor, composer, runButton, composerSteps = [] }) => {
  const ed = `monaco.editor.getEditors().find(e => e.getDomNode().closest(${JSON.stringify(editor)}))`;
  const focus = { js: `${ed}.focus()` };
  const inText = `${ed}.hasTextFocus()`;
  return [
    { id: `${prefix}-editor`, what: 'typing in the document', steps: [focus], expect: inText, fires: 'python' },
    { id: `${prefix}-body`, what: 'nothing focused', steps: [{ js: 'document.activeElement?.blur?.()' }], expect: bodyFocused, fires: 'python' },
    { id: `${prefix}-find`, what: 'Find open in the document', steps: [focus, FIND], expect: `!!document.activeElement.closest('.find-widget')`, fires: 'python' },
    { id: `${prefix}-find-closed`, what: 'Find closed with Escape', steps: [focus, FIND, ESC], expect: `${findClosed} && ${inText}`, fires: 'python' },
    { id: `${prefix}-esc`, what: 'after Esc out of the document', steps: [focus, ESC], expect: activeIs(runButton), fires: 'python' },
    ...(composer ? [{ id: `${prefix}-composer`, what: 'typing to the coach', steps: [...composerSteps, { click: composer }], expect: activeIs(composer), fires: 'pythonField' }] : []),
  ];
};
const SCREENS = [
  { label: 'LLD practice', start: '#/lld', ready: `!!document.querySelector('.pr-coach') && !!document.querySelector('.editor-wrap') && !!window.monaco?.editor.getEditors().length`,
    states: screenStates('practice', { editor: '.pr-editor', composer: '.pr-typed textarea', runButton: '.python-run',
      composerSteps: [{ js: `[...document.querySelectorAll('.ui-mode-switch')].find(b => b.dataset.mode !== 'voice')?.click()`, wait: 300 }] }) },
  { label: 'LLD mock', hash: `#/lld/lld-locker/${LLD_ID}`, ready: `!!document.querySelector('.lld-code .monaco-editor') && !!window.monaco?.editor.getEditors().length`,
    // The paused mock's answer box is disabled until Resume, and resuming is a live
    // interview; check:interview drives the mock composer (⌘↵ answers) with fakes.
    states: screenStates('lld', { editor: '.lld-code', composer: null, runButton: '.python-run' }) },
];

/* ------------------------------------------------------------------ harness */

const inflight = new Map();
async function cdp() {
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    if (m.method === 'Network.requestWillBeSent') inflight.set(m.params.requestId, m.params.request.method + ' ' + m.params.request.url.replace(/^http:\/\/127.0.0.1:\d+/, '') + (m.params.request.isLinkPreload ? '' : '') + ' t' + Math.round(performance.now() / 1000));
    if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') inflight.delete(m.params.requestId);
    // A page that warns before unload (unsaved practice work) would block navigation.
    if (m.method === 'Page.javascriptDialogOpening') {
      if (process.env.MATRIX_DEBUG) console.log(`    dialog: ${m.params.type} ${m.params.message}`);
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { waiting.delete(n); reject(Error(`CDP timeout: ${method}`)); }, 20000);
    waiting.set(n, (m) => { clearTimeout(timer); resolve(m); });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate threw');
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

await requireFreePort(DEBUG_PORT);
// The fake CLIs answer the model list at once (with no binary that request never ends,
// and six of them left over from reloads exhaust the browser's connections to the
// server). No coach turn is ever sent from this check.
const ROOT = new URL('..', import.meta.url).pathname;
const scratch = await startScratch(SERVER_PORT, SLUG, {
  STUDIO_COACH_BINARY: `${ROOT}server/coach/test/bin/fake-claude.mjs`,
  STUDIO_CODEX_BINARY: `${ROOT}server/coach/test/bin/fake-codex.mjs`,
});
{
  // A paused LLD mock to mount the LLD screen on. Nothing in it can call a model.
  const { newState } = await import('../server/interview/state.mjs');
  const { InterviewStore } = await import('../server/interview/store.mjs');
  const store = new InterviewStore({ root: scratch.home });
  await store.create('lld-locker', LLD_ID, { ...newState({ slug: 'lld-locker', mode: 'typed', startedAt: Date.now() }),
    discipline: 'lld', targetLevel: 'L4', pausedAt: Date.now(), lastCode: '# Candidate design\nclass Locker:\n    pass\n' });
  await store.append('lld-locker', LLD_ID, { kind: 'opening', elapsedMs: 0, asked: 'Design a parcel locker system.' });
}
const PROFILE_DIR = await fsp.mkdtemp(`${os.tmpdir()}/studio-shortcut-matrix-`);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-background-networking', '--no-first-run', `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${PROFILE_DIR}`, '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });

// The Video tab embeds a cross-origin player; the fake answers its protocol locally.
const { startFakeYouTube } = await import('./fake-youtube.mjs');
const fakeVideo = await startFakeYouTube();

const failures = [];
let checked = 0;
const fail = (line) => { failures.push(line); console.log(`  FAIL ${line}`); };

try {
  await sleep(2000);
  const { send, evaluate, close } = await cdp();
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  // A headless page without focus emulation can lose focus between steps.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: fakeVideo.inject() });
  // Practice starts in voice mode; it must never open a real microphone.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Microphone disabled in the shortcut matrix', 'NotAllowedError');
    };` });

  const press = async ({ key, code, vk, mod = 0, text }) => {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mod };
    // A printable key with no command modifier types: keyDown carries its text.
    if (text && !(mod & 6)) await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text, unmodifiedText: text });
    else await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const click = async (selector) => {
    const box = await evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null;
      n.scrollIntoView({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2 }; })()`);
    if (!box) throw Error(`nothing to click at ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
  };
  const idle = () => evaluate(`(async () => {
    for (let i = 0; i < 100; i++) {
      if (!document.querySelector('.ws-run.busy, .ws-submit.busy')) return true;
      await new Promise(r => setTimeout(r, 50));
    }
    return false;
  })()`);
  const CODING_READY = `(document.querySelector('.ws-fallback') || window.monaco?.editor?.getEditors?.().find(e => e.getDomNode()?.isConnected))
    && document.querySelector('.ws-submit') && !document.querySelector('.ws-submit').disabled && document.querySelector('#ref-problem p')`;
  let readyExpr = CODING_READY;
  const ready = (expr = readyExpr) => evaluate(`(async () => {
    for (let i = 0; i < 150; i++) {
      try { if (${expr}) return true; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  })()`);
  const step = async (s) => {
    if (s.js) await evaluate(s.js);
    if (s.key) await press(s);
    if (s.text && !s.key) await send('Input.insertText', { text: s.text });
    if (s.click) await click(s.click);
    if (s.idle) await idle();
    if (s.ready && !(await ready())) throw Error('the workspace did not come back');
    await sleep(s.wait ?? 80);
  };

  // Install the observers once per page load. Counters only ever go up.
  const OBSERVE = `(() => {
    if (window.__matrix) return;
    window.__matrix = { runs: 0, verdicts: 0, last: null };
    window.__focuslog = [];
    document.addEventListener('focusout', e => { window.__focuslog.push(String(e.target.className).slice(0, 30) + ' -> ' + String(e.relatedTarget?.className ?? 'null').slice(0, 30) + ' @' + (new Error().stack.split('\\n')[2] || '').trim().slice(0, 90)); window.__focuslog = window.__focuslog.slice(-4); }, true);
    window.addEventListener('studio-interview-work', e => {
      if (e.detail.type === 'run_result') window.__matrix.runs++;
      if (e.detail.type === 'verdict') window.__matrix.verdicts++;
    });
    // The keydown object outlives its dispatch, so defaultPrevented is readable afterwards.
    window.addEventListener('keydown', e => { window.__matrix.last = e; }, true);
  })()`;
  const SNAPSHOT = `(() => ({
    runs: window.__matrix.runs, verdicts: window.__matrix.verdicts,
    running: !!document.querySelector('.ws-run.busy'), judging: !!document.querySelector('.ws-submit.busy'),
    hideProblem: document.body.classList.contains('hide-problem'),
    hideResults: document.body.classList.contains('hide-results'),
    coach: document.body.classList.contains('coach-open'),
    hash: location.hash,
    tab: document.querySelector('.problem-tabs [aria-selected=true]')?.dataset.panel ?? null,
    shuffle: !!document.querySelector('[data-shuffle-notice]') || !!document.querySelector('.pnav-shuffle.busy, .shufflebtn.busy'),
    search: document.activeElement === document.querySelector('#q'),
    prevented: !!window.__matrix.last?.defaultPrevented,
  }))()`;
  // The dispatcher prevents a key exactly when it acts. Requiring that as well as the
  // effect keeps typing that happens to navigate (a letter in the search box opens the
  // catalog) from reading as a shortcut.
  const acted = (effect, a, b) => b.prevented && ({
    run: b.runs > a.runs || (b.running && !a.running),
    submit: b.verdicts > a.verdicts || (b.judging && !a.judging),
    claimed: b.prevented,
    problemPane: a.hideProblem !== b.hideProblem,
    resultsPane: a.hideResults !== b.hideResults,
    coachPane: a.coach !== b.coach,
    navigate: a.hash !== b.hash,
    tab: a.tab !== b.tab,
    shuffle: a.hash !== b.hash || (!a.shuffle && b.shuffle),
    search: (!a.search && b.search) || a.hash !== b.hash,
  })[effect];

  let url = '';
  let baselineCoach = false;
  const load = async (target, expr = readyExpr) => {
    url = target; readyExpr = expr;
    // Practice warns before unload (the microphone stub leaves its capture "failed"). The
    // dialog is accepted by the CDP listener, so wait until about:blank has really
    // committed: a navigation sent while the prompt is up is silently dropped.
    await send('Page.navigate', { url: 'about:blank' });
    for (let i = 0; i < 50 && (await evaluate('location.href')) !== 'about:blank'; i++) await sleep(100);
    await send('Page.navigate', { url });
    if (!(await ready())) {
      const seen = await Promise.race([evaluate(`location.href + ' ' + document.readyState + ' ' + (document.querySelector('#app')?.textContent || '').trim().slice(0, 160)`), sleep(3000).then(() => 'page not answering')]);
      throw Error(`the screen never became ready at ${url} (${seen})`);
    }
    await evaluate(OBSERVE);
    baselineCoach = await evaluate(`document.body.classList.contains('coach-open')`);
  };
  // At rest, nothing on the screen may read as an open overlay: that is the stale state
  // that used to switch every shortcut off.
  const atRest = async (label) => {
    const open = await evaluate(`(async () => (await import('/js/keyboard.js')).hasOpenOverlay())()`);
    checked++;
    if (open) fail(`${label}: at rest, the page already reports an open overlay`);
  };
  // Put the page back to rest without a reload when nothing navigated or opened.
  const settle = async () => {
    const soft = await evaluate(`(async () => {
      const shown = n => n.getClientRects().length > 0 && !n.hidden;
      if (location.hash !== ${JSON.stringify(new URL(url).hash)}) return false;
      if ([...document.querySelectorAll('dialog[open], aside.settings, [role=menu], [popover]')].some(n => shown(n) && (!n.matches('[popover]') || n.matches(':popover-open')))) return false;
      if (document.querySelector('.quick-input-widget') && shown(document.querySelector('.quick-input-widget')) && getComputedStyle(document.querySelector('.quick-input-widget')).display !== 'none') return false;
      if (document.querySelector('.monaco-editor .shadow-root-host')) return false;
      for (const editor of window.monaco?.editor?.getEditors?.() ?? []) {
        editor.trigger('matrix', 'closeFindWidget'); editor.trigger('matrix', 'hideSuggestWidget');
      }
      document.querySelector('[data-shuffle-notice]')?.remove();
      if (document.body.classList.contains('hide-problem')) document.querySelector('.prob-toggle')?.click();
      if (document.body.classList.contains('hide-results')) window.dispatchEvent(new CustomEvent('studio:toggle-results'));
      if (document.body.classList.contains('coach-open') !== ${'${BASE}'}) document.querySelector('.workspace-rail [data-pane=coach]')?.click();
      const tab = document.querySelector('.problem-tabs [aria-selected=true]');
      if (tab && tab.dataset.panel !== 'problem') document.querySelector('.problem-tabs [data-panel=problem]').click();
      document.activeElement?.blur?.();
      for (let i = 0; i < 100 && document.querySelector('.ws-run.busy, .ws-submit.busy'); i++) await new Promise(r => setTimeout(r, 50));
      return true;
    })()`.replace('${BASE}', String(baselineCoach)));
    if (!soft) await load(url);
    else await sleep(150);
  };

  const setUp = async (state) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await settle();
      try { for (const s of state.steps) await step(s); } catch (error) { if (attempt) throw error; await load(url); continue; }
      if (await evaluate(state.expect)) return true;
      if (process.env.MATRIX_DEBUG) console.log('    setup miss', state.id, await evaluate(`document.activeElement.tagName + '.' + document.activeElement.className + ' ' + location.hash + ' ' + JSON.stringify(window.__focuslog) + ' select:' + [...document.querySelectorAll('.coach-compose .ui-select-button')].map(b => b.disabled + '/' + b.getClientRects().length + '/' + b.textContent).join(',') + ' menus:' + [...document.querySelectorAll('[role=menu]')].map(m => m.hidden + '/' + m.getClientRects().length + '/' + m.textContent.slice(0, 40)).join(',')`));
      await load(url);
    }
    return false;
  };

  const runStates = async (label, target, states, { shortcuts = SHORTCUTS, profiles = PROFILE, expr = CODING_READY } = {}) => {
    console.log(`\n${label}`);
    if (target) await load(target, expr);
    await atRest(label);
    for (const state of states) {
      if (ONLY && !ONLY.test(state.id)) continue;
      const expected = new Set(profiles[state.fires]);
      const row = [];
      for (const shortcut of shortcuts) {
        if (!(await setUp(state))) { fail(`${state.what}: could not set up the state (${state.expect})`); row.push('✗setup'); break; }
        const before = await evaluate(SNAPSHOT);
        await evaluate('window.__matrix.last = null');
        await press(shortcut);
        await sleep(250);
        const after = await evaluate(SNAPSHOT);
        const did = Boolean(acted(shortcut.effect, before, after));
        checked++;
        const want = expected.has(shortcut.id);
        row.push(`${did === want ? '' : '✗'}${shortcut.label}${did ? '' : '·off'}`);
        if (did !== want) {
          const focus = await evaluate(`(() => { const a = document.activeElement; return a === document.body ? 'body' : a.tagName.toLowerCase() + '.' + String(a.className).split(' ').slice(0, 2).join('.'); })()`);
          fail(`${state.what}: ${shortcut.label} ${want ? 'did nothing' : 'fired'} (focus ${focus})`);
        }
      }
      console.log(`  ${row.every(c => !c.startsWith('✗')) ? 'ok  ' : 'FAIL'} ${state.what.padEnd(52)} ${row.join(' ')}`);
    }
  };

  const base = `${scratch.origin}/?simsubmit=wrong&simrun=pass#/p/${SLUG}`;

  // 1. The registry: every shortcut the app registers is in this table, and back.
  await load(base);
  const registered = await evaluate(`(async () => {
    const keyboard = await import('/js/keyboard.js');
    return typeof keyboard.listShortcuts === 'function' ? keyboard.listShortcuts().map(s => s.id) : null;
  })()`);
  if (!registered) fail('the app has no shortcut registry (keyboard.js listShortcuts) to check this table against');
  else {
    const known = new Set([...ALL, ...Object.keys(COVERED_ELSEWHERE)]);
    const missing = [...new Set(registered)].filter(id => !known.has(id));
    for (const id of missing) fail(`shortcut "${id}" is registered by the app but has no row in SHORTCUTS`);
    const unregistered = ALL.filter(id => !registered.includes(id));
    for (const id of unregistered) fail(`SHORTCUTS row "${id}" is not registered on the coding screen`);
    if (!missing.length && !unregistered.length) console.log(`  ok   ${new Set(registered).size} registered shortcuts, all in the table`);
  }

  // 2. The matrix.
  await runStates('Coding workspace', base, STATES);
  await runStates('Accepted submission', `${scratch.origin}/?simsubmit=accepted&simrun=pass#/p/${SLUG}`, CELEBRATION_STATES);

  // The Reset toast must not stand between ⌘Z and the editor.
  if (!ONLY || ONLY.test('reset-toast')) {
    await settle();
    for (const s of STATES.find(x => x.id === 'reset-toast').steps) await step(s);
    const showing = await evaluate(`!!document.querySelector('.fx-toast--note.is-in')`);
    await press({ key: 'z', code: 'KeyZ', vk: 90, mod: 4 });
    await sleep(250);
    const undone = await evaluate(`${ED}.getValue().includes('# mine') && ${inEditorText}`);
    checked++;
    if (showing && undone) console.log('  ok   ⌘Z with the Reset toast showing undoes the reset, focus stays in the code');
    else fail(`⌘Z with the Reset toast showing: toast=${showing} undone=${undone}`);
  }

  // 3. Escape.
  console.log('\nEscape');
  await load(base);
  for (const e of ESCAPES) {
    if (ONLY && !ONLY.test(e.what)) continue;
    await settle();
    for (const s of e.steps) await step(s);
    await press(ESC);
    await sleep(300);
    const ok = await evaluate(e.after);
    checked++;
    const focus = await evaluate(`(() => { const a = document.activeElement; return a === document.body ? 'body' : a.tagName.toLowerCase() + '.' + String(a.className).split(' ').slice(0, 2).join('.'); })()`);
    if (ok) console.log(`  ok   Esc from ${e.what} → focus ${focus}`);
    else fail(`Esc from ${e.what}: expected ${e.after}, focus ended on ${focus} (${await evaluate(`(() => { const a = document.activeElement; return (a.getAttribute('aria-selected') || '') + ' ' + (a.dataset?.panel || '') + ' problemHidden=' + document.querySelector('#ref-problem')?.hidden + ' iframeRects=' + (document.querySelector('iframe.video-player')?.getClientRects().length ?? 'none'); })()`)}) at ${await evaluate('location.hash')}`);
  }

  // 4. The catalog.
  console.log('\nCatalog');
  for (const c of CATALOG) {
    if (ONLY && !ONLY.test(c.what)) continue;
    await send('Page.navigate', { url: 'about:blank' });
    await send('Page.navigate', { url: `${scratch.origin}/${c.hash}` });
    await evaluate(`(async () => { for (let i = 0; i < 100 && !document.querySelector('.prow'); i++) await new Promise(r => setTimeout(r, 100)); })()`);
    for (const s of c.steps) await step(s);
    await press(c.press);
    await sleep(300);
    checked++;
    if (await evaluate(c.after)) console.log(`  ok   ${c.what}`);
    else fail(`catalog: ${c.what}`);
  }

  // 5. Without Monaco, the plain editor keeps every promise.
  await send('Network.setBlockedURLs', { urls: ['*/vendor/monaco/*'] });
  await runStates('Plain editor (Monaco unavailable)', base, FALLBACK_STATES);
  await send('Network.setBlockedURLs', { urls: [] });

  // 6. The other Python screens.
  for (const screen of SCREENS) {
    if (screen.start) {
      await load(`${scratch.origin}/${screen.start}`, `!!document.querySelector('.th[data-state=ready] .th-problem[data-slug]')`);
      await evaluate(`document.querySelector('.th-problem[data-slug]').click(); document.querySelector('.th-practice').click()`);
      if (!(await ready(screen.ready))) throw Error(`${screen.label} never opened`);
      url = `${scratch.origin}/${await evaluate('location.hash')}`; readyExpr = screen.ready;
      await evaluate(OBSERVE);
    }
    await runStates(screen.label, screen.hash ? `${scratch.origin}/${screen.hash}` : null, screen.states,
      { shortcuts: SCREEN_SHORTCUTS, profiles: SCREEN_PROFILE, expr: screen.ready });
  }

  // 7. The whiteboard. No app shortcut belongs to a design screen: the board's own keys
  // (tools, undo, ⌘ chords) must reach Excalidraw, and the coding keys must do nothing.
  if (!ONLY || ONLY.test('design-board')) {
    console.log('\nSystem design practice (whiteboard)');
    await load(`${scratch.origin}/#/design`, `!!document.querySelector('.th[data-state=ready] .th-problem[data-slug]')`);
    await evaluate(`document.querySelector('.th-problem[data-slug]').click(); document.querySelector('.th-practice').click()`);
    if (!(await ready(`!!document.querySelector('.pr-board .excalidraw canvas')`))) throw Error('the whiteboard never opened');
    url = `${scratch.origin}/${await evaluate('location.hash')}`; readyExpr = `!!document.querySelector('.pr-board .excalidraw canvas')`;
    await evaluate(OBSERVE);
    await atRest('the whiteboard');
    const tool = `(document.querySelector('.excalidraw [data-testid="toolbar-rectangle"]')?.checked ?? null)`;
    const boardChecks = [
      { what: 'R on the board picks its rectangle tool', press: { key: 'r', code: 'KeyR', vk: 82, mod: 0, text: 'r' }, after: `${tool} === true` },
      { what: '⌘B on the board toggles no pane', press: { key: 'b', code: 'KeyB', vk: 66, mod: 4 }, after: `!document.body.classList.contains('hide-problem') && location.hash === ${JSON.stringify(new URL(url).hash)}` },
      { what: '/ on the board does not jump to search', press: { key: '/', code: 'Slash', vk: 191, mod: 0, text: '/' }, after: `document.activeElement !== document.querySelector('#q') && location.hash === ${JSON.stringify(new URL(url).hash)}` },
      { what: "⌘' on the board runs nothing (no Run here)", press: { key: "'", code: 'Quote', vk: 222, mod: 4 }, after: `!(window.__matrix.last?.defaultPrevented && document.querySelector('.python-run'))` },
    ];
    for (const c of boardChecks) {
      await click('.pr-board .excalidraw canvas.interactive, .pr-board .excalidraw canvas');
      await sleep(150);
      await press(c.press);
      await sleep(250);
      checked++;
      if (await evaluate(c.after)) console.log(`  ok   ${c.what}`);
      else fail(`whiteboard: ${c.what}`);
      await press(ESC); await sleep(100);
    }
  }

  close();
} catch (error) {
  fail(`could not finish: ${error.message}`);
} finally {
  const exited = chrome.exitCode === null && chrome.signalCode === null
    ? new Promise((resolve) => chrome.once('exit', resolve)) : Promise.resolve();
  chrome.kill();
  await exited;
  await scratch.cleanup();
  await fakeVideo.close();
  await cleanupChrome(chrome, PROFILE_DIR);
}

if (failures.length) {
  console.error(`\nshortcut matrix FAILED — ${failures.length} of ${checked} wrong:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`\nshortcut matrix ok — ${checked} state × key checks, every shortcut where it belongs`);
