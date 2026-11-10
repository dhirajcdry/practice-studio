// A practice branch captures a point in a mock's history. It never rewrites that
// history, and never trusts client-supplied code or feedback as source evidence.
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../http-util.mjs';
import { InterviewStore, validId } from '../interview/store.mjs';
import { DesignStore, isSafeInterviewId } from '../design/store.mjs';
import { topicFor } from '../design/topics.mjs';
import { buildReport, reportMarkdown } from '../interview/report.mjs';
import { buildDesignReport } from '../design/report.mjs';
import { excerpt, selectRecords } from '../coach/context-policy.mjs';

const bad = message => new HttpError(400, 'BAD_REQUEST', message);
const missing = () => new HttpError(404, 'NOT_FOUND', 'Source mock interview not found.');
async function read(file, fallback) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function turnsAt(directory) {
  // A corrupt record must not turn into a misleading, apparently complete branch.
  return (await read(path.join(directory, 'turns.jsonl'), '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
export async function resolvePracticeSource(root, { discipline, slug, source }) {
  const interviewId = typeof source === 'string' ? source : source?.interviewId;
  if (!source || (typeof source !== 'string' && (typeof source !== 'object' || Array.isArray(source)))) throw bad('Invalid source interview.');
  if (source.discipline && source.discipline !== discipline) throw bad('Source discipline does not match.');
  let state, turns, work, title, statement, report;
  if (discipline === 'lld') {
    if (typeof slug !== 'string' || !/^lld-[a-z0-9][a-z0-9-]{0,84}$/.test(slug) || !validId(interviewId)) throw bad('Invalid source LLD interview.');
    const store = new InterviewStore({ root });
    state = await store.readState(slug, interviewId);
    if (!state) throw missing();
    if (state.discipline !== 'lld' || state.slug !== slug) throw bad('Source mock does not match this problem.');
    turns = await turnsAt(store.dir(slug, interviewId));
    title = state.title || state.scenario?.title || slug;
    statement = state.scenario?.statement || state.statement || turns.find(t => t.kind === 'opening')?.asked || title;
    const saved = await read(path.join(store.dir(slug, interviewId), 'code.py'), null);
    const code = state.debriefed ? (state.lastCode ?? saved ?? '') : (saved ?? state.lastCode ?? '');
    work = { code };
    report = buildReport(state, turns);
  } else if (discipline === 'design') {
    if (!isSafeInterviewId(interviewId)) throw bad('Invalid source system-design interview.');
    const store = new DesignStore({ root }), directory = store.dir(interviewId);
    const raw = await read(path.join(directory, 'interview.json'), null);
    if (raw === null) throw missing();
    state = JSON.parse(raw);
    const topic = topicFor(state.prompt);
    const actualSlug = state.topicSlug || topic.slug;
    if (slug && slug !== actualSlug) throw bad('Source mock does not match this problem.');
    slug = actualSlug;
    title = state.problem?.title || topic.title;
    statement = state.prompt || state.problem?.statement || title;
    turns = await turnsAt(directory);
    let names;
    try { names = (await fs.readdir(path.join(directory, 'scenes'))).filter(n => /^\d+\.json$/.test(n)).sort((a, b) => parseInt(a) - parseInt(b)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
    const last = names.at(-1);
    const elements = last ? JSON.parse(await fs.readFile(path.join(directory, 'scenes', last), 'utf8')).elements : [];
    work = { elements };
    report = buildDesignReport(state, turns);
  } else throw bad('Choose an LLD or system design discipline.');
  const provenance = { discipline, slug, interviewId, title, startedAt: state.startedAt ?? null,
    completed: Boolean(state.debriefed || state.endedAt), targetLevel: state.targetLevel || state.level || null, ...(state.reportDifficulty ? { reportDifficulty: state.reportDifficulty } : {}), capturedAt: new Date().toISOString() };
  // Keep conversational evidence once. Code buffers, provider chunks and all prior
  // canvas snapshots remain in the original record rather than multiplying per fork.
  const conversation = turns.filter(t => t.said || t.asked).map(({ kind, elapsedMs, phase, said, asked }) => ({ kind, elapsedMs, phase, said, asked }));
  const feedback = (report && reportMarkdown(report)) || turns.findLast(t => t.kind === 'debrief')?.asked || '';
  return { slug, title, statement, work, snapshot: { schemaVersion: 1, source: provenance,
    problem: { title, statement }, ...work, feedback, report, turns: conversation } };
}

export function sourceCoachContext(snapshot, {query=''}={}) {
  if (!snapshot) return null;
  const turns = snapshot.turns || [];
  const selected=selectRecords(turns,{budget:8000,query,head:3,tail:3});
  return { source: snapshot.source, problem: snapshot.problem, feedback: excerpt(snapshot.feedback || 'No mock feedback was recorded.',6000,query),
    originalWorkspace: {resource:'source_mock',note:'Retrieve this resource to compare the original code/board. Current editable work is supplied separately.'},
    transcript: selected.records, transcriptTruncated:selected.omittedRecords>0, totalTranscriptTurns: turns.length, includedTranscriptTurns:selected.includedRecords };
}
