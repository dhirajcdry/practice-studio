# UI foundation

Every new screen is built from these pieces. If a feature needs a control that isn't
here, add it here first, then use it. Don't hand-roll a one-off in the feature.

## Tokens (`web/css/app.css` `:root`)

| Kind | Tokens |
| --- | --- |
| Spacing (4px base) | `--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-5` 20 · `--space-6` 24 · `--space-7` 32 · `--space-8` 40 |
| Type | `--text-xs` 11 · `--text-sm` 13 · `--text-md` 15 · `--text-lg` 20 · `--text-xl` 28; `--line-sm/md/lg` |
| Shape | Component contracts use `--surface-card-*`, `--row-*`, `--tab-*`, `--chip-*`, and `--float-*` tokens for backgrounds, borders, radii, shadows, hover states, gaps, indicators, and typography. `--radius-sm/md/lg` and `--shadow-pop` remain the primitive aliases. |
| Control height | `--control-sm` (28, the app's standard), `--control-md` |
| Status | `--status-{success,warn,danger,accent}-{ink,bg}`, mapped onto each theme's easy/med/hard/accent |

Colours come only from theme variables (enforced by `server/test/css-rules.test.mjs`).

Component CSS must not hard-code shape values. `border`, `border-radius`, and `box-shadow`
use a whole shape token (or the explicitly permitted zero/none/50% values); hairline
borders use `1px solid var(--hair-*)`. Each theme family supplies the component token
contract. Dark variants inherit the family's geometry when appropriate and provide
palette-relative values for surfaces, borders, hovers, and shadows.

## Component tokens

Themes set these; components consume only these. Defaults live in `ui.css` on
`:root` and are re-bound on `body` so references resolve against the active palette.
Each family defines its contract in `themes.css`. Dark mode deliberately inherits
family geometry; palette, shadow, gilt and sun tokens resolve to that mode's values.

| Treatment | Tokens | Used for |
| --- | --- | --- |
| Cards | `--surface-card-{bg,border,radius,shadow,hover-bg,hover-shadow}` | Setup, saved records, metrics, report cards and empty states |
| Rows | `--row-{radius,hover-bg,gap,border,rule}` | Inset history cards or ruled lists; `rule` is the divider in typographic themes |
| Tabs | `--tab-{radius,active-bg,active-fg,active-indicator,active-shadow}` | Selected tabs and segmented choices; indicator is an inset shadow |
| Chips | `--chip-{radius,border,font}` | Status badges, counts, attachments and chart rounding |
| Floating | `--float-{radius,shadow,border}` | Menus, report sheet, composer and popovers |
| Controls / chart marks | `--control-border`, `--select-chevron-{border,width}`, `--phase-rule`, `--chart-marker-border` | Control edges and semantic chart strokes |

`--tab-selected-shadow` composes the indicator and active shadow. A transparent
zero-size shadow is the composable “no indicator” value. Art tabs retain their
shared primitive pseudo-element effects (glow, gilt diamond, survey stripe), and
both ARIA selection attributes match those effects. Real tablists use `aria-selected`.

New components never hard-code shape; if a theme needs a new kind of treatment,
add a token. Keep floating reading surfaces opaque, keep icon buttons borderless,
and use row spacing with inset content rather than stretching cards beyond their pane.

## Primitives (`web/js/ui/`, styles in `web/css/ui.css`)

- `createSelect({ label, options | groups, value, onChange, compact })`: the only dropdown. Anchored menu, keyboard, type-ahead. Exposes `value`, `disabled`, `setOptions`, `setGroups`, `dispose`, and emits `change`.
- `createMenu`: the anchored popover the select is built on, for action menus.
- `createPopover`: a small nonmodal editor in the browser top layer; outside click and Escape dismiss it without expanding its toolbar anchor.
- `createTabs` / `createBadge` (`primitives.js`): tab bars with roving focus; status chips.
- `createActionRow({ content, trailing, onClick, className })`: clickable content rows. Uses shared row/inset geometry and grows with its content. Never apply `.btn` to a multiline content row: `.btn` deliberately has compact toolbar geometry.
- `icon(name, size)` (`icon.js`): stroke icons in `currentColor`. Add a path there; never use Unicode glyphs (♫ ⌨ ▷ ◈) as icons.
- `button({ label, icon, kbd, variant, size, pressed, disabled, danger, ariaLabel,
  title, onClick, className })` in `ui/button.js`: `.btn` with exactly one of
  `btn--primary`, `btn--secondary`, `btn--quiet`, `btn--icon`. Standard height 28px,
  padding 0 10px, gap 6px, icons 15px. `size: 'lg'` is 34px for setup calls to action
  only. Composer Send is 28px. Icon buttons need an accessible label and never have a box.
  Danger recolours quiet actions; pressed quiet actions use accent-soft. Focus is a
  2px accent outline with 2px offset. Hook classes do not define another variant.
- `practiseFromMock(options)` shares the label and default outline treatment.
- Tabs use `ui/tabs.js` (13px/500, 2px underline, roving keyboard focus); `segmented`
  is the compact content-width grouped-switch surface. Badges use `ui/badge.js`,
  20px high, with neutral/good/warn/bad/accent tones. Content rows remain content-sized
  `ui-action-row` controls rather than toolbar buttons.

## Rules

Practice save errors belong beside the code/board, with an explicit Retry saving
action. The latest successful save clears its own error and browser recovery warning;
it must never clear a failed coach reply. Note, reply and reconnect errors are scoped
to their operations. Timer failures stay beside Pause/Resume. A save retry only saves
work; it never resends a question or starts a model turn.

Keyboard ownership is route-scoped. Catalog Enter/arrow/J/K/search navigation runs
only on coding routes or in the actual catalog search field. Other inputs, controls,
composition events and already-handled events never become catalog commands. Coding
pane chords are also coding-route-only, even if their module remains registered.
Excalidraw must receive its own bubbling keyboard events for shape editing/movement;
do not fix shortcut leakage by stopping all whiteboard events at the page boundary.

1. One primary action per state. Everything else is quiet.
2. No native `<select>` (the visual audit fails on a visible one) and no native `title` tooltips for content.
3. Icon buttons are borderless; hover highlights extend past the content with the theme radius.
4. Sibling controls in a row share a height (`check-controls`).
5. Don't narrate the UI ("Your interviews will appear here", "Continuing this conversation…"). Use relative dates, never ISO.
6. Vertical space is expensive. Prefer one dense row over a labelled form; inline pickers over dialogs.
7. A new feature gets a screen designed for it. Don't fit it into whatever container exists.
8. Never fabricate a statistic. Missing data is stated ("No evidence recorded", "—").
9. Use the spacing/type tokens, not raw px, in new CSS.
10. Before calling a screen done: add its states to `scripts/visual-audit.mjs`, run `npm run check:visual`, and look at the screenshots in at least one light and one dark theme. A green lint does not mean it looks good.

The context inspector reuses `dialogHeader`, `.rp-sheet` and `.rp-scroll` with one
bounded body scroller. Its list, detail, empty and narrow states are in the visual
audit. Exact payloads expand inside bounded text panels; long content must not widen
the sheet or move the close control. Practice adds open/empty desktop and narrow states.

## Themes

Studio, Desk and Twin Suns (`dunes`) are the only families. Each has a light and
 dark palette in `themes.css`; retired saved selections fall back to Studio without
changing light/dark mode. Semantic verdict and syntax colours remain independent
of control geometry.

- Studio: Avenir Next, flat adjoining panes, hairline dividers, 6px controls, no pane shadow.
- Desk: warm paper and grain, 14px floating panes with 10px gaps, 9px controls,
  Iowan Old Style titles at weight 500.
- Twin Suns: the painting is behind solid boards, never text. Boards have ink borders,
  3px corners, 14px gaps and two hard offset shadows. Controls and titles use Futura
  stencil capitals. The survey stripe belongs only beneath the app bar.

No app stylesheet may use backdrop filtering. Floating layers use solid surfaces.

## Interview report

`server/interview/report.mjs` derives the report on read: `reportFacts` counts the raw
record (time, phases, hints, runs, verdicts, words), and `parseReport` validates the
interviewer's JSON. A quote stays a quote only if the candidate actually said it;
otherwise it's shown as an observation. Nothing is stored, so a parser or layout fix
costs a reload, never a recording. The sheet is `web/js/interview-report.js` + `web/css/report.css`.

Reports lead with the verdict and facts, then the move-up band and at most three fixes.
Older practice items retain their title and improvements. The box score selects the
first Weak dimension, otherwise first Mixed, otherwise the first dimension. Play by
play attaches each distinct evidence quote at most once, within 60 seconds. The final
code precedes strengths and the saved follow-up thread. All time links open the
conversation at the nearest turn; reduced-motion preferences suppress scrolling animation.
The audit covers the report hero, box score, code, follow-ups and 375px layout, including
44px targets and composited text contrast. Set `STUDIO_REPORT_SHOTS=/absolute/output`
when running `npm run check:visual` to capture full-page Twin Suns/Studio reports and
a Twin Suns problem page. `STUDIO_VISUAL_PORT` selects an alternate scratch port.


Any finished interview, however old, can be asked about from the sheet's follow-up thread
(`POST /api/interview/ask`, prompt in `server/interview/review.mjs`). Questions and
answers go to `followups.jsonl` beside the record, never into `turns.jsonl`. The question
is saved before it's answered, a question still being answered comes back `pending`, and
older interviews with a prose debrief open the same sheet with that debrief as written.

## Result-panel spacing

Result rows (summaries and cases) run full width and own their internal padding.
Result notices (including tutor-run provenance) and state cards share the `.rr`
`--result-inset` and `--result-notice-gap` contract in `app.css`. Nested tutor
error cards use that same inset. Do not insert a new notice flush into `.rr-body`
or add competing margins in `workspace.css`. Check its bounds at narrow widths
and with and without an action button in the visual audit.


## Content spacing contracts

### Bounded workspace panes

LLD and system-design workspaces (practice and mocks) use
`ui/split-pane.js` for their horizontal work/coach divider. Drag or use Left/Right
(Shift for larger steps); Home/End choose the minimum/maximum work width; Enter or
double-click resets. Browser-local ratios are separate per discipline and shared
between its practice/mock screens. Minimum usable widths are enforced, viewport
changes clamp without overwriting the preference, and stacked layouts restore CSS
sizing. Pointer cancellation and page teardown release capture/listeners. Resizing
never remounts the editor, board, or conversation.

`.ui-workspace` is the shared desktop viewport frame for interview surfaces. A
workspace and its panes use `--content-inset: var(--space-4)` (16px), inherited by
`ui-inset` on headers, transcripts and controls. Set spacing on the container;
do not compensate with child margins or theme overrides.

A bounded `.ui-pane` is a flex column whose single `.ui-pane-scroll` child owns
transcript/content scrolling; `.ui-pane-controls` is a capped, independently
overflowing control region inside the pane. Header and controls remain in normal
layout flow and must not overlap the scroll rectangle or escape the pane edges.
Use structural spacing tokens and flex sizing to establish these bounds rather
than sticky overlays or hard-coded viewport-height subtraction. The visual lint
requires a visible scroll region of at least 80px on desktop and rejects vertical
document overflow when a desktop workspace is shown. Mobile may scroll the page
between stacked panes, while each visible pane still owns its bounded content
region. Embedded coding layouts are deliberately parent-viewport based and are
not `.ui-pane` surfaces unless they adopt this full contract.

Appearance classes must not change layout: `hover-surface` supplies hover feedback,
never padding or negative margins. Themes own color and shape; layout owns space.

- `ui-inset` owns all four content edges (12px). Use `ui-inset--compact` (8px) for
  receipts and `ui-inset--roomy` (20px) for reading/empty-state cards. Feature CSS must
  not override padding on an adopted surface.
- `ui-row` has a shrinking `ui-row-content` column and a `ui-row-trailing` column.
  Put navigation icons in `ui-row-chevron`; never absolutely position them or reserve
  a guessed amount of space with padding-right.
- `ui-cluster` wraps content and actions with a 12px gap. Give explanatory content
  `ui-cluster-content` so an action moves below it when the panel becomes narrow.
- `ui-stack` owns vertical separation, normally 8px; a compact title/description may
  set `--content-stack-gap: var(--space-1)`.
- Composed cards with full-width rows or media use `--content-rail` for their shared
  horizontal content edge. Change the token once for responsive layouts, not each child.
- Parent containers own external spacing. Result bodies intentionally retain full-width
  result rows; their inset notices share the existing result inset rule.

The CSS suite rejects competing padding rules for migrated surfaces and positioned
saved-row actions. The visual audit measures every rendered `ui-inset`, `ui-row`, and
`ui-cluster` in every state/theme, including narrow rows and long text. Add new card
states to that audit; an overflow-only check is insufficient.

### Header and conversation anatomy

Use `screenHeader`, `dialogHeader` and `paneHeader` from `ui/headers.js`.
`workspaceHeader` is a compatibility adapter for existing callers.

- Screen (46px): back, crumb, truncating title, badges, dot-separated metadata,
  flexible space, status, secondary actions, primary, overflow.
- Dialog (56px): title and metadata, action rail, separator, Close alone at the
  right edge. Secondary actions enter the existing keyboard-accessible menu on
  narrow screens. They retain their original handlers and current disabled state.
- Pane (38px): title/subtitle or tabs, then tools. Whiteboard zoom/fit is driven by
  the vendored API. Pane controls stay outside the scroll region.

The action placement contract for the redesign is:

| Region | Primary | Secondary | Overflow |
| --- | --- | --- | --- |
| Finished mock review | View report | Learning notes; Practise from this mock (outline) | Existing interviewer/print actions |
| Review without report | Practise from this mock | Learning notes | — |
| Report dialog | Practise from this mock | Ask the interviewer (pressed while open) | Re-grade; Print |
| Live mock | — | Timer; Pause/Resume; Finish (danger); Run; Submit | Learning notes; previous/next/shuffle |
| Untimed practice | — | Timer; Start/Resume; Learning notes | — |
| Coding workspace | Submit with shortcut | Previous/next/shuffle icons; Run with shortcut | External resources; Reset code |

Reset retains its arm-to-confirm step. Reference tabs retain their drawers and S/A
shortcuts. The coding screen rail replaces the old editor run bar. The case row
owns Copy to a new case; there is only one Run control.

Conversation controls use the UI font even in themes with serif prose. Show one
current status; additional text explains an available action, never repeats that
status. Microphone controls remain available during replies and playback. The transcript
remains the single scroll owner, and controls stay in normal layout flow.

Mock and practice transcripts use `ui/conversation.js` and `.ui-conversation-text`:
14px UI type, a 1.6 line height, and a centred 720px maximum message column.
`conversationMessage` owns labels, timestamps and action rows across chat, mocks,
practice and report follow-ups. Learner bubbles align right, use a soft ink fill and
9px/12px padding, and occupy at most 85% of the column. Their speaker name is
screen-reader-only. Consecutive same-speaker messages have 6px separation and one
visible speaker label; different speakers have 16px separation. Elapsed timestamps
remain visible. Code uses 12.5px mono, bounded horizontal scrolling and a shared
Copy code icon. Message actions appear on hover/focus and on the latest coach reply.
Day and phase separators use a centred label between hairlines. A quiet Thinking
row precedes tokens. Jump to latest appears only after new content arrives while
the reader is above the bottom; activation resumes the existing follow behavior.
Interviewer/coach replies use the safe Markdown renderer for both saved and streaming
text. Store the original source separately from rendered DOM so split tokens, Replay,
and Save to notes retain block boundaries. Learner prose stays literal (fenced code
is supported), with a quiet, content-sized background. Paragraphs own their spacing;
trailing model newlines must not create empty rows. Long code and tables scroll within
the reply. The conversation visual states cover desktop/narrow mocks, and practice
fixtures include headings, lists and code.

### Voice conversation

`ui/voice-panel.js` is the shared voice bar for coding chat, coding and LLD mocks,
design interviews, and practice. It holds only this turn: microphone toggle, level
meter, one status, the learner's words, and turn actions from `setControls`. It is one
line until there are words. Session controls (clock, Pause, Finish) belong in the screen
header; preferences belong in Settings. Do not add a control here without removing one.

The live draft separates confirmed text from highlighted provisional words. Preview
revisions never enter the saved answer; final phrases enter once, in recording order.
Long drafts scroll inside the panel without moving its status/control line. The bar
uses the composer well, border, radius and 28px controls. Sent answers are in the conversation above, so the
panel does not repeat them.

Clicking the words edits them in typed mode, and `answerModeSwitch` is the labelled
Type/Voice link. Send uses the composer's arrow and appears only when there are words;
Settings → Voice → **Send when I pause** chooses automatic or manual sending. A recovered
answer shows **Answer not sent** and holds the microphone until it is sent or edited.
Coding chat remains explicit-send dictation. During playback the microphone stays open,
its toggle remains available, and live words remain visible. Qualified speech interrupts
playback immediately; **Interrupt · Esc** is an alternative. The status distinguishes
preparation from speech and identifies a system-voice fallback. Interrupt cancels the rest of the current spoken
reply even when generation continues; the written reply remains available. `replayButton`
sits on each reply and is revealed with the message. A still-running reply must not hide
that the microphone is listening after an interruption.

Preview recognition runs at most every 900 ms with the recognizer's fast options.
Final phrases use full decoding and take priority over queued previews. Failed final
phrases hold later words in order, pause submission, and expose retry/discard actions.
Cutting a phrase does not discard its pending preview: it remains visible until that
phrase's final result arrives. Results from a previous microphone take are ignored.
The temporary audio survives only in the mounted tab, not a reload or route change.
The browser warns before unloading with unfinished capture or failed audio.

### Untimed practice

The workspace header includes a count-up stopwatch with Start/Pause/Resume. It has no
deadline and never pauses the coach or microphone. New and legacy sessions begin paused;
the visible page renews a short server lease while running, and hiding/leaving the page
pauses it. An expired lease is reopened paused, with no invented historical time. The
accumulated total survives reloads and server restarts; reopening always pauses and
requires an explicit Start/Resume. A heartbeat never resumes a stopped timer.
Each uninterrupted run stops after 12 hours even if the tab remains open. Resume
starts another run; this cutoff never generates a debrief or clears saved work.
Mock-derived practice starts its own clock. Shared control: `web/js/practice-timer.js`; only the
time text ticks, so the editor and conversation never re-render on a clock tick.

LLD and system design share `web/js/practice.js` and `/api/practice`. Starting a
session or editing the work never calls a model. An explicit typed question or a
voice question (sent on a pause, or with the Send arrow) includes the current
Python document/board, recent runs, saved notes and learner history. Input modes
can change without replacing the session or its conversation. Replies can be saved
to learning notes by the learner.

Starting practice in voice mode joins a continuous conversation. Reopened sessions
start with the microphone off, and its toggle (**Start voice**) joins once. The same
microphone and meter remain active through transcription, model replies and playback;
`voice.flush()` finishes the answer's phrases without closing the device. Browser echo
cancellation is enabled. A new utterance can interrupt audio before transcription finishes.
The toggle (**Pause voice**), switching to typing, leaving the tab, and microphone errors stop capture.
The conversation intent survives normal reply and transcription transitions. Interrupt
allows the next question to be recorded while the previous written reply finishes.
Pending/failed transcription blocks automatic sending. A failed model reply also holds
automatic sending and idle turns until an explicit Send or retry. New words remain in a separate
draft until the previous model turn finishes; server acceptance removes only the sent
prefix once. Complete sentences enter speech before generation finishes, with incomplete
Markdown held back. There is no timer that releases unfinished sentences. Sentences of
four or more words start immediately; shorter openers join their continuation, or release
on reply completion if they stand alone. Only text exceeding the 400-character chunk
budget splits before a sentence ends, preferring a clause boundary in the latter half of
the chunk, then a word boundary. Completion releases any final unpunctuated text.
The speaker preserves these grouped phrases as one clip, prepares the next clip during
playback, and does not flash a new preparation status for an already-prefetched clip.
The local synthesis worker keeps its model loaded across requests. Voice availability
is checked on joining, never by starting an unattended session.

Sessions live under `problems/<slug>/practice/<id>/`, separately from mock evidence.
Workspace autosaves are serialized; questions are persisted before generation;
request identities make retries idempotent, using the original question snapshot.
Reopened practice tabs read the growing in-memory answer on recovery polls, so partial
text remains visible before completion. Recovery replaces snapshots and never replays
old text as speech. Completion and failures persist the final available answer to disk.
A failed/interrupted response is recorded as such, never as a successful answer.
Practice questions enter the learner profile as ungraded observations, not verdicts
or completed interviews. `npm run check:practice` verifies real browser flows with
fake providers and a scratch workspace.

Editor frames use `.ui-editor-surface`. Keep whiteboards and code editors opaque.
Backdrop filtering is forbidden across the app; it changes fixed-overlay coordinates
and adds paint cost. Theme decoration belongs behind solid surfaces.

### Shared Python editor

LeetCode, LLD mocks and LLD practice all mount `web/js/python-editor.js`. Use
`createPythonEditorControls()` in the file toolbar and `mountPythonEditor()` in
its bounded editor host. Never create a second Monaco configuration in a screen.
The shared component owns wrapping (persisted across modes), cursor position,
indentation, find/undo, typing effects, live font/theme settings, keyboard commands,
read-only state and cleanup. Workspaces supply save/run/submit callbacks and own
persistence; a blank interview document stays blank.

An editable textarea is available immediately. A successful Monaco load transfers
its current text, selection and focus; failure leaves that fallback usable. Pending
loads cannot recreate disposed editors. `setReadOnly` also applies during loading.
Use `.python-document-bar` and `.python-document-identity` for new file headers;
the identity and controls wrap naturally when the pane narrows. `check:python-editor`
verifies the shared behavior in an isolated browser with fake providers.

### Practice from an attempted mock

LLD and system-design history rows (“Practise from it” in a problem's detail), the
Next session card (“Practise this”), open mocks and report sheets branch a practice copy. `startPracticeFromMock` passes a typed source identity;
`POST /api/practice/start` resolves the authoritative saved work on the server.
An active editor flushes before branching. Finished mocks stay read-only.

The server publishes a fully initialized practice directory with a single rename.
It saves the source problem, code/latest board, compact conversational evidence and
feedback in `source.json`; subsequent practice edits cannot change that snapshot or
the mock. The practice header links to the original, and Problem and mock feedback
contains the saved debrief. The coach receives this evidence on explicit questions,
with large transcript truncation labelled honestly. Missing feedback stays missing.


### Agent actions in practice and mocks

Use `web/js/workspace-tools.js` with the existing `coach-actions.js` protocol for
Python and board actions. Register against the full session target and unregister
on disposal. Render receipts through `ui/receipt.js` inside the scrolling
conversation: a 15px kind icon, 12.5px sentence and existing Undo action. Consecutive
receipts share a 2px left rule without card boxes. Show output is closed by default
and open for a failing run; its mono output scrolls within 180px. Tutor runs retain
their coach attribution and never increment learner statistics. The composer and workspace header must not move as receipts arrive.
Only live actions may execute; recorded receipts are display-only. Preserve native
Undo and refuse receipt Undo if intervening edits changed the target. A successful
acknowledgement means the workspace save completed, not merely that pixels changed.

### Compact workspaces and composers

`ui-toolbar` owns the file/panel control inset (8px vertically, 12px horizontally).
It replaces `ui-inset` on chrome; reading content retains the larger content inset.
Desktop workspace headers should fit in 52px, and Python file bars in 52px. Do not
stack a breadcrumb, title, subtitle and action bar above a working document.
Mobile navigation explicitly assigns rows instead of relying on accidental flex wrapping.

All chat, practice, mock and report inputs use `web/js/ui/composer.js`:

- `createComposer` supplies one bordered surface, content, transient notices and a
  footer with options on the left and actions on the right. Model/input-mode pickers
  belong in the footer. Idle status must not add a dedicated row.
- `bindComposerInput` owns auto-growth (one line through eight lines, then internal scrolling). Call `resize()` for
  programmatic draft changes and `dispose()` on teardown. Width changes and input
  events are observed. A large draft scrolls inside the input, never grows the page.
- `composerSend` provides a 28px filled icon action with the shortcut in the shared
  tooltip. Empty drafts disable Send. Coding chat swaps Send for its existing Stop
  action during streaming; other surfaces have no server cancellation action.
  The textarea has no separate focus ring: focus belongs to the rounded well container.
  Existing model/effort selection is one quiet footer button. Dictation uses the same
  capture controller and saved draft as typing, with a compact mic icon.
  Keep the existing Cmd/Ctrl+Enter behavior; plain Enter remains a newline.
- The composer stays in normal flex flow, so the transcript automatically receives
  the remaining height. Its inner body can scroll, while the footer stays visible. Do not copy an absolute overlay without an inset protocol.
  Only the existing embedded coding interview sticks within its parent scroll lane.
- A desktop idle practice composer has a 132px height budget. Narrow controls wrap
  without hiding model selection, mode switching, errors or the send action.

Keyboard actions belong to their visible surface. Use `web/js/keyboard.js` to
claim action keys once, respecting handled events, IME composition and key repeat.
Global workspace, navigation and recorder shortcuts stop while a dialog or menu is
open, even if focus falls back to the page or remains behind the overlay. Submit/Run
keys apply to the code buffer or workspace controls, not test-case inputs or Monaco
Find. Chat Send belongs only to its visible composer; nested interview answers must
never send a hidden Chat draft. Held Enter on action buttons must not repeat a
submission, confirm Reset, or start/finish another session.

`check:submit-keys`, `check:shortcuts` and `check:interview` exercise these boundaries
with simulated judges, fake providers and disposable workspaces.

These choices adapt T3 Code's [composer surface](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/ComposerSurface.tsx)
and [compact composer](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md)
to Studio's existing themes and independent scroll panes. `npm run check:composer`
measures header/input/footer geometry, growth/contraction, keyboard submission and
scroll containment against fake providers in a scratch workspace.

### Editor edge ownership

`mountPythonEditor` owns a `.python-editor-frame` and an inset
`.python-editor-viewport` for every Python workspace, including the plain textarea
fallback. `--python-editor-edge-inset` reserves 12px on both sides outside Monaco's
coordinate system. Its vertical padding uses the shared top/bottom tokens.

Line-number capacity (`lineNumbersMinChars`) is not spacing: three digits fill a
three-character gutter. Increasing that count only postpones the same problem.
Monaco's decoration lane is after the numbers and cannot supply the exterior inset.
Never offset Monaco's internal line numbers with CSS; that separates painting from
its hit targets, sticky rows and selection geometry. The viewport inset keeps all of
those aligned, and automatic layout receives the actual remaining width.

The editor browser check measures text ink with 3/4-digit line numbers at 14/20px,
horizontal scrolling and all three Python workspaces. The visual audit additionally
checks editor edge bounds in every rendered theme, including narrow long-file states.

## Coach line notes

Monaco line notes are opaque review cards with a tone label, tracked line range,
Collapse/Expand and Dismiss. Note text is plain text; newlines and long tokens wrap.
`createMonacoTutor` measures the inner card plus zone padding, observes size changes,
and updates Monaco's reserved view-zone height on editor resize and font changes.
The note width follows the visible editor content width, not its horizontal scroll width.
Never estimate height once or allow overflowing notes to paint over candidate code.

Edits inside marked lines clear the corresponding note; edits above it move the tracked
range and note together. Dismiss affects only that note. Disposing the tutor removes
zones, decorations and observers. `npm run check:tutor-marks` measures these behaviors
in a scratch Chrome fixture; `tutorMarks` and `tutorMarksNarrow` cover the actual practice
layout in the visual audit.

### Mock time budgets

`ui/mock-time.js` makes the mock clock itself the Add time trigger. A small popover
contains +15 min, +20 min and Custom; the numeric editor replaces the choices inside
that same surface. Saving closes it. Errors and Retry stay inside it; no extra form
or success message expands the header. At zero the clock shows overtime and only
Finish requests a debrief. This follows the voice bar’s compact, contextual controls.

### Saved feedback typography

Saved mock feedback in practice and inline interview debriefs use `conversationText`,
just like coach replies. `renderMarkdown` returns an unstyled fragment; consumers
must mount it inside a `.rich` typography surface. Its block markers let the visual
audit reject unstyled consumers. Do not apply broad paragraph/heading rules from a
parent disclosure: scope its statement and label rules to their direct children.

The practice reading pane owns exterior side gutters and a vertical gap as well as
vertical content padding. Padding scrolls away; exterior spacing keeps clipped text
away from the fixed header and leaves room for the keyboard focus ring outside text.
Branch-practice visual states measure section gaps, list indentation, horizontal
overflow and the reading boundary with long feedback at desktop/mobile widths,
including a focused, partially scrolled report.


Round 1 header verification uses the screen header as the coding readiness anchor;
the removed editor run bar must not gate audit setup. Buttons are 28px, pane tabs
38px, ordinary controls including composer Send are 28px, and setup actions are 34px. A narrow coach header can put its icon tools
on a second row while keeping all three tab labels visible. Narrow screen actions
remain reachable in More actions. Live mocks keep Submit outlined and expose
Practise from this mock in More actions. Board zoom labels follow Excalidraw's
onChange app state, including wheel and pinch changes; native undo/redo keeps the
theme's floating surface. Studio's screen chrome and work panes are flush.
Shared conversation anatomy uses `.ui-message`, one visible `.ui-speaker` per grouped
speaker run, `.ui-message-actions`, and a bounded reading body. User bubbles stay within
the shared reading width. Receipts use `.ui-receipt`; successful output starts collapsed and failed runs expand it. Composer Send is a 28px control, while setup actions remain 34px.


### Track homes

`#/lld` and `#/design` share `web/js/track-home.js` and `web/css/track-home.css`, fed by
`GET /api/track-home?discipline=` (`server/learning/track-home.mjs`) plus the track's own
interview and practice lists. One 1040px reading column, in this order:

1. **Next session**: the first practice suggestion of the latest graded mock (title, why,
   fix), its "move up" line, Practise this / Open the report, and the other suggestions.
2. **Skills**: rubric rows by graded-mock columns (latest eight, oldest left) plus an
   Overall row. A cell without evidence is a dash. One graded mock is labelled a single
   reading, not a trend; tallies count only rated reports. No averages or percentages.
3. **Problems**: one row per problem, most recent activity first, then catalog problems
   not tried yet. Mocks without a structured report say "Feedback, not graded".

New mock setup and open practice live behind the header actions. A page visit never
starts a model turn. The learner disclosure stays last.

### Settings, library rows and paint cost

Settings use `ui/segmented.js` with 28px padded options and a filled selection.
Native checkbox semantics remain on the shared `.ui-switch` (role `switch`). Sections
use an 11px uppercase label, an 8px content gap, 36px minimum rows, 12px helper text,
and 24px between sections. Theme miniatures show pane geometry in light and dark
without requesting the painting. Quiet prompt rows are content actions: 32px minimum,
13px type, 2px apart, no border. They are not 28px toolbar controls.

Design and LLD saved mocks are listed under their problem on the track home (see
"Track homes"): a title, outcome badge and dot-separated relative metadata, one
contextual action (Open mock / Continue practice / Review / Mock it), and a detail with
each attempt plus Mock it again, Practise untimed and Learning notes. Open retains
resumption for unfinished interviews. Coding history retains its Open
and resume behavior; practice branching is supported only for LLD and system design.
Reference drawers retain Solution / Article tabs and shortcuts with a separate close rail.

Twin Suns owns the only painting layer, a fixed contained pseudo-element behind
opaque boards. Pane headers have only a bottom hairline. Avoid background attachment
and layout transitions. Transitions use opacity, transform, background-color, color or
border-color at 120–160ms; reduced motion disables them. Long row groups can use
`content-visibility:auto` with intrinsic size estimates. Active streaming messages stay
visible. Conversation decoration and composer/resize measurements are scheduled per
animation frame; token updates replace only the active reply body, never saved messages.

Browser checks must await Chrome exit through `scripts/chrome-cleanup.mjs` before
removing disposable profiles. The helper retries removal five times at 200ms intervals.
