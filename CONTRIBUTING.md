# Contributing

Practice Studio is a local-first macOS app. Changes should preserve the local-only
server boundary, truthful progress data, and the rule that reference solutions are read
for comparison and never executed.

## Setup

Use Node.js 22 or newer and Python 3. From the repository root:

```sh
git clone --depth 1 https://github.com/neetcode-gh/leetcode.git vendor/neetcode-solutions
npm test
```

The app itself runs at `http://127.0.0.1:4173` with `npm start`. It has no npm runtime
dependencies and does not require `npm install`. The committed browser vendor files are
the runtime assets; do not replace them with CDN imports.

The test suite reads reference material from `vendor/neetcode-solutions/`, so the clone
must exist before `npm test`. The directory is generated and gitignored; run the relevant
generator after cloning when needed. Never hand-edit generated catalog,
solution-index, vendor, or interview-record output.

## Checks

Run `npm test` for the server and protocol unit tests. Browser checks use a local server
and the Google Chrome binary at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`:

```sh
npm run check:layout
npm run check                 # all headless browser checks
```

The CI job runs the unit and integration suite on macOS, checking out the upstream
revision recorded in `data/solutions-index.json` rather than relying on a moving branch. Browser checks are useful when
changing their named feature, but they require a scratch `STUDIO_HOME` populated with
cached fixtures. Several scripts copy or read real cache entries; never point them at a
personal workspace, and never assume they are offline unless their fixtures are seeded.
Do not add live judge or coach calls to CI.

For a deterministic local layout/stream check, `npm run demo` starts a disposable server
with an original Contains Duplicate fixture and a scripted coach. In another shell:

```sh
STUDIO_ORIGIN=http://127.0.0.1:4196 npm run check:layout
STUDIO_ORIGIN=http://127.0.0.1:4196 node scripts/check-coach-stream.mjs
```

Other feature checks start their own scratch servers and may copy the default content
cache. The full suite still needs those content fixtures. See the
[example session](docs/EXAMPLE-SESSION.md#reproduce-the-demo) for repeatable screenshot/GIF
capture, and [setup](docs/SETUP.md) for optional voice and coaching.

For visual changes, also inspect the result in a real browser. Keep LeetCode credentials
in the macOS keychain; never commit them or write them to an environment file. The app
binds to loopback, and changes must not widen that boundary.

## Generated output

Scripts in `package.json` such as `catalog`, `solutions`, `attempts`, and
`vendor:excalidraw` regenerate committed or local artifacts. Change the producing script
when behavior needs to change, then regenerate and review the resulting diff.
