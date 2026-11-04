import { withMemoryLock } from '../coach/memory.mjs';
// Problem-level learning material. NOTES is additive user-requested content;
// LEARNING is regenerated from immutable interview records, never used as raw evidence.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError, sendJson } from '../http-util.mjs';
import { readJsonBody } from '../coach/http.mjs';
import { InterviewStore, validId } from '../interview/store.mjs';
import { buildReport, reportMarkdown } from '../interview/report.mjs';
import { DesignStore } from '../design/store.mjs';
import { buildDesignReport } from '../design/report.mjs';
import { topicFor } from '../design/topics.mjs';
import { HOME_ROOT } from '../paths.mjs';
import { problemDir } from '../storage-layout.mjs';
function topicDir(root, slug) {
  if (typeof slug !== 'string' || !/^(?:lld|design)-[a-z0-9-]{1,100}$/.test(slug)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid learning topic.');
  return problemDir(root, slug);
}
export async function readLearningNotes(root, slug) {
  if (!/^(?:lld|design)-/.test(slug || '')) return '';
  try { return (await fs.readFile(path.join(topicDir(root, slug), 'NOTES.md'), 'utf8')).slice(-30000); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
// Stored assessments inform what to probe next; they are never substituted for evidence.
export async function readLearningContext(root, slug) {
  const notes = await readLearningNotes(root, slug);
  if (!/^(?:lld|design)-/.test(slug || '')) return notes;
  let summary = '';
  try { summary = (await fs.readFile(path.join(topicDir(root, slug), 'LEARNING.md'), 'utf8')).slice(0, 24000); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return [notes && `Learner-saved notes:\n${notes}`, summary && `Previous recorded assessments (model judgments, not verified outcomes):\n${summary}`].filter(Boolean).join('\n\n');
}
async function learningRecords(root, slug) {
  topicDir(root, slug);
  const records = [];
  if (slug.startsWith('lld-')) {
    const store = new InterviewStore({ root });
    for (const id of await store.list(slug)) {
      if (!validId(id)) continue;
      const state = await store.readState(slug, id), turns = await store.readTurns(slug, id);
      if (state) records.push({ id, state, turns, report: buildReport(state, turns) });
    }
  } else {
    const store = new DesignStore({ root });
    for (const id of await store.list()) {
      const state = await store.readState(id);
      if (!state || (state.topicSlug || topicFor(state.prompt).slug) !== slug) continue;
      const turns = await store.readTurns(id);
      records.push({ id, state, turns, report: buildDesignReport(state, turns) });
    }
  }
  records.sort((a, b) => b.id.localeCompare(a.id));
  return records;
}
export async function learningSummary(root, slug) {
  const records = await learningRecords(root, slug);
  const lines = [`# Learning record — ${slug}`, '', 'Derived from recorded interviews. Assessments below are model judgments, not verified hiring decisions.', '', `${records.length} recorded interview(s).`, ''];
  for (const { id, report, turns } of records) {
    lines.push(`## ${id}`, '');
    if (!report) lines.push('No completed debrief recorded.', '');
    else lines.push(reportMarkdown(report) || turns.findLast(t => t.kind === 'debrief')?.asked || 'No written feedback.', '');
  }
  return lines.join('\n');
}
export async function refreshLearning(root, slug) {
  const dir = topicDir(root, slug); await fs.mkdir(dir, { recursive: true });
  const text = await learningSummary(root, slug), file = path.join(dir, 'LEARNING.md'), tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, text); await fs.rename(tmp, file); } finally { await fs.rm(tmp, { force: true }); }
  return text;
}
export const routes = {
  'GET /api/learning/:slug': async (_req, res, ctx) => {
    const root = ctx.homeRoot || HOME_ROOT, slug = ctx.params.slug;
    const records = (await learningRecords(root, slug)).map(({ id, state, report, turns }) => ({
      id, date: state.startedAt, completed: Boolean(state.debriefed),
      signal: report?.judgement?.signal || null, headline: report?.judgement?.headline || null,
      markdown: (report && reportMarkdown(report)) || turns.findLast(t => t.kind === 'debrief')?.asked || 'No completed debrief recorded.',
    }));
    return sendJson(res, 200, { notes: await readLearningNotes(root, slug), summary: await learningSummary(root, slug), records });
  },
  'POST /api/learning/:slug/note': async (req, res, ctx) => {
    const root = ctx.homeRoot || HOME_ROOT, slug = ctx.params.slug, dir = topicDir(root, slug), body = await readJsonBody(req);
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 12000) throw new HttpError(400, 'BAD_REQUEST', 'A learning note must contain 1–12000 characters.');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'NOTES.md');
    await withMemoryLock(file, () => fs.appendFile(file, `\n## Saved ${new Date().toISOString()}\n\n${body.text.trim()}\n`));
    return sendJson(res, 200, { saved: true });
  },
};
