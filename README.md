# Practice Studio

**Practise coding and system-design interviews with a coach that follows your code, test runs, and reasoning.**

A workspace for the whole interview: write Python, run it locally, explain your approach,
and get feedback on what your tests don't measure. Built for macOS, with local session
storage, on-device transcription, and optional AI coaching through Claude Code.

[Quick start](#quick-start) · [Your first session](docs/FIRST-SESSION.md) · [Example session](docs/EXAMPLE-SESSION.md) · [Privacy & offline use](docs/PRIVACY.md)

![Practice Studio: a working Python solution, real local test results, and coaching about the reasoning behind it](docs/images/coach.png)

*An illustrative session in the actual app. The code is executed locally; the coaching
is scripted for this demo. [See the full example and how these images are made.](docs/EXAMPLE-SESSION.md)*

## Three ways to practise

| Coding | Explain your thinking | System design |
| --- | --- | --- |
| Browse the NeetCode 250 curriculum, write Python in Monaco, and run example or custom cases locally. Submit separately to LeetCode when you're ready. | Narrate an attempt or ask the coach a question. It receives your buffer, code changes, run results, timing, and available transcripts. | Draw on an Excalidraw whiteboard while an interviewer probes your requirements, estimates, and tradeoffs. Use typed answers or voice mode. |

The useful moment is often **after the tests pass**: can you explain the invariant,
justify the complexity, and defend the design? Studio preserves the evidence from the
attempt so the coach can ask a specific follow-up.

![System-design practice with a URL-shortener diagram and a question about a missing cache write path](docs/images/system-design.png)

*Illustrative interview: the candidate describes populating a cache, but hasn't drawn
that connection. The interviewer receives a graph of the board on the next answer.*

<details>
<summary>Watch a short coding walkthrough</summary>

![Open the example, write and run code, explain the approach, and receive a follow-up](docs/images/demo.gif)

The walkthrough uses a temporary demo workspace and scripted coaching. No account,
Claude request, or LeetCode submission is used to produce it.

</details>

## Quick start

**Requirements:** macOS, Node.js 22+, and Python 3. The editor and local runner work
without Claude Code. Voice additionally requires macOS 14+, Swift 6, and the downloaded
speech model.

```sh
git clone https://github.com/dhirajcdry/practice-studio.git
cd practice-studio
npm start
```

Open **http://127.0.0.1:4173**. There is no npm install or frontend build step.
Search for a problem, open it while online to cache its statement and starter code,
then write your solution and press **Run**. Local results cover the cases shown; they
are separate from an accepted LeetCode submission.

| Add-on | Setup |
| --- | --- |
| AI coach and system-design interviewer | Install and sign in to the Claude Code CLI; `claude` must be on your `PATH`. Coaching uses its configured online service. |
| Voice input | Run `swift build -c release --package-path asr`. The first transcription downloads the model; allow microphone access in your browser. |
| Reference solutions and articles | `git clone --depth 1 https://github.com/neetcode-gh/leetcode.git vendor/neetcode-solutions` |
| LeetCode submissions | Store your session cookies in macOS Keychain. [Submission setup](docs/SETUP.md#leetcode-submissions). |

[Your first session](docs/FIRST-SESSION.md) walks through the screens and expected
results. [Setup & troubleshooting](docs/SETUP.md) covers optional features, environment
variables, and keyboard shortcuts.

## Local storage, connected coaching

The browser talks to a Node server bound to `127.0.0.1`. Solutions, logs, transcripts,
and notes are stored in `~/LeetCodeTutor/` (configurable with `STUDIO_HOME`). Monaco and
Excalidraw are bundled in the repository.

**Local-first doesn't mean every feature is offline.** Cached problems and the Python
runner work offline. Claude coaching needs connectivity and sends session context to
its configured service. Fetching new problem statements and submitting solutions
contact LeetCode. Speech recognition runs on-device after its model is downloaded.
See [privacy & offline use](docs/PRIVACY.md) for the full boundary.

## Built around the practice loop

- **Own the evidence.** The coach receives editor text, diffs, and case results directly.
  It doesn't infer the attempt from screenshots of another website.
- **Keep the record.** Session events and code snapshots are retained locally; readable
  attempt documents can be regenerated from them. Missing progress evidence is shown
  as missing, rather than converted into a score.
- **Separate the processes.** Python runs in a fresh temporary directory with timeout
  and output limits, and a network-denying macOS sandbox when available. The coach's
  allowed tools and writable files are scoped separately.
- **Keep the frontend simple.** Plain browser ES modules and Node built-ins; no npm
  runtime dependencies. Vendored UI libraries and the optional Swift/Claude tools have
  their own dependencies.

[Architecture](docs/ARCHITECTURE.md) explains the processes, storage, and boundaries.
[Engineering decisions](docs/ENGINEERING.md) links the implementation and tests behind
these choices.

## Current scope

This is an early macOS project. The coding runner and editor support **Python**;
Windows and Linux aren't supported as equivalent sandboxed environments. Local cases
aren't LeetCode's hidden tests. AI feedback is guidance, not a hiring decision, and
transcription can mishear technical terms. Premium problem access and LeetCode browser
challenges can limit the integration.

[Current limitations](docs/LIMITATIONS.md) · [Roadmap](docs/ROADMAP.md) · [Contributing](CONTRIBUTING.md)

## Development

Clone the optional reference repository above before running the full test suite:

```sh
npm test           # Node unit and integration tests; fake coach and judge
npm run check      # Chrome checks; see CONTRIBUTING.md for scratch-workspace setup
```

| Directory | Purpose |
| --- | --- |
| `server/` | Routes, Python runner, coach, judge client, attempt records, and stats |
| `web/` | Browser UI and committed Monaco/Excalidraw assets |
| `asr/` | Optional Swift/CoreML speech recognizer |
| `data/` | Generated curriculum and reference index |
| `scripts/` | Generators, browser checks, and reproducible demo capture |
| `docs/` | User guides, architecture, API contracts, and protocol research |

Working with a coding agent? Start with [AGENTS.md](AGENTS.md).

## Credits & license

Curriculum and list membership come from [NeetCode](https://neetcode.io);
optional reference solutions and articles from
[neetcode-gh/leetcode](https://github.com/neetcode-gh/leetcode) (MIT).
LeetCode problem statements are fetched into your local cache and aren't distributed
with this repository. Demo statements are original illustrative fixtures.

Built with [Monaco Editor](https://github.com/microsoft/monaco-editor),
[Excalidraw](https://github.com/excalidraw/excalidraw), and
[FluidAudio](https://github.com/FluidInference/FluidAudio).

[MIT license](LICENSE).
