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
  let state = timer || { elapsedMs: 0, runningSince: null }, offset = (serverNow || Date.now()) - Date.now();
  let saving = false, savingHeartbeat = false, gone = false, desiredRunning = false, transition = 0;
  const time = el('span', { class: 'pr-timer-value', role: 'timer', 'aria-label': 'Practice time elapsed', 'aria-live': 'off' });
  const label = el('span', { class: 'pr-timer-label', 'aria-live': 'polite' });
  const failure = el('span', { class: 'pr-timer-error', role: 'alert', hidden: true, text: 'Timer not saved' });
  const button = el('button', { type: 'button', class: 'btn btn--quiet', onclick: () => setRunning(!isRunning()) });
  const root = el('div', { class: 'pr-timer', role: 'group', 'aria-label': 'Practice timer' }, [
    el('div', { class: 'pr-timer-reading' }, [label, time]), button, failure,
  ]);
  const now = () => Date.now() + offset;
  const isRunning = () => state.runningSince != null && state.leaseUntil > now();
  function paint() {
    if (gone) return;
    const running = isRunning();
    const activeMs = state.runningSince == null ? 0 : Math.max(0, Math.min(now(), state.leaseUntil ?? now()) - state.runningSince);
    time.textContent = formatPracticeTime((state.elapsedMs || 0) + activeMs);
    label.textContent = running ? 'Elapsed' : 'Paused';
    button.disabled = saving && !savingHeartbeat;
    const action = running ? 'Pause' : state.elapsedMs || activeMs ? 'Resume' : 'Start';
    button.setAttribute('aria-label', `${action} practice timer`);
    if (button.dataset.action !== action) { button.dataset.action = action; replace(button, [icon(running ? 'pause' : 'play'), el('span', { text: action })]); }
  }
  async function write(body, version, heartbeat = false) {
    saving = true; savingHeartbeat = heartbeat; if (!heartbeat) failure.hidden = true; paint();
    let succeeded = false;
    try {
      const result = await change(body);
      state = result.timer; offset = result.serverNow - Date.now(); succeeded = true;
      if (version === transition) desiredRunning = isRunning();
    } catch (error) {
      if (!gone) { failure.hidden = false; onError(error); }
    } finally {
      saving = false; savingHeartbeat = false; paint();
      // A stop selected during an in-flight start/heartbeat is serialized after it.
      // Failed mutations never automatically retry themselves.
      if (version !== transition && !desiredRunning && (succeeded || state.runningSince != null)) void write({ running: false }, transition);
    }
  }
  function setRunning(running) {
    desiredRunning = running; transition++;
    if (!saving) void write({ running }, transition);
  }
  function pause() { if (desiredRunning || state.runningSince != null || saving) setRunning(false); }
  paint();
  // Opening an existing session does not opt into tracking it again.
  if (state.runningSince != null) pause();
  const interval = setInterval(paint, 250);
  const heartbeat = setInterval(() => {
    if (!gone && desiredRunning && isRunning() && !saving && !document.hidden) void write({ heartbeat: true, runningSince: state.runningSince }, transition, true);
  }, 10_000);
  return { root, pause, dispose() { pause(); gone = true; clearInterval(interval); clearInterval(heartbeat); } };
}
