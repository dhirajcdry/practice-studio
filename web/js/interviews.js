// Interview history owns a single expanded row; switching sidebar tabs keeps it mounted.
import { el, replace } from './dom.js';
import { activeInterview, createInterviewPanel, interviewJson, createInterviewSetup } from './interview.js';
import { readSidebar, saveSidebar } from './sidebar-state.js';
import { interviewDuration, relativeInterviewDate, interviewOutcome } from './interview-format.js';
import { icon } from './ui/icon.js';

const labels = { in_progress: 'In progress', paused: 'Paused', completed: 'Completed', needs_attention: 'Needs attention' };
export function createInterviews(entry) {
  const { slug } = entry;
  let records = [], panel = null, selected = readSidebar(slug).interviewId || null;
  let visible = false, disposed = false, generation = 0, panelEpoch = 0;
  const rows = new Map();
  const list = el('div', { class: 'interview-list' });
  const notice = el('div', { class: 'interviews-notice ui-inset dim', role: 'status' });
  const retry = el('button', { class: 'btn btn--quiet ws-mini', text: 'Retry loading interviews', hidden: true, onclick: () => refresh() });
  const count = el('span', { class: 'interviews-count dim' });
  const setup = createInterviewSetup(entry);
  const overview = el('div', { class: 'interviews-overview' }, [setup.root,
    el('div', { class: 'interviews-toolbar' }, [el('strong', { text: 'Past interviews' }), count]), notice, retry, list]);
  const detailContent = el('div', { class: 'interview-detail-content' });
  const detail = el('section', { class: 'interview-detail', hidden: true }, [
    el('button', { class: 'btn btn--quiet interview-back', 'aria-label': 'Back to interviews', onclick: collapse }, [icon('back'), 'Interviews']), detailContent,
  ]);
  const root = el('section', { class: 'interviews-view', 'aria-label': 'Interviews', hidden: true }, [
    el('div', { dataset: { interviewRecorder: '' } }), overview, detail,
  ]);
  function paintView() { overview.hidden = Boolean(panel); detail.hidden = !panel; }
  function remember(id) { selected = id; saveSidebar(slug, { interviewId: id }); }
  function status(record) {
    if (record.debriefed) return 'completed';
    if (record.needsAttention) return 'needs_attention';
    if (record.status && labels[record.status]) return record.status;
    if (record.endedAt) return 'needs_attention';
    return record.pausedAt ? 'paused' : 'in_progress';
  }
  function paintRow(row, record) {
    const state = status(record);
    row.button.setAttribute('aria-expanded', String(selected === record.id));
    row.article.classList.toggle('is-expanded', selected === record.id);
    const outcome = interviewOutcome(record);
    row.badge.textContent = outcome.label; row.badge.dataset.status = state;
    row.badge.className = 'ui-badge interview-status ui-badge--' + outcome.tone;
    row.title.textContent = relativeInterviewDate(record.startedAt);
    row.meta.textContent = `${interviewDuration(record)} · ${record.mode === 'voice' ? 'Voice' : 'Typed'}`;
    // The row itself opens an interview. Only a paused one gets a second control, and it
    // says what it does: open it and carry on.
    row.resume.hidden = state !== 'paused';
    row.chevron.hidden = state === 'paused';
  }
  function rowFor(record) {
    let row = rows.get(record.id);
    if (!row) {
      const title = el('strong');
      const badge = el('span', { class: 'interview-status mono' });
      const meta = el('span', { class: 'interview-row-meta dim' });
      const content = el('div', { class: 'interview-row-content' });
      const chevron = el('span', { class: 'ui-row-trailing ui-row-chevron', 'aria-hidden': 'true' }, [icon('chevron', 16)]);
      const button = el('button', { class: 'ui-action-row interview-row-summary ui-inset ui-row', type: 'button', onclick: () => {
        const id = article.dataset.interviewId;
        if (selected === id) collapse(); else open(id);
      } }, [el('span', { class: 'ui-row-content ui-stack' }, [el('span', { class: 'interview-row-top' }, [title, badge]), meta]), chevron]);
      const resume = el('button', { class: 'btn btn--secondary interview-row-resume', text: 'Resume', hidden: true, onclick: () => {
        // Read the record as it is now; the one this row was built from may be a refresh old.
        const id = article.dataset.interviewId, latest = records.find(item => item.id === id) || record;
        open(id); if (status(latest) === 'paused') panel?.resume();
      } });
      const article = el('article', { class: 'sidebar-record interview-row', dataset: { interviewId: record.id } }, [el('div', { class: 'interview-row-heading' }, [button, resume]), content]);
      row = { article, button, title, badge, meta, content, resume, chevron }; rows.set(record.id, row);
    }
    paintRow(row, record); return row;
  }
  function render() {
    count.textContent = records.length ? `${records.length} ${records.length === 1 ? 'interview' : 'interviews'}` : '';
    const nodes = records.map(record => rowFor(record).article);
    // Keep mounted records in place: detaching an unchanged expanded row resets
    // its nested scroll/focus on every background status acknowledgement.
    const wanted = new Set(nodes);
    for (const child of [...list.children]) if (!wanted.has(child)) child.remove();
    nodes.forEach((node, index) => {
      if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
    });
    notice.textContent = records.length ? '' : 'No interviews recorded.';
  }
  function collapse() {
    panelEpoch++;
    panel?.dispose(); panel = null;
    for (const row of rows.values()) replace(row.content, []);
    if (selected === 'pending') { records = records.filter(record => record.id !== 'pending'); rows.delete('pending'); }
    remember(null); replace(detailContent, []); paintView(); render(); root.scrollTop = readSidebar(slug).interviewsListScroll || 0;
  }
  function update(state) {
    if (disposed) return;
    const id = state.id || 'pending';
    if (selected === 'pending' && state.id) {
      const row = rows.get('pending');
      if (row) { rows.delete('pending'); rows.set(id, row); row.article.dataset.interviewId = id;
      }
      records = records.filter(record => record.id !== 'pending'); remember(id);
    }
    const existing = records.find(record => record.id === id);
    const changed = !existing || existing.pausedAt !== state.pausedAt || existing.debriefed !== state.debriefed;
    if (existing) Object.assign(existing, state); else records.unshift({ ...state, id });
    render();
    if (changed && state.id) refresh();
  }
  function open(id = null) {
    const target = id || 'pending';
    if (selected === target && panel) return;
    if (!panel) saveSidebar(slug, { interviewsListScroll: root.scrollTop });
    const epoch = ++panelEpoch;
    panel?.dispose(); panel = null;
    for (const row of rows.values()) replace(row.content, []);
    remember(target);
    if (!records.some(record => record.id === target)) records.unshift({ id: target, ...(id ? {} : activeInterview(slug)) });
    render();
    panel = createInterviewPanel(entry, { id, embedded: true, onState: state => { if (epoch === panelEpoch) update(state); }, onBack: collapse });
    replace(detailContent, panel.root); paintView(); root.scrollTop = 0;
    panel.setVisible(visible);
  }
  async function refresh() {
    const request = ++generation;
    retry.hidden = true;
    if (!records.length) notice.textContent = 'Loading interviews…';
    try {
      const result = await interviewJson('/api/interview?slug=' + encodeURIComponent(slug));
      if (disposed || request !== generation) return;
      const expanded = panel && records.find(record => record.id === selected);
      records = [...result.interviews].sort((a, b) => b.startedAt - a.startedAt);
      if (expanded && selected !== 'pending') {
        records = records.filter(record => record.id !== selected);
        records.push(expanded); records.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      }
      if (panel && selected === 'pending') records.unshift({ ...activeInterview(slug), id: 'pending' });
      render();
      if (selected && !panel) {
        if (records.some(record => record.id === selected)) open(selected);
        else if (selected === 'pending' && activeInterview(slug)?.pending) open();
        else remember(null);
      }
    } catch (error) {
      if (disposed || request !== generation) return;
      notice.textContent = error.message; retry.hidden = false;
    }
  }
  const clock = setInterval(() => { for (const record of records) rowFor(record); }, 1000);
  return {
    root, open, refresh, showSetup: collapse,
    show(on) {
      const entering = on && !visible;
      visible = on; root.hidden = !on; panel?.setVisible(on);
      if (entering) refresh();
    },
    dispose() { disposed = true; generation++; clearInterval(clock); setup.dispose(); panel?.dispose(); },
  };
}
