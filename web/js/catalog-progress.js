// Read-only progress helpers for the catalog. A status is only shown when it came
// from the server's workspace evidence; this module never infers progress from a
// catalog entry or from a missing record.

const LABELS = Object.freeze({
  accepted: 'Accepted',
  'local-pass': 'Passed locally',
  attempted: 'In progress',
  'notes-only': 'Notes saved',
  empty: 'Not started',
  unknown: 'Progress unavailable',
});

export function summarizeProgress(problems = [], progressMap = null) {
  const total = Array.isArray(problems) ? problems.length : 0;
  let accepted = 0, localPass = 0, attempted = 0;
  for (const problem of problems || []) {
    const progress = progressMap?.get?.(problem.slug);
    if (!progress) continue;
    if (progress.status === 'accepted') accepted += 1;
    else if (progress.status === 'local-pass') localPass += 1;
    else if (progress.status === 'attempted') attempted += 1;
  }
  return { accepted, localPass, attempted, total, touched: accepted + localPass + attempted };
}

export function progressFor(slug, progressMap) {
  const record = progressMap?.get?.(slug);
  if (!progressMap || typeof progressMap.get !== 'function') return { status: 'unknown', label: LABELS.unknown };
  const status = record?.status || 'empty';
  return { status, label: LABELS[status] || LABELS.unknown };
}

/** Accepted / total for each difficulty, in the order given, from the same evidence. */
export function summarizeByDifficulty(problems = [], progressMap = null, difficulties = ['Easy', 'Medium', 'Hard']) {
  return difficulties.map((difficulty) => {
    const items = (problems || []).filter(problem => problem.difficulty === difficulty);
    return { difficulty, ...summarizeProgress(items, progressMap) };
  });
}

/** The /api/stats payload's per-problem records, keyed by slug. Throws on a bad shape. */
export function progressMapFrom(data) {
  if (!Array.isArray(data?.problems)) throw new Error('Progress response did not contain a problems array');
  return new Map(data.problems.filter(problem => problem && typeof problem.slug === 'string')
    .map(problem => [problem.slug, problem]));
}

export async function loadCatalogProgress({ signal } = {}) {
  const response = await fetch('/api/stats', { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Progress request failed (${response.status})`);
  return progressMapFrom(await response.json());
}
