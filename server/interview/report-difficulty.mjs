// The bar a mock's report is graded against. A global setting, read when a report is
// generated and then frozen on that interview's state; changing it never regrades a report.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError, sendJson } from '../http-util.mjs';
import { HOME_ROOT } from '../paths.mjs';
import { readJsonBody } from '../coach/http.mjs';

export const REPORT_DIFFICULTIES = ['beginner', 'mid-level'];
// Earlier name of 'mid-level'; still found in settings files and frozen on saved reports.
const LEGACY = { 'amazon-sde-2': 'mid-level' }; // privacy-ok: legacy id
export const normalizeReportDifficulty = value => LEGACY[value] ?? value;
export const DEFAULT_REPORT_DIFFICULTY = 'beginner';
const FILE = 'report-settings.json';

export async function readReportDifficulty(root = HOME_ROOT) {
  // Generating a report must not fail over a preference, so a bad file means the default.
  try {
    const difficulty = normalizeReportDifficulty(JSON.parse(await fs.readFile(path.join(root, FILE), 'utf8')).difficulty);
    return REPORT_DIFFICULTIES.includes(difficulty) ? difficulty : DEFAULT_REPORT_DIFFICULTY;
  } catch { return DEFAULT_REPORT_DIFFICULTY; }
}

export async function saveReportDifficulty(root, value) {
  value = normalizeReportDifficulty(value);
  if (!REPORT_DIFFICULTIES.includes(value)) throw new HttpError(400, 'BAD_REQUEST', 'Choose a supported report difficulty.');
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, FILE);
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify({ difficulty: value }) + '\n'); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
  return value;
}

const rootFor = ctx => ctx?.homeRoot ?? ctx?.paths?.HOME_ROOT ?? HOME_ROOT;
export const reportDifficultyRoutes = {
  'GET /api/report/difficulty': async (_req, res, ctx) => sendJson(res, 200, { difficulty: await readReportDifficulty(rootFor(ctx)) }),
  'PUT /api/report/difficulty': async (req, res, ctx) => {
    const body = await readJsonBody(req);
    return sendJson(res, 200, { difficulty: await saveReportDifficulty(rootFor(ctx), body.difficulty) });
  },
};
