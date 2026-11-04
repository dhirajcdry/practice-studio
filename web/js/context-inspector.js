import { el, replace } from './dom.js';
import { dialogHeader } from './ui/headers.js';
import { createActionRow } from './ui/primitives.js';
import { relativeInterviewDate } from './interview-format.js';

let active=null;
const number=value=>Number.isFinite(value)?value.toLocaleString():'Not reported';
const detail=(title,text)=>el('details',{class:'ci-source'},[el('summary',{text:title}),el('pre',{class:'mono',text:text??'Content is no longer retained.'})]);
async function get(url,signal){const res=await fetch(url,{signal});const data=await res.json();if(!res.ok)throw Error(data.error?.message||'Context could not be loaded.');return data;}
function table(rows){return el('dl',{class:'ci-facts'},rows.flatMap(([name,value])=>[el('dt',{text:name}),el('dd',{text:value})]));}

export async function openContextInspector() {
  active?.close();
  const opener=document.activeElement,dialog=el('dialog',{class:'rp-sheet ci-sheet','aria-label':'What was sent?'});
  const body=el('div',{class:'rp-scroll ci-body ui-inset'}),controller=new AbortController();
  let generation=0;
  const button=(text,onclick)=>el('button',{type:'button',class:'btn btn--quiet',text,onclick});
  dialog.append(dialogHeader({title:'What was sent?',subtitle:'Recent coach requests on this Mac',closeLabel:'Close context inspector',onClose:()=>dialog.close(),actions:[button('Refresh',()=>loadList())]}),body);
  dialog.addEventListener('close',()=>{controller.abort();dialog.remove();if(active===dialog)active=null;opener?.isConnected&&opener.focus();});
  dialog.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();dialog.close();}});
  dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
  document.body.append(dialog);active=dialog;dialog.showModal();
  async function loadList(){
    const version=++generation;replace(body,[el('p',{class:'dim',role:'status',text:'Loading requests…'})]);
    try {
      const data=await get('/api/coach/context',controller.signal);if(version!==generation)return;
      replace(body,[el('p',{class:'dim ci-caption',text:data.retention}),
        ...(data.requests.length?data.requests.slice().reverse().map(row=>createActionRow({className:'ci-request',onClick:()=>loadDetail(row.id),
          content:[el('strong',{text:row.model||row.provider}),el('span',{class:'dim',text:`${row.discipline||'Coach'} · ${relativeInterviewDate(row.at)} · ${row.status}`})],
          trailing:el('span',{class:'mono',text:`${number((row.input?.promptCharacters||0)+(row.input?.systemCharacters||0)+(row.input?.toolSchemaCharacters||0))} chars`}),
        })):[el('p',{class:'dim',text:'No coach requests recorded since server startup.'})])]);
    } catch(error){if(!controller.signal.aborted)replace(body,[el('p',{role:'alert',text:error.message})]);}
  }
  async function loadDetail(id){
    const version=++generation;
    try{
      const {request:r}=await get(`/api/coach/context?id=${encodeURIComponent(id)}`,controller.signal);if(version!==generation)return;
      const usage=r.usage||{},metrics=r.toolSession||{},input=r.input||{};
      replace(body,[button('All requests',()=>loadList()),el('div',{class:'ci-request-identity'},[
        el('h3',{text:r.model||r.provider}),el('p',{class:'dim',text:`${r.discipline||'Coach'} · ${r.status}${r.reasoningEffort?` · ${r.reasoningEffort} reasoning`:''}`}),
      ]),table([
        ['Conversation',r.conversation ? (r.conversation.resumed ? 'Continuing native session' : `New native segment · ${r.conversation.reason}`) : 'Independent request'],
        ...(r.conversation ? [['Context revision',String(r.conversation.revision)],['Native session',r.conversation.nativeId || 'Not established'],['State resync',r.conversation.resync ? 'After compaction' : 'No'],['Recovered interrupted attempts',String(r.conversation.recoveredAttempts || 0)]] : []),
        ['Prompt',`${number(input.promptCharacters)} characters`],['System instructions',`${number(input.systemCharacters)} characters`],['Tool definitions',`${number(input.toolSchemaCharacters)} characters`],
        ['Studio tool results',metrics.resultCharacters===undefined?'Not recorded':`${number(metrics.resultCharacters)} characters across ${number(metrics.calls)} calls`],
        ['Native research tools',r.nativeTools?.join(', ') || 'None'],
        ['Repeated reads avoided',number(metrics.repeatedReads)],
        ['Input tokens',`${number(usage.inputTokens)}${usage.inputTokens!=null?` (${usage.inputTokenScope||'provider reported'})`:''}`],
        ['Cache read tokens',number(usage.cacheReadInputTokens)],['Cache write tokens',number(usage.cacheCreationInputTokens)],
        ['Output tokens',number(usage.outputTokens)],['Reasoning output tokens',number(usage.reasoningOutputTokens)],
      ]),el('p',{class:'dim ci-caption',text:'Characters measure what Studio assembled. Tokens come from the provider. Cache counts are not subscription quota percentages; reasoning tokens may be included in output.'}),
      el('h3',{text:'Context sections'}),table((r.sections||[]).map(s=>[s.name,`${number(s.characters)} chars`])),
      ...(metrics.byTool?.length?[el('h3',{text:'Tool results by tool'}),table(metrics.byTool.map(t=>[t.name,`${number(t.resultCharacters)} chars · ${number(t.calls)} calls`]))]:[]),
      r.contentUnavailable?el('p',{role:'status',text:r.contentUnavailable}):null,
      detail('Exact prompt',r.prompt),detail('Exact system instructions',r.systemPrompt),detail('Exact tool definitions',r.toolSchemas),
      el('p',{class:'dim ci-caption',text:'These are the new application-supplied payloads for this turn. A resumed native session also contains its prior conversation or provider-managed compaction. That history, provider-owned instructions and later tool exchanges are not repeated in the prompt shown here. Tool-result character counts cover Studio tools; native web results are managed by the provider.'}),
      ]);
      body.scrollTop=0;
    }catch(error){if(!controller.signal.aborted)replace(body,[button('All requests',()=>loadList()),el('p',{role:'alert',text:error.message})]);}
  }
  await loadList();return dialog;
}
