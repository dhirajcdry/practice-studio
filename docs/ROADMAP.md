# Roadmap

This is a short list of actionable priorities based on the current repository gaps. It
describes useful next work, not committed delivery promises.

1. **Improve portability beyond macOS.** Separate macOS-only sandbox, Chrome, and Swift
   assumptions from the Node server so Linux and Windows contributors can run supported
   non-voice workflows with clear substitutions.
2. **Add a setup doctor.** Provide one bounded command that checks Node, Python, Chrome,
   the NeetCode clone, committed browser vendors, and writable local storage before a
   first run.
3. **Bootstrap coach memory in a fresh workspace.** Make the first coach session explain
   and initialize the expected local memory layout without requiring a manually created
   `TUTOR.md`, journal, or skills directory.
4. **Make browser checks deterministic.** Seed a disposable `STUDIO_HOME` with captured
   problem/cache fixtures and fake coach responses so layout and interaction checks can
   run in CI without personal data or external services.
5. **Plan explicit language expansion.** Define the runner, editor, fixtures, and result
   contract needed to add a second supported solution language while keeping Python's
   current behavior stable.
