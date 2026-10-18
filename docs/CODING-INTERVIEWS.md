# Coding interviews

Start interview replaces the recorder's start button. Its setup chooses 30/45/60 minutes,
Typed/Voice and Interviewer on/off. Off uses the existing silent recorder and attempt review.
On replaces the entire coach panel, so the coach composer, history and submission tab cannot
be mistaken for the interviewer. The editor's Connector submission button remains unchanged.

The debrief stays visible until **Back to coach**. Past chats includes interview records;
opening a finished record never starts a provider turn. An unfinished interview resumes its
original wall-clock start. Only Pause excludes elapsed time; navigating away does not pause.
If the tab is closed at expiry, reopening ends the interview rather than granting more time.

## Recording and recovery

Typed mode retains the segment recorder as an archive, without triggering a second coach
review. Voice mode instead uses the live phrase pipeline with `think_aloud` archival mode and
an interview identity. They never acquire two microphones for the same interview. Voice
phrases enter a persisted draft immediately, then `turnDecision` submits after silence and
all pending transcriptions finish. Ending drains outstanding phrases before the debrief.
The microphone closes during synthesized speech. Escape stops speech for the rest of that
reply; its text still arrives. Reloading Voice mode requires Enable microphone again.
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
