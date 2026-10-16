// The practice streak: consecutive days with any practice in them, read from the
// `activity` days /api/stats already reports. Shared by the catalog overview, the top
// bar pill and the celebration toast, so all three always agree.
//
// A day counts when it has a run, a submission or a logged event. Today not having one
// YET does not break the streak — it only breaks once a whole day passes without any.
// Activity dates come from each stamp's own prefix, and attempt files are stamped in
// UTC, so a late-evening run can land on "tomorrow"; a date after today counts as today.

/** YYYY-MM-DD of a Date in local time. */
export function localDay(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function shift(day, by) {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(new Date(y, m - 1, d + by));
}

/**
 * @param {Array<{date:string, events?:number, attempts?:number}>} activity
 * @param {Date} [now]
 * @returns {{current:number, best:number, activeToday:boolean, days:Set<string>, today:string}}
 */
export function computeStreak(activity = [], now = new Date()) {
  const today = localDay(now);
  const days = new Set();
  for (const entry of Array.isArray(activity) ? activity : []) {
    if (!entry || typeof entry.date !== 'string') continue;
    if (!((entry.events || 0) > 0 || (entry.attempts || 0) > 0)) continue;
    days.add(entry.date > today ? today : entry.date);
  }

  const activeToday = days.has(today);
  let current = 0;
  for (let day = activeToday ? today : shift(today, -1); days.has(day); day = shift(day, -1)) current += 1;

  let best = 0;
  for (const day of days) {
    if (days.has(shift(day, -1))) continue;   // only count runs from their first day
    let length = 0;
    for (let d = day; days.has(d); d = shift(d, 1)) length += 1;
    best = Math.max(best, length);
  }
  return { current, best, activeToday, days, today };
}

/** The last `count` local days, oldest first, each marked active or not. */
export function recentDays(streak, count = 14) {
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const day = shift(streak.today, -i);
    out.push({ day, active: streak.days.has(day) });
  }
  return out;
}

let cached = null;

/** One /api/stats read shared by everyone who asks within the same moment. */
export function loadStats({ fresh = false } = {}) {
  if (!fresh && cached) return cached;
  cached = fetch('/api/stats', { headers: { accept: 'application/json' } })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  return cached;
}

/** Fired after anything that can change the numbers, e.g. an accepted submission. */
export function announceStatsChanged() {
  cached = null;
  window.dispatchEvent(new CustomEvent('studio:stats-changed'));
}
