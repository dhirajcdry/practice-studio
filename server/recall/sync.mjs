// One durable payload per tutor revision. Delivery never invokes a model.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const locks = new Map();
const file = (root, name) => path.join(root, 'recall', name);
async function read(name, fallback) {
  try { return JSON.parse(await fsp.readFile(name, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function atomic(name, value) {
  await fsp.mkdir(path.dirname(name), { recursive: true });
  const temp = `${name}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value) + '\n'); await fsp.rename(temp, name);
}
function serial(root, fn) {
  const next = (locks.get(root) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(root, next.catch(() => {})); return next;
}
export function validRecallUrl(raw) {
  try { const u = new URL(raw); return u.protocol === 'http:' && u.hostname === '127.0.0.1'
    && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/api/recall/import'; }
  catch { return false; }
}
export async function readRecallState(root) {
  return { outbox: await read(file(root, 'outbox.json'), { items: [] }), mapping: await read(file(root, 'mapping.json'), {}) };
}
const receipt = item => ({ status: item.status, externalId: item.payload.externalId, revisionId: item.payload.revisionId,
  ...(item.status === 'saved' ? { noteId: item.response.noteId, url: item.response.url, conflict: item.response.status === 'conflict' } : {}) });
async function deliver(root, box, item, fetchImpl) {
  if (item.status === 'saved') return receipt(item);
  const endpoint = process.env.STUDYCRAFT_RECALL_URL || 'http://127.0.0.1:4317/api/recall/import';
  const token = process.env.STUDYCRAFT_RECALL_TOKEN;
  if (!token || !validRecallUrl(endpoint)) return receipt(item);
  item.attempts++;
  try {
    const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(item.payload) });
    const text = await response.text();
    if (text.length > 16000) throw Error('Oversized response');
    const result = JSON.parse(text);
    const noteUrl = new URL(result.url);
    if (!response.ok || !['created', 'updated', 'unchanged', 'conflict'].includes(result.status)
      || typeof result.noteId !== 'string' || !result.noteId || result.noteId.length > 200
      || result.externalId !== item.payload.externalId || result.evidenceHash !== item.payload.evidenceHash
      || result.revisionId !== item.payload.revisionId || noteUrl.origin !== new URL(endpoint).origin
      || noteUrl.username || noteUrl.password) throw Error('Unconfirmed delivery');
    const mapping = await read(file(root, 'mapping.json'), {});
    if (mapping[item.payload.externalId] && mapping[item.payload.externalId].noteId !== result.noteId) {
      throw Error('Pattern identity changed');
    }
    item.status = 'saved'; item.response = result;
    // Map first: if interrupted, the pending payload retries with the same revision id.
    mapping[item.payload.externalId] = { noteId: result.noteId, url: result.url, revisionId: result.revisionId };
    await atomic(file(root, 'mapping.json'), mapping);
  } catch { item.status = 'pending'; }
  item.nextAttemptAt = Date.now() + Math.min(300000, 30000 * 2 ** Math.min(item.attempts - 1, 4));
  await atomic(file(root, 'outbox.json'), box);
  return receipt(item);
}
export function enqueueRecall(root, payload, { fetchImpl = globalThis.fetch } = {}) {
  return serial(root, async () => {
    const box = await read(file(root, 'outbox.json'), { items: [] });
    let item = box.items.find(x => x.payload.revisionId === payload.revisionId);
    if (!item) {
      item = { payload, status: 'pending', attempts: 0, queuedAt: new Date().toISOString(), nextAttemptAt: 0 };
      box.items.push(item); await atomic(file(root, 'outbox.json'), box);
    }
    // Deliver revisions in order, including older offline generations of this pattern.
    for (const older of box.items) {
      if (older === item) break;
      if (older.payload.externalId === payload.externalId && older.status !== 'saved') {
        await deliver(root, box, older, fetchImpl);
        if (older.status !== 'saved') return receipt(item);
      }
    }
    return deliver(root, box, item, fetchImpl);
  });
}
export function flushRecall(root, { fetchImpl = globalThis.fetch, force = false } = {}) {
  return serial(root, async () => {
    const box = await read(file(root, 'outbox.json'), { items: [] });
    const blocked = new Set(), results = [];
    for (const item of box.items) {
      if (item.status === 'saved') continue;
      const id = item.payload.externalId;
      if (blocked.has(id)) continue;
      if (!force && item.nextAttemptAt > Date.now()) { blocked.add(id); continue; }
      results.push(await deliver(root, box, item, fetchImpl));
      if (item.status !== 'saved') blocked.add(id);
    }
    return results;
  });
}
export function startRecallSync({ root, intervalMs = 30000 } = {}) {
  const timer = setInterval(() => flushRecall(root).catch(() => {}), Math.max(1000, intervalMs));
  timer.unref(); void flushRecall(root).catch(() => {});
  return () => clearInterval(timer);
}
