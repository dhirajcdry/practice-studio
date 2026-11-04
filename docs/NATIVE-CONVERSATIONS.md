# Persistent native conversations

This is the runtime contract for `server/coach/native-sessions.mjs` and `provider.mjs`.
It supersedes the former fresh-native-thread-per-turn design. The browser still talks
only to Studio; authentication and inference remain the selected local CLI's responsibility.
No extra API billing, provider fallback, model downgrade or automatic upkeep call is added.

## Identities and lifecycle

Every interactive caller supplies a conversation built by
`buildConversation({key, requestId, message, context, bootstrap, recoverySections})`.
The helper renders the bootstrap from the same context acknowledged as the baseline;
callers must not concatenate a second full prompt. Keys identify the whole workspace:
`coding:<slug>:<chat-id>`,
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
instructions, including bootstrap role guidance, also start a new segment; Codex 0.165 cannot replace dynamic schemas on resume.

The CLI process closes after a turn; the native conversation remains persisted and
resumable. Three days without use archives Studio's segment metadata. Startup and hourly
expiry skip live leases. The next visit bootstraps a new segment; transcripts, notes,
code, boards and provider-owned files are not deleted.

## Context and caching

Bootstrap includes the saved conversation, current work, problem, selected learner
history, memory and source-linked session decisions exactly once. Ordinary-sized conversations are
included completely. Exceptionally large handoffs select within 100,000 characters,
explicitly advertise coverage/omissions and retain full paged retrieval. Debriefs retain
their separate evidence budget including chronological code changes. A 400,000-character
whole-request guard rejects excessive payloads rather than silently discarding current work.

Continuation sends the current message and changed named context sections. Unchanged
sections are listed by name. Code uses a smaller diff against the last acknowledged
snapshot when useful, with old/new content hashes; otherwise it sends the full code.
Append-only activity lists send only appended records. `get_state` always reads current
saved work and must precede editing; the existing revision/replacement checks still apply.

Session decisions use `sessionContext.delivery(query)`. Verified canonical entries are
keyed: continuations send only changed keys, including explicit status changes, and
notices when a previously delivered entry loses source verification. An omitted query
result is never a retraction. Query/source-count and anchor-selection churn does not
resend the record. A compaction resync restores verified decisions, selected correction
anchors and recent exact evidence; omitted originals remain available through paged retrieval.

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

The CLI process still starts for one turn and closes afterward; the provider-native
conversation is what persists. Delivery and reuse figures are measured characters and
provider telemetry, not subscription-quota percentages or guaranteed savings.

Completed-mock reports and follow-ups use a separate review identity
`review:<slug>:<id>:followups` (legacy design routes use `design` for the slug). The
report and follow-ups share the review system prompt, tool schema, and tool-result target.
The report starts with chronological interview evidence and final work. Its JSON rubric
is a one-response task in the current message, not a permanent role instruction. The first follow-up adds the
authoritative parsed `Report` section once, without duplicating the raw debrief. Later
follow-ups keep independent sections for evidence, final workspace, memory and report.

## Guardrails and owning tests

The November 4 audit found a working native resume path and substantial cache reads.
The waste came from repeatedly appending unchanged private scenario facts and whole
query-selected session projections, plus starting report follow-ups separately with
duplicated evidence. A cache hit still processes historical input; caching does not make
repeated application payloads free. Do not fix this by lowering the model/effort,
dropping evidence, disabling tools, or replacing the conversation with a short summary.

- Bootstrap is rendered from the exact context snapshot later acknowledged. Never build
  a separate larger prompt and mark an unrelated smaller baseline as delivered.
- Semantic deltas compare verified canonical entries by key. Changing a query, selected
  anchors, or source count does not establish a new requirement or retract an old one.
- Live conversations retain native dialogue. Recoveries restore current state and exact
  selected evidence; paged originals remain available. Model compaction is not archival deletion.
- Report generation and follow-ups share the review identity, system/tool signature and
  tool-result target. JSON instructions apply only to generating the report. Memory edits
  cannot trigger resending the unchanged report, final work or completed interview.
- Neither a failed turn nor a failed evidence write can acknowledge delivery. No automatic
  inference/upkeep call is added. Provider switches or incompatible instructions create
  explicit new segments; voice/typed switching does not.

| Contract | Owning regression tests |
| --- | --- |
| Bootstrap/baseline identity; key updates; query churn; correction recovery; independent report/memory sections | [`context-delivery.test.mjs`](../server/coach/test/context-delivery.test.mjs) |
| Native identity; code diffs; provider switches; leases; compaction; failed commits; expiry; interrupted progress | [`native-sessions.test.mjs`](../server/coach/test/native-sessions.test.mjs) |
| Evidence selection and coverage; code-change records; omitted evidence retrieval | [`context-policy.test.mjs`](../server/coach/test/context-policy.test.mjs) |
| Codex resume, permissions, stale callbacks and current-turn usage | [`codex-cli.test.mjs`](../server/coach/test/codex-cli.test.mjs) |
| Real route report-to-follow-up continuity, raw-record immutability and practice bootstrap | [`interview/routes.test.mjs`](../server/interview/routes.test.mjs), [`design/routes.test.mjs`](../server/design/routes.test.mjs), [`practice/routes.test.mjs`](../server/practice/routes.test.mjs) |

Run `npm test` and the affected browser checks below against scratch homes/fake providers.
These enforce delivery correctness; they do not establish identical real-model answers.
Any intentional replacement must update this contract, the decision log and the owning
regressions, with evidence that continuity, assistance attribution and recovery survive.

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
