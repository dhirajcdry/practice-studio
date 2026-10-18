import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
const home = process.env.STUDIO_TTS_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'PracticeStudio');
const root = path.join(home, 'tts'); const venv = path.join(root, 'venv'); const models = path.join(root, 'models');
await fs.mkdir(models, { recursive: true });
const run = (cmd,args) => new Promise((resolve,reject)=>{const p=spawn(cmd,args,{stdio:'inherit'});p.on('error',reject);p.on('close',c=>c?reject(new Error(`${cmd} exited ${c}`)):resolve())});
await run(process.env.STUDIO_TTS_PYTHON_BOOTSTRAP || 'python3', ['-m','venv',venv]);
await run(path.join(venv,'bin','python'), ['-m','pip','install','--upgrade','kokoro-onnx==0.4.9','soundfile']);
const files = [
  ['kokoro-v1.0.onnx','https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx','7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5'],
  ['voices-v1.0.bin','https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin','bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d'],
];
for (const [name,url,expected] of files) { const out=path.join(models,name); const tmp=`${out}.download-${process.pid}`; try { await run('curl',['-fL','--retry','2','-o',tmp,url]); const h=await import('node:crypto').then(({createHash})=>fs.readFile(tmp).then(b=>createHash('sha256').update(b).digest('hex'))); if(h !== expected) throw new Error(`${name} SHA256 ${h} does not match expected hash ${expected}`); await fs.rename(tmp,out); } finally { await fs.rm(tmp,{force:true}); } }
console.log(`Practice Studio TTS installed in ${root}`);
