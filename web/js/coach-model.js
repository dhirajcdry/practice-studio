import { tooltip } from './tooltip.js';
import { el, replace } from './dom.js';
import { createMenu } from './ui/menu.js';
import { modelMark } from './ui/model-mark.js';

let snapshot = null;
let loading = null;
let saving = false;
let selectionVersion = 0;
const listeners = new Set();
const notify = () => { for (const listener of listeners) listener(); };
async function request(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Could not update the coach model.');
  return data;
}
async function load() {
  if (!loading) {
    const version = selectionVersion;
    loading = request('/api/coach/models').then(data => {
      if (version === selectionVersion) { snapshot = data; notify(); }
    }).finally(() => { loading = null; });
  }
  return loading;
}

/** A shared workspace preference; switching affects the next turn, never a running one. */
export function createCoachModelPicker({ compact = false, onPending = () => {} } = {}) {
  let disposed = false;
  let busy = false;
  const button = el('button', { type: 'button', class: 'btn btn--quiet ui-select-button', 'aria-label': 'Coach model', text: 'Loading models…', disabled: true });
  tooltip(button, () => button.getAttribute('aria-label'));
  const select = el('div', { class: 'ui-select is-compact coach-model-select' }, button);
  const notice = el('span', { class: 'coach-model-notice', role: 'status', hidden: true });
  const root = el('div', { class: `coach-model-picker${compact ? ' is-compact' : ''}` }, [select, notice]);
  let pendingModel = null;
  const menu = createMenu({ anchor: button, label: 'Coach model', radio: true, onSelect: item => {
    if (item.value === '__back') { showModels(); return; }
    if (pendingModel) {
      const { provider, model } = pendingModel;
      saveSelection({ provider, model, reasoningEffort: item.value || undefined });
    } else {
      const [provider, model] = item.value.split(':');
      if (!showEfforts(provider, model)) saveSelection({ provider, model });
    }
  } });
  Object.defineProperty(select, 'disabled', { get: () => button.disabled });
  Object.defineProperty(select, 'value', { get: () => snapshot ? `${snapshot.selected.provider}:${snapshot.selected.model}` : '' });
  function effortsFor(provider, model) {
    const entry = snapshot?.providers.find(p => p.id === provider)?.models.find(m => m.id === model);
    return (entry?.reasoningEfforts || []).map(e => typeof e === 'string' ? e : e.reasoningEffort).filter(Boolean);
  }
  const effortLabel = effort => ({ none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' })[effort] || effort;
  function showModels(edge) {
    if (!snapshot || button.disabled) return;
    pendingModel = null;
    const selected = `${snapshot.selected.provider}:${snapshot.selected.model}`;
    const groups = snapshot.providers.map(provider => ({ label: provider.label, icon: () => modelMark(provider.id), options: provider.models.map(model => ({
      value: `${provider.id}:${model.id}`, label: model.label, checked: selected === `${provider.id}:${model.id}`,
      hint: selected === `${provider.id}:${model.id}` && snapshot.selected.reasoningEffort ? effortLabel(snapshot.selected.reasoningEffort) : undefined,
    })) }));
    if (!groups.some(group => group.options.some(item => item.value === selected))) groups.unshift({ label: 'Current', options: [{ value: selected, label: `${snapshot.selected.model} · unavailable`, disabled: true }] });
    menu.setAttribute('aria-label', 'Coach model');
    menu.setGroups(groups);
    menu.open(edge);
  }
  function showEfforts(provider, model) {
    const efforts = effortsFor(provider, model);
    if (!efforts.length) return false;
    pendingModel = { provider, model };
    const entry = snapshot.providers.find(p => p.id === provider)?.models.find(m => m.id === model);
    const checked = efforts.includes(snapshot.selected.reasoningEffort) ? snapshot.selected.reasoningEffort : '';
    menu.setAttribute('aria-label', `${entry.label}: thinking level`);
    menu.setGroups([{ options: [{ value: '__back', label: 'Back to models', role: 'menuitem' }] }, { label: `${entry.label} · Thinking level`, options: [
      { value: '', label: 'Model default', checked: !checked },
      ...efforts.map(effort => ({ value: effort, label: effortLabel(effort), checked: effort === checked })),
    ] }]);
    menu.open();
    return true;
  }
  function paint() {
    if (disposed) return;
    if (!snapshot) return;
    const { provider, model, reasoningEffort } = snapshot.selected;
    const entry = snapshot.providers.find(p => p.id === provider)?.models.find(m => m.id === model);
    const efforts = effortsFor(provider, model);
    const effort = reasoningEffort ? `${effortLabel(reasoningEffort)}${efforts.includes(reasoningEffort) ? '' : ' (unavailable)'}` : efforts.length ? 'Default' : '';
    // The mark says whose model it is; the text stays exactly what it was without one.
    replace(button, [modelMark(provider),
      el('span', { class: 'coach-model-name', text: entry?.label || `${model} · unavailable` }),
      effort ? el('span', { class: 'coach-model-effort', text: ` · ${effort}` }) : null]);
    button.setAttribute('aria-label', `Coach model: ${button.textContent}`);
    button.removeAttribute('title');
    button.disabled = busy || saving;
    menu.close(false);
    pendingModel = null;
    onPending(saving);
  }
  listeners.add(paint);
  async function saveSelection({ provider, model, reasoningEffort } = {}) {
    notice.hidden = true;
    saving = true;
    selectionVersion += 1;
    notify();
    try {
      const data = await request('/api/coach/model', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }),
      });
      snapshot = { ...snapshot, selected: data.selected };
    } catch (error) {
      if (!disposed) { notice.textContent = error.message; notice.hidden = false; }
    } finally { saving = false; notify(); }
  }
  button.addEventListener('click', () => menu.isOpen ? menu.close(true) : showModels());
  button.addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); showModels(event.key === 'ArrowUp' || event.key === 'End' ? 'end' : 'start');
    } else if (event.key === 'Escape') menu.close(true);
    else if (event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault(); showModels(); menu.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, bubbles: true }));
    }
  });
  menu.addEventListener('keydown', event => { if (event.key === 'ArrowLeft' && pendingModel) { event.preventDefault(); event.stopPropagation(); showModels(); } });
  paint();
  load().catch(() => {
    if (!disposed) { notice.textContent = 'Model choices unavailable. Reopen Settings to retry.'; notice.hidden = false; }
  });
  return { root, setBusy(value) { busy = value; paint(); }, dispose() { disposed = true; listeners.delete(paint); menu.dispose(); } };
}
