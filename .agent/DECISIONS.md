# Decision log

## 2026-11-01 — Persistent native conversations

**Authorization:** Dhiraj requested one Claude Code/Codex conversation per Studio session,
incremental workspace context, native compaction, three-day idle expiry, and retained
voice/tools/recovery. This supersedes the previous fresh-native-turn context policy.

**Reason:** Reconstructing every turn from a small selected transcript lost conversational
continuity; resending complete prompts would also rebuild context unnecessarily. Resume
the native working conversation and send acknowledged changes, with Studio evidence as
the source of truth. Never combine native resume with replaying the whole transcript.

**Implementation contract:** [NATIVE-CONVERSATIONS.md](../docs/NATIVE-CONVERSATIONS.md).

**Actual model/delegation choices:** Main session GPT-6 Astra, ultra reasoning (existing
configured session; no claimed model switch). User explicitly requested Astra subagents:

| Bounded responsibility | Model | Reasoning | Ownership |
| --- | --- | --- | --- |
| Native Claude/Codex adapters | GPT-6 Astra | high | Adapters, fake providers, adapter tests |
| Route integration and practice checkpoints | GPT-6 Astra | high | Interactive routes and focused tests |
| Independent correctness review | GPT-6 Astra | xhigh | Read-only lifecycle/protocol review |

Children used the shared checkout with explicit file ownership, no recursive delegation,
and no real tutor turns or real TTS. The parent integrates findings, fixes failures and
owns final validation. These are implementation-agent settings; they do not change the
learner's selected coach provider/model or claim a different account entitlement.

**Future changes:** Preserve native/Studio identity separation, explicit provider-switch
handoffs, guarded tools, server-owned evidence, and fake-only regression tests. A proposed
return to fresh sessions must explain its concrete benefit and continuity/cost tradeoff
in a new decision entry, rather than quietly reversing this one.

**Review findings resolved:** Failed transcript writes cannot acknowledge native history;
persistent routes must explicitly commit after saving; interrupted journals are included
as unconfirmed recovery evidence and retrievable through `native_progress`. Recovery
never rewrites a partial reply as a completed answer or automatically repeats a mutation.

**Validation:** `npm test`: 923 tests, 922 passed, 1 existing skip, 0 failures. Browser
checks passed for practice, voice, coding interviews, LLD, LLD scrolling, coach streaming,
coach reload, system design and recall. Reviewed actual Chrome screenshots of the context
inspector at desktop and narrow widths. Fake providers and scratch data only; no real
inference/allowance or learner-workspace mutations were used for validation. Installed
protocols inspected: Codex 0.165.0 and Claude Code 2.1.314. Native account-side behavior
remains subject to the installed provider and its service; no cache-saving percentage
or model entitlement is promised.

## 2026-11-01 — Agent-editable coaching instructions

Dhiraj explicitly authorized self-initiated lasting coaching changes with history and
undo. Store these as server-owned, versioned coaching rules rather than promoting
ordinary memory into instruction authority or giving agents source-file write access.
Rules customize pedagogy while existing tool permissions and evidence contracts remain.
Changes apply at the next turn through the shared provider wrapper and native signature;
no extra upkeep call or mid-turn restart. Settings provides independent inspection,
editing, disabling and restoration. The canonical contract is in
[CONTEXT.md](../docs/CONTEXT.md#editable-coaching-instructions).

Delegation: one economy worker implemented the bounded storage module and initial tests;
the main session integrated and hardened it. An expert consult reviewed authority,
revision semantics and native-session integration. All validation uses scratch homes,
fake CLIs and fake speech helpers; no real coach or image jobs.

## 2026-11-01 — Readable coach marks and explicit autonomous guidance

Dhiraj reported note text overlapping marked code and reiterated that coaching changes
must apply without review or approval. Replaced one-time note measurement with observed
card sizing and view-zone relayout, added opaque surfaces, tracked line labels and
collapse/dismiss controls. The shared provider policy now explicitly applies grounded
self-initiated improvements directly; history/undo do not gate them.

An economy worker prepared the bounded browser regression and visual-audit fixtures;
the main session corrected and completed those checks and owns the UI implementation.

## 2026-11-01 — Practice stopwatch

LLD and system-design practice share a count-up stopwatch, independent of the coach,
voice capture, and mock countdowns. Store only accumulated milliseconds and a server
start timestamp in the practice session; derive display time without per-second writes
or model calls. Explicit Pause/Resume is durable and idempotent, serialized with workspace
autosaves. It continues until paused, including time away from the page. Existing sessions
start tracking on their first visit, without inventing elapsed time from their creation date.
See [UI.md](../docs/UI.md#untimed-practice) and [CONTEXT.md](../docs/CONTEXT.md#open-practice).

Delegation: one native worker inherited the current GPT-6 Astra session settings to add
bounded timer regression tests; the main agent corrected API expectations, completed
concurrency/restart coverage, and implemented the server, shared control and browser checks.

## 2026-11-01 — Resizable workspaces and keyboard ownership

One instance-scoped divider implementation now serves LLD and system-design practice
and mocks. It persists discipline-specific ratios locally and restores CSS's stacked
layout below the workspace breakpoint. Width changes never replace editor or canvas
nodes. Reuse the shared split visuals rather than another feature-specific handle.

A whiteboard Enter/arrow regression exposed catalog shortcuts that were globally
registered and assumed every text field was the search box. Scope navigation at the
owning handler by route and exact search input, honor prevented/composing events,
and scope coding pane chords too. Keep Excalidraw's bubbling events intact: blanket
stopPropagation would trade wrong navigation for broken canvas editing.

Delegation: a native worker inherited this GPT-6 Astra session's settings for bounded
browser/visual regression additions. The main agent completed real-pointer, reset,
and Excalidraw keyboard checks and implemented the shared divider and keyboard guards.

## 2026-11-01 — Preserve practice board revisions

The keyboard regression also exposed a recovery gap: practice overwrote its latest
board, while interview scenes were already retained. A blank or accidental edit could
therefore replace the only server copy. Archive exact previous and incoming scenes by
content hash before each replacement, atomically and inside the session write queue.
Never delete history automatically or add it wholesale to model context. See
[CONTEXT.md](../docs/CONTEXT.md#open-practice).

The affected Ticketmaster practice was recovered from the user's Dia local-storage
journal, with the pre-restore state and matching records kept in the session's recovery
directory. The restored board and unsent draft were verified in the actual Dia tab.
This was a one-time recovery, not a new dependency on browser internals.

The real Enter → type → save regression also found mutable element aliasing in practice:
the comparison baseline shared objects with Excalidraw, so text edits could compare
equal and skip autosave. Detach initial canvas data, observed scenes, tool inputs, and
queued request snapshots. The browser regression requires typed text to survive reload.

Delegation: a native worker implemented the initial archive helper and focused tests;
the main agent added atomic publication, corruption checks and endpoint coverage. An
economy worker investigated the final Excalidraw browser regression fixture.

## 2026-11-01 — Operation-owned failures and Claude empty-completion recovery

A local restart exposed a stale practice error: autosave failures were written into
the coach composer and successful saves never cleared them. Workspace failures now
have their own notice and save-only retry; successful saves cannot hide failed replies.
Browser regressions cover recovery through both a retry and a later edit, and verify
that saving never silently retries inference.

The repeated Ticketmaster feedback was a single Studio request. The Claude 2.1.314
native transcript showed feedback, successful record_session, an empty thinking-only
completion, then an isMeta/turnCompanion reminder asserting no visible output. Claude
responded with a paraphrase. Keep exact echo reconciliation and live streaming; do not
guess which divergent content to hide. Mitigate in Claude's delivery instructions with
a truthful nonempty completion and explicit reminder handling. No supported recovery
disable switch was found; this mitigation cannot guarantee model behavior.

Delegation: one GPT-6 Astra expert consult traced the exact session and implemented
the provider guidance with fake-CLI tests. The main agent implemented operation-owned
UI errors and real-browser failure/recovery checks. Raw learner evidence is preserved.
