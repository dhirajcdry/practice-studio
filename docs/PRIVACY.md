# Privacy & offline use

Practice Studio stores your practice on your machine. Connected features have separate
boundaries: Claude coaching uses its configured service, and problem fetching/submissions
contact LeetCode. The local server is bound to `127.0.0.1`.

## What runs where

| Feature | Local work | Network use |
| --- | --- | --- |
| Catalog, editor, themes, whiteboard | Committed catalog and vendored browser assets | No CDN needed |
| NeetCode problem definitions | Only slug, name, description, Python starter, example inputs, test case type, Pro-only flag and message in `STUDIO_HOME/cache/neetcode/` | Opening an uncached premium problem fetches its NeetCode question page once. Solutions, article bodies and videos are discarded at parse time and never cached, logged, shown or sent to the coach |
| Problem statements and starters | Cached in `STUDIO_HOME/cache/leetcode/` | First open of an uncached problem calls LeetCode |
| Python run | Temporary driver and code; case comparison | Runner sandbox denies network when enabled on macOS |
| AI coaching | Local CLI process, context assembly, session files | CLI sends the prompt/context to its configured service; native web research can search public sources and read pages |
| System-design interview | Canvas, scene snapshots, transcript, phase state | New interviewer turns use the same connected CLI |
| Speech recognition | Audio decoded and transcribed on-device by Swift/WhisperKit 0.18.0 | Initial dependency/model downloads; recognition itself is on-device |
| Interviewer speech output | Local Kokoro ONNX, with browser `speechSynthesis` fallback | Kokoro synthesis sends nothing off-device; setup downloads dependencies and models. System voice behavior depends on browser/OS |
| LeetCode submission | Verdict and submitted code recorded locally | Your browser, through the Studio Connector extension, sends your solution to LeetCode with its own sign-in and polls that submission's result |
| NeetCode submission (premium problems) | Verdict and submitted code recorded locally | Your browser, through the Studio Connector extension, puts your solution into a neetcode.io tab's editor storage, presses NeetCode's Submit with its own sign-in and reads the verdict off that page. No NeetCode cookie is read |
| Reference solutions/articles | Read from optional local checkout | Initial clone/update from GitHub |

## AI coaching

A coding turn can include the current editor buffer, a diff from the latest code snapshot,
problem content, local case results, stdout/errors, elapsed time, available speech
transcripts, and relevant session activity. Studio tools retrieve scoped evidence and
apply visible code/board edits or memory updates. The configured account/service
processes the prompts; provider retention and account settings apply.

On the design side, the interviewer receives the candidate's answer, phase/timing context,
and a textual component/connection graph with changes from the previous board. It isn't
sent a screenshot of the canvas by Studio. Saved transcript context may be resent when
starting a fresh native segment. Same-provider interactive turns resume native CLI
history; provider-managed compaction and retention settings apply. Native session files
are held by the CLI. Studio additionally stores conversation identity/checkpoints and
partial reply journals under `context/conversations`, and exact tool-result pages under
`context/tool-results`. These contain private learner context. Three-day idle expiry
archives session metadata without deleting any learning evidence.

Interactive coaches use Studio-defined tools plus provider-native web research
(Codex web search, Claude WebSearch/WebFetch). Shell and unrelated MCP servers remain
disabled. Research guidance excludes private code/history from queries and treats web
content as untrusted; search queries and fetched URLs are processed by the provider.
Legacy Claude memory maintenance retains its scoped file rules; it is never triggered
automatically after an answer. Studio does not introduce separate API billing.

Settings → What was sent? shows exact application-supplied prompts, instructions and
Studio tool definitions for recent requests, plus provider-reported usage when available.
Prompt contents are retained in memory only, up to 20 requests within one million
characters. Content-free usage records live under `usage/turns.jsonl`. Provider-owned
instructions, web result payloads and later tool exchanges are not included in the
inspector's exact prompt. Their tokens may be reflected in provider-reported usage.

## Audio and transcripts

Audio uploaded from the browser goes to a temporary local file for the Swift transcriber.
The route removes that temporary file afterward. Coding transcripts can be stored under
`problems/<slug>/transcripts/`; spoken design answers are recorded in the interview turns.
Studio's transcription route doesn't send audio to a speech API. Text produced from audio
can subsequently be included in a coach/interviewer prompt.

Live previews use a faster local decoding pass and are never stored as transcript
records or sent as answers. Final phrase decoding supplies the saved text. If a final
phrase fails, its audio is held temporarily in the current browser workspace for an
explicit retry or discard; it is not persisted in browser storage and is lost when
leaving the workspace or reloading. Successful phrases remain in the recoverable text
draft. Cancelling a preview releases its temporary file after native decoding finishes.

Natural speech uses a long-lived local Python/Kokoro process. Sentence text travels only
between the browser and the loopback server; WAV audio stays in memory. No speech text
or audio leaves the machine through Kokoro. Settings → Voice stores the output mode,
voice and speed in browser localStorage. Natural defaults to Heart at 1.0× and falls
back to the browser's system voice if unavailable. System voice availability and network
behavior depend on the browser and OS. Microphone permission is managed by the browser.

`npm run tts:setup` is an explicit, one-time network install of Kokoro 0.4.9 and verified
model files under `~/Library/Application Support/PracticeStudio/tts/`. Startup and checks
never install or download TTS models.

The recognizer first checks the selected `modelName` in the `com.justwisper.app` UserDefaults
domain, defaulting to `small.en`; `STUDIO_ASR_MODEL` overrides that selection. Existing
Wispr model and tokenizer files are reused read-only from `~/Library/Application Support/Wispr/Models/`
and `~/Library/Application Support/Wispr/Models/Tokenizers/`. Missing models are downloaded into
`~/Library/Application Support/PracticeStudio/ASRModels/`.

## Storage and credentials

`STUDIO_HOME` defaults to `~/LeetCodeTutor`. It holds solutions, snapshots, session logs,
notes, transcripts, cached problem content, and saved interviews as ordinary files.
The editor also keeps a recovery draft and UI preferences in browser local storage.
Claude Code manages its own authentication and conversation storage separately.

Studio stores no LeetCode credentials. Submissions are sent by the Studio Connector
extension from a leetcode.com tab, using the browser's existing sign-in. The extension
checks that the LeetCode cookies exist and uses the CSRF token inside that tab; no cookie
value is passed to the Studio page or server, logged, or written to a file. See
[Submitting to LeetCode](SUBMITTING.md).

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

### Selecting a coach provider

New replies use the provider selected in the coach header or Settings: Codex CLI
(ChatGPT sign-in; Astra by default) or Claude Code (its configured sign-in). Context is
sent only to the selected provider; hitting a limit does not silently switch services.
Codex receives the current turn, bounded prior chat history, and relevant local note
excerpts. Its ephemeral thread has no enabled coaching tools or memory-file writes.
Studio saves the resulting chat locally. Claude keeps its existing scoped memory tools.
Model selection contains no credentials and lives in `STUDIO_HOME/coach-settings.json`.
MCP servers from your own Codex config are turned off by name for Studio's threads.

### Coach pictures

When the coach writes an ````image` block, the browser may ask for it to be drawn,
depending on the coach-pictures setting. The picture description, which the coach wrote
from your conversation, is sent to OpenAI through your Codex sign-in and spends your
Codex image quota. No code, notes or history go with it. The picture is stored locally
as `STUDIO_HOME/problems/<slug>/visuals/<id>.<ext>`, beside a `.json` file holding the
description it was drawn from. Codex also keeps its own copy under
`~/.codex/generated_images`; Studio doesn't manage or delete that folder.
