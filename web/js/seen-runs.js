// Server retention is longer than a panel's lifetime. Remember acknowledgement by
// server identity so remounting cannot turn an already-read answer into new mail.
export const SEEN_RUNS_KEY = 'studio.coach.seenRuns.v1';
export function createSeenRuns(storage) {
  let ids = [];
  try {
    const saved = JSON.parse(storage.getItem(SEEN_RUNS_KEY));
    if (Array.isArray(saved)) ids = [...new Set(saved.filter(id => typeof id === 'string'))].slice(-100);
  } catch { /* unavailable or invalid storage */ }
  return {
    has: id => ids.includes(id),
    remember(id) {
      if (!id) return;
      ids = [...ids.filter(old => old !== id), id].slice(-100);
      try { storage.setItem(SEEN_RUNS_KEY, JSON.stringify(ids)); } catch { /* keep memory */ }
    },
  };
}
