# Coding interviews

The coding sidebar contains Chat, Interviews and Submissions. Start a typed or voice
interview from Interviews; select a saved row to inspect it without starting a provider.
Only explicit Resume continues a saved interview. Finished rows open a structured
report with post-interview questions. Only Pause freezes the coding/LLD clock.

## Recording and recovery

Typed mode does not implicitly open a microphone. Voice mode uses the live phrase pipeline with `think_aloud` archival mode and
an interview identity. They never acquire two microphones for the same interview. Voice
phrases enter a persisted draft immediately, then `turnDecision` submits after silence and
all pending transcriptions finish. Ending drains outstanding phrases before the debrief.
The same microphone stays open while an answer is submitted and the interviewer speaks.
Speaking over a reply stops its current and queued audio immediately; Escape does the same.
Its written text still arrives, and newly spoken words wait in the draft for the next turn.
Acceptance removes only the submitted prefix, so words captured in flight are preserved.
Failed replies hold automatic sending until an explicit Send or retry. Reloading Voice
mode requires turning the microphone on again.
Untranscribed audio retains the existing browser unload guard; it cannot survive a browser
process crash. Already transcribed words and typed drafts survive navigation/reload.

`server/interview/` owns `problems/<slug>/interviews/<id>/`. Candidate turns, buffer snapshots,
events, errors and replies append to `turns.jsonl`. `interview.json` is atomic mutable state;
`interview.md` is always rendered from the raw record. Claude Write/Edit deny rules cover the
entire directory. No part of interview startup fetches a statement: a missing local cache
produces an actionable error.

Requests reserve an interview operation before reading its state. Candidate input is
persisted before the SSE `accepted` event. Request identities prevent a repeated answer from
being appended on retry. A disconnected reader does not cancel generation; GET waits for
the existing turn and replays its durable result. Stop owns finalization even if the provider's
kill callback never fires. Pauses and completions cannot overwrite an in-flight response.

## Providers and interjections

### Low-level design mode

The `#/lld` screen uses the same interview panel, provider lifecycle, pause/resume
handling, raw record, and report pipeline as coding interviews. It is a strict 45-minute
L4 exercise by default with a blank Python document owned by the candidate. The library
includes three example Python scenarios: meeting-room booking, parcel lockers,
and a vending machine. Fresh mock preparation is not limited to those examples.
The interviewer asks one short question at a time, avoids
proposing classes or methods, and introduces at most one persisted curveball. Typed and
Voice are the same mutually exclusive modes used by the other interview screens.

Both providers use `readCoachChoice` and `runProviderTurn`, with no Studio or native tools.
Claude resumes its native session. Coding interviews opt into a separate tool-free Codex
conversation helper: one locked ephemeral app-server thread reused across turns, with each
configured MCP server disabled by name. Ordinary coach behavior is unchanged. Provider or
model changes, connection loss, and a missing Claude session cause reconstruction from the
complete raw record and a full buffer. Otherwise turns contain phase/time/hint facts, new
results and a code diff (full refresh every fifth reply or a large change).

Verdicts queue until the candidate has been quiet for 20 seconds and the 120-second
unprompted-interjection cooldown has elapsed. Failed runs require over 30 seconds of speech
silence. Idle thresholds are 45 seconds in Clarify/Approach and 90 in Code, considering both
speech and typing. The two-minute warning is another safe interjection. An unfinished draft
holds the floor. No event can trigger a submission or run code.

## Validation

- `node --test server/interview/*.test.mjs server/coach/test/codex-conversation.test.mjs`
- `npm run check:interview` uses a scratch home, synthetic cached content, fake CLIs, blocked
  external network, and no microphone. It checks typed conversation, reload/draft continuity,
  verdict response, debrief sections, coach restoration and measured button heights.
- `npm run check:visual` includes typed, voice and debrief fixtures across every theme/mode.
  Live visual fixtures refresh their clock at read time; they do not open a microphone.
- Reviewer: verify real speech turn boundaries, echo hold, interruption, mic permissions,
  background archive behavior and navigation with an unfinished spoken phrase.

## Python low-level design

Open **LLD** and choose **Start a new mock**. The selected coach model prepares a
fresh Python OOD problem using the learner's recorded history, prior assessments,
saved notes, target level and duration. The sample cards remain available for deliberate
practice; they are not the question bank. System Design's **Start a new mock** defaults
to **Choose for me · unseen** and uses the same preparation service.

Preparation checks recorded identities, titles, statements and semantic family IDs,
including legacy design sessions. A rejected repeat requires an explicit retry; there
is no canned fallback or automatic model retry. Exact/family checks cannot establish
semantic novelty for every paraphrase. History covers local Studio records and supplied
memory notes, not inaccessible external Claude or ChatGPT chats.

The default is 45 minutes at L4, using Python. The candidate starts with a blank
`design.py` editor. Put requirements and design notes in Python comments, then write
classes, methods and executable assertions or unittest tests. Run Python executes only
that document with Studio's timeout, output cap and process-group cleanup. It is a
standalone execution aid, not hidden correctness testing: a normal exit establishes no
correctness verdict. Completed documents are read-only.

LLD uses the coding interview panel, voice controls, drafts, lifecycle, reports and
review questions. Every interviewer turn receives the full current document. The
opening is the literal one-line scenario. Private clarification facts are supplied to
the interviewer; it is instructed to answer only what was asked. Probe counts and
curveball delivery tags are persisted, but substantive interview behavior still needs
real-session evaluation. Click Finish to request the debrief. Saying “done” stays an ordinary answer.

Each turn tells the interviewer where a plan by share of time says it should be:
requirements to 12%, classes and methods to 32%, code to 72%, a trace to 85%, then the
change requirement. The interviewer moves the candidate on and asks for the trace itself.
The change requirement stays private until 72% of the time, or until the trace phase, and
is dropped in the last three minutes. A debrief treats a step the interview never asked
for as not reached, not as a failure.

LLD reports cover requirements, responsibilities, interfaces, state, correctness,
edge cases, self-verification, extensibility and communication. Technical errors,
missing considerations, and self-caught versus interviewer-surfaced bugs are separate
sections. Unassessed areas have no rating. Model observations remain judgments.

System-design interviews now open the same report sheet and support post-interview
questions in a separate `followups.jsonl`; original transcripts and scenes stay intact.
The mock is strict while running; completed-report follow-ups switch to open teaching,
including approaches, complexity, edge cases, tests, and corrected code when asked.
Questions and answers are saved. Legacy prose debriefs remain readable, and legacy phase
durations are not invented.

Learning is organized per topic under `problems/<lld-or-design-slug>/`: requested notes
append to `NOTES.md`, while `LEARNING.md` is derived from recorded interviews. New
system-design topics use their own `design-<topic>` folder; legacy `design/<id>/` records
and index sidecars are preserved and remain readable.


## Shared learner context and answer modes

`server/learning/profile.mjs` derives cross-problem context from raw records, accepted
submissions, meaningful coding activity, interview reports and saved notes. Target
levels are explicit preferences in `learner-profile.json`; they are never presented as
assessed ability. Completed interviews and solved coding problems are separate facts.
Missing assessments stay unknown. Recent evidence is bounded with coverage markers;
problem identities remain exhaustive. Coaches, live interviewers and report follow-ups
receive this context as untrusted data. Current-session evidence is excluded from the
historical assessment list and supplied separately for grading.

New setups default to **Voice**, respecting a deliberately remembered Typed choice.
The live **Answer mode** control switches between Voice and Typed without a new session,
clock reset or transcript reset. Leaving Voice stops audio and drains the final phrase
into the same saved draft. Entering Voice with an unsent answer requires explicit send
or edit. Mode changes during a streamed reply take effect locally immediately and save
when that reply finishes. Failed saves have an explicit retry. Reload restores the saved
mode; reopening history does not implicitly enable the microphone.

Prepared definitions are server-owned `problems/<slug>/problem.json`; preparation
receipts in `mock-preparations/` make explicit retries idempotent. No interview clock
starts until preparation succeeds. Private clarification facts, curveballs and selection
rationale stay server-side. Interview records retain a definition snapshot, so a later
catalog change cannot alter what an existing interview was about.

## Advisory mock clock

Coding, LLD and system-design mocks stay open when the budget runs out. The clock
shows overtime; only the explicit Finish / Done — debrief me action starts a debrief.
Click the clock for 15 minutes, 20 minutes, or a custom whole number from 1–240.
Extensions add to the existing budget (including time already spent in overtime),
survive reloads and pauses, and do not call a model. The original budget and each
extension remain in the saved evidence.
