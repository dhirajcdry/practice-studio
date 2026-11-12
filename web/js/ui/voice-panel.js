import { tooltip } from '../tooltip.js';
import { messageAction } from './conversation.js';
import { el } from '../dom.js';
import { icon } from './icon.js';
import { END_OF_TURN_MS } from '../speech.js';
import { autoSendEnabled } from '../speech-preferences.js';

// The one voice bar: what is happening, your words, and this turn's controls.
// Session controls live in each screen's header and preferences live in Settings.
// Provisional words never enter the saved answer; callers own the confirmed draft.
export function createVoicePanel({ onEdit, role = 'Interviewer', autoSend = true, transcriptClass = '' } = {}) {
  let state = 'idle', draft = '', partial = '', sending = false, busy = false, paused = false, held = false;
  let playback = { phase: 'idle' }, sample = {}, following = true;
  const automatic = () => autoSend && autoSendEnabled();
  const label = el('span', { class: 'voice-state', role: 'status' });
  const bars = Array.from({ length: 16 }, () => el('i'));
  const meter = el('span', { class: 'voice-wave', 'aria-hidden': 'true' }, bars);
  const duration = el('span', { class: 'voice-duration mono', 'aria-label': 'Recording duration' });
  const hint = el('span', { class: 'voice-hint' });
  const finalText = el('span', { class: 'voice-confirmed' });
  const liveText = el('span', { class: 'voice-partial' });
  const canEdit = () => Boolean(onEdit && draft && !busy && !sending);
  const edit = () => { if (canEdit() && !String(getSelection())) onEdit(); };
  const transcript = el('div', { class: `voice-transcript ${transcriptClass}`, tabindex: '0', 'aria-label': 'Your live answer. Highlighted words are still being transcribed. Click or press Enter to edit.', onclick: edit,
    onkeydown: event => { if (event.key === 'Enter') { event.preventDefault(); edit(); } } }, [finalText, liveText]);
  const caption = el('p', { class: 'voice-caption', hidden: true });
  const lead = el('span', { class: 'voice-lead' });
  const actions = el('span', { class: 'voice-actions' });
  const root = el('section', { class: 'voice-panel', 'aria-label': 'Voice conversation' }, [
    el('div', { class: 'voice-bar' }, [lead, meter, label, hint, duration, actions]), caption, transcript,
  ]);
  transcript.addEventListener('scroll', () => { following = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 28; });
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  function paint() {
    const playing = ['preparing','speaking'].includes(playback.phase);
    root.dataset.state = playing ? playback.phase : state;
    root.dataset.capture = state;
    text(label, playing ? playback.phase === 'preparing' ? 'Preparing voice…' : `${role} speaking${playback.engine === 'system' ? ' · system voice' : ''}`
      : sending ? 'Sending your answer…' : state === 'opening' ? 'Opening microphone…'
      : state === 'working' ? 'Finishing transcription…' : held ? 'Answer not sent' : state === 'recording' ? 'Listening' : busy ? `${role} is thinking…` : paused ? 'Voice paused' : 'Microphone off');
    const seconds = Math.floor((sample.elapsedMs || 0) / 1000);
    // Interviews already show a clock. Dictation has no other sign of how long a take is.
    text(duration, !autoSend && ['recording','working'].includes(state) ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,'0')}` : '');
    text(finalText, draft);
    text(liveText, partial ? `${draft && !/\s$/.test(draft) ? ' ' : ''}${partial}` : '');
    transcript.classList.toggle('is-editable', canEdit());
    transcript.hidden = !draft && !partial;
    const counting = automatic() && !playing && !busy && !sending && !paused && !held && state === 'recording' && draft.trim() && !sample.pending && !sample.failed && sample.sinceLoud >= 700;
    label.title = playing && state === 'recording' ? 'Microphone is on. Speak to interrupt.' : '';
    text(hint, sample.failed ? 'Retry or discard the failed audio below' : playing ? '' : state === 'working' || sample.pending ? 'Finishing your last words…' : counting ? `Sending in ${Math.max(0,(END_OF_TURN_MS - sample.sinceLoud)/1000).toFixed(1)}s` : '');
    label.hidden = !playing && Boolean(hint.textContent);
    caption.hidden = playback.phase !== 'error';
    text(caption, playback.phase === 'error' ? playback.message || 'Voice playback is unavailable. The reply is still in the conversation.' : '');
    if (following) transcript.scrollTop = transcript.scrollHeight;
  }
  paint();
  return {
    root, get automatic() { return automatic(); },
    setControls({ lead: before = [], actions: after = [] }) { lead.replaceChildren(...before); actions.replaceChildren(...after); },
    update(value = {}) {
      ({state = state, draft = draft, partial = partial, sending = sending, busy = busy, paused = paused, held = held} = value); paint();
    },
    level(value) {
      sample = value;
      const level = Math.min(1, Math.max(0, value.level || 0));
      for (let i = 0; i < bars.length - 1; i++) bars[i].style.setProperty('--voice-level', bars[i+1].style.getPropertyValue('--voice-level') || '.08');
      bars.at(-1).style.setProperty('--voice-level', String(Math.max(.08,level)));
      paint();
    },
    playback(value) { playback = value; paint(); },
  };
}

// The quiet link between the two answer modes. `target` is what it switches to.
export function answerModeSwitch(target, onSelect) {
  const voice = target === 'voice';
  return el('button', { class: 'btn btn--quiet ui-mode-switch', type: 'button', dataset: { mode: target },
    text: voice ? 'Voice' : 'Type', 'aria-label': voice ? 'Answer by voice' : 'Type your answer', onclick: () => onSelect(target) });
}

export function micToggle(onclick) {
  const button = el('button', { class: 'btn btn--icon voice-mic', type: 'button', onclick }, icon('mic-off', 15));
  tooltip(button, () => button.getAttribute('aria-label')); return button;
}

export function paintMicToggle(button, on, labels = { on: 'Mute microphone', off: 'Turn on microphone' }) {
  const value = on ? 'on' : 'off';
  if (button.dataset.mic !== value) { button.dataset.mic = value; button.replaceChildren(icon(on ? 'mic' : 'mic-off')); }
  const name = on ? labels.on : labels.off;
  button.removeAttribute('title'); button.setAttribute('aria-label', name);
  button.setAttribute('aria-pressed', String(on));
}

// Replay sits on the reply it replays, revealed with the message.
export function replayButton(getText, onReplay, role = 'Interviewer') {
  return messageAction(el('button', { class: 'voice-replay', type: 'button', 'aria-label': `Replay ${role.toLowerCase()} reply`,
    onclick: () => { const value = getText().trim(); if (value) onReplay(value); } }), 'speaker', `Replay ${role.toLowerCase()} reply`);
}

// Silence must still read as received: the words went in and the interviewer chose not to answer.
export function interviewerSilentNote({ live = false } = {}) {
  return el('p', { class: 'dim interviewer-silent', ...(live ? { role: 'status' } : {}), text: 'Heard you. The interviewer chose to stay silent.' });
}
