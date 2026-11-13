import { questionNode } from './ui/turn.js';
import { createWorkspaceReply, workspaceReply, interviewStamp } from './ui/workspace-turn.js';
import { bindPythonTools, bindBoardTools, showWorkspaceAction } from './workspace-tools.js';
// Both design disciplines share one untimed, question-led learning workspace.
import { el, replace } from './dom.js';
import { icon } from './ui/icon.js';
import { tooltip } from './tooltip.js';
import { claimActionKey, hasOpenOverlay } from './keyboard.js';
import { workspaceHeader, paneHeader } from './ui/headers.js';
import { createComposer, composerSend, bindComposerInput, mountComposerDictation } from './ui/composer.js';
import { createSelect } from './ui/select.js';
import { createPythonEditorControls, mountPythonEditor } from './python-editor.js';
import { loadExcalidraw, boardTools } from './whiteboard.js';
import { getSettings, onSettingsChange } from './settings.js';
import { bindConversation, conversationText, setConversationText } from './ui/conversation.js';
import { openLearningNotes, saveLearningNote } from './learning.js';
import { relativeInterviewDate } from './interview-format.js';
import { streamInterviewRequest } from './interview-transport.js';
import { createVoicePanel, answerModeSwitch, micToggle, paintMicToggle, replayButton } from './ui/voice-panel.js';
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
  let code = '', elements = [], editor, boardRoot, boardApi, voice, speaker, modelPicker, timer;
  let untheme = () => {}, saveChain = Promise.resolve(), revision = 0, savedRevision = 0, following = true;
  let lastRequest = null, pendingPoll = null, unbindTools = () => {};
  let conversationView;
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
  const retrySave = el('button', { class: 'btn btn--secondary', type: 'button', text: 'Retry saving', onclick: async () => {
    retrySave.disabled = true;
    try { await save(); } catch { /* The save owns its error and recovery state. */ }
    finally { if (!gone) retrySave.disabled = false; }
  } });
  const workError = el('div', { class: 'pr-work-error ui-cluster ui-inset ui-inset--compact', role: 'status', hidden: true }, [workErrorText, retrySave]);
  const thread = el('div', { class: 'pr-thread ui-pane-scroll', role: 'log', 'aria-label': 'Practice conversation', tabindex: '0' });
  const input = el('textarea', { class: 'coach-input', rows: '2', 'aria-label': 'Ask your practice coach', placeholder: 'Ask the coach' });
  input.value = readDraft(draftKey)?.text || '';
  const inputSize = bindComposerInput(input);
  let partialWords = '', playbackInterrupted = false, voiceLoop, replySpeech, windowFocused = document.hasFocus();
  const voiceView = createVoicePanel({ role: 'Coach', onEdit: () => setInputMode('typed') });
  const replayReply = text => { if (busy || speaker?.speaking) return; speaker?.say(text); };
  const status = el('span', { class: 'pr-state', role: 'status' });
  const send = composerSend(el('button', { type: 'button', onclick: () => ask() }));
  const voiceSend = composerSend(el('button', { type: 'button', hidden: true, onclick: () => ask() }));
  const mic = micToggle(() => {
    if (voiceLoop?.enabled) { voiceLoop.pause(); interruptReply(); }
    else { speaker?.cancel(); voiceLoop?.start(); }
  });
  const interrupt = el('button', { class: 'btn btn--secondary', text: 'Interrupt · Esc', hidden: true, onclick: () => interruptReply() });
  const typeLink = answerModeSwitch('typed', setInputMode);
  const voiceLink = answerModeSwitch('voice', setInputMode);
  const retry = el('button', { class: 'btn btn--secondary', text: 'Retry reply', hidden: true, onclick: () => ask(lastRequest) });
  const actions = el('div', { class: 'pr-actions' }, [retry, send]);
  const typed = el('div', { class: 'pr-typed' }, input);
  const voicePane = el('div', { class: 'pr-voice' }, [voiceView.root]);
  voiceView.setControls({ lead: [mic], actions: [interrupt, typeLink, voiceSend] });
  const work = el('section', { class: 'pr-work card ui-editor-surface' });
  const output = el('pre', { class: 'lld-output mono', hidden: true });
  const run = el('button', { class: 'btn btn--secondary python-run', type: 'button', text: 'Run Python', onclick: async () => {
    run.disabled = true; output.hidden = false; output.textContent = 'Running…';
    try {
      await save();
      const result = await json('/api/practice/run', { slug, id, code: currentCode() });
      output.textContent = `${result.timedOut ? 'Time limit exceeded' : `Exit ${result.exitCode ?? '—'}`}\n${result.stdout || ''}${result.stderr || ''}`;
    } catch (e) { output.textContent = e.message; }
    finally { run.disabled = false; }
  } });
  tooltip(run, "Run Python (⌘')");
  const currentCode = () => editor?.getValue() ?? code;
  function updateTopic(topic) {
    if (!session || !topic || gone) return;
    session.title = topic.title; session.statement = topic.statement;
    const heading = view.querySelector('.ui-workspace-identity h1');
    if (heading) heading.textContent = session.title;
    if (problemText) {
      problemText.textContent = session.statement || '';
      // The disclosure appears once the coach has recorded a problem to show in it.
      if (session.statement) problemText.parentElement.hidden = false;
    }
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
    mode = next; spokenThisTurn = false; playbackInterrupted = true; replySpeech?.cancel(); speaker?.cancel();
    if (mode === 'voice') voiceLoop?.start(); else voiceLoop?.pause();
    changed(); paint(); if (mode === 'typed') input.focus();
  }
  function paint() {
    if (voice) voice.root.hidden = mode !== 'typed';
    if (modelPicker) { modelPicker.root.hidden = mode !== 'typed'; modelPicker.setBusy(busy); }
    typed.hidden = mode !== 'typed'; voicePane.hidden = mode !== 'voice';
    inputSize.resize();
    voiceView.update({state: voiceState, draft: input.value, partial: partialWords, busy, sending, paused: !voiceLoop?.enabled});
    send.disabled = busy || sending || !input.value.trim();
    const speaking = Boolean(speaker?.speaking);
    voiceLink.hidden = mode === 'voice';
    typeLink.hidden = speaking;
    mic.disabled = sending || voiceState === 'working';
    paintMicToggle(mic, Boolean(voiceLoop?.enabled), { on: 'Pause voice', off: 'Start voice' });
    interrupt.hidden = !speaking;
    status.textContent = speaker?.speaking ? 'Coach speaking' : busy ? 'Coach is thinking…' : voiceState === 'working' ? 'Transcribing…' : voiceState === 'recording' ? 'Listening' : 'Ready when you are';
    status.hidden = mode === 'voice' || busy || status.textContent === 'Ready when you are';
    send.hidden = mode === 'voice';
    voiceSend.hidden = speaking || !(input.value.trim() || partialWords);
    voiceSend.disabled = send.disabled;
    retry.hidden = !lastRequest || busy;
    bottom();
  }
  function bottom() { if (following) { thread.scrollTop = thread.scrollHeight; lastThreadTop = thread.scrollTop; } }
  function exchange(question, answer = '', state = 'complete', requestId = null) {
    if (requestId && exchangeNodes.has(requestId)) return exchangeNodes.get(requestId);
    const turn = createWorkspaceReply();
    const reply = turn.body; reply.classList.add('pr-answer'); setConversationText(reply, answer);
    const marker = el('span', { class: 'dim pr-exchange-status', text: state === 'failed' ? 'Reply incomplete' : '' });
    if (state === 'pending' && !answer) turn.start();
    thread.querySelector('.pr-empty')?.remove();
    const saveNote = el('button', { class: 'btn btn--quiet', text: 'Save to notes', 'aria-label': 'Save to notes', onclick: async () => {
      saveNote.disabled = true;
      // The button itself says the note was kept; it stays disabled so it cannot be saved twice.
      try { await saveLearningNote(slug, `Question: ${question}\n\n${reply.dataset.markdown || answer}`); saveNote.textContent = 'Saved to notes'; saveNote.setAttribute('aria-label', 'Saved to notes'); clearError(`note:${requestId}`); }
      catch (e) { showError(e, `note:${requestId}`); saveNote.disabled = false; }
    } });
    saveNote.hidden = !answer;
    const finish = () => turn.finish({ actions: [replayButton(() => reply.dataset.markdown || reply.textContent, replayReply, 'Coach'), saveNote] });
    thread.append(el('article', { class: 'pr-exchange ui-message-group' }, [
      questionNode({ text: question }),
      turn.node, marker,
    ]));
    const ui = { reply, marker, saveNote, turn, finish };
    if (state !== 'pending') finish();
    if (requestId) exchangeNodes.set(requestId, ui);
    bottom(); return ui;
  }
  async function ask(retryRequest = null) {
    if (busy || sending || !session) return;
    sending = true; spokenThisTurn = false; paint(); voiceLoop?.sync();
    try { await voice?.flush(); }
    catch (error) { sending = false; if (!gone) { showError(error); paint(); } return; }
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
    ui.turn.start(); ui.marker.textContent = ''; ui.saveNote.hidden = true;
    paint();
    try {
      await save();
      await streamInterviewRequest('/api/practice/ask', request, (name, value) => {
        if (gone) return;
        if (name === 'action') showWorkspaceAction(ui.turn, value);
        if (name === 'tool') ui.turn.tool(value);
        if (name === 'practice_topic') updateTopic(value);
        if (name === 'token') { ui.turn.writing(); ui.reply.dataset.streaming = 'true'; answer += value.text || ''; setConversationText(ui.reply, answer); bottom();
          if (mode === 'voice' && !playbackInterrupted) replySpeech.push(value.text || '');
        }
        if (name === 'done') { answer = value.answer ?? answer; setConversationText(ui.reply, answer); ui.saveNote.hidden = false; }
      });
      lastRequest = null; localStorage.removeItem(requestKey);
      if (!gone && mode === 'voice' && !playbackInterrupted) replySpeech.finish();
    } catch (e) {
      ui.turn.setNotice({ tone: 'err', head: 'Reply incomplete', body: e.message });
      replySpeech?.cancel(); voiceLoop?.pause();
      ui.marker.textContent = e.workspaceSave ? 'Question not sent. Save your work, then retry.' : 'Reply incomplete. Your question is saved.';
      if (!e.workspaceSave) showError(e);
    }
    finally { ui.finish(); ui.reply.dataset.streaming = 'false'; busy = false; if (!gone) { paint(); bottom(); voiceLoop?.sync(); } }
  }
  function interruptReply() {
    playbackInterrupted = true; replySpeech?.cancel(); speaker?.cancel(); voiceLoop?.sync(); paint();
  }
  let lastThreadTop = 0;
  thread.addEventListener('wheel', event => { if (event.deltaY < 0) following = false; }, { passive: true });
  thread.addEventListener('scroll', () => {
    following = thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 1;
    lastThreadTop = thread.scrollTop;
  });
  input.addEventListener('input', () => { saveDraft(draftKey, input.value); paint(); });
  input.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === 'Enter' && !hasOpenOverlay() && claimActionKey(e)) ask();
  });
  view.addEventListener('keydown', e => {
    // Excalidraw listens above its canvas for shape/undo shortcuts.
    if (!e.target.closest('.excalidraw')) e.stopPropagation();
    if (e.key === 'Escape' && !hasOpenOverlay() && claimActionKey(e)) interruptReply();
  });
  replace(host, el('p', { class: 'ui-inset', text: 'Opening practice…' }));
  (async () => {
    try {
      const data = await json(endpoint); if (gone) return;
      session = data.session; mode = session.mode || 'voice'; code = data.code || session.code || ''; elements = data.elements || session.elements || [];
      // Timer failures already live beside Pause/Resume and clear on its own retry.
      practiceTimer = createPracticeTimer({ timer: session.timer, serverNow: data.serverNow, change: async body => {
        const response = await fetch(`${endpoint}/timer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true });
        const result = await response.json(); if (!response.ok) throw Error(result.error?.message || 'Timer not saved'); return result;
      }, onError: () => {} });
      const source = data.sourceSnapshot?.source || session.source;
      const recovered = recoverWork();
      if (recovered) { code = recovered.code ?? code; elements = recovered.elements ?? elements; mode = recovered.mode || mode; }
      try { lastRequest = JSON.parse(localStorage.getItem(requestKey) || 'null'); } catch {}
      if (data.exchanges.some(e => e.requestId === lastRequest?.requestId && e.status === 'complete')) { lastRequest = null; localStorage.removeItem(requestKey); }
      const interrupted = data.exchanges.findLast(e => e.status === 'pending' || e.status === 'failed');
      if (!lastRequest && interrupted) lastRequest = { slug, id, question: interrupted.question, requestId: interrupted.requestId };
      modelPicker = createCoachModelPicker({ compact: true });
      const canvas = el('div', { class: session.discipline === 'lld' ? 'lld-code pr-editor' : 'dz-canvas pr-board ui-editor-surface' });
      const editorControls = session.discipline === 'lld' ? createPythonEditorControls() : null;
      const boardControls = session.discipline === 'lld' ? null : boardTools(() => boardApi);
      if (session.discipline !== 'lld') work.classList.add('has-board-tools');
      const fileHeader = paneHeader({ title: session.discipline === 'lld' ? 'design.py' : 'Whiteboard', subtitle: saveStatus, tools: session.discipline === 'lld' ? [editorControls.root, run] : boardControls });
      if (session.discipline === 'lld') fileHeader.classList.add('python-document-bar');
      work.append(fileHeader, workError, canvas);
      if (session.discipline === 'lld') work.append(output);
      problemText = el('p', { text: session.statement || '' });
      const statement = el('details', { class: 'pr-problem' }, [
        el('summary', {}, [icon('forward', 14), el('span', { text: source ? 'Problem and mock feedback' : 'Problem' })]), problemText]);
      // An open session has no problem yet; the empty state below already says so.
      statement.hidden = !source && !session.statement;
      if (source) {
        const feedback = data.sourceSnapshot?.feedback;
        const feedbackNode = conversationText(typeof feedback === 'string' && feedback.trim() ? feedback : 'No mock feedback was recorded.');
        const feedbackDetails = el('section', { class: 'pr-feedback' }, [el('h3', { class: 'pr-feedback-label', text: 'Mock feedback' }), feedbackNode]);
        statement.append(feedbackDetails);
      }
      thread.prepend(statement);
      const coach = el('aside', { class: 'pr-coach card ui-pane', 'aria-label': 'Practice coach' }, [
        Object.assign(paneHeader({ title: 'Practice coach', subtitle: status }), { className: 'ui-pane-header pr-coach-head' }), thread,
        createComposer({ className: 'pr-compose ui-pane-controls', content: [typed, voicePane],
          leading: [voiceLink, modelPicker.root], trailing: [actions], notices: [error] }),
      ]);
      view.append(workspaceHeader({ title: session.title, subtitle: `${session.discipline === 'lld' ? 'Python · ' : ''}Untimed practice`, backHref: `#/${session.discipline === 'lld' ? 'lld' : 'design'}`, backLabel: session.discipline === 'lld' ? 'Low-level design' : 'System design', actions: [source ? el('a', { class: 'pr-source-link', href: source.discipline === 'lld' ? `#/lld/${encodeURIComponent(source.slug)}/${encodeURIComponent(source.interviewId)}` : `#/design/${encodeURIComponent(source.interviewId)}`, text: `From mock · ${source.startedAt || source.capturedAt ? relativeInterviewDate(source.startedAt || source.capturedAt) : 'original'}` }) : null, practiceTimer.root, el('button', { class: 'btn btn--quiet pr-notes', text: 'Learning notes', onclick: () => openLearningNotes(slug, session.title) })] }),
        el('div', { class: 'pr-split' }, [work, coach]));
      replace(host, view);
      conversationView = bindConversation(thread, { composer: view.querySelector('.pr-compose'), onJump: () => { following = true; } });
      disposeSplit = installPaneResizer(view.querySelector('.pr-split'), { storageKey: `studio.workspace-split.${session.discipline}.v1`, minLeft: session.discipline === 'lld' ? 420 : 360 });
      if (!data.exchanges.length) thread.append(el('div', { class: 'pr-empty' }, [el('h2', { text: session.openEnded && !session.statement ? 'What would you like to work on?' : 'Make room to think.' }), el('p', { class: 'dim', text: session.openEnded && !session.statement ? 'Describe a question, paste its requirements, or ask for a suggestion. Your coach will keep the problem and your work here as you go.' : 'Your coach sees your work when you ask a question. Explore the problem, try an approach, and ask for help whenever you need it.' })]));
      else for (const item of data.exchanges) {
        const ui = exchange(item.question, item.answer, item.status, item.requestId);
        ui.turn.restore(item.activity, item.actions, { pending: item.status === 'pending', at: item.at });
        if (item.status !== 'pending') ui.finish();
      }
      if (data.busy) { busy = true; watchPending(); }
      speaker = createSpeaker({ onPlayback: value => voiceView.playback(value), onStateChange: () => { if (!gone) { paint(); voiceLoop?.sync(); } } });
      voice = createVoiceControl({ getSlug: () => '', logTakes: false, maxTakeMs:60*60000, reportEmptyTake:false, onSettled:()=>voiceLoop?.sync(), onPreview: text => { partialWords = text; if (!gone) paint(); }, onTranscript: text => {
        if (gone) { appendDraft(draftKey, text); return; }
        input.value += (input.value ? ' ' : '') + text; saveDraft(draftKey, input.value);
        if (mode === 'voice' && (speaker.speaking || (busy && !playbackInterrupted))) interruptReply();
        paint();
      }, onState: state => { voiceState = state; if (!gone) paint(); }, onLevel: value => {
        voiceView.level(value); const {sinceLoud,pending} = value; if(value.loud)spokenThisTurn=true;
        if (mode === 'voice' && value.loud && (speaker.speaking || (busy && !playbackInterrupted))) interruptReply();
        if (voiceView.automatic && !voice.hasTranscriptionError() && voiceLoop?.enabled && spokenThisTurn && mode === 'voice' && turnDecision({ sinceLoud, chars: input.value.trim().length, pending, speaking: speaker.speaking, busy: busy || sending }) === 'send') ask();
      } });
      voiceLoop = createVoiceLoop({capture:voice,speaker,canListen:()=>!gone&&mode==='voice'&&!document.hidden&&windowFocused,onChange:()=>{if(!gone)paint();}});
      mountComposerDictation(view.querySelector('.pr-compose'), voice);
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
        boardRoot.render(ex.createElement(ex.Excalidraw, { theme: getSettings().dark ? 'dark' : 'light', excalidrawAPI: api => { boardApi = api; }, initialData: { elements: structuredClone(elements), scrollToContent: true }, onChange: (next, appState) => {
          boardControls.sync(appState?.zoom?.value);
          // Keep the comparison baseline detached from the canvas's mutable objects.
          if (JSON.stringify(next) === JSON.stringify(elements)) return; elements = structuredClone(next); changed();
        }, UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, export: false } } }));
        unbindTools = bindBoardTools({ target: `practice:${slug}:${id}`, getApi: () => boardApi, getElements: () => elements, setElements: next => { elements = structuredClone(next); changed(); }, save });
        untheme = onSettingsChange(settings => boardApi?.updateScene({ appState: { theme: settings.dark ? 'dark' : 'light' } }));
      }
      if (recovered) changed(); paint(); bottom();
      if (voiceLaunches.delete(id) && mode === 'voice') voiceLoop.start();
    } catch (e) {
      if (!gone && !view.isConnected) replace(host, el('div', { class: 'ui-inset' }, [el('p', { text: e.message }), el('a', { href: `#/${slug.startsWith('lld-') ? 'lld' : 'design'}`, text: slug.startsWith('lld-') ? 'Back to Low-level design' : 'Back to System design' })]));
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
        ui.turn.restore(item.activity, item.actions, { pending: item.status === 'pending', at: item.at });
          if (item.status !== 'pending') ui.finish();
          // Recovery polls are snapshots, not deltas. Replace the visible prefix
          // while pending too; do not replay historical text through the speaker.
          if (ui.reply.dataset.markdown !== (item.answer || '')) {
            setConversationText(ui.reply, item.answer || '');
          }
          if (item.status !== 'pending') {
            ui.marker.textContent = item.status === 'failed' ? 'Reply incomplete. Retry when ready.' : '';
            ui.saveNote.hidden = item.status !== 'complete'; ui.finish();
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
  const visibility=()=>{if(!gone){ voiceLoop?.sync(); if (document.hidden) practiceTimer?.pause(); }};
  document.addEventListener('visibilitychange',visibility);
  const pagehide = () => practiceTimer?.pause();
  window.addEventListener('pagehide', pagehide);
  const focus=()=>{windowFocused=true;visibility();};
  const blur=()=>{windowFocused=false;visibility();};
  window.addEventListener('focus',focus); window.addEventListener('blur',blur);
  window.addEventListener('beforeunload', beforeUnload);
  return { destroy() {
    practiceTimer?.dispose();
    disposeSplit(); conversationView?.dispose();
    clearTimeout(timer); clearTimeout(pendingPoll); if (revision !== savedRevision) save().catch(() => {});
    gone = true; voiceLoop?.dispose(); replySpeech?.cancel(); document.removeEventListener('visibilitychange',visibility); window.removeEventListener('focus',focus); window.removeEventListener('blur',blur); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('pagehide', pagehide);
    voice?.dispose({ finish: true }); speaker?.dispose(); modelPicker?.dispose();
    inputSize.dispose(); unbindTools(); editor?.dispose(); boardRoot?.unmount(); untheme();
  } };
}
