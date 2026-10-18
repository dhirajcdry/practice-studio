// Studio owns the evidence and provenance; the tutor writes only the lesson.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CATALOG_FILE } from '../paths.mjs';
import { enqueueRecall } from './sync.mjs';
export { startRecallSync } from './sync.mjs';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const clip = (value, limit = 600) => String(value ?? '').slice(0, limit);
const safe = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 100;
async function json(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function tail(file, bytes = 24000) {
  let handle;
  try {
    handle = await fsp.open(file, 'r'); const { size } = await handle.stat();
    const start = Math.max(0, size - bytes); const buffer = Buffer.alloc(Math.min(size, bytes));
    await handle.read(buffer, 0, buffer.length, start);
    const value = buffer.toString('utf8'); return start ? value.slice(value.indexOf('\n') + 1) : value;
  } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  finally { await handle?.close(); }
}
const rows = value => value.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
async function names(dir) { try { return (await fsp.readdir(dir)).sort(); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
const stateFile = root => path.join(root, 'recall', 'patterns.json');
const readState = root => json(stateFile(root), { workspaceId: null, patterns: {} });
async function writeState(root, state) {
  await fsp.mkdir(path.dirname(stateFile(root)), { recursive: true });
  const tmp = `${stateFile(root)}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state) + '\n'); await fsp.rename(tmp, stateFile(root));
}
async function problemDigest(root, slug) {
  const dir = path.join(root, 'problems', slug);
  const events = [];
  for (const name of (await names(path.join(dir, 'sessions'))).filter(n => /^[\w.-]+\.jsonl$/.test(n)).slice(-3)) {
    events.push(...rows(await tail(path.join(dir, 'sessions', name))));
  }
  const chats = rows(await tail(path.join(dir, 'chats.jsonl'))).filter(t => t.kind !== 'recall-notes').slice(-3)
    .map(t => ({ at: t.at, ask: clip(t.ask), answer: clip(t.answer, 900) }));
  const runs = events.filter(e => e.type === 'run_result').slice(-3).map(e => ({ at: e.at, data: clip(JSON.stringify(e.data), 1500) }));
  const failures = [];
  for (const name of (await names(path.join(dir, 'submissions'))).filter(n => /^[\w.-]+\.json$/.test(n)).slice(-4)) {
    const s = await json(path.join(dir, 'submissions', name), null);
    if (s?.failure) failures.push({ sourceId: name, at: s.at, failure: clip(JSON.stringify(s.failure), 1000) });
  }
  const snapshots = (await names(path.join(dir, 'attempts'))).filter(n => /^[\w.-]+\.py$/.test(n)).slice(-2);
  const code = [];
  const currentCode = clip(await tail(path.join(dir, 'solution.py'), 1800), 1800);
  for (const name of snapshots) code.push({ sourceId: name, text: clip(await tail(path.join(dir, 'attempts', name), 1800), 1800) });
  const speech = [];
  for (const name of (await names(path.join(dir, 'transcripts'))).filter(n => /^[\w.-]+\.json$/.test(n)).slice(-2)) {
    const transcript = await json(path.join(dir, 'transcripts', name), null);
    speech.push({ sourceId: name, text: transcript?.text ? clip(transcript.text, 800) : null });
  }
  const changes = code.length === 2 ? {
    from: code[0].sourceId, to: code[1].sourceId,
    removed: code[0].text.split('\n').filter(line => !code[1].text.split('\n').includes(line)).slice(0, 12),
    added: code[1].text.split('\n').filter(line => !code[0].text.split('\n').includes(line)).slice(0, 12),
  } : null;
  return { slug, url: `http://127.0.0.1:4173/#/p/${slug}`, attemptIds: [...new Set(events.map(e => e.data?.attemptId).filter(id => typeof id === 'string' && id.length <= 200))].slice(-8),
    runs, failures, chats, code, currentCode, changes, speech, missing: { runs: !runs.length, failingCases: !failures.length && !events.some(e => e.type === 'run_result' && e.data?.failures?.length), chats: !chats.length } };
}
export async function getRecallDigest({ root, slug, patternId } = {}) {
  if (!root || !safe(slug) || (patternId !== undefined && !safe(patternId))) throw Error('Invalid recall problem or pattern id.');
  const state = await readState(root);
  const prior = patternId ? state.patterns[patternId] : null;
  const catalog = await json(CATALOG_FILE, { problems: [] });
  const entry = catalog.problems.find(p => p.leetcodeSlug === slug);
  const slugs = [...new Set([slug, ...Object.keys(prior?.sources ?? {})])];
  const problems = [];
  for (const s of slugs.slice(0, 4)) problems.push(await problemDigest(root, s));
  const evidence = { patternId: patternId ?? null, catalogPattern: entry?.pattern ?? null, problems,
    omittedProblems: Math.max(0, slugs.length - 4), previousSources: Object.values(prior?.sources ?? {}),
    existingPatterns: Object.entries(state.patterns).slice(-60).map(([id, p]) => ({ patternId: id, title: p.title })),
    previousNote: prior ? { title: prior.title, body: clip(prior.body, 3500), intuition: clip(prior.intuition, 700), recall: clip(prior.recall, 700) } : null };
  // Source summaries are retained in storage; bound what crosses the model boundary.
  evidence.previousSources = evidence.previousSources.slice(-20).map(s => ({ slug: s.slug, trap: clip(s.trap, 200), failingCase: clip(s.failingCase, 300) }));
  return { ...evidence, evidenceHash: hash(problems), bounded: true };
}
const locks = new Map();
export function saveRecallNote(args) {
  const previous = locks.get(args.root) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => save(args)); locks.set(args.root, next.catch(() => {})); return next;
}
async function save({ root, slug, patternId, title, body, intuition, recall, trap, failingCase, relatedExternalIds = [] }) {
  if (!safe(patternId) || !safe(slug) || relatedExternalIds.some(id => !safe(id))) throw Error('Invalid pattern id.');
  for (const [name, value, max] of [['title', title, 180], ['body', body, 12000], ['intuition', intuition, 3000], ['recall', recall, 2000], ['trap', trap, 1000], ['failingCase', failingCase, 1500]]) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`Invalid ${name}.`);
  }
  const state = await readState(root); state.workspaceId ??= crypto.randomUUID();
  const digest = await getRecallDigest({ root, slug, patternId });
  const current = digest.problems[0];
  const sources = { ...(state.patterns[patternId]?.sources ?? {}), [slug]: { slug, url: current.url, trap, failingCase, attemptIds: current.attemptIds } };
  const note = { title, body, intuition, recall, sources, relatedExternalIds: [...new Set([...(state.patterns[patternId]?.relatedExternalIds ?? []), ...relatedExternalIds])].filter(id => id !== patternId) };
  state.patterns[patternId] = note;
  const sourceList = Object.values(sources).sort((a, b) => a.slug.localeCompare(b.slug));
  const payload = { schemaVersion: 1, workspaceId: state.workspaceId, externalId: patternId, title,
    body,
    intuition, recall, author: 'tutor', relatedExternalIds: note.relatedExternalIds, sources: sourceList, evidenceHash: digest.evidenceHash };
  if (sourceList.length > 1000 || note.relatedExternalIds.length > 1000) throw Error('This pattern has reached the import limit.');
  payload.revisionId = hash(payload);
  if (Buffer.byteLength(JSON.stringify(payload)) > 8 * 1024 * 1024) throw Error('This pattern exceeds the import size limit.');
  // Save identity/provenance first; retrying after interruption reconstructs the same revision.
  await writeState(root, state);
  return enqueueRecall(root, payload);
}
