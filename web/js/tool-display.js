// Plain wording for the coach's tools, by tool name.
//
// The wording lives with the tool definitions on the server (TOOL_SPECS[*].display), so a
// new tool cannot ship without it and a saved turn only ever needs to remember the tool's
// name. The page reads the whole table once at startup and resolves names from it.

const UNKNOWN = Object.freeze({ doing: 'Using a tool', done: 'Used a tool', effect: 'read' });
let table = null, unknown = UNKNOWN, loading = null;

export const toolName = name => String(name ?? '').replace(/^mcp__studio__/, '');

/** Fetch the table once. Never rejects: without it every step reads as a generic one. */
export function loadToolDisplay() {
  loading ??= fetch('/api/coach/tool-display', { headers: { accept: 'application/json' } })
    .then(response => response.ok ? response.json() : null)
    .then(data => { if (data?.tools) { table = data.tools; unknown = data.unknown || UNKNOWN; } })
    .catch(() => {});
  return loading;
}

/** Tests and fixtures supply the table directly. */
export function setToolDisplay(tools, fallback = UNKNOWN) { table = tools; unknown = fallback; }

/** `{ doing, done, effect }` for a tool. An unknown tool gets safe generic wording, never its name. */
export function displayFor(name) {
  return table?.[toolName(name)] || unknown;
}
