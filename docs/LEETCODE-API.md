# LeetCode API Reference (for a local, single-user practice app)

Research date: **2026-07-25**. Probes run from a US residential-ish IP over plain `curl/HTTP2`.

## How to read this document

Every factual claim carries one of two tags. Nothing is left ambiguous.

- **[VERIFIED 2026-07-25]** — I executed this request during this research session and observed the result. Evidence is inline.
- **[UNVERIFIED]** — From prior knowledge or a named public source. I did **not** execute it. Confidence is stated explicitly.

**No code was submitted or run against LeetCode's judge during this research, and no authentication was attempted.** Everything in Part 2 (run/submit) is therefore `[UNVERIFIED]` by construction. That is the part most likely to have drifted, and the part you should smoke-test manually before trusting.

Total network activity: 11 anonymous requests, spaced with sleeps.

---

# Part 1 — Content fetch (anonymous)

## 1.1 The endpoint works anonymously

**[VERIFIED 2026-07-25]** `POST https://leetcode.com/graphql/` serves full problem content with **no cookies, no CSRF token, no session, and no headers beyond `Content-Type: application/json`**.

Header-sensitivity matrix, all returning `HTTP 200` with valid data:

| Variant | Result |
|---|---|
| `Content-Type` only — no `User-Agent`, no `Referer` | **[VERIFIED]** `200`, `{"data":{"question":{"questionId":"1","title":"Two Sum"}}}` |
| `/graphql` (no trailing slash) | **[VERIFIED]** `200`, identical body |
| `/graphql/` + browser `User-Agent`, no `Referer` | **[VERIFIED]** `200`, identical body |
| `/graphql/` + `User-Agent` + `Referer` | **[VERIFIED]** `200`, identical body |

Both `/graphql` and `/graphql/` work. Use the trailing-slash form; it is what the site itself uses and is less likely to pick up a redirect later.

> **Important asymmetry — see §4.1.** The GraphQL endpoint passed Cloudflare unchallenged, but **HTML page GETs did not**. `GET https://leetcode.com/problems/two-sum/` with the same browser `User-Agent` returned **`HTTP 403` with `cf-mitigated: challenge`** **[VERIFIED 2026-07-25]**. Do not build anything that scrapes HTML pages or that expects to obtain cookies by fetching a page.

Send `Referer` and a real browser `User-Agent` anyway. They are not required today, they are free, and they make your traffic indistinguishable from the browser if the posture tightens.

## 1.2 The working query

**[VERIFIED 2026-07-25]** This exact query text returned every requested field for `two-sum`. Copy it verbatim.

```graphql
query questionData($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    questionId
    questionFrontendId
    title
    titleSlug
    content
    difficulty
    isPaidOnly
    likes
    dislikes
    categoryTitle
    stats
    hints
    exampleTestcases
    sampleTestCase
    metaData
    topicTags { name slug }
    codeSnippets { lang langSlug code }
  }
}
```

Exact request:

```http
POST /graphql/ HTTP/2
Host: leetcode.com
Content-Type: application/json
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36
Referer: https://leetcode.com/problems/two-sum/

{"operationName":"questionData",
 "variables":{"titleSlug":"two-sum"},
 "query":"query questionData($titleSlug: String!) { question(titleSlug: $titleSlug) { questionId questionFrontendId title titleSlug content difficulty isPaidOnly likes dislikes categoryTitle stats hints exampleTestcases sampleTestCase metaData topicTags { name slug } codeSnippets { lang langSlug code } } }"}
```

`operationName` is optional — a bare `{"query":..., "variables":...}` worked identically **[VERIFIED]**.

## 1.3 Real response (trimmed, `two-sum`)

**[VERIFIED 2026-07-25]** `HTTP 200`, 6017 bytes. All 17 requested keys present.

```json
{
  "data": {
    "question": {
      "questionId": "1",
      "questionFrontendId": "1",
      "title": "Two Sum",
      "titleSlug": "two-sum",
      "content": "<p>Given an array of integers <code>nums</code>&nbsp;and an integer <code>target</code>, return <em>indices of the two numbers such that they add up to <code>target</code></em>.</p>\n\n<p>You may assume that each input would have <strong><em>exactly</em> one solution</strong>...</p>\n\n<p><strong class=\"example\">Example 1:</strong></p>\n\n<pre>\n<strong>Input:</strong> nums = [2,7,11,15], target = 9\n<strong>Output:</strong> [0,1]\n<strong>Explanation:</strong> Because nums[0] + nums[1] == 9, we return [0, 1].\n</pre>\n\n<p><strong>Constraints:</strong></p>\n\n<ul>\n\t<li><code>2 &lt;= nums.length &lt;= 10<sup>4</sup></code></li>\n</ul>",
      "difficulty": "Easy",
      "isPaidOnly": false,
      "categoryTitle": "Algorithms",
      "stats": "{\"totalAccepted\": \"22.7M\", \"totalSubmission\": \"39.3M\", \"totalAcceptedRaw\": 22731328, \"totalSubmissionRaw\": 39280204, \"acRate\": \"57.9%\"}",
      "hints": ["A really brute force way would be to search for all possible pairs of numbers but that would be too slow. ..."],
      "exampleTestcases": "[2,7,11,15]\n9\n[3,2,4]\n6\n[3,3]\n6",
      "sampleTestCase": "[2,7,11,15]\n9",
      "metaData": "{\n  \"name\": \"twoSum\",\n  \"params\": [\n    {\"name\": \"nums\", \"type\": \"integer[]\"},\n    {\"name\": \"target\", \"type\": \"integer\"}\n  ],\n  \"return\": {\"type\": \"integer[]\", \"size\": 2},\n  \"manual\": false\n}",
      "topicTags": [
        {"name": "Array", "slug": "array"},
        {"name": "Hash Table", "slug": "hash-table"}
      ],
      "codeSnippets": [
        {"lang": "Python3", "langSlug": "python3",
         "code": "class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        "}
      ]
    }
  }
}
```

### Field notes

| Field | Type | Notes |
|---|---|---|
| `questionId` | string | **Internal** id. This is what the submit endpoint wants. **[VERIFIED]** |
| `questionFrontendId` | string | The **displayed** problem number. For `two-sum` both are `"1"`, but they diverge on newer problems — see §1.6. **[VERIFIED]** |
| `content` | HTML string | Full description incl. Examples and Constraints. `null` for premium. **[VERIFIED]** |
| `difficulty` | string | `"Easy"` / `"Medium"` / `"Hard"`. **[VERIFIED]** |
| `stats` | **JSON-encoded string** | Must be `JSON.parse`d again. **[VERIFIED]** |
| `metaData` | **JSON-encoded string** | Function name, param types, return type. Must be parsed again. **[VERIFIED]** |
| `hints` | array of HTML strings | May be `[]`. **[VERIFIED]** |
| `exampleTestcases` | string | **All** sample cases, newline-separated, one line per argument. **[VERIFIED]** |
| `sampleTestCase` | string | Only the **first** case. **[VERIFIED]** |
| `topicTags` | array | **[VERIFIED]** |
| `codeSnippets` | array | `null` for premium. **[VERIFIED]** |

**The `exampleTestcases` format is the key detail for Part 2.** It is exactly the string you feed back as `data_input` to the run endpoint. Arguments are newline-separated in declaration order, and consecutive test cases are simply concatenated. For `two-sum`, `"[2,7,11,15]\n9\n[3,2,4]\n6\n[3,3]\n6"` is 3 cases × 2 args. To split it into individual cases you must know the arity from `metaData.params.length` — there is no delimiter between cases. **[VERIFIED — format observed; arity-splitting rule is the standard interpretation, high confidence]**

### Available languages

**[VERIFIED 2026-07-25]** `codeSnippets[].langSlug` for `two-sum`, in response order:

```
cpp, java, python3, python, javascript, typescript, csharp, c,
golang, kotlin, swift, rust, ruby, php, dart, scala, elixir, erlang, racket
```

`langSlug` is the value you pass as `lang` when running/submitting. **[UNVERIFIED — high confidence;** consistent across every public client and matches the site's own payloads.**]**

## 1.4 Second probe — `valid-parentheses`

**[VERIFIED 2026-07-25]** `HTTP 200`, no errors. Confirms the query generalizes.

```json
{"questionId":"20","questionFrontendId":"20","title":"Valid Parentheses",
 "difficulty":"Easy","isPaidOnly":false,
 "exampleTestcases":"\"()\"\n\"()[]{}\"\n\"(]\"\n\"([])\"\n\"([)]\"",
 "sampleTestCase":"\"()\"",
 "topicTags":[{"name":"String","slug":"string"},{"name":"Stack","slug":"stack"}]}
```

Note string arguments are **JSON-quoted inside** the testcase string — `"()"` not `()`. Preserve bytes exactly; do not unquote.

## 1.5 Premium problems — `meeting-rooms`

**[VERIFIED 2026-07-25]** `HTTP 200`, **no GraphQL `errors` array**. The request succeeds; specific fields are silently `null`.

```json
{"questionId":"252","questionFrontendId":"252","title":"Meeting Rooms",
 "difficulty":"Easy","isPaidOnly":true,
 "content":null,
 "exampleTestcases":"[[0,30],[5,10],[15,20]]\n[[7,10],[2,4]]",
 "sampleTestCase":"[[0,30],[5,10],[15,20]]",
 "topicTags":[{"name":"Array","slug":"array"},{"name":"Sorting","slug":"sorting"}],
 "codeSnippets":null}
```

**Implementer rules:**
- Detect premium with `isPaidOnly === true`. Do **not** infer it from a failed request — the request succeeds.
- `content` and `codeSnippets` are `null`. Anything that dereferences `codeSnippets` will throw. Guard it.
- `title`, `difficulty`, `topicTags`, `exampleTestcases`, `sampleTestCase` **are** available anonymously even for premium. You can build a full catalog including premium problems; you just can't show the description or a starter stub.
- **[UNVERIFIED — moderate confidence]** With a premium account's `LEETCODE_SESSION` cookie these fields populate normally. Not tested (no credentials).

## 1.6 Problem catalog / slug list

**[VERIFIED 2026-07-25]** `GET https://leetcode.com/api/problems/all/` works anonymously. `HTTP 200`, ~2.06 MB, `num_total: 3999`.

```json
{
  "user_name": "",
  "num_solved": 0, "num_total": 3999,
  "ac_easy": 0, "ac_medium": 0, "ac_hard": 0,
  "stat_status_pairs": [
    {"stat": {"question_id": 4369,
              "question__title": "Even Number of Knight Moves",
              "question__title_slug": "even-number-of-knight-moves",
              "total_acs": 42135, "total_submitted": 56457,
              "frontend_question_id": 3996,
              "question__hide": false, "is_new_question": false},
     "status": null,
     "difficulty": {"level": 1},
     "paid_only": true}
  ],
  "category_slug": ""
}
```

This one endpoint gives you the whole slug catalog in a single request — much better than paginating GraphQL. Notes:

- **`question_id` (4369) ≠ `frontend_question_id` (3996).** **[VERIFIED]** This is the trap in §2.2: submissions need the **internal** id. Never send the displayed number.
- `difficulty.level` is `1|2|3` = Easy|Medium|Hard. **[UNVERIFIED — high confidence;** universal convention across clients, and `level: 1` on an Easy problem is consistent with the observed row.**]**
- `status` is `null` anonymously; with a session it becomes `"ac"` / `"notac"` / `null`. **[UNVERIFIED — moderate confidence]**
- `user_name: ""` and `num_solved: 0` are the anonymous tell.
- **[UNVERIFIED — low/moderate confidence]** This is a legacy endpoint that has been "about to be removed" for years. It works today; keep a GraphQL `problemsetQuestionList` fallback in mind. I did not test that fallback.

---

# Part 2 — Run and Submit

> **Everything in this section is `[UNVERIFIED]`.** I did not authenticate and did not submit code, per the constraints. Sources are named per claim. These endpoints have been stable for roughly a decade across many independent clients, which is why confidence is high — but "stable for a decade" is not "I saw it work today". **Smoke-test the first submission by hand and compare against what's written here.**

## 2.1 The two endpoints

**[UNVERIFIED — high confidence]** Source: [`skygragon/leetcode-cli` `lib/config.js`](https://github.com/skygragon/leetcode-cli/blob/master/lib/config.js), fetched this session, quoted verbatim:

```javascript
urls: {
  base:        'https://leetcode.com',
  graphql:     'https://leetcode.com/graphql',
  problems:    'https://leetcode.com/api/problems/$category/',
  problem:     'https://leetcode.com/problems/$slug/description/',
  test:        'https://leetcode.com/problems/$slug/interpret_solution/',
  submit:      'https://leetcode.com/problems/$slug/submit/',
  submissions: 'https://leetcode.com/api/submissions/$slug',
  submission:  'https://leetcode.com/submissions/detail/$id/',
  verify:      'https://leetcode.com/submissions/detail/$id/check/'
}
```

| Action | Method + URL |
|---|---|
| **Run** against test cases | `POST https://leetcode.com/problems/{slug}/interpret_solution/` |
| **Submit** to the judge | `POST https://leetcode.com/problems/{slug}/submit/` |
| **Poll** either one | `GET https://leetcode.com/submissions/detail/{id}/check/` |

The **same** `/check/` endpoint polls both run and submit results; only the id differs (§2.4).

**[VERIFIED 2026-07-25]** `GET https://leetcode.com/submissions/detail/1/check/` unauthenticated returns **`HTTP 403` with header `cf-mitigated: challenge`** and an HTML Cloudflare interstitial (5825 bytes, `content-type: text/html`), **not** JSON. So: the path exists and is protected, but an anonymous probe cannot distinguish "wrong endpoint" from "not logged in" — both look like a Cloudflare 403. See §4.2, this matters for error handling.

## 2.2 Request bodies

**[UNVERIFIED — high confidence]** Source: `skygragon/leetcode-cli` `lib/plugins/leetcode.js`, fetched this session. The shared base body from `runCode()`:

```javascript
{
  lang:        problem.lang,                  // langSlug, e.g. "python3"
  question_id: parseInt(problem.id, 10),      // INTERNAL questionId, as a NUMBER
  test_mode:   false,
  typed_code:  file.data(problem.file)        // full source text
}
```

**Run** adds `data_input`:

```javascript
opts.body = {data_input: problem.testcase};
```

**Submit** adds `judge_type`:

```javascript
opts.body = {judge_type: 'large'};
```

Concretely:

```jsonc
// POST /problems/two-sum/interpret_solution/
{
  "lang": "python3",
  "question_id": 1,
  "test_mode": false,
  "typed_code": "class Solution:\n    def twoSum(self, nums, target):\n        ...",
  "data_input": "[2,7,11,15]\n9\n[3,2,4]\n6\n[3,3]\n6"
}
```

```jsonc
// POST /problems/two-sum/submit/
{
  "lang": "python3",
  "question_id": 1,
  "test_mode": false,
  "typed_code": "class Solution:\n    def twoSum(self, nums, target):\n        ...",
  "judge_type": "large"
}
```

**Gotchas:**
- `question_id` is the **internal** `questionId` from GraphQL / `question_id` from `/api/problems/all/`, **not** `questionFrontendId`. **[VERIFIED that these differ (§1.6); UNVERIFIED which one the endpoint wants — high confidence it's the internal one, all clients agree]**
- Some clients send `question_id` as a string. `leetcode-cli` parses it to an int. **[UNVERIFIED — the endpoint most likely accepts either; low confidence on that leniency]**
- `data_input` should be the `exampleTestcases` string byte-for-byte, or the user's edited version in the same format.
- `typed_code` must be the complete file including the `class Solution` wrapper.

## 2.3 Headers and cookies

**[UNVERIFIED — high confidence]** Source: `skygragon/leetcode-cli` `lib/plugins/leetcode.js`, quoted verbatim:

```javascript
opts.headers.Origin = config.sys.urls.base;          // https://leetcode.com
opts.headers.Referer = problem.link;                 // https://leetcode.com/problems/<slug>/
opts.headers['X-CSRFToken'] = user.sessionCSRF;
opts.headers['X-Requested-With'] = 'XMLHttpRequest';
```

Corroborated independently by [`kaiwk/leetcode.el`](https://github.com/kaiwk/leetcode.el) (sets `X-CSRFToken` and problem-URL `Referer`) **[UNVERIFIED — fetched this session]**.

Full header set for run/submit:

```http
POST /problems/two-sum/submit/ HTTP/2
Host: leetcode.com
Content-Type: application/json
Origin: https://leetcode.com
Referer: https://leetcode.com/problems/two-sum/
X-CSRFToken: <value of csrftoken cookie>
X-Requested-With: XMLHttpRequest
User-Agent: <a real, current browser UA>
Cookie: LEETCODE_SESSION=<...>; csrftoken=<...>
```

**Non-negotiable:**
- **`Referer` must be the problem's own URL**, not `https://leetcode.com/`. This is Django CSRF referer-checking on HTTPS; a wrong or missing `Referer` yields `403 CSRF verification failed`. **[UNVERIFIED — high confidence; this is standard Django behavior and every client sets it]**
- **`X-CSRFToken` must equal the `csrftoken` cookie value**, sent on the *same* request. Django compares header to cookie. **[UNVERIFIED — high confidence]**
- `Origin` and `X-Requested-With` are set by all clients. Send them.

## 2.4 Response to run/submit

**[UNVERIFIED — high confidence]** Both return `HTTP 200` with a small JSON body containing only an id.

```jsonc
// interpret_solution/ response
{"interpret_id": "runcode_1721928000.123456_AbCdEfGh", "test_case": "..."}

// submit/ response
{"submission_id": 1234567890}
```

`leetcode.el` reads `interpret_id` from the run response **[UNVERIFIED — confirmed in that source this session]**; `leetcode-cli` and DeepWiki's write-up of `wklee610/leetcode-cli` confirm `submission_id` from submit **[UNVERIFIED]**.

Then poll `GET /submissions/detail/{id}/check/` where `{id}` is `interpret_id` for a run and `submission_id` for a submit. Same `Referer` / `X-CSRFToken` / cookie headers apply. **[UNVERIFIED — high confidence]**

## 2.5 Poll-until-done protocol

**[UNVERIFIED — high confidence]** Source: `leetcode.el` polls on a `state` field with a `pcase` over `"PENDING"`, `"STARTED"`, `"SUCCESS"`; `leetcode-cli` requeues the task until `result.state === 'SUCCESS'`.

State machine:

| `state` | Meaning | Action |
|---|---|---|
| `"PENDING"` | Queued, not started | keep polling |
| `"STARTED"` | Judge is running it | keep polling |
| `"SUCCESS"` | **Judging finished** — read `status_code` for the verdict | stop |
| `"FAILURE"` | Judge-side failure | stop, surface as an infra error **[UNVERIFIED — lower confidence, rarely seen]** |

**`state: "SUCCESS"` means "the judging pipeline completed", NOT "the code was accepted."** Acceptance is `status_code === 10`. Conflating these is the single most common bug in third-party clients.

**Polling cadence.** `leetcode.el` sleeps 0.2 s between polls **[UNVERIFIED — observed in source]**; DeepWiki reports `wklee610/leetcode-cli` hardcodes a 10 s delay before the first check **[UNVERIFIED]**. For a human-paced local app: wait ~1 s, then poll every ~1 s, with a hard timeout of ~30 s for runs and ~60 s for submits. Do not poll at 0.2 s — it buys nothing and looks like a bot.

Interim polls return a minimal body, roughly `{"state":"PENDING"}` — **all result fields are absent, not null**. Guard every field access. **[UNVERIFIED — moderate confidence]**

## 2.6 Terminal verdicts

**[UNVERIFIED — high confidence on the codes, moderate on exact per-verdict field presence]** Codes cross-confirmed by `leetcode.el` (`pcase` over 10, 11, 12, 13, 14, 15, 20) and the DeepWiki table.

| `status_code` | `status_msg` |
|---|---|
| 10 | `Accepted` |
| 11 | `Wrong Answer` |
| 12 | `Memory Limit Exceeded` |
| 13 | `Output Limit Exceeded` |
| 14 | `Time Limit Exceeded` |
| 15 | `Runtime Error` |
| 20 | `Compile Error` |
| 21 | `Unknown Error` |
| 30 | `Timeout` (judge-side, not your code) |

Codes 12/13 are inferred from the `pcase` set and universal convention **[UNVERIFIED — moderate confidence]**. 21/30 are from prior knowledge only **[UNVERIFIED — low confidence]**. Always fall back to displaying `status_msg` verbatim rather than switching solely on the integer.

### Fields by verdict

All field names below are those `leetcode.el` reads from the `/check/` response **[UNVERIFIED — confirmed present in that source this session; per-verdict presence is my inference]**.

**Accepted (10) — submit:**
```jsonc
{
  "state": "SUCCESS",
  "status_code": 10,
  "status_msg": "Accepted",
  "run_success": true,
  "total_correct": 57,
  "total_testcases": 57,
  "status_runtime": "52 ms",
  "runtime_percentile": 94.32,
  "status_memory": "17.2 MB",
  "memory_percentile": 61.05,
  "lang": "python3",
  "pretty_lang": "Python3",
  "submission_id": "1234567890"
}
```
→ Runtime/memory: `status_runtime`, `status_memory` (**display strings with units**). Percentiles: `runtime_percentile`, `memory_percentile` (floats 0–100, **submit only** — a run does not produce them).

**Wrong Answer (11):**
```jsonc
{
  "state": "SUCCESS", "status_code": 11, "status_msg": "Wrong Answer",
  "run_success": true,
  "total_correct": 34, "total_testcases": 57,
  "input": "[3,2,4]\n6",
  "last_testcase": "[3,2,4]\n6",
  "code_output": "[0,1]",
  "expected_output": "[1,2]",
  "std_output": ""
}
```
→ **The failing test case is `last_testcase` (or `input`); yours vs. correct is `code_output` vs. `expected_output`.** `total_correct`/`total_testcases` gives "34/57 passed". `std_output` holds anything the code printed.

For a **run** (`interpret_solution`), `code_output` is an **array** of outputs, one per input case, while for a **submit** it is a **string** for the single failing case. Type-check before rendering. **[UNVERIFIED — moderate confidence; a well-known inconsistency]**

**Time Limit Exceeded (14) / Memory Limit Exceeded (12):**
```jsonc
{"state":"SUCCESS","status_code":14,"status_msg":"Time Limit Exceeded",
 "run_success": true,
 "total_correct": 51, "total_testcases": 57,
 "last_testcase": "[...large input...]",
 "status_runtime": "N/A", "status_memory": "N/A"}
```
→ `last_testcase` is the input it choked on. `run_success` stays `true` (the code ran, it was just too slow/big). Runtime/memory are typically `"N/A"`.

**Runtime Error (15):**
```jsonc
{"state":"SUCCESS","status_code":15,"status_msg":"Runtime Error",
 "run_success": false,
 "runtime_error": "IndexError: list index out of range",
 "full_runtime_error": "IndexError: list index out of range\n    ...traceback...\nLine 5 in twoSum (Solution.py)",
 "last_testcase": "[3,3]\n6",
 "total_correct": 12, "total_testcases": 57}
```
→ **`full_runtime_error` is the one to show** (includes traceback and line numbers); `runtime_error` is the one-line summary. `run_success` is `false`.

**Compile Error (20):**
```jsonc
{"state":"SUCCESS","status_code":20,"status_msg":"Compile Error",
 "run_success": false,
 "compile_error": "Line 5: error: ';' expected",
 "full_compile_error": "Line 5: error: ';' expected\n        return ans\n                  ^\n1 error"
}
```
→ **`full_compile_error`** is the detailed one. No `total_correct` / `total_testcases` — nothing ran. Guard for their absence.

**Renderer rule:** branch on `run_success` first (`false` → show `full_compile_error || full_runtime_error`), then on `status_code`. Never assume `total_testcases` exists.

---

# Part 3 — Auth model

## 3.1 The two cookies

**[UNVERIFIED — high confidence]** Only two cookies matter:

| Cookie | Purpose |
|---|---|
| `LEETCODE_SESSION` | The session. A JWT. Identifies the user. |
| `csrftoken` | Django CSRF token. Must be sent **both** as a cookie **and** as the `X-CSRFToken` header. |

Nothing else (`__cf_bm`, `_gid`, `gr_user_id`, …) is needed. Sending extra cookies is harmless.

## 3.2 How the user obtains them

**[UNVERIFIED — high confidence]** The user does this by hand, once, in their own browser:

1. Log in to `leetcode.com` normally.
2. DevTools → **Application** → **Storage** → **Cookies** → `https://leetcode.com`.
3. Copy the **Value** of `LEETCODE_SESSION` and of `csrftoken`.
4. Paste both into the app's settings.

**[VERIFIED 2026-07-25]** There is no programmatic alternative worth attempting: `GET https://leetcode.com/problems/two-sum/` returns `403 cf-mitigated: challenge` to a non-browser client, so **the app cannot fetch a page to bootstrap a `csrftoken` cookie**. It must be supplied. (Also, per the constraints: do not automate login. LeetCode login involves Cloudflare Turnstile and automating it is exactly what gets accounts flagged.)

Store them in the OS keychain, not in a plaintext config file or anything git-tracked.

## 3.3 Lifetime

**[UNVERIFIED — moderate confidence]** `LEETCODE_SESSION` is a JWT with an expiry typically around **two weeks**, refreshed by browser activity. The app's copy does **not** get refreshed by the site's normal rotation, so expect the user to re-paste roughly every 1–2 weeks, and sooner if they log out anywhere (logging out invalidates the session server-side) or change their password.

**[UNVERIFIED — moderate confidence, and worth exploiting]** `LEETCODE_SESSION` is a standard JWT: base64-decode the middle segment and read the `exp` claim to **display the expiry date and warn before it lapses, without any network call**. Decode locally, never verify or trust it for anything security-relevant — it is a display hint only.

## 3.4 Detecting expiry — build this

**[VERIFIED 2026-07-25]** The cheapest, most reliable session check is a GraphQL `userStatus` query. Anonymous response, observed:

```json
{"data":{"userStatus":{"userId":null,"isSignedIn":false,"isPremium":null,"username":""}}}
```

Request (returns `HTTP 200` either way):

```jsonc
POST https://leetcode.com/graphql/
Content-Type: application/json
Cookie: LEETCODE_SESSION=<...>; csrftoken=<...>

{"operationName":"globalData","variables":{},
 "query":"query globalData { userStatus { userId isSignedIn isPremium username } }"}
```

**Implementation:** call this on app start and before any submit. `data.userStatus.isSignedIn === false` ⇒ show **"LeetCode session expired — paste a fresh cookie"**. With a valid session it returns the real `userId` / `username` / `isPremium` **[UNVERIFIED — not tested, no credentials; high confidence]**.

This is far better than inferring expiry from a failed submit, because:

**[VERIFIED 2026-07-25]** an unauthenticated request to a protected path (`/submissions/detail/1/check/`) returns a **Cloudflare `403` HTML page** (`cf-mitigated: challenge`, `content-type: text/html`), **not** a JSON auth error. An app that only parses JSON will see a parse failure and report a mystery error. **[UNVERIFIED — moderate confidence]** With an *expired* (rather than absent) session you are more likely to get a Django `403 Forbidden` with `{"detail": "Authentication credentials were not provided."}`, or a `302` redirect to `/accounts/login/`. Handle all three shapes.

**Expiry handling checklist:**
- `HTTP 403` **and** body is HTML / `cf-mitigated` header present → "blocked or signed out" → run the `userStatus` check to disambiguate.
- `HTTP 403` with JSON `detail` mentioning authentication → session expired.
- `HTTP 302`/redirect to `/accounts/login/` → session expired.
- `userStatus.isSignedIn === false` → session expired. **Authoritative — use this to decide.**
- `HTTP 403` with `detail` mentioning **CSRF** → not an expiry; it's a bad `X-CSRFToken` or wrong `Referer`. Different message to the user.

---

# Part 4 — Operational reality

## 4.1 Cloudflare posture

**[VERIFIED 2026-07-25]** LeetCode sits behind Cloudflare (`server: cloudflare`, `cf-ray` headers present) and the posture is **split**:

| Surface | Anonymous plain-`curl` result |
|---|---|
| `POST /graphql/` | **Passes.** `200`, even with no `User-Agent` at all. **[VERIFIED]** |
| `GET /api/problems/all/` | **Passes.** `200`, 2.06 MB. **[VERIFIED]** |
| `GET /problems/two-sum/` (HTML) | **Blocked.** `403`, `cf-mitigated: challenge`. **[VERIFIED]** |
| `GET /submissions/detail/1/check/` | **Blocked.** `403`, `cf-mitigated: challenge`, HTML body. **[VERIFIED]** |

Consequences:
- **Content fetching is safe and easy.** Build against `/graphql/`.
- **Never scrape HTML pages.** They are challenged.
- The `403` on `/check/` was unauthenticated. **[UNVERIFIED — moderate confidence]** With valid session cookies + browser `User-Agent` + correct `Referer` it should pass, since every extant client works this way. **This is the single biggest unverified assumption in this document.**
- The `403` response advertised `accept-ch: Sec-CH-UA-*` — Cloudflare is fingerprinting client hints. **[VERIFIED — header observed]** Sending a browser `User-Agent` with **no** matching `Sec-CH-UA` headers is a mild inconsistency. If you hit challenges on authenticated calls, adding matching `Sec-CH-UA`, `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform` headers is the first thing to try. **[UNVERIFIED — speculative]**

## 4.2 Headers to always send

**[UNVERIFIED — high confidence, except where noted]**

```
User-Agent:  a real, current browser UA — ideally copied from the user's own browser,
             so it matches the browser the session cookie was minted in
Referer:     https://leetcode.com/problems/<slug>/     (REQUIRED for run/submit)
Origin:      https://leetcode.com                       (run/submit)
Content-Type: application/json
X-Requested-With: XMLHttpRequest                        (run/submit)
X-CSRFToken: <csrftoken cookie value>                   (run/submit)
```

For **content fetch only**, none of these are required **[VERIFIED]** — but send `User-Agent` and `Referer` anyway.

## 4.3 Rate limiting

**[UNVERIFIED — moderate confidence]** No published limits. Community-reported behavior:
- Submissions are throttled server-side; rapid-fire submits return errors telling you to wait. A handful per hour is invisible.
- GraphQL content reads tolerate normal browsing rates. Hundreds of rapid requests (e.g. bulk-scraping the catalog) draw `429` and/or Cloudflare challenges.
- `HTTP 429` should be handled with exponential backoff. **[UNVERIFIED]**

For this app's stated volume — a handful of submissions an hour, human-paced — throttling should never be hit. **Do not build a bulk pre-fetcher** that walks all 3999 problems at speed; that is the one thing in this design that could plausibly trip protection. Fetch problem content lazily, on open, and cache it locally forever (problem statements essentially never change).

## 4.4 Failure modes worth handling

| Symptom | Likely cause | Do |
|---|---|---|
| `403` + HTML + `cf-mitigated` | Cloudflare challenge | Don't retry in a loop. Surface "LeetCode is challenging this client." Check `userStatus`. |
| `403` + JSON `detail` re: CSRF | `X-CSRFToken` ≠ `csrftoken` cookie, or wrong `Referer` | Fix headers. Not an expiry — say so. |
| `403`/`302` to login, `isSignedIn:false` | Session expired | "Session expired — paste a fresh cookie." |
| `429` | Rate limited | Exponential backoff, tell the user to wait. |
| `question` is `null` in GraphQL data | Bad slug | Validate slugs against `/api/problems/all/`. **[VERIFIED that a valid slug returns data]** |
| `content`/`codeSnippets` `null`, `isPaidOnly:true` | Premium problem | Show a "premium" state, don't crash. **[VERIFIED]** |
| Poll never leaves `PENDING` | Judge backed up, or bad id | Hard timeout (30 s run / 60 s submit) + a "check on leetcode.com" link. |
| `state:"SUCCESS"` treated as accepted | **Your bug** | Acceptance is `status_code === 10`. |
| JSON parse error on a response | You got an HTML challenge/error page | Check `content-type` before parsing. Common enough to matter. **[VERIFIED — this is exactly what `/check/` returned]** |
| Submit succeeds, `question_id` was the frontend number | Wrong id field | Use internal `questionId`. **[VERIFIED that the two differ]** |

## 4.5 ToS and account risk — plainly

LeetCode's Terms of Service prohibit accessing the service by automated means and using unofficial/undocumented APIs. There is no public API and no sanctioned third-party access path; using session cookies from a browser to drive `interpret_solution` / `submit` is outside the ToS regardless of how low the volume is.

In practice, enforcement targets scraping at scale and contest cheating, not individuals; the VS Code extension (millions of installs), `leetcode-cli`, and numerous editor plugins have used exactly this mechanism for years. The realistic exposure is that **the mechanism breaks without notice** (endpoints change, Cloudflare tightens) rather than account action. But account suspension is the stated remedy in the ToS, the account is the user's real LeetCode profile with their submission history, and there is no appeal path worth relying on. Keep the volume human-paced, don't parallelize submissions, and don't build a bulk scraper.

---

# Appendix — Verified vs. unverified at a glance

**Verified hands-on this session (2026-07-25):**
- `POST /graphql/` serves problem content fully anonymously, no headers required.
- The exact `questionData` query in §1.2 returns all 17 fields for `two-sum` and `valid-parentheses`.
- Premium behavior: `isPaidOnly:true`, `content:null`, `codeSnippets:null`, no `errors` array, metadata/testcases still present (`meeting-rooms`).
- `exampleTestcases` / `sampleTestCase` / `metaData` / `stats` formats, and that `stats`/`metaData` are doubly-encoded JSON.
- 19 language slugs available.
- `GET /api/problems/all/` works anonymously; `num_total: 3999`; internal `question_id` ≠ `frontend_question_id`.
- `userStatus` GraphQL query returns `isSignedIn:false` anonymously — usable as a session-validity check.
- HTML pages and `/submissions/detail/{id}/check/` return Cloudflare `403 cf-mitigated: challenge` to a plain client, with HTML bodies.

**Not verified (no credentials, no submissions, by constraint):**
- Every run/submit request/response shape in Part 2.
- That `/check/` returns JSON when properly authenticated.
- All `status_code` semantics and per-verdict field presence.
- Cookie lifetime, and the exact wire shape of an *expired* (vs. absent) session.
- Rate limits.
- That premium content populates with a premium session.
