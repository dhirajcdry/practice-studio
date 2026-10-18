// Normalize only fields the saved-submission UI renders; discard the raw GraphQL envelope.
const MAX_TEXT = 20 * 1024;
const text = (value) => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : null);
const number = (value) => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
};
const percentile = (value) => {
  const result = number(value);
  return result !== null && result <= 100 ? result : null;
};
// Keep a bounded chart, rejecting malformed buckets rather than inventing measurements.
function points(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(parsed?.distribution)) return [];
  return parsed.distribution.map((point) => {
    if (!Array.isArray(point) || typeof point[0] !== 'string') return null;
    const bucket = number(point[0]);
    const pct = percentile(point[1]);
    return bucket !== null && pct !== null
      ? { bucket, label: point[0].slice(0, 100), pct }
      : null;
  }).filter(Boolean).sort((a, b) => a.bucket - b.bucket).slice(0, 400);
}
function displayNumber(value, pattern) {
  const match = typeof value === 'string' ? pattern.exec(value) : null;
  return match ? Number(match[1]) : null;
}
export function normaliseLeetCodeDetails(raw, fetchedAt = new Date().toISOString()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const runtime = {
    display: text(raw.runtimeDisplay),
    ms: number(raw.runtime) ?? displayNumber(raw.runtimeDisplay, /^\s*([\d.]+)\s*ms\s*$/i),
    percentile: percentile(raw.runtimePercentile),
    distribution: points(raw.runtimeDistribution),
    unit: 'ms',
  };
  const mb = displayNumber(raw.memoryDisplay, /^\s*([\d.]+)\s*MB\s*$/i);
  const memory = {
    display: text(raw.memoryDisplay),
    mb: Number.isFinite(mb) ? mb : null,
    percentile: percentile(raw.memoryPercentile),
    distribution: points(raw.memoryDistribution),
    unit: null,
  };
  // The raw memory number and the display together identify its scale. Only label
  // buckets when they also agree with that scale; a distant or ambiguous histogram
  // keeps its raw labels. The undocumented API must not turn KB into fabricated MB.
  const rawMemory = number(raw.memory);
  const near = (a, b) => a !== null && b !== null && Math.abs(a - b) <= Math.max(0.1, Math.abs(b) * 0.02);
  const agrees = (value) => memory.distribution.some((point) => near(point.bucket, value));
  if (memory.mb !== null && rawMemory !== null) {
    if (near(rawMemory, memory.mb) && agrees(memory.mb)) memory.unit = 'MB';
    else if (near(rawMemory / 1024, memory.mb) && agrees(rawMemory)) memory.unit = 'KB';
    else if (near(rawMemory / 1024, memory.mb) && agrees(memory.mb)) memory.unit = 'MB';
  }
  const result = { runtime, memory, fetchedAt };
  // Persist only failure blocks rendered by the detail view.
  for (const key of ['lastTestcase', 'codeOutput', 'expectedOutput', 'stdOutput', 'compileError', 'runtimeError']) {
    result[key] = text(raw[key]);
  }
  return result;
}
export const normalizeDetails = normaliseLeetCodeDetails;
export const DETAILS_MAX = MAX_TEXT;
