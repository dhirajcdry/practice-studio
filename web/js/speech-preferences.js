// Voice preferences belong to this browser, not the practice archive.
export const NATURAL_VOICES = [
  ['af_heart', 'Heart · American'], ['af_bella', 'Bella · American'],
  ['am_michael', 'Michael · American'], ['am_fenrir', 'Fenrir · American'],
  ['bf_emma', 'Emma · British'], ['bm_george', 'George · British'],
];
const KEY = 'studio.voice.v1';
export function voicePreferences() {
  let value = {};
  try { value = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* defaults */ }
  return {
    engine: value.engine === 'system' ? 'system' : 'natural',
    voice: NATURAL_VOICES.some(([id]) => id === value.voice) ? value.voice : 'af_heart',
    speed: Number.isFinite(value.speed) && value.speed >= 0.5 && value.speed <= 2 ? value.speed : 1,
  };
}
export function saveVoicePreferences(patch) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...voicePreferences(), ...patch })); } catch { /* this browser cannot remember */ }
}
