// Provider choice belongs to this local workspace, never to a CLI's private session ID.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError, sendJson } from '../http-util.mjs';
import { HOME_ROOT } from '../paths.mjs';
import { readJsonBody } from './http.mjs';
import { runCoachTurn as runClaude } from './claude-cli.mjs';
import { runCoachTurn as runCodex, listCodexModels } from './codex-cli.mjs';

export const DEFAULT_COACH = Object.freeze({ provider: 'codex', model: 'gpt-6-astra' });
export const CLAUDE_MODELS = [
  { id: 'default', label: 'Claude Code default' },
  { id: 'sonnet', label: 'Claude Sonnet' },
  { id: 'opus', label: 'Claude Opus' },
  { id: 'haiku', label: 'Claude Haiku' },
];
let catalogPromise;
let catalogAt = 0;
async function codexCatalog() {
  if (!catalogPromise || Date.now() - catalogAt > 60_000) {
    catalogAt = Date.now();
    catalogPromise = listCodexModels().catch(error => { catalogPromise = null; throw error; });
  }
  return catalogPromise;
}
export function validChoice(value) {
  return value && ['codex', 'claude'].includes(value.provider) && typeof value.model === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value.model)
    && (value.provider !== 'claude' || CLAUDE_MODELS.some(m => m.id === value.model));
}
export async function readCoachChoice(root = HOME_ROOT, { binary } = {}) {
  // A custom Claude binary is an existing integration/test seam, not a Codex executable.
  try {
    const value = JSON.parse(await fs.readFile(path.join(root, 'coach-settings.json'), 'utf8'));
    if (validChoice(value)) return { provider: value.provider, model: value.model };
    throw new Error('Invalid saved coach selection. Choose a model in Settings.');
  } catch (error) {
    if (error.code === 'ENOENT') return binary ? { provider: 'claude', model: 'default' } : { ...DEFAULT_COACH };
    throw error;
  }
}
export async function saveCoachChoice(root, value, { models = codexCatalog } = {}) {
  if (!validChoice(value)) throw new HttpError(400, 'BAD_REQUEST', 'Choose a supported coach provider and model.');
  if (value.provider === 'codex' && !(await models()).some(m => m.id === value.model)) {
    throw new HttpError(400, 'MODEL_UNAVAILABLE', 'That model is not in the Codex CLI catalog. Refresh the choices.');
  }
  const choice = { provider: value.provider, model: value.model };
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, 'coach-settings.json');
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(choice) + '\n'); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
  return choice;
}
export function runProviderTurn({ choice, binary, ...options }) {
  return choice.provider === 'codex'
    ? runCodex({ ...options, model: choice.model, binary: process.env.STUDIO_CODEX_BINARY || 'codex' })
    : runClaude({ ...options, binary: binary || 'claude', model: choice.model === 'default' ? null : choice.model });
}
const rootFor = ctx => ctx?.homeRoot ?? ctx?.paths?.HOME_ROOT ?? HOME_ROOT;
export const providerRoutes = {
  'GET /api/coach/models': async (_req, res, ctx) => {
    let codex = [], codexError = null;
    try { codex = await codexCatalog(); } catch (error) { codexError = error.message; }
    const selected = await readCoachChoice(rootFor(ctx));
    return sendJson(res, 200, { selected, providers: [
      { id: 'codex', label: 'Codex CLI', models: codex, error: codexError },
      { id: 'claude', label: 'Claude Code', models: CLAUDE_MODELS },
    ] });
  },
  'PUT /api/coach/model': async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const selected = await saveCoachChoice(rootFor(ctx), body);
    return sendJson(res, 200, { selected });
  },
};
