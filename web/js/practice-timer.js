import { el, replace } from './dom.js';
import { icon } from './ui/icon.js';

export function formatPracticeTime(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const pair = n => String(n).padStart(2, '0');
  return hours ? `${hours}:${pair(minutes)}:${pair(seconds % 60)}` : `${pair(minutes)}:${pair(seconds % 60)}`;
}

// Both disciplines use this control. Ticks only change the time text, not the
// workspace DOM; pause/resume is persisted before acknowledging the transition.
export function createPracticeTimer({ timer, serverNow, change, onError }) {
  let state = timer, offset = (serverNow || Date.now()) - Date.now(), saving = false, gone = false;
  const time = el('span', { class: 'pr-timer-value', role: 'timer', 'aria-label': 'Practice time elapsed', 'aria-live': 'off' });
  const label = el('span', { class: 'pr-timer-label', 'aria-live': 'polite' });
  const failure = el('span', { class: 'pr-timer-error', role: 'alert', hidden: true, text: 'Timer not saved' });
  const button = el('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: () => setRunning(state?.runningSince == null) });
  const root = el('div', { class: 'pr-timer', role: 'group', 'aria-label': 'Practice timer' }, [
    el('div', { class: 'pr-timer-reading' }, [label, time]), button, failure,
  ]);
  function tick() {
    if (gone) return;
    time.textContent = state ? formatPracticeTime((state.elapsedMs || 0) + (state.runningSince == null ? 0 : Math.max(0, Date.now() + offset - state.runningSince))) : '—';
  }
  function paint() {
    if (gone) return;
    const running = state?.runningSince != null;
    label.textContent = !state ? 'Not tracked yet' : running ? 'Elapsed' : 'Paused';
    button.disabled = saving;
    button.setAttribute('aria-label', !state ? 'Start practice timer' : running ? 'Pause practice timer' : 'Resume practice timer');
    replace(button, [icon(running ? 'pause' : 'play'), el('span', { text: !state ? 'Start' : running ? 'Pause' : 'Resume' })]);
    tick();
  }
  async function setRunning(running) {
    if (saving || gone) return;
    saving = true; failure.hidden = true; paint();
    try {
      const result = await change(running);
      state = result.timer; offset = result.serverNow - Date.now();
    } catch (error) {
      if (!gone) { failure.hidden = false; onError(error); }
    } finally { saving = false; paint(); }
  }
  paint();
  const interval = setInterval(tick, 250);
  // Pre-timer sessions have no trustworthy duration. Start on this first visit,
  // rather than treating their creation date as active practice time.
  if (!state) void setRunning(true);
  return { root, dispose() { gone = true; clearInterval(interval); } };
}
