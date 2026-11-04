// The interview report: facts the server measures from the raw record, plus the
// interviewer's structured judgement. Derived on read, never stored, so a parsing or
// rendering fix costs nothing but a reload.
import { clock, elapsed, phaseTimes, PHASES } from './state.mjs';

export const RATINGS = ['Strong', 'Solid', 'Mixed', 'Weak'];
export const SIGNALS = ['Strong hire', 'Hire', 'Lean hire', 'Lean no', 'No hire'];
export const DIMENSIONS = ['Problem solving', 'Coding', 'Communication', 'Testing'];
export const LLD_DIMENSIONS = ['Requirements', 'Responsibilities', 'Interfaces', 'State modeling', 'Correctness', 'Edge cases', 'Self-verification', 'Extensibility', 'Communication'];
export const DESIGN_DIMENSIONS = ['Requirements', 'Estimation', 'Data modeling', 'Architecture', 'Trade-offs', 'Reliability', 'Communication'];
const words = text => (String(text || '').match(/[\p{L}\p{N}']+/gu) || []).length;
const normal = text => String(text || '').toLowerCase().replace(/[“”"'‘’.,!?;:()\-—–]/g, ' ').replace(/\s+/g, ' ').trim();

/** Everything here is counted from turns.jsonl and interview.json; nothing is model-written. */
export function reportFacts(state, turns, now = Date.now()) {
  const said = turns.filter(t => t.said), asked = turns.filter(t => t.asked && ['opening', 'turn', 'event'].includes(t.kind || t.replyKind));
  const candidateWords = said.reduce((n, t) => n + words(t.said), 0);
  const interviewerWords = asked.reduce((n, t) => n + words(t.asked), 0);
  const runs = [], verdicts = [];
  for (const t of turns) {
    if (t.kind !== 'event' || !t.event) continue;
    const at = t.elapsedMs ?? 0;
    if (t.event.type === 'run_result') {
      const failed = Number(t.event.failed) || 0;
      runs.push({ at, passed: !t.event.error && failed === 0, failed, total: Number(t.event.total) || null, error: Boolean(t.event.error) });
    } else if (t.event.type === 'verdict') verdicts.push({ at, status: t.event.status || null, label: t.event.verdict || t.event.status || 'Submitted', accepted: Boolean(t.event.accepted) });
  }
  const buffers = turns.filter(t => t.kind === 'buffer' && typeof t.code === 'string');
  const times = phaseTimes(state, now);
  return {
    durationMs: elapsed(state, now),
    plannedMs: (state.minutes || 45) * 60000,
    mode: state.mode,
    startedAt: state.startedAt,
    phases: PHASES.map(phase => ({ phase, ms: Math.max(0, times[phase] || 0) })),
    hints: (state.hints || []).map(h => ({ level: h.level, at: h.elapsedMs, phase: h.phase })),
    runs, verdicts,
    candidateTurns: said.length,
    candidateWords, interviewerWords,
    talkShare: candidateWords + interviewerWords ? candidateWords / (candidateWords + interviewerWords) : null,
    firstRunAt: runs[0]?.at ?? null,
    finalCode: buffers.at(-1)?.code ?? state.lastCode ?? null,
  };
}

function json(text) {
  const fenced = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : String(text || '');
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}
const str = (value, max = 600) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const list = (value, max) => Array.isArray(value) ? value.slice(0, max) : [];
const at = value => {
  const match = String(value ?? '').match(/^(\d{1,3}):(\d{2})$/);
  return match && Number(match[2]) < 60 ? (Number(match[1]) * 60 + Number(match[2])) * 1000 : null;
};
const pick = (value, allowed) => allowed.find(option => option.toLowerCase() === String(value || '').trim().toLowerCase()) || null;

/**
 * Validate the interviewer's JSON against the record. A quote counts as verified only
 * if the candidate actually said it; anything else is kept as the interviewer's
 * observation, never shown in quote marks.
 */
export function parseReport(text, turns = [], { dimensions: rubric = DIMENSIONS, durationMs = Infinity } = {}) {
  const raw = json(text);
  if (!raw || typeof raw !== 'object') return null;
  const spoken = turns.filter(t => typeof t.said === 'string');
  const checkedTime = value => { const ms = at(value); return ms !== null && ms <= durationMs ? ms : null; };
  const evidence = item => {
    const quote = str(item?.quote, 300), note = str(item?.note, 300);
    const source = quote && spoken.find(turn => turn.said.includes(quote));
    const verified = Boolean(source);
    if (!quote && !note) return null;
    return { at: verified && Number.isFinite(source.elapsedMs) ? source.elapsedMs : checkedTime(item?.at), quote: verified ? quote : null, note: note || (verified ? null : quote), provenance: verified ? 'quote' : 'interpretation' };
  };
  const dimensions = rubric.map(name => {
    const found = list(raw.dimensions, 12).find(d => normal(d?.name) === normal(name));
    const items = list(found?.evidence, 3).map(evidence).filter(Boolean);
    return { name, rating: items.length ? pick(found?.rating, RATINGS) : null, summary: str(found?.summary, 400), evidence: items };
  });
  const moment = item => {
    const text = str(item?.text, 240);
    return text && checkedTime(item?.at) !== null ? { at: checkedTime(item?.at), kind: pick(item?.kind, ['insight', 'stuck', 'hint', 'bug', 'fix', 'test', 'verdict']) || 'insight', text } : null;
  };
  return {
    technicalErrors: list(raw.technicalErrors, 12).map(x => str(x, 1000)).filter(Boolean),
    missingConsiderations: list(raw.missingConsiderations, 12).map(x => str(x, 800)).filter(Boolean),
    discoveries: list(raw.discoveries, 12).map(x => str(x, 800)).filter(Boolean),
    signal: pick(raw.signal ?? raw.hireSignal, SIGNALS),
    headline: str(raw.headline, 200),
    summary: str(raw.summary, 600),
    dimensions,
    strengths: list(raw.strengths, 4).map(s => str(s, 300)).filter(Boolean),
    improvements: list(raw.improvements, 4).map(s => str(s, 300)).filter(Boolean),
    moments: list(raw.moments, 8).map(moment).filter(Boolean).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
    code: raw.code && typeof raw.code === 'object' ? {
      complexity: str(raw.code.complexity, 120), optimal: str(raw.code.optimal, 120),
      notes: list(raw.code.notes, 4).map(s => str(s, 300)).filter(Boolean),
    } : null,
    practice: list(raw.practice, 3).map(p => typeof p === 'string' ? { title: str(p, 160), why: null }
      : { title: str(p?.title, 160), why: str(p?.why, 300) }).filter(p => p.title),
  };
}

export function buildReport(state, turns, now = Date.now()) {
  const debrief = [...turns].reverse().find(t => t.kind === 'debrief');
  if (!state.debriefed || !debrief) return null;
  const facts = reportFacts(state, turns, now);
  return { facts, judgement: parseReport(debrief.asked, turns, { durationMs: facts.durationMs, dimensions: state.discipline === 'lld' ? LLD_DIMENSIONS : DIMENSIONS }) };
}

/** Markdown for interview.md, so the mirrored record reads well outside Studio. */
export function reportMarkdown(report) {
  const { facts, judgement: j } = report;
  if (!j) return null;
  const lines = [`**${j.signal || 'No signal'}**${j.headline ? ` — ${j.headline}` : ''}`, ''];
  if (j.summary) lines.push(j.summary, '');
  lines.push(Object.hasOwn(facts, 'finalBoard')
    ? `Duration ${clock(facts.durationMs)} of ${clock(facts.plannedMs)} · ${facts.finalBoard ? 'Board recorded' : 'The board was empty'} · phase durations and hint counts not recorded`
    : `Duration ${clock(facts.durationMs)} of ${clock(facts.plannedMs)} · ${facts.hints.length} hints · ${facts.runs.length} runs · ${facts.verdicts.length} submissions`, '');
  for (const d of j.dimensions) {
    lines.push(`### ${d.name} — ${d.rating || 'Not rated'}`, '');
    if (d.summary) lines.push(d.summary, '');
    for (const e of d.evidence) lines.push(`- ${e.at === null ? '' : clock(e.at) + ' '}${e.quote ? `“${e.quote}”` : ''}${e.quote && e.note ? ' — ' : ''}${e.note || ''}`);
    if (!d.evidence.length) lines.push('- No evidence recorded.');
    lines.push('');
  }
  for (const [title, items] of [['Hard technical errors', j.technicalErrors], ['Missing considerations', j.missingConsiderations], ['Self-caught vs interviewer-surfaced', j.discoveries]]) {
    if (items?.length) lines.push(`### ${title}`, '', ...items.map(item => `- ${item}`), '');
  }
  if (j.strengths.length) lines.push('### What went well', '', ...j.strengths.map(s => `- ${s}`), '');
  if (j.improvements.length) lines.push('### What to improve', '', ...j.improvements.map(s => `- ${s}`), '');
  if (j.practice.length) lines.push('### Practise next', '', ...j.practice.map((p, i) => `${i + 1}. ${p.title}${p.why ? ` — ${p.why}` : ''}`), '');
  return lines.join('\n');
}
