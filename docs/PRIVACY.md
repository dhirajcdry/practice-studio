# Privacy & offline use

Practice Studio stores your practice on your machine. Connected features have separate
boundaries: Claude coaching uses its configured service, and problem fetching/submissions
contact LeetCode. The local server is bound to `127.0.0.1`.

## What runs where

| Feature | Local work | Network use |
| --- | --- | --- |
| Catalog, editor, themes, whiteboard | Committed catalog and vendored browser assets | No CDN needed |
| Problem statements and starters | Cached in `STUDIO_HOME/cache/leetcode/` | First open of an uncached problem calls LeetCode |
| Python run | Temporary driver and code; case comparison | Runner sandbox denies network when enabled on macOS |
| AI coaching | Local CLI process, context assembly, session files | CLI sends the prompt/context to its configured service |
| System-design interview | Canvas, scene snapshots, transcript, phase state | New interviewer turns use the same connected CLI |
| Speech recognition | Audio decoded and transcribed by Swift/CoreML | Initial dependency/model downloads; recognition itself is on-device |
| Interviewer speech output | Browser `speechSynthesis` | Voice availability and network behavior depend on browser/OS |
| LeetCode submission | Credentials read from Keychain; result recorded locally | Sends your solution to LeetCode and polls that submission's result |
| Reference solutions/articles | Read from optional local checkout | Initial clone/update from GitHub |

## AI coaching

A coding turn can include the current editor buffer, a diff from the latest code snapshot,
problem content, local case results, stdout/errors, elapsed time, available speech
transcripts, and recent session activity. The CLI can read files inside `STUDIO_HOME`
and write the designated coach memory files there. Its configured account/service
processes the prompts; provider retention and account settings apply.

On the design side, the interviewer receives the candidate's answer, phase/timing context,
and a textual component/connection graph with changes from the previous board. It isn't
sent a screenshot of the canvas by Studio. Saved transcript context may be resent when
resuming an interview without its original CLI thread.

The allowed CLI tools are `Read`, `Glob`, `Write`, and `Edit`, with filesystem allow/deny
rules. Bash, web tools, and unrelated MCP servers are excluded. These permissions govern
tool access; they don't turn a remote model into an offline one.

## Audio and transcripts

Audio uploaded from the browser goes to a temporary local file for the Swift transcriber.
The route removes that temporary file afterward. Coding transcripts can be stored under
`problems/<slug>/transcripts/`; spoken design answers are recorded in the interview turns.
Studio's transcription route doesn't send audio to a speech API. Text produced from audio
can subsequently be included in a coach/interviewer prompt.

The app uses your browser's microphone and speech-output facilities. Microphone permission
and selected TTS voices are managed by the browser and macOS.

## Storage and credentials

`STUDIO_HOME` defaults to `~/LeetCodeTutor`. It holds solutions, snapshots, session logs,
notes, transcripts, cached problem content, and saved interviews as ordinary files.
The editor also keeps a recovery draft and UI preferences in browser local storage.
Claude Code manages its own authentication and conversation storage separately.

LeetCode cookies are stored in **macOS Keychain**, not plaintext application config.
Keychain is persistent storage; describing this as "credentials never touch disk" would
be inaccurate. The credentials wrapper redacts ordinary serialization and inspection,
but the values must still be used in outbound judge requests.

`STUDIO_MIRROR_DIR` is opt-in. Pointing it at iCloud Drive or another synced folder sends
the generated daily Markdown summary through that folder's sync service. The destination
has its own sharing and retention behavior.

## Offline preparation

A cached problem can be read and run without connectivity. An uncached statement can't.
Reference material must already be cloned, and the speech model must already be downloaded.
AI coaching, new interviewer questions, and real judge submissions need connectivity.
Saved design interviews remain readable locally.

```sh
npm run warm:check     # inspect cache coverage; no network requests
```

Opening selected problems while online is sufficient for targeted preparation. There is
also an explicitly invoked cache warmer:

```sh
npm run warm
```

It fetches sequentially with a delay between requests, resumes cached progress, and stops
on a challenge/rate limit. It isn't run automatically by the app or CI. Don't replace it
with concurrent fetching or unbounded retries; interrupted preparation can be resumed
later. See `scripts/warm-cache.mjs` for its current behavior.

## Keeping a practice archive

Back up `STUDIO_HOME` if you want to preserve your work; it isn't synced by Studio unless
you configure a mirror destination. Removing it deletes the local practice record, not
Claude's independently managed history or browser recovery drafts. Don't commit a personal
workspace, recordings, cookie values, or unreviewed coach notes to a public repository.
The public examples in this repo use original demo fixtures and scripted coaching.
