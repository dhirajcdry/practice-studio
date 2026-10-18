// Interview-only, tool-free native thread reuse. The connection lives for this one
// interview; losing it is recoverable from Studio's append-only transcript.
import { connection, startLockedTurn, mcpServerStarting, plainError, MCP_STARTED, safeError, TURN_TIMEOUT_MS } from './codex-cli.mjs';
export function runConversationTurn({ conversation, prompt, systemPrompt = '', model, binary, onToken = () => {}, onSessionId = () => {}, onDone = () => {}, onError = () => {} }) {
  let settled = false, timer, streamed = '', finalText = '';
  function close() {
    conversation.client?.close(); conversation.client = null; conversation.threadId = null; conversation.ready = false;
  }
  const fail = error => {
    if (settled) return;
    settled = true; clearTimeout(timer); close(); onError(safeError(error));
  };
  const notification = message => {
    if (settled) return;
    if (mcpServerStarting(message, conversation.threadId)) { fail(plainError(MCP_STARTED)); return; }
    const p = message.params || {};
    if (!conversation.threadId || p.threadId !== conversation.threadId) return;
    if (message.method === 'item/agentMessage/delta') { streamed += p.delta || ''; onToken(p.delta || ''); }
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage') finalText = p.item.text || finalText;
    if (message.method !== 'turn/completed') return;
    if (p.turn?.status !== 'completed') { fail(p.turn?.error?.message || 'Turn failed.'); return; }
    finalText ||= p.turn?.items?.filter(i => i.type === 'agentMessage').at(-1)?.text || '';
    if (!streamed && finalText) onToken(finalText);
    if (!streamed && !finalText) { fail('No reply was returned.'); return; }
    settled = true; clearTimeout(timer); conversation.ready = true;
    onDone(conversation.threadId, 'completed');
  };
  conversation.notification = notification;
  conversation.close = close;
  timer = setTimeout(() => fail('The interviewer took too long and was stopped.'), TURN_TIMEOUT_MS);
  timer.unref?.();
  (async () => {
    try {
      if (!conversation.client) {
        conversation.client = connection({ binary, onNotification: message => conversation.notification?.(message) });
        const client = conversation.client;
        client.exited.then(error => {
          if (conversation.client !== client) return;
          conversation.ready = false; conversation.client = null; conversation.threadId = null;
          if (!settled) fail(error);
        });
        await client.initialize();
        if (settled) return;
        await startLockedTurn(client, { model, baseInstructions: systemPrompt, text: prompt,
          onThread: id => { conversation.threadId = id; onSessionId(id); }, alive: () => !settled });
      } else {
        conversation.ready = false;
        onSessionId(conversation.threadId);
        await conversation.client.rpc('turn/start', { threadId: conversation.threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      }
    } catch (error) { fail(error); }
  })();
  return { kill() { settled = true; clearTimeout(timer); close(); }, get exited() { return conversation.client?.exited || Promise.resolve(); } };
}
