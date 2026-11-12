import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError, sendJson } from './http-util.mjs';
import { disciplineForSlug } from './storage-layout.mjs';
import { classifyProblem } from './runner/meta.mjs';

export function parseProblemUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) throw new HttpError(400, 'BAD_REQUEST', 'A LeetCode problem URL is required.');
  let url;
  try { url = new URL(raw.trim()); } catch { throw new HttpError(400, 'BAD_REQUEST', 'That is not a valid LeetCode problem URL.'); }
  const match = /^\/problems\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/.*)?$/.exec(url.pathname);
  if (!['https:', 'http:'].includes(url.protocol) || !['leetcode.com', 'www.leetcode.com'].includes(url.hostname)
    || url.port || url.username || url.password || !match || match[1].length > 100) {
    throw new HttpError(400, 'BAD_REQUEST', 'Use a URL like https://leetcode.com/problems/two-sum/.');
  }
  return match[1];
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 8192) throw new HttpError(413, 'BODY_TOO_LARGE', 'The problem URL is too long.');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'BAD_REQUEST', 'The request body must be JSON.'); }
}

export function problemImportRoutes({ addedFile }) {
  // Recover after a failed save so a subsequent explicit attempt can succeed.
  let writeQueue = Promise.resolve();
  async function inspect(req, res, ctx, commit) {
    const input = await readBody(req);
    const slug = input?.slug ?? parseProblemUrl(input?.url);
    if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 100) {
      throw new HttpError(400, 'BAD_REQUEST', 'A LeetCode problem slug or URL is required.');
    }
    const source = input?.source === undefined ? 'you' : input.source;
    if (source !== 'you' && source !== 'others') throw new HttpError(400, 'BAD_REQUEST', 'Source must be you or others.');
    const existing = ctx.catalog.get(slug);
    if (commit && existing) return sendJson(res, 200, { slug, existing: true, entry: existing });
    // Never reinterpret a saved design/LLD workspace as a coding problem.
    const discipline = disciplineForSlug(slug);
    if (!existing && discipline !== 'coding') {
      for (const candidate of [path.join(path.dirname(addedFile), 'tracks', discipline, 'problems', slug), path.join(path.dirname(addedFile), 'problems', slug)]) {
        try { await fs.access(candidate); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        throw new HttpError(409, 'PROBLEM_IDENTITY_CONFLICT', 'That name already belongs to a saved interview topic. Nothing was changed.');
      }
    }
    let got;
    try { got = await ctx.leetcode.getContent(slug); }
    catch (error) {
      throw new HttpError(error.kind === 'unknown-slug' ? 404 : 503, 'IMPORT_UNAVAILABLE', error.message || 'LeetCode could not load this problem. Try again later.');
    }
    const content = got.content;
    const question = got.question ?? content;
    if (!question?.title) throw new HttpError(502, 'IMPORT_UNAVAILABLE', 'LeetCode did not return a problem title. Nothing was added.');
    const stub = content?.codeSnippets?.find(s => s.langSlug === 'python3')?.code
      ?? content?.codeSnippets?.find(s => s.langSlug === 'python')?.code ?? null;
    const shape = classifyProblem(content?.metaData, { pythonStub: stub, slug });
    const record = { leetcodeSlug: slug, leetcodeProblemNumber: question.questionFrontendId ?? null,
      title: question.title, pattern: null, difficulty: question.difficulty ?? null,
      lists: source === 'others' ? { others: true } : { added: true }, leetcodePremium: content?.isPaidOnly === true };
    if (!commit) return sendJson(res, 200, {
      slug, existing: Boolean(existing), entry: existing ?? { slug, title: record.title, number: record.leetcodeProblemNumber, difficulty: record.difficulty },
      content, pythonStub: stub,
      runner: { supported: shape.kind !== 'unsupported', message: shape.kind === 'unsupported' ? shape.message : 'Local runner supported. Public examples are available when supplied by LeetCode.' },
    });
    let wasExisting = false;
    const save = writeQueue.catch(() => {}).then(async () => {
      if (ctx.catalog.get(slug)) { wasExisting = true; return; }
      let records = [];
      try { records = JSON.parse(await fs.readFile(addedFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!Array.isArray(records)) throw new Error('The saved problem list is malformed.');
      const saved = records.find(record => record.leetcodeSlug === slug);
      if (saved) { ctx.catalog.add(saved, ctx.solutions); wasExisting = true; return; }
      records.push(record);
      const temp = `${addedFile}.${randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(addedFile), { recursive: true });
      try {
        await fs.writeFile(temp, JSON.stringify(records, null, 2), { mode: 0o600 });
        await fs.rename(temp, addedFile);
      } finally { await fs.rm(temp, { force: true }); }
      ctx.catalog.add(record, ctx.solutions);
    });
    writeQueue = save;
    await save;
    return sendJson(res, 200, { slug, existing: wasExisting, entry: ctx.catalog.get(slug) });
  }
  return {
    'POST /api/problems/import/preview': (req, res, ctx) => inspect(req, res, ctx, false),
    'POST /api/problems/import': (req, res, ctx) => inspect(req, res, ctx, true),
  };
}
