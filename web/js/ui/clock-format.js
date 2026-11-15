/**
 * The one clock format for every timed screen (mock countdowns, overtime, practice
 * timers): "45:00", "05:00", then "1:02:34" from an hour on, so a long reading never
 * becomes a four- or five-digit minute count. `pad: false` drops the leading zero for
 * prose ("5:00 left").
 */
export function formatClock(ms, { pad = true } = {}) {
  const seconds = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  const two = n => String(n).padStart(2, '0');
  if (hours) return `${hours}:${two(minutes)}:${two(seconds % 60)}`;
  return `${pad ? two(minutes) : minutes}:${two(seconds % 60)}`;
}
