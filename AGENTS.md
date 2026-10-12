# Studio — Agent Instructions

<!-- This is the single source of truth for all AI coding agents. CLAUDE.md is a symlink to this file. -->
<!-- AGENTS.md spec: https://agents.md — supported by Claude Code, Cursor, Codex, Copilot, Gemini CLI, and others. -->

## What this is

A local-first interview practice environment. You solve LeetCode problems in your own
editor, against your own runner, with a coach (Codex CLI or Claude Code) that sees the whole session —
buffer, diff, test results, elapsed time — rather than a screenshot. It also runs full
system-design mock interviews on an Excalidraw whiteboard, with a voice mode where the
interviewer speaks and going quiet is what submits your answer.

The browser talks to a local Node server on `127.0.0.1`; there is no hosted Studio
backend or Studio account. The local Claude Code CLI subprocess uses its configured
authentication and online service, sending session context there. Speech recognition is
on-device with WhisperKit 0.18.0, reusing justwisper's selected cached model read-only
or downloading into Studio's own cache; speech output uses browser
`speechSynthesis`, whose voice behavior depends on browser/OS. LeetCode content fetches
and optional submissions also use the network. See `docs/PRIVACY.md` for the boundary.

No build step. `web/` is served as-is; anything the browser can't import bare (Monaco,
Excalidraw) is pre-bundled once by a vendoring script and the *output* is committed under
`web/vendor/`.

## Running it

```
npm start                 # server on 127.0.0.1:4173 (or $STUDIO_PORT)
npm test                  # node --test across server/**/*.test.mjs
npm run check             # headless-Chrome checks — layout, coach stream, shortcuts,
                           # toolbar, lanes, coach reload, run chip, find, design
```

Everything else in `package.json`'s `scripts` is a generator (`catalog`, `warm`,
`attempts`, `solutions`, `vendor:excalidraw`) — re-run the script rather than
hand-editing its output; see "Generated vs hand-written" below.

CI runs the Node unit/integration suite on macOS (`.github/workflows/ci.yml`). Before
calling anything done: `npm test`, then the
relevant `npm run check:*` (or the full `npm run check` if the change touches shared UI
like `web/js/dom.js`, `web/css/app.css`, or navigation), then a manual pass in an actual
browser for anything visual — type-checking and the test suite verify correctness, not
that a screen doesn't blink or an icon isn't misaligned.

## Layout

| Path | What it is | Owned by |
| --- | --- | --- |
| `server/` | The HTTP server: routes per feature (`coach/`, `design/`, `asr/`, …), each with its own `*.test.mjs` beside it | hand-written |
| `web/` | The client. No framework, no bundler — `web/js/*.js` are plain ES modules, `web/css/*.css` per screen | hand-written |
| `web/vendor/` | Monaco and Excalidraw, pre-bundled for a browser that has no CDN and no build step | generated, **committed** (see below) |
| `data/catalog.json`, `data/solutions-index.json` | Problem catalog and reference-solution index | generated, `scripts/extract-catalog.mjs` / `scripts/index-solutions.mjs` |
| `vendor/neetcode-solutions/` | Shallow clone of `neetcode-gh/leetcode` (MIT), reference solutions | generated, **gitignored** — re-clone before running anything that reads it |
| `extension/` | The Studio Connector browser extension (Manifest V3, no build step) that submits to LeetCode; see `docs/SUBMITTING.md` | hand-written |
| `docs/` | Architecture and protocol notes (`ARCHITECTURE.md`, `SUBMITTING.md`, `API-CONTRACT*.md`, `LEETCODE-API.md`) | hand-written, read before touching the judge/coach boundary |
| `asr/` | The on-device Swift transcriber (`studio-asr`) built against WhisperKit 0.18.0 | hand-written |

**Generated vs hand-written, the one rule that matters most:** if a path above says
"generated," never hand-edit it — fix the script that produces it and re-run the script.
This applies doubly inside `server/design/`: `turns.jsonl`, `scenes/*.json` and
`interview.json` are an append-only raw record of an interview that actually happened;
`interview.md` and any graph rendering are always *derived* from that record and must be
regenerated, never hand-patched — a rendering bug costs a regeneration, never a recording.

`/vendor/` (repo root, gitignored) and `web/vendor/` (committed) are two different things
with the same basename — do not conflate them. The root one is regenerated from a network
clone; the one under `web/` is regenerated from `npm run vendor:excalidraw` (Monaco is
vendored similarly — check `scripts/` for the exact command) and has no build step at
runtime, so it must be committed for the app to work at all.

## Non-negotiable constraints

These hold regardless of what a specific task asks for. If a request seems to require
violating one of these, stop and say so rather than finding a workaround.

- **Never `bypassPermissions` / `--dangerously-skip-permissions` for the coach subprocess.**
  The coach reads LeetCode's HTML problem descriptions and NeetCode's markdown articles —
  that content is untrusted input, never instruction, and permission scoping is the actual
  enforcement of that, not a formality.
- **The coach's Read/Write/Glob are scoped to `~/LeetCodeTutor/` only**, and even inside
  that root it must never write `meta.json`, `index.json`, `solution.py`, `attempts/`,
  `chats.jsonl`, `sessions/*.jsonl`, or — for the design-interview feature —
  `design/*/interview.json`, `design/*/turns.jsonl`, `design/*/scenes/**`,
  `design/*/interview.md`. Those are the server's raw record; the coach may only write
  `design/*/NOTES.md` and the top-level `DESIGN.md`. See `server/coach/claude-cli.mjs`'s
  `permissionArgs()` for the enforced allow/deny list.
- **The server binds `127.0.0.1` only, never `0.0.0.0`.** It executes arbitrary code
  (the coach subprocess, the local judge runner) — this is not a hardening nice-to-have.
- **Studio holds no LeetCode credentials.** Submissions use the browser's own sign-in
  through the Studio Connector extension. Never a cookie in a file, an env var, Keychain,
  a log line, or a server request.
- **One submission per explicit user action. No retry loops, no batching, ever.**
  Automating your own submissions at human pace is what every editor plugin does; a retry
  loop or a batch is the one thing that would plausibly look like abuse. See
  `docs/SUBMITTING.md` for the full design and `docs/API-CONTRACT-P2.md` Phase 4 for the three submission traps
  (internal `question_id` vs displayed number, `state: SUCCESS` ≠ accepted, auth failures
  arrive as HTML not JSON).
- **Reference solutions under `vendor/` are never executed** — read for comparison only.
- **The dashboard and any progress mirror must never fabricate a statistic.** A missing
  debrief, an empty board, or a silent answer is stated as such ("— said nothing —", "The
  board was empty") rather than smoothed over, defaulted, or left blank.
- **No automatic or concurrent bulk pre-fetching against LeetCode.** The app fetches
  lazily on open and caches content in `STUDIO_HOME/cache/leetcode/`. The existing
  `npm run warm` is a deliberate user-invoked, sequential preparation tool; preserve its
  delays, challenge/rate-limit stop behavior, and bounded network-error retries. Never
  run it automatically in startup, tests, CI, or documentation capture.

## Conventions worth knowing before you touch the UI

- **`replace()` in `web/js/dom.js` is atomic** (`node.replaceChildren(...)`) on purpose —
  it used to be `clear()` then `append()` as two separate mutations, which painted a blank
  frame on every re-render across the whole app. Do not reintroduce a two-step clear/fill.
- **Voice is a mode, not a toggle.** Typed input (text box + Send) and Voice mode (no text
  box — going quiet submits) are mutually exclusive, clearly-labeled modes in both the
  design-interview screen and the LeetCode coach panel, not a button glued onto one shared
  panel.
- **Streaming token filters must cut mid-token, not at line end.** Both the impersonation
  guard (`server/design/narration.mjs`) and the phase-tag stripper
  (`server/design/interview.mjs`'s `createTagStripper`) hold back a chunk the instant it
  *could* still become a label/tag opener, rather than waiting for a full line — by the
  time a full line has streamed to the browser (or been spoken aloud), it's too late to
  take it back.
- **Verify UI changes with real measurements, not eyeballing.** Pixel-alignment and
  layout-flash bugs in this codebase have been caught by driving a real headless Chrome
  over CDP (see `scripts/check-*.mjs`) and reading `getBoundingClientRect()`, not by
  visual inspection.

## Coach provider boundary

The coach header and Settings choose Codex CLI/Astra or Claude Code for new turns.
Dispatch lives in `server/coach/provider.mjs`. Keep native provider session identities
separate and preserve server-owned history when switching. Codex uses ephemeral
read-only app-server threads with tools disabled; it cannot write learner memory files.
Claude's existing tool/path restrictions above remain mandatory. Never silently switch
providers, use API billing, or label an unverified model as available to the account.

## LeetCode submissions

The browser submits, not the server. The **Studio Connector** extension (`extension/`)
sends one submission per click from a leetcode.com tab with the browser's own sign-in;
`POST /api/submit/record` only records the result. Read `docs/SUBMITTING.md` before
touching `extension/`, `web/js/leetcode-bridge.js`, `submitCode` in `web/js/api.js`,
`web/js/submit.js` or `server/judge/`.

- Never reintroduce server-side submission, cookie import, or Keychain storage. Cloudflare
  challenges non-browser clients even with valid cookies; that path was removed for that reason.
- Studio, the Connector and the LeetCode sign-in live in the same browser profile.
  Sign-in problems and Cloudflare checks are resolved there, never by copying cookies.
- Never automate a real submission in a check or test; use `?simsubmit=`, the panel tests in
  `web/tests.html`, or a fresh Chrome for Testing profile, where the Connector answers
  `SIGNED_OUT` without sending anything.
- After changing `extension/`, say that the extension must be reloaded in
  `chrome://extensions`; a running browser doesn't pick up changes on its own.
