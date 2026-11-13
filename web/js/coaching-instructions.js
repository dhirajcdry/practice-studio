import { el, replace } from './dom.js';
import { dialogHeader } from './ui/headers.js';
import { createSelect } from './ui/select.js';
import { relativeInterviewDate } from './interview-format.js';
import { icon } from './ui/icon.js';

const SCOPES = [['all','All disciplines'],['coding','Coding'],['lld','Low-level design'],['design','System design']];
const MODES = [['all','All modes'],['practice','Practice'],['mock','Mock interviews'],['review','Reviews']];
const label = (options, value) => options.find(([id]) => id === value)?.[1] || value;
const scopeLabel = rule => `${label(SCOPES,rule.scope)} · ${label(MODES,rule.mode)}`;
const button = (text, onclick, primary = false) => el('button',{type:'button',class:`btn btn--${primary?'primary':'quiet'}`,text,onclick});
let active;

export async function openCoachingInstructions() {
  active?.close();
  const opener = document.activeElement, controller = new AbortController();
  const dialog = el('dialog',{class:'rp-sheet gi-sheet','aria-label':'Coaching instructions'});
  const body = el('div',{class:'rp-scroll gi-body ui-inset'});
  const status = el('p',{class:'dim',role:'status','aria-live':'polite'});
  let state, generation=0, busy=false, pickers=[];
  const disposePickers=()=>{for(const picker of pickers)picker.dispose();pickers=[];};
  async function request(method='GET',data,offset=0) {
    const res=await fetch(`/api/coach/instructions${offset?`?offset=${offset}`:''}`,{method,signal:controller.signal,headers:data?{'content-type':'application/json'}:undefined,body:data?JSON.stringify(data):undefined});
    const result=await res.json();if(!res.ok)throw Error(result.error?.message||'Instructions could not be saved.');return result;
  }
  async function mutate(change) {
    if(busy)return;busy=true;
    dialog.querySelectorAll('button,input,textarea').forEach(n=>n.disabled=true);
    status.textContent='Saving…';
    try {
      await request('PUT',{...change,expectedRevision:state.revision,mutationId:crypto.randomUUID()});
      await load();status.textContent='Saved. Applies to future replies.';
    }catch(error){if(!controller.signal.aborted)status.textContent=`${error.message} Refresh to see the latest instructions before retrying.`;}
    finally{busy=false;dialog.querySelectorAll('button,input,textarea').forEach(n=>n.disabled=false);}
  }
  function historyRow(change) {
    const diff=el('details',{class:'gi-history ui-stack'},[
      el('summary',{},[icon('chevron',14),el('span',{text:`Revision ${change.revision} · ${change.source.actor==='coach'?'Coach':'You'} · ${relativeInterviewDate(change.at)}`})]),
      el('p',{text:change.reason}),
      el('div',{class:'gi-versions'},[['Before',change.before],['After',change.after]].map(([title,rules])=>el('section',{class:'ui-stack'},[
        el('strong',{text:title}),...(rules.length?rules.map(rule=>el('div',{class:'gi-version-rule'},[
          el('span',{class:'dim',text:`${scopeLabel(rule)}${rule.enabled?'':' · Disabled'}`}),el('p',{text:rule.text}),
        ])):[el('p',{class:'dim',text:'No saved instructions.'})]),
      ]))),
      change.source.conversationKey?el('p',{class:'dim gi-source',text:`Source: ${change.source.conversationKey}${change.source.requestId?` · ${change.source.requestId}`:''}`}):null,
      el('div',{class:'gi-actions'},[button('Restore this version',()=>mutate({operation:'restore',restoreRevision:change.revision,reason:`Restored revision ${change.revision} from Settings.`}))]),
    ]);return diff;
  }
  function render() {
    disposePickers();
    const history=el('div',{class:'ui-stack gi-history-list'},state.history.map(historyRow));
    const more=button('Older changes',async()=>{
      if(state.nextOffset===null)return;more.disabled=true;
      try{const page=await request('GET',undefined,state.nextOffset);if(page.revision!==state.revision){status.textContent='Instructions changed. Refresh to see the latest history.';return;}
        history.append(...page.history.map(historyRow));state.nextOffset=page.nextOffset;more.hidden=page.nextOffset===null;
      }catch(error){status.textContent=error.message;}finally{more.disabled=false;}
    });more.hidden=state.nextOffset===null;
    replace(body,[el('p',{class:'dim',text:'Your coach can improve these instructions on its own. Changes guide future replies across providers; every change is saved here and can be reversed.'}),
      el('div',{class:'ui-cluster'},[el('h3',{class:'ui-cluster-content',text:`Instructions · ${state.rules.length}`}),button('Add instruction',()=>edit(),true)]),
      ...state.rules.map(rule=>el('article',{class:'gi-rule ui-stack ui-inset'},[
        el('div',{class:'ui-cluster'},[el('strong',{class:'ui-cluster-content',text:scopeLabel(rule)}),el('span',{class:'dim',text:rule.enabled?'Active':'Disabled'})]),
        el('p',{class:'gi-text',text:rule.text}),
        el('div',{class:'ui-cluster gi-actions'},[button('Edit',()=>edit(rule)),button(rule.enabled?'Disable':'Enable',()=>mutate({operation:'upsert',rule:{...rule,enabled:!rule.enabled},reason:`${rule.enabled?'Disabled':'Enabled'} instruction from Settings.`})),button('Remove',()=>mutate({operation:'remove',ruleId:rule.id,reason:'Removed instruction from Settings.'}))]),
      ])),
      ...(!state.rules.length?[el('p',{class:'dim',text:'No saved coaching instructions. Add one here, or let your coach refine its approach during a conversation.'})]:[]),
      el('div',{class:'ui-cluster'},[el('h3',{class:'ui-cluster-content',text:'Change history'}),state.revision?button('Undo latest change',()=>mutate({operation:'restore',restoreRevision:state.revision-1,reason:'Undid the latest change from Settings.'})):null]),
      history,...(!state.history.length?[el('p',{class:'dim',text:'No changes yet.'})]:[]),more,
      el('p',{class:'dim gi-caption',text:'Instructions customize teaching. Permissions, privacy, truthful reporting and interview evidence remain protected.'}),status,
    ]);
  }
  function edit(rule) {
    disposePickers();
    const scope=createSelect({label:'Discipline',options:SCOPES,value:rule?.scope||'all'});
    const mode=createSelect({label:'Mode',options:MODES,value:rule?.mode||'practice'});pickers=[scope,mode];
    const area=el('textarea',{class:'gi-input',rows:'6',maxlength:'2000','aria-label':'Coaching instruction',placeholder:'Explain the intuition before showing code.'});area.value=rule?.text||'';
    const reason=el('input',{class:'gi-input',maxlength:'2000','aria-label':'Reason for change',placeholder:'Why this helps (optional)'});
    replace(body,[el('button',{type:'button',class:'btn btn--quiet gi-back',onclick:render},[icon('back',14),'Back to instructions']),el('h3',{text:rule?'Edit instruction':'Add instruction'}),
      el('div',{class:'ui-cluster'},[scope,mode]),area,reason,
      button('Save instruction',()=>{if(!area.value.trim()){status.textContent='Write an instruction first.';area.focus();return;}
        void mutate({operation:'upsert',rule:{id:rule?.id||`instruction-${crypto.randomUUID()}`,scope:scope.value,mode:mode.value,text:area.value.trim(),enabled:rule?.enabled??true},reason:reason.value.trim()||'Coaching instruction edited in Settings.'});},true),status]);area.focus();
  }
  async function load() {
    const version=++generation;
    try{const result=await request();if(version!==generation||controller.signal.aborted)return;state=result;render();}
    catch(error){if(!controller.signal.aborted){status.textContent=error.message;if(!body.contains(status))replace(body,[status]);}}
  }
  dialog.append(dialogHeader({title:'Coaching instructions',subtitle:'How your coach adapts to you',closeLabel:'Close coaching instructions',onClose:()=>dialog.close(),actions:[button('Refresh',()=>load())]}),body);
  dialog.addEventListener('close',()=>{controller.abort();disposePickers();dialog.remove();if(active===dialog)active=null;if(opener?.isConnected)opener.focus();});
  dialog.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();dialog.close();}});
  document.body.append(dialog);active=dialog;dialog.showModal();await load();return dialog;
}
