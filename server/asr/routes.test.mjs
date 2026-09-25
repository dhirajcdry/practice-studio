// Noise on stderr is not a failure.
//
// The on-device transcriber works, and then prints this to stderr as the Apple Neural
// Engine runtime tears the model down:
//
//   E5RT encountered an STL exception. msg = Failed to PropagateInputTensorShapes:
//   std::runtime_error during type inference for ios17.slice_by_index: zero shape error.
//
// It arrives *after* the JSON result, the process still exits 0, and the transcript is
// correct. It is chatter from Apple's runtime, not our transcription failing — verified
// by transcribing the same audio and reading the exit code and stdout.
//
// The danger is not the message, it is what a future change might do with it: any
// "surface stderr when it looks like something went wrong" logic would turn every
// successful take into a reported error, and a user who is told transcription failed
// will stop trusting the transcripts that did work. These tests pin the rule — the exit
// code and the parsed stdout decide the outcome, and nothing else does.

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The exact teardown line, so a rename of the real thing does not silently pass. */
const E5RT_NOISE = 'E5RT encountered an STL exception. msg = Failed to '
  + 'PropagateInputTensorShapes: std::runtime_error during type inference for '
  + 'ios17.slice_by_index: zero shape error.';

/**
 * A stand-in transcriber that behaves exactly as the real one does on this machine:
 * good JSON on stdout, ANE chatter on stderr, exit 0.
 */
async function fakeTranscriber({ exit = 0, stdout = '', stderr = '' }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-asr-fake-'));
  const file = path.join(dir, 'fake-asr.mjs');
  await fsp.writeFile(file, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr)});
process.exit(${exit});
`, { mode: 0o755 });
  return file;
}

/** The decision runAsr makes, isolated from the multipart parsing around it. */
function outcomeOf(binary) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binary], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8').trim();
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (code === 0 && stdout) {
        try { return resolve({ ok: true, result: JSON.parse(stdout), stderr }); } catch { /* fall through */ }
      }
      resolve({ ok: false, stderr, code });
    });
  });
}

const GOOD = JSON.stringify({
  durationSeconds: 0.5,
  modelId: 'FluidInference/parakeet-tdt-0.6b-v2-coreml',
  text: 'Mm.',
  words: [{ start: 0, end: 0.4, word: 'Mm.' }],
});

test('a transcript that arrives with ANE chatter behind it is still a transcript', async () => {
  const binary = await fakeTranscriber({ exit: 0, stdout: `${GOOD}\n`, stderr: `${E5RT_NOISE}\n` });
  const outcome = await outcomeOf(binary);
  assert.equal(outcome.ok, true, 'stderr noise was mistaken for a failed transcription');
  assert.equal(outcome.result.text, 'Mm.');
  assert.match(outcome.stderr, /E5RT/, 'the fixture did not actually produce the noise');
});

test('the exit code and stdout decide the outcome — never the contents of stderr', async () => {
  // Alarming words on stderr, a perfectly good result on stdout.
  const scary = await fakeTranscriber({
    exit: 0, stdout: `${GOOD}\n`,
    stderr: 'error: exception: failed: std::runtime_error: FATAL\n',
  });
  assert.equal((await outcomeOf(scary)).ok, true, 'a scary word on stderr failed a good take');

  // And the converse: a real failure is still a failure, however quiet.
  const quiet = await fakeTranscriber({ exit: 3, stdout: '', stderr: '' });
  assert.equal((await outcomeOf(quiet)).ok, false, 'a crashed transcriber was reported as success');
});

test('the diagnostic line the transcriber prints on the way is not an error either', async () => {
  // studio-asr logs what it decoded to stderr on every successful run.
  const binary = await fakeTranscriber({
    exit: 0, stdout: `${GOOD}\n`,
    stderr: 'studio-asr: decoded 0.50s of audio via AVFoundation (8000 samples @ 16000 Hz)\n'
      + `studio-asr: transcribed in 0.10s (5x realtime), 1 words with timings\n${E5RT_NOISE}\n`,
  });
  assert.equal((await outcomeOf(binary)).ok, true);
});

test('unparseable stdout is a failure even on exit 0 — a transcript is never guessed at', async () => {
  const binary = await fakeTranscriber({ exit: 0, stdout: 'not json\n', stderr: '' });
  assert.equal((await outcomeOf(binary)).ok, false);
});
