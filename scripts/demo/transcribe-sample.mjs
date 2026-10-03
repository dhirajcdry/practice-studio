// Generate a public, non-personal audio/transcript pair using the real local ASR.
// Requires macOS say, ffmpeg, and `swift build -c release --package-path asr`.
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'docs', 'media');
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-voice-sample-'));
const sourceText = 'I check for the value before adding it to the set. Otherwise the current value would match itself. The set contains only values from earlier positions.';
try {
  await fsp.mkdir(output, { recursive: true });
  const input = path.join(work, 'reasoning.aiff');
  execFileSync('say', ['-v', 'Samantha', '-r', '160', '-o', input, sourceText]);
  const audio = path.join(output, 'reasoning.wav');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-ar', '16000', '-ac', '1', audio]);
  const result = JSON.parse(execFileSync(path.join(root, 'asr/.build/release/studio-asr'), ['--input', audio, '--json'], { encoding: 'utf8' }));
  if (!result.text || !result.words?.length) throw new Error('Expected actual text and word timings from the transcriber');
  await fsp.writeFile(path.join(output, 'reasoning.json'), JSON.stringify({
    provenance: 'Synthetic macOS Samantha voice; actual output of Studio’s on-device transcriber. Not a personal recording.',
    sourceText, ...result,
  }, null, 2) + '\n');
  console.log(`Generated ${result.durationSeconds.toFixed(2)}s synthetic voice and ${result.words.length} actual timed words.`);
} finally {
  await fsp.rm(work, { recursive: true, force: true });
}
