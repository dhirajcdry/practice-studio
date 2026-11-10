# Context, storage, and provider contract

Practice Studio is a local, single-server application. An explicitly requested `start_notes_session` packages bounded insight/context/questions into a durable local outbox and delivers it to `STUDIO_WRITER_URL` in the background. The UUID in the Writer POST body is reused on transport retries; receipts say `queued` until Writer accepts the request, then `started`, and link to `/?session=<id>`. HTTPS tailnet URLs and loopback HTTP development URLs are accepted; credentials are never stored. Canonical problem data lives at
`tracks/coding/problems/<slug>`, `tracks/lld/problems/<slug>`, or
`tracks/design/problems/<slug>`. Track memory is `tracks/<discipline>/MEMORY.md` and
legacy hand-written memory is retained in `tracks/<discipline>/LEGACY.md`.
`shared/learner.md` holds shared coaching preferences; explicit level targets remain in
`learner-profile.json`. Performance evidence stays in its discipline.
Writer is the default authoring flow for learner study notes, handouts, and insight expansions. The former Studycraft authoring tool is retired from the normal tutor flow; its storage, outbox, and legacy receipts remain preserved for compatibility and recovery. Tutor memory stays separate from learner study documents.
Catalog membership determines LeetCode identities before any prefix inference: for
example, `design-twitter` belongs to coding. Generated system-design topics receive
a distinct slug if their proposed name collides with a catalog problem.
`server/storage-layout.mjs` resolves these paths and preserves compatibility with old
`problems/<slug>` and `memory/*.md` locations. Migration is lossless.

`scripts/migrate-storage.mjs` defaults to a dry run. It reports checksums, collisions,
aliases, and interruption-recovery details; use `--apply` only after stopping writers.
Run `npm run storage:migrate -- --root /path/to/STUDIO_HOME` to inspect the plan;
add `--apply` to perform it after stopping Studio. Keep a backup before applying.

Interactive turns use persistent native conversations managed by
`server/coach/native-sessions.mjs`; see [NATIVE-CONVERSATIONS.md](NATIVE-CONVERSATIONS.md)
for the complete identity, delivery, compaction, expiry and recovery contract. First turns
and provider switches bootstrap from Studio evidence using the shared `buildConversation`
helper, which renders the acknowledged context once. Same-provider turns append the
current message and changed workspace/context sections; they do not resend the transcript.
Typed/voice switching keeps the same conversation. Logical Studio IDs and actual native
IDs remain separate. Three-day idle expiry archives resumability, never learner evidence.

Context budgets are characters, not exact tokens or quotas. Usage telemetry is content-free
in `usage/turns.jsonl`: both providers report actual token usage when available, including
cached input and reasoning output where provided. Missing counters remain null. Codex
input counts include cached input; Claude reports uncached input separately. Resumed Codex
turns exclude historical thread usage. Segment and context-delivery metadata are recorded
without prompt text.

Retrieval resources include learning history, `problem:<slug>`, `session`, `source_mock`,
`runs`, and `scenes`. `interview:<slug>:<id>` retrieves a completed mock identified
by the full discipline history returned by `learning`, including older assessments
that were left out of the initial prompt. A missing excerpt is not missing evidence. Memory and context are
paged so a turn can retrieve omitted records explicitly. Coding, LLD, and design history
are scoped by discipline; LLD selection does not receive coding or design history, while
the full novelty inventory remains within the requested discipline. Other-topic NOTES
are not automatically included; assessments retain provenance and notes remain
retrievable through `read_context` (for example `problem:<slug>`).

Memory writes happen through Studio tools during the same turn. There is no automatic
memory-upkeep model turn or follow-up upkeep call. Fresh debrief context includes original requirements, the full
final code, and selected chronological code deltas and assistance with a larger budget.
All archives and raw records remain evidence; derived reports are regenerable.

Ordinary native continuations carry no repeated chat history. A fresh segment receives
complete session conversation up to a 100,000-character handoff budget, with explicit
selection/coverage plus retrieval for exceptionally large archives. Debrief evidence has
its separate 120,000-character budget. Session decisions use up to 7,000 characters.
The current work is separate from these history budgets. Automatic notes use up to
1,800 shared + 3,000 discipline + 4,000 problem + 2,000 legacy characters, plus
small provenance/excerpt notices. Retrieval returns pages of at most 6,000 characters.
A 400,000-character prompt/system/tool-schema guard rejects an oversized request before launch;
it does not silently discard the current work. Tool exchanges within a turn can
add context, and these character budgets are not subscription-cost guarantees.

Directory separation prevents cross-discipline prompt pollution; it does not make
filesystem reads constant time. History scanning is still linear. The current
format suits a local single-server workspace; larger installations would need a
rebuildable indexed view without replacing the append-only source records.


## Selection and session continuity

`context-packet.mjs` keeps stable instructions and problem context ahead of changing
work/history wherever the mode permits. Current code and semantic board state remain
separate from history selection. Fresh handoffs include the conversation; unusually large handoffs prioritize opening,
relevant earlier and recent evidence with explicit omissions. Resumed turns send changes
against the acknowledged baseline, including code diffs and appended activity records.
No model or reasoning downgrade is made for cost control.

`record_session` keeps source-backed requirements, decisions, unresolved questions,
probes, assistance and self-corrections in `context/sessions/<target-hash>.json`.
Every entry requires an exact quote from the session and a stable source ID. It remains
a model interpretation, not an independently verified fact. Source quotes are checked
again on read. Different practice branches and mocks have separate targets. The coach
updates this record during the existing turn; no summarization/upkeep turn is spawned.
A bounded fallback includes exact requirement/correction excerpts, without treating an
unaccepted suggestion as an agreement.

`search_context` builds a local inverted index of same-discipline evidence, session
sources, and saved notes when needed in a turn. Searches return up to eight compact
hits with resource IDs; `read_context` pages the exact originals. Basic vocabulary
aliases help find related errors, but this is lexical retrieval, not an embedding
service. Archives remain authoritative. Successful mutations invalidate the index;
external concurrent edits may be seen only on the next turn.

All Studio tool results are capped at 6,000 characters, including escaped JSON.
Oversized results retain an exact session-scoped `result:<hash>` resource for paging.
Repeated identical reads in a turn return an unchanged receipt with that resource;
changed results are sent again. Read explicitly from the resource to repeat a page.
Exact result pages persist under `context/tool-results/<target-hash>` across native turns.
Raw run output, current code and evidence are preserved, never silently discarded.

## Inspection and public research

Settings → What was sent? opens the request inspector: exact application prompt,
system instructions, Studio tool schemas, section sizes, tool-result sizes and actual
provider usage. An in-memory ring keeps up to 20 requests within 1,000,000 characters.
It is cleared at restart. Disk telemetry contains sizes/hashes and usage, not prompts.
Native conversation history/compaction, provider-owned instructions and subsequent
tool/web exchanges are outside the exact new payload shown; token counts may include those exchanges. Native web payloads
are not included in Studio tool-result character metrics. Cache counts do not imply
subscription quota percentages or guaranteed savings.

Claude requests also record content-free delivery measurements: first/last incoming
text-delta times, number of deltas and stdout batches, largest delta size, and first/last
forwarded text times. These appear as `streaming` in request inspections and usage rows.
They measure chunks, not billable tokens, and distinguish provider bursts from delivery
delay. Missing measurements are null rather than inferred from completed message logs.

Assistant text is delivered live, including text preceding a tool call. Providers are
instructed to continue that reply after tools rather than repeat the answer. The Claude
adapter tracks assistant-message and text-block boundaries and suppresses an exact
opening replay of its last text block after a tool round trip, before emitting tokens
to the page, speech or stored answer. Divergent/shorter text and repetition within a
message are preserved. Completed assistant snapshots never add a second copy of streamed
text. Historical records are not rewritten by this delivery guard.

Claude Code 2.1.314 can inject a synthetic “Your previous response had no visible
output” reminder after a thinking-only completion following a tool. This can happen
even when earlier text in the same turn was already streamed. Claude-specific delivery
instructions require a short, truthful, nonempty completion after bookkeeping and tell
the model not to repeat earlier feedback when that reminder appears. This is a prompt
mitigation, not guaranteed semantic deduplication; no supported CLI disable switch was
found. Paraphrased corrections must remain visible. The native instruction signature
changes normally, preserving saved Studio history in the next segment's handoff.

Interactive turns enable provider-native public web research. Claude exposes only
WebSearch/WebFetch alongside Studio MCP tools; Codex enables live web search while
keeping shell, files and user MCP servers disabled. Adapters default research off for
utility/image jobs; automatic problem preparation also opts out. No extra search API
or billing account is introduced. Search only when useful/requested and cite sources;
never send private learner code/history in a query. Web content is untrusted. Live mocks
(`coachingMode: 'mock'`) have no web research; their debriefs and follow-ups keep it.

## Interviewer silence

In every mock, a reply holding only control tags means the interviewer chose to say nothing. Studio shows and speaks nothing, records `interviewer_silent`, still applies
the phase tag and keeps pending events. Stepping in is the model's judgment rather than a
timer: idle ticks offer it the chance to speak and never require it. Voice mode keeps the
microphone open while a reply is being decided and spoken. Qualified learner speech
cancels playback and future audio from that reply; capture and transcription continue.
The written response finishes normally, and the new utterance waits in its own draft
until that model turn completes. Acceptance consumes only the submitted prefix once,
preserving words added in flight. A reply that arrives after the candidate
has started speaking again is shown but not spoken. System design replies stream live, so
each answer waits for its first complete sentence to show it is not filler; speech starts
on that sentence regardless. With no speech, drawing or draft for 60 seconds, the design
page offers one such turn, at most every two minutes. An answer met with silence shows
"Heard you. The interviewer chose to stay silent." in the transcript, live and on reload.

An interviewer first understands the candidate's idea, then may give a plain go-ahead such
as "Okay, go ahead with that." It means they may move on, not that the idea is right, so
the filler backstop lets it through. Coding mocks ask about complexity only after that
understanding, and only if the candidate has not said it.

## Report bar and practice behaviour

Reports for all three disciplines share one calibration in `debriefPrompt`: the bar is a
candidate who would pass at the target level, each shortfall counts once, typos carry no
weight, and steps the interview never reached are not faults. An empty session gets a null
signal and null ratings. Practice (`PRACTICE_PARTNER`) works like an unjudged interview:
it follows the learner, gives no unasked hints, and gives exactly what is explicitly
requested. Attempt reviews teach openly. Saved reports are never rewritten.

The global Report difficulty (`report-settings.json`, default `beginner`) is read when a
report is generated and frozen on that interview as `reportDifficulty`, so changing it
never regrades a finished report and follow-ups recheck ratings at the same difficulty.
Both named difficulties grade against Amazon SDE II (L5) whatever the mock's target level:
`amazon-sde-2` at that bar and `beginner` a step below it. Older records without the field
keep the target-level bar above.

## Past performance in mocks

A live mock receives no past performance: no learner history, agent memory or saved notes, and its tools cannot
reach them: `liveMock` removes the memory, note, submission and search tools and limits
`read_context` to this interview's own record. Debriefs and report follow-ups keep all of
it. Choosing which problem to practise may still use history, before the interview starts.

## Open practice

Board autosaves retain exact element arrays in each practice session's
`board-history/<sha256>.json`. Both the previous and incoming scene are archived before
`elements.json` is replaced, under the same per-session write queue. Snapshots are
published atomically, immutable, and deduplicated by content; an unreadable current
board or corrupt snapshot prevents replacement. They are recovery data, never extra
model context. No automatic pruning or inference runs. Recover a chosen scene through
the existing workspace save path, preserving the current scene as another revision.
This covers accepted server saves; browser recovery storage still protects changes
waiting for autosave. Mock evidence retains its existing append-only scene records.
The practice page holds detached element snapshots, including its change-comparison
baseline and each queued request. Excalidraw mutates element objects in place; sharing
those objects silently hides text edits from equality checks and can change a queued
save after its revision was captured.

Practice sessions persist a server-owned `timer: { elapsedMs, runningSince, leaseUntil }` in
their `session.json`. The count-up timer starts only on explicit Start/Resume; a null
`runningSince` freezes the accumulated total. New sessions begin paused; a short server lease
lasts 30 seconds and is renewed by the visible browser every 10 seconds. Expiry
freezes elapsed time at that boundary. A heartbeat only renews its existing live run;
it cannot restart a stopped or expired timer. Every uninterrupted run has a hard
12-hour cutoff, including when a visible tab keeps sending heartbeats. Leases and
elapsed time are capped at that boundary; only explicit Resume starts another run.
Previously saved paused totals remain intact. Hiding, leaving, and reopening pause
tracking with a keepalive write. No automatic start is performed. Timer transitions share the workspace
write queue, preventing code/mode/topic autosaves from restoring stale clock state.
Repeated start/pause requests are idempotent. Timer state is not learner evidence,
a deadline, or additional model context. Legacy records are initialized only when
opened for practice, never backdated from `createdAt`.

LLD and system-design launchers default to “Choose my own problem”. Starting creates
an empty, voice-default session without a model call. The learner supplies any problem
in conversation; `set_practice_problem` persists its title and requirements and updates
the live header. Its generated problem slug remains stable, keeping notes and memory
with the same workspace. Topic updates never replace code, board or exchanges. Preset
and mock-derived sessions cannot have their source problem overwritten by this tool.
Opening another custom practice creates a separate identity.

## Editable coaching instructions

Coaches apply durable teaching improvements directly from lasting user feedback or
their own conversation-grounded observations. Neither path waits for review or approval;
history and undo are optional controls, not gates. `read_coaching_instructions` and
`update_coaching_instructions` are shared Studio tools for both providers, including
practice, mocks and report follow-ups. They do not grant file or shell access. During a
live mock the saved rules still apply, but the interviewer changes them only when directly
asked, and a rule limiting hints does not stop it stepping in as a real interviewer would.

Instructions are distinct from learner memory: skill observations remain untrusted
context; enabled coaching rules explicitly customize teaching defaults. Rules have a
stable ID, discipline (`all`, `coding`, `lld`, `design`), mode (`all`, `practice`, `mock`,
`review`), text and enabled state. Narrower rules take precedence over general ones;
the learner's current request supersedes saved teaching preferences. Permissions,
privacy, evidence integrity, explicit-action requirements and mock assistance contracts
remain fixed. Free-form prose is governed by that instruction hierarchy, not by a claim
that a text validator can prove a rule pedagogically safe or beneficial.

`shared/coaching-instructions.json` is server-owned and separate from memory tool paths.
It contains active rules and a retained revision history: before/after snapshots,
reason, timestamp, mutation identity and server-bound actor/conversation/request source.
The server serializes changes under a lock, checks the expected revision, and atomically
writes state and history together. Repeated mutation identities cannot apply twice or
be reused with different arguments. Restoring a version creates a new revision and
preserves later evidence. Failed or interrupted replies do not roll back an already
saved instruction change and must not automatically retry it.

Settings → Coaching instructions shows current rules and paged history. Users can add,
edit, disable, remove, undo the latest change, or restore a complete earlier version.
Agent changes also appear as action receipts. Restoring a version restores the entire
instruction set; editing or disabling one rule leaves other rules intact.

Applicable enabled rules are snapshotted before each interactive provider turn and
included in the actual system instructions and native-session signature. An update
made during a reply takes effect on subsequent turns. Effective instruction changes
start a new native segment with the saved conversation handoff; unrelated scope/history
changes do not. No automatic upkeep or follow-up inference is started. Utility jobs,
including picture generation, do not receive coaching guidance. Settings → What was
sent? exposes the exact instruction snapshot used by a request.

## Mock budget extensions

Mock countdowns are advisory. Expiry and an answer containing only “done” never
request a debrief. The explicit finish endpoint remains the completion boundary.
`POST /api/interview/extend` and `/api/design/extend` accept the session identity,
`minutes` (an integer from 1–240) and an idempotent `requestId`. They serialize with
model turns, preserve `originalMinutes`, increase `minutes`, and append a
`time_extended` record without inference. Pause accounting is unchanged.
