// One Python editor for coding, LLD interviews and untimed practice. Workspaces
// own saving/running; this module owns editing, preferences and lifecycle.
import { el } from './dom.js';
import { claimActionKey, hasOpenOverlay } from './keyboard.js';
import { getSettings, isDark, onSettingsChange } from './settings.js';
import { attachTypingFx } from './typing-fx.js';
import { attachTypingReveal } from './typing-reveal.js';
import { icon } from './ui/icon.js';

const MONACO_BASE = new URL('../vendor/monaco/vs', import.meta.url).href;
const WRAP_KEY = 'studio.editor.wrap';
const WRAP_EVENT = 'studio:editor-wrap';
function readWrap() {
  try { return localStorage.getItem(WRAP_KEY) === 'on'; } catch { return false; }
}
function writeWrap(on) {
  try { localStorage.setItem(WRAP_KEY, on ? 'on' : 'off'); } catch { /* preference still works for this page */ }
  window.dispatchEvent(new CustomEvent(WRAP_EVENT, { detail: on }));
}

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
export function loadMonaco() {
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

/** Monaco follows the selected family and effective appearance. */
export function monacoThemeFor(theme, dark = false) {
  return `ps-${theme}-${dark ? 'dark' : 'light'}`;
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
    'focusBorder': '#00000000',
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
  // Slate: the light theme's palette, re-lit. Same hue for each token so the code reads
  // the same way in both modes — only the ground and the contrast change.
  monaco.editor.defineTheme('ps-studio-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'E8E8E8' },
      { token: 'comment', foreground: '7A7A7A', fontStyle: 'italic' },
      { token: 'string', foreground: '8FD9AE' },
      { token: 'number', foreground: 'E3B457' },
      { token: 'keyword', foreground: 'C7A0E8' },
      { token: 'keyword.flow', foreground: 'C7A0E8' },
      { token: 'type', foreground: '86C2EC' },
      { token: 'type.identifier', foreground: '86C2EC' },
      { token: 'predefined', foreground: '86C2EC' },
      { token: 'identifier', foreground: 'E8EAED' },
      { token: 'delimiter', foreground: 'A0A0A0' },
      { token: 'operator', foreground: 'A0A0A0' },
    ],
    colors: {
      'editor.background': '#161616',
      'editor.foreground': '#E8E8E8',
      'editorGutter.background': '#161616',
      'editorLineNumber.foreground': '#969696',
      'editorLineNumber.activeForeground': '#E8EAED',
      'editor.lineHighlightBackground': '#1E1E1E',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#91A7FF',
      'editor.selectionBackground': '#E8EAED26',
      'editor.inactiveSelectionBackground': '#E8EAED14',
      'editorIndentGuide.background1': '#FFFFFF12',
      'editorIndentGuide.activeBackground1': '#FFFFFF2E',
      'editorWhitespace.foreground': '#FFFFFF18',
      'editorBracketMatch.background': '#00000000',
      ...widgetColors({
        ground: '#101010', raised: '#222222', ink: '#E8E8E8', dim: '#A0A0A0',
        edge: '#3A3A3A', accent: '#91A7FF', onAccent: '#161616',
        match: '#91A7FF4D', matchDim: '#91A7FF26', hoverWash: '#FFFFFF12',
      }),
    },
  });

  monaco.editor.defineTheme('ps-studio-light', {
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
      'editorLineNumber.foreground': '#737373',
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

  // Each generated row supplies syntax hues as well as the editor surfaces.
  const palettes = [
    ['ps-desk-light', 'vs', '#FFFDF9', '#181818', '#F6F2EA', '#756C63', '#BD5F3C', '#A34A2A', '#2F5D7C', '#3F7A55', '#8A5D0E', '#BD5F3C2E', ''],
    ['ps-desk-dark', 'vs-dark', '#211E1B', '#EEE8E0', '#2A2622', '#A3998F', '#E2875F', '#E59A78', '#8FB8D8', '#9ACB9F', '#E0B060', '#E2875F33', ''],
    ['ps-dunes-light', 'vs', '#FBF2E800', '#2A1A10', '#C2491D12', '#75685E', '#C2491D', '#B0431C', '#2F5D7C', '#2E6B4F', '#8C5A06', '#C2491D33', ''],
    ['ps-dunes-dark', 'vs-dark', '#08141A00', '#E9E4DA', '#FF9A6212', '#999C99', '#FF9A62', '#FF9A62', '#8CC7D9', '#7FD4A0', '#F2CB6C', '#FF9A6233', ''],
  ];
  for (const [name, base, background, foreground, line, dim, accent, keyword, type, string, number, selection, fontStyle] of palettes) {
    const dark = base === 'vs-dark';
    const art = name.startsWith('ps-dunes-');
    monaco.editor.defineTheme(name, {
      base, inherit: true,
      rules: [
        { token: '', foreground: foreground.slice(1) },
        { token: 'comment', foreground: dim.slice(1), fontStyle: 'italic' },
        { token: 'string', foreground: string.slice(1) }, { token: 'number', foreground: number.slice(1) },
        { token: 'keyword', foreground: keyword.slice(1), fontStyle },
        { token: 'type', foreground: type.slice(1) }, { token: 'predefined', foreground: type.slice(1) },
        { token: 'identifier', foreground: foreground.slice(1) }, { token: 'delimiter', foreground: dim.slice(1) },
        { token: 'operator', foreground: dim.slice(1) },
      ],
      colors: {
        'editor.background': background, 'editor.foreground': foreground,
        'editorGutter.background': background, 'editorLineNumber.foreground': dim,
        'editorLineNumber.activeForeground': foreground, 'editor.lineHighlightBackground': line,
        'editor.lineHighlightBorder': '#00000000', 'editorCursor.foreground': accent,
        'editor.selectionBackground': selection, 'editorIndentGuide.background1': dark ? '#FFFFFF12' : '#00000012',
        'editorIndentGuide.activeBackground1': dark ? '#FFFFFF2E' : '#0000002E',
        'editorWhitespace.foreground': dark ? '#FFFFFF18' : '#00000018',
        // Sticky scroll pins scope headers over the code and defaults to the editor
        // background. Art themes make that transparent, so the pinned lines drew
        // straight over the real ones. The band must be solid, hovered or not.
        'editorStickyScroll.background': background.slice(0, 7),
        'editorStickyScrollHover.background': art ? (dark ? '#10232A' : '#FFF9F0') : line,
        ...widgetColors({ ground: art ? background.slice(0, 7) : background, raised: art ? (dark ? '#10232A' : '#FFF9F0') : line, ink: foreground, dim,
          edge: dark ? '#FFFFFF22' : '#00000022', accent, onAccent: art ? (dark ? background.slice(0, 7) : '#FFFFFF') : (dark ? background : '#FFFFFF'), match: `${accent}40`,
          matchDim: `${accent}1F`, hoverWash: dark ? '#FFFFFF12' : '#0000000D' }),
      },
    });
  }
}

const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Defaults for someone typing algorithms all day: four spaces, no minimap,
 *  and nothing that pops up over the code while they are thinking. */
function editorOptions(host) {
  const spacing = getComputedStyle(host);
  return {
    language: 'python',
    theme: monacoThemeFor(getSettings().theme, isDark()),
    automaticLayout: true,
    fontFamily: MONO_STACK,
    fontSize: getSettings().codeSize,
    lineHeight: 22,
    tabSize: 4,
    insertSpaces: true,
    detectIndentation: false,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    // Scrolling here is keyboard-driven (PageDown, find-next, go-to-line) and happens all
    // day; an animated scroll is latency, not polish.
    smoothScrolling: false,
    cursorBlinking: getSettings().motion ? 'smooth' : 'solid',
    // The caret glides to each new character, so the reveal and the caret travel together.
    cursorSmoothCaretAnimation: getSettings().motion && getSettings().typingFx !== false ? 'on' : 'off',
    renderLineHighlight: 'line',
    wordWrap: readWrap() ? 'on' : 'off',
    renderWhitespace: 'selection',
    lineNumbersMinChars: 3,
    glyphMargin: false,
    folding: true,
    padding: {
      top: parseFloat(spacing.getPropertyValue('--python-editor-padding-top')) || 12,
      bottom: parseFloat(spacing.getPropertyValue('--python-editor-padding-bottom')) || 16,
    },
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

/* -------------------------- shared editor adapters ------------------------- */
function textareaEditor(host, initial, { label, readOnly }) {
  const area = el('textarea', {
    class: 'ws-fallback', spellcheck: 'false', autocomplete: 'off',
    autocapitalize: 'off', autocorrect: 'off', 'aria-label': label,
  });
  area.value = initial; area.setSelectionRange(0, 0); area.readOnly = readOnly;
  host.append(area);
  let changed = () => {}, cursor = () => {};
  const position = () => {
    const lines = area.value.slice(0, area.selectionStart).split('\n');
    return { lineNumber: lines.length, column: lines.at(-1).length + 1 };
  };
  const notifyCursor = () => cursor(position());
  area.addEventListener('input', () => { changed(); notifyCursor(); });
  for (const event of ['keyup', 'click', 'select']) area.addEventListener(event, notifyCursor);
  area.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || area.readOnly) return;
    event.preventDefault();
    area.setRangeText('    ', area.selectionStart, area.selectionEnd, 'end');
    changed(); notifyCursor();
  });
  return {
    kind: 'textarea', raw: { area },
    getValue: () => area.value,
    setValue: value => { area.value = value; notifyCursor(); },
    getPosition: position,
    focus: () => area.focus(), blur: () => area.blur(),
    hasFocus: () => document.activeElement === area,
    onChange: fn => { changed = fn; }, onCursorChange: fn => { cursor = fn; },
    setReadOnly: value => { area.readOnly = value; },
    setFontSize: px => { area.style.fontSize = `${px}px`; },
    setTheme: () => {}, setMotion: () => {},
    setWrap: on => { area.wrap = on ? 'soft' : 'off'; },
    layout: () => {}, dispose: () => area.remove(),
  };
}

function monacoEditor(monaco, host, initial, { label, readOnly }) {
  const instance = monaco.editor.create(host, { ...editorOptions(host), value: initial, readOnly, ariaLabel: label });
  const model = instance.getModel();
  const stopFx = attachTypingFx(instance, host, monaco);
  const stopReveal = attachTypingReveal(instance, monaco, { getSettings, onSettingsChange });
  let changed = () => {}, cursor = () => {};
  instance.onDidChangeModelContent(() => changed());
  instance.onDidChangeCursorPosition(event => cursor(event.position));
  return {
    kind: 'monaco', raw: { instance, monaco },
    getValue: () => instance.getValue(),
    setValue: value => {
      // Preserve undo when a workspace restores a draft or the learner's earlier work.
      if (!model || model.isDisposed()) return;
      instance.pushUndoStop();
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
      instance.pushUndoStop();
    },
    getPosition: () => instance.getPosition(),
    focus: () => instance.focus(), blur: () => host.querySelector('textarea')?.blur(),
    hasFocus: () => instance.hasTextFocus(),
    onChange: fn => { changed = fn; }, onCursorChange: fn => { cursor = fn; },
    setReadOnly: value => instance.updateOptions({ readOnly: value }),
    setFontSize: px => instance.updateOptions({ fontSize: px }),
    setMotion: (on, typing = true) => instance.updateOptions({
      cursorBlinking: on ? 'smooth' : 'solid', cursorSmoothCaretAnimation: on && typing ? 'on' : 'off',
    }),
    setTheme: name => monaco.editor.setTheme(name),
    setWrap: on => instance.updateOptions({ wordWrap: on ? 'on' : 'off' }),
    layout: () => instance.layout(),
    dispose: () => {
      stopFx(); stopReveal(); instance.dispose();
      // Dispose our own model only, after detaching the editor and its listeners.
      if (model && !model.isDisposed()) model.dispose();
    },
  };
}

/** The same file-row controls wherever a learner writes Python. */
export function createPythonEditorControls() {
  let stopCursor;
  const cursor = el('span', { class: 'editor-cursor', text: 'Ln 1, Col 1' });
  const label = el('span');
  const wrapButton = el('button', { class: 'btn btn--icon editor-tool editor-wrap', type: 'button', title: 'Wrap long lines', 'aria-label': 'Wrap long lines',
    onclick: () => { const on = wrapButton.getAttribute('aria-pressed') !== 'true'; paintWrap(on); writeWrap(on); },
  }, [icon('wrap', 14)]);
  const root = el('span', { class: 'python-editor-tools' }, [cursor, wrapButton]);
  function paintWrap(on) { wrapButton.setAttribute('aria-pressed', String(on)); label.textContent = on ? 'Wrap on' : 'Wrap off'; }
  paintWrap(readWrap());
  return {
    root, cursor, wrapButton, paintWrap,
    bind(editor) {
      stopCursor?.dispose();
      const paint = ({ lineNumber, column }) => { cursor.textContent = `Ln ${lineNumber}, Col ${column}`; };
      stopCursor = editor.onCursorChange(paint); paint(editor.getPosition());
    },
    dispose() { stopCursor?.dispose(); stopCursor = null; },
  };
}

/** Immediately usable, then upgrades in place. A failed or late Monaco load must
 * never lose a keystroke, change read-only state, or recreate a departed editor. */
export function mountPythonEditor(host, initial = '', options = {}) {
  const { controls, onRun, onSubmit, onSave, onEscape, label = 'Python solution' } = options;
  let readOnly = Boolean(options.readOnly), disposed = false, frame;
  let changed = options.onChange || (() => {}), wrapped = readWrap();
  // Monaco's line-number width is capacity, not an edge inset. Reserve real space
  // outside its coordinate system so 3/4-digit gutters, sticky rows, selections,
  // folding controls and the fallback all keep the same distance from the pane.
  host.classList.add('python-editor-frame');
  const viewport = el('div', { class: 'python-editor-viewport' });
  host.append(viewport);
  let current = textareaEditor(viewport, initial, { label, readOnly });
  const cursors = new Set();
  const notifyCursor = position => { for (const fn of cursors) fn(position); };
  function connect() {
    current.onChange(() => changed()); current.onCursorChange(notifyCursor);
    applySettings(getSettings()); current.setWrap(wrapped);
    controls?.paintWrap(wrapped); notifyCursor(current.getPosition());
  }
  function applySettings(settings) {
    current.setFontSize(settings.codeSize);
    current.setMotion(settings.motion, settings.typingFx !== false);
    current.setTheme(monacoThemeFor(settings.theme, isDark()));
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { if (!disposed) current.layout(); });
  }
  function applyWrap(on) { wrapped = on; current.setWrap(on); controls?.paintWrap(on); }
  const onWrap = event => applyWrap(event.detail);
  const onStorage = event => { if (event.key === WRAP_KEY || event.key === null) applyWrap(readWrap()); };
  window.addEventListener(WRAP_EVENT, onWrap); window.addEventListener('storage', onStorage);
  const unsettings = onSettingsChange(applySettings);
  // The host boundary catches commands in both adapters. Capture keeps Monaco and
  // outer app shortcuts from executing the same Run/Save twice. Find/undo/folding
  // remain Monaco's native commands; no global shortcuts consume typed letters.
  function onKey(event) {
    // Find/replace, quick input, and other Monaco widgets own their keys. Being
    // somewhere inside the editor host is not enough intent to run or submit code.
    if (hasOpenOverlay() || !current.hasFocus()) return;
    const meta = (event.metaKey || event.ctrlKey) && !event.altKey;
    const action = meta && event.key === 'Enter' ? onSubmit
      : meta && event.key === "'" ? onRun
      : meta && event.key.toLowerCase() === 's' ? onSave
      : event.key === 'Escape' && (current.kind === 'textarea' || !host.querySelector('.find-widget.visible')) ? onEscape : null;
    if (action && claimActionKey(event)) action();
  }
  const stopKey = event => event.stopPropagation();
  host.addEventListener('keydown', onKey, true); host.addEventListener('keydown', stopKey);
  const api = {
    get kind() { return current.kind; }, get raw() { return current.raw; },
    getValue: () => current.getValue(), setValue: value => current.setValue(value),
    getPosition: () => current.getPosition(),
    focus: () => current.focus(), blur: () => current.blur(), hasFocus: () => current.hasFocus(),
    onChange: fn => { changed = fn; },
    onCursorChange: fn => { cursors.add(fn); return { dispose: () => cursors.delete(fn) }; },
    setReadOnly: value => { readOnly = Boolean(value); current.setReadOnly(readOnly); },
    setWrap: applyWrap, layout: () => current.layout(),
    dispose() {
      if (disposed) return; disposed = true;
      cancelAnimationFrame(frame); unsettings();
      window.removeEventListener(WRAP_EVENT, onWrap); window.removeEventListener('storage', onStorage);
      host.removeEventListener('keydown', onKey, true); host.removeEventListener('keydown', stopKey);
      controls?.dispose(); cursors.clear(); current.dispose(); viewport.remove();
      host.classList.remove('python-editor-frame');
    },
  };
  connect(); controls?.bind(api);
  api.ready = loadMonaco().then(monaco => {
    if (disposed) return { error: null };
    const previous = current, area = previous.raw.area;
    const value = previous.getValue(), focused = previous.hasFocus();
    const start = area.selectionStart, end = area.selectionEnd, scroll = area.scrollTop;
    // Create successfully before removing the fallback; preserve it on any failure.
    current = monacoEditor(monaco, viewport, value, { label, readOnly });
    previous.dispose(); connect();
    const model = current.raw.instance.getModel();
    const a = model.getPositionAt(start), b = model.getPositionAt(end);
    current.raw.instance.setSelection(new monaco.Selection(a.lineNumber, a.column, b.lineNumber, b.column));
    current.raw.instance.setScrollTop(scroll);
    if (focused) current.focus();
    current.layout();
    return { error: null };
  }).catch(error => ({ error }));
  return api;
}
