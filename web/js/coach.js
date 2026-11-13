import { changeCards } from './ui/turn-changes.js';
import { createPopover } from './ui/popover.js';
import { createReply, questionNode, threadStrip, bindPinnedQuestion, activitySteps, isNoteOnlyReply } from './ui/turn.js';
import { bindConversation, conversationSeparator } from './ui/conversation.js';
import { paneHeader } from './ui/headers.js';
import { createComposer, composerSend, bindComposerInput, mountComposerDictation } from './ui/composer.js';
import { claimActionKey, hasOpenOverlay, isTextEntry } from './keyboard.js';
import { activeInterview } from './interview.js';
import { createInterviews } from './interviews.js';
import { readSidebar, saveSidebar } from './sidebar-state.js';
import { tooltip } from './tooltip.js';
import { icon } from './ui/icon.js';
// The coach panel — a streaming conversation beside the editor (ARCHITECTURE.md §5,
// API-CONTRACT-P2.md Phase 3).
//
// The hard rule from the architecture: **solving must never depend on the coach.**
// So every failure here is contained to this one card. A missing `claude` binary, a
// server that predates Phase 3, a dropped connection mid-answer — each shows a plain
// sentence inside the panel and changes nothing about the editor, the runner, or the
// reference panels.
//
// Everything the coach writes is untrusted model output. Prose goes through the same
// escape-by-default markdown renderer the NeetCode articles use; ```mermaid, ```svg,
// ```viz and ```image blocks go through illustrator.js, which validates or sanitises
// before drawing. No innerHTML is assigned anywhere in this file.

import { el, replace } from './dom.js';
import { renderMarkdown, looksLikeCode } from './markdown.js';
import { splitDiagramBlocks, renderDiagram } from './illustrator.js';
import { loadHistory, api } from './api.js';
import { createVoicePanel } from './ui/voice-panel.js';
import { createVoiceControl } from './voice.js';
import { createCoachModelPicker } from './coach-model.js';
import { flushRecorder } from './recorder.js';
import { flushEditorSave } from './editor.js';
import {
  studioToolName, undoAction,
} from './coach-actions.js';
import { readAttempt, resumeDecision } from './attempt-state.js';
import { renderHistory, threadDate } from './history.js';
import { createSubmissions } from './submissions.js';
import { onChord, chordLabel } from './shortcuts.js';
import { readDraft, saveDraft, clearDraft, appendDraft, watchDraft } from './drafts.js';
import {
  startRun, runFor, watch, stopRun, markSeen, dismissRun, runsElsewhere, onRunsChange, adopt,
} from './coachruns.js';

// Keys that scroll the focused conversation; they must not reach the global map.
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

const OPEN_KEY = 'studio.coach.open.v1';

/* ============================== shaping (pure) ============================== */

// Thinking is already shown in the conversation; keep other ongoing status here.
export function setCoachState(label, separator, text) {
  const active = ['Asking', 'Listening', 'Transcribing', 'Attempt in progress', 'Stopping'].includes(text);
  label.textContent = active ? text : '';
  label.hidden = separator.hidden = !active;
}

export function setChatToolsVisible(history, newChat, popover, visible) {
  history.hidden = newChat.hidden = !visible;
  popover.hidden = true;
  history.setAttribute('aria-pressed', 'false');
}

/**
 * Turn any outcome of `streamCoachMessage` into the notice the panel shows.
 *
 * `hadText` matters: a stream that dropped after two paragraphs is a different
 * event from one that never started, and telling them apart is the difference
 * between "try again" and "the answer above is incomplete".
 *
 * @param {object} result
 * @param {boolean} hadText whether any token arrived before the failure
 * @returns {{tone:string, head:string, body:string, retry:boolean}|null} null when nothing is wrong
 */
export function shapeCoachOutcome(result, hadText = false) {
  if (result && result.ok === true) {
    if (!hadText) {
      return {
        tone: 'warn',
        head: 'The coach finished without saying anything',
        body: 'The turn completed but no text came back. That is usually a session that ended early — asking again normally fixes it.',
        retry: true,
      };
    }
    return null;
  }

  const kind = result?.kind || 'server';
  const message = result?.message || 'The coach stopped for a reason it did not explain.';

  const PRESETS = {
    coach: { tone: 'err', head: 'The coach could not answer', retry: true },
    unavailable: { tone: 'warn', head: 'This server has no coach yet', retry: false },
    offline: { tone: 'warn', head: 'The studio server is not answering', retry: true },
    timeout: { tone: 'warn', head: 'The coach went quiet', retry: true },
    cancelled: { tone: '', head: 'Stopped', retry: false },
    truncated: { tone: 'warn', head: 'The answer was cut off', retry: true },
    server: { tone: 'err', head: 'The coach request failed', retry: true },
  };
  const preset = PRESETS[kind] || PRESETS.server;

  const tail = kind === 'cancelled' || kind === 'unavailable'
    ? ''
    : ' Everything else in Studio is unaffected — the editor, the runner and the reference panels all still work.';

  return { tone: preset.tone, head: preset.head, body: message + tail, retry: preset.retry };
}

/* ============================== rendering ============================== */

/**
 * Render one coach message: prose through the article renderer, diagrams through
 * the illustrator, in the order they were written.
 *
 * While a message is streaming this runs on every frame, so a finished diagram is
 * kept in `cache` and re-attached rather than parsed and laid out again — without
 * it, a drawing near the top of a long answer flickers for as long as the coach
 * keeps typing. The cache belongs to one message; a second copy of the same
 * diagram in the same message is drawn fresh rather than stolen from the first.
 *
 * `live` marks a reply that is arriving now. Only a live reply may start painting a
 * Codex picture by itself; a replayed one looks its pictures up and offers a button.
 */
export function renderCoachText(target, text, cache = null, { slug = null, live = false } = {}) {
  target.dataset.markdown = text;
  const fragment = document.createDocumentFragment();
  const segments = splitDiagramBlocks(text);
  if (!segments.length) { replace(target, fragment); return target; }
  const usedThisPass = new Set();
  for (const segment of segments) {
    if (segment.type === 'markdown') { fragment.append(renderMarkdown(segment.text)); continue; }
    const key = segment.complete ? `${segment.lang}::${segment.code}` : null;
    if (cache && key && cache.has(key) && !usedThisPass.has(key)) {
      usedThisPass.add(key);
      fragment.append(cache.get(key));
      continue;
    }
    const node = renderDiagram(segment.lang, segment.code, { complete: segment.complete, slug, live });
    if (cache && key && !usedThisPass.has(key)) { cache.set(key, node); usedThisPass.add(key); }
    fragment.append(node);
  }
  replace(target, fragment);
  return target;
}


const STARTERS = [
  { icon: 'play', label: 'Where do I start?', text: 'I have read the problem and I am not sure where to start. Ask me one question that would unblock me — do not give me the approach.' },
  { icon: 'check', label: 'Check my approach', text: 'Here is the approach I am about to write. Tell me where it breaks before I spend twenty minutes on it.' },
  { icon: 'bug', label: 'Why is this wrong?', text: 'My code fails one of the example cases. Point me at the reasoning error rather than the fix.' },
  { icon: 'code', label: 'Trace my code', text: 'Trace what my current code does on Example 1 as a step-by-step ```viz illustration with frames, using the real values. If it goes wrong, stop on the step where it diverges. Then say in one sentence what I am missing — do not write the fix.' },
  { icon: 'image', label: 'Picture it', text: 'Give me one ```image that will make this problem\'s core idea stick in an interview: a concrete metaphor, not a diagram of the solution. Then tie it back to the algorithm in two sentences, without revealing more than I have already worked out.' },
];

/* ============================== the panel ============================== */

// An attempt's next thread belongs to the problem, not to whichever panel happens
// to be mounted. Restoring only the label/flag never stops or clears a surviving run.
const attemptThreads = new Map();
function attemptThread(slug) {
  if (!attemptThreads.has(slug)) attemptThreads.set(slug, { pending: false, live: false });
  const state = attemptThreads.get(slug);
  const saved = readAttempt();
  if (saved?.slug === slug && !saved.archiveId && resumeDecision(saved) === 'resume') state.live = true;
  return state;
}
function reviewOptions({ attemptId, spokenMs = 0, elapsedMs = 0 }) {
  const mins = Math.max(1, Math.round(elapsedMs / 60_000));
  const spoke = spokenMs > 0
    ? `${Math.floor(spokenMs / 60_000)}:${String(Math.round(spokenMs / 1000) % 60).padStart(2, '0')} spoken`
    : 'nothing spoken';
  return { kind: 'attempt-review', attemptId,
    lead: `Attempt ended · ${mins} min · ${spoke} — reviewing it end to end.` };
}

/**
 * Build the coach for one problem.
 *
 * @param {{slug:string, title?:string}} entry
 * @returns {{root:HTMLElement, focus:() => void, dispose:() => void}}
 */
export function createCoachPanel(entry) {
  const slug = entry.slug;
  // The panel does not own the turn — coachruns.js does, so that leaving this problem
  // does not kill the answer. `detachRun` unsubscribes; it never stops anything.
  let detachRun = null;
  let shownRun = null;
  let streaming = false;
  let disposed = false;
  let turns = 0;
  // Set when an attempt opens, consumed by the first turn of that attempt, so the CLI
  // starts a fresh session rather than resuming the previous attempt's reasoning.
  const thread = attemptThread(slug);
  // Set when a past conversation is chosen from the history view; consumed by the next
  // turn, so continuing one is an explicit act rather than a lasting mode.
  let resumeSessionId = null;

  const log = el('div', { class: 'coach-log', tabindex: '0', role: 'log', 'aria-live': 'polite', 'aria-label': 'Coach conversation' });
  const stateLabel = el('span', { class: 'coach-state mono dim' });
  const stateSeparator = el('span', { class: 'coach-sep', 'aria-hidden': 'true' });
  const setState = text => setCoachState(stateLabel, stateSeparator, text);
  setState(thread.live ? 'Attempt in progress' : '');

  const input = el('textarea', {
    class: 'coach-input', rows: '2', spellcheck: 'true',
    placeholder: 'Ask the coach',
    'aria-label': 'Message the coach',
  });
  const restoredDraft = readDraft(slug);
  if (restoredDraft?.text) input.value = restoredDraft.text;
  let partialWords = '';
  const voiceView = createVoicePanel({autoSend:false, role:'Coach', onEdit:()=>{voice.stop();input.hidden=false;input.focus();}});
  voiceView.root.hidden = true;
  function committed() { return input.value; }

  const inputSize = bindComposerInput(input);
  const sendButton = composerSend(el('button', { class: 'btn btn--quiet coach-send', type: 'button', onclick: () => submit() }), 'Ask coach');

  const stopButton = el('button', {
    class: 'btn btn--quiet ws-mini coach-stop', type: 'button', hidden: true, text: 'Stop',
    onclick: () => { setState('Stopping'); stopRun(slug); },
  });

  const voice = createVoiceControl({
    getSlug: () => slug,
    onPreview: text => {
      partialWords = text; if (!disposed) voiceView.update({draft:input.value,partial:partialWords});
    },
    onLevel: value => voiceView.level(value),
    // Dictation lands phrase by phrase while you are still speaking, so it joins the
    // sentence with a space rather than starting a new paragraph — it should read like
    // typing, because that is what it is standing in for.
    onTranscript: (text, meta) => {
      if (disposed) { appendDraft(slug, text); return; }
      const existing = input.value;
      const gap = existing === '' || /\s$/.test(existing) ? '' : ' ';
      input.value = existing + gap + text;
      saveDraft(slug, committed());
      voiceView.update({draft:input.value,partial:partialWords});
      autosize();
      // Focus is NOT taken here: you may be reading your code while you talk, and
      // stealing the caret mid-sentence is how a shortcut turns into a typo.
      if (document.activeElement === input) {
        input.setSelectionRange(input.value.length, input.value.length);
      }
      log.scrollTop = log.scrollHeight;
    },
    onState: (state) => {
      voiceView.root.hidden = true; input.hidden = false;
      voiceView.update({state,draft:input.value,partial:partialWords});
      sendButton.disabled = !input.value.trim() || state !== 'idle' || streaming || changingModel;
      if (state === 'recording') setState('Listening');
      else if (state === 'working') setState('Transcribing');
      else if (!streaming) setState(thread.live ? 'Attempt in progress' : 'Ready');
    },
  });

  const composer = createComposer({ className: 'coach-compose', content: [input, voiceView.root],
    trailing: [stopButton, sendButton], notices: api.demo ? [] : [voice.status] });
  composerSend(stopButton, 'Stop');
  stopButton.replaceChildren(icon('stop', 15));
  const pinnedQuestion = bindPinnedQuestion(log);
  const conversationView = bindConversation(log, { composer, onJump: () => { following = true; mayResume = true; } });
  sendButton.disabled = !input.value.trim();
  const composerOptions = composer.querySelector('.ui-composer-options');
  composerOptions.classList.add('coach-actions');


  const closeButton = el('button', {
    class: 'btn btn--icon icon-btn coach-hide', type: 'button',
  'aria-label': 'Hide sidebar · ' + chordLabel('coach'),
  }, [icon('sidebar', 16)]);
  tooltip(closeButton, 'Hide sidebar · ' + chordLabel('coach'));
  closeButton.addEventListener('click', () => setOpen(false));

  let attachment = null;
  const attachmentLabel = el('span');
  function clearAttachment() {
    attachment = null;
    attachmentChip.hidden = true;
  }
  const attachmentChip = el('div', { class: 'submission-attachment', hidden: true }, [
    attachmentLabel,
    el('button', {
      class: 'btn btn--icon icon-btn', type: 'button', 'aria-label': 'Remove attached submission', onclick: clearAttachment,
    }, icon('close')),
  ]);
  composer.prepend(attachmentChip);
  const tabChat = el('button', {
    class: 'btn btn--quiet coach-tab ui-tab', type: 'button', 'aria-pressed': 'true', text: 'Chat',
  });
  const tabInterviews = el('button', { class: 'btn btn--quiet coach-tab ui-tab', type: 'button', 'aria-pressed': 'false', text: 'Interviews' });
  const interviews = createInterviews(entry);
  let selectedTab = 'chat';
  const submissionCount = el('span', { class: 'submission-count' });
  const tabSubmissions = el('button', {
    class: 'btn btn--quiet coach-tab ui-tab', type: 'button', 'aria-pressed': 'false',
  }, ['Submissions', submissionCount]);
  const submissions = createSubmissions({
    slug,
    onCount: count => { submissionCount.textContent = count; },
    onAsk: submission => {
      attachment = { submissionId: String(submission.submissionId) };
      const time = new Date(submission.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      attachmentLabel.textContent = `${submission.verdict} · ${time}`;
      attachmentChip.className = `submission-attachment tone-${submission.accepted ? 'easy' : 'hard'}`;
      attachmentChip.hidden = false;
      showTab('chat');
      input.focus();
    },
  });
  const submissionsView = submissions.root;
  submissionsView.hidden = true;
  let historyPopover = null;
  const pastChats = el('div', { class: 'chat-history-popover', hidden: true });
  function chooseThread(past) {
    if (streaming) return;
    restoreWanted = false;
    resumeSessionId = past.sessionId;
    thread.pending = false;
    pastChats.hidden = true; historyPopover?.close(false);
    historyButton.setAttribute('aria-pressed', 'false');
    showTab('chat');
    replayThread(past);
  }
  function iconButton(label, path, action) {
    const node = el('button', { class: 'btn btn--icon icon-btn chat-icon', type: 'button', 'aria-label': label, onclick: action });
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '15', height: '15', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) icon.setAttribute(key, value);
    const shape = document.createElementNS(icon.namespaceURI, 'path');
    shape.setAttribute('d', path);
    icon.append(shape);
    node.append(icon);
    tooltip(node, label);
    return node;
  }
  const historyButton = iconButton('History', 'M3 10a9 9 0 1 1 1 8 M3 4v6h6 M12 7v6l4 2', () => {
    pastChats.hidden = !pastChats.hidden;
    historyButton.setAttribute('aria-pressed', String(!pastChats.hidden));
    if (pastChats.hidden) historyPopover.close(false);
    if (!pastChats.hidden) {
      historyPopover.open();
      renderHistory(pastChats, {
        slug, onResume: chooseThread, current: resumeSessionId || shownRun?.result?.sessionId,
        disabled: streaming, heading: 'Past chats',
      });
    }
  });
  historyPopover = createPopover({ anchor: historyButton, label: 'Recent chats', content: pastChats, className: 'coach-history-menu', bounds: () => root });
  historyPopover.root.addEventListener('toggle', event => { if (event.newState === 'closed') { pastChats.hidden = true; historyButton.setAttribute('aria-pressed', 'false'); } });
  const newChatButton = iconButton('New chat', 'M14 5l5 5 M4 20l5-1L21 7l-5-5L4 14z M14 20h8 M18 16v8', () => {
    if (streaming) return;
    restoreWanted = false;
    resumeSessionId = null;
    shownRun = null;
    thread.pending = true;
    turns = 0;
    pastChats.hidden = true; historyPopover?.close(false);
    historyButton.setAttribute('aria-pressed', 'false');
    showTab('chat');
    showEmptyState();
  });
  function showTab(name) {
    selectedTab = ['chat', 'interviews', 'submissions'].includes(name) ? name : 'chat';
    saveSidebar(slug, { tab: selectedTab });
    root.dataset.sidebarTab = selectedTab;
    const onChat = selectedTab === 'chat', onSubmissions = selectedTab === 'submissions';
    const alreadyActive = tabSubmissions.getAttribute('aria-pressed') === 'true';
    submissionsView.hidden = !onSubmissions;
    interviews.show(selectedTab === 'interviews');
    tabInterviews.classList.toggle('has-live', Boolean(activeInterview(slug) && !activeInterview(slug).pausedAt));
    log.hidden = composer.hidden = !onChat;
    stripHost.hidden = !onChat || !threadInfo;
    tabChat.setAttribute('aria-pressed', String(onChat));
    tabInterviews.setAttribute('aria-pressed', String(selectedTab === 'interviews'));
    tabSubmissions.setAttribute('aria-pressed', String(onSubmissions));
    [tabChat, tabInterviews, tabSubmissions].forEach((tab, index) => { const chosen = ['chat', 'interviews', 'submissions'][index] === selectedTab; tab.setAttribute('aria-selected', String(chosen)); tab.tabIndex = chosen ? 0 : -1; });
    pastChats.hidden = true; historyPopover?.close(false);
    historyButton.setAttribute('aria-pressed', 'false');
    setChatToolsVisible(historyButton, newChatButton, pastChats, onChat);
    // The empty screen already lists the recent chats and is itself the new chat.
    if (onChat && log.querySelector(':scope > .coach-empty')) historyButton.hidden = newChatButton.hidden = true;
    if (onSubmissions) {
      if (alreadyActive) submissions.showList(); else submissions.refresh();
    }
    if (onChat && active?.root === root) showPendingRun();
  }
  tabChat.addEventListener('click', () => showTab('chat'));
  tabInterviews.addEventListener('click', () => showTab('interviews'));
  tabSubmissions.addEventListener('click', () => showTab('submissions'));
  function submissionChanged(event) {
    if (event.detail?.slug !== slug) return;
    submissions.refresh(event.detail.submissionId);
    if (event.type === 'studio-open-submission') {
      setOpen(true);
      showTab('submissions');
      submissions.open(event.detail.submissionId);
    }
  }
  window.addEventListener('studio-submission', submissionChanged);
  window.addEventListener('studio-open-submission', submissionChanged);
  function closeHistory() {
    if (pastChats.hidden) return;
    pastChats.hidden = true; historyPopover?.close(false);
    historyButton.setAttribute('aria-pressed', 'false');
    historyButton.focus();
  }
  function outsideHistory(event) {
    if (!pastChats.contains(event.target) && !historyButton.contains(event.target)) closeHistory();
  }
  document.addEventListener('pointerdown', outsideHistory);

  let changingModel = false;
  const modelPicker = createCoachModelPicker({ compact: true, onPending: pending => {
    changingModel = pending;
    sendButton.disabled = !input.value.trim() || pending || streaming || voice.isBusy();
  } });

  const stripHost = el('div', { class: 'ui-thread-host', hidden: true });
  const root = el('section', { class: 'card coach', 'aria-label': 'Coach' }, [
    Object.assign(paneHeader({ tabs: el('span', { class: 'coach-tabs ui-tabs', role: 'tablist', 'aria-label': 'Practice sidebar' }, [tabChat, tabInterviews, tabSubmissions]), tools: [historyButton, newChatButton, closeButton] }), { className: 'ui-pane-header coach-bar' }),
    stripHost, log,
    submissionsView,
    interviews.root,
    conversationView.anchor, composer,
  ]);
  if (!api.demo) mountComposerDictation(composer, voice);

  root.querySelector('.ui-pane-tools').classList.add('coach-chat-tools');
  composer.querySelector('.coach-actions').prepend(modelPicker.root);
  composerOptions.append(el('div', { class: 'coach-status-row' }, [stateSeparator, stateLabel]));
  const sidebarTabs = [tabChat, tabInterviews, tabSubmissions];
  const tabNames = ['chat', 'interviews', 'submissions'];
  sidebarTabs.forEach((tab, index) => {
    tab.setAttribute('role', 'tab');
    tab.addEventListener('keydown', event => {
      let next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % 3;
      else if (event.key === 'ArrowLeft') next = (index + 2) % 3;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = 2;
      else return;
      event.preventDefault(); showTab(tabNames[next]); sidebarTabs[next].focus();
    });
  });
  function setupInterview(event) { if (event.detail?.slug === slug) { showTab('interviews'); interviews.showSetup(); } }
  window.addEventListener('studio-interview-setup', setupInterview);
  /* ---- log helpers ---- */

  function autosize() {
    inputSize.resize();
    sendButton.disabled = !input.value.trim() || streaming || voice.isBusy() || changingModel;
  }
  const unwatchDraft = watchDraft(slug, text => {
    // Saving committed text must leave the visible provisional phrase in place.
    if (committed() !== text) { input.value = text; partialWords = ''; voiceView.update({draft:text,partial:''}); autosize(); }
  });
  input.addEventListener('input', autosize);
  input.addEventListener('input', () => saveDraft(slug, committed()));
  input.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain') || '';
    const fences = input.value.slice(0, input.selectionStart).match(/```/g) || [];
    if (!/[\r\n]/.test(text) || fences.length % 2 || !looksLikeCode(text)) return;
    event.preventDefault();
    input.setRangeText('```python\n' + text.replace(/[\r\n]+$/, '') + '\n```\n', input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  function atBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight <= 1;
  }

  // Input owns follow state. A timed "armed" window also admits our own scrolls
  // during streaming rebuilds; a 120px bottom tolerance swallowed the first wheel
  // tick. Upward intent now latches off before the browser performs its scroll.
  let following = true;
  let mayResume = false;
  let lastTop = log.scrollTop;
  const intent = (direction) => {
    if (!direction) return;
    following = false;
    mayResume = direction > 0;
    lastTop = log.scrollTop;
    // A downward gesture at the bottom is already a return to live content.
    if (mayResume && atBottom()) following = true;
  };
  log.addEventListener('wheel', event => intent(event.deltaY), { passive: true });
  log.addEventListener('keydown', event => {
    if (event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
    if (['PageUp', 'ArrowUp', 'Home'].includes(event.key)) intent(-1);
    if (['PageDown', 'ArrowDown', 'End'].includes(event.key)) intent(1);
    if (event.key === ' ') intent(event.shiftKey ? -1 : 1);
  });
  let touchY = null;
  log.addEventListener('touchstart', event => {
    touchY = event.touches[0]?.clientY ?? null;
    following = false;
    mayResume = false;
  }, { passive: true });
  log.addEventListener('touchmove', event => {
    const y = event.touches[0]?.clientY;
    if (touchY !== null && y !== undefined) intent(touchY - y);
    touchY = y ?? null;
  }, { passive: true });
  let pointerY = null;
  log.addEventListener('pointerdown', event => {
    pointerY = null;
    // Native and overlay scrollbars: suspend before a thumb drag or track click.
    const box = log.getBoundingClientRect();
    if (event.clientX >= box.right - Math.max(16, log.offsetWidth - log.clientWidth)) {
      pointerY = event.clientY;
      following = false;
      mayResume = true;
      lastTop = log.scrollTop;
    }
  }, { passive: true });
  log.addEventListener('pointermove', event => {
    if (event.buttons && pointerY !== null) {
      intent(event.clientY - pointerY);
      pointerY = event.clientY;
    }
  }, { passive: true });
  log.addEventListener('pointerup', () => { pointerY = null; });
  log.addEventListener('pointercancel', () => { pointerY = null; });
  log.addEventListener('scroll', () => {
    const top = log.scrollTop;
    if (!following && mayResume && top > lastTop && atBottom()) following = true;
    lastTop = top;
  }, { passive: true });

  function scrollDown(force = false) {
    if (force || following) log.scrollTop = log.scrollHeight;
  }

  const replies = new Set();
  let threadInfo = null;
  function updateThreadStrip(info = threadInfo) {
    threadInfo = info;
    stripHost.hidden = !info || selectedTab !== 'chat';
    replace(stripHost, info ? threadStrip(info) : []);
  }
  const progressWatches = new WeakMap();
  function watchChangeProgress(actions, card, repaint) {
    let watched = progressWatches.get(card);
    if (!watched) { watched = new Set(); progressWatches.set(card, watched); }
    for (const action of actions) {
      const writer = action.writerSessionId;
      const recall = studioToolName(action.tool) === 'save_recall_note' && action.revisionId && !action.url;
      if ((!writer && !recall) || watched.has(action.id)) continue;
      watched.add(action.id);
      const refresh = async () => {
        if (disposed || !card.isConnected) return;
        try {
          const response = await fetch(writer ? `/api/coach/writer/${encodeURIComponent(writer)}` : `/api/coach/recall/${encodeURIComponent(action.revisionId)}`);
          if (response.ok) {
            const result = await response.json();
            if (writer && result.stage) action.summary = `Writer · ${result.stage}`;
            if (recall && result.status === 'saved' && /^http:\/\/127\.0\.0\.1(?::\d+)?\//.test(result.url)) {
              action.summary = 'Saved to Studycraft'; action.url = result.url; repaint(); return;
            }
            repaint();
            if (writer && ['done', 'error', 'stopped', 'interrupted', 'failed'].includes(result.status)) return;
          }
        } catch { /* Preserve the link if a read-only progress check fails. */ }
        setTimeout(refresh, writer ? 15000 : 30000);
      };
      setTimeout(refresh, 1000);
    }
  }
  function retryQuestion(ask) { input.value = ask || ''; saveDraft(slug, input.value); autosize(); input.focus(); }
  function replyNotice({ text = '', activity = [], actions = [], kind, stopped, result, ask }) {
    if ((!result || result.ok) && stopped || result?.kind === 'cancelled' || result?.stoppedReason === 'stopped') return { head: 'Stopped before it finished' };
    const outcome = result && !result.ok ? shapeCoachOutcome(result, !!text.trim()) : null;
    const noteOnly = isNoteOnlyReply({ text, activity, actions, kind });
    const notice = outcome || (noteOnly ? { tone: 'warn', head: 'The coach saved a note and wrote only this.', retry: true }
      : !text.trim() ? shapeCoachOutcome({ ok: true }, false) : null);
    return notice ? { ...notice, actions: notice.retry ? [{ label: 'Ask again', onClick: () => retryQuestion(ask) }] : [] } : null;
  }

  function showEmptyState() {
    updateThreadStrip(null);
    historyButton.hidden = true;
    newChatButton.hidden = true;
    const recent = el('div', { class: 'recent-chats' });
    replace(log, el('div', { class: 'coach-empty' }, [
      el('h3', { text: 'Ask about this problem' }),
      el('p', { class: 'coach-context', text: 'The coach can see your code and changes, run results, and saved speech.' }),
      el('div', { class: 'coach-starters' }, STARTERS.map(starter => el('button', {
        class: 'ui-action-row ui-starter', type: 'button',
        onclick: () => {
          input.value = starter.text;
          saveDraft(slug, input.value);
          autosize();
          input.focus();
        },
      }, [icon(starter.icon, 15), el('span', { text: starter.label })]))), recent,
    ]));
    renderHistory(recent, { slug, onResume: chooseThread });
  }

  /**
   * A line from the app, not from either party. Used when an attempt ends: the coach is
   * about to speak without anyone having typed, and pretending otherwise would put words
   * in his mouth in his own conversation.
   */
  function noteNode(text) {
    return el('div', { class: 'coach-session-note mono dim', text });
  }

  function addNote(text) {
    const note = noteNode(text);
    if (log.querySelector('.coach-empty')) replace(log, note);
    else log.append(note);
    scrollDown(true);
    return note;
  }

  // Roles are `you` and `reply` — NOT `coach`. `.cmsg.coach` also matched the panel's own
  // `.coach` rule, which is `display:flex; height:100%; overflow:hidden`. Every answer was
  // therefore forced to exactly the height of the log and clipped there, with nothing left
  // for the log to scroll: the answer looked cut off mid-sentence and the wheel did
  // nothing. A message and the panel it sits in must not share a class name.
  function messageNode(role, text = '', at = null, meta = '') {
    if (role === 'you') {
      const message = questionNode({ text, at }); message.classList.add('cmsg', 'you');
      return { message, bodyEl: message.querySelector('.ui-conversation-text') };
    }
    const reply = createReply({ meta, startedAt: at }); replies.add(reply);
    reply.node.classList.add('cmsg', 'reply');
    return { message: reply.node, bodyEl: reply.body, reply };
  }

  function addMessage(role, text = '', at = null, meta = '') {
    historyButton.hidden = false;
    newChatButton.hidden = false;
    const view = messageNode(role, text, at, meta);
    if (log.querySelector('.coach-empty')) replace(log, view.message);
    else log.append(view.message);
    scrollDown(true);
    return view;
  }

  /**
   * Put a past conversation back on screen, then continue it.
   *
   * Resuming used to set the session id and print one line saying so, which left the
   * panel empty: the thread you had just chosen was invisible, the coach appeared to
   * have forgotten it, and clicking Resume twice simply stacked a second line. You
   * cannot continue a conversation you cannot read.
   *
   * The log is assembled off-screen and swapped atomically. Appending would splice the old thread onto whatever was
   * on screen and imply the coach can see both, when the CLI is resuming exactly one.
   */
  function replayThread(thread) {
    historyButton.hidden = false;
    newChatButton.hidden = false;
    updateThreadStrip({ title: thread.turns?.find(t => t.ask)?.ask, startedAt: thread.startedAt || thread.turns?.[0]?.askedAt || thread.turns?.[0]?.at, turns: thread.turns?.length || 0 });
    replace(log, threadNodes(thread));
    following = true;
    scrollDown(true);
  }

  /** The saved turns of one conversation as nodes, each tagged with the turn it came from. */
  function threadNodes(thread) {
    const nodes = [];
    let day = null;
    const push = (turn, node) => { if (turn.requestId) node.dataset.requestId = String(turn.requestId); nodes.push(node); };
    for (const turn of thread.turns || []) {
      const at = turn.at || thread.startedAt;
      const nextDay = at && new Date(at).toDateString();
      if (nextDay && nextDay !== day && nextDay !== 'Invalid Date') { nodes.push(conversationSeparator(threadDate(at))); day = nextDay; }
      if (turn.ask && turn.ask.trim()) push(turn, messageNode('you', turn.ask, turn.askedAt || at).message);
      else if (turn.kind === 'attempt-review') push(turn, noteNode('Attempt review'));
      const { message: card, bodyEl, reply } = messageNode('reply', '', turn.askedAt || at, turn.model || turn.provider || '');
      push(turn, card);
      const steps = activitySteps(turn.activity || (turn.tools || []).map(() => ({})), turn.at);
      const acted = Array.isArray(turn.actions) ? turn.actions.filter(a => a && a.tool) : [];
      const ui = new Map();
      const paintChanges = () => reply.setChanges(changeCards(acted, { ui, settled: true, onUndo: async action => {
        ui.set(String(action.id), { busy: true }); paintChanges();
        try { const result = await undoAction(action); ui.set(String(action.id), result.ok ? { undone: true } : { error: result.message }); }
        catch { ui.set(String(action.id), { error: 'Could not undo this change. Try again.' }); }
        paintChanges();
      } }));
      reply.setActivity(steps); paintChanges();
      watchChangeProgress(acted, card, paintChanges);
      renderCoachText(bodyEl, turn.answer || '', new Map(), { slug, live: false });
      reply.setNotice(replyNotice({ text: turn.answer || '', activity: steps, actions: acted, kind: turn.kind, stopped: turn.stopped, result: turn.outcome, ask: turn.ask }));
      reply.finish({ at, durationMs: turn.durationMs });
    }
    return nodes;
  }

  /**
   * On open, draw the conversation the next message will continue.
   *
   * The server continues the problem's last conversation unless told otherwise. The panel
   * used to open on the empty screen regardless, so a question typed there appeared alone,
   * as a new chat, while it was really one more turn of a thread you could not see.
   * What is on screen and what the coach is continuing must be the same conversation.
   */
  let restoreWanted = !thread.pending;
  async function restoreCurrentThread() {
    const data = await loadHistory(slug);
    if (disposed) return;
    const wanted = restoreWanted && !thread.pending && !resumeSessionId;
    restoreWanted = false;
    const current = wanted && data.ok && data.currentSessionId
      ? data.threads.find(past => past.sessionId === data.currentSessionId) : null;
    // A turn already on screen as a run (in flight, or adopted after a reload) is not drawn twice.
    const shown = shownRun?.serverId;
    if (current) updateThreadStrip({ title: current.turns?.find(t => t.ask)?.ask, startedAt: current.startedAt, turns: current.turns.length + (shownRun && !current.turns.some(t => t.requestId === shown) ? 1 : 0) });
    const nodes = current ? threadNodes({ ...current, turns: current.turns.filter(turn => !shown || turn.requestId !== shown) }) : [];
    if (!nodes.length) { if (!log.querySelector('.cmsg,.coach-session-note')) showEmptyState(); return; }
    historyButton.hidden = false;
    newChatButton.hidden = false;
    if (!log.firstChild || log.querySelector('.coach-empty')) replace(log, nodes);
    else log.prepend(...nodes);
    following = true;
    scrollDown(true);
  }

  /* ---- one turn ---- */

  function setBusy(on, label) {
    streaming = on;
    newChatButton.disabled = on;
    newChatButton.title = on ? 'Wait for the current answer to finish before starting a new chat.' : 'New chat';
    if (!pastChats.hidden) renderHistory(pastChats, { slug, onResume: chooseThread, disabled: on });
    sendButton.disabled = !input.value.trim() || on || voice.isBusy() || changingModel;
    sendButton.hidden = on;
    modelPicker.setBusy(on);
    sendButton.setAttribute('aria-label', on ? 'Asking coach' : 'Ask coach');
    sendButton.classList.toggle('busy', on);
    stopButton.hidden = !on;
    if (label) setState(label);
  }

  /**
   * Show a run, live or already finished, and keep showing it as it arrives.
   *
   * Called from two places, which is the whole point: right after starting a turn, and
   * again when the panel is re-mounted on a problem whose answer has been streaming in
   * the background while you were somewhere else.
   *
   * @param {boolean} printAsk whether the question still needs putting on screen —
   *   false when submit() has just drawn it, true when re-attaching to a run in flight
   */
  function attachRun(run, { printAsk = true } = {}) {
    if (shownRun === run) return;   // already on screen; re-attaching would duplicate it
    shownRun = run;
    if (detachRun) { detachRun(); detachRun = null; }

    // The same turn, already drawn from the saved thread: the run is the fuller copy.
    if (run.serverId) for (const node of log.querySelectorAll('[data-request-id]')) {
      if (node.dataset.requestId === String(run.serverId)) node.remove();
    }
    if (printAsk) {
      if (run.review) addNote(run.lead || 'Attempt ended. Reviewing it end to end.');
      else if (run.ask) addMessage('you', run.ask, run.startedAt);
    }

    updateThreadStrip(threadInfo ? { ...threadInfo, turns: log.querySelectorAll('.cmsg.reply').length + 1 }
      : { title: run.ask || 'Attempt review', startedAt: run.startedAt, turns: 1 });
    const { message: card, bodyEl, reply } = addMessage('reply', '', run.startedAt, run.model || run.provider || '');
    if (run.serverId) card.dataset.requestId = String(run.serverId);
    const receiptUi = new Map();
    const steps = () => activitySteps(run.tools, run.endedAt);
    const diagrams = new Map();      // finished drawings, kept across frames
    let painting = false;
    let paintedAt = 0;
    // Every paint rebuilds the whole message body, which is fine at four frames a second
    // and miserable at sixty: the text under the cursor is replaced mid-selection and the
    // box reflows constantly. The stream is prose, not an animation.
    const PAINT_MS = 220;

    let activityLive = !run.done && !run.text;
    const paintTools = (live = !run.done && !run.text) => { activityLive = live; reply.setActivity(steps(), { live, endedAt: run.endedAt }); };

    const undo = async (action) => {
      const id = String(action.id);
      if (receiptUi.get(id)?.busy) return;
      receiptUi.set(id, { busy: true });
      paintReceipts();
      try { const result = await undoAction(action); receiptUi.set(id, result.ok ? { undone: true } : { error: result.message }); }
      catch { receiptUi.set(id, { error: 'Could not undo this change. Try again.' }); }
      paintReceipts();
    };

    const paintReceipts = () => reply.setChanges(changeCards([...(run.actions?.values() ?? [])], {
      ui: receiptUi, onUndo: undo, settled: run.done,
    }));
    const watchHandoffs = () => watchChangeProgress([...(run.actions?.values() || [])], card, paintReceipts);

    const render = () => {
      // Reading three paragraphs back: hold that exact offset across the rebuild, or the
      // sentence being read moves under the eye every time a token lands.
      const keep = following ? -1 : log.scrollTop;
      renderCoachText(bodyEl, run.text, diagrams, { slug, live: true });
      bodyEl.dataset.streaming = String(!run.done && Boolean(run.text));
      if (following) log.scrollTop = log.scrollHeight;
      else if (keep >= 0) log.scrollTop = keep;
      paintedAt = performance.now();
    };

    const paint = () => {
      if (painting) return;
      painting = true;
      const wait = Math.max(0, PAINT_MS - (performance.now() - paintedAt));
      setTimeout(() => requestAnimationFrame(() => {
        painting = false;
        if (disposed) return;
        render();
      }), wait);
    };

    const finish = () => {
      paintTools(); paintReceipts();
      renderCoachText(bodyEl, run.text, diagrams, { slug, live: true });
      const outcome = replyNotice({ text: run.text, activity: steps(), actions: [...(run.actions?.values() || [])], kind: run.kind, result: run.result, ask: run.ask });
      reply.setNotice(outcome);
      reply.finish({ at: run.endedAt, durationMs: run.durationMs });

      bodyEl.dataset.streaming = 'false';
      setBusy(false, outcome && outcome.tone === 'err' ? 'Not available' : thread.live ? 'Attempt in progress' : 'Ready');
      resumeSessionId = null;
      markSeen(slug);
      if (detachRun) { detachRun(); detachRun = null; }
      scrollDown();
    };

    // Whatever has already arrived, before subscribing to the rest.
    paintTools();
    paintReceipts();
    watchHandoffs();
    if (run.text) render();

    if (run.done) { finish(); return; }

    setBusy(true, 'Thinking');
    detachRun = watch(slug, (event) => {
      if (disposed) return;
      if (event === 'token') { if (activityLive) paintTools(false); paint(); return; }
      if (event === 'tool') { paintTools(!run.done); scrollDown(); return; }
      if (event === 'action') { paintReceipts(); watchHandoffs(); scrollDown(); return; }
      if (event === 'done') finish();
    });
  }

  async function submit({ ask = null, kind = null, attemptId = null, newThread = false, lead = null } = {}) {
    if (streaming || voice.isBusy() || changingModel) return;
    const review = kind === 'attempt-review';
    const message = ask !== null ? ask : input.value.trim();
    if (!review && message === '') { input.focus(); return; }

    if (!review) {
      input.value = '';
      clearDraft(slug);
      autosize();
    }
    // attachRun owns both the question/review note and the reply. startRun announces
    // synchronously, so showPendingRun may attach before the explicit call below.
    // Printing the question here as well would display the same submission twice.

    turns++;
    following = true; // a new question always follows, whatever was scrolled last time
    setBusy(true, 'Thinking');

    // Get the in-flight take onto disk before the question goes out. Otherwise the words
    // that prompted the question are still inside the recorder, and the coach answers as
    // though they were never said. Bounded inside flushRecorder — this cannot hang.
    if (!review) {
      try {
        setState('Transcribing');
        await flushRecorder();
      } catch { /* speech is a bonus input; never let it block a question */ }
    }
    // The coach reads solution.py from disk, and the editor saves on a debounce: typing
    // and asking straight away would otherwise send the code from a second ago. Bounded
    // (2 s) and quiet inside flushEditorSave — a slow save cannot hold the question.
    await flushEditorSave(slug).catch(() => false);

    const run = startRun({
      slug,
      title: entry.title || slug,
      message,
      kind,
      attemptId,
      newThread: newThread || thread.pending,
      resumeSessionId,
      attach: attachment,
      lead,
    });
    clearAttachment();
    thread.pending = false;
    attachRun(run, { printAsk: true });
  }

  /* ---- keyboard ---- */

  // main.js owns a global map (j/k/s/a/r, /, Esc). It must stop while typing here,
  // and arrow/page keys must scroll the conversation rather than change problem.
  // Everything else bubbles: stopping every key used to leave all shortcuts dead
  // after any click in this panel (the conversation is focusable), until you
  // happened to click somewhere else.
  root.addEventListener('keydown', (event) => {
    if (isTextEntry(event.target)
      || (log.contains(event.target) && SCROLL_KEYS.has(event.key))) event.stopPropagation();
    // Interviews and submissions remain inside this root, alongside a hidden Chat
    // composer. Only a gesture in the visible Chat composer can send its draft.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === 'Enter'
      && selectedTab === 'chat' && !composer.hidden && composer.contains(event.target) && !hasOpenOverlay()) {
      if (claimActionKey(event)) submit();
      return;
    }
    if (event.key === 'Escape' && !pastChats.hidden) {
      closeHistory();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === 'Escape' && document.activeElement === input) { event.preventDefault(); input.blur(); }
  });

  // The empty screen only when there is nothing to continue; deciding first avoids
  // flashing it before the thread.
  if (restoreWanted) { historyButton.hidden = true; newChatButton.hidden = true; restoreCurrentThread(); }
  else showEmptyState();
  submissions.refresh();
  const savedSidebar = readSidebar(slug);
  showTab(savedSidebar.tab || (activeInterview(slug) ? 'interviews' : 'chat'));
  if (!savedSidebar.interviewId && activeInterview(slug)) interviews.open(activeInterview(slug).id || null);
  autosize();

  return {
    root,
    focus: () => input.focus(),
    isStreaming: () => streaming,
    isChatVisible: () => selectedTab === 'chat',
    setVisible(on) { interviews.show(on && selectedTab === 'interviews'); },
    openInterview(id = null) { showTab('interviews'); interviews.open(id); },
    slug,
    attach: attachRun,
    turnCount: () => turns,

    /** A new attempt is a new conversation: clear the panel and drop the resumed thread. */
    beginAttempt() {
      // A new attempt is a new conversation, so the previous turn is genuinely
      // unwanted — this is the one place that stops a run rather than letting it finish.
      stopRun(slug);
      restoreWanted = false;
      thread.pending = true;
      thread.live = true;
      resumeSessionId = null;
      showTab('chat');
      showEmptyState();
      setState('Attempt in progress');
    },

    endAttempt() {
      thread.live = false;
      if (!streaming && !voice.isBusy()) setState('Ready');
    },

    /** The attempt ended. Ask for the end-to-end review, with no typed question. */
    reviewAttempt(detail = {}) {
      thread.live = false;
      setOpen(true);
      return submit({ ...reviewOptions(detail), ask: '', newThread: thread.pending });
    },
    /**
     * Leaving the problem. The run is NOT stopped: it keeps going in the background and
     * this panel simply stops listening. Come back and mountCoach re-attaches to it.
     */
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('studio-interview-setup', setupInterview);
      window.removeEventListener('studio-submission', submissionChanged);
      window.removeEventListener('studio-open-submission', submissionChanged);
      document.removeEventListener('pointerdown', outsideHistory);
      if (detachRun) { detachRun(); detachRun = null; }
      // Voice may finish outstanding phrases asynchronously; the callback above
      // updates this same draft key as each phrase arrives.
      unwatchDraft();
      saveDraft(slug, committed());
      voice.dispose({ finish: true });
      inputSize.dispose(); pinnedQuestion.dispose(); for (const reply of replies) reply.dispose(); conversationView.dispose(); historyPopover.dispose(); modelPicker.dispose();
      interviews.dispose();
    },
  };
}

/* ============================== mounting ============================== */

let active = null;
let launcher = null;

function readOpen() {
  try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
}

function writeOpen(open) {
  try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* private browsing */ }
}

/** A background answer for the problem on screen, shown as soon as there is room for it. */
function showPendingRun() {
  if (!active || !isOpen() || !active.isChatVisible()) return;
  const run = runFor(active.slug);
  if (run) active.attach(run, { printAsk: true });
}

/** Open or close the panel. The editor keeps its width when the coach is away. */
export function setOpen(open, { focus = true } = {}) {
  document.body.classList.toggle('coach-open', open);
  active?.setVisible(open);
  writeOpen(open);
  if (launcher) launcher.setAttribute('aria-pressed', String(open));
  // Only when *you* opened it. Restoring a panel that was open last time must not
  // silently capture the keyboard — the editor is the reason the screen exists, and
  // typing that lands in the composer looks exactly like broken shortcuts.
  if (open && focus && active) setTimeout(() => active.focus(), 60);
  if (open) showPendingRun();
}

export function isOpen() {
  return document.body.classList.contains('coach-open');
}

/**
 * A standing note about answers being written for problems you are not looking at.
 *
 * Without it, a background turn is invisible: you would have to remember that you asked
 * something on Trapping Rain Water twenty minutes ago and go back to check. Clicking a
 * row goes there — which is the whole point of letting the turn outlive the panel.
 */
let runsChip = null;
// Set by the indicator: following it means "show me that answer", not "go to that page".
let openOnMount = false;

function ensureRunsChip() {
  if (runsChip && document.body.contains(runsChip)) return runsChip;
  runsChip = el('div', { class: 'coach-runs', hidden: true });
  document.body.append(runsChip);
  onRunsChange(paintRunsChip);
  // A turn adopted from the server after a reload lands here rather than at mount time,
  // so the panel has to be told to look again when one appears.
  onRunsChange(showPendingRun);
  paintRunsChip();
  return runsChip;
}

// Said plainly in its tooltip, because a close mark next to something still being
// written looks like a cancel and is not one.
function hideRunButton(run) {
  const button = el('button', {
    class: 'btn btn--icon coach-run-x', type: 'button',
    'aria-label': `Hide this note about ${run.title}`,
    onclick: () => dismissRun(run.slug),
  }, icon('close', 13));
  tooltip(button, run.done ? 'Hide this. The answer stays on that problem.' : 'Hide this. The coach keeps writing.');
  return button;
}

function paintRunsChip() {
  if (!runsChip) return;
  const raw = /^#\/p\/([^/?]+)/.exec(location.hash)?.[1];
  let here = null;
  try { here = raw ? decodeURIComponent(raw) : null; } catch { /* malformed route */ }
  const others = runsElsewhere(here);
  runsChip.hidden = others.length === 0;
  // Two actions, so two buttons — the row cannot be one button with another inside it.
  // Following it goes to the answer; the × takes the note away and nothing else.
  replace(runsChip, others.map((run) => el('div', { class: 'coach-run mono' }, [
    el('button', {
      class: 'btn btn--quiet coach-run-go', type: 'button',
      onclick: () => {
        openOnMount = true;
        if (location.hash === `#/p/${run.slug}`) { setOpen(true); showPendingRun(); }
        else location.hash = `#/p/${run.slug}`;
      },
    }, [
      el('span', { class: 'coach-run-dot' + (run.done ? ' is-done' : '') }),
      el('span', { class: 'coach-run-title', text: run.title }),
      el('span', { class: 'coach-run-state', text: run.done ? 'answer ready' : 'writing…' }),
    ]),
    hideRunButton(run),
  ])));
}

window.addEventListener('hashchange', paintRunsChip);

function ensureLauncher() {
  if (launcher && document.body.contains(launcher)) return launcher;
  launcher = el('button', {
    class: 'btn btn--quiet coach-launch', type: 'button', 'aria-pressed': 'false',
    onclick: () => setOpen(!isOpen()),
  }, [el('span', { text: 'Coach' }), el('kbd', { text: chordLabel('coach') })]);
  document.body.append(launcher);
  return launcher;
}

/**
 * Mount the coach for one problem and return the element to place in the DOM.
 * Called by problem.js, which owns the problem screen.
 */
let adoption = null;
export function mountCoach(entry) {
  if (active) active.dispose();
  const panel = createCoachPanel(entry);
  active = panel;
  ensureLauncher();
  ensureRunsChip();
  setOpen(Boolean(activeInterview(entry.slug)) || openOnMount || readOpen(), { focus: false });
  openOnMount = false;

  // The server may still be writing an answer this page has never seen — the tab was
  // reloaded, or this is a second tab. Ask once; anything found announces itself and
  // arrives through showPendingRun.
  if (!adoption) adoption = adopt().catch(() => { adoption = null; });

  // An answer that was still arriving when you left, or that finished while you were
  // away. It goes on screen once the panel is open — attaching into a hidden panel would
  // mark it read and take the indicator away without anyone having seen it.
  showPendingRun();

  return panel.root;
}

// Opening an interview selects an accordion row inside the existing sidebar.
window.addEventListener('studio-interview-change', () => {
  const interview = activeInterview();
  if (!interview || active?.slug !== interview.slug) return;
  active.openInterview(interview.id || null);
  setOpen(true, { focus: false });
    }, icon('close'));
window.addEventListener('studio-interview-open', event => {
  if (active?.slug !== event.detail.slug) return;
  active.openInterview(event.detail.id);
  setOpen(true, { focus: false });
});

/** A new attempt owns a fresh thread even if its panel is temporarily absent. */
export function coachBeginAttempt(slug) {
  const thread = attemptThread(slug);
  thread.pending = true;
  thread.live = true;
  if (active?.slug === slug) active.beginAttempt();
  else stopRun(slug);
}

/** Route the review to the attempt, using the same payload with or without a panel. */
export function coachReviewAttempt(detail) {
  const thread = attemptThread(detail.slug);
  thread.live = false;
  if (active?.slug === detail.slug) active.endAttempt();
  if (!detail.attemptId || !detail.spokenMs) return;
  if (active?.slug === detail.slug) return active.reviewAttempt(detail);
  ensureRunsChip();
  // The review reads the saved code too; same bounded flush as a typed question.
  return flushEditorSave(detail.slug).catch(() => false).then(() => {
    const run = startRun({ slug: detail.slug, title: detail.title || detail.slug,
      ...reviewOptions(detail), newThread: thread.pending });
    thread.pending = false;
    return run;
  });
}

export function teardownCoach() {
  if (active) { active.dispose(); active = null; }
  document.body.classList.remove('coach-open');
  if (launcher) { launcher.remove(); launcher = null; }
}

// ⌘\ toggles the panel. It used to be a bare `c`, which meant it worked only while the
// cursor was nowhere and typed a letter the rest of the time — including into the coach's
// own composer, which is the one place you are guaranteed to be typing.
onChord('coach', () => { if (active) setOpen(!isOpen()); });
window.addEventListener('studio:open-coach', () => { if (active) setOpen(true); });

window.addEventListener('hashchange', () => {
  if (!/^#\/p\//.test(location.hash)) teardownCoach();
});

/**
 * Contract-shaped entry point, for wiring from main.js instead of problem.js.
 * `mountEl` is emptied and given the coach for whatever problem the hash names.
 */
export function init(mountEl, apiState) {
  const match = /^#\/p\/(.+)$/.exec(location.hash);
  if (!match) return null;
  const slug = decodeURIComponent(match[1]);
  replace(mountEl, mountCoach({ slug, title: slug }));
  return active;
}

export { api };
