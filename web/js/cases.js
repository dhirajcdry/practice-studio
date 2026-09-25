// The test case editor: LeetCode's tabs, with cases of your own.
//
// Two kinds of case sit in the same strip, and the difference matters:
//
//   Examples — LeetCode's, read-only. They are the problem's own statement, and a
//              "local run" that executed a quietly edited version of the examples
//              printed above the editor would be lying about what it checked.
//   Yours    — anything you added: a case you invented, or the exact input a
//              submission failed on. Editable, deletable, and saved per problem.
//
// Copying an example gives you an editable version of it, which is the honest way to
// get "let me tweak case 2" without pretending the example changed.
//
// The list here IS the list that runs. Everything is joined back into the same
// newline-delimited blob the runner already takes, in tab order.

import { el, replace, clear } from './dom.js';
import { loadTestcases, saveTestcases } from './api.js';

const SAVE_DEBOUNCE_MS = 700;

/** Split one case's stored input into one value per parameter. */
export function splitInput(input, perCase) {
  const lines = String(input ?? '').split('\n');
  const out = [];
  for (let i = 0; i < (perCase || lines.length); i += 1) out.push((lines[i] ?? '').trim());
  return out;
}

/** The blob the runner takes: every case in tab order, one line per parameter. */
export function joinCases(cases) {
  return cases.map((c) => String(c.input ?? '').trim()).join('\n');
}

/** A short label for a tab — the first value, which is almost always the interesting one. */
export function tabLabel(index) {
  return `Case ${index + 1}`;
}

/**
 * Build the editor.
 *
 * @param {object} opts
 * @param {string} opts.slug
 * @param {() => void} [opts.onRun] the Run button in the strip, so you can run the case
 *   you just typed without moving the mouse back to the toolbar
 * @param {(state:object) => void} [opts.onChange] fired whenever the runnable list changes
 */
export function createCaseEditor({ slug, onRun = null, onChange = () => {} }) {
  const tabs = el('div', { class: 'tc-tabs' });
  const panelEl = el('div', { class: 'tc-panel' });
  const noticeEl = el('div', { class: 'tc-notice', hidden: true });
  const root = el('div', { class: 'tc' }, [tabs, noticeEl, panelEl]);

  let examples = [];       // {input, expected, source:'example'}
  let mine = [];           // {input, expected, source:'custom'|'leetcode', note}
  let params = [];
  let perCase = 1;
  let selected = 0;
  let saveTimer = null;
  let loaded = false;
  // Until we know otherwise, assume the runner can drive this problem. When it cannot, the
  // panel says why and offers nothing else — a "+" here would let you write out a case for
  // a problem that was never going to run it.
  let runnable = true;

  const all = () => [...examples, ...mine];

  function notice(text, tone = '') {
    noticeEl.hidden = !text;
    noticeEl.className = 'tc-notice' + (tone ? ' ' + tone : '');
    noticeEl.textContent = text || '';
  }

  function announce() {
    const list = all();
    onChange({
      cases: list,
      testcases: joinCases(list),
      expected: list.map((c) => c.expected ?? null),
      count: list.length,
    });
  }

  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const result = await saveTestcases(slug, mine.map((c) => ({
        input: c.input, expected: c.expected, source: c.source, note: c.note ?? null,
      })));
      if (!result.ok) notice(result.message, 'warn');
      else notice('');
    }, SAVE_DEBOUNCE_MS);
  }

  function select(index) {
    selected = Math.max(0, Math.min(index, all().length - 1));
    paint();
  }

  /** Add a case and make it the one on screen. Returns its index. */
  function addCase({ input = '', expected = null, source = 'custom', note = null } = {}) {
    mine.push({ input, expected, source, note });
    selected = all().length - 1;
    queueSave();
    paint();
    announce();
    return selected;
  }

  function removeCase(index) {
    const own = index - examples.length;
    if (own < 0 || own >= mine.length) return;   // examples are not ours to delete
    mine.splice(own, 1);
    if (selected >= all().length) selected = Math.max(0, all().length - 1);
    queueSave();
    paint();
    announce();
  }

  function editCase(index, patch) {
    const own = index - examples.length;
    if (own < 0 || own >= mine.length) return;
    mine[own] = { ...mine[own], ...patch };
    queueSave();
    announce();
  }

  /* ------------------------------- painting ------------------------------- */

  function paintTabs() {
    const list = all();
    replace(tabs, [
      ...list.map((c, i) => {
        const mineHere = i >= examples.length;
        return el('button', {
          class: 'tc-tab' + (i === selected ? ' is-on' : '') + (mineHere ? ' is-mine' : ''),
          type: 'button',
          'aria-pressed': String(i === selected),
          title: mineHere
            ? (c.source === 'leetcode' ? 'From a failed submission' : 'Yours')
            : "LeetCode's example",
          onclick: () => select(i),
        }, [
          el('span', { text: tabLabel(i) }),
          c.source === 'leetcode' ? el('span', { class: 'tc-mark', title: 'From a failed submission', text: '!' }) : null,
        ]);
      }),
      runnable
        ? el('button', {
          class: 'tc-add', type: 'button', title: 'Add a test case of your own',
          onclick: () => addCase({ input: blankInput() }),
        }, '+')
        : null,
    ]);
  }

  function blankInput() {
    return new Array(perCase).fill('').join('\n');
  }

  function field(label, value, { readOnly, onInput, placeholder = '' }) {
    const input = el('textarea', {
      class: 'tc-input mono', rows: '1', spellcheck: 'false', placeholder,
      ...(readOnly ? { readonly: 'readonly' } : {}),
    });
    input.value = value ?? '';
    const size = () => {
      input.style.height = 'auto';
      input.style.height = Math.min(160, Math.max(30, input.scrollHeight)) + 'px';
    };
    input.addEventListener('input', () => { size(); onInput?.(input.value); });
    requestAnimationFrame(size);
    return el('label', { class: 'tc-field' }, [
      el('span', { class: 'mono dim tc-label', text: label }),
      input,
    ]);
  }

  function paintPanel() {
    const list = all();
    if (!list.length) {
      // When the runner cannot drive this problem the notice above already says why, in
      // one sentence. A second line here saying there are no cases, next to a button to
      // add one, reads as a contradiction of it.
      if (!runnable) { clear(panelEl); return; }
      replace(panelEl, el('p', { class: 'tc-empty' }, [
        el('span', { text: loaded ? 'No example cases for this problem. ' : 'Loading the example cases… ' }),
        loaded ? el('button', { class: 'act', type: 'button', text: 'Add one', onclick: () => addCase({ input: blankInput() }) }) : null,
      ]));
      return;
    }

    const index = Math.min(selected, list.length - 1);
    const c = list[index];
    const isMine = index >= examples.length;
    const values = splitInput(c.input, perCase);

    const fields = values.map((value, i) => field(
      params[i] || `Line ${i + 1}`,
      value,
      {
        readOnly: !isMine,
        placeholder: 'JSON, e.g. [1,2,3]',
        onInput: (next) => {
          // Read the CURRENT case, not the one captured when this box was drawn.
          // editCase replaces the object, so a captured copy goes stale the moment you
          // type in a different box — and the second edit silently threw the first away.
          const merged = splitInput(all()[index]?.input ?? '', perCase);
          merged[i] = next;
          editCase(index, { input: merged.join('\n') });
        },
      },
    ));

    const expected = field('Expected', c.expected ?? '', {
      readOnly: !isMine,
      placeholder: isMine ? 'optional — leave empty to just see the output' : 'not published',
      onInput: (next) => editCase(index, { expected: next.trim() === '' ? null : next }),
    });

    const foot = el('div', { class: 'tc-foot' }, [
      isMine
        ? el('span', { class: 'mono dim tc-origin', text: c.source === 'leetcode' ? 'From a failed submission' : 'Yours' })
        : el('span', { class: 'mono dim tc-origin', text: "LeetCode's example — read only" }),
      el('span', { class: 'spacer' }),
      isMine
        ? el('button', { class: 'ws-mini', type: 'button', text: 'Delete', onclick: () => removeCase(index) })
        : el('button', {
          class: 'ws-mini', type: 'button', text: 'Copy to a new case',
          title: 'An editable copy, so the example itself stays what LeetCode published',
          onclick: () => addCase({ input: c.input, expected: c.expected }),
        }),
      onRun ? el('button', { class: 'ws-run tc-run', type: 'button', text: 'Run', onclick: onRun }) : null,
    ]);

    replace(panelEl, [el('div', { class: 'tc-fields' }, [...fields, expected]), foot]);
  }

  function paint() {
    paintTabs();
    paintPanel();
  }

  /* -------------------------------- loading ------------------------------- */

  async function load() {
    let data;
    try {
      data = await loadTestcases(slug);
    } catch {
      // Say so and stop. Leaving "Loading the example cases…" on screen forever would be
      // the one thing worse than the failure itself.
      loaded = true;
      runnable = false;
      notice('The test cases could not be loaded.', 'warn');
      paint();
      return;
    }
    loaded = true;
    runnable = data.ok && data.runnable !== false;
    if (!data.ok) { notice(data.reason || 'The test cases could not be loaded.', 'warn'); paint(); return; }
    examples = (data.cases || []).map((c) => ({ ...c, source: 'example' }));
    mine = data.extra || [];
    params = data.params || [];
    perCase = data.perCase || Math.max(1, params.length);
    if (data.reason) notice(data.reason, 'warn');
    paint();
    announce();
  }

  paint();
  load();

  return {
    root,
    /** What a run should execute right now. */
    payload() {
      const list = all();
      return { testcases: joinCases(list), expected: list.map((c) => c.expected ?? null), count: list.length };
    },
    /** The input a submission failed on, as a case you can now run against. */
    addFailingCase({ input, expected = null }) {
      const index = addCase({ input: String(input).trim(), expected, source: 'leetcode' });
      select(index);
      return index;
    },
    dispose() { clearTimeout(saveTimer); },
  };
}
