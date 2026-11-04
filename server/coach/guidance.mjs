import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { workspacePath } from '../storage-layout.mjs';
import { HttpError } from '../http-util.mjs';
import { withMemoryLock } from './memory.mjs';

export const GUIDANCE_SCOPES = Object.freeze(['all', 'coding', 'lld', 'design']);
export const GUIDANCE_MODES = Object.freeze(['all', 'practice', 'mock', 'review']);
const MAX_RULES = 40, MAX_TEXT = 2000, MAX_TOTAL = 16000;
const fileFor = root => workspacePath(root, path.join(root, 'shared', 'coaching-instructions.json'));
const fail = (message) => { throw new HttpError(400, 'invalid_guidance', message); };
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b]) => a.localeCompare(b))) : item);
function validRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail('rule must be an object.');
  const allowed = new Set(['id','scope','mode','text','enabled']);
  if (Object.keys(rule).some(k => !allowed.has(k))) fail('Unknown rule field.');
  for (const k of ['id','scope','mode','text','enabled']) if (!(k in rule)) fail(`Missing rule field: ${k}.`);
  if ('id' in rule && (typeof rule.id !== 'string' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(rule.id) || rule.id.length > 80)) fail('Invalid rule id.');
  if ('scope' in rule && !GUIDANCE_SCOPES.includes(rule.scope)) fail('Invalid rule scope.');
  if ('mode' in rule && !GUIDANCE_MODES.includes(rule.mode)) fail('Invalid rule mode.');
  if ('text' in rule && (typeof rule.text !== 'string' || rule.text.length > MAX_TEXT || !rule.text.trim())) fail('Invalid rule text.');
  if ('enabled' in rule && typeof rule.enabled !== 'boolean') fail('Invalid rule enabled flag.');
}
function checkRules(rules) {
  if (!Array.isArray(rules) || rules.length > MAX_RULES) fail('Too many guidance rules.');
  const ids = new Set(); let total = 0;
  for (const r of rules) { validRule(r); if (ids.has(r.id)) fail('Duplicate rule id.'); ids.add(r.id); if (r.enabled) total += r.text.length; }
  if (total > MAX_TOTAL) fail('Active guidance text is too large.');
}
async function load(file) {
  let state;
  try { state = JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { revision: 0, rules: [], history: [] }; throw error; }
  if (!state || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.history) || state.history.length !== state.revision) fail('Guidance store is corrupt.');
  checkRules(state.rules);
  const mutations = new Set();
  for (const [index, entry] of state.history.entries()) {
    if (entry.revision !== index + 1 || !entry._payload || mutations.has(entry.mutationId)) fail('Guidance history is corrupt.');
    mutations.add(entry.mutationId);
    checkRules(entry.before); checkRules(entry.after);
    if (canonical(entry.before) !== canonical(index ? state.history[index - 1].after : [])) fail('Guidance history is inconsistent.');
  }
  if (canonical(state.rules) !== canonical(state.history.at(-1)?.after || [])) fail('Guidance history is inconsistent.');
  return state;
}
async function save(file, state) { await fsp.mkdir(path.dirname(file), { recursive: true, mode:0o700 }); const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; try { await fsp.writeFile(tmp, JSON.stringify(state, null, 2), { mode:0o600 }); await fsp.rename(tmp, file); } finally { await fsp.rm(tmp, { force:true }).catch(()=>{}); } }
const mutationData = ({ expectedRevision, mutationId, operation, rule, ruleId, restoreRevision, reason, source }) => ({ expectedRevision, mutationId, operation, rule: rule || null, ruleId: ruleId || null, restoreRevision: restoreRevision ?? null, reason, source });


export async function readGuidance(root, { offset = 0, limit = 20 } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('Invalid page.');
  const s = await load(fileFor(root)); const history = [...s.history].reverse();
  return { revision: s.revision, rules: clone(s.rules), history: clone(history.slice(offset, offset + limit)), nextOffset: offset + limit < history.length ? offset + limit : null };
}

export async function changeGuidance(root, input, source = {}) {
  if (!input || typeof input !== 'object') fail('Mutation is required.');
  if (Object.keys(input).some(k => !['expectedRevision','mutationId','operation','rule','ruleId','restoreRevision','reason'].includes(k))) fail('Unknown mutation field.');
  const { expectedRevision, mutationId, operation, rule, ruleId, restoreRevision, reason } = input;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || typeof mutationId !== 'string' || !mutationId || mutationId.length > 120) fail('Invalid mutation identity.');
  if (!['upsert','remove','restore'].includes(operation)) fail('Invalid operation.');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) fail('Invalid reason.');
  if (!source || !['user','coach'].includes(source.actor) || Object.keys(source).some(k => !['actor','conversationKey','requestId'].includes(k))) fail('Invalid source.');
  if (operation === 'upsert') validRule(rule); else if (operation === 'remove' && (typeof ruleId !== 'string' || !ruleId)) fail('ruleId is required.'); else if (operation === 'restore' && (!Number.isInteger(restoreRevision) || restoreRevision < 0)) fail('restoreRevision is required.');
  for (const key of ['conversationKey','requestId']) if (source[key] !== undefined && (typeof source[key] !== 'string' || !source[key] || source[key].length > 500)) fail('Invalid source identity.');
  if (source.actor === 'coach' && (!source.conversationKey || !source.requestId)) fail('Coach changes require a saved conversation identity.');
  const operationFields = { upsert: ['rule'], remove: ['ruleId'], restore: ['restoreRevision'] };
  for (const key of ['rule','ruleId','restoreRevision']) if (input[key] !== undefined && !operationFields[operation].includes(key)) fail('Unexpected field for this operation.');
  const file = fileFor(root);
  return withMemoryLock(file, async () => { const s = await load(file); const payload = mutationData({ expectedRevision, mutationId, operation, rule: rule && {id:rule.id,scope:rule.scope,mode:rule.mode,text:rule.text,enabled:rule.enabled}, ruleId, restoreRevision, reason, source: clone(source) }); const prior = s.history.find(h => h.mutationId === mutationId); if (prior) { if (canonical(prior._payload) !== canonical(payload)) fail('Mutation id was already used with different data.'); return { revision: s.revision, rules: clone(s.rules), change: clone(prior), replayed: true }; } if (expectedRevision !== s.revision) throw new HttpError(409, 'guidance_revision_conflict', 'Guidance revision is stale.');
    const before = clone(s.rules); let after;
    if (operation === 'upsert') { after = s.rules.filter(r => r.id !== rule.id); after.push(clone(rule)); }
    else if (operation === 'remove') { if (!s.rules.some(r => r.id === ruleId)) fail('That rule no longer exists.'); after = s.rules.filter(r => r.id !== ruleId); }
    else { const target = restoreRevision === 0 ? [] : s.history.find(h => h.revision === restoreRevision)?.after; if (!target) fail('Unknown restore revision.'); after = clone(target); }
    checkRules(after); const change = { revision: s.revision + 1, at: new Date().toISOString(), operation, reason, source: clone(source), before, after, mutationId, _payload:payload }; s.revision++; s.rules = after; s.history.push(change); await save(file, s); return { revision: s.revision, rules: clone(after), change: clone(change), replayed: false }; });
}

export async function effectiveGuidance(root, { discipline, mode } = {}) {
  if (!GUIDANCE_SCOPES.includes(discipline) || discipline === 'all' || !GUIDANCE_MODES.includes(mode) || mode === 'all') fail('Invalid guidance resolution.');
  const { rules } = await load(fileFor(root)); const selected = rules.filter(r => r.enabled && (r.scope === 'all' || r.scope === discipline) && (r.mode === 'all' || r.mode === mode)).sort((a,b)=>((a.scope==='all')-(b.scope==='all'))||((a.mode==='all')-(b.mode==='all'))||a.id.localeCompare(b.id));
  return { rules: selected.map(({ id, scope, mode, text }) => ({ id, scope, mode, text })), text: JSON.stringify(selected.map(({ id, scope, mode, text }) => ({ id, scope, mode, text }))) };
}
