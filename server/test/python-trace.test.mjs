import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMs, ownFrames, tracebackLine, splitException, dedent, renameFile, shapeScriptRun } from '../../web/js/python-trace.js';

// A made-up script error, shaped like runPythonScript's: driver and runpy frames first.
const driverTrace = [
  'Traceback (most recent call last):',
  '  File "/tmp/studio-run/_studio_driver.py", line 5, in <module>',
  '    runpy.run_path("solution.py", run_name="__main__")',
  '  File "<frozen runpy>", line 287, in run_path',
  '  File "<frozen runpy>", line 98, in _run_module_code',
  '  File "solution.py", line 12, in <module>',
  '    shelf.place(Parcel("small"))',
  '  File "solution.py", line 7, in place',
  '    return self.slots[size].pop()',
  'KeyError: \'small\'',
].join('\n');

test('milliseconds read the way the Result panel reads them', () => {
  assert.equal(formatMs(0.4), '<1 ms');
  assert.equal(formatMs(41.6), '42 ms');
  assert.equal(formatMs(12345), '12.3 s');
  assert.equal(formatMs(null), '');
  assert.equal(formatMs(-1), '');
});

test('only the learner\'s own frames and the exception line are kept', () => {
  const own = ownFrames(driverTrace);
  assert.ok(!own.includes('_studio_driver.py'));
  assert.ok(!own.includes('runpy'));
  assert.match(own, /line 12, in <module>/);
  assert.match(own, /KeyError: 'small'$/);
  assert.equal(ownFrames('KeyError: x'), null);
  // When nothing would be trimmed, there is no shorter version to offer.
  assert.equal(ownFrames('Traceback (most recent call last):\n  File "solution.py", line 1, in <module>\n    x\nNameError: x'), null);
});

test('the error line is the last frame in the learner\'s file', () => {
  assert.equal(tracebackLine(driverTrace), 7);
  assert.equal(tracebackLine('  File "/a/b/solution.py", line 3\n    def f(:\nSyntaxError: invalid syntax'), 3);
  assert.equal(tracebackLine('no frames here'), null);
  assert.equal(tracebackLine(driverTrace, 'design.py'), null);
});

test('exceptions split into their type and message', () => {
  assert.deepEqual(splitException("KeyError: 'small'"), { type: 'KeyError', detail: "'small'" });
  assert.deepEqual(splitException('KeyboardInterrupt'), { type: '', detail: 'KeyboardInterrupt' });
});

test('frames are dedented by their shared indentation only', () => {
  assert.equal(dedent('Traceback (most recent call last):\n  File "x", line 1\n    code\nE: y'), 'File "x", line 1\n  code\nE: y');
});

test('the runner\'s file is shown under the editor tab\'s name, nothing else renamed', () => {
  const renamed = renameFile(driverTrace, 'solution.py', 'design.py');
  assert.ok(!renamed.includes('solution.py'));
  assert.match(renamed, /File "design\.py", line 7/);
  assert.match(renamed, /run_path\("design\.py"/);
  assert.equal(renameFile('my_solution.py is fine', 'solution.py', 'design.py'), 'my_solution.py is fine');
});

test('a clean run says it ran, with its time and exit code', () => {
  const shaped = shapeScriptRun({ status: 'ok', exitCode: 0, stdout: 'placed small\n', stderr: '', timedOut: false, truncated: false, ms: 41.6 });
  assert.equal(shaped.headline, 'Ran · 42 ms · exit 0');
  assert.equal(shaped.tone, 'pass');
  assert.equal(shaped.stdout, 'placed small\n');
  assert.equal(shaped.traceback, null);
});

test('an exception is named by its own type, with the line and the stderr before it', () => {
  const shaped = shapeScriptRun({ status: 'ok', exitCode: 1, stdout: 'start\n', stderr: 'warning: low stock\n' + driverTrace + '\n', ms: 30 });
  assert.equal(shaped.headline, 'Error · KeyError');
  assert.equal(shaped.reason, "'small'");
  assert.equal(shaped.line, 7);
  assert.equal(shaped.errors, 'warning: low stock');
  assert.ok(shaped.traceback.startsWith('Traceback'));
});

test('time limits, output limits and plain non-zero exits are said as such', () => {
  assert.equal(shapeScriptRun({ status: 'timeout', timedOut: true, exitCode: null }).headline, 'Time limit exceeded');
  const limited = shapeScriptRun({ status: 'output-limit', exitCode: null, stdout: 'x' });
  assert.equal(limited.headline, 'Output limit reached');
  assert.equal(limited.truncated, true);
  const exited = shapeScriptRun({ status: 'ok', exitCode: 3, stdout: '', stderr: 'bad input\n', ms: 5 });
  assert.equal(exited.headline, 'Exited · 5 ms · exit 3');
  assert.equal(exited.tone, 'error');
  assert.equal(exited.errors, 'bad input');
  assert.equal(shapeScriptRun({ status: 'ok', exitCode: 0, truncated: true }).truncated, true);
  assert.equal(shapeScriptRun({ status: 'ok', exitCode: 1, stderr: 'Traceback (most recent call last):\n  File "solution.py", line 2, in <module>\nKeyboardInterrupt\n' }).headline, 'Error · KeyboardInterrupt');
});
