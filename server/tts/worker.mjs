import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOME = path.join(os.homedir(), 'Library', 'Application Support', 'PracticeStudio', 'tts');
const failure = message => ({ ok: false, error: { message } });

// One process owns the model; one outstanding line owns its next response.
export class TtsWorker {
  constructor({ python = process.env.STUDIO_TTS_PYTHON || path.join(HOME, 'venv/bin/python'),
    script = process.env.STUDIO_TTS_SCRIPT || path.join(ROOT, 'tts/studio-tts.py'),
    timeout = Number(process.env.STUDIO_TTS_TIMEOUT_MS || 30000) } = {}) {
    const models = process.env.STUDIO_TTS_MODEL_DIR || path.join(HOME, 'models');
    this.python = python; this.script = script; this.timeout = timeout;
    this.model = process.env.STUDIO_TTS_MODEL || path.join(models, 'kokoro-v1.0.onnx');
    this.voices = process.env.STUDIO_TTS_VOICES || path.join(models, 'voices-v1.0.bin');
    this.child = null; this.queue = []; this.active = null; this.buffer = '';
  }
  request(payload) {
    if (this.queue.length >= 16) return Promise.resolve(failure('Speech queue is full.'));
    return new Promise(resolve => { this.queue.push({ payload, resolve }); this.drain(); });
  }
  start() {
    const child = spawn(this.python, ['-I', this.script], {
      env: { ...process.env, STUDIO_TTS_MODEL: this.model, STUDIO_TTS_VOICES: this.voices },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.child = child; this.buffer = '';
    const die = () => {
      if (this.child !== child) return;
      this.child = null; this.buffer = '';
      this.finish(failure('Local speech helper stopped.'), false);
      this.drain();
    };
    child.on('error', die); child.on('close', die);
    child.stdin.on('error', () => { child.kill('SIGKILL'); die(); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      if (this.child !== child) return;
      this.buffer += data;
      if (this.buffer.length > 16 * 1024 * 1024) { child.kill('SIGKILL'); return; }
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        let result;
        try { result = JSON.parse(line); } catch { child.kill('SIGKILL'); return; }
        this.finish(result);
      }
    });
  }
  drain() {
    if (this.active || !this.queue.length) return;
    if (!this.child) this.start();
    this.active = this.queue.shift();
    const child = this.child;
    this.timer = setTimeout(() => child.kill('SIGKILL'), this.timeout);
    child.stdin.write(JSON.stringify(this.active.payload) + '\n');
  }
  finish(result, drain = true) {
    if (!this.active) return;
    clearTimeout(this.timer);
    const active = this.active; this.active = null;
    active.resolve(result);
    if (drain) this.drain();
  }
  close() {
    const child = this.child; this.child = null; this.buffer = '';
    this.finish(failure('Speech stopped.'), false);
    for (const item of this.queue.splice(0)) item.resolve(failure('Speech stopped.'));
    child?.kill('SIGTERM');
  }
}
