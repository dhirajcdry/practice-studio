import { HttpError, sendJson } from '../http-util.mjs';
import { TtsWorker } from './worker.mjs';
import fs from 'node:fs/promises';

export const ttsWorker = new TtsWorker();
export function createTtsRoutes(worker = ttsWorker) {
  async function availability() {
    for (const file of [worker.python, worker.script, worker.model, worker.voices]) {
      try { await fs.access(file); } catch { return { available: false, voices: [], reason: `Local speech file missing: ${file}` }; }
    }
    const result = await worker.request({ op: 'voices' });
    return { available: result.ok === true, voices: result.ok ? result.voices : [], reason: result.ok ? null : result.error?.message || 'Local speech unavailable.' };
  }
  return {
    'GET /api/tts/status': async (_req, res) => sendJson(res, 200, await availability()),
    'POST /api/tts': async (req, res) => {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) throw new HttpError(413, 'BAD_REQUEST', 'Text is too long.');
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks)); } catch { throw new HttpError(400, 'BAD_REQUEST', 'Expected JSON.'); }
      if (!body || typeof body.text !== 'string') throw new HttpError(400, 'BAD_REQUEST', 'text must be a string.');
      const text = body.text.trim();
      if (!text || text.length > 500 || /[\r\n]/.test(text) || /[.!?]\s+\S/.test(text.replace(/\b(?:e\.g|i\.e|Mr|Mrs|Dr)\./g, ''))) {
        throw new HttpError(400, 'BAD_REQUEST', 'Provide one sentence of up to 500 characters.');
      }
      const voice = body.voice ?? 'af_heart', speed = body.speed ?? 1;
      if (typeof voice !== 'string' || !/^[ab][fm]_[a-z]+$/.test(voice)) throw new HttpError(400, 'BAD_REQUEST', 'Unknown English voice.');
      if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < .5 || speed > 2) throw new HttpError(400, 'BAD_REQUEST', 'Speed must be between 0.5 and 2.');
      const status = await availability();
      if (!status.available) throw new HttpError(503, 'TTS_UNAVAILABLE', status.reason);
      if (!status.voices.includes(voice)) throw new HttpError(400, 'BAD_REQUEST', 'Unknown voice.');
      const result = await worker.request({ text, voice, speed });
      if (!result.ok || typeof result.wav !== 'string') throw new HttpError(503, 'TTS_UNAVAILABLE', result.error?.message || 'Speech failed.');
      const wav = Buffer.from(result.wav, 'base64');
      if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new HttpError(503, 'TTS_UNAVAILABLE', 'Invalid speech audio.');
      res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' }); res.end(wav);
    },
  };
}
export const routes = createTtsRoutes();
