# Studio HTTP contract — Phase 1 (Browse)

Frozen so the server and the web client can be built in parallel. Both sides code against
this document. If either side needs a change, the change lands here first.

Server: Node 23, `node:http`, no framework, **binds 127.0.0.1 only**, port **4173**.

## Scope decisions (settled, do not revisit)

- **NeetCode 250 only.** Filter `catalog.json` to `lists.neetcode250 === true`. The other
  723 problems are not shown in Phase 1.
- **Drop `pattern === "JavaScript"`** — 30 non-DSA language exercises. They are not in the
  250 anyway; assert this rather than assuming it.
- **Python only.** No language switcher.
- Expected result: **250 problems, 18 patterns.** Log it at boot; a different number means
  something upstream moved.

## Conventions

All responses JSON, `application/json; charset=utf-8`. Errors are
`{ "error": { "code": "...", "message": "..." } }` with a real HTTP status. `message` is
shown to the user, so it must be plain English, never a stack trace.

Every request is checked for a loopback `Origin`/`Host`; anything else gets 403.

---

### `GET /api/health`
`200 { ok: true, problemCount: 250, patternCount: 18, catalogSource, solutionsCommit }`

---

### `GET /api/problems`
The full list, sent once at boot — 250 items is small, so there is no pagination and no
server-side search. Filtering and sorting are the client's job.

```json
{ "problems": [ {
    "slug": "two-sum",                  // canonical key, LeetCode slug
    "neetcodeSlug": "two-integer-sum",  // may differ (74 forks) or be null
    "number": 1,
    "title": "Two Sum",                 // bundle title; /api/problems/:slug has the real one
    "pattern": "Arrays & Hashing",
    "difficulty": "Easy",
    "lists": { "blind75": true, "neetcode150": true, "neetcode250": true },
    "isPro": false,
    "hasPythonSolution": true,
    "hasArticle": true,
    "youtubeVideoId": "KLlXCFG5TnA"     // nullable
  } ],
  "patterns": ["Arrays & Hashing", "Two Pointers", "..."]   // canonical display order
}
```

`patterns` is ordered as NeetCode orders them (roughly easy→hard), because that ordering is
the curriculum. Preserve first-appearance order from the catalog; do not alphabetize.

---

### `GET /api/problems/:slug`
Catalog entry plus live LeetCode content. **Lazy-fetch on first open, then cache forever**
in `~/LeetCodeTutor/cache/leetcode/<slug>.json`. Statements do not change. Never bulk
pre-fetch — that is the one behaviour that could trip Cloudflare, and it buys nothing.

```json
{ "slug": "two-sum",
  "catalog": { ...as above... },
  "content": {
    "title": "Two Sum",              // real title — prefer over catalog.title
    "difficulty": "Easy",
    "descriptionHtml": "<p>...</p>", // untrusted, see below
    "topicTags": ["Array", "Hash Table"],
    "exampleTestcases": "[2,7,11,15]\n9",
    "isPaidOnly": false,
    "fetchedAt": "2026-07-25T...",
    "stale": false
  },
  "solution": { "available": true, "language": "python" },
  "article": { "available": true } }
```

**Premium fails silently, not loudly** — HTTP 200 with `isPaidOnly: true` and
`content: null`. Null-check everything; do not let it throw. Return `content` with
`descriptionHtml: null` and let the client show "this one is LeetCode premium".

**Network down / fetch failed:** if a cache entry exists, serve it with `stale: true`. If
not, `503 LEETCODE_UNREACHABLE` with a message saying the description could not be loaded
and the rest of the app still works. **Never block the page on this.**

---

### `GET /api/problems/:slug/solution`
`200 { language: "python", code: "...", sourcePath: "python/0001-two-sum.py", license: { notice, copyright } }`

Resolve by **problem number, not stem** — upstream spells the same problem differently
across languages, so exact-stem lookup silently loses files.

`404 SOLUTION_NOT_AVAILABLE` for the ~26 problems in the 250 with no Python reference. The
client offers the article instead.

The MIT notice is served with every response and the client must display it wherever
solution text appears. That is the license obligation.

---

### `GET /api/problems/:slug/article`
`200 { markdown: "...", sourcePath: "articles/two-sum.md", license: {...} }`

Articles are keyed by **slug only** upstream, with no number prefix — a different key
space from solutions. `404 ARTICLE_NOT_AVAILABLE` when absent.

---

## Untrusted content — non-negotiable

`descriptionHtml` is LeetCode's HTML and article markdown is third-party text. Neither is
trusted:

- The **server** never executes or interprets them; it passes bytes through.
- The **client** sanitizes before rendering — strip `<script>`, `<iframe>`, `<object>`,
  `<embed>`, every `on*` attribute, and any `javascript:` URL. Allow only the formatting
  tags LeetCode actually uses (`p`, `pre`, `code`, `ul`, `ol`, `li`, `strong`, `em`, `img`,
  `sup`, `sub`, `b`, `i`, `br`, `table`/`tr`/`td`/`th`, `a` with an `https:` href).
- Render article markdown with an escape-by-default renderer; raw HTML inside markdown is
  escaped, not passed through.

No external network requests from the page except LeetCode-hosted `<img>` in descriptions.
No CDNs — Monaco and every asset are served from disk so the app works offline.
