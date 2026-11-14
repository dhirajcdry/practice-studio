import { el } from '../dom.js';
import { icon } from './icon.js';
import { tooltip } from '../tooltip.js';
import { createMockTimeControls, mockTimeReading } from './mock-time.js';

// "02:00" reads as "2:00": the band is a sentence, the header clock is a readout.
export function pausedBandText(reading) {
  const [minutes, seconds] = reading.text.replace(/^\+/, '').split(':');
  return `Paused · ${Number(minutes)}:${seconds} ${reading.remaining <= 0 ? 'over' : 'left'}`;
}

// The session controls every timed mock shares: the clock (which is the Add time
// trigger), one Pause/Resume toggle that never leaves the header, Finish, and a paused
// band that reads in remaining time with its own Resume. Presentation only: the screen
// owns every guard and request, and calls update() with what is true now.
export function createMockSessionControls({ clock, extend, onTimeChange = () => {}, onPause, onFinish, pauseClass = '', finishClass = '', className = '' }) {
  const timeControls = createMockTimeControls({ clock, extend, onChange: onTimeChange });
  let resumeIcon = null, label = 'Pause interview';
  const pauseButton = el('button', { class: `btn btn--icon icon-btn mock-pause ${pauseClass}`.trim(), type: 'button', 'aria-label': label, onclick: () => onPause() });
  tooltip(pauseButton, () => pauseButton.getAttribute('aria-label'));
  const finishButton = el('button', { class: `btn btn--quiet mock-finish ${finishClass}`.trim(), 'data-danger': 'true', type: 'button', text: 'Finish', onclick: () => onFinish() });
  const root = el('div', { class: `mock-session ${className}`.trim() }, [timeControls.root, pauseButton, finishButton]);
  const bandText = el('span', { class: 'ui-cluster-content mock-paused-text' });
  const resume = el('button', { class: 'btn btn--primary mock-resume', type: 'button', text: 'Resume', onclick: () => onPause() });
  const band = el('div', { class: 'ci-paused mock-paused ui-inset ui-cluster', role: 'status', hidden: true }, [bandText, resume]);
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  function paintToggle(showResume) {
    // Swap the icon only when the state flips; a 1 s tick must not replace the SVG.
    if (resumeIcon === showResume) return;
    resumeIcon = showResume; label = showResume ? 'Resume interview' : 'Pause interview';
    pauseButton.replaceChildren(icon(showResume ? 'play' : 'pause'));
    pauseButton.setAttribute('aria-label', label);
  }
  paintToggle(false);
  return {
    root, band, timeControls, pauseButton, finishButton,
    get saving() { return timeControls.saving; },
    /**
     * paused: the interview clock is stopped (shows the band).
     * resumable: the toggle offers Resume (paused, or not yet joined in this tab).
     * A disabled flag left undefined leaves that control to the screen's own updates.
     */
    update({ minutes, elapsedMs, paused = false, resumable = paused, ended = false, pauseDisabled, resumeDisabled = pauseDisabled, finishDisabled, timeDisabled }) {
      const reading = mockTimeReading(minutes, elapsedMs);
      setText(clock, reading.text);
      clock.setAttribute('aria-label', `${reading.text} ${reading.label}`);
      timeControls.root.querySelector('button').setAttribute('aria-label', `${reading.text} ${reading.label}. Add time`);
      if (timeDisabled !== undefined) timeControls.update({ disabled: timeDisabled, hidden: ended });
      paintToggle(resumable);
      pauseButton.hidden = finishButton.hidden = ended;
      const toggleDisabled = resumable ? resumeDisabled : pauseDisabled;
      if (toggleDisabled !== undefined) pauseButton.disabled = toggleDisabled;
      if (resumeDisabled !== undefined) resume.disabled = resumeDisabled;
      if (finishDisabled !== undefined) finishButton.disabled = finishDisabled;
      band.hidden = !paused || ended;
      if (!band.hidden) setText(bandText, pausedBandText(reading));
      return reading;
    },
    /** For screens that drive Pause/Resume availability imperatively. */
    setPauseDisabled(value) { pauseButton.disabled = resume.disabled = value; },
    dispose() { timeControls.dispose(); },
  };
}
