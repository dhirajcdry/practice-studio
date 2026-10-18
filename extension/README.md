# Studio Connector (1.2.0)

The browser extension that lets Practice Studio submit to LeetCode. It sends your solution
from a leetcode.com tab, signed in as you, so Studio never needs your LeetCode cookies.

**Install once:** sign in to leetcode.com, open `chrome://extensions` (or `dia://extensions`),
turn on **Developer mode**, click **Load unpacked**, choose this folder, then reload Studio.
After pulling changes here, press the reload icon on the extension's card.

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3; host access to `https://leetcode.com/*` only |
| `bridge.js` | Runs on `127.0.0.1` / `localhost` pages and relays Studio's request |
| `background.js` | Checks sign-in, picks a leetcode.com tab, submits once, polls the verdict |

Version 1.2.0 makes one optional read-only `submissionDetails` GraphQL request after
judging completes. A failed read never changes the verdict. Details reads never retry.
The `studio-submit` port also accepts `{type: "details", submissionId}` for an explicit
Fetch details click. It opens/reuses a LeetCode tab and closes only a tab it created. Studio records the result at `POST /api/submit/record`; submission history
is served by `GET /api/problems/:slug/submissions`, and optional details are sent once to
`POST /api/problems/:slug/submissions/:id/details` and stored by Studio in a JSON sidecar
next to the submitted code.

How it works, every result state and troubleshooting: [docs/SUBMITTING.md](../docs/SUBMITTING.md).
