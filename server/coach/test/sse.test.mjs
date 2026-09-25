import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { frameEvent, frameJson, SseStream } from '../sse.mjs';

test('frameEvent puts every payload line on its own data: line', () => {
  const framed = frameEvent('token', 'one\ntwo\n\nfour');
  assert.equal(framed, 'event: token\ndata: one\ndata: two\ndata: \ndata: four\n\n');
});

test('frameEvent normalises CRLF and lone CR — a stray \\r must not split an event badly', () => {
  assert.equal(frameEvent('x', 'a\r\nb\rc'), 'event: x\ndata: a\ndata: b\ndata: c\n\n');
});

test('an event block is terminated by exactly one blank line', () => {
  const framed = frameEvent('done', '{}');
  // Precisely one empty line at the end: two \n and nothing else.
  assert.ok(framed.endsWith('\n\n'));
  assert.ok(!framed.endsWith('\n\n\n'));
});

test('multi-line payloads survive a round trip through a strict SSE parser', () => {
  const payloads = ['plain', 'with\nnewlines', 'trailing\n', '\nleading', 'blank\n\nline', ''];
  const wire = payloads.map((p) => frameEvent('token', p)).join('');

  // A deliberately pedantic parser: split on blank lines, join data lines with \n.
  const parsed = [];
  for (const block of wire.split('\n\n')) {
    if (block.trim() === '') continue;
    const lines = block.split('\n');
    const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
    const data = lines
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(l.startsWith('data: ') ? 6 : 5))
      .join('\n');
    parsed.push({ event, data });
  }

  assert.equal(parsed.length, payloads.length);
  for (let i = 0; i < payloads.length; i += 1) {
    assert.equal(parsed[i].event, 'token');
    assert.equal(parsed[i].data, payloads[i]);
  }
});

test('JSON payloads never contain a raw newline, so one event is always one data line', () => {
  const framed = frameJson('token', { text: 'a\nb\r\nc' });
  const dataLines = framed.split('\n').filter((l) => l.startsWith('data:'));
  assert.equal(dataLines.length, 1);
  assert.deepEqual(JSON.parse(dataLines[0].slice(6)), { text: 'a\nb\r\nc' });
});

function fakeRes() {
  const out = new PassThrough();
  let chunks = '';
  out.on('data', (c) => {
    chunks += c;
  });
  return {
    writeHead() {},
    write(s) {
      out.write(s);
      return true;
    },
    end() {
      out.end();
    },
    get text() {
      return chunks;
    },
  };
}

test('SseStream emits the four contract event names with the contract payloads', () => {
  const res = fakeRes();
  const s = new SseStream(res);
  s.token('hi');
  s.tool('Read', 'NOTES.md');
  s.done('sess-1', 'end_turn');
  assert.match(res.text, /^: open\n\n/);
  assert.ok(res.text.includes('event: token\ndata: {"text":"hi"}\n\n'));
  assert.ok(res.text.includes('event: tool\ndata: {"name":"Read","summary":"NOTES.md"}\n\n'));
  assert.ok(
    res.text.includes('event: done\ndata: {"sessionId":"sess-1","stoppedReason":"end_turn"}\n\n'),
  );
});

test('writes after close are dropped rather than throwing', () => {
  const res = fakeRes();
  const s = new SseStream(res);
  s.error('gone wrong');
  const before = res.text;
  assert.equal(s.token('late'), false);
  assert.equal(res.text, before);
  assert.ok(before.includes('event: error\ndata: {"message":"gone wrong"}\n\n'));
});
