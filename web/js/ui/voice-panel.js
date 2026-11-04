import { el } from '../dom.js';
import { icon } from './icon.js';
import { END_OF_TURN_MS } from '../speech.js';

// A shared view of the audio lifecycle. Provisional words never enter the saved
// answer; callers own the confirmed draft and acknowledge submission explicitly.
export function createVoicePanel({ onEdit, onReplay, onPolicyChange = () => {}, role = 'Interviewer', autoSend = true, transcriptClass = '' } = {}) {
  let state = 'idle', draft = '', partial = '', sending = false, busy = false, paused = false;
  let playback = { phase: 'idle' }, sample = {}, reply = '', lastSent = '', following = true;
  let automatic = autoSend;
  if (autoSend) try { automatic = localStorage.getItem('studio.voice.autoSend') !== 'false'; } catch {}
  const label = el('span', { class: 'voice-state', role: 'status' });
  const bars = Array.from({ length: 16 }, () => el('i'));
  const meter = el('span', { class: 'voice-wave', 'aria-hidden': 'true' }, bars);
  const duration = el('span', { class: 'voice-duration mono', 'aria-label': 'Recording duration' });
  const title = el('span', { class: 'voice-transcript-label', text: 'You' });
  const finalText = el('span', { class: 'voice-confirmed' });
  const liveText = el('span', { class: 'voice-partial' });
  const transcript = el('div', { class: `voice-transcript ${transcriptClass}`, tabindex: '0', 'aria-label': 'Your live answer. Highlighted words are still being transcribed.' }, [finalText, liveText]);
  const hint = el('span', { class: 'voice-hint' });
  const edit = el('button', { type: 'button', class: 'btn btn--quiet btn--sm', text: 'Edit answer', onclick: () => onEdit?.() });
  const policy = el('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: () => {
    automatic = !automatic;
    try { localStorage.setItem('studio.voice.autoSend', String(automatic)); } catch {}
    onPolicyChange(automatic); paint();
  } });
  const replay = el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Replay ${role.toLowerCase()} reply`, onclick: () => onReplay?.(reply) }, icon('speaker'));
  const captionLabel = el('span', { class: 'voice-transcript-label' });
  const captionText = el('p', { class: 'voice-caption-text' });
  const caption = el('div', { class: 'voice-caption', hidden: true }, [captionLabel, captionText]);
  const sentText = el('p');
  const sent = el('details', { class: 'voice-sent', hidden: true }, [el('summary', { text: 'Last sent answer' }), sentText]);
  const draftPanel = el('div', { class: 'voice-draft' }, [title, transcript]);
  const root = el('section', { class: 'voice-panel', 'aria-label': 'Voice conversation' }, [
    el('div', { class: 'voice-topline' }, [meter, label, duration, autoSend ? policy : null, replay]), caption,
    draftPanel,
    el('div', { class: 'voice-bottomline' }, [hint, edit]), sent,
  ]);
  transcript.addEventListener('scroll', () => { following = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 28; });
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  function paint() {
    const playing = ['preparing','speaking'].includes(playback.phase);
    root.dataset.state = playing ? playback.phase : state;
    text(label, playing ? playback.phase === 'preparing' ? 'Preparing voice…' : `${role} speaking`
      : sending ? 'Sending your answer…' : state === 'opening' ? 'Opening microphone…'
      : state === 'recording' ? 'Listening' : state === 'working' ? 'Finishing transcription…' : busy ? `${role} is thinking…` : paused ? 'Voice paused' : 'Microphone off');
    const seconds = Math.floor((sample.elapsedMs || 0) / 1000);
    text(duration, ['recording','working'].includes(state) ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,'0')}` : '');
    text(title, sending ? 'You · sending' : partial ? 'You · live' : 'You');
    text(finalText, draft);
    text(liveText, partial ? `${draft && !/\s$/.test(draft) ? ' ' : ''}${partial}` : '');
    transcript.classList.toggle('is-empty', !draft && !partial);
    transcript.dataset.placeholder = state === 'recording' ? 'Go ahead, I’m listening…' : 'Your words appear here as you speak.';
    edit.hidden = !draft || !onEdit; edit.disabled = busy || sending;
    text(policy, automatic ? 'Pause to send' : 'Send manually');
    policy.setAttribute('aria-pressed', String(automatic));
    policy.setAttribute('aria-label', automatic ? 'Pause to send is on. Switch to manual sending.' : 'Manual sending is on. Enable pause to send.');
    policy.disabled = busy || sending || paused;
    policy.hidden = playing;
    draftPanel.hidden = playing || (!draft && !partial && !['recording','working'].includes(state));
    replay.hidden = !reply || !onReplay || playing || busy || sending; replay.disabled = busy || sending || playing || state === 'working';
    const counting = automatic && !playing && !busy && !sending && !paused && state === 'recording' && draft.trim() && !sample.pending && !sample.failed && sample.sinceLoud >= 700;
    text(hint, sample.failed ? 'Automatic sending paused · retry or discard the failed audio below.' : state === 'working' || sample.pending ? 'Finishing your last words…' : counting ? `Sending in ${Math.max(0,(END_OF_TURN_MS - sample.sinceLoud)/1000).toFixed(1)}s`
      : '');
    root.querySelector('.voice-bottomline').hidden = playing || (!hint.textContent && edit.hidden);
    caption.hidden = !playing && playback.phase !== 'error';
    text(captionLabel, playback.phase === 'error' ? 'Voice playback unavailable' : playback.engine === 'system' ? `${role} · system voice` : role);
    text(captionText, playback.phase === 'error' ? playback.message || 'The reply is still available in the conversation.' : playback.text || '');
    sent.hidden = !lastSent;
    if (following) transcript.scrollTop = transcript.scrollHeight;
  }
  paint();
  return {
    root, get automatic() { return automatic; },
    update(value = {}) {
      ({state = state, draft = draft, partial = partial, sending = sending, busy = busy, paused = paused} = value); paint();
    },
    level(value) {
      sample = value;
      const level = Math.min(1, Math.max(0, value.level || 0));
      for (let i = 0; i < bars.length - 1; i++) bars[i].style.setProperty('--voice-level', bars[i+1].style.getPropertyValue('--voice-level') || '.08');
      bars.at(-1).style.setProperty('--voice-level', String(Math.max(.08,level)));
      paint();
    },
    playback(value) { playback = value; paint(); },
    reply(text) { reply = String(text || ''); paint(); },
    sent(value) { if (!value?.trim()) return; lastSent = value; text(sentText, lastSent); paint(); },
  };
}
