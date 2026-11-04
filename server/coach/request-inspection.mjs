import { sendJson } from '../http-util.mjs';
import crypto from 'node:crypto';

const MAX_ENTRIES=20, MAX_TEXT=1_000_000;
const rings=new Map();
const hash=text=>crypto.createHash('sha256').update(text).digest('hex').slice(0,16);
function ring(root){const key=String(root||'');if(!rings.has(key))rings.set(key,[]);return rings.get(key);}
export function inspectSections(prompt) {
  const sections=[];let offset=0,start=0,label='Instructions and context policy',fence=null;
  for(const line of prompt.split(/(?<=\n)/)) {
    if(!fence && /^## /u.test(line)) {
      if(offset>start)sections.push({name:label,characters:offset-start,hash:hash(prompt.slice(start,offset))});
      label=line.trim().slice(3);start=offset;
    }
    if(!fence && /^<DATA_[a-f0-9]+>/.test(line))fence=line.trim().replace('<','</');
    else if(!fence && /^<<<STUDIO-DATA-\S+/.test(line))fence=line.match(/^<<<(STUDIO-DATA-\S+)/)[1]+'>>>';
    else if(fence && line.trim()===fence)fence=null;
    offset+=line.length;
  }
  if(offset>start)sections.push({name:label,characters:offset-start,hash:hash(prompt.slice(start,offset))});
  return sections;
}
export function recordRequestInspection(root,detail) {
  const prompt=String(detail.prompt??''),systemPrompt=String(detail.systemPrompt??''),toolSchemas=String(detail.toolSchemas??'');
  const value={id:detail.id,at:detail.at||new Date().toISOString(),provider:detail.provider,model:detail.model??null,reasoningEffort:detail.reasoningEffort??null,
    discipline:detail.discipline??null,sessionId:detail.sessionId??null,status:'running',nativeTools:detail.nativeTools||[],
    conversation:detail.conversation || null,
    input:{promptCharacters:prompt.length,systemCharacters:systemPrompt.length,toolSchemaCharacters:toolSchemas.length},
    sections:inspectSections(prompt),prompt,systemPrompt,toolSchemas,toolSession:null,usage:null};
  const entries=ring(root);
  const previous=entries.findLast(e=>e.sessionId===value.sessionId && e.provider===value.provider && e.model===value.model);
  if(previous && typeof previous.prompt==='string'){let n=0;while(n<Math.min(previous.prompt.length,prompt.length)&&previous.prompt[n]===prompt[n])n++;value.unchangedPromptPrefixCharacters=n;}
  // Exact payloads are ephemeral. Oversized direct callers get explicit unavailable
  // content rather than a truncated payload presented as what the model received.
  if(prompt.length+systemPrompt.length+toolSchemas.length>MAX_TEXT){value.prompt=null;value.systemPrompt=null;value.toolSchemas=null;value.contentUnavailable='Request exceeded the inspection retention budget.';}
  entries.push(value);
  const bytes=()=>entries.reduce((n,x)=>n+(x.prompt?.length||0)+(x.systemPrompt?.length||0)+(x.toolSchemas?.length||0),0);
  while(entries.length>MAX_ENTRIES||bytes()>MAX_TEXT)entries.shift();
  return value;
}
export function finishRequestInspection(root,id,patch={}){const item=ring(root).find(x=>x.id===id);if(item)Object.assign(item,patch,{atEnd:new Date().toISOString()});}
export function requestInspectionRoutes(rootFor=ctx=>ctx?.homeRoot){return {'GET /api/coach/context':async(req,res,ctx)=>{
  const entries=ring(rootFor(ctx)),id=new URL(req.url,'http://localhost').searchParams.get('id');
  if(id){const request=entries.find(x=>x.id===id);return request?sendJson(res,200,{request}):sendJson(res,404,{error:{code:'NOT_FOUND',message:'This request is no longer retained. The inspector keeps recent requests since server startup.'}});}
  return sendJson(res,200,{requests:entries.map(({prompt,systemPrompt,toolSchemas,...summary})=>({...summary,...summary.input})),retention:'Up to 20 recent requests within a shared 1,000,000-character budget, since server startup. Prompt contents are not written to disk.'});
}};}
export const _inspection={rings};
