// The tutor's abilities in Studio.
//
// The coach can act — manage test cases, run the learner's code, point at lines, edit
// code when asked, open a reference panel when asked, keep a note — without ever getting
// file or shell access. It calls a tool by name; Studio validates the arguments, does the
// thing itself, logs it, and shows it in the chat as a receipt the learner can undo.
// That is the whole design: the model asks, the app acts, and nothing the model writes is
// trusted to have done anything until Studio has.
//
// One definition serves both providers: Codex receives TOOL_SPECS as `dynamicTools` on its
// thread and calls back over app-server JSON-RPC (codex-cli.mjs); Claude Code reaches the
// same executor through a per-turn stdio MCP server (studio-mcp.mjs → POST
// /api/coach/tools/call). Either way it ends up in `ToolSession.call` below.
//
// Two kinds of tool:
//  * server-applied (cases, run, note): done here, then announced to the page with an
//    `action` event so it can refresh what it shows;
//  * browser-applied (marks, code edit, panel): announced as a pending `action`, done by
//    the page, which answers POST /api/coach/actions/:id/result. Without an answer within
//    15 s the tool says Studio is not open — a turn never hangs on a closed tab.

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { readCases, writeCases, whyNotRunnable, MAX_CASES, MAX_INPUT_CHARS, MAX_EXPECTED_CHARS, MAX_NOTE_CHARS } from '../runner/cases.mjs';
import { problemCases } from '../runner/case-list.mjs';
import { createRunControl, runCode } from '../runner/run.mjs';
import { readCachedProblem } from './problem-cache.mjs';
import { isoWithOffset } from './sessions.mjs';

export const LIMITS = Object.freeze({
  text: 4000,          // any free-text argument
  code: 20_000,        // edit_code find / replace
  inputBytes: 20 * 1024,
  callsPerTurn: 40,
  marks: 6,
  ackMs: 15_000,
  resultChars: 6000,   // what one tool result hands back to the model
});

const text = (description, maxLength = LIMITS.text) => ({ type: 'string', maxLength, description });
const caseNumber = { type: 'integer', minimum: 1, description: 'The case number as the learner sees it: Case 1, Case 2, … with the LeetCode examples first.' };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

/** What the model is told. Short, and each one says when to use it. */
export const TOOL_SPECS = Object.freeze([
  {
    name: 'get_state',
    description: 'Read the live Studio picture for this problem: parameter names in order, every test case numbered the way the learner sees them (examples first), the latest learner and tutor runs, when solution.py was last saved, and your line marks. Use it before acting if anything may have changed.',
    inputSchema: object({}),
  },
  {
    name: 'add_case',
    description: "Add a test case after the learner's existing ones. Use it to put an edge case in front of them (empty input, k = 0, duplicates, cycles, limits) instead of describing it. Leave expected out when you are not certain, or say in why that it is uncertain.",
    inputSchema: object({
      input: { type: ['object', 'array'], description: 'The arguments: an object keyed by parameter name, or an array of values in parameter order. Values are JSON (lists, numbers, strings, null).' },
      expected: { description: 'The correct answer as a JSON value. Omit when unsure.' },
      why: text('One line the learner sees beside the case: what this case tests.'),
    }, ['input', 'why']),
  },
  {
    name: 'update_case',
    description: 'Change a case the learner or you added (LeetCode examples are read-only). Pass only what changes; expected: null clears it.',
    inputSchema: object({
      case: caseNumber,
      input: { type: ['object', 'array'], description: 'New arguments, as for add_case.' },
      expected: { description: 'New expected answer as a JSON value, or null to clear it.' },
      why: text('New one-line note.'),
    }, ['case']),
  },
  {
    name: 'remove_case',
    description: 'Delete a case the learner or you added. LeetCode examples cannot be removed.',
    inputSchema: object({ case: caseNumber }, ['case']),
  },
  {
    name: 'run_code',
    description: "Run the learner's saved solution.py on their test cases (all, or the listed case numbers) with Studio's local runner and read what really came back: output, expected, verdict, stdout, errors. Verify with it before you claim what their code does. Unsaved editor changes are not included.",
    inputSchema: object({
      cases: { type: 'array', items: caseNumber, maxItems: 40, description: 'Case numbers to run; omit for all.' },
    }),
  },
  {
    name: 'mark_lines',
    description: "Highlight lines in the learner's editor with a short note. tone: bug for the faulty line, hint for where to look, good for what is right. At most 6 marks show; the oldest is dropped. Prefer pointing to rewriting.",
    inputSchema: object({
      from: { type: 'integer', minimum: 1, description: 'First line, 1-based.' },
      to: { type: 'integer', minimum: 1, description: 'Last line, inclusive. Defaults to from.' },
      note: text('What to look at here, in a sentence.', 500),
      tone: { type: 'string', enum: ['hint', 'bug', 'good'] },
    }, ['from', 'note']),
  },
  {
    name: 'clear_marks',
    description: "Remove all your line marks from the learner's editor.",
    inputSchema: object({}),
  },
  {
    name: 'edit_code',
    description: "Change the learner's code in their editor as one undoable edit they watch happen: replace one exact occurrence of find with replace. Only when they asked you to (write the boilerplate, fix this, refactor) or clearly handed you control; make the smallest edit that does it. find must match the editor text exactly, whitespace included, and occur once. An empty find is allowed only when the editor is empty or holds the untouched starter code, and replaces all of it.",
    inputSchema: object({
      find: text('Exact text to replace.', LIMITS.code),
      replace: text('Replacement text.', LIMITS.code),
      why: text('One line saying what you changed.'),
    }, ['find', 'replace', 'why']),
  },
  {
    name: 'open_panel',
    description: 'Open the reference solution or the written article beside the editor. Only when the learner asks for it.',
    inputSchema: object({ panel: { type: 'string', enum: ['solution', 'article'] } }, ['panel']),
  },
  {
    name: 'save_note',
    description: "Append a dated entry to this problem's NOTES.md: something durable about how the learner approaches this problem, worth reading next time.",
    inputSchema: object({ text: text('The note, in a few sentences.') }, ['text']),
  },
]);

export const TOOL_NAMES = Object.freeze(TOOL_SPECS.map((t) => t.name));
const SPEC_BY_NAME = new Map(TOOL_SPECS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------------------
// Argument validation: the subset of JSON Schema the specs above use, nothing more.
// ---------------------------------------------------------------------------------------

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

function check(schema, value, where) {
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => matchesType(value, t))) {
      const wanted = types.map((t) => (t === 'integer' ? 'a whole number' : `a${/^[aeiou]/.test(t) ? 'n' : ''} ${t}`)).join(' or ');
      return `${where} must be ${wanted}.`;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) return `${where} must be one of: ${schema.enum.join(', ')}.`;
  if (typeof value === 'string' && schema.maxLength && value.length > schema.maxLength) {
    return `${where} is ${value.length} characters; the limit is ${schema.maxLength}.`;
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) return `${where} must be at least ${schema.minimum}.`;
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${where} has more than ${schema.maxItems} items.`;
    if (schema.items) {
      for (const [i, item] of value.entries()) {
        const why = check(schema.items, item, `${where}[${i}]`);
        if (why) return why;
      }
    }
  }
  if (typeOf(value) === 'object' && schema.properties) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) return `"${key}" is required.`;
    }
    for (const [key, item] of Object.entries(value)) {
      const sub = schema.properties[key];
      if (!sub) {
        if (schema.additionalProperties === false) return `"${key}" is not an argument of this tool.`;
        continue;
      }
      const why = check(sub, item, `"${key}"`);
      if (why) return why;
    }
  }
  return null;
}

/** @returns {{ok:true, args:object} | {ok:false, message:string}} */
export function validateArgs(name, args) {
  const spec = SPEC_BY_NAME.get(name);
  if (!spec) return { ok: false, message: `There is no Studio tool called "${String(name).slice(0, 60)}".` };
  const value = args ?? {};
  const why = check(spec.inputSchema, value, 'The arguments');
  if (why) return { ok: false, message: why };
  for (const key of ['input', 'expected']) {
    if (value[key] !== undefined && JSON.stringify(value[key]).length > LIMITS.inputBytes) {
      return { ok: false, message: `"${key}" is larger than the ${LIMITS.inputBytes / 1024} KB Studio accepts.` };
    }
  }
  if (name === 'mark_lines' && value.to !== undefined && value.to < value.from) {
    return { ok: false, message: '"to" must not be before "from".' };
  }
  return { ok: true, args: value };
}

// ---------------------------------------------------------------------------------------
// Turning tool arguments into the stored case format (one JSON value per line, expected
// as a JSON string) — exactly what the testcases PUT route stores.
// ---------------------------------------------------------------------------------------

/** @returns {{ok:true, text:string} | {ok:false, message:string}} */
export function inputToText(input, params, perCase) {
  let values;
  if (Array.isArray(input)) {
    values = input;
  } else {
    const keys = Object.keys(input);
    const missing = params.filter((p) => !(p in input));
    const extra = keys.filter((k) => !params.includes(k));
    if (missing.length || extra.length) {
      return { ok: false, message: `The input must name exactly these parameters: ${params.join(', ')}.${extra.length ? ` Unknown: ${extra.join(', ')}.` : ''}` };
    }
    values = params.map((p) => input[p]);
  }
  if (values.length !== perCase) {
    return { ok: false, message: `This problem takes ${perCase} value${perCase === 1 ? '' : 's'} per case (${params.join(', ')}); got ${values.length}.` };
  }
  if (values.some((v) => v === undefined)) return { ok: false, message: 'Every input value must be JSON.' };
  const textValue = values.map((v) => JSON.stringify(v)).join('\n');
  if (textValue.length > MAX_INPUT_CHARS) {
    return { ok: false, message: `That input is ${textValue.length} characters; Studio keeps cases up to ${MAX_INPUT_CHARS}.` };
  }
  const why = whyNotRunnable(textValue, perCase);
  return why ? { ok: false, message: why } : { ok: true, text: textValue };
}

/** undefined → leave alone; null → none; a string that is JSON is kept as written. */
export function expectedToText(expected) {
  if (expected === undefined) return { ok: true, text: undefined };
  if (expected === null) return { ok: true, text: null };
  let out;
  if (typeof expected === 'string') {
    try {
      JSON.parse(expected);
      out = expected.trim();
    } catch {
      out = JSON.stringify(expected); // a plain string answer, e.g. "bab"
    }
  } else {
    out = JSON.stringify(expected);
  }
  if (out.length > MAX_EXPECTED_CHARS) {
    return { ok: false, message: `That expected value is ${out.length} characters; Studio keeps up to ${MAX_EXPECTED_CHARS}.` };
  }
  return { ok: true, text: out };
}

const SOURCE_LABEL = { example: 'example', custom: 'yours', leetcode: 'failed submission', coach: 'tutor' };

function clip(value, limit) {
  const s = String(value ?? '');
  return s.length > limit ? `${s.slice(0, limit)}… (${s.length - limit} more characters)` : s;
}

function oneLine(value, limit = 120) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

/** "nums = [3,2,4]; target = 6" from the stored lines. */
function describeInput(input, params) {
  const lines = String(input ?? '').split('\n').filter((l) => l.trim() !== '');
  return lines.map((line, i) => (params[i] ? `${params[i]} = ${line.trim()}` : line.trim())).join('; ');
}

function capText(textValue) {
  return textValue.length > LIMITS.resultChars
    ? `${textValue.slice(0, LIMITS.resultChars)}\n… (cut at ${LIMITS.resultChars} characters)`
    : textValue;
}

/** The runner's response as text the model can quote from. */
export function renderRun(result, numbers, params) {
  const lines = [];
  const summary = result?.summary ?? {};
  if (result?.error) {
    lines.push(`It did not run (${result.error.kind}): ${result.error.message}`);
    if (result.error.traceback) lines.push(clip(result.error.traceback, 1500));
  } else {
    const failed = (result?.cases ?? []).filter((c) => c.passed === false).length;
    lines.push(`Ran the saved solution.py on ${numbers.length} case${numbers.length === 1 ? '' : 's'}: ${summary.passed ?? 0} passed, ${failed} failed (${summary.totalMs ?? '?'} ms).`);
  }
  for (const [i, c] of (result?.cases ?? []).entries()) {
    const n = numbers[i] ?? i + 1;
    const verdict = c.passed === true ? 'passed' : c.passed === false ? (c.error ? `ERROR (${c.error.kind})` : 'FAILED') : 'no verdict (no expected value to compare)';
    lines.push('', `Case ${n} — ${verdict}${Number.isFinite(c.ms) ? ` (${c.ms} ms)` : ''}`);
    lines.push(`  input:    ${clip(describeInput(c.input, params), 600)}`);
    if (c.expected !== null && c.expected !== undefined) lines.push(`  expected: ${clip(c.expected, 400)}`);
    if (c.actual !== null && c.actual !== undefined) lines.push(`  output:   ${clip(c.actual, 400)}`);
    if (c.note) lines.push(`  note:     ${clip(c.note, 200)}`);
    if (c.stdout) lines.push(`  stdout:   ${clip(String(c.stdout).trim(), 300).replace(/\n/g, '\n            ')}`);
    if (c.error?.message) lines.push(`  error:    ${clip(c.error.message, 300)}`);
    if (c.error?.traceback && c.passed !== true) lines.push(clip(c.error.traceback, 800));
  }
  return capText(lines.join('\n'));
}

// ---------------------------------------------------------------------------------------
// The store: every action, for as long as an Undo or a late answer might reference it.
// One per workspace (CoachService), outliving the turns that created them.
// ---------------------------------------------------------------------------------------

export const MAX_STORED_ACTIONS = 400;

let seq = 0;
function actionId() {
  seq += 1;
  return `act-${Date.now().toString(36)}-${seq}-${crypto.randomBytes(3).toString('hex')}`;
}

export class ActionStore {
  constructor() {
    this.byId = new Map();
    this.marks = new Map(); // slug → [{from, to, note, tone}], what Studio last placed
    this.locks = new Map();
  }

  add(record) {
    this.byId.set(record.id, record);
    while (this.byId.size > MAX_STORED_ACTIONS) {
      const oldest = this.byId.keys().next().value;
      this.byId.delete(oldest);
    }
    return record;
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  /** Case changes for one problem, one at a time: a tool call and an Undo must not race. */
  withLock(slug, fn) {
    const previous = this.locks.get(slug) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(slug, next.catch(() => {}));
    return next;
  }

  /**
   * The page's answer to a browser-applied action. First answer wins.
   * @returns {'accepted'|'unknown'|'settled'}
   */
  answer(id, { ok, message }) {
    const record = this.get(id);
    if (!record) return 'unknown';
    if (record.payload.status !== 'pending' || !record.waiter) return 'settled';
    record.waiter({ ok: ok === true, message: oneLine(message, 400) });
    return 'accepted';
  }

  /**
   * Undo one tutor case change in place, preserving independent later edits.
   * @returns {Promise<{status:number, body:object}>}
   */
  undo(id) {
    const record = this.get(id);
    if (!record) return Promise.resolve({ status: 404, body: { ok: false, message: 'That action is no longer held by Studio, so it cannot be undone here.' } });
    if (record.payload.undo !== 'server') {
      const message = record.payload.undo === 'browser'
        ? 'A code edit is undone in the editor, not by Studio.'
        : 'That action has nothing to undo.';
      return Promise.resolve({ status: 400, body: { ok: false, message } });
    }
    return this.withLock(record.slug, async () => {
      if (record.undone) return { status: 409, body: { ok: false, message: 'That change was already undone.' } };
      const current = await readCases({ root: record.root, slug: record.slug });
      const same = (a, b) => a && b && a.input === b.input && a.expected === b.expected
        && a.note === b.note && a.source === b.source;
      let restored;
      if (record.undoKind === 'add') {
        const index = current.findLastIndex((c) => same(c, record.case));
        if (index === -1) return { status: 409, body: { ok: false, message: 'That case was already changed or removed, so there is nothing to undo.' } };
        restored = current.slice(0, index).concat(current.slice(index + 1));
      } else if (record.undoKind === 'remove') {
        if (current.some((c) => same(c, record.case))) {
          return { status: 409, body: { ok: false, message: 'That case was already changed or restored, so there is nothing to undo.' } };
        }
        if (current.length >= MAX_CASES) {
          return { status: 409, body: { ok: false, message: 'The case list is full. Remove a case before undoing this removal.' } };
        }
        const index = Math.min(record.index, current.length);
        restored = current.slice();
        restored.splice(index, 0, record.case);
      } else if (record.undoKind === 'update') {
        const index = current.findIndex((c) => same(c, record.afterCase));
        if (index === -1) return { status: 409, body: { ok: false, message: 'That case was edited since the tutor made this change, so there is nothing to undo.' } };
        restored = current.slice();
        restored[index] = record.beforeCase;
      } else {
        return { status: 409, body: { ok: false, message: 'That case was already changed or removed, so there is nothing to undo.' } };
      }
      await writeCases({ root: record.root, slug: record.slug, cases: restored });
      record.undone = true;
      record.payload.undone = true;
      return { status: 200, body: { ok: true, refresh: 'cases' } };
    });
  }
}

// ---------------------------------------------------------------------------------------
// One turn's tool session.
// ---------------------------------------------------------------------------------------

const NOT_DONE = {
  mark_lines: 'the lines were not marked',
  clear_marks: 'the marks were not cleared',
  edit_code: 'the code edit was not made',
  open_panel: 'the panel was not opened',
};

function lineSpan(from, to) {
  return to && to !== from ? `lines ${from}–${to}` : `line ${from}`;
}

/**
 * @param {object} o
 * @param {string} o.root           workspace root
 * @param {string} o.slug
 * @param {ActionStore} o.store
 * @param {import('./runs.mjs').CoachRuns} [o.runs]  where `action` events go
 * @param {object} [o.run]          the run they belong to
 * @param {object} [o.sessionLog]   for coach_ran_code / coach_edited_code / get_state's runs
 * @param {object} [o.leetcode]     the content cache, read cache-only
 * @param {Function} [o.runner]     runCode, injectable for tests
 */
export function createToolSession({
  root, slug, store, runs = null, run = null, sessionLog = null, catalogEntry = null, leetcode = null,
  runner = runCode, ackTimeoutMs = LIMITS.ackMs, log = console, now = () => Date.now(),
}) {
  const records = [];
  const controls = new Set();
  let calls = 0;
  let closed = false;

  function emit(record) {
    if (runs && run) runs.action(run, record.payload);
  }

  function record(tool, args, fields) {
    const id = actionId();
    const payload = { id, tool, args, slug, needsAck: false, summary: '', undo: null, status: 'done', ...fields, id };
    const rec = store.add({ id, slug, root, tool, payload, waiter: null, undone: false });
    records.push(rec);
    return rec;
  }

  async function loadList() {
    const problem = await readCachedProblem({ leetcode, root, slug, catalogEntry });
    if (!problem) return { error: 'Studio has no cached copy of this problem yet, so it cannot work with its test cases. The learner needs to open the problem once.' };
    const list = problemCases(problem, slug);
    if (!list.runnable) return { error: `The local runner cannot drive this problem, so it has no test cases to work with: ${list.reason}` };
    const mine = await readCases({ root, slug });
    return { problem, list, mine, all: [...list.examples, ...mine] };
  }

  function addedIndex(L, n) {
    const examples = L.list.examples.length;
    if (n > L.all.length) return { error: `There is no Case ${n}; the learner has ${L.all.length}.` };
    if (n <= examples) return { error: `Case ${n} is a LeetCode example, and examples are read-only. Add a new case instead.` };
    return { index: n - examples - 1 };
  }

  function noteFrom(why) {
    const line = oneLine(why, 1000);
    return line.length > MAX_NOTE_CHARS ? `${line.slice(0, MAX_NOTE_CHARS - 1)}…` : line;
  }

  async function changeCases(tool, args, build) {
    return store.withLock(slug, async () => {
      const L = await loadList();
      if (L.error) return { ok: false, text: L.error };
      const change = build(L);
      if (change.error) return { ok: false, text: change.error };
      await writeCases({ root, slug, cases: change.cases });
      const rec = record(tool, args, { summary: change.summary, refresh: 'cases', undo: 'server', ...(change.select ? { select: change.select } : {}) });
      if (change.undoKind) Object.assign(rec, change.undoKind);
      emit(rec);
      return { ok: true, text: change.text };
    });
  }

  const handlers = {
    async get_state() {
      const L = await loadList();
      const lines = [];
      const problem = L.problem ?? null;
      lines.push(`Problem: ${catalogEntry?.title ?? problem?.title ?? slug} (${slug})`);
      if (L.error) {
        lines.push(L.error);
      } else {
        const params = L.list.params;
        lines.push(`Parameters, in order: ${params.join(', ') || '(none)'}`);
        lines.push(`Cases, numbered as the learner sees them (examples are read-only; ${L.mine.length} of ${MAX_CASES} added cases used):`);
        for (const [i, c] of L.all.entries()) {
          const label = SOURCE_LABEL[c.source] ?? c.source;
          lines.push(`Case ${i + 1} — ${label}${c.note ? `: "${oneLine(c.note, 200)}"` : ''}`);
          lines.push(`  ${clip(describeInput(c.input, params), 400)}`);
          lines.push(`  expected: ${c.expected === null || c.expected === undefined ? '(none)' : clip(c.expected, 200)}`);
        }
      }
      if (sessionLog) {
        const [learner, tutor] = await Promise.all([
          sessionLog.latestEventOfType(slug, 'run_result').catch(() => null),
          sessionLog.latestEventOfType(slug, 'coach_ran_code').catch(() => null),
        ]);
        const describe = (e) => {
          const d = e?.data ?? {};
          if (d.errorKind) return `did not run (${d.errorKind}), at ${e.at}`;
          if (Number.isFinite(d.passed) && Number.isFinite(d.total)) return `${d.passed} of ${d.total} passed, at ${e.at}`;
          return `recorded at ${e.at}`;
        };
        lines.push(`Learner's last local run: ${learner ? describe(learner) : 'none recorded'}`);
        lines.push(`Your last run_code: ${tutor ? describe(tutor) : 'none'}`);
      }
      try {
        const stat = await fsp.stat(path.join(root, 'problems', slug, 'solution.py'));
        const minutes = Math.round((now() - stat.mtimeMs) / 60_000);
        lines.push(`solution.py: last saved ${minutes < 1 ? 'less than a minute' : `${minutes} minute${minutes === 1 ? '' : 's'}`} ago. The editor may hold newer unsaved text.`);
      } catch {
        lines.push('solution.py: not saved yet.');
      }
      const marks = store.marks.get(slug) ?? [];
      lines.push(marks.length
        ? `Your line marks (the learner may have dismissed some): ${marks.map((m) => `${lineSpan(m.from, m.to)} (${m.tone}) "${oneLine(m.note, 80)}"`).join('; ')}`
        : 'Your line marks: none.');
      return { ok: true, text: capText(lines.join('\n')) };
    },

    add_case(args) {
      return changeCases('add_case', args, (L) => {
        if (L.mine.length >= MAX_CASES) return { error: `The learner already has ${MAX_CASES} added cases, the most Studio keeps. Remove one first.` };
        const input = inputToText(args.input, L.list.params, L.list.perCase);
        if (!input.ok) return { error: input.message };
        const expected = expectedToText(args.expected);
        if (!expected.ok) return { error: expected.message };
        const twin = L.all.findIndex((c) => String(c.input).trim() === input.text);
        if (twin !== -1) return { error: `Case ${twin + 1} already has exactly that input.` };
        const note = noteFrom(args.why);
        const n = L.all.length + 1;
        const added = { input: input.text, expected: expected.text ?? null, source: 'coach', at: isoWithOffset(new Date(now())), note };
        return {
          cases: [...L.mine, added],
          undoKind: { undoKind: 'add', case: added },
          summary: `Added Case ${n}: ${oneLine(note, 100)}`,
          select: n,
          text: `Added Case ${n}: ${describeInput(input.text, L.list.params)}; expected ${expected.text ?? '(none)'}. The learner sees it in their case list with your note.`,
        };
      });
    },

    update_case(args) {
      return changeCases('update_case', args, (L) => {
        const at = addedIndex(L, args.case);
        if (at.error) return { error: at.error };
        const next = { ...L.mine[at.index] };
        if (args.input !== undefined) {
          const input = inputToText(args.input, L.list.params, L.list.perCase);
          if (!input.ok) return { error: input.message };
          next.input = input.text;
        }
        if (args.expected !== undefined) {
          const expected = expectedToText(args.expected);
          if (!expected.ok) return { error: expected.message };
          next.expected = expected.text;
        }
        if (args.why !== undefined) next.note = noteFrom(args.why);
        if (args.input === undefined && args.expected === undefined && args.why === undefined) {
          return { error: 'Nothing to change: pass input, expected or why.' };
        }
        const cases = L.mine.slice();
        cases[at.index] = next;
        return {
          cases,
          undoKind: { undoKind: 'update', beforeCase: L.mine[at.index], afterCase: next },
          summary: `Changed Case ${args.case}`,
          select: args.case,
          text: `Case ${args.case} is now ${describeInput(next.input, L.list.params)}; expected ${next.expected ?? '(none)'}.`,
        };
      });
    },

    remove_case(args) {
      return changeCases('remove_case', args, (L) => {
        const at = addedIndex(L, args.case);
        if (at.error) return { error: at.error };
        const gone = L.mine[at.index];
        return {
          cases: L.mine.filter((_, i) => i !== at.index),
          undoKind: { undoKind: 'remove', case: gone, index: at.index },
          summary: `Removed Case ${args.case}`,
          text: `Removed Case ${args.case} (${describeInput(gone.input, L.list.params)}). Later cases each moved up one number.`,
        };
      });
    },

    async run_code(args) {
      const L = await loadList();
      if (L.error) return { ok: false, text: L.error };
      let code = null;
      try { code = await fsp.readFile(path.join(root, 'problems', slug, 'solution.py'), 'utf8'); } catch { /* none yet */ }
      if (!code || !code.trim()) return { ok: false, text: 'There is no saved solution.py for this problem yet, so there is nothing to run.' };
      const numbers = args.cases?.length ? [...new Set(args.cases)] : L.all.map((_, i) => i + 1);
      const missing = numbers.filter((n) => n > L.all.length);
      if (missing.length) return { ok: false, text: `There is no Case ${missing[0]}; the learner has ${L.all.length}.` };
      const chosen = numbers.map((n) => L.all[n - 1]);

      const control = createRunControl();
      controls.add(control);
      let result;
      try {
        // The same runner POST /api/run uses, on the same list the Run button would send:
        // every case's input joined in order, with the expected values aligned to them.
        result = await runner({
          code,
          slug,
          metaData: L.problem.metaData,
          testcases: chosen.map((c) => String(c.input).trim()).join('\n'),
          expectedOverrides: chosen.map((c) => c.expected ?? null),
          exampleTestcases: L.problem.exampleTestcases,
          descriptionHtml: L.problem.descriptionHtml,
          pythonStub: L.problem.pythonStub,
          control,
        });
      } finally {
        controls.delete(control);
      }
      if (closed && control.cancelled) return { ok: false, text: 'The run was stopped because the reply ended.' };

      const s = result?.summary ?? {};
      await sessionLog?.appendEvent(slug, 'coach_ran_code', {
        ok: result?.ok === true,
        passed: s.passed ?? null,
        total: s.total ?? null,
        totalMs: s.totalMs ?? null,
        errorKind: result?.error?.kind ?? null,
        cases: numbers,
      }).catch(() => {});

      const summary = result?.error
        ? `Ran your saved code: it did not run (${result.error.kind})`
        : `Ran your saved code: ${s.passed ?? 0} of ${s.total ?? chosen.length} passed`;
      const rec = record('run_code', args, { summary, refresh: 'run', caseNumbers: numbers });
      rec.payload.run = { runId: rec.id, ...result };
      emit(rec);
      return { ok: true, text: renderRun(result, numbers, L.list.params) };
    },

    mark_lines(args) {
      const tone = args.tone ?? 'hint';
      const mark = { from: args.from, to: args.to ?? args.from, note: args.note, tone };
      return browserAction('mark_lines', { ...args, to: mark.to, tone }, `Marked ${lineSpan(mark.from, mark.to)}: ${oneLine(args.note, 80)}`, null, () => {
        const marks = [...(store.marks.get(slug) ?? []), mark].slice(-LIMITS.marks);
        store.marks.set(slug, marks);
      });
    },

    clear_marks(args) {
      return browserAction('clear_marks', args, 'Cleared the line marks', null, () => store.marks.delete(slug));
    },

    edit_code(args) {
      if (args.find === args.replace) return { ok: false, text: 'find and replace are the same, so there is nothing to change.' };
      return browserAction('edit_code', args, `Edited your code: ${oneLine(args.why, 100)}`, 'browser', () => {
        const count = (s) => (s === '' ? 0 : s.split('\n').length);
        return sessionLog?.appendEvent(slug, 'coach_edited_code', {
          why: oneLine(args.why, 400), added: count(args.replace), removed: count(args.find),
        }).catch(() => {});
      });
    },

    open_panel(args) {
      return browserAction('open_panel', args, args.panel === 'solution' ? 'Opened the reference solution' : 'Opened the article', null);
    },

    async save_note(args) {
      const file = path.join(root, 'problems', slug, 'NOTES.md');
      const stamp = isoWithOffset(new Date(now())).slice(0, 16).replace('T', ' ');
      let existing = '';
      try { existing = await fsp.readFile(file, 'utf8'); } catch { /* first note */ }
      const lead = existing === '' ? `# ${catalogEntry?.title ?? slug}\n` : existing.endsWith('\n') ? '' : '\n';
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.appendFile(file, `${lead}\n### ${stamp} (tutor note)\n${String(args.text).trim()}\n`, 'utf8');
      const rec = record('save_note', args, { summary: `Saved a note: ${oneLine(args.text, 80)}` });
      emit(rec);
      return { ok: true, text: `Saved to problems/${slug}/NOTES.md.` };
    },
  };

  /** Hand a browser-applied action to the page and wait for its answer. */
  async function browserAction(tool, args, summary, undo, onDone = () => {}) {
    const rec = record(tool, args, { needsAck: true, summary, undo, status: 'pending' });
    const notOpen = `Studio is not open on this problem, so ${NOT_DONE[tool]}.`;
    const settle = (ok, message) => {
      rec.waiter = null;
      rec.payload.status = ok ? 'done' : 'failed';
      if (message) rec.payload.message = message;
      emit(rec);
    };
    if (!runs || !run || run.subscribers.size === 0) {
      settle(false, notOpen);
      return { ok: false, text: notOpen };
    }
    let timer;
    const answer = await new Promise((resolve) => {
      rec.waiter = resolve;
      emit(rec);
      // Not unref'd: this wait is what the turn is doing, and it ends within ackTimeoutMs.
      timer = setTimeout(() => resolve(null), ackTimeoutMs);
    });
    clearTimeout(timer);
    if (answer === null) {
      settle(false, notOpen);
      return { ok: false, text: notOpen };
    }
    if (answer.ended) {
      settle(false, answer.message);
      return { ok: false, text: answer.message };
    }
    if (!answer.ok) {
      settle(false, answer.message || 'Studio could not do it.');
      return { ok: false, text: `Studio could not do that: ${answer.message || 'no reason given.'}` };
    }
    await onDone();
    settle(true, answer.message || null);
    return { ok: true, text: `Done: ${summary}.${answer.message ? ` ${answer.message}` : ''}` };
  }

  return {
    /** @returns {Promise<{ok:boolean, text:string}>} never rejects */
    async call(tool, args) {
      if (closed) return { ok: false, text: 'This reply has ended, so Studio did not do that.' };
      calls += 1;
      if (calls > LIMITS.callsPerTurn) {
        return { ok: false, text: `That is more than ${LIMITS.callsPerTurn} Studio actions in one reply; Studio stopped doing them. Finish the reply.` };
      }
      const checked = validateArgs(tool, args);
      if (!checked.ok) return { ok: false, text: checked.message };
      try {
        return await handlers[tool](checked.args);
      } catch (err) {
        log?.warn?.(`[coach] tool ${tool} on ${slug} failed: ${err?.message ?? err}`);
        return { ok: false, text: 'Studio could not do that because of an internal error. Nothing else was changed.' };
      }
    },

    /** Receipts for the turn record: [{id, tool, summary, ok}]. */
    get actions() {
      return records.map((r) => ({ id: r.id, tool: r.tool, summary: r.payload.summary, ok: r.payload.status === 'done' }));
    },

    /** End of turn: refuse further calls, stop a run in flight, release pending waits. */
    dispose() {
      if (closed) return;
      closed = true;
      for (const control of controls) control.cancel();
      const message = 'The reply ended before Studio answered, so it was not done.';
      for (const r of records) {
        if (!r.waiter) continue;
        // Settled here, synchronously, so a page re-attaching to the finished run gets a
        // failed receipt rather than a pending action it would go and apply.
        r.payload.status = 'failed';
        r.payload.message = message;
        r.waiter({ ok: false, ended: true, message });
      }
    },
  };
}
