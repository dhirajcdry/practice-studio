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
- `createTabs` / `createBadge` (`primitives.js`): tab bars with roving focus; status chips.
- `createActionRow({ content, trailing, onClick, className })`: clickable content rows. Uses shared row/inset geometry and grows with its content. Never apply `.btn` to a multiline content row: `.btn` deliberately has compact toolbar geometry.
- `icon(name, size)` (`icon.js`): stroke icons in `currentColor`. Add a path there; never use Unicode glyphs (♫ ⌨ ▷ ◈) as icons.
- Buttons: `.btn` plus `--primary` (one per state, `--solid-*` tokens) · `--secondary` · `--quiet` · `--danger-quiet`; `.icon-btn` for icon-only (borderless, 28px).

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

## Interview report

`server/interview/report.mjs` derives the report on read: `reportFacts` counts the raw
record (time, phases, hints, runs, verdicts, words), and `parseReport` validates the
interviewer's JSON. A quote stays a quote only if the candidate actually said it;
otherwise it's shown as an observation. Nothing is stored, so a parser or layout fix
costs a reload, never a recording. The sheet is `web/js/interview-report.js` + `web/css/report.css`.

Any finished interview, however old, can be asked about from the sheet's side panel
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

Use `workspaceHeader` and `dialogHeader` from `web/js/ui/headers.js`. Navigation, title and metadata share one compact desktop row. The back icon has a
labelled link; title and metadata wrap naturally when space is limited.
Actions own a trailing rail and wrap below on small screens. Dialogs always put the
labelled close icon at the top right. Notes and reports use the same header contract.
The visual audit checks close placement and title/action overlap across themes.

Conversation controls use the UI font even in themes with serif prose. Show one
current status; additional text explains an available action, never repeats that
status. Busy/speaking states hide unavailable microphone controls. The transcript
remains the single scroll owner, and controls stay in normal layout flow.

### Voice conversation

`ui/voice-panel.js` is the shared listening/playback view for coding chat, coding and
LLD mocks, design interviews, and practice. The live draft separates confirmed text
from highlighted provisional words. Preview revisions never enter the saved answer;
final phrases enter once, in recording order. Long drafts scroll inside the panel.
A real microphone level history and elapsed time show capture activity. Accepted
answers remain available under **Last sent answer**; this is server acceptance,
not merely pressing Send.

The learner can switch between pause-to-send and manual sending, edit the draft in
typed mode, interrupt playback, and replay the last reply. Coding chat remains
explicit-send dictation. Playback captions distinguish preparation from actual speech
and identify a system-voice fallback. Interrupt cancels the rest of the current spoken
reply even when generation continues; the written reply remains available.
One status line reflects the active microphone or playback; a still-running reply must
not hide that the microphone is listening after an interruption. The compact panel
shows either the learner's live words or the spoken caption, with details on demand.

Preview recognition runs at most every 900 ms with the recognizer's fast options.
Final phrases use full decoding and take priority over queued previews. Failed final
phrases hold later words in order, pause submission, and expose retry/discard actions.
Cutting a phrase does not discard its pending preview: it remains visible until that
phrase's final result arrives. Results from a previous microphone take are ignored.
The temporary audio survives only in the mounted tab, not a reload or route change.
The browser warns before unloading with unfinished capture or failed audio.

### Untimed practice

The workspace header includes a count-up stopwatch with Pause/Resume. It has no
deadline and never pauses the coach or microphone. It runs until explicitly paused,
including time away from the page; both its total and paused/running state survive
reloads and server restarts. Existing sessions without timing start tracking on their
first visit after this feature, with no estimate of historical time. Mock-derived
practice starts its own clock. Shared control: `web/js/practice-timer.js`; only the
time text ticks, so the editor and conversation never re-render on a clock tick.

LLD and system design share `web/js/practice.js` and `/api/practice`. Starting a
session or editing the work never calls a model. An explicit typed question or a
voice question (pause to send, or manual Send) includes the current
Python document/board, recent runs, saved notes and learner history. Input modes
can change without replacing the session or its conversation. Replies can be saved
to learning notes by the learner.

Starting practice in voice mode joins a continuous conversation. Reopened sessions
offer **Start voice** once; after each reply, listening resumes without another click.
**Pause voice**, switching to typing, leaving the tab, and microphone errors stop capture.
The conversation intent survives normal reply and transcription transitions. Interrupt
allows the next question to be recorded while the previous written reply finishes.
Pending/failed transcription blocks automatic sending. Streamed sentences and short
stable clauses enter speech before generation finishes, with incomplete Markdown held
back. Voice availability is warmed on joining, never by starting an unattended session.

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

Editor frames use `.ui-editor-surface`. Decorative theme blur must not apply to
these frames: `backdrop-filter` creates a containing block for fixed descendants,
which changes the coordinates of embedded editor overlays. Keep whiteboards and
code editors opaque; apply theme decoration to their surrounding chrome instead.

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

LLD and system-design history rows, open mocks and report sheets expose
“Practise from this mock”. `startPracticeFromMock` passes a typed source identity;
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
on disposal. Render receipts with the shared inset/cluster styles inside the scrolling
conversation. The composer and workspace header must not move as receipts arrive.
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
- `bindComposerInput` owns auto-growth (40px minimum, 180px cap or 20% of viewport height). Call `resize()` for
  programmatic draft changes and `dispose()` on teardown. Width changes and input
  events are observed. A large draft scrolls inside the input, never grows the page.
- `composerSend` provides the same labelled icon action and shortcut hint everywhere.
  Keep the existing Cmd/Ctrl+Enter behavior; plain Enter remains a newline.
- The composer stays in normal flex flow, so the transcript automatically receives
  the remaining height. Its inner body can scroll, while the footer stays visible. Do not copy an absolute overlay without an inset protocol.
  Only the existing embedded coding interview sticks within its parent scroll lane.
- A desktop idle practice composer has a 132px height budget. Narrow controls wrap
  without hiding model selection, mode switching, errors or the send action.

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
