// Claude can repeat its pre-tool answer in a new assistant message after the tool
// returns. Reconcile that protocol boundary before text reaches storage or speech.
// No fuzzy matching, global sentence deduplication, or completed-snapshot replay.
export function createClaudeTextStream() {
  let emitted = false, needsBreak = false, blockActive = false, blockIndex;
  let rawBlock = '', lastBlock = '', hasTool = false, firstBlock = true;
  let candidate = null, held = '', echoWhitespace = null;

  function emit(text, out) {
    if (!text) return;
    if (needsBreak) out.push('\n\n');
    needsBreak = false; emitted = true; out.push(text);
  }
  function endBlock(out) {
    // A shorter matching answer is different. An exact complete echo is not.
    if (candidate && held && held !== candidate) emit(held, out);
    candidate = null; held = ''; echoWhitespace = null;
    if (rawBlock) lastBlock = rawBlock;
    rawBlock = ''; blockActive = false;
  }
  function continuation(text, out) {
    const tail = (echoWhitespace || '') + text;
    if (!tail.trim()) { echoWhitespace = tail; return; }
    echoWhitespace = null;
    // Preserve the model's separator after the echoed prefix, consistently
    // regardless of how the provider split it into deltas.
    needsBreak = false; emit(tail, out);
  }
  return {
    start() {
      const out = []; endBlock(out);
      candidate = hasTool && lastBlock ? lastBlock : null;
      hasTool = false; firstBlock = true; needsBreak = emitted;
      return out;
    },
    tool() { hasTool = true; },
    push(index, text) {
      const out = [];
      if (!blockActive || index !== blockIndex) {
        if (blockActive) endBlock(out);
        if (!firstBlock) { candidate = null; needsBreak = emitted; }
        firstBlock = false; blockActive = true; blockIndex = index;
      }
      rawBlock += text;
      if (echoWhitespace !== null) { continuation(text, out); return out; }
      if (!candidate) { emit(text, out); return out; }
      held += text;
      // Hold only the ambiguous prefix. Novel content streams on first divergence.
      if (candidate.startsWith(held)) return out;
      const suffix = held.slice(candidate.length);
      if (held.startsWith(candidate) && /^\s/.test(suffix)) {
        candidate = null; held = ''; continuation(suffix, out);
      } else {
        // Includes a word extension such as "Yes" -> "Yesterday".
        const different = held; candidate = null; held = ''; emit(different, out);
      }
      return out;
    },
    stop(index) { const out = []; if (blockActive && index === blockIndex) endBlock(out); return out; },
    finish() { const out = []; endBlock(out); return out; },
  };
}
