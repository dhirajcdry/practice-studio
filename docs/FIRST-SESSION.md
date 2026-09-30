# Your first session

Start with a small coding attempt. You can complete the local run without setting up
voice, coaching, reference material, or judge credentials.

## 1. Open the workspace

Run `npm start` from the checkout and visit `http://127.0.0.1:4173`.
You should see the problem list, list/difficulty filters, and search. The console warning
about missing reference solutions means the optional solution/article checkout is absent;
it doesn't prevent writing or running your own code.

## 2. Choose a familiar problem

Search for **Contains Duplicate** and open it while online. Studio caches the statement,
Python starter, and example inputs on first open. You should see the statement and editor.
If fetching is challenged or you're offline with an empty cache, the content panel explains
why. Wait and retry later, or choose a problem you've already cached.

## 3. Write and run

Write your Python solution, then press **Run** (`⌘'`). The results panel shows the actual
output for each case and whether it matches the expected output. Compile errors and
tracebacks point back to your code. Check the save indicator before leaving the page:
saved to disk and kept only in the browser are different states.

Add a custom case in the testcase panel if you want to probe an edge condition. A useful
first choice is an empty or single-element input where the problem's constraints permit
it. A passing local run establishes only that those cases passed. You haven't submitted
to LeetCode yet.

## 4. Explain the solution

If Claude Code is installed and signed in, open the coach (`⌘\`) and ask a precise
question, for example:

> My examples pass. What invariant do I need to explain, and what edge case should I test?

The coach receives the current buffer, available run evidence, and session context. Read
its reasoning against your actual code. It may ask you to explain a detail instead of
giving you the answer. If the CLI isn't available, the panel says so; you can keep coding.

![An illustrative coding session with local run results and an invariant follow-up](images/coach.png)

*This screenshot uses scripted coaching. [The example session](EXAMPLE-SESSION.md)
explains the reasoning being practised.*

## 5. Try speaking, when ready

[Build the optional transcriber](SETUP.md#voice-input), then press **Start attempt** (`⌥R`).
Allow microphone access and explain your choices while you solve. End the attempt to
request coaching on the completed attempt. A silent attempt or absent transcript is
missing evidence; it isn't proof that you reasoned well or poorly.

## 6. Leave something useful for next time

Your default workspace is `~/LeetCodeTutor/`. Look under `problems/<slug>/` for your
working solution, code snapshots, session logs, and any saved coaching notes/transcripts.
Readable attempt documents are derived from the logs. `npm run attempts` rebuilds them.

The progress view starts with limited data. It can show that more attempts are needed
before a metric is meaningful. That's expected on the first session.

## 7. Try a system-design interview

Open **System design** from the navigation and start a new interview. New interviewer
turns require Claude Code connectivity. Use **Type** to control when you send an answer,
or **Voice** for spoken turn-taking after voice setup.

Draw the system you're describing. The next answer sends a graph of the board to the
interviewer, which can probe missing connections and assumptions. Leave and return via
the interview library to resume an unfinished session. Completed interviews have a
read-only transcript and board replay.

For a concrete example, see the [illustrative URL-shortener session](EXAMPLE-SESSION.md#system-design-the-board-is-evidence).
[Setup & troubleshooting](SETUP.md) covers errors and optional submissions.
