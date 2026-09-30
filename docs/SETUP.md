# Setup & troubleshooting

Start with the [README quick start](../README.md#quick-start). The basic coding workspace
needs macOS, Node.js 22+, and Python 3. It doesn't need an npm install, Claude account,
Swift build, or LeetCode cookies.

## Check the basic tools

```sh
node --version
python3 --version
npm start
```

The server prints its listening address. Open `http://127.0.0.1:4173` in a desktop
browser. Search and open a problem while online to cache its content. An empty workspace
has no cached statements; the committed catalog supplies the list, not the statements.

## AI coaching

Install Claude Code using its official installation instructions, sign in, and check:

```sh
claude --version
```

Restart Studio if you installed the CLI after starting the server. `STUDIO_COACH_BINARY`
can point at an executable outside `PATH`. The coding workspace still works when the
CLI is missing or a turn fails. The system-design interviewer needs the CLI to ask new
questions; saved interviews can be read without new model turns.

The CLI uses your configured authentication and service. Studio supplies session context
and permits access to its workspace. See [privacy](PRIVACY.md#ai-coaching) before putting
sensitive material in that workspace. A new workspace starts without your personal coach
notes; memory files can develop through use. Studio doesn't copy your instructions from
another workspace automatically.

## Voice input

Voice is optional. Install the Swift 6 toolchain on macOS 14 or later, then build:

```sh
swift build -c release --package-path asr
```

The server expects `asr/.build/release/studio-asr` in this checkout. The first
transcription downloads the Parakeet CoreML model; do that while online before relying
on offline speech recognition. The model cache is separate from `STUDIO_HOME`, under
`~/Library/Application Support/FluidAudio/Models/`.

Allow microphone access in the browser. In a coding attempt, **Start attempt** records
spoken reasoning alongside edits and runs. In a system-design interview, **Type** and
**Voice** are separate answer modes; in voice mode, going quiet submits a turn. Audio is
transcribed locally, but a transcript used for AI coaching becomes part of the connected
coach context. Browser speech output uses `speechSynthesis`; available voices and their
offline behavior depend on your browser and operating system.

## Reference material

Reference solutions and articles are optional for practice and required by some tests:

```sh
git clone --depth 1 https://github.com/neetcode-gh/leetcode.git vendor/neetcode-solutions
```

The committed index was generated against an upstream revision. If a newer checkout has
moved indexed files, see [contributing](../CONTRIBUTING.md) before regenerating it with
`npm run solutions`. Reference solutions are displayed as text and never executed by
Studio.

## LeetCode submissions

Submitting requires your LeetCode session cookies. Obtain them from your signed-in
browser and store them under account `studio` in macOS Keychain. `LEETCODE_SESSION` and `csrftoken` are required; `cf_clearance` is optional when
LeetCode is not challenging your browser. The names are:

| Keychain service | Browser cookie |
| --- | --- |
| `studio-leetcode-session` | `LEETCODE_SESSION` |
| `studio-leetcode-csrf` | `csrftoken` |
| `studio-leetcode-cfclearance` | `cf_clearance` |

To keep cookie values out of shell history, use interactive password prompts:

```sh
security add-generic-password -U -a studio -s studio-leetcode-session -w
security add-generic-password -U -a studio -s studio-leetcode-csrf -w
security add-generic-password -U -a studio -s studio-leetcode-cfclearance -w
```

Paste each value at its password prompt. The `-U` option updates an existing item.
Alternatively, create or update these generic password items in Keychain Access.
`cf_clearance` is tied to the browser that issued it; if challenged, set
`STUDIO_LEETCODE_UA` to that browser's user agent before starting Studio. Cookie expiry
or a challenge can require signing in again and updating the Keychain items.

Use **Submit** only when you intend to contact the real judge. Each explicit action sends
one solution; a local pass doesn't imply acceptance by hidden tests.

## Configuration

Set environment variables in the shell that starts Studio. Don't store cookie values in
environment variables or project files.

| Variable | Default | Purpose |
| --- | --- | --- |
| `STUDIO_HOME` | `~/LeetCodeTutor` | Solutions, session records, notes, and content cache |
| `STUDIO_PORT` | `4173` | Local server port; host stays `127.0.0.1` |
| `STUDIO_COACH_BINARY` | `claude` | Executable for coaching and design interviews |
| `STUDIO_PYTHON` | `python3` | Interpreter for local code execution |
| `STUDIO_NO_SANDBOX` | unset | `1` disables the macOS sandbox; removes its network restriction |
| `STUDIO_LEETCODE_UA` | Pinned browser user agent | User agent for real judge requests |
| `STUDIO_MIRROR_DIR` | unset | Optional destination for a daily Markdown summary |

For a separate practice workspace:

```sh
STUDIO_HOME="$HOME/PracticeStudio" STUDIO_PORT=4174 npm start
```

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `/` · `j` / `k` · `Enter` | Search · move through results · open |
| `⌘'` · `⌘↵` · `⌘S` | Run locally · submit to LeetCode · save |
| `⌘B` · `⌘J` · `⌘\` | Toggle problem · results · coach |
| `⌥R` | Start or end a coding attempt |
| `s` · `a` | Reveal reference solution or article outside the editor |

The settings panel lists shortcuts and the six themes. Reveal actions are logged so they
can appear in your practice history.

## Common setup problems

| What you see | What to check |
| --- | --- |
| Port already in use | Stop the other Studio process, or start with `STUDIO_PORT=4174 npm start`. |
| Problem content unavailable | An uncached problem needs LeetCode connectivity. Wait if challenged; a different cached problem can still work offline. |
| Local runner can't find Python | Run `python3 --version`, or set `STUDIO_PYTHON` to your Python 3 executable. |
| Reference solution/article unavailable | Clone the optional reference repository and check that the indexed file exists. |
| Coach unavailable or authentication error | Confirm `claude` works from this shell, sign in, and restart Studio. |
| Transcriber not built | Build the Swift target in this checkout; building another checkout doesn't create this one's binary. |
| First voice turn takes longer | The model may be downloading or compiling. Allow online setup to finish. |
| Microphone is silent | Check the browser's site permissions, selected input device, and macOS microphone permission. |
| Local pass, judge failure | Local examples/custom cases and LeetCode hidden tests are different evidence; read the judge's actual verdict. |

For an offline trip, use `npm run warm:check` to inspect cache coverage without a network
request. See [offline preparation](PRIVACY.md#offline-preparation) for the optional
sequential cache warmer.
