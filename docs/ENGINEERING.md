# Engineering decisions

These choices make the practice evidence easier to preserve and the integrations easier
to inspect. The links below point to the code and tests, rather than treating a design
intention as proof of a universal guarantee.

| Decision | Why | Implementation and evidence |
| --- | --- | --- |
| Own the editor and run loop | Supply exact code, diffs, and case results to the coach | [Context builder](../server/coach/context.mjs), [context tests](../server/coach/test/context.test.mjs) |
| Cache content and vendor browser assets | Keep the coding loop usable without CDN or repeated content fetches | [Content cache](../server/leetcode.mjs), [offline tests](../server/test/offline.test.mjs), [vendor provenance](../web/vendor/excalidraw/VENDORED.md) |
| Use Node built-ins and browser modules | Avoid a runtime package install and frontend build | [package.json](../package.json), [server entry](../server/index.mjs), [browser entry](../web/js/main.js) |
| Save atomic buffers and append activity | Preserve working code and retain the events that explain an attempt | [Workspace routes](../server/workspace/routes.mjs), [session log](../server/coach/sessions.mjs), [assembly tests](../server/attempts/assemble.test.mjs) |
| Scope CLI tools and writable paths | Let coaching keep notes while protecting working solutions and evidence | [Permission arguments](../server/coach/claude-cli.mjs), [CLI tests](../server/coach/test/claude-cli.test.mjs) |
| Frame untrusted material per turn | Distinguish problem/code/article content from instructions | [Context builder](../server/coach/context.mjs), [context tests](../server/coach/test/context.test.mjs) |
| Kill an execution's process group | Stop runaway children as well as the parent | [Executor](../server/runner/execute.mjs), [runner tests](../server/runner/run.test.mjs) |
| Extract a graph from the whiteboard | Compare the candidate's diagram with the claims in an answer | [Graph extraction](../server/design/graph.mjs), [graph tests](../server/design/graph.test.mjs) |
| Filter incomplete streamed labels | Stop candidate impersonation before a complete label is displayed/spoken | [Narration guard](../server/design/narration.mjs), [guard tests](../server/design/narration.test.mjs) |
| Use Keychain and redacted wrappers | Keep session cookies out of plaintext app configuration and routine diagnostics | [Credentials](../server/judge/credentials.mjs), [credential tests](../server/judge/test/credentials.test.mjs) |
| Report missing samples | Avoid presenting sparse practice evidence as a confident metric | [Aggregation](../server/stats/aggregate.mjs), [stats tests](../server/stats/test/aggregate.test.mjs) |
| Measure rendered boxes | Catch clipped/overlapping messages that unit tests don't see | [Layout check](../scripts/check-layout.mjs), [stream check](../scripts/check-coach-stream.mjs) |

The permission rules and sandbox have specific scopes. Prompt fencing isn't a proof of
immunity to prompt injection, and the practice runner isn't intended to isolate hostile
code from the entire filesystem. See the [architecture](ARCHITECTURE.md) for these
boundaries and [limitations](LIMITATIONS.md) for the product's current scope.
