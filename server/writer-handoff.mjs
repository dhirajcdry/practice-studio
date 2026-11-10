import crypto from 'node:crypto';
import path from 'node:path';
import fsp from 'node:fs/promises';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const workers = new Map();
const RETRY_MS = 30_000;
export function writerBaseUrl(env = process.env) {
  try {
    const u = new URL(env.STUDIO_WRITER_URL);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/') return null;
    if (!(u.protocol === 'https:' && (u.hostname.endsWith('.ts.net') || loopback)) && !(u.protocol === 'http:' && loopback)) return null;
    return u.origin;
  } catch { return null; }
}
const outboxDir = root => path.join(root, 'context', 'writer-outbox');
function fileFor(root, id) { if (!UUID.test(id)) throw new Error('Invalid Writer session id.'); return path.join(outboxDir(root), `${id}.json`); }
async function writeAtomic(file, value) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fsp.writeFile(tmp, JSON.stringify(value), { mode: 0o600 }); await fsp.rename(tmp, file); }
  finally { await fsp.rm(tmp, { force: true }); }
}
export function handoffId(value) {
  const hex = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export async function enqueueWriterSession({ root, title, message, context, source, id, env = process.env, now = Date.now }) {
  const base = writerBaseUrl(env);
  if (!base) return { ok: false, text: 'Writer is not configured. Set STUDIO_WRITER_URL to its HTTPS Tailscale origin or a loopback development origin.' };
  if (!source || source.app !== 'practice-studio' || !source.title || !source.url || !source.conversationId) return { ok: false, text: 'Writer handoff needs a Studio source identity.' };
  for (const [value, max] of [[title,180],[message,8000],[context,30000]]) if (typeof value !== 'string' || !value.trim() || value.length > max) return {ok:false,text:'The handoff is empty or exceeds its context limit.'};
  id ||= handoffId({title,message,context,source});
  const body = { id, title, message, context, source };
  const file = fileFor(root, id);
  await fsp.mkdir(outboxDir(root), { recursive: true });
  try {
    const prior = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (JSON.stringify(prior.body) !== JSON.stringify(body) || prior.base !== base) return { ok: false, text: 'That Writer session id already has different content or destination.' };
    if (prior.status === 'failed') await writeAtomic(file,{...prior,status:'queued',attempts:0,nextAttemptAt:now()});
    workers.get(root)?.();
    return { ok: true, id, status: prior.status === 'started' ? 'started' : 'queued', url: `${base}/?session=${id}`, replayed: true };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeAtomic(file, { body, base, status: 'queued', attempts: 0, nextAttemptAt: now(), createdAt: now() });
  workers.get(root)?.();
  return { ok: true, id, status: 'queued', url: `${base}/?session=${id}` };
}
export async function writerSessionStatus(root,id,{fetchFn=fetch}={}) {
  const item=JSON.parse(await fsp.readFile(fileFor(root,id),'utf8'));
  if(item.status!=='started') return {id,status:item.status,stage:item.status==='failed'?'Delivery failed. Ask your tutor to retry the same handoff.':'Waiting for Writer',error:item.lastError};
  try {
    const response=await fetchFn(`${item.base}/api/ai/sessions/${id}`,{signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error('Writer is unavailable');
    const result=await response.json();
    return {id,status:result.status,stage:result.stage,outputNoteId:result.outputNoteId,url:`${item.base}/?session=${id}`};
  } catch {return {id,status:'unreachable',stage:'Sent to Writer · status unavailable',url:`${item.base}/?session=${id}`};}
}
export function startWriterWorker({ root, env = process.env, fetchFn = globalThis.fetch, intervalMs = RETRY_MS, now = Date.now, log = console, startImmediately = true } = {}) {
  let stopped = false, busy=false;
  const tick = async () => {
    if (busy || stopped || !writerBaseUrl(env)) return;
    busy=true;
    try {
      let names=[];try{names=await fsp.readdir(outboxDir(root));}catch(error){if(error.code!=='ENOENT')throw error;}
      let sent=0;
      for (const name of names.filter(n => UUID.test(n.replace(/\.json$/,'')) && n.endsWith('.json'))) {
        if(stopped || sent>=2)break;
        const file=path.join(outboxDir(root),name);
        let item;try{item=JSON.parse(await fsp.readFile(file,'utf8'));}catch{continue;}
        if(item.status!=='queued' || item.nextAttemptAt>now())continue;
        sent++;
        try {
          if(item.base!==writerBaseUrl(env))throw new Error('Writer destination changed; queued context was not sent.');
          const response=await fetchFn(`${item.base}/api/ai/sessions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(item.body),signal:AbortSignal.timeout(10_000)});
          if(!response.ok){const error=new Error(`Writer returned HTTP ${response.status}`);error.permanent=[400,403,404,409,413].includes(response.status);throw error;}
          const result=await response.json();
          if(result.id!==item.body.id || typeof result.status!=='string')throw new Error('Writer returned an invalid acknowledgement.');
          await writeAtomic(file,{...item,status:'started',startedAt:now()});
        }catch(error){
          const attempts=(item.attempts||0)+1;
          await writeAtomic(file,{...item,attempts,status:error.permanent?'failed':'queued',nextAttemptAt:now()+RETRY_MS*Math.min(attempts,20),lastError:String(error.message).slice(0,300)});
        }
      }
    }catch(error){log.warn?.(`[writer] ${error.message}`);}finally{busy=false;}
  };
  const poke=()=>void tick();workers.set(root,poke);
  const timer=setInterval(poke,intervalMs);timer.unref?.();if(startImmediately)poke();
  const stop=()=>{stopped=true;clearInterval(timer);if(workers.get(root)===poke)workers.delete(root);};
  stop.tick=tick;
  return stop;
}
