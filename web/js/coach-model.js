import { el, replace } from './dom.js';

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
  const select = el('select', { class: 'coach-model-select', 'aria-label': 'Coach model', disabled: true }, [
    el('option', { text: 'Loading models…' }),
  ]);
  const notice = el('span', { class: 'coach-model-notice', role: 'status', hidden: true });
  const root = el('div', { class: `coach-model-picker${compact ? ' is-compact' : ''}` }, [select, notice]);
  function paint() {
    if (disposed) return;
    select.disabled = busy || saving || !snapshot;
    if (!snapshot) return;
    const selectedKey = `${snapshot.selected.provider}:${snapshot.selected.model}`;
    const groups = snapshot.providers.map(provider => el('optgroup', { label: provider.label }, provider.models.map(model =>
      el('option', { value: `${provider.id}:${model.id}`, text: `${model.label} · ${provider.id === 'codex' ? 'Codex' : 'Claude'}` })
    )));
    if (!snapshot.providers.some(p => p.models.some(m => `${p.id}:${m.id}` === selectedKey))) {
      groups.unshift(el('option', { value: selectedKey, text: `${snapshot.selected.model} · unavailable`, disabled: true }));
    }
    replace(select, groups);
    select.value = selectedKey;
    select.title = 'Coach model for new coding and system-design replies';
    onPending(saving);
  }
  listeners.add(paint);
  select.addEventListener('change', async () => {
    const [provider, model] = select.value.split(':');
    notice.hidden = true;
    saving = true;
    selectionVersion += 1;
    notify();
    try {
      const data = await request('/api/coach/model', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, model }),
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
  return { root, setBusy(value) { busy = value; paint(); }, dispose() { disposed = true; listeners.delete(paint); } };
}
