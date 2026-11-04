// Shared by coding, LLD, design, and post-interview questions. A truncated stream is
// a visible failure, never a successful empty reply. Readers may reconnect to records.
export async function streamInterviewRequest(url, body, onEvent) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const error = Error(result?.error?.message || `Interview request failed (${response.status}).`);
    error.status = response.status; throw error;
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.json();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', completed = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done && buffer.trim()) buffer += '\n\n';
      buffer = buffer.replace(/\r\n/g, '\n');
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        const name = block.match(/^event: ?(.+)$/m)?.[1] || 'message';
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const payload = JSON.parse(data);
        if (name === 'error') throw Error(payload.message || 'The interviewer could not finish this turn.');
        if (name === 'done') completed = true;
        onEvent(name, payload);
      }
      if (done) break;
    }
    if (!completed) throw Error('The connection ended. Your saved interview is still open.');
    return { interjected: true };
  } finally { reader.releaseLock(); }
}
