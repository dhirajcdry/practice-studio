// The orchestrator: problem + code in, the contract's /api/run body out.
//
// Every failure mode in docs/API-CONTRACT-P2.md is a first-class result here. Nothing in
// this file throws for a bad user program, an infinite loop, a broken metaData or a
// missing python3 — those are all answers, not exceptions.
//
// Reference solutions under vendor/ are never executed. Nothing in this module reads them;
// the only code that ever reaches python3 is the `code` string on the request.

import fsp from 'node:fs/promises';
import path from 'node:path';

import { adaptedExpected, normaliseQuadTree } from './adapters.mjs';
import { classifyProblem, isNodeType, parseMetaData } from './meta.mjs';
import { buildCases } from './testcases.mjs';
import { compareValues, formatValue } from './compare.mjs';
import { rewriteTraceback, summarize } from './traceback.mjs';
import {
  DEFAULT_OUTPUT_CAP,
  DEFAULT_TIMEOUT_MS,
  killGroup,
  makeWorkspace,
  readResult,
  removeWorkspace,
  runDriver,
} from './execute.mjs';

export { DEFAULT_TIMEOUT_MS, DEFAULT_OUTPUT_CAP };

export const MAX_CASES = 25;

/** Handle a caller can hold to kill a run in flight. */
export function createRunControl() {
  return {
    cancelled: false,
    child: null,
    cancel() {
      this.cancelled = true;
      if (this.child) killGroup(this.child.pid, { signal: 'SIGKILL' });
      return true;
    },
  };
}

function emptySummary() {
  return { passed: 0, total: 0, totalMs: 0 };
}

function failure(kind, message, extra = {}) {
  return {
    ok: false,
    cases: [],
    summary: emptySummary(),
    error: { kind, message, ...extra },
  };
}

/**
 * @param {object} opts
 * @param {string} opts.code            the user's python, straight from the request
 * @param {string|object} opts.metaData LeetCode metaData (string or parsed)
 * @param {string} [opts.testcases]     newline-delimited input; defaults to exampleTestcases
 * @param {string} [opts.exampleTestcases]
 * @param {string} [opts.descriptionHtml] scraped for expected outputs
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.outputCapBytes]
 * @param {object} [opts.control]       from createRunControl()
 */
export async function runCode({
  code,
  slug = null,
  metaData,
  testcases,
  expectedOverrides,
  exampleTestcases,
  descriptionHtml,
  pythonStub = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  outputCapBytes = DEFAULT_OUTPUT_CAP,
  control = createRunControl(),
} = {}) {
  if (typeof code !== 'string' || code.trim() === '') {
    return failure('compile', 'There is no code to run yet — write a solution first.');
  }

  const shape = classifyProblem(parseMetaData(metaData), { pythonStub, slug });
  if (shape.kind === 'unsupported') return failure('unsupported', shape.message);

  const perCase = shape.kind === 'design' ? 2 : shape.params.length;
  const built = buildCases({
    perCase,
    testcases: typeof testcases === 'string' && testcases.trim() !== '' ? testcases : exampleTestcases,
    descriptionHtml,
    expectedOverrides,
    prefixExpected: shape.answerFrom?.sizeFromReturn === true,
  });
  if (!built.ok) return failure('unsupported', `${built.message} Submitting to LeetCode still works.`);

  const cases = applyAdapterExpected(shape, built.cases).slice(0, MAX_CASES);

  let dir = null;
  try {
    dir = await makeWorkspace(code);
  } catch (err) {
    return failure(
      'compile',
      `The local runner could not create a scratch directory to run your code in (${String(err?.code ?? err?.message ?? err)}).`,
    );
  }

  const configPath = path.join(dir, 'case.json');
  const resultPath = path.join(dir, 'result.json');

  try {
    // --- probe: import the file once, so a syntax or import error is reported before any
    //     case "runs" and gets blamed for it.
    const probeCfg =
      shape.kind === 'design'
        ? { kind: 'design', classname: shape.classname }
        : {
          kind: 'function',
          name: shape.name,
          ...adapterConfig(shape),
        };
    await fsp.writeFile(configPath, JSON.stringify(probeCfg), 'utf8');
    const probe = await runDriver({
      dir,
      configPath,
      resultPath,
      phase: 'probe',
      timeoutMs,
      outputCapBytes,
      onSpawn: (child) => {
        control.child = child;
        if (control.cancelled) killGroup(child.pid, { signal: 'SIGKILL' });
      },
    });

    if (control.cancelled) return failure('cancelled', 'The run was stopped.');

    if (probe.status === 'spawn-failed') {
      return failure(
        'compile',
        'The local runner could not start python3. Check that `python3` is on your PATH.',
      );
    }
    if (probe.status === 'timeout') {
      return failure(
        'timeout',
        `Your file did not finish loading within ${Math.round(timeoutMs / 1000)}s — there may be a loop outside your function.`,
      );
    }
    if (probe.status === 'output-limit') {
      return failure(
        'output',
        'Your file printed more output than the local runner will hold while it was being loaded.',
      );
    }

    const probeResult = await readResult(resultPath);
    if (probeResult === null) {
      return failure(
        'compile',
        probe.stderr.trim() !== ''
          ? 'Your code could not be loaded.'
          : 'Your code could not be loaded and python3 gave no reason.',
        { traceback: rewriteTraceback(probe.stderr, { dir }).text },
      );
    }
    if (probeResult.status !== 'ok') {
      const tb = rewriteTraceback(probeResult.traceback ?? '', { dir });
      const message =
        summarize(probeResult.traceback ?? '') ||
        probeResult.message ||
        'Your code could not be loaded.';
      return failure('compile', message, { traceback: tb.text, line: tb.line });
    }

    // --- one process per case. A case that hangs is killed; the rest still run.
    const out = [];
    let totalMs = 0;
    let passed = 0;

    for (const testCase of cases) {
      if (control.cancelled) break;

      if (testCase.parseError) {
        out.push({
          index: testCase.index,
          input: testCase.input,
          expected: null,
          actual: null,
          stdout: '',
          passed: false,
          ms: 0,
          error: { kind: 'unsupported', message: testCase.parseError },
        });
        continue;
      }

      const cfg = buildCaseConfig(shape, testCase);
      if (cfg === null) {
        out.push({
          index: testCase.index,
          input: testCase.input,
          expected: testCase.expected ?? null,
          actual: null,
          stdout: '',
          passed: false,
          ms: 0,
          error: {
            kind: 'unsupported',
            message:
              'This case is not in the operations/arguments form the local runner expects for a class-design problem.',
          },
        });
        continue;
      }

      await fsp.rm(resultPath, { force: true }).catch(() => {});
      await fsp.writeFile(configPath, JSON.stringify(cfg), 'utf8');

      const run = await runDriver({
        dir,
        configPath,
        resultPath,
        phase: 'run',
        timeoutMs,
        outputCapBytes,
        onSpawn: (child) => {
          control.child = child;
          if (control.cancelled) killGroup(child.pid, { signal: 'SIGKILL' });
        },
      });
      totalMs += run.ms;

      const base = {
        index: testCase.index,
        input: testCase.input,
        expected: testCase.expected ?? null,
        actual: null,
        stdout: run.stdout,
        passed: false,
        ms: Math.round(run.ms),
      };

      if (control.cancelled) break;

      if (run.status === 'timeout') {
        out.push({
          ...base,
          error: {
            kind: 'timeout',
            message: `This case did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped.`,
          },
        });
        continue;
      }
      if (run.status === 'output-limit') {
        out.push({
          ...base,
          stdout: run.stdout,
          truncated: true,
          error: {
            kind: 'output',
            message: `This case printed more than ${Math.round(outputCapBytes / 1024)} KB and was stopped. Check for a print inside a loop.`,
          },
        });
        continue;
      }

      const result = await readResult(resultPath);
      if (result === null) {
        const tb = rewriteTraceback(run.stderr, { dir });
        out.push({
          ...base,
          error: {
            kind: 'runtime',
            message:
              summarize(run.stderr) ||
              (run.signal
                ? `Your code was stopped by the system (${run.signal}) — it may have used too much memory.`
                : 'Your code stopped without producing an answer.'),
            traceback: tb.text,
          },
        });
        continue;
      }

      if (result.status === 'error') {
        const tb = rewriteTraceback(result.traceback ?? '', { dir });
        out.push({
          ...base,
          callMs: round2(result.ms),
          error: {
            kind: 'runtime',
            message: summarize(result.traceback ?? '') || result.message || 'Your code raised an error.',
            traceback: tb.text,
            line: tb.line,
          },
        });
        continue;
      }

      if (result.status === 'bad-input') {
        // The case is valid JSON but not the shape this parameter needs — `5` where a
        // linked list goes. The user's code never ran, so it is not blamed for it.
        out.push({
          ...base,
          error: { kind: 'unsupported', message: result.message ?? 'This case could not be built.' },
        });
        continue;
      }

      if (result.status === 'unserializable') {
        out.push({
          ...base,
          callMs: round2(result.ms),
          actual: result.repr ?? null,
          passed: null,
          note: result.message ?? 'The returned value could not be compared automatically.',
        });
        continue;
      }

      if (result.status === 'driver-error') {
        out.push({
          ...base,
          error: {
            kind: 'runtime',
            message: 'The local runner itself failed on this case. This is a Studio bug, not your code.',
            traceback: rewriteTraceback(result.traceback ?? '', { dir }).text,
          },
        });
        continue;
      }

      const actual = formatValue(result.value);
      const callMs = round2(result.ms);

      // Something worth saying that is not a verdict — how much of the MountainArray call
      // budget went, for the problem that is entirely about the call budget.
      const info = typeof result.info === 'string' && result.info !== '' ? result.info : null;

      if (!testCase.hasExpected) {
        out.push({
          ...base,
          actual,
          callMs,
          passed: null,
          note: 'LeetCode does not publish an expected answer for this case — compare it yourself.',
        });
        continue;
      }

      const compared =
        shape.adapter?.expected === 'quad-tree' ? normaliseQuadTree(result.value) : result.value;
      const verdict = compareValues(compared, testCase.expectedValue, {
        order: orderRuleFor(shape),
      });
      if (verdict.passed === true) passed += 1;
      out.push({
        ...base,
        actual,
        callMs,
        passed: verdict.passed,
        ...(verdict.orderInsensitive ? { orderInsensitive: true } : {}),
        ...(verdict.note || info
          ? { note: [info, verdict.note].filter(Boolean).join(' ') }
          : {}),
      });
    }

    if (control.cancelled) {
      return { ...failure('cancelled', 'The run was stopped.'), cases: out };
    }

    return {
      ok: true,
      cases: out,
      summary: { passed, total: out.length, totalMs: Math.round(totalMs) },
      error: null,
    };
  } finally {
    await removeWorkspace(dir);
  }
}

/**
 * How much reordering this problem's answer tolerates. See compareValues.
 *
 * The case that forces this to exist: sortColors, whose answer is read back out of the
 * array it mutated. A solution that does nothing leaves every item present and every item
 * in the wrong place — a perfect multiset match, and a green pass, for code that solved
 * nothing.
 */
/** The parts of the config a recipe needs: which class, which methods, which recipe. */
function adapterConfig(shape) {
  const adapter = shape.adapter;
  if (!adapter) return {};
  return {
    adapter: { driver: adapter.driver, answer: adapter.answer },
    ...(adapter.target ? { classname: adapter.target } : {}),
    ...(adapter.methods ? { methods: adapter.methods } : {}),
  };
}

/**
 * The expected answer for the problems whose description prints it as a sentence —
 * "tail connects to node index 1", "Intersected at '8'" — or does not print it at all.
 * Left exactly as built for everything else.
 */
function applyAdapterExpected(shape, cases) {
  const rule = shape.adapter?.expected;
  if (!rule) return cases;
  return cases.map((testCase) => {
    if (testCase.parseError) return testCase;
    const parsed = adaptedExpected(rule, testCase.expected, testCase.values);
    if (!parsed.ok) return { ...testCase, expectedValue: undefined, hasExpected: false };
    return {
      ...testCase,
      expected: JSON.stringify(parsed.value) ?? 'null',
      expectedValue: parsed.value,
      hasExpected: true,
    };
  });
}

function orderRuleFor(shape) {
  if (shape.adapter) return shape.adapter.order;
  if (shape.kind !== 'function') return 'lenient';
  if (isNodeType(shape.returnType)) return 'strict';
  if (shape.answerFrom) return shape.answerFrom.sizeFromReturn ? 'unknown' : 'strict';
  return 'lenient';
}

function round2(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function buildCaseConfig(shape, testCase) {
  if (shape.kind === 'function') {
    return {
      kind: 'function',
      name: shape.name,
      args: testCase.values,
      // The driver needs the declared types to know that [1,2,3] is a linked list here and
      // a plain list of integers there. LeetCode's own arrays are ambiguous without them.
      argTypes: shape.params.map((p) => p.type),
      returnType: shape.returnType,
      // Set for in-place problems: read the answer back out of this argument instead.
      ...(shape.answerFrom ? { answerFrom: shape.answerFrom } : {}),
      ...adapterConfig(shape),
    };
  }
  const [ops, opArgs] = testCase.values;
  if (!Array.isArray(ops) || !Array.isArray(opArgs)) return null;
  if (!ops.every((o) => typeof o === 'string')) return null;
  if (!opArgs.every((a) => Array.isArray(a))) return null;
  if (ops.length !== opArgs.length) return null;
  return { kind: 'design', classname: shape.classname, ops, opArgs };
}
