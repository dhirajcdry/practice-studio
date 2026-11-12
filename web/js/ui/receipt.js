import { el, replace } from '../dom.js';
import { tooltip } from '../tooltip.js';
import { icon } from './icon.js';
import { receiptGlyph, studioToolName } from '../coach-actions.js';

// Both provider adapters deliver the same durable receipt. Rendering it must never
// apply it: execution/Undo remains with the caller and its existing ownership checks.
export function paintReceipt(row, { tool = '', status = '', content = [], output = null, failed = false } = {}) {
  row.className = `cmsg-receipt ui-receipt is-${status}`;
  row.dataset.tool = studioToolName(tool) || tool;
  const line = el('div', { class: 'ui-receipt-line' }, [
    el('span', { class: 'cr-glyph', 'aria-hidden': 'true' }, icon(receiptGlyph(row.dataset.tool), 15)), ...content,
  ]);
  for (const button of line.querySelectorAll('button[title]')) { tooltip(button, button.title); button.removeAttribute('title'); }
  for (const sentence of line.querySelectorAll('.cr-text')) tooltip(sentence, sentence.textContent);
  const wasOpen = row.querySelector('details')?.open;
  const newlyFailed = failed && row.dataset.failed !== 'true';
  row.dataset.failed = String(failed);
  replace(row, [line, output === null ? null : el('details', { class: 'ui-receipt-output', open: newlyFailed || (wasOpen ?? failed) }, [
    el('summary', { text: 'Show output' }), el('pre', { text: output || 'No output.' }),
  ])]);
  return row;
}

export function receiptOutput(action) {
  const result = action.result || action.run;
  if (!result || typeof result !== 'object') return null;
  if ('stdout' in result || 'stderr' in result) return (result.stdout || '') + (result.stderr || '');
  if (Array.isArray(result.cases)) return [result.error?.message, ...result.cases.map((item, i) => [`Case ${i + 1}`, item.stdout, item.stderr, item.error?.message, item.error?.traceback].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n');
  if (result.error) return [result.error.message, result.error.traceback].filter(Boolean).join('\n');
  if (typeof result.diff === 'string') return result.diff;
  return null;
}
export function receiptFailed(action) {
  const result = action.result || action.run;
  return action.status === 'failed' || Boolean(result?.timedOut) || (result?.exitCode != null && result.exitCode !== 0)
    || result?.ok === false || result?.passed === false || Boolean(result?.error)
    || (Number.isFinite(result?.summary?.passed) && result.summary.passed < result.summary.total);
}

export function toolReceipt(tool, text) {
  const row = paintReceipt(el('div'), { tool, content: [el('span', { class: 'cr-text', text })] });
  row.classList.add('cmsg-tool'); return row;
}
