# Current limitations

Practice Studio is an early macOS project. These are the practical boundaries to know
before using it or assessing a result.

- **Platform:** macOS is the supported environment. The sandbox and credential store
  depend on macOS facilities; Windows/Linux aren't equivalent supported setups. If
  `sandbox-exec` is unavailable or disabled, Python still runs with timeout/output
  limits, but without the sandbox's network restriction.
- **Language:** the working buffer, runner, and submission flow currently use Python.
  The upstream reference repository contains other languages, which doesn't imply
  execution support for them.
- **Test coverage:** local runs cover example/custom cases, including supported tree,
  linked-list, in-place, and class-style adapters. These aren't LeetCode's hidden tests.
  An unsupported or ambiguous problem shape can still require the real judge.
- **Fresh setup:** problem statements require a first online fetch, reference articles
  need a separate clone, and voice needs a Swift build and initial model download.
  The coach's memory begins with the files available in the chosen workspace.
- **AI feedback:** coaching and mock-interview debriefs are model judgments. Check them
  against the code and evidence; they don't predict an employer's hiring decision.
- **Voice:** microphone permissions, transcription errors, technical vocabulary, and
  browser/OS speech voices affect the conversation. Typed answers remain available.
- **Whiteboard interpretation:** the interviewer sees an extracted graph of supported
  shapes/text/connections, not every visual nuance of a freehand drawing. It receives
  an updated graph when you send an answer, rather than replying on each edit.
- **LeetCode access:** browser challenges, expiring cookies, and Premium content can
  limit fetching or submissions. A cache entry for a restricted problem doesn't create
  access to content that LeetCode didn't return.
- **Offline use:** cached practice and stored records work locally; connected coaching,
  new interviewer turns, new problem fetching, and submissions require network access.

See [setup](SETUP.md), [privacy](PRIVACY.md), and the [roadmap](ROADMAP.md).
