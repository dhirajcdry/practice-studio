// Server-Sent Events framing. Hand-rolled, because the format is six lines of spec and
// a dependency here would be a supply-chain question for no benefit.
//
// The one rule that matters: an event is a block of `field: value` lines terminated by a
// blank line. A value containing a newline must be split across multiple `data:` lines,
// otherwise the blank line inside it terminates the event early and the client sees a
// truncated, syntactically valid, wrong message. That is the corruption this file exists
// to prevent.

/**
 * Frame one event. `data` may contain newlines and CRLFs; both are normalised and split.
 * @param {string} event event name
 * @param {string} data payload
 * @returns {string}
 */
export function frameEvent(event, data) {
  const lines = String(data).split(/\r\n|\r|\n/);
  let out = `event: ${event}\n`;
  for (const line of lines) out += `data: ${line}\n`;
  return `${out}\n`;
}

/** Frame an event whose payload is JSON. JSON.stringify never emits a raw newline, but
 *  framing still goes through frameEvent so there is exactly one code path. */
export function frameJson(event, value) {
  return frameEvent(event, JSON.stringify(value));
}

/**
 * An open SSE response. Writes are ignored once the stream is closed, so a late token
 * from a child that has not noticed the disconnect yet cannot throw.
 */
export class SseStream {
  /** @param {import('node:http').ServerResponse} res */
  constructor(res) {
    this.res = res;
    this.closed = false;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // Belt and braces for any proxy that ever ends up in front of this.
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    // Flush headers immediately so the browser's EventSource opens rather than waiting
    // for the first token, which can be seconds away while the model thinks.
    res.write(': open\n\n');
    res.flushHeaders?.();
  }

  /** @param {string} event @param {unknown} value */
  send(event, value) {
    if (this.closed) return false;
    try {
      this.res.write(frameJson(event, value));
      return true;
    } catch {
      this.closed = true;
      return false;
    }
  }

  token(text) {
    return this.send('token', { text });
  }

  tool(name, summary) {
    return this.send('tool', { name, summary });
  }

  done(sessionId, stoppedReason) {
    return this.send('done', { sessionId, stoppedReason });
  }

  /** One error event, in plain English, and that is the end of the stream. */
  error(message) {
    const ok = this.send('error', { message });
    this.end();
    return ok;
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.res.end();
    } catch {
      /* already torn down */
    }
  }
}
