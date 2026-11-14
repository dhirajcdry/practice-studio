import { practiseFromMock } from './ui/button.js';
import { bindPythonTools } from './workspace-tools.js';
import { openLearningNotes } from './learning.js';
// LLD contributes a candidate-owned Python document; the interview panel owns all
// conversation, voice, timing, recovery and reports, exactly as in coding interviews.
import { el, replace } from './dom.js';
import { installPaneResizer } from './ui/split-pane.js';
import { createInterviewPanel, createInterviewSetup, interviewJson } from './interview.js';
import { createPythonEditorControls, mountPythonEditor } from './python-editor.js';
import { createPythonRun } from './python-run-output.js';
import { screenHeader, paneHeader } from './ui/headers.js';
import { createBadge } from './ui/badge.js';
import { initPractice, startPracticeFromMock } from './practice.js';
import { mountTrackHome } from './track-home.js';

export function initLLD(host) {
  const route = location.hash.split('/');
  if (route[2] === 'practice') return initPractice(host, { slug: route[3], id: route[4] });
  let gone = false, panel = null, editor = null, saveTimer;
  let home = null, unbindTools = () => {}, toolTarget = null, disposeSplit = () => {}, disposeHeader = () => {};
  let session = null, text = '', diskCode = '', saveChain = Promise.resolve(), edited = false;
  const life = new AbortController();
  const view = el('div', { class: 'lld-view' }); replace(host, view);
  // Catalog shortcuts must not intercept Enter on LLD cards or setup controls.
  view.addEventListener('keydown', event => event.stopPropagation());
  const notice = el('p', { class: 'lld-notice', role: 'status' });
  function fail(error) { if (!gone) notice.textContent = error.message; }
  const draftKey = () => session?.id ? `studio.lld.code:${session.id}` : null;
  const getCode = () => editor?.getValue() ?? text;
  function localDraft() { if (!edited || session?.debriefed || session?.endedAt) return; const key = draftKey(); if (key) try { localStorage.setItem(key, JSON.stringify({ code: getCode(), base: diskCode })); } catch { notice.textContent = 'Browser recovery storage unavailable. Save to disk before leaving.'; } }
  const endpoint = () => `/api/lld/${session.slug}/${session.id}/code`;
  function save() {
    if (!session?.id || !edited || session.debriefed || session.endedAt) return saveChain;
    const code = getCode(), url = endpoint(), key = draftKey();
    saveChain = saveChain.catch(() => {}).then(async () => {
      const response = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      const result = await response.json(); if (!response.ok) throw Error(result.error?.message || 'Document could not be saved.');
      if (!gone && getCode() === code) { diskCode = code; notice.textContent = 'Saved to disk'; edited = false; try { localStorage.removeItem(key); } catch {} }
      // Keep the recovery copy until a later load agrees with the saved document.
      return key;
    }).catch(fail);
    return saveChain;
  }
  function changed(value) {
    text = value; edited = true; localDraft(); clearTimeout(saveTimer); saveTimer = setTimeout(save, 500);
    notice.textContent = 'Saving…';
    window.dispatchEvent(new CustomEvent('studio-interview-work', { detail: { slug: session?.slug, type: 'typing' } }));
  }
  async function workspace(entry, initialState = null, id = null) {
    view.classList.add('is-workspace', 'ui-workspace');
    disposeSplit();
    home?.destroy(); home = null; panel?.dispose(); panel = null; unbindTools(); toolTarget = null; editor?.dispose(); editor = null;
    session = { ...initialState, slug: entry.slug, id }; text = ''; diskCode = ''; edited = false;
    const codeHost = el('div', { class: 'lld-code', 'aria-label': 'Python design document' });
    const pythonRun = createPythonRun({ fileName: 'design.py', editor: () => editor, disabled: true,
      canRun: () => Boolean(session?.id && !session.debriefed && !session.endedAt),
      execute: async () => { await save(); return interviewJson('/api/lld/run', { slug: session.slug, interviewId: session.id, code: getCode() }); } });
    const { button: run, root: output } = pythonRun;
    const editorControls = createPythonEditorControls();
    const interviewHost = el('div', { class: 'lld-interviewer' });
    // One meta pattern for both tracks: level · track (· language). A review adds its state.
    const metaText = () => `${session.targetLevel || 'L4'} · Low-level design · Python`;
    const subtitle = el('span', { text: metaText() });
    const stateBadge = createBadge('Debriefed', 'good');
    const paintBadge = () => {
      const review = Boolean(session.endedAt || session.debriefed);
      stateBadge.hidden = !review;
      stateBadge.className = `ui-badge ui-badge--${session.debriefed ? 'success' : 'neutral'}`;
      stateBadge.textContent = session.debriefed ? 'Debriefed' : 'Not debriefed';
    };
    paintBadge();
    const practiceAction = practiseFromMock({ variant: 'secondary',  onClick: async event => {
        const button = event.currentTarget; button.disabled = true;
        try { await save(); if (edited) throw Error('Save the latest document before creating a practice copy.'); await startPracticeFromMock({ discipline: 'lld', slug: entry.slug, interviewId: session.id }); }
        catch (error) { fail(error); button.disabled = false; }
      } });
    const notesAction = el('button', { class: 'btn btn--quiet', text: 'Learning notes', onclick: () => openLearningNotes(entry.slug, entry.title) });
    const reportAction = el('button', { class: 'btn btn--primary', text: 'View report', onclick: () => panel?.showReport() });
    const headerHost = el('div');
    // Built once. onState fires on idle ticks, so the action rail is swapped only when the
    // screen really changes (live to review, report ready, the panel arriving); rebuilding
    // it on every tick dropped focus from Finish and orphaned open menus.
    let header = null, headerKey = '';
    disposeHeader();
    const renderHeader = () => {
      const review = Boolean(session.endedAt || session.debriefed);
      paintBadge();
      practiceAction.classList.toggle('btn--primary', review && !session.debriefed);
      practiceAction.classList.toggle('btn--secondary', !review || Boolean(session.debriefed));
      const key = `${review}:${Boolean(session.debriefed)}:${Boolean(panel)}`;
      if (key === headerKey) return;
      headerKey = key;
      const status = !review ? panel?.headerControls : null;
      // A live mock keeps Learning notes in More actions (past performance competes with Finish).
      const actions = { primary: review ? (session.debriefed ? reportAction : practiceAction) : null,
        secondary: [review ? notesAction : null, review && session.debriefed ? practiceAction : null],
        overflow: !review ? [practiceAction, notesAction] : [] };
      if (header) { header.setActions(actions, status); return; }
      header = screenHeader({ title: entry.title, crumb: 'Low-level design', badges: [stateBadge], meta: [subtitle], back: { href: '#/lld', label: 'Back to Low-level design' }, status, actions });
      headerHost.append(header);
      disposeHeader = () => { header?.dispose(); disposeHeader = () => {}; };
    };
    renderHeader();
    replace(view, [headerHost, el('div', { class: 'lld-workspace' }, [
      el('section', { class: 'lld-document card ui-editor-surface' }, [Object.assign(paneHeader({ title: 'design.py', subtitle: notice, tools: [editorControls.root, run] }), { className: 'ui-pane-header python-document-bar' }), codeHost, output]), interviewHost,
    ])]);
    notice.textContent = id ? 'Loading document…' : 'Blank document';
    disposeSplit = installPaneResizer(view.querySelector('.lld-workspace'), { storageKey: 'studio.workspace-split.lld.v1', minLeft: 420, label: 'Python document and interviewer' });
    if (id) {
      try {
        const [saved, record] = await Promise.all([interviewJson(endpoint()), interviewJson(`/api/interview/${entry.slug}/${id}`)]);
        if (gone) return;
        session = { ...session, ...(record.state || record) };
        subtitle.textContent = metaText();
        text = diskCode = saved.code || '';
        let draft = null; try { draft = JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch {}
        if (!session.debriefed && !session.endedAt && draft?.code !== undefined && draft.base === diskCode && draft.code !== diskCode) { text = draft.code; edited = true; notice.textContent = 'Recovered browser draft'; }
        else if (!session.debriefed && draft?.code !== undefined && draft.code !== diskCode) {
          const recovery = el('details', { class: 'ui-inset' }, [el('summary', { text: 'A different browser draft is available — saved document kept' }), el('pre', { class: 'lld-output mono', text: draft.code })]);
          codeHost.before(recovery);
        }
        else notice.textContent = session.debriefed ? 'Completed document · read-only' : 'Saved to disk';
      } catch (error) { fail(error); return; }
    }
    editor = mountPythonEditor(codeHost, text, {
      controls: editorControls, label: 'Python design document',
      readOnly: Boolean(session.debriefed || session.endedAt),
      onChange: () => changed(editor.getValue()), onRun: () => run.click(), onSave: save,
      onEscape: () => { editor.blur(); run.focus(); },
    });
    editor.ready.then(({ error }) => { if (error && !gone) notice.textContent = 'Plain editor · Python runs remain available'; });
    panel = createInterviewPanel({ ...entry, discipline: 'lld' }, { id, initialState, getCode, contained: true,
      onBack: () => { location.hash = '#/lld'; },
      onState: state => {
        session = { ...session, ...state }; renderHeader(); run.disabled = !state.id || Boolean(state.debriefed || state.endedAt);
        subtitle.textContent = metaText();
        editor?.setReadOnly(Boolean(state.debriefed || state.endedAt));
        if (state.id) {
          const target = `interview:${entry.slug}:${state.id}`;
          if (target !== toolTarget) {
            unbindTools(); toolTarget = target;
            unbindTools = bindPythonTools({ target, editor, save: async () => { await save(); if (edited) throw Error('Document is not saved.'); }, changed: () => changed(editor.getValue()), readOnly: () => Boolean(session.debriefed || session.endedAt) });
          }
          history.replaceState(null, '', `#/lld/${entry.slug}/${state.id}`);
          if (edited) { localDraft(); save(); }
        }
      },
    });
    interviewHost.append(panel.root); renderHeader(); panel.setVisible(true);
  }
  async function library() {
    try {
      const data = await interviewJson('/api/lld'); if (gone) return;
      const entries = data.scenarios.map(item => ({ ...item, slug: item.slug.startsWith('lld-') ? item.slug : `lld-${item.slug}`, discipline: 'lld' }));
      const path = location.hash.split('/');
      if (path[2] && path[3]) {
        const entry = entries.find(item => item.slug === path[2]) || data.interviews.find(item => item.slug === path[2]);
        if (!entry) throw Error('Unknown LLD problem.');
        return workspace(entry, null, path[3]);
      }
      const interviews = (data.interviews || []).map(item => ({ ...item, title: item.title || entries.find(entry => entry.slug === item.slug)?.title }));
      home = mountTrackHome(view, {
        discipline: 'lld', title: 'Low-level design',
        loadInterviews: async () => ({ interviews }),
        openInterview: item => { location.hash = `#/lld/${item.slug}/${item.id}`; },
        startMock: async (problem, state) => {
          if (problem) return workspace(entries.find(entry => entry.slug === problem.slug) || { ...problem, discipline: 'lld' }, state);
          const prepared = (await interviewJson('/api/mock/prepare', { discipline: 'lld', targetLevel: state.targetLevel, minutes: state.minutes, requestId: state.startRequestId })).problem;
          if (!gone) await workspace(prepared, { ...state, slug: prepared.slug, title: prepared.title });
        },
      });
    } catch (error) { replace(view, [notice, el('a', { href: '#/lld', text: 'Back to Low-level design' })]); fail(error); }
  }
  window.addEventListener('beforeunload', event => { if (edited) { localDraft(); event.preventDefault(); event.returnValue = ''; } }, { signal: life.signal });
  library();
  return { destroy() { localDraft(); save(); gone = true; home?.destroy(); disposeSplit(); disposeHeader(); clearTimeout(saveTimer); life.abort(); panel?.dispose(); unbindTools(); editor?.dispose(); } };
}
