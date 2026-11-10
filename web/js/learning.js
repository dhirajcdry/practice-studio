import { el, replace } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { dialogHeader } from './ui/headers.js';
import { relativeInterviewDate, signalLabel } from './interview-format.js';
import { readDraft, saveDraft, clearDraft } from './drafts.js';
export async function saveLearningNote(slug, text) {
  const response = await fetch(`/api/learning/${encodeURIComponent(slug)}/note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  const result = await response.json(); if (!response.ok) throw Error(result.error?.message || 'Note could not be saved.');
}
let openNotes = null;
export function openLearningNotes(slug, title) {
  openNotes?.close();
  const draftKey = `learning-note:${slug}`;
  const content = el('div', { class: 'ln-saved' });
  const input = el('textarea', { class: 'coach-input ln-input', rows: '4', 'aria-label': 'New learning note', placeholder: 'An insight, a mistake to revisit, or a question for next time…' });
  input.value = readDraft(draftKey)?.text || '';
  input.addEventListener('input', () => { saveDraft(draftKey, input.value); save.disabled = !input.value.trim(); });
  const status = el('span', { role: 'status', class: 'dim' });
  const save = el('button', { class: 'btn btn--primary', text: 'Save note', disabled: !input.value.trim(), onclick: async () => {
    if (!input.value.trim()) return;
    save.disabled = true;
    try { await saveLearningNote(slug, input.value); input.value = ''; clearDraft(draftKey); await load(); status.textContent = 'Note saved'; }
    catch (error) { status.textContent = error.message; }
    finally { save.disabled = !input.value.trim(); }
  } });
  const dialog = el('dialog', { class: 'rp-sheet ln-sheet', 'aria-label': 'Learning notes' });
  dialog.append(dialogHeader({ title: 'Learning notes', subtitle: title, closeLabel: 'Close learning notes', onClose: () => dialog.close() }),
    el('div', { class: 'rp-scroll ln-scroll' }, [
      el('section', { class: 'ln-compose' }, [el('label', { text: 'Add a note', for: 'learning-note-input' }), input,
        el('div', { class: 'ln-actions' }, [status, save])]), content,
    ]));
  input.id = 'learning-note-input';
  async function load() {
    const response = await fetch(`/api/learning/${encodeURIComponent(slug)}`), data = await response.json();
    if (!response.ok) throw Error(data.error?.message || 'Notes could not be loaded.');
    const evidence = (data.records || []).map(record => el('details', { class: 'ln-evidence' }, [
      el('summary', {}, [el('span', { text: relativeInterviewDate(record.date) }), el('span', { class: 'dim', text: signalLabel(record.signal, record.reportDifficulty) || (record.completed ? 'No verdict recorded' : 'Unfinished interview') })]),
      record.headline ? el('p', { text: record.headline }) : null,
      el('div', { class: 'rich' }, renderMarkdown(record.markdown)),
    ]));
    replace(content, [
      el('section', {}, [el('h3', { text: 'Your notes' }), el('div', { class: 'rich ln-note-text' }, renderMarkdown(data.notes ? data.notes.replace(/^## Saved (\d{4}-\d{2}-\d{2}T\S+)$/gm, (_, date) => `## Saved ${relativeInterviewDate(date)}`) : 'No notes saved yet.'))]),
      el('section', {}, [el('h3', { text: 'Interview evidence' }), el('p', { class: 'dim ln-caption', text: 'Feedback from your recorded interviews.' }),
        evidence.length ? el('div', { class: 'ln-evidence-list' }, evidence) : el('p', { class: 'dim', text: 'No interviews recorded for this problem.' })]),
    ]);
  }
  document.body.append(dialog); openNotes = dialog; dialog.showModal();
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { dialog.remove(); if (openNotes === dialog) openNotes = null; });
  load().catch(error => { status.textContent = error.message; });
}
