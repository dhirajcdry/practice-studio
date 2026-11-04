// A rebuildable, source-linked index of session decisions. Raw records stay authoritative.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { workspacePath } from '../storage-layout.mjs';
import { withMemoryLock } from './memory.mjs';
import { selectRecords } from './context-policy.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const SESSION_GUIDE = `Keep interview continuity using the source-linked session record. When an important requirement, decision, unresolved question, probe, assistance, or self-correction is established, use record_session during this turn with exact evidence quotes. Update the same key when it changes; do not create a running transcript or write an entry for every reply. Entries are model interpretations, not independent facts. A quoted suggestion is not an agreed requirement. Retrieve the source before a consequential assessment. Only source-confirmed learner work supports unaided ability. Never turn your own assistance into a learner accomplishment.`;

export function sessionEvidence(records = []) {
  const out = [];
  records.forEach((record, index) => {
    if (!record || typeof record !== 'object') return;
    const identity = record.requestId || record.id || record.at || record.date || index;
    const fields = [['said','learner'],['ask','learner'],['question','learner'],['asked','coach'],['answer','coach']];
    let speech = false;
    for (const [field, actor] of fields) if (typeof record[field] === 'string' && record[field].trim()) {
      const text = record[field]; speech = true;
      out.push({ sourceId: `turn:${hash(JSON.stringify([identity,field,text])).slice(0,24)}`, index, actor, kind:record.kind || record.type || 'exchange', text,
        ...(record.stopped?{interrupted:true}:{}),...(record.status?{status:record.status}:{}) });
    }
    const {code,elements,snapshot,chunks,actions,...rest} = record;
    if (rest.action) rest.action = {tool:rest.action.tool,status:rest.action.status,summary:rest.action.summary};
    if (!speech && (rest.kind || rest.type) && !['buffer','board','scene'].includes(rest.kind || rest.type)) {
      const text = JSON.stringify(rest);
      out.push({sourceId:`turn:${hash(text).slice(0,24)}`,index,actor:'record',kind:rest.kind || rest.type,text});
    }
    for (const action of actions || []) {
      const text=JSON.stringify({tool:action.tool,status:action.status,summary:action.summary});
      out.push({sourceId:`turn:${hash(JSON.stringify([identity,action.id,text])).slice(0,24)}`,index,actor:'record',kind:'assistance',text});
    }
  });
  return out;
}

export function sessionProjection(records, saved = [], {query = '', budget = 7000} = {}) {
  const sources = sessionEvidence(records), byId = new Map(sources.map(s => [s.sourceId,s]));
  const entries = saved.filter(entry => entry.evidence?.every(e => byId.get(e.sourceId)?.text.includes(e.quote)));
  // These are exact excerpts, not an inferred agreement or skill assessment. Keep
  // middle-of-session requirements/corrections eligible even before the model records them.
  const anchors = sources.filter(s => /\b(require|scope|agree|allow|constraint|must|should|instead|actually|correct|cancel|concurren|atomic|race|hint|probe|curveball|wrong|fix)\w*/i.test(s.text))
    .map(s => ({...s,text:s.text.length > 1200 ? s.text.slice(0,1200)+' [excerpt; retrieve source]' : s.text}));
  return {notice:'Source-linked interpretations and exact excerpts; agreement and mastery must be checked against original evidence.',
    entries:selectRecords(entries,{budget:Math.floor(budget*.6),query,head:4,tail:4}),
    anchors:selectRecords(anchors,{budget:Math.floor(budget*.4),query,head:2,tail:2}),
    sourceCount:sources.length,unavailableEntries:saved.length-entries.length};
}

export function createSessionContext({root,target,records}) {
  const file = workspacePath(root,path.join(root,'context','sessions',`${hash(target)}.json`));
  async function load() {
    try { const value=JSON.parse(await fs.readFile(file,'utf8')); return Array.isArray(value.entries)?value.entries:[]; }
    catch(e) { if(e.code==='ENOENT')return []; throw e; }
  }
  return {
    target,
    async read(query='') { return sessionProjection(await records(),await load(),{query}); },
    async sources() { return sessionEvidence(await records()); },
    async record({key,kind,summary,status='active',evidence}) {
      return withMemoryLock(file,async()=>{
        const sources=new Map(sessionEvidence(await records()).map(s=>[s.sourceId,s]));
        if(!evidence?.length || evidence.some(e=>!e.quote?.trim() || !sources.get(e.sourceId)?.text.includes(e.quote)))
          return {ok:false,text:'Each entry needs an exact quote from an available session source. Read session or search_context first; do not invent a source.'};
        const entries=await load(),at=entries.findIndex(e=>e.key===key);
        if(at<0 && entries.length>=80)return {ok:false,text:'The session record has 80 entries. Consolidate or update an existing key.'};
        const entry={key,kind,summary,status,evidence:evidence.map(e=>({...e,actor:sources.get(e.sourceId).actor})),
          provenance:'model interpretation supported by quoted record',updatedAt:new Date().toISOString()};
        if(at<0)entries.push(entry);else entries[at]=entry;
        await fs.mkdir(path.dirname(file),{recursive:true});
        const temp=`${file}.${crypto.randomUUID()}.tmp`;
        try { await fs.writeFile(temp,JSON.stringify({version:1,target,entries})+'\n');await fs.rename(temp,file); }
        finally { await fs.rm(temp,{force:true}); }
        return {ok:true,text:`Recorded session ${kind} under ${key}. This is a source-linked interpretation, not independent evidence.`};
      });
    },
  };
}
