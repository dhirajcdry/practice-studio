#!/usr/bin/env node
// The "studio" MCP server Claude Code starts for one coach turn.
//
// It does nothing itself. It lists Studio's tools (TOOL_SPECS) and forwards each call to
// the running Studio server — POST STUDIO_TOOLS_URL with this turn's STUDIO_TOOLS_TOKEN —
// which validates and performs it exactly as it would for Codex. So Claude gets the same
// abilities with no file or shell access of its own, and the token dies with the turn.
//
// Transport: MCP over stdio, newline-delimited JSON-RPC 2.0. Hand-rolled because the
// protocol surface used here is five methods and the repo takes no dependencies.

import { createInterface } from 'node:readline';
import { TOOL_SPECS } from './tools.mjs';

export const PROTOCOL_VERSION = '2025-06-18';
const CALL_TIMEOUT_MS = 120_000; // a run_code over 25 cases, or a 15 s browser answer, fits

const url = process.env.STUDIO_TOOLS_URL;
const token = process.env.STUDIO_TOOLS_TOKEN;

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function textResult(text, isError) {
  return { content: [{ type: 'text', text }], isError };
}

async function callStudio(name, args) {
  if (!url || !token) return textResult('Studio tools are not connected for this turn.', true);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, tool: name, arguments: args ?? {} }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 403) return textResult('This turn has ended, so Studio no longer accepts actions from it.', true);
    if (!res.ok || !body || typeof body.text !== 'string') {
      return textResult(body?.error?.message ?? `Studio could not do that (HTTP ${res.status}).`, true);
    }
    return textResult(body.text, body.ok !== true);
  } catch {
    return textResult('Studio could not be reached, so that was not done.', true);
  }
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize':
      return isRequest && send({ id, result: {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'studio', title: 'Practice Studio', version: '0.1.0' },
      } });
    case 'ping':
      return isRequest && send({ id, result: {} });
    case 'tools/list':
      return isRequest && send({ id, result: {
        tools: TOOL_SPECS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      } });
    case 'tools/call': {
      if (!isRequest) return undefined;
      const result = await callStudio(params?.name, params?.arguments);
      return send({ id, result });
    }
    default:
      // Notifications (notifications/initialized, cancellations) need no answer.
      if (isRequest) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      return undefined;
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  handle(message).catch(() => {
    if (message?.id !== undefined) send({ id: message.id, error: { code: -32603, message: 'Internal error' } });
  });
});
