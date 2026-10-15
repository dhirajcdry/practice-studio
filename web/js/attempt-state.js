// Persist the identity, not the microphone. A reload must reopen the same window of
// work, while a forgotten tab from yesterday must not capture today's work into it.
export const ATTEMPT_KEY = 'studio.attempt.v1';
export const STALE_ATTEMPT_MS = 6 * 60 * 60 * 1000;

export function resumeDecision(value, now = Date.now()) {
  if (!value || typeof value.attemptId !== 'string' || !value.attemptId
    || typeof value.slug !== 'string' || !value.slug
    || !Number.isFinite(value.startedAt) || value.startedAt > now
    || !Number.isFinite(value.savedMs) || value.savedMs < 0) return 'invalid';
  return now - value.startedAt > STALE_ATTEMPT_MS ? 'stale' : 'resume';
}

export function readAttempt() {
  try { return JSON.parse(localStorage.getItem(ATTEMPT_KEY)); } catch { return null; }
}
export function saveAttempt(value) {
  try {
    if (value) localStorage.setItem(ATTEMPT_KEY, JSON.stringify(value));
    else localStorage.removeItem(ATTEMPT_KEY);
  } catch { /* Storage may be unavailable; keep the live attempt in memory. */ }
}
