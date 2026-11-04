# Persistent native conversations

This is the runtime contract for `server/coach/native-sessions.mjs` and `provider.mjs`.
It supersedes the former fresh-native-thread-per-turn design. The browser still talks
only to Studio; authentication and inference remain the selected local CLI's responsibility.
No extra API billing, provider fallback, model downgrade or automatic upkeep call is added.

## Identities and lifecycle

Every interactive caller supplies `conversation: {key, requestId, bootstrapPrompt,
message, context}`. Keys identify the whole workspace: `coding:<slug>:<chat-id>`,
`practice:<slug>:<practice-id>`, `interview:<slug>:<mock-id>`, `design:<mock-id>`, or a
completed mock's follow-up identity. Practice copies and originals are separate.

The Studio logical ID is never a native resume ID. Metadata contains a sequence of
provider segments and their actual native IDs. Legacy fields named `claudeSessionId`
are compatibility identifiers, not permission to resume a provider session. Existing
Studio conversations migrate through one saved-history bootstrap on their next turn.

Same provider, compatible instructions/tools and successful prior turn resume the same
native conversation. Voice/typed changes are context, not a new session. Model/reasoning
choice is applied to the next turn without switching providers. A provider switch,
including A → B → A, starts a new segment with a handoff. Changed tool schemas or role
instructions also start a new segment; Codex 0.165 cannot replace dynamic schemas on resume.

The CLI process closes after a turn; the native conversation remains persisted and
resumable. Three days without use archives Studio's segment metadata. Startup and hourly
expiry skip live leases. The next visit bootstraps a new segment; transcripts, notes,
code, boards and provider-owned files are not deleted.

## Context and caching

Bootstrap includes the saved conversation, current work, problem, selected learner
history, memory and source-linked session decisions. Ordinary-sized conversations are
included completely. Exceptionally large handoffs select within 100,000 characters,
explicitly advertise coverage/omissions and retain full paged retrieval. Debriefs retain
their separate evidence budget including chronological code changes. A 400,000-character
whole-request guard rejects excessive payloads rather than silently discarding current work.

Continuation sends the current message and changed named context sections. Unchanged
sections are listed by name. Code uses a smaller diff against the last acknowledged
snapshot when useful, with old/new content hashes; otherwise it sends the full code.
Append-only activity lists send only appended records. `get_state` always reads current
saved work and must precede editing; the existing revision/replacement checks still apply.

After a successful native turn, the route first saves Studio evidence, then calls the
third `onDone` argument (`commit`, required for persistent routes), then notifies the browser. Only that commit
advances the context baseline. Utility callers without a conversation keep independent
turns. A failed or cancelled attempt never silently retries against uncertain native state.
The next explicit request starts a handoff including saved assistance receipts.

Native harnesses manage their own working-context compaction. Observed compaction events
mark the next turn for a full current-state resync, including decisions and unresolved
questions, without replaying the whole conversation. Original evidence remains available
through `read_context` and `search_context`; memory remains a source-linked interpretation.

Resume enables shared history; it does not guarantee a cache hit. Caching depends on exact
prefixes, provider behavior and retention. Stable role/tool definitions and small appended
messages improve reuse. Usage reports provider counts, never invented savings or quota
percentages. Codex resumed-turn counts subtract historical usage rather than charging the
whole thread again in Studio telemetry.

## Streaming, tools and recovery

Tokens continue through existing narration/tag filters, UI streaming and speech queues.
Provider-native tool callbacks bind to the current turn. Codex validates both thread and
turn IDs; Claude gets a fresh per-turn MCP token/config, revoked when that turn finishes.
Every Codex start/resume disables each user-configured MCP server by name, file/shell tools,
and approvals. Studio tools and authorized native public web research remain available.
Never use permission bypass flags or silently grant tools because a session is resumed.

Code/board edits remain visible, undoable, checked and saved before success. Completed
mocks stay evidence; practice branches are editable. Tool-result `result:<hash>` pages are
saved within the full workspace target, so later turns can retrieve references in native
history. They cannot retrieve another target's results or arbitrary paths.

A browser refresh detaches a viewer and does not launch another model turn. Existing
coding run reattachment and practice polling restore progress without narrating replayed
text. Practice checkpoints partial answers about every 350 ms, serialized with action
receipts and final writes. Every persistent turn also keeps a server-side progress journal
about every 300 ms. A server restart interrupts the process; it cannot recover unreceived
provider output or browser microphone audio. Interrupted records remain explicit and no
question or tool mutation is automatically replayed. A replacement segment includes prior
interrupted journals as explicitly unconfirmed evidence with request/attempt identities;
`read_context(native_progress)` retrieves the exact records. They are not rewritten into
completed chat or mock answers. Native journals contain raw adapter
text; presentation must continue through the existing narration filters, never display the
journal directly as if it were an already-filtered assistant answer.

## Storage and inspection

Canonical learner evidence remains under `tracks/{coding,lld,design}/problems/<slug>`.
`context/conversations/<sha256-key>/state.json` stores native segment metadata and the last
acknowledged section hashes/code baseline. `turns/<attempt-id>.json` stores request identity,
partial answer, progress sequence and terminal status. Writes are atomic and serialized;
one server lease owns a conversation at a time. No raw interview files are rewritten.

`context/tool-results/<target-hash>/<result-hash>.txt` stores exact paged tool results.
These and progress journals contain private learner context, just like Studio's existing
archives; use the same local backup/privacy treatment. There is no automatic evidence
deletion. This remains local single-server storage, not a multi-process database.

Settings → What was sent? distinguishes a new segment from a resumed conversation, shows
native identity, delivered revision and compaction resync, and displays the exact **new**
application payload. Native prior history, provider compaction, built-in instructions and
later tool exchanges are additional context, not falsely included in that view. The
content-free `usage/turns.jsonl` includes segment/delivery metadata and actual provider usage.

## Regression contract

Use scratch homes and fake CLIs. Test two separately launched turns resuming the same
native ID, provider A/B/A switches, voice/typed continuity, schema changes, compaction,
failed commits, cancellation, concurrent requests, idle expiry, full first handoff,
incremental code/activity and persisted tool pages. Adapter tests must enforce permissions
on resume, stale callback rejection, current-turn usage and early token streaming.

Run `npm test`, then the affected browser checks (`check:practice`, `check:voice`,
`check:interview`, `check:lld`, coach stream/reload and design). Never test a real model
against learner data. Restart the asset-snapshot server only when no coach turn is active.

Protocol references: [Codex app-server](https://learn.chatgpt.com/docs/app-server),
[Claude headless sessions](https://code.claude.com/docs/en/headless). Installed CLI schema
and adapter fixtures are the compatibility authority when documentation describes newer APIs.

## Coaching instruction revisions

`provider.mjs` resolves enabled coaching rules by discipline and mode before
`beginConversation`. Only the effective rule contents enter the system instruction
signature; the global revision and irrelevant rules do not. Consequently changing or
undoing applicable coaching instructions creates an `instructions-or-tools-changed`
segment with the existing handoff, while unrelated edits preserve resumability.
The executing turn retains its original snapshot even if a Studio tool saves a change.
See [Editable coaching instructions](CONTEXT.md#editable-coaching-instructions).
