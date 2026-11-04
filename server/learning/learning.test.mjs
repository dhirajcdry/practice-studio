import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesignStore } from '../design/store.mjs';
import { buildDesignReport } from '../design/report.mjs';
import { refreshLearning, readLearningNotes, learningSummary, routes } from './index.mjs';
import { Readable } from 'node:stream';
import { problemDir } from '../storage-layout.mjs';

test('topic folders retain separate interviews and legacy records without rewriting evidence', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-learning-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DesignStore({ root }), legacy = '2026-10-30T10-00-00-000Z', fresh = '2026-10-31T10-00-00-000Z';
  const state = { prompt: 'Design a URL-shortening service.', startedAt: 1000, endedAt: 61000, minutes: 45, debriefed: true };
  await store.create(legacy, state); await store.appendTurn(legacy, { kind: 'debrief', asked: 'Legacy feedback.' });
  await store.create(fresh, { ...state, topicSlug: 'design-url-shortener' });
  await store.appendTurn(fresh, { kind: 'turn', said: 'I will use a durable mapping.' });
  await store.appendTurn(fresh, { kind: 'debrief', asked: JSON.stringify({ signal: 'Hire', dimensions: [{ name: 'Reliability', rating: 'Solid', evidence: [{ quote: 'I will use a durable mapping.' }] }] }) });
  assert.equal(store.dir(fresh), path.join(problemDir(root, 'design-url-shortener'), 'interviews', fresh));
  assert.equal(store.dir(legacy), path.join(root, 'design', legacy));
  const before = await fs.readFile(path.join(store.dir(fresh), 'turns.jsonl'), 'utf8');
  const summary = await refreshLearning(root, 'design-url-shortener');
  assert.match(summary, /2 recorded interview/); assert.match(summary, /Legacy feedback/); assert.match(summary, /Reliability/);
  assert.equal(await fs.readFile(path.join(store.dir(fresh), 'turns.jsonl'), 'utf8'), before);
  assert.deepEqual(await new DesignStore({ root }).list(), [legacy, fresh]);
  assert.equal((await new DesignStore({ root }).readState(fresh)).topicSlug, 'design-url-shortener');
  const notes = path.join(problemDir(root, 'design-url-shortener'), 'NOTES.md'); await fs.writeFile(notes, 'My own observation.');
  await refreshLearning(root, 'design-url-shortener'); assert.equal(await readLearningNotes(root, 'design-url-shortener'), 'My own observation.');
  const req = Readable.from([Buffer.from(JSON.stringify({ text: 'Next time trace a failed write.' }))]);
  await routes['POST /api/learning/:slug/note'](req, { writeHead(){}, end(){} }, { homeRoot: root, params: { slug: 'design-url-shortener' } });
  assert.match(await readLearningNotes(root, 'design-url-shortener'), /My own observation\.[\s\S]*Next time/);
  await assert.rejects(learningSummary(root, '../escape'), /Invalid learning topic/);
});

test('legacy design reports do not manufacture timing, code, or phase accounting', () => {
  const report = buildDesignReport({ debriefed: true, startedAt: 1000, endedAt: 61000, minutes: 45, graph: { nodes: [], edges: [], notes: [], unattached: 0 } }, [{ kind: 'turn', said: 'A queue.' }, { kind: 'debrief', asked: '{"dimensions":[{"name":"Architecture","rating":"Strong","evidence":[]}]}' }]);
  assert.equal(report.facts.finalBoard, null); assert.deepEqual(report.facts.phases, []); assert.equal(report.facts.finalCode, null); assert.equal(report.judgement.dimensions.find(d => d.name === 'Architecture').rating, null);
});
