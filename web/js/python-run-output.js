// "Run Python" for a whole Python document (LLD mocks and practice): one button and one
// output panel, drawn with the LeetCode Result panel's own classes. The panel says only
// what the runner said: a verdict, what was printed, the learner's own traceback frames
// with the file named as the editor tab names it, and a way back to the failing line.
import { el, replace } from './dom.js';
import { button } from './ui/button.js';
import { tooltip } from './tooltip.js';
import { shapeScriptRun, traceBlock } from './python-trace.js';

const RUNNER_FILE = 'solution.py';
const TONE = { pass: 's-pass', error: 's-error', look: 's-look' };

/** One labelled row, the Result panel's `.rr-row` pattern. */
const row = (label, value) => el('div', { class: 'rr-row' }, [
  el('span', { class: 'rr-label', text: label }),
  el('div', { class: 'rr-value' }, el('pre', { class: 'rr-printed', text: value })),
]);

/**
 * `editor` is the python-editor API, or a function returning the current one (a
 * workspace may mount its editor after the panel). `onDismiss` runs after the learner
 * hides the output, so focus can return to the Run button.
 */
export function createPythonRunOutput({ editor, fileName = 'design.py', onDismiss } = {}) {
  const currentEditor = typeof editor === 'function' ? editor : () => editor;
  const root = el('div', { class: 'rr pyrun', hidden: true, 'aria-live': 'polite', 'aria-label': `${fileName} output` });
  let ticker = null;
  const stopClock = () => { if (ticker) { clearInterval(ticker); ticker = null; } };
  const close = () => button({ variant: 'icon', icon: 'close', ariaLabel: 'Hide output', className: 'pyrun-close',
    onClick: () => { clear(); onDismiss?.(); } });

  function summary(tone, headline, trailing = '') {
    return el('div', { class: `rr-summary ${TONE[tone] || ''}` }, [
      el('span', { class: 'rr-headline' }, [el('span', { class: 'rr-dot', 'aria-hidden': 'true' }), el('span', { text: headline })]),
      el('span', { class: 'spacer' }),
      trailing ? el('span', { class: 'rr-total tnum', text: trailing }) : null,
      close(),
    ]);
  }

  function paint(nodes) {
    stopClock();
    root.hidden = false;
    replace(root, nodes);
    root.scrollTop = 0;
  }

  function running() {
    const started = Date.now();
    const clock = el('span', { class: 'mono dim tnum', text: '0.0s' });
    paint(el('div', { class: 'rr-running' }, [
      el('div', { class: 'rr-bar' }, el('i')),
      el('div', { class: 'rr-runrow' }, [el('span', { class: 'mono', text: `Running ${fileName}` }), clock]),
    ]));
    ticker = setInterval(() => { clock.textContent = ((Date.now() - started) / 1000).toFixed(1) + 's'; }, 100);
  }

  function show(result) {
    const shaped = shapeScriptRun(result, { file: RUNNER_FILE });
    const tone = TONE[shaped.tone] || '';
    const msInHeadline = shaped.kind === 'ran' || shaped.kind === 'exit';
    const line = shaped.line;
    const goTo = line && currentEditor()?.revealLine
      ? button({ label: `Go to line ${line}`, variant: 'quiet', className: 'rr-goto', onClick: () => currentEditor()?.revealLine(line) })
      : null;
    const why = shaped.kind === 'exception'
      ? (line || shaped.reason ? el('div', { class: `rr-why ${tone}` }, [
        line ? el('strong', { text: `Line ${line}` }) : null,
        shaped.reason ? el('span', { text: shaped.reason }) : null,
      ]) : null)
      : shaped.reason ? el('div', { class: `rr-why ${tone}` }, el('span', { text: shaped.reason })) : null;
    const rows = [
      shaped.stdout ? row('Printed', shaped.stdout) : null,
      shaped.errors ? row('Stderr', shaped.errors) : null,
    ].filter(Boolean);
    const foot = [
      !msInHeadline && shaped.ms ? el('span', {}, ['Time ', el('b', { class: 'tnum', text: shaped.ms })]) : null,
      shaped.kind === 'ran' && !shaped.stdout && !shaped.errors ? el('span', { text: 'Nothing printed' }) : null,
      goTo,
    ].filter(Boolean);
    paint([
      summary(shaped.tone, shaped.headline),
      el('div', { class: `rr-case pyrun-body ${tone}` }, [
        why,
        // Above the rows, so a long truncated print cannot push the notice out of sight.
        shaped.truncated ? el('p', { class: 'pyrun-note', text: shaped.kind === 'output-limit'
          ? 'Output truncated: the script printed more than Studio keeps, so it was stopped. Only the start is shown.'
          : 'Output truncated: only the start of what the script printed is shown.' }) : null,
        rows.length ? el('div', { class: 'rr-rows' }, rows) : null,
        shaped.traceback ? traceBlock(shaped.traceback, { file: RUNNER_FILE, fileName }) : null,
        foot.length ? el('div', { class: 'rr-foot' }, foot) : null,
      ]),
    ]);
    return shaped;
  }

  /** The request itself failed (server unreachable, a run already in flight): nothing ran. */
  function failed(message) {
    paint([
      summary('error', 'The run did not happen'),
      el('div', { class: 'rr-case pyrun-body s-error' }, el('p', { class: 'pyrun-message', text: message || 'Studio could not run the document.' })),
    ]);
  }

  function clear() {
    stopClock();
    root.hidden = true;
    replace(root, []);
  }

  return { root, running, show, failed, clear, dispose: stopClock };
}

/**
 * The Run Python button and its output, wired together. `execute()` saves if needed and
 * resolves to the runner's result; `canRun()` decides whether the button is enabled after
 * a run (callers may also set `button.disabled` themselves as their session changes).
 */
export function createPythonRun({ fileName = 'design.py', editor, execute, canRun = () => true, disabled = false }) {
  const output = createPythonRunOutput({ editor, fileName, onDismiss: () => runButton.focus() });
  const runButton = el('button', { class: 'btn btn--secondary python-run', type: 'button', text: 'Run Python', disabled, onclick: run });
  tooltip(runButton, "Run Python (⌘')");
  async function run() {
    if (runButton.disabled || !canRun()) return;
    runButton.disabled = true;
    output.running();
    try { output.show(await execute()); }
    catch (error) { output.failed(error?.message); }
    finally { runButton.disabled = !canRun(); }
  }
  return { button: runButton, output, root: output.root, run };
}
