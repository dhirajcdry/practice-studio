import { bindPythonTools, bindBoardTools, showWorkspaceAction } from './workspace-tools.js';
// Both design disciplines share one untimed, question-led learning workspace.
import { el, replace } from './dom.js';
import { workspaceHeader } from './ui/headers.js';
import { createComposer, composerSend, bindComposerInput } from './ui/composer.js';
import { createSelect } from './ui/select.js';
import { createPythonEditorControls, mountPythonEditor } from './python-editor.js';
import { loadExcalidraw } from './whiteboard.js';
import { getSettings, onSettingsChange } from './settings.js';
import { renderMarkdown } from './markdown.js';
import { openLearningNotes, saveLearningNote } from './learning.js';
import { relativeInterviewDate } from './interview-format.js';
import { streamInterviewRequest } from './interview-transport.js';
import { createVoicePanel } from './ui/voice-panel.js';
import { createVoiceControl } from './voice.js';
import { createSpeaker, turnDecision } from './speech.js';
import { createSpeechStream } from './speech-stream.js';
import { createVoiceLoop } from './voice-loop.js';
import { readDraft, saveDraft, clearDraft, appendDraft } from './drafts.js';
import { createCoachModelPicker } from './coach-model.js';
import { createPracticeTimer } from './practice-timer.js';
import { installPaneResizer } from './ui/split-pane.js';

const voiceLaunches = new Set();
export const practiceHref = session => `#/${session.discipline === 'lld' ? 'lld' : 'design'}/practice/${session.slug}/${session.id}`;
async function json(url, body, method = 'POST') {
  let r;
  try { r = await fetch(url, body === undefined ? undefined : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (cause) { throw Object.assign(Error('Could not reach the local Studio server.', { cause }), { network: true }); }
  const result = await r.json();
  if (!r.ok) throw Error(result.error?.message || 'Practice could not be saved.');
  return result;
}
export async function startPractice(problem, snapshot = {}) {
  const { session } = await json('/api/practice/start', { ...problem, ...snapshot, mode: 'voice' });
  voiceLaunches.add(session.id);
  location.hash = practiceHref(session);
}
export async function startPracticeFromMock({ discipline, slug, interviewId }) {
  const { session } = await json('/api/practice/start', {
    discipline, ...(slug ? { slug } : {}), source: { interviewId }, mode: 'voice',
  });
  voiceLaunches.add(session.id);
  location.hash = practiceHref(session);
}
export function createPracticeLauncher({ discipline, problems }) {
  let gone = false;
  const picker = createSelect({ label: 'Practice problem', value: '', options: [['', 'Choose my own problem'], ...problems.map(p => [p.slug, p.title])] });
  const status = el('p', { class: 'dim', role: 'status', hidden: true });
  const start = el('button', { class: 'btn btn--secondary', text: 'Start practice', onclick: async () => {
    start.disabled = true; status.hidden = true;
    try { const selected = problems.find(p => p.slug === picker.value); await startPractice(selected ? { ...selected, discipline } : { discipline, title: 'Open practice', statement: '' }); }
    catch (error) { status.hidden = false; status.textContent = error.message; }
    finally { start.disabled = false; }
  } });
  const saved = el('div', { class: 'pr-saved' });
  const root = el('section', { class: 'pr-launch card ui-inset ui-inset--roomy' }, [
    el('div', { class: 'ui-stack' }, [el('h2', { text: 'Untimed practice' }), el('p', { class: 'dim', text: 'Start with any problem. Describe it to your coach, or pick an example below.' })]),
    el('div', { class: 'ui-cluster' }, [picker, start]), status, saved,
  ]);
  json(`/api/practice?discipline=${discipline}`).then(({ sessions }) => {
    if (gone || !sessions.length) return;
    replace(saved, [el('h3', { text: 'Continue practising' }), ...sessions.map(s => el('a', { class: 'pr-saved-row ui-row', href: practiceHref(s) }, [
      el('strong', { class: 'ui-row-content', text: s.title }), el('span', { class: 'dim ui-row-trailing', text: relativeInterviewDate(s.updatedAt) }),
    ]))]);
  }).catch(error => { if (!gone) { status.hidden = false; status.textContent = error.message; } });
  return { root, dispose() { gone = true; picker.dispose(); } };
}

export function initPractice(host, { slug, id }) {
  let gone = false, session, mode = 'voice', busy = false, sending = false, voiceState = 'idle', spokenThisTurn = false;
  let code = '', elements = [], editor, boardRoot, boardApi, voice, speaker, picker, modelPicker, timer;
  let untheme = () => {}, saveChain = Promise.resolve(), revision = 0, savedRevision = 0, following = true;
  let lastRequest = null, pendingPoll = null, unbindTools = () => {};
  let problemText, practiceTimer, disposeSplit = () => {};
  const exchangeNodes = new Map();
  const endpoint = `/api/practice/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`;
  const draftKey = `practice:${id}`, workKey = `studio.practice.work:${id}`, requestKey = `studio.practice.request:${id}`;
  const view = el('div', { class: 'pr-view ui-workspace' });
  const saveStatus = el('span', { class: 'dim pr-save', role: 'status', text: 'Saved' });
  const error = el('p', { class: 'pr-error', role: 'status', hidden: true });
  const errors = new Map();
  let saveFailure = '', draftFailure = '';
  const workErrorText = el('span', { class: 'ui-cluster-content' });
  const retrySave = el('button', { class: 'btn btn--secondary btn--sm', type: 'button', text: 'Retry saving', onclick: async () => {
    retrySave.disabled = true;
    try { await save(); } catch { /* The save owns its error and recovery state. */ }
    finally { if (!gone) retrySave.disabled = false; }
  } });
  const workError = el('div', { class: 'pr-work-error ui-cluster ui-inset ui-inset--compact', role: 'status', hidden: true }, [workErrorText, retrySave]);
  const thread = el('div', { class: 'pr-thread ui-pane-scroll ui-inset', role: 'log', 'aria-label': 'Practice conversation', tabindex: '0' });
  const input = el('textarea', { class: 'coach-input', rows: '2', 'aria-label': 'Ask your practice coach', placeholder: 'Ask about your design, an edge case, or a trade-off…' });
  input.value = readDraft(draftKey)?.text || '';
  const inputSize = bindComposerInput(input);
  let partialWords = '', playbackInterrupted = false, voiceLoop, replySpeech, windowFocused = document.hasFocus();
  const voiceView = createVoicePanel({ role: 'Coach', onEdit: () => setInputMode('typed'), onReplay: text => { voice?.stop(); speaker?.say(text); } });
  const status = el('span', { class: 'pr-state', role: 'status' });
  const send = composerSend(el('button', { type: 'button', onclick: () => ask() }));
  const mic = el('button', { class: 'btn btn--secondary', text: 'Start voice', onclick: () => {
    if (voiceLoop?.enabled) { voiceLoop.pause(); interruptReply(); }
    else { speaker?.cancel(); voiceLoop?.start(); }
  } });
  const interrupt = el('button', { class: 'btn btn--quiet', text: 'Interrupt', hidden: true, onclick: () => interruptReply() });
  const retry = el('button', { class: 'btn btn--secondary', text: 'Retry reply', hidden: true, onclick: () => ask(lastRequest) });
  const actions = el('div', { class: 'pr-actions' }, [mic, interrupt, retry, send]);
  const typed = el('div', { class: 'pr-typed' }, input);
  const voicePane = el('div', { class: 'pr-voice' }, [voiceView.root]);
  const work = el('section', { class: 'pr-work card ui-editor-surface' });
  const output = el('pre', { class: 'lld-output mono', hidden: true });
  const run = el('button', { class: 'btn btn--secondary python-run', type: 'button', title: "Run Python (⌘')", text: 'Run Python', onclick: async () => {
    run.disabled = true; output.hidden = false; output.textContent = 'Running…';
    try {
      await save();
      const result = await json('/api/practice/run', { slug, id, code: currentCode() });
      output.textContent = `${result.timedOut ? 'Time limit exceeded' : `Exit ${result.exitCode ?? '—'}`}\n${result.stdout || ''}${result.stderr || ''}`;
    } catch (e) { output.textContent = e.message; }
    finally { run.disabled = false; }
  } });
  const currentCode = () => editor?.getValue() ?? code;
  function updateTopic(topic) {
    if (!session || !topic || gone) return;
    session.title = topic.title; session.statement = topic.statement;
    const heading = view.querySelector('.ui-workspace-identity h1');
    if (heading) heading.textContent = session.title;
    if (problemText) problemText.textContent = session.statement || 'Describe any problem to your coach to get started.';
  }
  function paintErrors() { if (!gone) { error.hidden = errors.size === 0; error.textContent = [...errors.values()].join('\n'); } }
  function showError(e, scope = 'reply') {
    errors.set(scope, e.network || /^(Failed to fetch|Load failed|NetworkError)/i.test(e.message || '')
      ? 'Could not reach Studio. Your conversation is saved; retry when the server is available.' : e.message || String(e));
    paintErrors();
  }
  function clearError(scope) { errors.delete(scope); paintErrors(); }
  function paintWorkError() {
    if (gone) return;
    workError.hidden = !saveFailure && !draftFailure;
    workErrorText.textContent = [saveFailure, draftFailure].filter(Boolean).join(' ');
  }
  function recoverWork() {
    try { return JSON.parse(localStorage.getItem(workKey) || 'null'); } catch { return null; }
  }
  // Queued saves own their data: Excalidraw mutates elements in place while typing.
  function snapshot() { return session?.discipline === 'lld' ? { code: currentCode(), mode } : { elements: structuredClone(elements), mode }; }
  function changed() {
    revision++; saveStatus.textContent = 'Saving…';
    try { localStorage.setItem(workKey, JSON.stringify(snapshot())); draftFailure = ''; }
    catch { draftFailure = 'Browser recovery storage is unavailable. Keep this tab open until Saved.'; }
    paintWorkError();
    clearTimeout(timer); timer = setTimeout(() => save().catch(() => {}), 500);
  }
  function save() {
    if (!session) return saveChain;
    const data = snapshot(), version = revision;
    saveChain = saveChain.catch(() => {}).then(() => json(endpoint, data, 'PUT')).then(() => {
      savedRevision = version;
      if (version === revision) {
        try { localStorage.removeItem(workKey); } catch { /* The server has the current work. */ }
        saveFailure = ''; draftFailure = ''; paintWorkError();
        if (!gone) saveStatus.textContent = 'Saved';
      }
    }).catch(e => {
      if (!gone) saveStatus.textContent = 'Not saved';
      saveFailure = e.network ? 'Could not reach Studio to save. Your changes are still in this tab.' : `Work not saved: ${e.message || e}. Keep this tab open.`;
      paintWorkError(); e.workspaceSave = true; throw e;
    });
    return saveChain;
  }
  function setInputMode(next) {
    mode = next; picker.value = next; spokenThisTurn = false; playbackInterrupted = true; replySpeech?.cancel(); speaker?.cancel();
    if (mode === 'voice') voiceLoop?.start(); else voiceLoop?.pause();
    changed(); paint(); if (mode === 'typed') input.focus();
  }
  function paint() {
    typed.hidden = mode !== 'typed'; voicePane.hidden = mode !== 'voice';
    inputSize.resize();
    voiceView.update({state: voiceState, draft: input.value, partial: partialWords, busy, sending, paused: !voiceLoop?.enabled});
    send.disabled = busy || sending || (!input.value.trim() && !['recording','working'].includes(voiceState));
    mic.hidden = mode !== 'voice';
    mic.disabled = sending || voiceState === 'working';
    mic.textContent = voiceLoop?.enabled ? 'Pause voice' : 'Start voice';
    mic.setAttribute('aria-pressed', String(!!voiceLoop?.enabled));
    interrupt.hidden = !speaker?.speaking;
    status.textContent = speaker?.speaking ? 'Coach speaking' : busy ? 'Coach is thinking…' : voiceState === 'working' ? 'Transcribing…' : voiceState === 'recording' ? 'Listening' : 'Ready when you are';
    status.hidden = mode === 'voice' || status.textContent === 'Ready when you are';
    send.hidden = mode === 'voice' && !(input.value.trim() || ['recording','working'].includes(voiceState));
    retry.hidden = !lastRequest || busy;
    bottom();
  }
  function bottom() { if (following) thread.scrollTop = thread.scrollHeight; }
  function exchange(question, answer = '', state = 'complete', requestId = null) {
    if (requestId && exchangeNodes.has(requestId)) return exchangeNodes.get(requestId);
    const reply = el('div', { class: 'rich pr-answer' }, answer ? renderMarkdown(answer) : null);
    const marker = el('span', { class: 'dim pr-exchange-status', text: state === 'pending' ? 'Reply in progress…' : state === 'failed' ? 'Reply incomplete' : '' });
    thread.querySelector('.pr-empty')?.remove();
    const saveNote = el('button', { class: 'btn btn--quiet btn--sm', text: 'Save to notes', onclick: async () => {
      saveNote.disabled = true;
      try { await saveLearningNote(slug, `Question: ${question}\n\n${reply.dataset.markdown || answer}`); saveNote.textContent = 'Saved to notes'; clearError(`note:${requestId}`); }
      catch (e) { showError(e, `note:${requestId}`); saveNote.disabled = false; }
    } });
    saveNote.hidden = !answer;
    thread.append(el('article', { class: 'pr-exchange' }, [el('div', { class: 'pr-question' }, [el('span', { class: 'pr-who', text: 'You' }), el('p', { text: question })]),
      el('span', { class: 'pr-who', text: 'Coach' }), reply, marker, saveNote]));
    const receipts = el('div', { class: 'pr-receipts' }); reply.before(receipts);
    const ui = { reply, marker, saveNote, receipts };
    if (requestId) exchangeNodes.set(requestId, ui);
    bottom(); return ui;
  }
  async function drain() {
    if (!voice?.isBusy()) return;
    voice.stop();
    await new Promise(resolve => { const tick = setInterval(() => { if (!voice.isBusy() || gone) { clearInterval(tick); resolve(); } }, 40); });
  }
  async function ask(retryRequest = null) {
    if (busy || sending || !session) return;
    sending = true; spokenThisTurn = false; paint(); voiceLoop?.sync();
    await drain();
    if (gone) { sending = false; return; }
    if (voice?.hasTranscriptionError()) { sending = false; paint(); return; }
    const question = retryRequest?.question || input.value.trim();
    if (!question) { sending = false; paint(); voiceLoop?.sync(); return; }
    const request = retryRequest || { slug, id, question, requestId: crypto.randomUUID(), ...snapshot() };
    busy = true; sending = false; clearError('reply'); speaker.cancel();
    lastRequest = request;
    try { localStorage.setItem(requestKey, JSON.stringify(request)); } catch {}
    if (!retryRequest) { input.value = ''; clearDraft(draftKey); }
    // Sending a new question explicitly returns to the live reply, even if the
    // learner was reading older messages. Later scrolling still pauses following.
    following = true;
    const ui = exchange(question, '', 'complete', request.requestId); let answer = ''; playbackInterrupted = false;
    replySpeech = createSpeechStream(speaker);
    replace(ui.reply, []); ui.marker.textContent = ''; ui.saveNote.hidden = true;
    paint();
    try {
      await save();
      await streamInterviewRequest('/api/practice/ask', request, (name, value) => {
        if (gone) return;
        if (name === 'accepted') voiceView.sent(question);
        if (name === 'action') showWorkspaceAction(ui.receipts, value);
        if (name === 'practice_topic') updateTopic(value);
        if (name === 'token') { answer += value.text || ''; replace(ui.reply, renderMarkdown(answer)); bottom();
          if (mode === 'voice' && !playbackInterrupted) replySpeech.push(value.text || '');
        }
        if (name === 'done') { answer = value.answer ?? answer; replace(ui.reply, renderMarkdown(answer)); ui.reply.dataset.markdown = answer; ui.saveNote.hidden = false; }
      });
      lastRequest = null; localStorage.removeItem(requestKey);
      voiceView.reply(answer);
      if (!gone && mode === 'voice' && !playbackInterrupted) replySpeech.finish();
    } catch (e) {
      replySpeech?.cancel(); voiceLoop?.pause();
      ui.marker.textContent = e.workspaceSave ? 'Question not sent. Save your work, then retry.' : 'Reply incomplete. Your question is saved.';
      if (!e.workspaceSave) showError(e);
    }
    finally { busy = false; if (!gone) { paint(); bottom(); voiceLoop?.sync(); } }
  }
  function interruptReply() {
    playbackInterrupted = true; replySpeech?.cancel(); speaker?.cancel(); voiceLoop?.sync(); paint();
  }
  thread.addEventListener('scroll', () => { following = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48; });
  input.addEventListener('input', () => { saveDraft(draftKey, input.value); paint(); });
  input.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); ask(); } });
  view.addEventListener('keydown', e => {
    // Excalidraw listens above its canvas for shape/undo shortcuts.
    if (!e.target.closest('.excalidraw')) e.stopPropagation();
    if (e.key === 'Escape') interruptReply();
  });
  replace(host, el('p', { class: 'ui-inset', text: 'Opening practice…' }));
  (async () => {
    try {
      const data = await json(endpoint); if (gone) return;
      session = data.session; mode = session.mode || 'voice'; code = data.code || session.code || ''; elements = data.elements || session.elements || [];
      // Timer failures already live beside Pause/Resume and clear on its own retry.
      practiceTimer = createPracticeTimer({ timer: session.timer, serverNow: data.serverNow, change: running => json(`${endpoint}/timer`, { running }), onError: () => {} });
      const candidateSource = data.sourceSnapshot?.source || session.source;
      const source = candidateSource && typeof candidateSource === 'object' && candidateSource.interviewId ? candidateSource : null;
      const recovered = recoverWork();
      if (recovered) { code = recovered.code ?? code; elements = recovered.elements ?? elements; mode = recovered.mode || mode; }
      try { lastRequest = JSON.parse(localStorage.getItem(requestKey) || 'null'); } catch {}
      if (data.exchanges.some(e => e.requestId === lastRequest?.requestId && e.status === 'complete')) { lastRequest = null; localStorage.removeItem(requestKey); }
      const interrupted = data.exchanges.findLast(e => e.status === 'pending' || e.status === 'failed');
      if (!lastRequest && interrupted) lastRequest = { slug, id, question: interrupted.question, requestId: interrupted.requestId };
      picker = createSelect({ label: 'Answer mode', compact: true, value: mode, options: [['voice', 'Voice'], ['typed', 'Typed']], onChange: () => {
        setInputMode(picker.value);
      } });
      modelPicker = createCoachModelPicker({ compact: true });
      const canvas = el('div', { class: session.discipline === 'lld' ? 'lld-code pr-editor' : 'dz-canvas pr-board ui-editor-surface' });
      const editorControls = session.discipline === 'lld' ? createPythonEditorControls() : null;
      work.append(el('div', { class: 'pr-work-bar python-document-bar ui-toolbar' }, [el('div', { class: 'python-document-identity' }, [el('strong', { text: session.discipline === 'lld' ? 'design.py' : 'Whiteboard' }), saveStatus]), editorControls?.root, session.discipline === 'lld' ? run : null]), workError, canvas);
      if (session.discipline === 'lld') work.append(output);
      problemText = el('p', { text: session.statement || 'Describe any problem to your coach to get started.' });
      const statement = el('details', { class: 'pr-problem' }, [el('summary', { text: source ? 'Problem and mock feedback' : 'Problem' }), problemText]);
      if (source) {
        const feedback = data.sourceSnapshot?.feedback;
        const feedbackNode = typeof feedback === 'string' && feedback.trim() ? renderMarkdown(feedback) : el('p', { text: 'No mock feedback was recorded.' });
        const feedbackDetails = el('section', { class: 'pr-feedback' }, [el('h3', { text: 'Mock feedback' }), feedbackNode]);
        statement.append(feedbackDetails);
      }
      thread.prepend(statement);
      const coach = el('aside', { class: 'pr-coach card ui-pane', 'aria-label': 'Practice coach' }, [
        el('div', { class: 'pr-coach-head ui-toolbar' }, [el('strong', { text: 'Practice coach' }), status]), thread,
        createComposer({ className: 'pr-compose ui-pane-controls', content: [typed, voicePane],
          leading: [picker, modelPicker.root], trailing: [actions], notices: [error] }),
      ]);
      view.append(workspaceHeader({ title: session.title, subtitle: `${session.discipline === 'lld' ? 'Python · ' : ''}Untimed practice`, backHref: `#/${session.discipline === 'lld' ? 'lld' : 'design'}`, backLabel: session.discipline === 'lld' ? 'Low-level design' : 'System design', actions: [source ? el('a', { class: 'pr-source-link', href: source.discipline === 'lld' ? `#/lld/${encodeURIComponent(source.slug)}/${encodeURIComponent(source.interviewId)}` : `#/design/${encodeURIComponent(source.interviewId)}`, text: `From mock · ${source.startedAt || source.capturedAt ? relativeInterviewDate(source.startedAt || source.capturedAt) : 'original'}` }) : null, practiceTimer.root, el('button', { class: 'btn btn--secondary pr-notes', text: 'Learning notes', onclick: () => openLearningNotes(slug, session.title) })] }),
        el('div', { class: 'pr-split' }, [work, coach]));
      replace(host, view);
      disposeSplit = installPaneResizer(view.querySelector('.pr-split'), { storageKey: `studio.workspace-split.${session.discipline}.v1`, minLeft: session.discipline === 'lld' ? 420 : 360 });
      if (!data.exchanges.length) thread.append(el('div', { class: 'pr-empty' }, [el('h2', { text: session.openEnded && !session.statement ? 'What would you like to work on?' : 'Make room to think.' }), el('p', { class: 'dim', text: session.openEnded && !session.statement ? 'Describe a question, paste its requirements, or ask for a suggestion. Your coach will keep the problem and your work here as you go.' : 'Your coach sees your work when you ask a question. Explore the problem, try an approach, and ask for help whenever you need it.' })]));
      else for (const item of data.exchanges) {
        const ui = exchange(item.question, item.answer, item.status, item.requestId);
        for (const action of item.actions || []) showWorkspaceAction(ui.receipts, action, { replay: true });
        voiceView.sent(item.question); if (item.answer) voiceView.reply(item.answer);
      }
      if (data.busy) { busy = true; watchPending(); }
      speaker = createSpeaker({ onPlayback: value => voiceView.playback(value), onStateChange: active => { if (active) voice?.stop(); if (!gone) { paint(); voiceLoop?.sync(); } } });
      voice = createVoiceControl({ getSlug: () => '', logTakes: false, maxTakeMs:60*60000, reportEmptyTake:false, onSettled:()=>voiceLoop?.sync(), onPreview: text => { partialWords = text; if (!gone) paint(); }, onTranscript: text => {
        if (gone) { appendDraft(draftKey, text); return; }
        input.value += (input.value ? ' ' : '') + text; saveDraft(draftKey, input.value); paint();
      }, onState: state => { voiceState = state; if (!gone) paint(); }, onLevel: value => {
        voiceView.level(value); const {sinceLoud,pending} = value; if(value.loud)spokenThisTurn=true;
        if (voiceView.automatic && !voice.hasTranscriptionError() && voiceLoop?.enabled && spokenThisTurn && mode === 'voice' && turnDecision({ sinceLoud, chars: input.value.trim().length, pending, speaking: speaker.speaking, busy: busy || sending }) === 'send') ask();
      } });
      voiceLoop = createVoiceLoop({capture:voice,speaker,canListen:()=>!gone&&mode==='voice'&&!document.hidden&&windowFocused&&!sending&&(!busy||playbackInterrupted),onChange:()=>{if(!gone)paint();}});
      voicePane.append(voice.status);
      if (session.discipline === 'lld') {
        editor = mountPythonEditor(canvas, code, {
          controls: editorControls, label: 'Python practice document', onChange: changed,
          onRun: () => run.click(), onSave: () => save().catch(() => {}),
          onEscape: () => { editor.blur(); run.focus(); },
        });
        unbindTools = bindPythonTools({ target: `practice:${slug}:${id}`, editor, save, changed });
        const { error } = await editor.ready; if (gone) return;
        if (error) saveStatus.textContent = 'Plain editor';
      } else {
        const ex = await loadExcalidraw(); if (gone) return;
        boardRoot = ex.createRoot(canvas);
        boardRoot.render(ex.createElement(ex.Excalidraw, { theme: getSettings().dark ? 'dark' : 'light', excalidrawAPI: api => { boardApi = api; }, initialData: { elements: structuredClone(elements), scrollToContent: true }, onChange: next => {
          // Keep the comparison baseline detached from the canvas's mutable objects.
          if (JSON.stringify(next) === JSON.stringify(elements)) return; elements = structuredClone(next); changed();
        }, UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, export: false } } }));
        unbindTools = bindBoardTools({ target: `practice:${slug}:${id}`, getApi: () => boardApi, getElements: () => elements, setElements: next => { elements = structuredClone(next); changed(); }, save });
        untheme = onSettingsChange(settings => boardApi?.updateScene({ appState: { theme: settings.dark ? 'dark' : 'light' } }));
      }
      if (recovered) changed(); paint(); bottom();
      if (voiceLaunches.delete(id) && mode === 'voice') voiceLoop.start();
    } catch (e) {
      if (!gone && !view.isConnected) replace(host, el('div', { class: 'ui-inset' }, [el('p', { text: e.message }), el('a', { href: `#/${slug.startsWith('lld-') ? 'lld' : 'design'}`, text: 'Back to library' })]));
      else showError(e);
    }
  })();
  // Reloading while the server is answering rejoins its durable record. It never
  // starts another model turn or re-sends the learner's question.
  function watchPending() {
    pendingPoll = setTimeout(async () => {
      if (gone) return;
      try {
        const data = await json(endpoint); if (gone) return;
        clearError('reconnect');
        updateTopic(data.session);
        for (const item of data.exchanges) {
          const ui = exchange(item.question, item.answer, item.status, item.requestId);
          for (const action of item.actions || []) showWorkspaceAction(ui.receipts, action, { replay: true });
        voiceView.sent(item.question); if (item.answer) voiceView.reply(item.answer);
          // Recovery polls are snapshots, not deltas. Replace the visible prefix
          // while pending too; do not replay historical text through the speaker.
          if (ui.reply.dataset.markdown !== (item.answer || '')) {
            replace(ui.reply, renderMarkdown(item.answer || '')); ui.reply.dataset.markdown = item.answer || '';
          }
          if (item.status !== 'pending') {
            ui.marker.textContent = item.status === 'failed' ? 'Reply incomplete. Retry when ready.' : '';
            ui.saveNote.hidden = item.status !== 'complete';
          }
        }
        busy = data.busy;
        if (busy) watchPending();
        else if (data.exchanges.some(e => e.requestId === lastRequest?.requestId && e.status === 'complete')) { lastRequest = null; localStorage.removeItem(requestKey); }
        paint(); bottom(); voiceLoop?.sync();
      } catch (e) { busy = false; showError(e, 'reconnect'); paint(); }
    }, 1200);
  }
  const beforeUnload = e => { if (revision !== savedRevision) { e.preventDefault(); e.returnValue = ''; } };
  const visibility=()=>{if(!gone)voiceLoop?.sync();};
  document.addEventListener('visibilitychange',visibility);
  const focus=()=>{windowFocused=true;visibility();};
  const blur=()=>{windowFocused=false;visibility();};
  window.addEventListener('focus',focus); window.addEventListener('blur',blur);
  window.addEventListener('beforeunload', beforeUnload);
  return { destroy() {
    practiceTimer?.dispose();
    disposeSplit();
    clearTimeout(timer); clearTimeout(pendingPoll); if (revision !== savedRevision) save().catch(() => {});
    gone = true; voiceLoop?.dispose(); replySpeech?.cancel(); document.removeEventListener('visibilitychange',visibility); window.removeEventListener('focus',focus); window.removeEventListener('blur',blur); window.removeEventListener('beforeunload', beforeUnload);
    voice?.dispose({ finish: true }); speaker?.dispose(); picker?.dispose(); modelPicker?.dispose();
    inputSize.dispose(); unbindTools(); editor?.dispose(); boardRoot?.unmount(); untheme();
  } };
}
