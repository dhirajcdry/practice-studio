import { el, replace } from './dom.js';
import { createSelect } from './ui/select.js';

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
  const select = createSelect({ label: 'Coach model', compact: true, options: [['','Loading models…']] }); select.classList.add('coach-model-select'); select.disabled = true;
  const notice = el('span', { class: 'coach-model-notice', role: 'status', hidden: true });
  const root = el('div', { class: `coach-model-picker${compact ? ' is-compact' : ''}` }, [select, notice]);
  function paint() {
    if (disposed) return;
    select.disabled = busy || saving || !snapshot;
    if (!snapshot) return;
    const selectedKey = `${snapshot.selected.provider}:${snapshot.selected.model}${snapshot.selected.reasoningEffort ? `:${snapshot.selected.reasoningEffort}` : ''}`;
    const groups = snapshot.providers.map(provider => ({ label: provider.label, options: provider.models.flatMap(model => {
      const efforts = (model.reasoningEfforts || []).map(e => typeof e === 'string' ? e : e.reasoningEffort).filter(Boolean);
      return efforts.length ? [{ value: `${provider.id}:${model.id}`, label: `${model.label} · default` }, ...efforts.map(effort => ({ value: `${provider.id}:${model.id}:${effort}`, label: `${model.label} · ${effort}` }))]
        : [{ value: `${provider.id}:${model.id}`, label: model.label }];
    }) }));
    if (!snapshot.providers.some(p => p.models.some(m => `${p.id}:${m.id}` === `${snapshot.selected.provider}:${snapshot.selected.model}`))) {
      groups.unshift({ label: 'Current', options: [{ value: selectedKey, label: `${snapshot.selected.model} · unavailable`, disabled: true }] });
    }
    select.setGroups(groups);
    select.value = selectedKey;
    onPending(saving);
  }
  listeners.add(paint);
  select.addEventListener('change', async () => {
    const [provider, model, reasoningEffort] = select.value.split(':');
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
  });
  paint();
  load().catch(() => {
    if (!disposed) { notice.textContent = 'Model choices unavailable. Reopen Settings to retry.'; notice.hidden = false; }
  });
  return { root, setBusy(value) { busy = value; paint(); }, dispose() { disposed = true; listeners.delete(paint); select.dispose(); } };
}
