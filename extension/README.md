# Studio Connector

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

How it works, every result state and troubleshooting: [docs/SUBMITTING.md](../docs/SUBMITTING.md).
