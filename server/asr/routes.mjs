// POST /api/asr — transcribe a recording locally.
//
// Nothing leaves the machine. The audio goes to a temp file, `studio-asr` reads it, and
// the temp file is deleted. Speech is the most personal thing this app touches; it is
// never uploaded, and there is no code path here that could upload it.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HttpError, sendJson } from '../http-util.mjs';
import { STUDIO_DIR, HOME_ROOT } from '../paths.mjs';

const ASR_BINARY = path.join(STUDIO_DIR, 'asr', '.build', 'release', 'studio-asr');
const MAX_AUDIO_BYTES = 200 * 1024 * 1024; // ~40 min of opus; a debrief is minutes, not hours
const ASR_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Minimal multipart/form-data reader. Zero dependencies on purpose — this process holds a
 * session cookie and executes code, so every added package is a supply-chain question.
 * Handles exactly what FormData sends: a boundary, a few text fields, one binary part.
 */
function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw new HttpError(400, 'BAD_REQUEST', 'That upload was not formatted as multipart form data.');

  const boundary = Buffer.from(`--${(match[1] || match[2]).trim()}`);
  const parts = [];
  let cursor = buffer.indexOf(boundary);

  while (cursor !== -1) {
    const bodyStart = cursor + boundary.length;
    if (buffer.slice(bodyStart, bodyStart + 2).toString() === '--') break; // closing boundary
    const next = buffer.indexOf(boundary, bodyStart);
    if (next === -1) break;

    // Section is CRLF + headers + CRLFCRLF + payload + CRLF
    const section = buffer.slice(bodyStart + 2, next - 2);
    const headerEnd = section.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      cursor = next;
      continue;
    }
    const headers = section.slice(0, headerEnd).toString('utf8');
    const payload = section.slice(headerEnd + 4);
    const nameMatch = /name="([^"]*)"/i.exec(headers);
    const fileMatch = /filename="([^"]*)"/i.exec(headers);

    parts.push({
      name: nameMatch ? nameMatch[1] : null,
      filename: fileMatch ? fileMatch[1] : null,
      data: payload,
    });
    cursor = next;
  }
  return parts;
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_AUDIO_BYTES) {
      throw new HttpError(413, 'BAD_REQUEST', 'That recording is longer than this app accepts in one take.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Extensions studio-asr knows how to decode. The extension is how it picks a decoder. */
function safeExtension(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return ['.webm', '.wav', '.m4a', '.mov', '.mp4', '.aiff', '.caf'].includes(ext) ? ext : '.webm';
}

function runAsr(file) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ASR_BINARY, ['--input', file, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: { kind: 'unavailable', message: err.message } });
      return;
    }

    const out = [];
    const err = [];
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, error: { kind: 'timeout', message: 'Transcription took too long and was stopped.' } });
    }, ASR_TIMEOUT_MS);

    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: { kind: 'unavailable', message: e.message } });
    });

    child.on('close', (code) => {
      if (settled) return;
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8').trim();
      const stderr = Buffer.concat(err).toString('utf8').trim();

      if (code === 0 && stdout) {
        try {
          return resolve({ ok: true, result: JSON.parse(stdout) });
        } catch {
          return resolve({
            ok: false,
            error: { kind: 'internal', message: 'The transcriber returned something unreadable.' },
          });
        }
      }
      // studio-asr reports failures as JSON on stderr — surface its own words, since it
      // distinguishes "no audio track" from "silent" from "nothing was said".
      try {
        const parsed = JSON.parse(stderr.slice(stderr.indexOf('{')));
        if (parsed?.error) return resolve({ ok: false, error: parsed.error });
      } catch {
        /* fall through to the generic message */
      }
      resolve({
        ok: false,
        error: { kind: 'failed', message: stderr.split('\n').pop() || `Transcription failed (exit ${code}).` },
      });
    });
  });
}

async function handleTranscribe(req, res, ctx) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new HttpError(400, 'BAD_REQUEST', 'Expected an audio upload.');
  }

  try {
    await fs.access(ASR_BINARY);
  } catch {
    throw new HttpError(
      503,
      'ASR_UNAVAILABLE',
      'The transcriber has not been built yet. Run `swift build -c release` in studio/asr. Nothing was sent anywhere.',
    );
  }

  const parts = parseMultipart(await readBody(req), contentType);
  const audio = parts.find((p) => p.name === 'audio' && p.filename);
  if (!audio || audio.data.length === 0) {
    throw new HttpError(400, 'BAD_REQUEST', 'That upload contained no audio.');
  }
  const slug = parts.find((p) => p.name === 'slug')?.data.toString('utf8').trim() || null;
  const mode = parts.find((p) => p.name === 'mode')?.data.toString('utf8').trim() || 'think_aloud';
  // Which attempt this take belongs to. Segmenting is a crash-safety detail; the attempt
  // is the real unit, and every segment recorded between record and stop carries its id
  // so they can be read back as one continuous narration.
  const attemptId = parts.find((p) => p.name === 'attemptId')?.data.toString('utf8').trim() || null;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-asr-'));
  const file = path.join(dir, `take${safeExtension(audio.filename)}`);

  try {
    await fs.writeFile(file, audio.data);
    const outcome = await runAsr(file);

    if (!outcome.ok) {
      // no_audio / empty_transcript are honest failures, not server faults: the recording
      // genuinely contained no speech. Never dress that up as an empty success.
      const kind = outcome.error?.kind || 'failed';
      const status = kind === 'no_audio' || kind === 'empty_transcript' ? 422 : 503;
      return sendJson(res, status, {
        error: { code: kind.toUpperCase(), message: outcome.error?.message || 'Transcription failed.' },
      });
    }

    const result = outcome.result;

    // Keep the transcript beside the problem it belongs to, so a debrief can be reread.
    //
    // Dictation is excluded on purpose: that is the composer microphone, used to talk to
    // the coach instead of typing. Filing it here would count a message *to* the coach as
    // evidence of thinking out loud, and inflate the one number that is supposed to say
    // whether he is rehearsing the spoken part of an interview.
    const persist = mode !== 'dictation';
    // The caller logs this filename into the session event, which is how the coach later
    // knows the take belongs to the sitting. Guessing that from timestamps alone dropped
    // the opening take of every sitting; naming it removes the guess.
    let transcript = null;
    if (persist && slug && /^[a-z0-9][a-z0-9-]*$/.test(slug) && result?.text) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${stamp}-${mode}.json`;
        const outDir = path.join(HOME_ROOT, 'problems', slug, 'transcripts');
        await fs.mkdir(outDir, { recursive: true });
        await fs.writeFile(
          path.join(outDir, filename),
          JSON.stringify({ ...result, mode, attemptId, recordedAt: new Date().toISOString() }, null, 2),
        );
        transcript = filename;
      } catch (err) {
        ctx.log?.warn?.(`[asr] transcript not saved for ${slug}: ${err.message}`);
      }
    }

    return sendJson(res, 200, {
      text: result?.text ?? '',
      words: Array.isArray(result?.words) ? result.words : [],
      durationSeconds: result?.durationSeconds ?? null,
      mode,
      transcript,
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export const routes = {
  'POST /api/asr': handleTranscribe,
};
