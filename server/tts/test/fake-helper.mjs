#!/usr/bin/env node
import readline from 'node:readline';
// 20 ms of silence. No Python, model, audio device, or network.
const wav = Buffer.alloc(44 + 960);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(960, 40);
for await (const line of readline.createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (req.text === 'Die.') process.exit(1);
  if (req.text === 'Wait.') await new Promise(resolve => setTimeout(resolve, 500));
  process.stdout.write(JSON.stringify(req.op === 'voices'
    ? { ok: true, voices: ['af_heart', 'af_bella', 'am_michael', 'am_fenrir', 'bf_emma', 'bm_george'] }
    : { ok: true, wav: wav.toString('base64') }) + '\n');
}
