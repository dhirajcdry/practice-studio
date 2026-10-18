# Submitting to LeetCode

**Run** checks your code locally against the cases you can see. **Submit** sends it to
LeetCode's own judge, which runs every hidden test and returns the verdict that counts.

Studio submits through **your browser**, using a small extension that ships in this repo:
the **Studio Connector** (`extension/`). The extension sends the submission from a
leetcode.com tab, signed in as you, exactly as if you had pressed Submit on LeetCode.
Studio never sees, stores or asks for your LeetCode cookies.

## Set it up once

Use the same browser profile you run Studio in, and make sure you are signed in to
leetcode.com there. Any Chromium browser works: Dia, Chrome, Brave, Arc, Edge.

1. Open `chrome://extensions` (in Dia, `dia://extensions` also works).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this repo's `extension/` folder.
4. Reload Studio.

That's it. There is no command to run, nothing to paste, and no macOS Keychain prompt.
Until the extension is installed, the Submit panel shows these steps along with a
**Copy current solution** button and a link to the problem, so you can still submit by hand.

**After pulling changes to `extension/`**, press the reload icon on the extension's card in
`chrome://extensions`, then reload Studio.

## What happens when you press Submit

```mermaid
sequenceDiagram
  autonumber
  participant P as Studio page
  participant B as Connector bridge<br/>(content script)
  participant W as Connector worker<br/>(service worker)
  participant T as leetcode.com tab
  participant S as Studio server
  P->>B: postMessage submit {slug, code}
  B->>W: port "studio-submit"
  W->>W: signed in? (LEETCODE_SESSION, csrftoken cookies)
  W->>T: use an open tab, or open one in the background
  W->>T: inject pageSubmit
  T->>T: GraphQL questionData → internal questionId
  T->>T: ONE POST /problems/{slug}/submit/ → submission_id
  W->>T: inject pagePoll
  T->>T: GET /submissions/detail/{id}/check/ every 1 s until SUCCESS (max 55 s)
  W-->>B: {ok, submissionId, check}
  B-->>P: postMessage result
  P->>S: POST /api/submit/record {slug, code, submissionId, check}
  S-->>P: verdict (status_code 10 = Accepted) + what was recorded
```

1. You click **Submit**. The page asks the Connector, through `window.postMessage`.
2. The Connector checks that this browser is signed in to LeetCode. If not, it stops and
   says so; nothing is sent.
3. It uses an open, loaded leetcode.com tab, or opens the problem page in a background tab
   and closes it afterwards.
4. Inside that tab it looks up the problem's **internal** `questionId` and sends **one**
   POST to `/problems/{slug}/submit/`. Because the request comes from LeetCode's own page,
   it carries your cookies, CSRF token, Cloudflare clearance and the browser's TLS
   fingerprint, which is why Cloudflare lets it through.
5. It polls `/submissions/detail/{id}/check/` once a second until judging finishes, for up
   to 55 seconds.
6. The page sends the submission id and LeetCode's raw result to the Studio server, which
   decides the verdict (Accepted means `status_code === 10`, nothing else) and records it.
7. The panel shows the verdict in LeetCode's own words: the failing input, expected and
   actual output, compile or runtime error, runtime and memory percentiles.

If the server is down at step 6, the panel still shows the verdict, built from the same
result, but it is not saved to your history.

## The rules it never breaks

- **One submission per click.** There is no retry, no backoff loop and no automatic
  resubmission anywhere: not in the page, the extension or the server. A second click on
  the same problem while one is being judged is refused.
- **Honest about what was sent.** Every failure says whether your code reached LeetCode:
  `not_sent`, `submitted` (with a link to the real submission) or `unknown`. Studio never
  offers "Submit again" when the code may already be there.
- **Only Studio can use it.** The bridge only runs on `127.0.0.1` and `localhost`, and only
  answers pages that declare `<meta name="practice-studio">`. The worker rejects
  connections from any other origin.
- **Cookies stay in the browser.** The worker checks that the two LeetCode cookies exist and
  passes the CSRF token into the leetcode.com tab, where LeetCode's own requests use it
  anyway. No cookie value reaches the Studio page, the server, a log or a file.

## What gets recorded

All of it is written by the server into `STUDIO_HOME` (default `~/LeetCodeTutor`):

| Where | What |
| --- | --- |
| `problems/<slug>/submissions/<id>.py` | The exact code that was judged |
| `problems/<slug>/meta.json` → `submissions[]` | Verdict, tests passed, runtime, memory, percentiles, link. Merged into the file, never overwritten; a submission id already there is not added twice |
| `problems/<slug>/sessions/<id>.jsonl` | A `submitted` event and a `verdict` event, which the coach and stats read |

If the code was sent but no verdict came back, only the code and the `submitted` event
are recorded.

## What the panel tells you

| Panel says | Meaning | What to do |
| --- | --- | --- |
| **Install the Studio Connector to submit** | The extension isn't installed in this browser profile, or the page was open before you installed it | Follow [Set it up once](#set-it-up-once), then reload Studio |
| **You are not signed in to LeetCode** | No LeetCode session in this browser profile | Sign in on leetcode.com, then submit again |
| **Your LeetCode session has expired** | LeetCode refused the session the browser has | Sign in again on leetcode.com |
| **The judge could not be reached** (Cloudflare) | Cloudflare wants the browser to verify itself | Open the leetcode.com tab, finish the check, submit again |
| **LeetCode is rate limiting submissions** | Too many submissions in a short window | Wait a minute or two |
| **LeetCode has not finished judging** | Judging took longer than 55 s | Open the linked submission on LeetCode; don't resubmit |
| **A submission is already on its way** | You clicked twice | Wait for the first verdict |

## Troubleshooting

- **The panel still says to install after installing.** Reload the Studio page. The
  extension marks a page as it loads, so pages that were already open don't know about it.
- **"The Studio Connector was reloaded since this page opened."** You reloaded or updated
  the extension. Reload Studio.
- **Studio runs on a different host.** The bridge only matches `http://127.0.0.1/*` and
  `http://localhost/*` (any port). Edit `matches` in `extension/manifest.json` if you need
  another host, then reload the extension.
- **A background tab flashes open and closes.** That's the Connector, when no leetcode.com
  tab was open. Keep one open to avoid it.
- **Want to watch it work?** Open `chrome://extensions`, click **service worker** on the
  Connector's card for its console, or open DevTools on the leetcode.com tab and watch the
  Network panel for `submit/` and `check/`.

## Files

| File | Role |
| --- | --- |
| `extension/manifest.json` | Manifest V3. Permissions: `scripting`, `tabs`, `cookies`; host access to `https://leetcode.com/*` and `https://neetcode.io/*` (premium problems; no NeetCode cookie is ever read) |
| `extension/bridge.js` | Content script on local pages. Marks the page (`data-studio-connector`), relays one request and one answer |
| `extension/background.js` | Service worker. Sign-in check, tab handling, the in-tab submit and poll, all error wording; the NeetCode path (`submitNeetCode`, `pageStoreNeetCodeCode`, `pageNeetCodeSubmit`, `pageNeetCodeVerdict`) |
| `web/js/leetcode-bridge.js` | The page side of the message exchange |
| `web/js/api.js` → `submitCode` | Sends to the Connector, then to the record route |
| `web/js/submit.js` | The verdict panel and every state in the table above |
| `server/judge/routes.mjs` | `POST /api/submit/record`: validates and records |
| `server/judge/verdict.mjs` | Turns LeetCode's `/check/` body into the verdict; `buildNeetCodeVerdict` for NeetCode |
| `server/judge/record.mjs` | Writes the code, the session events and `meta.json` |

### Messages

Page → bridge (`window.postMessage`, same origin):

```js
{ source: 'studio-page', type: 'submit', id, slug, code, lang: 'python3' }
```

Bridge → page:

```js
{ source: 'studio-connector', id, result }
// result on success:  { ok: true, submissionId, check }          // check = raw /check/ body
// result on failure:  { ok: false, code, message, submissionState, submissionId?, challenge? }
```

Failure codes: `SIGNED_OUT`, `SESSION_EXPIRED`, `RATE_LIMITED`, `JUDGE_UNREACHABLE`,
`JUDGE_TIMEOUT`, `SUBMIT_IN_FLIGHT`, `PROBLEM_NOT_FOUND`, `BAD_REQUEST`,
`CONNECTOR_ERROR`, `CONNECTOR_GONE`. The page maps them to panel states in `SUBMIT_KINDS`
(`web/js/api.js`); a code it doesn't know still shows the Connector's message verbatim.

`POST /api/submit/record` takes `{ slug, code, submissionId, check }` (`check` is `null` when
no verdict came back). It answers `200` with the verdict payload described in
[API-CONTRACT-P2.md](API-CONTRACT-P2.md#phase-4--the-judge), `400` for a malformed
request or an unfinished `check`, `404` for a slug outside the catalog, and `409` if that
submission was already recorded.

## Developing and testing

- `npm test` covers the record route (`server/judge/test/routes.test.mjs`), the verdict
  rules (`verdict.test.mjs`) and the NeetCode verdict and recording (`neetcode.test.mjs`).
  Nothing in the suite talks to LeetCode or NeetCode.
- `web/tests.html` covers every panel state, including the install and sign-in states.
- `?simsubmit=accepted|wrong|tle|compile|runtime|expired|nosession|noconnector|unreachable|judgetimeout|ratelimited|inflight`
  renders a state without touching the extension or LeetCode.
- To exercise the real extension headlessly, use Chrome for Testing or Chromium; branded
  Chrome ignores `--load-extension`. With a fresh profile, a submit through the page
  returns `SIGNED_OUT`, which proves the whole path without sending anything.
- Never automate a real submission. Every one is a real entry on someone's account.

## Why the browser submits, not the server

Studio used to copy the LeetCode cookies into macOS Keychain and submit from its Node
server. Cloudflare recognised that connection as a non-browser client and challenged it
even when the cookies were valid, and copying cookies out of the browser meant repeated
Keychain password prompts. Submitting from a leetcode.com tab removes both problems: the
request is the browser's own, and there is nothing to copy.

The underlying LeetCode endpoints are documented in [LEETCODE-API.md](LEETCODE-API.md)
(Part 2).

## Premium problems: NeetCode

LeetCode premium problems (`isPaidOnly`) can't be judged on a free LeetCode account, so
Studio judges them on **neetcode.io** instead, with the same Connector, in the same panel.
The button reads **Submit on NeetCode** and the panel's scope says `neetcode.io`. This
needs Connector **1.1.0** or later and a neetcode.io sign-in in the same browser profile,
with NeetCode's editor set to Python.

**After updating:** the Connector gained the `https://neetcode.io/*` host permission in
1.1.0. Press the reload icon on its card in `chrome://extensions`, then reload Studio.
An older Connector would ignore the NeetCode target and send the code to LeetCode, so
Studio checks the version first and never sends anything to one.

```mermaid
sequenceDiagram
  autonumber
  participant P as Studio page
  participant W as Connector worker
  participant T as neetcode.io tab
  participant S as Studio server
  P->>W: submit {target:'neetcode', slug, neetcodeSlug, code} (through the bridge)
  W->>T: use an open neetcode.io tab, or open /problems/{ncSlug}/question in the background
  W->>T: inject: write code into localStorage "{ncSlug}_python_tabs"[activeTab].code
  W->>T: load /problems/{ncSlug}/question fresh
  W->>T: inject: wait for Submit + editor, check Python, stale-code guard, press Submit ONCE
  loop every 1 s, up to 60 s
    W->>T: inject: read the new verdict off the page (read-only)
  end
  W-->>P: {ok, target:'neetcode', result:{status, passed, total, memory, time, details, url}}
  P->>S: POST /api/submit/record {source:'neetcode', slug, code, result, url, requestId}
  S-->>P: verdict (accepted ⇔ status is exactly "Accepted") + what was recorded
```

**Why localStorage.** NeetCode's editor is Monaco, but it isn't exposed to the page
(`window.monaco` is undefined), and typing into it would fight auto-indent and bracket
completion. NeetCode loads its editor from `localStorage`: `<ncSlug>_python_tabs` is a JSON
array of tabs (`[{ "code": "…" }]`) and `<ncSlug>_python_activeTab` is the index as a
string. The Connector writes the code into the active tab (keeping that tab's other fields,
or creating `[{code}]` with index `"0"`), then loads the problem page fresh, which also
means no earlier verdict is on the page.

**The stale-code guard.** Before pressing Submit the Connector checks two things, and
refuses with `not_sent` if either fails for 20 s: NeetCode's stored copy is still exactly
our code (whitespace aside), and the text Monaco has painted (its `.view-line`s, in
on-screen order, whitespace removed so wrapped lines and non-breaking spaces don't matter)
is the start of our code. Comparing only the first line would not do: almost every solution
starts with `class Solution:`. Any verdict already on the page is marked before the press,
so only a new one is read. In a background tab Monaco may not paint at all; then the tab is
brought to the front once, checked again, and Studio's tab is focused again afterwards.

**Verdict.** NeetCode has no status code. The server accepts only the exact text
`Accepted` (`buildNeetCodeVerdict` in `server/judge/verdict.mjs`). It records the code as
`submissions/nc-<timestamp>.py`, a `submitted` and a `verdict` event with
`source: 'neetcode'`, and a `meta.json` entry with that synthetic id, `source: 'neetcode'`
and the NeetCode page as its link. Stats count an accepted NeetCode verdict like any other.
If Submit was pressed but no verdict showed within 60 s, only the code and the `submitted`
event are recorded, and the panel links to NeetCode.

| Panel says | Meaning | What to do |
| --- | --- | --- |
| **Update the Studio Connector** | The Connector is older than 1.1.0 | Reload it in `chrome://extensions`, then reload Studio. Studio copies your code and opens NeetCode meanwhile |
| **Install the Studio Connector to submit to NeetCode** | No Connector in this browser profile | [Set it up once](#set-it-up-once). Studio copies your code and opens NeetCode meanwhile |
| **You are not signed in to NeetCode** | No Submit button, or a sign-in prompt, on NeetCode | Sign in on neetcode.io, then submit again |
| **NeetCode's editor is not set to Python** | The language button shows another language | Switch NeetCode's editor to Python once, then submit again |
| **Your code did not show up in NeetCode's editor** | The stale-code guard refused. Nothing was pressed | Submit again; if it repeats, open the problem on NeetCode and look |
| **NeetCode has not shown a verdict** | Submit was pressed, nothing appeared in 60 s | Open the linked page on NeetCode; don't resubmit |

Connector codes on this path: `NOT_PYTHON`, `STALE_CODE`, `EDITOR_HIDDEN`, `SIGNED_OUT`,
`JUDGE_TIMEOUT`, `JUDGE_UNREACHABLE`, `SUBMIT_IN_FLIGHT`, `BAD_REQUEST`, `CONNECTOR_ERROR`
(mapped in `NEETCODE_KINDS`, `web/js/api.js`). **Run** still uses the local runner.

For NeetCode-judged problems, Studio uses NeetCode's own statement, Python starter,
method names, parameter types and example inputs. Opening a premium problem lazily
fetches its NeetCode question page once and caches only the problem definition in
`STUDIO_HOME/cache/neetcode/`. Expected values are the `Output:` lines NeetCode prints
in each example, used only when every example has one that reads as JSON and the
statement does not accept several answers (Foreign Dictionary does, so its runs show
output without a verdict). The statement's TeX becomes plain text and its hint and
company-tag blocks are dropped. Meeting problems receive `Interval`
objects with `.start` and `.end`; string encode/decode runs `decode(encode(strs))` on one
`Solution` instance.

Existing saved solutions are never rewritten. The workspace and submit panel flag a
missing NeetCode method before any submission is sent. For a single renamed method,
**Use NeetCode's name** changes only the definition's name in one undoable editor edit;
parameter names and the body stay intact. Class-shape differences and detected list-based
Interval code require manual edits and have no rename button. This textual guard catches
signature mismatches and common old Interval code; it does not prove arbitrary Python
implementations compatible with the judge.

If NeetCode is Pro-only or its definition cannot be fetched, Studio keeps the existing
LeetCode/doocs behavior. Missing premium statements and Python signatures are fetched lazily from
[doocs/leetcode](https://github.com/doocs/leetcode) (CC BY-SA 4.0), with linked attribution
under the statement. Successful fetches are cached permanently in
`STUDIO_HOME/cache/premium-statements/`; a failed fetch leaves the premium notice.
Only class/method headers and node-definition comments are retained from the Python
solution, with method bodies replaced by `pass`. Existing saved code and recovery drafts
keep precedence. Example outputs are used only when their parsed inputs match all of
LeetCode's supplied example cases; ambiguous formats retain unpublished expectations.
