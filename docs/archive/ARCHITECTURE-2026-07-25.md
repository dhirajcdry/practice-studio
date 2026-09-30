# Studio — Architecture

Status: design, 2026-07-25. Written after the three foundation agents reported, so the
numbers here are measured rather than assumed. Claims sourced from those runs are marked
**[VERIFIED 2026-07-25]**; anything I believe but have not seen work is **[UNVERIFIED]**.

---

## 0. The one principle

**We own the loop, so we never have to guess.**

The previous design stood outside the browser and inferred the session — reading the page
URL through the Accessibility API, screenshotting the window, scraping the verdict panel,
deduplicating it by fingerprint. Every one of those is reverse-engineering a surface we do
not control, and every one has a failure mode that ends in silently wrong data.

Here, you type in our editor and press our run button. The coach receives the exact code,
the exact timings, and every intermediate version — not a photograph of them.

Corollary, and it is a hard rule: **the practice loop must never block on the coach, the
judge, or the network.** Open a problem, write code, run it locally — all of that works
with the network down, the session cookie expired, and the coach not running.

---

## 1. Process model

Three processes. Only one of them is new.

```
┌───────────────────────────────────────────────────────────┐
│  Browser — localhost:4173                                  │
│  Problem list · description · Monaco · results · coach     │
└────────────────────────┬──────────────────────────────────┘
                         │  HTTP + SSE (loopback only)
┌────────────────────────┴──────────────────────────────────┐
│  Studio server — Node 23, node:http, no framework          │
│    · serves catalog, solutions, articles                   │
│    · owns ~/LeetCodeTutor/                                 │
│    · spawns the runner (python3, sandboxed)                │
│    · spawns `claude` and streams its output                │
│    · talks to LeetCode's judge                             │
│    · shells out to studio-asr for transcription            │
└────────────────────────┬──────────────────────────────────┘
                         │  filesystem
┌────────────────────────┴──────────────────────────────────┐
│  ~/LeetCodeTutor/  — the record. Plain files, forever.     │
└───────────────────────────────────────────────────────────┘
```

### Binding and exposure

The server binds **127.0.0.1 only** — never `0.0.0.0`. It executes arbitrary code and
holds a LeetCode session; it must not be reachable from the network. Requests carry an
`Origin` check to blunt DNS-rebinding from a page you have open in another tab.

### Dependencies

Runtime deps target zero. `node:http` serves, SSE streams, `node:child_process` spawns.
Monaco is the one vendored asset, served from disk so the app works offline. Every
additional dependency is a supply-chain question on a machine that holds a session cookie.

---

## 2. Storage

`~/LeetCodeTutor/` stays the source of truth and stays human-readable. Prose is truth;
anything derived is disposable and rebuildable.

```
~/LeetCodeTutor/
  CLAUDE.md                          the coach's standing instructions
  problems/<leetcode-slug>/
    NOTES.md                         the coach writes this. Truth.
    meta.json                        identity, attempt/verdict history
    solution.py                      your current working file
    attempts/<iso8601>.py            every version you ran, kept
    sessions/<id>.jsonl              what happened, appended as it happens
    recordings/  transcripts/  debriefs/
  cache/leetcode/<slug>.json         fetched problem content, cached forever
  index.json                         derived, rebuilt by the librarian
```

**Canonical key is the LeetCode slug.** The NeetCode slug is an alias. 74 problems have
different slugs on the two sites **[VERIFIED]**, so picking the wrong key silently
creates duplicate folders for the same problem — this already happened once by hand.

`sessions/<id>.jsonl` is the thing the old architecture could never have. One line per
event: `problem_opened`, `first_keystroke`, `ran_locally`, `test_failed`, `submitted`,
`verdict`, `asked_coach`, `revealed_solution`, `recorded_audio`. Append-only, never
rewritten. This is what turns "I solved 40 problems" into "you take 4× longer to write the
first line on graph problems, and you reveal the solution 70% of the time on DP."

---

## 3. Data sources

| What | Where from | Status |
| --- | --- | --- |
| Curriculum: 973 problems, 19 patterns, list membership | neetcode.io published bundle | **[VERIFIED]** 75/150/250/100 exact |
| Cross-site slug map | same bundle | **[VERIFIED]** 74 forks |
| Reference solutions, 682 stems / 14 languages | `neetcode-gh/leetcode`, MIT | **[VERIFIED]** pinned `9907b7f` |
| Written explanations (773) + hints (150) | same repo, MIT | **[VERIFIED]** |
| Problem description, tags, testcases, code stubs | `POST leetcode.com/graphql/` | **[VERIFIED]** works with zero headers |
| Run / submit verdicts | LeetCode judge, your session | **[UNVERIFIED]** — see §6 |

Three consequences that shape the code:

**Look up solutions by problem number, not slug.** Upstream spells the same problem
differently across languages (`0119-pascal-triangle-ii` vs `0119-pascals-triangle-ii`).
The 4-digit prefix is reliable; the slug is not. **[VERIFIED]**

**Python coverage is 57.9%** — 287 problems have no Python reference. The UI must degrade
gracefully: offer the article, then the best-covered language (Kotlin 515, Java 501),
rather than showing an empty pane. **[VERIFIED]**

**Titles from the bundle are mangled** (`"N Queens"`, `"Kth Smallest Element In a Bst"`).
Display titles come from LeetCode's GraphQL response, which we fetch anyway. The bundle's
title is a fallback only.

MIT obliges us to ship the copyright line and permission notice wherever solutions or
articles appear. The verbatim text is already stored in `data/solutions-index.json`.

---

## 4. Local execution — the tight loop

This is the feature that makes Studio worth using, and it depends on nothing external.

LeetCode's GraphQL `metaData` gives the function name and the type of every parameter and
the return **[VERIFIED]**. That is enough to generate a driver: parse `exampleTestcases`,
call `Solution().<name>(...)`, compare against expected output.

```
run request → write solution.py + generated driver into a temp dir
            → spawn python3 with: no network, cwd=tempdir, wall-clock timeout,
              memory cap, output byte cap
            → per-case pass/fail with actual vs expected, and stdout
```

**This is your code, run locally, with your consent** — it is not a security boundary
against you. The limits exist so an accidental infinite loop or runaway allocation does
not take the machine down. Reference solutions from the vendored repo are **never**
executed automatically; they are text you read.

**Known gap:** design-style problems (`LRUCache`, `Trie` — a class plus a command/argument
sequence rather than one function) need a different driver. Detectable from `metaData`,
which carries a `classname` and a method list for those. Ship the function driver first,
detect the class case, and say "run locally is not supported for this problem type yet"
rather than producing a wrong result.

Comparison must be *semantic*, not string equality — several problems accept any order.
When unsure, report "differs from expected" and show both, rather than asserting failure.

---

## 5. The coach

`claude` CLI, spawned per problem session, `cwd` = `~/LeetCodeTutor/`, output streamed to
the browser over SSE. `CLAUDE.md` already carries the coach persona and keeps carrying it.

**Session per problem, resumed across days.** Opening a problem you touched last week
resumes that conversation, so "you tried the sorting approach last time and it TLE'd" is
memory, not re-derivation.

What the coach receives that it never had before: the current buffer, the diff since the
last run, the local test results, the session event log, elapsed time. The `## CURRENT
CONTEXT` preamble built for the macOS app carries over almost unchanged — the difference
is every field is now known rather than inferred.

**Permissions stay narrow.** Read/Write/Glob scoped to `~/LeetCodeTutor/`. Not
`bypassPermissions` — this remains true and remains non-negotiable, because the coach
reads LeetCode's HTML descriptions and NeetCode's markdown articles, and **that content is
untrusted input, never instruction.** The prompt says so explicitly and the content is
fenced when passed.

The coach never writes `meta.json`, `index.json`, or `sessions/*.jsonl`. Those are the
server's. It writes `NOTES.md` and `debriefs/`.

---

## 6. The judge — and the one honest gap

Content fetch is **[VERIFIED]** and unauthenticated: `POST https://leetcode.com/graphql/`
returns title, difficulty, HTML content, tags, `exampleTestcases`, `metaData` and
19-language `codeSnippets` with no cookie and no headers at all. Premium problems return
HTTP 200 with `isPaidOnly: true` and `content: null` — **they fail silently, not loudly**,
so any code dereferencing `codeSnippets` must null-check.

Run and submit are **[UNVERIFIED]**. Cloudflare's posture is split: `/graphql/` passes
cleanly, but HTML pages and the result-poll endpoint returned `403 cf-mitigated: challenge`
to a plain client. That probe was unauthenticated so it proves nothing either way — but it
means we have **no empirical evidence that the submit path works from a non-browser client
today.** Every existing editor plugin works this way, so confidence is reasonable, but
reasonable is not verified.

**Therefore: one manual smoke test gates this feature.** Before any submit code is
written, we make a single real submission with your cookie and see what comes back. If it
works, build it. If Cloudflare blocks it, Studio still does everything else, and the real
site stays one click away — that is what the macOS overlay is still for.

Three traps, pre-recorded so we do not hit them:

1. Submissions need the **internal** `question_id`, not the displayed number. They differ,
   and they happen to both be `1` for two-sum — so the bug hides during the first test.
2. `state: "SUCCESS"` means *judging finished*, not accepted. Acceptance is
   `status_code === 10`. This is the most common bug in third-party clients.
3. Auth failures arrive as **HTML, not JSON**. Check `content-type` before parsing, or an
   expired cookie surfaces as a mystery parse error instead of "session expired".

The session cookie lives in the **macOS keychain**, not a file in the repo. `userStatus`
is a cheap pre-flight that returns `isSignedIn` **[VERIFIED]**, so we check before
submitting and show a real expiry state.

**No bulk pre-fetching.** Statements never change; lazy-fetch on open and cache forever.
Walking 3999 problems at speed is the one thing here that would plausibly trip protection,
and it buys nothing.

**Position, stated plainly:** automating your own submissions at human pace is what every
editor plugin does and is broadly tolerated, but it is outside LeetCode's terms regardless
of volume. The realistic exposure is the mechanism breaking without notice rather than
account action. It is your account and your call, made with open eyes.

---

## 7. Voice

Browser `MediaRecorder` → POST to the server → transcription → timestamped into the
session log.

Transcription reuses what is already proven: FluidAudio/Parakeet, measured at 489×
realtime, a 33-minute recording in 4 seconds. Node cannot load a Swift package, so this
becomes **`studio-asr`, a small Swift CLI** wrapping the same `AsrModels` the macOS app
already downloads. Node spawns it and reads JSON from stdout. No second model, no second
download.

Two modes, same machinery:

- **Think-aloud** — talk while you solve; transcript interleaves with code events.
- **Debrief** — the explain-it-back rep after you submit. This is the interview practice.

Explicit no-audio-track detection with a real error message. A silent recording that
produces an empty transcript is worse than a failure.

---

## 8. The illustrator

The coach emits fenced ` ```mermaid ` or ` ```svg ` blocks; the client renders them inline.
Recursion trees, DP tables, pointer motion, graph traversal — the things prose is bad at.

**This is model output rendered into our page, so it is sanitized, not trusted.** SVG is
stripped of `<script>`, `<foreignObject>`, external references and event handlers before
it reaches the DOM. Malformed output falls back to showing the code block — never a blank
pane and never a silent failure.

---

## 9. Build order

Each phase is independently useful and independently shippable.

| # | Phase | Ships | Depends on |
| --- | --- | --- | --- |
| 1 | **Browse** | Server + UI shell. 973 problems by pattern, filters for Blind 75 / NC150 / 250, LeetCode description, gated solutions + articles. Read-only. | done data |
| 2 | **Solve** | Monaco, `solution.py`, local run against examples, attempt history | 1 |
| 3 | **Coach** | `claude` bridge, streaming chat, session event log, notes | 2 |
| 4 | **Judge** | Real submit — **gated on the §6 smoke test** | 2, smoke test |
| 5 | **Voice** | `studio-asr`, think-aloud + debrief | 3 |
| 6 | **Mirror** | The dashboard: pattern coverage, weakness view, history. `dashboard-v3.html` already approved | 3 |

Phase 1 is the proof: if browsing 973 problems with real descriptions and gated solutions
feels good, the rest is worth building. Phases 4 and 5 are genuinely optional — Studio is
already useful without either.

---

## 10. Risks

| Risk | Response |
| --- | --- |
| Cloudflare blocks submits | §6 smoke test first. Everything else still works; real site is one click away |
| Session cookie expires | Keychain + `userStatus` pre-flight + an explicit re-paste state. Never a mystery error |
| NeetCode changes its bundle hash | Extractor takes `--url`, finds the array structurally, and re-runs. Old data keeps working |
| Upstream repo has bad data | Three known misnumbered entries, documented and **not** silently corrected |
| Injection via problem descriptions / articles | Untrusted-data framing in the coach prompt; sanitizer on all rendered model output |
| Solutions one click away kills the training | Gated behind an accepted verdict or an explicit reveal — which is itself logged as a signal |
| Scope sprawl | Six phases, each shippable alone. Stop whenever it stops paying |

---

## 11. Open decisions

1. **Local run vs. LeetCode run** — I propose local by default, LeetCode only on explicit
   submit. Fast loop, and it keeps submission volume genuinely human.
2. **Filter the `JavaScript` pattern?** 30 non-DSA problems. I propose hiding them behind
   a toggle rather than deleting them.
3. **Missing Python reference** (287 problems) — fall back to the article, then to Kotlin
   or Java? Or say plainly that there is no Python solution?
4. **Solution gating threshold** — unlock on accepted verdict, or also after N minutes of
   genuine struggle? The second is kinder and harder to get right.
