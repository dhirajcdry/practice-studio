// Read-only readiness checks. Never starts providers, downloads models, or warms caches.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
const run = promisify(execFile), root = path.resolve(new URL('..', import.meta.url).pathname);
const home = process.env.STUDIO_HOME || path.join(os.homedir(), 'LeetCodeTutor');
async function probe(command) { try { return (await run(command, ['--version'], { timeout: 3000, maxBuffer: 32768 })).stdout.trim().split('\n')[0]; } catch { return null; } }
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
function report(label, ok, detail, required = false) { console.log(`${ok ? 'OK' : required ? 'MISSING' : 'OPTIONAL'} ${label}${detail ? ': ' + detail : ''}`); if (!ok && required) process.exitCode = 1; }
report('Node >=22', Number(process.versions.node.split('.')[0]) >= 22, process.version, true);
const python = await probe(process.env.STUDIO_PYTHON || 'python3'); report('Python', !!python, python, true);
for (const [name, file] of [['Monaco', 'web/vendor/monaco/vs/loader.js'], ['Excalidraw', 'web/vendor/excalidraw/excalidraw.mjs']]) report(name, await exists(path.join(root, file)), file, true);
const chrome = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const chromeVersion = await probe(chrome); report('Chrome for browser checks', !!chromeVersion, chromeVersion);
for (const [label, binary] of [['Codex CLI', process.env.STUDIO_CODEX_BINARY || 'codex'], ['Claude CLI', process.env.STUDIO_COACH_BINARY || 'claude']]) { const version = await probe(binary); report(label, !!version, version ? `${version} (authentication not checked)` : 'not found'); }
let ancestor = home; while (!(await exists(ancestor)) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
try { await fs.access(ancestor, constants.W_OK); report('Workspace writable', true, home, true); } catch { report('Workspace writable', false, home, true); }
for (const [label, file] of [['Reference checkout', path.join(root, 'vendor/neetcode-solutions')], ['Cached statements', path.join(home, 'cache/leetcode')], ['WhisperKit helper', path.join(root, 'asr/.build/release/studio-asr')], ['Studio speech models', path.join(os.homedir(), 'Library/Application Support/PracticeStudio/ASRModels')], ['Kokoro installation', path.join(os.homedir(), 'Library/Application Support/PracticeStudio/tts')]]) report(label, await exists(file), file);
console.log('Cached justwisper models may also be reused. Microphone permissions, provider sign-in and speech quality require an explicit live session.');
