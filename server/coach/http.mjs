// Request-body helpers. `server/http-util.mjs` covers responses; Phase 1 never had to
// read a body, so reading one lives here until it is needed in more than one module.

import { HttpError } from '../http-util.mjs';

const DEFAULT_LIMIT = 2 * 1024 * 1024; // 2 MB. A solution buffer plus a question, generously.

/**
 * Read and JSON-parse a request body.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<any>}
 */
export async function readJsonBody(req, { limit = DEFAULT_LIMIT } = {}) {
  const chunks = [];
  let size = 0;

  await new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'BODY_TOO_LARGE', 'That request body is too large to accept.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', reject);
  });

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value;
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'That request body was not a JSON object.');
  }
}

/** A non-empty string field, or an HttpError naming the field. */
export function requireString(body, field, { maxLength = 100_000 } = {}) {
  const value = body?.[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'BAD_REQUEST', `"${field}" is required and must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new HttpError(400, 'BAD_REQUEST', `"${field}" is longer than this endpoint accepts.`);
  }
  return value;
}
