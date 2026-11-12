import { screenHeader } from './ui/headers.js';
import { el, replace } from './dom.js';
import { sanitizeHtml } from './sanitize.js';
import { icon } from './ui/icon.js';

// Requests belong to this mounted view. Leaving it cannot navigate the next screen.
export function renderProblemImport({ onAdded }) {
  let controller = null;
  let disposed = false;
  let preview = null;
  const status = el('p', { class: 'import-status', role: 'status', 'aria-live': 'polite' });
  const details = el('section', { class: 'import-preview', hidden: true, 'aria-label': 'Problem preview' });
  const input = el('input', { id: 'problem-url', type: 'url', required: true, autocomplete: 'off',
    placeholder: 'https://leetcode.com/problems/…', 'aria-describedby': 'import-help' });
  const inspect = el('button', { type: 'submit', class: 'btn btn--primary', text: 'Preview problem' });
  const form = el('form', { class: 'import-form' }, [
    el('label', { for: 'problem-url', text: 'LeetCode problem URL' }),
    el('div', { class: 'import-input-row' }, [input, inspect]),
    el('p', { id: 'import-help', class: 'import-help', text: 'Import the statement, Python starter code and public examples into your workspace.' }),
  ]);
  const root = el('div', { class: 'view problem-import' }, [
    screenHeader({ title: 'Add a problem', back: { href: '#/', label: 'All problems' } }),
    el('section', { class: 'import-card' }, [form, status]), details,
  ]);
  async function request(endpoint, url) {
    controller?.abort();
    const active = controller = new AbortController();
    const timer = setTimeout(() => active.abort(), 25000);
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }), signal: active.signal });
      const result = await response.json();
      if (!response.ok) throw Error(result.error?.message || 'The problem could not be imported.');
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw Error('The request was interrupted. Preview the link again to check its status.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  input.addEventListener('input', () => {
    preview = null; details.hidden = true; inspect.className = 'btn btn--primary'; status.textContent = '';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const url = input.value.trim();
    preview = null; details.hidden = true; input.disabled = true; inspect.disabled = true;
    status.textContent = 'Loading problem…';
    try {
      const result = await request('/api/problems/import/preview', url);
      if (disposed) return;
      preview = result;
      status.textContent = result.existing ? 'This problem is already in your catalog.' : 'Preview ready. Nothing has been added yet.';
      inspect.className = 'btn btn--secondary';
      const add = el('button', { type: 'button', class: 'btn btn--primary import-save', text: result.existing ? 'Open problem' : 'Add and open' });
      add.addEventListener('click', async () => {
        if (!preview) return;
        add.disabled = true; input.disabled = true; inspect.disabled = true;
        status.textContent = 'Opening problem…';
        try {
          const saved = await request('/api/problems/import', url);
          if (!disposed) await onAdded(saved);
        } catch (error) {
          if (!disposed) { status.textContent = error.message; add.disabled = false; }
        } finally { if (!disposed) { input.disabled = false; inspect.disabled = false; } }
      });
      const content = result.content || {};
      replace(details, [
        el('div', { class: 'import-preview-head' }, [el('div', {}, [
          el('p', { class: 'import-help', text: [result.entry.number, result.entry.difficulty].filter(Boolean).join(' · ') }),
          el('h2', { text: result.entry.title }),
        ]), add]),
        el('p', { class: 'import-runner', text: result.runner.message }),
        el('p', { class: 'import-help', text: 'Local tests use public examples and your own cases. LeetCode’s hidden tests run only when you submit.' }),
        el('div', { class: 'import-description prose' }, content.descriptionHtml ? sanitizeHtml(content.descriptionHtml)
          : el('p', { text: 'The statement is unavailable. Premium content may need to be connected from your signed-in browser after adding.' })),
        el('h3', { text: 'Python starter' }),
        el('pre', { class: 'import-code', text: result.pythonStub || 'No Python starter code is available.' }),
        el('h3', { text: 'Example inputs' }),
        el('pre', { class: 'import-code', text: content.exampleTestcases || 'No public example inputs are available.' }),
      ]);
      details.hidden = false;
      add.focus({ preventScroll: true });
    } catch (error) { if (!disposed) status.textContent = error.message; }
    finally { if (!disposed) { input.disabled = false; inspect.disabled = false; } }
  });
  return { element: root, destroy() { disposed = true; controller?.abort(); } };
}
