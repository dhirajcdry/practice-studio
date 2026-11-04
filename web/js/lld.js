import { bindPythonTools } from './workspace-tools.js';
import { openLearningNotes } from './learning.js';
// LLD contributes a candidate-owned Python document; the interview panel owns all
// conversation, voice, timing, recovery and reports, exactly as in coding interviews.
import { el, replace } from './dom.js';
import { installPaneResizer } from './ui/split-pane.js';
import { createInterviewPanel, createInterviewSetup, interviewJson } from './interview.js';
import { createPythonEditorControls, mountPythonEditor } from './python-editor.js';
import { relativeInterviewDate } from './interview-format.js';
import { icon } from './ui/icon.js';
import { createLearnerSummary } from './learner.js';
import { workspaceHeader } from './ui/headers.js';
import { createPracticeLauncher, initPractice, startPracticeFromMock } from './practice.js';

export function initLLD(host) {
  const route = location.hash.split('/');
  if (route[2] === 'practice') return initPractice(host, { slug: route[3], id: route[4] });
  let gone = false, panel = null, editor = null, setup = null, mockSetup = null, learner = null, saveTimer;
  let practiceLauncher = null, unbindTools = () => {}, toolTarget = null, disposeSplit = () => {};
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
    setup?.dispose(); mockSetup?.dispose(); learner?.dispose(); practiceLauncher?.dispose(); panel?.dispose(); unbindTools(); toolTarget = null; editor?.dispose(); editor = null;
    session = { ...initialState, slug: entry.slug, id }; text = ''; diskCode = ''; edited = false;
    const codeHost = el('div', { class: 'lld-code', 'aria-label': 'Python design document' });
    const output = el('pre', { class: 'lld-output mono', hidden: true, 'aria-live': 'polite' });
    const run = el('button', { class: 'btn btn--secondary python-run', type: 'button', title: "Run Python (⌘')", text: 'Run Python', disabled: true, onclick: async () => {
      if (!session?.id || session.debriefed) return;
      run.disabled = true; output.hidden = false; output.textContent = 'Running…';
      try {
        await save();
        const result = await interviewJson('/api/lld/run', { slug: session.slug, interviewId: session.id, code: getCode() });
        if (!gone) output.textContent = `${result.timedOut ? 'Time limit exceeded' : `Exit ${result.exitCode ?? '—'}`}\n${result.stdout || ''}${result.stderr || ''}`;
      } catch (error) { if (!gone) output.textContent = error.message; }
      finally { if (!gone) run.disabled = Boolean(session.debriefed || session.endedAt); }
    } });
    const editorControls = createPythonEditorControls();
    const interviewHost = el('div', { class: 'lld-interviewer' });
    const subtitle = el('p', { class: 'dim', text: `Python · ${session.targetLevel || 'L4'} · Low-level design` });
    replace(view, [workspaceHeader({ title: entry.title, subtitle, backHref: '#/lld', backLabel: 'Low-level design', actions: [
      el('button', { class: 'btn btn--quiet', text: 'Practise from this mock', onclick: async event => {
        const button = event.currentTarget; button.disabled = true;
        try { await save(); if (edited) throw Error('Save the latest document before creating a practice copy.'); await startPracticeFromMock({ discipline: 'lld', slug: entry.slug, interviewId: session.id }); }
        catch (error) { fail(error); button.disabled = false; }
      } }),
      el('button', { class: 'btn btn--secondary', text: 'Learning notes', onclick: () => openLearningNotes(entry.slug, entry.title) }),
    ] }), el('div', { class: 'lld-workspace' }, [
      el('section', { class: 'lld-document card ui-editor-surface' }, [el('div', { class: 'lld-document-bar python-document-bar ui-toolbar' }, [el('div', { class: 'python-document-identity' }, [el('strong', { text: 'design.py' }), notice]), editorControls.root, run]), codeHost, output]), interviewHost,
    ])]);
    notice.textContent = id ? 'Loading document…' : 'Blank document';
    disposeSplit = installPaneResizer(view.querySelector('.lld-workspace'), { storageKey: 'studio.workspace-split.lld.v1', minLeft: 420, label: 'Python document and interviewer' });
    if (id) {
      try {
        const [saved, record] = await Promise.all([interviewJson(endpoint()), interviewJson(`/api/interview/${entry.slug}/${id}`)]);
        if (gone) return;
        session = { ...session, ...(record.state || record) };
        subtitle.textContent = `Python · ${session.targetLevel || 'L4'} · Low-level design`;
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
        session = { ...session, ...state }; run.disabled = !state.id || Boolean(state.debriefed || state.endedAt);
        subtitle.textContent = `Python · ${session.targetLevel || 'L4'} · Low-level design`;
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
    interviewHost.append(panel.root); panel.setVisible(true);
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
      const interviews = data.interviews || [], seen = new Set(interviews.map(item => item.slug));
      learner = createLearnerSummary('lld');
      practiceLauncher = createPracticeLauncher({ discipline: 'lld', problems: entries });
      mockSetup = createInterviewSetup({ slug: 'lld-new-mock', discipline: 'lld', label: 'Mock interview', description: 'A fresh problem chosen from your history. Defend your design, then review the feedback.', startLabel: 'Start a new mock', onStart: async state => {
        const { problem } = await interviewJson('/api/mock/prepare', { discipline: 'lld', targetLevel: state.targetLevel, minutes: state.minutes, requestId: state.startRequestId });
        if (!gone) await workspace(problem, { ...state, slug: problem.slug, title: problem.title });
      } });
      let selected = null;
      const cards = entries.map(entry => {
        const startHost = el('div', { class: 'lld-start', id: `setup-${entry.slug}`, role: 'region', 'aria-labelledby': `choose-${entry.slug}`, hidden: true });
        const button = el('button', {
          class: 'lld-scenario', id: `choose-${entry.slug}`, type: 'button', dataset: { slug: entry.slug },
          'aria-expanded': 'false', 'aria-controls': startHost.id,
          onclick: () => {
            const closing = selected?.button === button;
            setup?.dispose(); setup = null;
            if (selected) {
              selected.button.setAttribute('aria-expanded', 'false');
              selected.host.hidden = true; replace(selected.host, []);
            }
            selected = null;
            if (closing) return;
            setup = createInterviewSetup({ ...entry, onStart: state => workspace(entry, state) });
            replace(startHost, [setup.root, el('button', { class: 'btn btn--quiet', text: 'Learning notes', onclick: () => openLearningNotes(entry.slug, entry.title) })]);
            startHost.hidden = false; button.setAttribute('aria-expanded', 'true');
            selected = { button, host: startHost };
            // Keep the result of the click beside the problem, including on small screens.
            startHost.scrollIntoView({ block: 'nearest' });
          },
        }, [el('span', { class: 'lld-scenario-copy' }, [
          el('strong', { text: entry.title }), el('span', { class: 'dim', text: seen.has(entry.slug) ? 'Mock attempted' : 'No mock yet' }),
        ]), icon('chevron')]);
        return el('div', { class: 'lld-choice' }, [button, startHost]);
      });
      const records = [...interviews].sort((a, b) => Number(b.startedAt) - Number(a.startedAt)).map(item => {
        const open = el('a', { class: 'lld-record-link', href: `#/lld/${item.slug}/${item.id}` }, [
          el('strong', { text: entries.find(entry => entry.slug === item.slug)?.title || item.slug }),
          el('span', { class: 'dim', text: `${item.debriefed ? 'Completed' : 'Unfinished'} · ${relativeInterviewDate(item.startedAt)}` }),
        ]);
        const practice = el('button', { class: 'btn btn--quiet', text: 'Practise from this mock', onclick: async event => {
          event.preventDefault(); event.stopPropagation(); practice.disabled = true;
          try { await startPracticeFromMock({ discipline: 'lld', slug: item.slug, interviewId: item.id }); }
          catch (error) { notice.textContent = error.message; practice.disabled = false; }
        } });
        return el('div', { class: 'lld-record ui-inset ui-cluster' }, [el('div', { class: 'ui-cluster-content' }, open), practice]);
      });
      replace(view, [el('header', { class: 'lld-heading' }, el('div', {}, [el('h1', { text: 'Low-level design' }), el('p', { class: 'dim', text: 'Design it. Implement it. Defend it.' })])),
        el('div', { class: 'lld-modes' }, [el('div', { class: 'lld-new-mock ui-stack' }, [mockSetup.root]), practiceLauncher.root]), learner.root,
        el('div', { class: 'lld-library' }, [el('section', {}, [el('h2', { text: 'Practise a specific problem' }), el('div', { class: 'lld-scenarios' }, cards)]),
        el('section', {}, [el('h2', { text: 'Your interviews' }), records.length ? el('div', { class: 'lld-records' }, records) : el('p', { class: 'dim', text: 'No LLD interviews recorded.' })])]), notice]);
    } catch (error) { replace(view, [notice, el('a', { href: '#/lld', text: 'Back to LLD' })]); fail(error); }
  }
  window.addEventListener('beforeunload', event => { if (edited) { localDraft(); event.preventDefault(); event.returnValue = ''; } }, { signal: life.signal });
  library();
  return { destroy() { localDraft(); save(); gone = true; disposeSplit(); clearTimeout(saveTimer); life.abort(); panel?.dispose(); setup?.dispose(); mockSetup?.dispose(); learner?.dispose(); practiceLauncher?.dispose(); unbindTools(); editor?.dispose(); } };
}
