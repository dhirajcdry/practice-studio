// Browser half of check:visual. Every setup has a visible-state assertion: a missing
// menu or an unopened detail must fail the audit instead of producing a clean screenshot.
import { checkSidebar } from './check-sidebar.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { visualLint } from './visual-lint.js';
import { setTimeout as sleep } from 'node:timers/promises';

export async function runVisualAudit({ origin, target, output }) {
  // check:visual copies this neutral fixture into the scratch STUDIO_HOME as collection.json.
  const collectionFixture = JSON.parse(await fsp.readFile(new URL('../server/test/fixtures/collection.json', import.meta.url), 'utf8'));
  const collectionCount = new Set(collectionFixture.problems.map(problem => problem.slug)).size;
  const lint = `return (${visualLint.toString()})();`;
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (request) {
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(Error(message.error.message));
      else request.resolve(message.result);
    }
    if (message.method === 'Fetch.requestPaused') {
      const { requestId, request: paused } = message.params;
      const allowed = paused.url.startsWith(`${origin}/`) || /^(data:|blob:|about:)/.test(paused.url);
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
        requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }),
      }).catch(() => {}); // Closing the browser may cancel an outstanding request.
    }
  });
  const evaluate = async body => {
    const result = await send('Runtime.evaluate', {
      expression: `(async () => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const visible = node => node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[hidden]');
        const need = selector => { const node = document.querySelector(selector); if (!visible(node)) throw Error('Missing visible state: ' + selector); return node; };
        // A tab's text includes its count badge ("Submissions2"); match the label, not the badge.
        // No backslashes: this runs from inside a template literal, which would eat them.
        const clickText = (selector, text) => { const node = [...document.querySelectorAll(selector)].find(n => visible(n) && n.textContent.trim().replace(/[ 0-9]+$/, '') === text); if (!node) throw Error('Missing control: ' + text); node.click(); };
        ${body}
      })()`, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression, label) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(`return !!(${expression});`)) return;
      await sleep(100);
    }
    throw Error(`Timed out waiting for ${label}`);
  };
  // In the wide workspace the floating launcher is intentionally hidden; the rail
  // owns the same toggle. Preserve the open state when a route restores it.
  const coach = `if (!document.querySelector('.coach-bar')?.getClientRects().length) {
    let toggle = null;
    for (let attempt = 0; attempt < 20 && !toggle; attempt++) {
      const selector = document.body.classList.contains('ws-wide') ? '[data-pane="coach"]' : '.coach-launch';
      const candidate = document.querySelector(selector);
      if (visible(candidate)) toggle = candidate;
      else await sleep(100);
    }
    if (!toggle) throw Error('Missing visible coach toggle');
    toggle.click();
  }
  await sleep(300); need('.coach-bar'); clickText('.coach-tab', 'Chat');`;
  const submissions = `${coach} clickText('.coach-tab', 'Submissions'); await sleep(400); need('.submission-row');`;
  const editor = `const inst = window.monaco.editor.getEditors()[0]; if (!inst) throw Error('No editor'); inst.focus();`;
  const problem = '/#/p/jump-game';
  const learnerRun = `need('.ui-screen-header .ws-run').click(); for (let i=0; i<100 && !document.querySelector('.rr-case'); i++) await sleep(50); need('.rr-case');`;
  const tutorRun = `const api = await import('/js/api.js'); if (!api.simulateRun) throw Error('Tutor fixture requires simulated run'); const raw = await api.runCode('jump-game', ''); await (await import('/js/coach-actions.js')).applyAction({ id: crypto.randomUUID(), slug: 'jump-game', refresh: 'run', run: raw });`;
  const tutorSpacing = `
    const banner=need('.rr-tutor'), body=need('.rr-body'), tabs=need('.rr-tabs');
    const b=banner.getBoundingClientRect(), p=body.getBoundingClientRect(), t=tabs.getBoundingClientRect();
    const inset=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-4'));
    const gap=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-3'));
    if (b.left-p.left < inset-1 || p.right-b.right < inset-1 || b.top-t.bottom < gap-1) throw Error('Tutor notice is flush with the result pane');
    for (const child of [need('.rr-tutor-copy'), ...banner.querySelectorAll('button')]) {
      const c=child.getBoundingClientRect();
      if (c.left-b.left < gap-1 || b.right-c.right < gap-1 || c.top-b.top < gap-1 || b.bottom-c.bottom < gap-1) throw Error('Tutor notice content lacks internal padding');
    }
    const copy=need('.rr-tutor-copy').getBoundingClientRect(), button=banner.querySelector('button');
    if (button) { const action=button.getBoundingClientRect(); if (action.left < copy.right+gap-1 && action.top < copy.bottom+gap-1) throw Error('Tutor notice action crowds the text'); }
    const title=need('.rr-tutor-mark').getBoundingClientRect(), description=need('.rr-tutor-what').getBoundingClientRect();
    if (description.top-title.bottom < 3) throw Error('Tutor notice text lacks vertical separation');
    const error=document.querySelector('.rr-tutorbody > .state');
    if (error) { const e=error.getBoundingClientRect(); if (Math.abs(e.left-b.left)>1 || Math.abs(e.right-b.right)>1) throw Error('Nested tutor error does not share the notice inset'); }
  `;
  // The case form: every label sits in one column and every field starts at the same edge.
  const caseForm = `
    const pane = need('.ws-results').getBoundingClientRect();
    const fields = [...document.querySelectorAll('.tc-panel .tc-field')].filter(visible);
    if (!fields.length) throw Error('No case fields');
    const lefts = new Set(fields.map(f => Math.round(f.querySelector('.tc-input').getBoundingClientRect().left)));
    if (lefts.size !== 1) throw Error('Case fields do not share a left edge: ' + [...lefts].join(','));
    for (const f of fields) { const r = f.getBoundingClientRect(); if (r.right > pane.right + 1) throw Error('Case field overflows the pane'); }
    if (need('.ws-results').scrollWidth > need('.ws-results').clientWidth + 1) throw Error('Case panel scrolls sideways');`;
  // Result tab: the verdict first, never pinned over a case; one case at a time from tabs;
  // values as labelled rows sharing one left edge; no sideways scroll.
  const resultLayout = `
    const pane = need('.ws-results'), summary = need('.rr-summary').getBoundingClientRect();
    if (pane.scrollWidth > pane.clientWidth + 1) throw Error('Result panel scrolls sideways');
    if (getComputedStyle(need('.rr-summary')).position === 'sticky') throw Error('The verdict is pinned over the cases');
    const tabs = need('.rr-casetabs').getBoundingClientRect();
    if (tabs.top < summary.bottom - 1) throw Error('The case tabs sit under the verdict');
    if (document.querySelectorAll('.rr-case').length !== 1) throw Error('More than one case is on screen');
    const lefts = new Set([...document.querySelectorAll('.rr-case .rr-value')].map(v => Math.round(v.getBoundingClientRect().left)));
    if (lefts.size > 1) throw Error('Result values do not share a left edge');
    const tone = getComputedStyle(need('.rr-casetab.is-on .rr-dot')).backgroundColor;
    const why = getComputedStyle(need('.rr-why strong')).color;
    if (tone !== why) throw Error('The selected tab and its reason disagree on status colour');`;
  // The results pane is short; these states scroll it to the end so the rows and footer show.
  const scrollEnd = `await sleep(100); need('.ws-results').scrollTop = 1e6;`;
  // A run whose output is tree nodes where values were expected, through the real panel body.
  const nodeRun = `clickText('.rr-tab', 'Result');
    const run = await import('/js/run.js');
    const look = (i, input, expected, values) => ({ index: i, input, expected, actual: '[' + values.map(v => 'TreeNode(' + v + ')').join(', ') + ']', passed: null, ms: 30 + i,
      note: 'Your code returned a TreeNode, which cannot be compared automatically.' });
    run.renderRunResult(need('.rr-body'), run.shapeRunResult({ ok: true, summary: { totalMs: 158 }, cases: [
      look(0, '[1,2,3,null,5,null,4]', '[1,3,4]', [1, 3, 4]), look(1, '[1,2,3,4,null,null,null,5]', '[1,3,4,5]', [1, 3, 4, 5]),
      look(2, '[1,null,3]', '[1,3]', [1, 3]), { index: 3, input: '[]', expected: '[]', actual: '[]', passed: true, ms: 35 }] }), { params: ['root'] });`;
  const historySpacing = `
    for (const row of document.querySelectorAll('.recent-chat')) {
      if (!visible(row)) continue;
      const card=row.getBoundingClientRect(), arrow=row.querySelector('.recent-chevron').getBoundingClientRect();
      const title=row.querySelector('.recent-title').getBoundingClientRect();
      if (card.right-arrow.right < 11 || arrow.left-title.right < 11) throw Error('History arrow lacks edge or text spacing');
      const style=getComputedStyle(row);
      const center=card.top+parseFloat(style.borderTopWidth)+(card.height-parseFloat(style.borderTopWidth)-parseFloat(style.borderBottomWidth))/2;
      if (Math.abs((arrow.top+arrow.bottom)/2-center)>1) throw Error('History arrow is not centered within the row borders');
    }
  `;
  const lldSelection = {
    url: '/#/lld',
    // The track home renders after its three saved-record requests; wait for the row
    // before opening it, so a late insert cannot move it after scrollIntoView.
    setup: `for (let i=0; i<100 && !document.querySelector('.th-box--mock .th-pick[data-slug]'); i++) await sleep(50);
      await document.fonts.ready; await new Promise(requestAnimationFrame);
      need('.th-box--mock .th-pick[data-slug]').click();`,
    ready: '.th-box--mock .th-pick[data-slug][aria-pressed="true"]',
    assert: `const c=need('.th-box--mock .ci-start').getBoundingClientRect();
      if (c.left<0 || c.right>innerWidth || c.top<0 || c.bottom>innerHeight) throw Error('LLD Start is outside the viewport');`,
  };
  const editorEdges = {
    url:'/#/lld/practice/lld-locker/visual-practice-lld', ready:'.pr-editor .monaco-editor',
    setup:`for(let i=0;i<120&&!document.querySelector('.pr-editor .monaco-editor');i++)await sleep(50);const editor=window.monaco.editor.getEditors()[0];editor.setValue(['class Booking:','    def verify(self):',...Array.from({length:1240},(_,i)=>'        value_'+i+' = '+i)].join(String.fromCharCode(10)));editor.updateOptions({fontSize:20,wordWrap:'off'});editor.setPosition({lineNumber:1110,column:9});editor.revealLineInCenter(1110);await sleep(180);need('.pr-work').scrollIntoView({block:'center'});`,
  };
  const tutorMarks = {
    url: '/#/lld/practice/lld-locker/visual-practice-lld',
    width: 1440, height: 1000, ready: '.pr-editor .monaco-editor',
    setup: `for(let i=0;i<120&&!document.querySelector('.pr-editor .monaco-editor');i++)await sleep(50);const editor=window.monaco.editor.getEditors()[0];const {createMonacoTutor}=await import('/js/coach-actions.js');const tutor=createMonacoTutor(editor,window.monaco);editor.getModel().setValue(['class Locker:','    def reserve(self, package):','        self.package = package','        self.expires_at = now() + 7','', '    def release(self):','        self.package = None',...Array.from({length:40},(_,i)=>'# additional context '+i)].join(String.fromCharCode(10)));tutor.markLines({from:2,to:4,tone:'bug',note:'The compartment owns the expiry policy and reads the wall clock. Pass expires_at into this method, and inject a clock so expiry can be tested.'});tutor.markLines({from:6,to:7,tone:'good',note:'Keep the reset in one method so each release follows the same state transition.'});editor.setScrollTop(0);editor.layout();need('.pr-work').scrollIntoView({block:'center'});`,
    assert: `for(const outer of document.querySelectorAll('.tutor-note')){const body=outer.querySelector('.tutor-note-body'),text=outer.querySelector('.tutor-note-text');const a=outer.getBoundingClientRect(),b=body.getBoundingClientRect(),t=text.getBoundingClientRect();if(b.bottom>a.bottom+1||t.bottom>b.bottom+1||body.scrollWidth>body.clientWidth+1)throw Error('Tutor note overflows its reserved space');}`,
  };  const practiceMode = label => `{
    const draft=document.querySelector('.pr-typed textarea');draft.value='';draft.dispatchEvent(new Event('input'));
    const modeSwitch=document.querySelector('.pr-compose .ui-mode-switch[data-mode="${label === 'Voice' ? 'voice' : 'typed'}"]');
    if(modeSwitch&&!modeSwitch.hidden){modeSwitch.click();await sleep(80);}
  }`;
  const contextFixture = `
    const prompt='## Problem\\nDesign booking.\\n## Current work\\n'+Array.from({length:90},(_,i)=>'line '+i+': candidate evidence').join('\\n');
    const fixture={id:'visual-context',at:new Date().toISOString(),provider:'codex',model:'Fixture coach',discipline:'lld',status:'complete',reasoningEffort:'high',prompt,systemPrompt:'Fixture interview instructions',toolSchemas:'[]',input:{promptCharacters:prompt.length,systemCharacters:30,toolSchemaCharacters:2},sections:[{name:'Problem',characters:36},{name:'Current work',characters:prompt.length-36}],usage:{inputTokens:1234,cacheReadInputTokens:800,cacheCreationInputTokens:null,outputTokens:90,inputTokenScope:'total'},toolSession:{calls:2,resultCharacters:345,repeatedReads:1,byTool:[{name:'read_context',calls:2,resultCharacters:345}]}};
    const original=window.fetch;window.fetch=async(...args)=>String(args[0]).startsWith('/api/coach/context')?new Response(JSON.stringify(String(args[0]).includes('?id=')?{request:fixture}:{requests:[fixture],retention:'Synthetic audit fixture; exact request content retained in memory.'}),{headers:{'content-type':'application/json'}}):original(...args);
    await (await import('/js/context-inspector.js')).openContextInspector();
  `;
  const contextDetail = contextFixture+`need('.ci-request').click();for(let i=0;i<100&&!document.querySelector('.ci-source');i++)await sleep(25);`;
  const guidanceFixture = `
    const rule={id:'intuition',scope:'coding',mode:'practice',text:'Explain intuition before code. Ask me to identify the invariant before suggesting an implementation.',enabled:true};
    const fixture={revision:1,rules:[rule],history:[{revision:1,at:new Date().toISOString(),source:{actor:'coach',conversationKey:'coding:two-sum:visual-audit'},reason:'The learner benefits from connecting the invariant to a concrete example.',before:[],after:[rule]}],nextOffset:null};
    const original=window.fetch;window.fetch=async(...args)=>String(args[0]).startsWith('/api/coach/instructions')?new Response(JSON.stringify(fixture),{headers:{'content-type':'application/json'}}):original(...args);
    await(await import('/js/coaching-instructions.js')).openCoachingInstructions();
  `;
  const voiceFixture = (state, extra = '') => ({
    url:'/#/lld/practice/lld-locker/visual-practice-lld', ready:'.pr-coach .pr-answer',
    setup: `${practiceMode('Voice')}
      const {createVoicePanel,answerModeSwitch,micToggle,paintMicToggle}=await import('/js/ui/voice-panel.js');
      const panel=createVoicePanel({onEdit:()=>{},role:'Coach'});
      const fixtureMic=micToggle(()=>{});paintMicToggle(fixtureMic,'${state}'==='recording');
      panel.setControls({lead:[fixtureMic],actions:[answerModeSwitch('typed',()=>{})]});
      const host=need('.pr-voice');host.replaceChildren(panel.root);
      panel.update({state:'${state}',draft:'I would check that the reservation belongs to the caller before changing it.',partial:'Then validate the time range'});
      panel.level({level:.65,elapsedMs:19200,sinceLoud:200,pending:0});
      ${extra}
      if(['preparing','speaking'].includes(panel.root.dataset.state)){
        const interrupt=document.createElement('button');interrupt.className='btn btn--secondary btn--sm';interrupt.textContent='Interrupt · Esc';
        panel.setControls({lead:[fixtureMic],actions:[interrupt]});
      }
      panel.root.scrollIntoView({block:'nearest'});`,
    assert:`const panel=need('.voice-panel').getBoundingClientRect(), node=document.querySelector('.voice-transcript');
      if(visible(node)){const draft=node.getBoundingClientRect();if(draft.height>145||draft.left<panel.left||draft.right>panel.right+1)throw Error('Voice draft is not contained');}
      else need('.voice-state');
      if(document.scrollingElement.scrollWidth>innerWidth+1)throw Error('Voice caused horizontal overflow');`,
  });
  const practiceSaveFailure = width => ({
    url: '/#/lld/practice/lld-locker/visual-practice-lld', width, ready: '.pr-coach .pr-answer',
    setup: `for(let i=0;i<100&&!window.monaco?.editor.getModels().length;i++)await sleep(50);
      const original=window.fetch;window.fetch=(url,options)=>options?.method==='PUT'&&String(url).startsWith('/api/practice/')?Promise.reject(new TypeError('Failed to fetch')):original(url,options);
      monaco.editor.getModels()[0].setValue('# Unsaved work\\nclass Locker: pass');
      for(let i=0;i<100&&document.querySelector('.pr-work-error').hidden;i++)await sleep(50);`,
    assert: `if(need('.pr-work-error').hidden||need('.pr-save').textContent!=='Not saved')throw Error('Save failure not shown');
      if(!document.querySelector('.pr-compose .pr-error').hidden)throw Error('Save error leaked into coach');
      const notice=need('.pr-work-error').getBoundingClientRect(),work=need('.pr-work').getBoundingClientRect();
      if(notice.left<work.left||notice.right>work.right+1||document.documentElement.scrollWidth>innerWidth)throw Error('Save error overflows workspace');`,
  });
  const modelEffort = {
    url: '/#/lld/practice/lld-locker/visual-practice-lld', ready: '.pr-coach .coach-model-select button:not(:disabled)',
    setup: `${practiceMode('Typed')}
      for(let i=0;i<100&&document.querySelector('.pr-coach .coach-model-select button')?.disabled;i++)await sleep(50);
      await sleep(50);
      const original = window.fetch;
      window.fetch = (url, options) => String(url) === '/api/coach/models'
        ? Promise.resolve(new Response(JSON.stringify({selected:{provider:'codex',model:'astra',reasoningEffort:'xhigh'},providers:[
          {id:'codex',label:'Codex',models:[{id:'astra',label:'GPT-6 Astra',reasoningEfforts:['low','medium','high','xhigh','max','ultra']}]}
        ]}),{headers:{'content-type':'application/json'}})) : original(url, options);
      const {createCoachModelPicker} = await import('/js/coach-model.js');
      const picker = createCoachModelPicker({compact:true});
      need('.pr-coach .coach-model-picker').replaceWith(picker.root);
      for(let i=0;i<100&&!picker.root.querySelector('.coach-model-select button')?.textContent.includes('Extra high');i++)await sleep(50);
      need('.pr-coach .coach-model-select button:not(:disabled)');
      need('.pr-coach').scrollIntoView({block:'center'});
      await document.fonts.ready;await sleep(150);`,
    assert: `for(const b of need('.pr-coach .coach-model-picker').querySelectorAll('button')) {
      if(!visible(b))continue;const r=b.getBoundingClientRect();
      if(r.left<0||r.right>innerWidth+1)throw Error('Model or effort control overflows');
    }
    if(!need('.pr-coach .coach-model-select button').textContent.includes('Extra high'))throw Error('Selected effort missing');`,
  };
  // Turn fixtures only render local made-up data; no provider or picture job is started.
  const turnState = state => ({ url: problem, ready: '.coach-log .ui-turn', setup: `${coach}
    const {createReply,questionNode,threadStrip}=await import('/js/ui/turn.js');
    const {renderCoachText}=await import('/js/coach.js');
    const log=need('.coach-log');
    const at='2025-01-14T14:33:00Z';
    const question='Why does this queue contain the same cell twice?';
    const reply=createReply({speaker:'Coach',meta:'Example model',startedAt:new Date(Date.now()-6000).toISOString()});
    const read={display:{doing:'Reading your coaching rules',done:'Read your coaching rules',effect:'read'},effect:'read',ms:2000};
    const note={display:{doing:'Saving a private note',done:'Saved a private note',effect:'note'},effect:'note',ms:1000};
    log.replaceChildren(questionNode({text:question,at}),reply.node);
    const host=need('.coach-bar').nextElementSibling;host.hidden=false;host.replaceChildren(threadStrip({title:question,startedAt:at,turns:1}));
    const state=${JSON.stringify(state)};
    reply.setActivity(state==='note-only'?[read,note]:[read],{live:state==='working'});
    const text=state==='working'||state==='failed'?'':state==='note-only'?'I saved a note.':state==='stopped'?'Start with every source in the queue. Then, level by':state==='long'||state==='jump'?Array(35).fill('Mark each cell when you enqueue it. This prevents two parents from adding the same neighbour.').join('\\n\\n'):'Mark each cell when you enqueue it. Both parents otherwise add the same neighbour before either copy is processed.';
    renderCoachText(reply.body,text,null,{live:false});
    if(state==='writing')reply.body.dataset.streaming='true';
    if(state==='change'||state==='expanded')reply.setChanges([{id:'fixture-change',title:'Added a test case',detail:'A small grid with two paths to the same cell.',tag:'Undoable',actions:[{label:'View',onClick(){}},{label:'Undo',onClick(){}}],state:'done'}]);
    if(state==='note-only')reply.setNotice({tone:'warn',head:'The coach saved a note and wrote only this.',actions:[{label:'Ask again',onClick(){}}]});
    if(state==='stopped')reply.setNotice({head:'Stopped before it finished'});
    if(state==='failed')reply.setNotice({tone:'err',head:'The coach could not answer',body:'The connection ended before an answer arrived.',actions:[{label:'Ask again',onClick(){}}]});
    if(!['working','writing'].includes(state))reply.finish({at,durationMs:41000});
    if(state==='expanded')reply.node.querySelector('.ui-turn-activity button').click();
    if(state==='restored'){
      const earlier=createReply({speaker:'Coach',meta:'Example model'});renderCoachText(earlier.body,'Start by listing the initial sources.',null,{live:false});earlier.finish({at,durationMs:12000});
      log.prepend(questionNode({text:'How should I start the queue?',at}),earlier.node);
      host.replaceChildren(threadStrip({title:'How should I start the queue?',startedAt:at,turns:2}));
    }
    if(state==='long'){log.scrollTop=180;await sleep(100);need('.ui-pinned-question');}
    if(state==='jump'){log.scrollTop=180;await sleep(100);need('.ui-jump-latest').hidden=false;}
  `, assert: `const reply=need('.coach-log .ui-turn');
    if(reply.scrollWidth>reply.clientWidth+1)throw Error('Turn overflows');
    const body=reply.querySelector('.ui-turn-body'),foot=reply.querySelector('.ui-turn-foot');
    if(!body.textContent.trim()&&foot)throw Error('Empty reply exposes Copy');
    const head=need('.ui-turn-head').getBoundingClientRect(),activity=reply.querySelector('.ui-turn-activity');
    if(!activity.hidden&&activity.getBoundingClientRect().top<head.bottom)throw Error('Activity overlaps speaker');
    for(const turn of document.querySelectorAll('.coach-log .ui-turn'))if(turn.querySelectorAll('.ui-turn-activity-line').length>1)throw Error('A reply has more than one activity line');
    const pill=document.querySelector('.ui-jump-latest');
    if(pill&&!pill.hidden){const p=pill.getBoundingClientRect(),c=need('.coach-compose').getBoundingClientRect(),l=need('.coach-log').getBoundingClientRect();if(p.height<20||p.bottom>c.top||p.top<l.top)throw Error('Jump to latest is not floating above the composer');if(Math.abs((p.left+p.right)/2-(l.left+l.right)/2)>2)throw Error('Jump to latest is off centre');}
  ` });
  const conversationAssertions = `
    const bodies=[...document.querySelectorAll('.ui-conversation-text')];
    if(!bodies.some(n=>n.querySelector('code')?.textContent==='get_balance') || !bodies.some(n=>n.querySelector('strong')))throw Error('Reply Markdown is visible as plain text');
    for(const body of bodies){
      const style=getComputedStyle(body),box=body.getBoundingClientRect();
      if(parseFloat(style.fontSize)>14.1 || parseFloat(style.lineHeight)>23)throw Error('Transcript type is too large');
      const last=body.lastElementChild;if(last && box.bottom-last.getBoundingClientRect().bottom>13)throw Error('Trailing blank lines create a transcript gap');
      if(body.scrollWidth>body.clientWidth+1)throw Error('Conversation body overflows');
    }
    const entries=[...document.querySelectorAll('.ci-entry,.dz-entry')];
    for(let i=1;i<entries.length;i++)if(entries[i].getBoundingClientRect().top-entries[i-1].getBoundingClientRect().bottom>20)throw Error('Transcript turn gap is too large');
  `;
  const feedbackAssertions = `
    const body=need('.pr-feedback .ui-conversation-text'), log=need('.pr-thread');
    const heads=[...body.querySelectorAll('h2,h3')];
    if(heads.length<4 || !body.querySelector('ol') || !body.querySelector('pre') || !body.querySelector('table'))throw Error('Feedback fixture is incomplete');
    for(const heading of heads.slice(1)) {
      const previous=heading.previousElementSibling;
      if(heading.getBoundingClientRect().top-previous.getBoundingClientRect().bottom<15)throw Error('Feedback sections lack breathing room');
    }
    for(const list of body.querySelectorAll('ul,ol')) {
      if(parseFloat(getComputedStyle(list).paddingInlineStart)<20)throw Error('Feedback bullets escape their reading inset');
      if(list.getBoundingClientRect().top-list.previousElementSibling.getBoundingClientRect().bottom<7)throw Error('Feedback list runs into preceding paragraph');
    }
    if(body.scrollWidth>body.clientWidth+1 || document.documentElement.scrollWidth>innerWidth)throw Error('Feedback overflows');
    const rect=log.getBoundingClientRect(),header=need('.pr-coach-head').getBoundingClientRect();
    if(rect.top-header.bottom<7)throw Error('Scrolled text touches the fixed coach header');
    const pane=need('.pr-coach').getBoundingClientRect();
    if(rect.left-pane.left<15 || pane.right-rect.right<15)throw Error('Reading viewport lacks exterior side gutters');
    if(!log.matches(':focus-visible') || parseFloat(getComputedStyle(log).outlineWidth)<1)throw Error('Keyboard reading focus is missing');
    if(parseFloat(getComputedStyle(log).outlineOffset)<0)throw Error('Keyboard focus paints over scrolled text');
    if(parseFloat(getComputedStyle(body).fontSize)>14.1)throw Error('Feedback bypasses conversation typography');
  `;
  const feedbackState = (width, scrolled=false) => ({
    url:'/#/lld/practice/lld-locker/visual-branch-lld', width, height:900, ready:'.pr-feedback', keyboardFocus:'.pr-thread',
    setup:`need('.pr-problem').open=true;need('.pr-coach').scrollIntoView({block:'center'});const log=need('.pr-thread');log.scrollTop=${scrolled ? 240 : 0};log.focus({preventScroll:true});`,
    assert:feedbackAssertions + (scrolled ? `if(need('.pr-thread').scrollTop<200)throw Error('Feedback did not scroll');` : ''),
  });
  const mockTimeSetup = `for(let i=0;i<100&&document.querySelector('.mock-add-time')?.disabled;i++)await sleep(50);need('.ci-clock').textContent='+03:00';need('.mock-add-time').click();`;
  const mockCustomSetup = `${mockTimeSetup} [...document.querySelectorAll('.ui-menu-item')].find(n=>n.textContent.includes('Custom')).click();`;
  const importPreview = `need('#problem-url').value='https://leetcode.com/problems/import-sample/description/'; need('.import-form').requestSubmit(); for(let i=0;i<100&&!document.querySelector('.import-save');i++)await sleep(100);need('.import-save');`;
  // Solution and Article are tabs of the problem pane: the solution replaces the statement
  // inside .pcol, the statement stays in the DOM, and Problem brings it back without a fetch.
  const referenceTab = { url: problem, setup: `for (let i = 0; i < 100 && !document.querySelector('#ref-problem .stmt'); i++) await sleep(50);
      need('#ref-problem .stmt'); window.__stmt = need('#ref-problem'); window.__stmtFetches = 0;
      const originalFetch = window.fetch; window.fetch = (...args) => { if (/\\/api\\/problems\\/jump-game(\\?|$)/.test(String(args[0]))) window.__stmtFetches++; return originalFetch(...args); };
      need('[data-panel="solution"]').click();`, ready: '.pcol .ref-tab[data-panel="solution"] pre.solutioncode', assert: `
      const tab = name => need('.problem-tabs [role=tab][data-panel="' + name + '"]');
      const pane = need('.pcol'), stmt = document.querySelector('#ref-problem'), solution = need('.ref-tab[data-panel="solution"]');
      if (!pane.contains(solution) || !visible(solution)) throw Error('Solution is not shown inside the problem pane');
      if (document.querySelector('#drawer,.drawer,.scrim')) throw Error('The reference drawer is still in the page');
      if (stmt !== window.__stmt || !stmt.isConnected || visible(stmt) || visible(document.querySelector('.pcol .ptags'))) throw Error('Statement must stay in the DOM, hidden');
      if (tab('solution').getAttribute('aria-selected') !== 'true' || tab('problem').getAttribute('aria-selected') !== 'false') throw Error('Solution tab is not the selected one');
      if (!need('.ref-tab .copy').textContent.includes('Copy')) throw Error('Copy button missing');
      tab('problem').click(); await sleep(50);
      if (document.querySelector('#ref-problem') !== window.__stmt || !visible(stmt) || !stmt.querySelector('.stmt') || visible(solution)) throw Error('Problem did not restore the same statement');
      if (tab('problem').getAttribute('aria-selected') !== 'true') throw Error('Problem tab is not selected after switching back');
      if (window.__stmtFetches) throw Error('Switching back refetched the statement');
      tab('solution').click(); await sleep(50);
      if (!visible(solution) || visible(stmt)) throw Error('Solution did not come back');` };
  const states = {
    importEmpty: { url: '/#/add', ready: '.import-form' },
    importPreview: { url: '/#/add', ready: '.import-form', setup: importPreview },
    importNarrow: { url: '/#/add', width: 390, ready: '.import-form', setup: importPreview, assert: `const r=need('.import-preview').getBoundingClientRect(); if(r.right>innerWidth||r.left<0)throw Error('Import preview overflows');` },
    importError: { url: '/#/add', ready: '.import-form', setup: `need('#problem-url').value='https://example.com/problems/sample/';need('.import-form').requestSubmit();for(let i=0;i<100&&need('.import-status').textContent==='Loading problem…';i++)await sleep(50);`, assert: `if(!need('.import-status').textContent.includes('Use a URL'))throw Error('Missing invalid URL error');` },
    importSaved: { url: '/#/add', ready: '.catalog', setup: `${importPreview} need('.import-save').click();for(let i=0;i<100&&!location.hash.startsWith('#/p/');i++)await sleep(100);if(location.hash!=='#/p/import-sample')throw Error('Import did not open');location.hash='#/';await sleep(400);`, assert: `if(!document.querySelector('.prow[data-slug="import-sample"]'))throw Error('Imported problem missing from Added by you');` },
    mockTimeMenu: { url: '/#/lld/lld-locker/1760000000000-00000009', ready: '.ci-panel', setup: mockTimeSetup, assert: `need('.ui-menu-item');` },
    mockTimeCustom: { url: '/#/lld/lld-locker/1760000000000-00000009', ready: '.ci-panel', setup: mockCustomSetup, assert: `if(!visible(need('.mock-time-input')))throw Error('Custom minutes hidden');` },
    mockTimeCustomNarrow: { url: '/#/lld/lld-locker/1760000000000-00000009', width: 390, ready: '.ci-panel', setup: `need('.lld-interviewer').scrollIntoView({block:'center'}); ${mockCustomSetup}`, assert: `const r=need('.mock-time-custom').getBoundingClientRect();if(r.right>innerWidth||r.left<0)throw Error('Custom minutes overflow');` },

    conversationLLD: { url: '/#/lld/lld-locker/1760000000000-00000011', width: 1440, height: 900, ready: '.ci-text code', assert: conversationAssertions },
    conversationLLDNarrow: { url: '/#/lld/lld-locker/1760000000000-00000011', width: 390, ready: '.ci-text code', setup: `for(let i=0;i<100&&!document.querySelector('.ci-text code');i++)await sleep(50);need('.lld-interviewer').scrollIntoView({block:'center'});`, assert: conversationAssertions },
    conversationDesign: { url: '/#/design/2026-11-04T12-00-00-000Z', width: 1440, height: 900, ready: '.dz-log .ui-conversation-text code', assert: conversationAssertions },
    conversationDesignNarrow: { url: '/#/design/2026-11-04T12-00-00-000Z', width: 390, ready: '.dz-log .ui-conversation-text code', setup: `for(let i=0;i<100&&!document.querySelector('.dz-log .ui-conversation-text code');i++)await sleep(50);need('.dz-side').scrollIntoView({block:'center'});`, assert: conversationAssertions },
    modelEffort,
    modelEffortNarrow: {...modelEffort,width:390},
    modelEffortMenu: {...modelEffort,width:390,setup:modelEffort.setup+`need('.pr-coach .coach-model-select button').click();need('[role="menu"]:not([hidden]) [role="menuitemradio"]').click();`,ready:'[role="menu"][aria-label$="thinking level"]:not([hidden])',assert:modelEffort.assert+`const option=need('[role="menu"]:not([hidden]) [role="menuitemradio"]');if(option.disabled||!option.textContent.includes('Model default'))throw Error('Model default is unavailable');`},
    practiceSaveFailure: practiceSaveFailure(1440),
    practiceSaveFailureNarrow: practiceSaveFailure(390),
    voiceListening:voiceFixture('recording'),
    voiceListeningNarrow:{...voiceFixture('recording'),width:390},
    voiceLongAnswer:voiceFixture('recording', `panel.update({draft:'We must validate ownership before mutating the reservation. '.repeat(80)});`),
    voiceAnswerHeld:voiceFixture('recording', `panel.update({held:true,partial:''});panel.level({level:.1,sinceLoud:4000,pending:0});`),
    voicePreparing:voiceFixture('recording', `panel.update({draft:'',partial:'',busy:true});panel.playback({phase:'preparing',text:'What happens if two callers try to book the same room?',engine:'natural'});`),
    voiceSpeaking:voiceFixture('recording', `panel.update({draft:'',partial:''});panel.playback({phase:'speaking',text:'What happens if two callers try to book the same room?',engine:'natural'});`),
    voiceSpeakingNarrow:{...voiceFixture('recording', `panel.playback({phase:'speaking',text:'Which operation needs to be atomic?',engine:'natural'});`),width:390},
    voiceSystemFallback:voiceFixture('recording', `panel.update({draft:'',partial:''});panel.playback({phase:'speaking',text:'Which operation needs to be atomic?',engine:'system'});`),
    voicePlaybackError:voiceFixture('idle', `panel.update({draft:'',partial:''});panel.playback({phase:'error',message:'The reply is still in the conversation. Try replaying it.'});`),
    pythonEditorEdges: editorEdges,
    pythonEditorEdgesNarrow: {...editorEdges,width:390},
    tutorMarks,
    tutorMarksNarrow: {...tutorMarks,width:390},
    lldBranchReport: { url: '/#/lld/lld-locker/1760000000000-00000010', ready: '.rp-sheet[open]', setup: `for(let i=0;i<100&&!document.querySelector('.ci-open-report');i++)await sleep(50);need('.ci-open-report').click();` },
    lldBranchReportNarrow: { url: '/#/lld/lld-locker/1760000000000-00000010', width:390, ready: '.rp-sheet[open]', setup: `for(let i=0;i<100&&!document.querySelector('.ci-open-report');i++)await sleep(50);need('.ci-open-report').click();` },
    practiceBranch: feedbackState(1440),
    practiceBranchNarrow: feedbackState(390),
    practiceBranchScrolled: feedbackState(1440,true),
    practiceBranchScrolledNarrow: feedbackState(390,true),
    agentActions: { url: '/#/lld/practice/lld-locker/visual-practice-lld', ready: '.pr-coach .pr-answer', setup: `const {showWorkspaceAction}=await import('/js/workspace-tools.js');const {createWorkspaceReply}=await import('/js/ui/workspace-turn.js');const thread=need('.pr-thread');const log=createWorkspaceReply();thread.append(log.node);showWorkspaceAction(log,{id:'visual-code-edit',tool:'edit_code',status:'done',summary:'Edited your code: added cancellation validation while preserving the caller’s reservation and ownership checks.'},{replay:true});showWorkspaceAction(log,{id:'visual-memory',tool:'update_memory',status:'done',summary:'Updated LLD memory with the observed invariant and the next verification exercise.'},{replay:true});showWorkspaceAction(log,{id:'visual-run',tool:'run_code',status:'done',summary:'Ran Python (coach run)',result:{exitCode:0,stdout:'reservation trace '.repeat(40)}},{replay:true});log.finish();log.node.querySelector('.ui-turn-activity-line')?.click();if(log.node.querySelector('details[open]'))throw Error('Successful run output must start collapsed');thread.scrollTop=thread.scrollHeight;` },
    agentActionsNarrow: { url: '/#/lld/practice/lld-locker/visual-practice-lld', width:390, ready: '.pr-coach .pr-answer', setup: `const {showWorkspaceAction}=await import('/js/workspace-tools.js');const {createWorkspaceReply}=await import('/js/ui/workspace-turn.js');const thread=need('.pr-thread');const log=createWorkspaceReply();thread.append(log.node);showWorkspaceAction(log,{id:'visual-code-edit',tool:'edit_code',status:'done',summary:'Edited your code: added cancellation validation while preserving the caller’s reservation and ownership checks.'},{replay:true});showWorkspaceAction(log,{id:'visual-memory',tool:'update_memory',status:'failed',summary:'Update learner memory',message:'The saved note changed. Read it again before replacing this passage.'},{replay:true});log.finish();need('.pr-coach').scrollIntoView({block:'center'});thread.scrollTop=thread.scrollHeight;` },
    practiceLongDraft: { url: '/#/lld/practice/lld-locker/visual-practice-lld', width:1024, height:650, ready: '.pr-coach .pr-answer', setup: `${practiceMode('Typed')} const input=need('.pr-typed textarea'); input.value='A concrete trace through reservation ownership, validation and cancellation. '.repeat(80);input.dispatchEvent(new Event('input'));`, assert: `const c=need('.ui-composer').getBoundingClientRect(),t=need('.pr-thread').getBoundingClientRect();if(c.height>280||t.height<80)throw Error('Long draft consumes conversation');` },
    practiceVoice: { url: '/#/lld/practice/lld-locker/visual-practice-lld', ready: '.pr-coach .pr-answer', setup: practiceMode('Voice'), assert: `if(visible(document.querySelector('.pr-typed')))throw Error('Voice exposes typed input');` },
    practiceLLD: { url: '/#/lld/practice/lld-locker/visual-practice-lld', ready: '.pr-coach .pr-answer', setup: practiceMode('Typed'), assert: conversationAssertions },
    practiceLLDNarrow: { url: '/#/lld/practice/lld-locker/visual-practice-lld', width: 390, ready: '.pr-coach .pr-answer', setup: `${practiceMode('Typed')} for(let i=0;i<100&&!document.querySelector('.pr-coach');i++)await sleep(50);need('.pr-coach').scrollIntoView({block:'center'});`, assert: conversationAssertions },
    practiceDesign: { url: '/#/design/practice/design-url-shortener/visual-practice-design', ready: '.pr-board .excalidraw', assert: conversationAssertions },
    practiceSplitWide: { url: '/#/lld/practice/lld-locker/visual-practice-lld', width: 1440, height: 900, ready: '.pr-coach .pr-answer', setup: `const d=need('.ui-pane-divider,.split.split-col');d.focus();for(let i=0;i<3;i++)d.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await sleep(120);`, assert: `if(need('.ui-pane-divider,.split.split-col').hidden)throw Error('Wide practice divider hidden');if(document.documentElement.scrollWidth>innerWidth)throw Error('Wide practice overflows');` },
    practiceSplitNarrow: { url: '/#/lld/practice/lld-locker/visual-practice-lld', width: 390, height: 844, ready: '.pr-coach .pr-answer', setup: `await sleep(80);`, assert: `const d=document.querySelector('.ui-pane-divider,.split.split-col');if(d&&!d.hidden)throw Error('Narrow practice divider visible');if(document.documentElement.scrollWidth>innerWidth)throw Error('Narrow practice overflows');` },
    practiceDesignSplitWide: { url: '/#/design/practice/design-url-shortener/visual-practice-design', width: 1440, height: 900, ready: '.pr-board .excalidraw', setup: `const d=need('.ui-pane-divider,.split.split-col');d.focus();d.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));await sleep(120);`, assert: `if(need('.ui-pane-divider,.split.split-col').hidden)throw Error('Wide design divider hidden');if(document.documentElement.scrollWidth>innerWidth)throw Error('Wide design overflows');` },
    practiceTimerRunning: { url: '/#/lld/practice/lld-locker/visual-practice-lld', ready: '.pr-timer', setup: `for(let i=0;i<100&&need('.pr-timer button').disabled;i++)await sleep(50);if(need('.pr-timer-label').textContent==='Paused')need('.pr-timer button').click();for(let i=0;i<100&&need('.pr-timer-label').textContent!=='Elapsed';i++)await sleep(50);`, assert: `if(need('.pr-timer-label').textContent!=='Elapsed')throw Error('Timer not running');` },
    practiceTimerPaused: { url: '/#/lld/practice/lld-locker/visual-practice-lld', ready: '.pr-timer', setup: `for(let i=0;i<100&&need('.pr-timer button').disabled;i++)await sleep(50);if(need('.pr-timer-label').textContent==='Elapsed')need('.pr-timer button').click();for(let i=0;i<100&&need('.pr-timer-label').textContent!=='Paused';i++)await sleep(50);`, assert: `if(need('.pr-timer-label').textContent!=='Paused')throw Error('Timer not paused');` },
    learningNotes: { url: '/#/lld', setup: `(await import('/js/learning.js')).openLearningNotes('lld-locker','Locker system');`, ready: '.ln-sheet[open] .ln-evidence' },
    learningNotesNarrow: { url: '/#/lld', width: 390, setup: `(await import('/js/learning.js')).openLearningNotes('lld-locker','A much longer problem title: reservations, ownership, and concurrent allocation');`, ready: '.ln-sheet[open] .ln-evidence' },
    lldLibrary: { url: '/#/lld', ready: '.th-box--mock .th-pick[data-slug]' },
    lldNarrow: { url: '/#/lld', width: 390, ready: '.th-box--mock .th-pick[data-slug]' },
    lldNewMock: { url: '/#/lld', ready: '.th-box--mock .ci-start' },
    lldMockNarrow: { url: '/#/lld', width: 390, ready: '.th-box--mock .ci-start', assert: `need('.th-box--mock [aria-label="Answer mode: Voice"]'); need('.th-box--mock [aria-label^="Target level:"]');` },
    lldSelected: lldSelection,
    lldSelectedNarrow: { ...lldSelection, width: 390 },
    lldLongDocument: { url: '/#/lld/lld-locker/1760000000000-00000009', width: 1024, height: 650, setup: `for(let i=0;i<100 && !document.querySelector('.ci-composer .ui-mode-switch:not(:disabled)');i++) await sleep(50); const log=need('.ci-log'); for(let i=0;i<20;i++){const p=document.createElement('p');p.textContent='Interviewer: How does reservation ownership prevent conflicting updates?';log.append(p);} log.scrollTop=log.scrollHeight;`, ready: '.ci-contained .ci-log' },
    lldDocumentNarrow: { url: '/#/lld/lld-locker/1760000000000-00000009', width: 390, ready: '.lld-workspace .ci-panel', setup: `for(let i=0;i<100 && !document.querySelector('.ci-panel');i++)await sleep(50);need('.lld-interviewer').scrollIntoView({block:'center'});` },
    lldDocument: { url: '/#/lld/lld-locker/1760000000000-00000009', ready: '.lld-workspace .ci-panel' },
    referenceTab,
    // Stacked (below 1081px) the pane sits above the editor; the tabs switch the same way.
    referenceTabNarrow: { ...referenceTab, width: 900 },
    interviewLive: { url: problem, setup: `const originalFetch = window.fetch; window.fetch = async (...args) => { const response = await originalFetch(...args); if (String(args[0]).includes('/api/interview/jump-game/')) { const data = await response.json(); data.startedAt = Date.now(); data.pausedAt = null; data.lastSpeechAt = Date.now(); data.lastTypingAt = Date.now(); return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); } return response; }; const m = await import('/js/interview.js'); m.openInterviewRecord('jump-game', '1760000000000-00000001');`, ready: '.ci-panel[data-mode="typed"] .ci-input', assert: `need('.ci-phases');` },
    interviewVoice: { url: problem, setup: `const originalFetch = window.fetch; window.fetch = async (...args) => { const response = await originalFetch(...args); if (String(args[0]).includes('/api/interview/jump-game/')) { const data = await response.json(); data.startedAt = Date.now(); data.pausedAt = null; data.lastSpeechAt = Date.now(); data.lastTypingAt = Date.now(); return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); } return response; }; const m = await import('/js/interview.js'); m.openInterviewRecord('jump-game', '1760000000000-00000002');`, ready: '.ci-panel[data-mode="voice"] .ci-voice', assert: `if (visible(document.querySelector('.ci-input'))) throw Error('Voice mode exposes text box'); need('.ci-voice .voice-state');` },
    interviewNoResponse: { url: problem, setup: `const originalFetch = window.fetch; window.fetch = async (...args) => { const response = await originalFetch(...args); if (String(args[0]).includes('/api/interview/jump-game/1760000000000-00000003')) { const data = await response.json(); data.completionReason = 'no-response'; data.report = null; delete data.hireSignal; data.turns = data.turns.filter(t => t.kind === 'opening'); return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); } return response; }; (await import('/js/interview.js')).openInterviewRecord('jump-game', '1760000000000-00000003');`, ready: '.ci-empty-session', assert: `if (document.querySelector('.ci-open-report,.ci-mini-dim')) throw Error('Empty interview displays a report');` },
    interviewDebrief: { url: problem, setup: `const m = await import('/js/interview.js'); m.openInterviewRecord('jump-game', '1760000000000-00000003');`, ready: '.ci-panel[data-debriefed="true"] .ci-score-hero', assert: `
      if (document.querySelectorAll('.ci-mini-dim').length !== 4) throw Error('Missing dimensions'); need('.ci-open-report'); need('.ci-transcript');
    ` },
    interviewReport: { url: problem, setup: `const m = await import('/js/interview.js'); m.openInterviewRecord('jump-game', '1760000000000-00000003'); await new Promise(r => { const t = setInterval(() => { const b = document.querySelector('.ci-open-report'); if (b) { clearInterval(t); b.click(); r(); } }, 50); });`, ready: '.rp-sheet[open] .rp-signal', assert: `
      if (document.querySelectorAll('.rp-dim-row').length !== 4) throw Error('Missing dimensions'); need('.rp-track'); need('.rp-practice');
      if (!document.querySelector('.rp-moment-quote q')) throw Error('Verified quote missing');
      if (getComputedStyle(need('.rp-scroll')).scrollbarWidth !== 'thin') throw Error('Report scrollbar is not thin');
    ` },
    interviewReportLower: { url: problem, setup: `const m = await import('/js/interview.js'); m.openInterviewRecord('jump-game', '1760000000000-00000003'); await new Promise(r => { const t = setInterval(() => { const b = document.querySelector('.ci-open-report'); if (b) { clearInterval(t); b.click(); setTimeout(() => { document.querySelector('.rp-dims')?.scrollIntoView({ block: 'start' }); r(); }, 300); } }, 50); });`, ready: '.rp-sheet[open] .rp-signal', assert: `
      if (document.querySelectorAll('.rp-dim-row').length !== 4) throw Error('Missing dimensions'); need('.rp-track'); need('.rp-practice');
      if (!document.querySelector('.rp-moment-quote q')) throw Error('Verified quote missing');
    ` },
    interviewReportCode: { url: problem, setup: `const m = await import('/js/interview.js'); m.openInterviewRecord('jump-game', '1760000000000-00000003'); await new Promise(r => { const t = setInterval(() => { const b = document.querySelector('.ci-open-report'); if (b) { clearInterval(t); b.click(); setTimeout(() => { document.querySelector('.rp-solution')?.scrollIntoView({ block: 'start' }); r(); }, 300); } }, 50); });`, ready: '.rp-sheet[open] .rp-signal', assert: `
      if (document.querySelectorAll('.rp-dim-row').length !== 4) throw Error('Missing dimensions'); need('.rp-track'); need('.rp-practice');
      if (!document.querySelector('.rp-moment-quote q')) throw Error('Verified quote missing');
    ` },
    interviewReportFollowups: { url: problem, setup: `const m = await import('/js/interview.js'); m.openInterviewRecord('jump-game', '1760000000000-00000003'); await new Promise(r => { const t = setInterval(() => { const b = document.querySelector('.ci-open-report'); if (b) { clearInterval(t); b.click(); setTimeout(() => { document.querySelector('.rp-dims')?.scrollIntoView({ block: 'start' }); r(); }, 300); } }, 50); });`, ready: '.rp-sheet[open] .rp-signal', assert: `
      if (document.querySelectorAll('.rp-dim-row').length !== 4) throw Error('Missing dimensions'); need('.rp-track'); need('.rp-practice');
      if (!document.querySelector('.rp-moment-quote q')) throw Error('Verified quote missing');
    ` },
    interviewReportPhone: { width:375, height:844, url: problem, setup: `const m = await import('/js/interview.js'); m.openInterviewRecord('jump-game', '1760000000000-00000003'); await new Promise(r => { const t = setInterval(() => { const b = document.querySelector('.ci-open-report'); if (b) { clearInterval(t); b.click(); setTimeout(() => {  r(); }, 300); } }, 50); });`, ready: '.rp-sheet[open] .rp-signal', assert: `
      if (document.querySelectorAll('.rp-dim-row').length !== 4) throw Error('Missing dimensions'); need('.rp-track'); need('.rp-practice');
      if (!document.querySelector('.rp-moment-quote q')) throw Error('Verified quote missing');
    ` },
    interviewPaused: { url: problem, setup: `const m = await import('/js/interview.js'); m.openInterviewRecord('jump-game', '1760000000000-00000001');`, ready: '.ci-paused:not([hidden])' },
    interviewsList: { url: problem, setup: `${coach} clickText('.coach-tab', 'Interviews'); document.querySelector('.interview-back')?.click();`, ready: '.interviews-overview .interview-row' },
    interviewsEmpty: { url: problem, setup: `const originalFetch = window.fetch; window.fetch = async (...args) => String(args[0]).startsWith('/api/interview?') ? new Response(JSON.stringify({ interviews: [] }), { headers: { 'content-type': 'application/json' } }) : originalFetch(...args); ${coach} clickText('.coach-tab', 'Interviews'); document.querySelector('.interview-back')?.click();`, ready: '.ci-start', assert: `if (document.querySelectorAll('.interview-row').length) throw Error('Empty list has rows');` },
    modelMenuOpen: { url: problem, setup: `${coach} for(let i=0;i<120&&document.querySelector('.coach-compose .ui-select-button')?.disabled;i++)await sleep(50); need('.coach-compose .ui-select-button:not(:disabled)').click();`, ready: '[role="menu"]:not([hidden])' },
    guidanceList: {url:problem,setup:guidanceFixture,ready:'.gi-rule'},
    guidanceHistory: {url:problem,setup:guidanceFixture+`need('.gi-history summary').click();`,ready:'.gi-history[open]'},
    guidanceNarrow: {url:problem,width:390,height:844,setup:guidanceFixture+`need('.gi-history summary').click();`,ready:'.gi-history[open]'},
    guidanceEdit: {url:problem,setup:guidanceFixture+`[...document.querySelectorAll('.gi-sheet button')].find(b=>b.textContent==='Edit').click();`,ready:'.gi-input'},
    guidanceEmpty: {url:problem,setup:`await(await import('/js/coaching-instructions.js')).openCoachingInstructions();`,ready:'.gi-body'},
    contextList: {url:problem,setup:contextFixture,ready:'.ci-request'},
    contextDetail: {url:problem,setup:contextDetail,ready:'.ci-source'},
    contextDetailNarrow: {url:problem,width:390,height:844,setup:contextDetail,ready:'.ci-source'},
    contextEmpty: {url:problem,setup:`await (await import('/js/context-inspector.js')).openContextInspector();`,ready:'.ci-body'},
    practiceOpen: {url:'/#/lld',setup:`const {session}=await(await fetch('/api/practice/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({discipline:'lld'})})).json();location.hash='#/lld/practice/'+session.slug+'/'+session.id;for(let i=0;i<100&&!document.querySelector('.pr-empty');i++)await sleep(50);`,ready:'.pr-empty'},
    practiceOpenNarrow: {url:'/#/lld',width:390,setup:`const {session}=await(await fetch('/api/practice/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({discipline:'lld'})})).json();location.hash='#/lld/practice/'+session.slug+'/'+session.id;for(let i=0;i<100&&!document.querySelector('.pr-empty');i++)await sleep(50);need('.pr-coach').scrollIntoView({block:'center'});`,ready:'.pr-empty'},
    settingsSelects: { url: problem, setup: `await import('/js/settings.js').then(m => m.openSettings('voice'));`, ready: '.set-voice .ui-select', assert: `if ([...document.querySelectorAll('select')].some(visible)) throw Error('Native select');` },
    catalogNarrowRows: { url: '/#/', width: 390, setup: `need('.phead').scrollIntoView({block:'start'});`, ready: '.phead' },
    roadmapDetail: { url: '/#/roadmap', setup: `need('.roadmap-node').click(); need('.roadmap-detail').scrollIntoView({block:'center'});`, ready: '.roadmap-detail:not([hidden])' },
    catalogNarrow: { url: '/#/', width: 390, ready: '.catalog' },
    coachWorking: turnState('working'),
    coachWriting: turnState('writing'),
    coachChanged: turnState('change'),
    coachActivityExpanded: turnState('expanded'),
    coachNoteOnly: turnState('note-only'),
    coachStopped: turnState('stopped'),
    coachFailed: turnState('failed'),
    coachPinnedQuestion: turnState('long'),
    coachJumpLatest: turnState('jump'),
    coachRestoredThread: turnState('restored'),
    coachPicture: { url: problem, setup: `${coach} const picture=(await import('/js/coach-image.js')).renderImageCard(JSON.stringify({prompt:'An interval merging diagram',alt:'How overlapping intervals combine'})); need('.coach-log').append(picture);`, ready: '.pic-offer' },
    coachIllustration: { url: problem, setup: `${coach} const viz=(await import('/js/viz.js')).drawViz({type:'array',title:'Walking the array',values:[2,3,1,1,4],frames:[{note:'Start at the first index.'},{note:'Track the furthest reachable index.'}]}); need('.coach-log').append(viz);`, ready: '.viz-stepper' },
    catalog: { url: '/#/', ready: '.catalog' },
    trackerSettings: { url: '/#/', ready: '.catalog', setup: `need('.set-settings').click();need('[data-set-tab=practice]').click();for(let i=0;i<100&&need('.tracker-reset-all').disabled;i++)await sleep(50);`, assert: `if(document.querySelector('.tracker-actions'))throw Error('Unexpected per-problem tracker control');` },
    trackerReset: { url: '/#/', ready: '.catalog', setup: `await fetch('/api/tracker/restore',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});need('.set-settings').click();need('[data-set-tab=practice]').click();for(let i=0;i<100&&need('.tracker-reset-all').disabled;i++)await sleep(50);need('.tracker-reset-all').click();if(!need('.tracker-reset-all').textContent.includes('again'))throw Error('Reset must ask for a second click');if(document.querySelector('.tracker-restore-all').offsetParent)throw Error('Undo shown before any reset');need('.tracker-reset-all').click();for(let i=0;i<100&&!document.querySelector('.tracker-restore-all').offsetParent;i++)await sleep(50);`, assert: `const data=await(await fetch('/api/tracker')).json();if(!data.resetAt||data.problems.some(p=>p.status!=='empty'))throw Error('All tracker statuses must reset');if(!need('[aria-label="Problem tracker"]').textContent.includes('preserved'))throw Error('Missing preservation receipt');` },
    trackerSettingsNarrow: { url: '/#/', width: 390, ready: '.catalog', setup: `need('.set-settings').click();need('[data-set-tab=practice]').click();`, assert: `const r=need('.tracker-reset-all').getBoundingClientRect();if(r.left<0||r.right>innerWidth)throw Error('Reset control outside viewport');` },

    collectionCatalog: { url: '/#/', setup: `clickText('.seg-opt', '${collectionFixture.label}'); need('.filterbar').scrollIntoView({block:'start'});`, ready: '.catalog', assert: `
      const rows = [...document.querySelectorAll('.prow')];
      if (rows.length !== ${collectionCount} || new Set(rows.map(row => row.dataset.slug)).size !== ${collectionCount}) throw Error('Collection must contain ${collectionCount} unique problems');
      if (!need('.countpill').textContent.includes('${collectionCount}')) throw Error('Incorrect collection count');` },
    collectionCatalogNarrow: { url: '/#/', width: 390, setup: `clickText('.seg-opt', '${collectionFixture.label}'); need('.filterbar').scrollIntoView({block:'start'});`, ready: '.catalog' },
    collectionProblem: { url: '/#/p/time-based-key-value-store', setup: `need('[data-interview-prep]').open = true;`, ready: '[data-interview-prep]', assert: `
      if (!need('[data-interview-prep]').textContent.includes('Fixture caveat')) throw Error('Missing collection caveat');
      if (!need('.ptags').textContent.includes('${collectionFixture.id}')) throw Error('Missing collection tag');` },
    collectionProblemNarrow: { url: '/#/p/time-based-key-value-store', width: 390, setup: `need('[data-interview-prep]').open = true; need('[data-interview-prep]').scrollIntoView({block:'start'});`, ready: '[data-interview-prep]' },
    collectionRoadmap: { url: '/#/roadmap', setup: `clickText('.chip', '${collectionFixture.label}');`, ready: '.roadmap', assert: `
      const counts = [...document.querySelectorAll('.node-meta')].map(node => parseInt(node.textContent, 10));
      if (counts.reduce((a,b) => a+b, 0) !== ${collectionCount}) throw Error('Roadmap must include all ${collectionCount} collection problems');` },
    roadmap: { url: '/#/roadmap', ready: '.roadmap' },
    progress: { url: '/#/progress', ready: '.dash-patterns', assert: `const b=need('.dash-body').getBoundingClientRect();if(b.width>1201)throw Error('Progress is not a bounded column');if(document.querySelector('.dash [title]'))throw Error('Native title tooltip on Progress');` },
    progressNarrow: { url: '/#/progress', width: 390, ready: '.dash-patterns', assert: `if(document.documentElement.scrollWidth>innerWidth)throw Error('Progress overflows the phone width');` },
    design: { url: '/#/design', ready: '.th-item' },
    designSetup: { url: '/#/design', ready: '.th-box--mock .ci-start', assert: `need('.th-box--mock [aria-label="Answer mode: Voice"]');` },
    designSetupNarrow: { url: '/#/design', width: 390, ready: '.th-box--mock .ci-start' },
    problem: { url: problem, ready: '.ui-screen-header .ws-run', setup: `if (document.body.classList.contains('coach-open')) need('.coach-hide').click();` },
    chat: { url: problem, setup: coach, ready: '.recent-chat', assert: historySpacing },
    chatNarrow: { url: problem, setup: `${coach} need('.recent-chats').style.width='260px'; need('.recent-title').textContent='I am struggling to understand how these overlapping intervals should merge, especially when the new interval spans several existing intervals.';`, ready: '.recent-chat', assert: historySpacing },
    chatThreadNarrow: { url: problem, setup: `${coach} const chat = [...document.querySelectorAll('.recent-chat')].find(n => n.textContent.includes('Both are good')); if (!chat) throw Error('Missing coach chat fixture'); chat.click(); await sleep(300); const pane = need('.coach'); pane.style.width = pane.style.maxWidth = pane.style.minWidth = '290px'; pane.style.flex = 'none'; await sleep(200);`, ready: '.ui-thread-strip', assert: `const bar = need('.coach-bar').getBoundingClientRect(), strip = need('.ui-thread-strip').getBoundingClientRect(); for (const n of document.querySelectorAll('.coach-chat-tools button')) { const r = n.getBoundingClientRect(); if (!r.width) continue; if (r.bottom > bar.bottom + 0.5 || r.top < bar.top - 0.5) throw Error('A chat tool hangs outside the sidebar header'); if (r.bottom > strip.top + 0.5 && r.top < strip.bottom - 0.5) throw Error('A chat tool covers the conversation strip'); }` },
    composerFocus: { url: problem, setup: `${coach} let input = null; for (let i = 0; i < 40 && !input; i++) { input = [...document.querySelectorAll('textarea.ui-composer-input')].find(visible); if (!input) await sleep(100); } if (!input) throw Error('Missing the coach composer'); input.focus(); await sleep(250);`, ready: '.ui-composer:focus-within', assert: `const c = getComputedStyle(need('.ui-composer:focus-within')); if (c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) > 0) throw Error('The focused composer draws a second ring'); if (c.boxShadow === 'none') throw Error('The focused composer shows no focus halo');` },
    chatActive: { url: problem, setup: `${coach} const chat = [...document.querySelectorAll('.recent-chat')].find(n => n.textContent.includes('Both are good')); if (!chat) throw Error('Missing coach chat fixture'); chat.click(); await sleep(300); need('.coach-chat-tools [aria-label="History"]').click();`, ready: '.chat-history-popover .recent-chat', assert: historySpacing },
    subsNarrow: { url: problem, setup: `${submissions} need('.submissions').style.width='260px';`, ready: '.submission-row' },
    interviewsNarrow: { url: problem, setup: `${coach} clickText('.coach-tab', 'Interviews'); document.querySelector('.interview-back')?.click(); need('.interviews-view').style.width='280px';`, ready: '.interviews-overview .interview-row' },
    catalogScrolled: { url: '/#/', setup: `for (let i=0; i<100 && !document.querySelector('.catalog .psec .prow'); i++) await sleep(50); document.scrollingElement.scrollTo({ top: 520, behavior: 'instant' }); await sleep(200);`, ready: '.catalog .filterbar' },
    stmtNarrow: { url: problem, ready: '.stmt-example .ex-value', assert: `
      const rows = [...document.querySelectorAll('.stmt-example')].map(n => [...n.querySelectorAll('.ex-label')].map(l => l.textContent).join(','));
      if (rows[0] !== 'Input,Output,Explanation') throw Error('Example rows were not read: ' + rows[0]);
      if (!document.querySelector('.stmt-constraints li') || !document.querySelector('.stmt-follow p')) throw Error('Constraints or follow-up missing');
      if (document.querySelector('.stmt-follow strong')) throw Error('The follow-up kept its duplicate bold label');
      const links = [...document.querySelectorAll('.pcol .pane-links a')].map(a => a.textContent);
      if (!links.includes('LeetCode')) throw Error('Problem links are not beside the tabs: ' + links.join(','));
      const second = [...document.querySelectorAll('.stmt-example')][1].querySelector('.ex-value').textContent;
      if (second !== 'nums = [3,2,1,0,4]\\nlimit = 2') throw Error('Each parameter of an input should be on its own line: ' + JSON.stringify(second));
      const starts = [...document.querySelectorAll('.stmt-example .ex-value')].map(n => Math.round(n.getBoundingClientRect().left));
      if (new Set(starts).size !== 1) throw Error('Example values do not start on one line down the list: ' + starts.join(','));
      const tries = document.querySelectorAll('.ex-try');
      if (tries.length !== 1) throw Error('Only an example that exists as a test case may offer to open it; found ' + tries.length);
      for (const n of document.querySelectorAll('.stmt-example')) { const p = need('.pcol').getBoundingClientRect(), r = n.getBoundingClientRect(); if (r.right > p.right + 1) throw Error('An example overflows the pane'); }` },
    stmtWide: { url: problem, width: 2200, setup: `need('.pbody.with-workspace').style.gridTemplateColumns = '1100px minmax(0,1fr)'; await sleep(200);`, ready: '.stmt-example .ex-value', assert: `
      const lead = need('.stmt-lead').getBoundingClientRect(), examples = need('.stmt-examples').getBoundingClientRect();
      if (need('.pcol').getBoundingClientRect().width < 880) throw Error('Fixture pane is not wide');
      if (examples.left < lead.right) throw Error('In a wide pane the examples sit beside the description');
      if (Math.abs(examples.top - lead.top) > 2) throw Error('Description and examples should start level');
      const rest = need('.stmt-rest').getBoundingClientRect(); if (rest.top - lead.bottom > 40) throw Error('Tall examples push the constraints away from the description: ' + Math.round(rest.top - lead.bottom) + 'px');` },
    // Fixture statements carry no pictures (they would need the network), so one is drawn here.
    stmtFigure: { url: problem, width: 2200, setup: `need('.pbody.with-workspace').style.gridTemplateColumns = '1100px minmax(0,1fr)'; for (let i = 0; i < 40 && !document.querySelector('.stmt-example .ex-body'); i++) await sleep(100); const c = document.createElement('canvas'); c.width = 420; c.height = 460; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 420, 460); g.strokeStyle = '#222'; g.lineWidth = 4; for (const [x, y] of [[210, 60], [110, 220], [310, 220], [250, 390], [370, 390]]) { g.beginPath(); g.arc(x, y, 44, 0, 7); g.stroke(); } const img = new Image(); img.alt = ''; img.src = c.toDataURL(); await img.decode(); const fig = document.createElement('div'); fig.className = 'ex-figure'; fig.append(img); need('.stmt-example .ex-body').prepend(fig); await sleep(200);`, ready: '.stmt-example .ex-figure img', assert: `
      const img = need('.stmt-example .ex-figure img').getBoundingClientRect(), rows = need('.stmt-example .ex-rows').getBoundingClientRect(), card = need('.stmt-example').getBoundingClientRect();
      if (img.height > 261) throw Error('An example diagram is taller than its cap: ' + img.height);
      if (card.width >= 420 && rows.left < img.right) throw Error('In a wide card the diagram sits beside its values');
      if (img.right > card.right || rows.right > card.right + 1) throw Error('Example content overflows its card');
      if (card.width >= 420 && rows.height < img.height && Math.abs((rows.top + rows.bottom) / 2 - (img.top + img.bottom) / 2) > 24) throw Error('Short rows beside a diagram should sit level with its middle');` },
    // Newer LeetCode problems put "Explanation:" on its own line and let a picture be the explanation.
    stmtPictureExplanation: { url: problem, setup: `for (let i = 0; i < 40 && !document.querySelector('.stmt'); i++) await sleep(100); const { structureStatement } = await import('/js/statement.js'); const c = document.createElement('canvas'); c.width = 400; c.height = 207; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 400, 207); g.strokeStyle = '#222'; g.lineWidth = 3; g.beginPath(); g.arc(200, 100, 40, 0, 7); g.stroke(); const rich = document.createElement('div'); rich.className = 'rich'; rich.innerHTML = '<p>Return what can be seen from the right side.</p><p><strong>Example 1:</strong></p><p><strong>Input:</strong> root = [1,2,3,null,5,null,4]</p><p><strong>Output:</strong> [1,3,4]</p><p><strong>Explanation:</strong></p><p><img alt=""></p><p><strong>Example 2:</strong></p><p><strong>Input:</strong> root = []</p><p><strong>Output:</strong> []</p><p><strong>Constraints:</strong></p><ul><li>The tree has at most 100 nodes.</li></ul>'; const img = rich.querySelector('img'); img.src = c.toDataURL(); await img.decode(); need('.stmt').replaceWith(structureStatement(rich)); await sleep(200);`, ready: '.stmt-example .ex-value', assert: `
      const first = need('.stmt-example');
      const labels = [...first.querySelectorAll('.ex-label')].map(n => n.textContent).join(',');
      if (labels !== 'Input,Output,Explanation') throw Error('A picture explanation lost its row: ' + labels);
      if (!first.querySelector('.ex-row .ex-value.is-figure img')) throw Error('The picture is not in the Explanation row');
      if (first.querySelector('.ex-raw') || first.querySelector('.ex-figure')) throw Error('The explanation label or picture was left outside its row');
      if (need('.stmt-example .ex-value.is-figure img').getBoundingClientRect().height > 261) throw Error('The picture exceeds its cap');` },
    problemScroll: { url: problem, setup: `const pane=need('.pcol'); pane.lastElementChild.style.minHeight='2400px'; await sleep(100);`, ready: '.pcol', assert: `
      // overflow:hidden still scrolls from script, so the computed value is the test:
      // only auto or scroll lets a wheel or trackpad move it.
      const pane=need('.pcol'), flow=getComputedStyle(pane).overflowY;
      if (pane.scrollHeight <= pane.clientHeight + 100) throw Error('Fixture statement is not taller than its pane');
      if (!/auto|scroll/.test(flow)) throw Error('A long problem statement cannot be scrolled (overflow-y: ' + flow + ')');` },
    subsEmpty: { url: '/#/p/time-based-key-value-store', setup: `${coach} clickText('.coach-tab', 'Submissions'); await sleep(400);`, ready: '.submission-empty' },
    subsList: { url: problem, setup: submissions, ready: '.submission-row' },
    subsAccepted: { url: problem, setup: `${submissions} const row = [...document.querySelectorAll('.submission-row')].find(n => n.textContent.includes('Accepted')); if (!row) throw Error('No accepted fixture'); row.click();`, ready: '.submission-hero.accepted', assert: `need('.submission-chart');` },
    subsTle: { url: problem, setup: `${submissions} const row = [...document.querySelectorAll('.submission-row')].find(n => n.textContent.includes('Time Limit Exceeded')); if (!row) throw Error('No TLE fixture'); row.click();`, ready: '.submission-hero.rejected' },
    resetNotice: { url: problem, setup: `${editor} inst.setValue('# something of my own\\nclass Solution:\\n    pass\\n'); await sleep(600); need('.ws-reset').click(); await sleep(300);`, ready: '.ws-notice:not([hidden])', assert: `
      if (![...document.querySelectorAll('.ws-notice button')].some(b => b.textContent.trim() === 'Undo')) throw Error('Reset must offer Undo');` },
    moreMenu: { url: problem, width: 600, setup: `need('.ui-screen-header .ui-header-more').click(); await sleep(200);`, ready: '.ui-menu-item', assert: `
      for (const item of document.querySelectorAll('.ui-menu-item')) if (item.querySelector('button, a, input')) throw Error('A menu item contains another control: ' + item.textContent.trim());` },
    subsWrong: { url: problem, setup: `${submissions} const row = [...document.querySelectorAll('.submission-row')].find(n => n.textContent.includes('Wrong Answer')); if (!row) throw Error('No wrong-answer fixture'); row.click(); await sleep(400); const pane = need('.submissions'); pane.scrollTop = 220;`, ready: '.failure-block pre', assert: `
      const pane = need('.submissions'), bar = need('.submission-action-bar').getBoundingClientRect(), box = pane.getBoundingClientRect();
      if (pane.scrollHeight <= pane.clientHeight + 40) throw Error('Fixture detail does not scroll');
      if (box.bottom - bar.bottom > 1.5) throw Error('Content shows ' + (box.bottom - bar.bottom).toFixed(0) + 'px beneath the pinned actions');` },
    find: { url: problem, setup: `${editor} await inst.getAction('actions.find').run();`, ready: '.find-widget.visible' },
    suggest: { url: problem, setup: `${editor}
      // Insert on a real method-body line, not past the model's last line.
      const model = inst.getModel();
      if (model.getLineCount() < 3) throw Error('Suggestion fixture needs a method body');
      window.visualOriginalCode = model.getValue();
      inst.executeEdits('visual-check', [{ range: new window.monaco.Range(3, 1, 3, model.getLineMaxColumn(3)), text: '        ' }]);
      inst.setPosition({ lineNumber: 3, column: 9 });
      inst.trigger('keyboard', 'type', { text: 'num' });
      await inst.getAction('editor.action.triggerSuggest').run();`, ready: '.suggest-widget.visible' },
    runResult: { url: '/?simrun=pass#/p/jump-game', setup: `need('.ui-screen-header .ws-run').click();`, ready: '.rr-case', assert: resultLayout },
    tutorRun: { url: '/?simrun=pass#/p/jump-game', setup: learnerRun + tutorRun, ready: '.rr-tutor button', assert: tutorSpacing },
    tutorRunNoHistory: { url: '/?simrun=pass#/p/jump-game', setup: tutorRun, ready: '.rr-tutor', assert: tutorSpacing + `if (document.querySelector('.rr-tutor button')) throw Error('No learner run exists to restore');` },
    tutorRunNarrow: { url: '/?simrun=pass#/p/jump-game', setup: learnerRun + tutorRun + `need('.ws-results').style.width='360px';`, ready: '.rr-tutor button', assert: tutorSpacing },
    tutorRunError: { url: '/?simrun=compile#/p/jump-game', setup: tutorRun, ready: '.rr-tutorbody > .state', assert: tutorSpacing },
    verdictWrong: { url: '/?simsubmit=wrong#/p/jump-game', setup: `need('.ui-screen-header .ws-submit').click();`, ready: '.sub-verdict.v-rejected', assert: `
      const expected = [...document.querySelectorAll('.sub-detail')].find(n => n.firstElementChild.textContent === 'Expected output');
      const actual = document.querySelector('.sub-detail.bad');
      const pane = need('.ws-results').getBoundingClientRect();
      for (const node of [expected, actual]) {
        if (!node) throw Error('Missing failure comparison');
        const box = node.getBoundingClientRect();
        if (box.top < pane.top - 1 || box.bottom > pane.bottom + 1) throw Error('Failure comparison is below the results fold');
      }` },
    verdictAccepted: { url: '/?simsubmit=accepted&motion=0#/p/jump-game', setup: `need('.ui-screen-header .ws-submit').click();`, ready: '.sub-verdict.v-accepted' },
    cases: { url: '/#/p/cheapest-flights-within-k-stops', setup: `need('.tc-tab.is-mine').click();`, ready: '.tc-panel', assert: caseForm },
    // A published example with five parameters: read-only, labelled like the statement's rows.
    casesExample: { url: '/#/p/cheapest-flights-within-k-stops', ready: '.tc-panel .tc-input[readonly]', assert: caseForm + `
      if (!need('.tc-row-actions').textContent.includes('Duplicate')) throw Error('An example offers Duplicate');
      if (!need('.tc-row').textContent.includes('read only')) throw Error('Read-only is not said beside the case');` },
    // One parameter with a long value of your own: it wraps inside its field, never widens the pane.
    casesLong: { url: problem, setup: `need('.tc-tab.is-mine').click(); await sleep(100);
      const box = need('.tc-panel .tc-input:not([readonly])');
      box.value = '[' + Array.from({ length: 90 }, (_, i) => (i * 37) % 11).join(',') + ']';
      box.style.height = 'auto'; box.style.height = Math.min(160, box.scrollHeight) + 'px';`, ready: '.tc-panel', assert: caseForm },
    casesNarrow: { url: '/#/p/cheapest-flights-within-k-stops', setup: `need('.ws-results').style.width='360px';`, ready: '.tc-panel', assert: caseForm },
    casesShort: { url: '/#/p/cheapest-flights-within-k-stops', height: 640, ready: '.tc-panel', assert: caseForm },
    resultEmpty: { url: problem, setup: `clickText('.rr-tab', 'Result');`, ready: '.rr-empty' },
    resultLook: { url: problem, setup: nodeRun + scrollEnd, ready: '.rr-case.s-look', assert: resultLayout + `
      if (!need('.rr-summary').textContent.includes('3 of 4 need a look')) throw Error('Wrong needs-a-look headline');
      if (!need('.rr-why').textContent.includes('node.val')) throw Error('The node hint is missing');` },
    resultFail: { url: '/?simrun=fail#/p/jump-game', setup: learnerRun + scrollEnd, ready: '.rr-case.s-wrong', assert: resultLayout + `
      if (!need('.rr-mark.is-expected') || !need('.rr-mark:not(.is-expected)')) throw Error('The difference is not marked on both sides');` },
    resultError: { url: '/?simrun=runtime#/p/jump-game', setup: learnerRun + scrollEnd, ready: '.rr-field.trace', assert: resultLayout + `
      if (!/IndexError on line/.test(need('.rr-why strong').textContent)) throw Error('The error does not lead with its type and line');` },
    resultTimeout: { url: '/?simrun=timeout#/p/jump-game', setup: learnerRun, ready: '.rr-case.k-timeout', assert: resultLayout },
    resultStdout: { url: '/?simrun=pass#/p/jump-game', setup: learnerRun + `document.querySelectorAll('.rr-casetab')[1].click();`, ready: '.rr-printed', assert: resultLayout },
    resultShort: { url: '/?simrun=fail#/p/jump-game', height: 640, setup: learnerRun, ready: '.rr-case.s-wrong', assert: resultLayout },
    resultNarrow: { url: '/?simrun=runtime#/p/jump-game', setup: learnerRun + `need('.ws-results').style.width='360px';`, ready: '.rr-case.s-error', assert: resultLayout },
    settingsVoice: { url: problem, setup: `await import('/js/settings.js').then(m => m.openSettings('voice'));`, ready: '.set-voice', assert: `need('[aria-label^="Speech output"]'); need('[aria-label^="Natural voice"]'); need('[aria-label="Speech speed"]'); need('[aria-label="Preview voice"]');` },
    settingsPractice: { url: problem, setup: `await import('/js/settings.js').then(m => m.openSettings('practice'));`, ready: '.settings', assert: `const d=need('.settings').getBoundingClientRect(),p=need('.set-page:not([hidden])').getBoundingClientRect();if(d.left<0||d.right>innerWidth||d.bottom>innerHeight)throw Error('Settings dialog outside viewport');if(p.right>d.right+.5||need('.set-body').scrollWidth>need('.set-body').clientWidth)throw Error('Settings page overflows');` },
    settingsAppearance: { url: problem, setup: `await import('/js/settings.js').then(m => m.openSettings('appearance'));`, ready: '.settings', assert: `const d=need('.settings').getBoundingClientRect(),p=need('.set-page:not([hidden])').getBoundingClientRect();if(d.left<0||d.right>innerWidth||d.bottom>innerHeight)throw Error('Settings dialog outside viewport');if(p.right>d.right+.5||need('.set-body').scrollWidth>need('.set-body').clientWidth)throw Error('Settings page overflows');` },
    settingsEditor: { url: problem, setup: `await import('/js/settings.js').then(m => m.openSettings('editor'));`, ready: '.settings', assert: `const d=need('.settings').getBoundingClientRect(),p=need('.set-page:not([hidden])').getBoundingClientRect();if(d.left<0||d.right>innerWidth||d.bottom>innerHeight)throw Error('Settings dialog outside viewport');if(p.right>d.right+.5||need('.set-body').scrollWidth>need('.set-body').clientWidth)throw Error('Settings page overflows');` },
    settingsKeys: { url: problem, setup: `await import('/js/settings.js').then(m => m.openSettings('keys'));`, ready: '.settings', assert: `const d=need('.settings').getBoundingClientRect(),p=need('.set-page:not([hidden])').getBoundingClientRect();if(d.left<0||d.right>innerWidth||d.bottom>innerHeight)throw Error('Settings dialog outside viewport');if(p.right>d.right+.5||need('.set-body').scrollWidth>need('.set-body').clientWidth)throw Error('Settings page overflows');` },
    settingsNarrow: { url: problem, width: 390, setup: `await import('/js/settings.js').then(m => m.openSettings('appearance'));`, ready: '.settings', assert: `const d=need('.settings').getBoundingClientRect(),p=need('.set-page:not([hidden])').getBoundingClientRect();if(d.left<0||d.right>innerWidth||d.bottom>innerHeight)throw Error('Settings dialog outside viewport');if(p.right>d.right+.5||need('.set-body').scrollWidth>need('.set-body').clientWidth)throw Error('Settings page overflows');` },
    settings: { url: problem, setup: `await import('/js/settings.js').then(m => m.openSettings('coach'));`, ready: '.settings', assert: `
      const background = getComputedStyle(need('.settings')).backgroundColor;
      if (background.startsWith('rgba(') && !background.endsWith(', 1)')) throw Error('Reading overlay is translucent: ' + background);` },
    // Drafts are kept across reloads. Saving is switched off for this page so the typed text
    // cannot reach any other state's screenshot.
    composerTyped: { url: problem, setup: `${coach} let input = null; for (let i = 0; i < 40 && !input; i++) { input = [...document.querySelectorAll('textarea.ui-composer-input')].find(visible); if (!input) await sleep(100); } if (!input) throw Error('Missing the coach composer'); const send = [...input.closest('.ui-composer').querySelectorAll('.ui-composer-send')].find(visible); if (!send) throw Error('Missing the send button'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(200); const empty = getComputedStyle(send).backgroundColor; if (!send.disabled) throw Error('Send is enabled with nothing typed'); Storage.prototype.setItem = () => {}; input.focus(); input.value = 'Why does the greedy choice work here?'; input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(400); if (send.disabled) throw Error('Send stays disabled after typing'); if (getComputedStyle(send).backgroundColor === empty) throw Error('Send looks the same empty and ready');`, ready: '.ui-composer:focus-within' },
  };
  const selectedStates = process.env.STUDIO_VISUAL_STATES?.split(',').filter(Boolean);
  if (selectedStates) {
    for (const name of selectedStates) if (!states[name]) throw Error('Unknown visual state: ' + name);
    for (const name of Object.keys(states)) if (!selectedStates.includes(name)) delete states[name];
  }
  const findings = [];
  const syntaxContrast = [];
  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    // Only this scratch origin may load resources, including plain-HTTP requests.
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${origin}/` });
    await until("document.querySelector('.catalog')", 'catalog');
    const themes = await evaluate("return (await import('/js/settings.js')).THEMES.map(theme => theme.id);");
    const selectedThemes = process.env.STUDIO_VISUAL_THEMES?.split(',').filter(Boolean);
    if (selectedThemes?.some(theme => !themes.includes(theme))) throw Error('Unknown visual theme');
    for (const theme of selectedThemes || themes) for (const mode of ['light', 'dark']) {
      for (const [state, config] of Object.entries(states)) {
        try {
          await send('Emulation.setDeviceMetricsOverride', { width: config.width || 1600, height: config.height || 1000, deviceScaleFactor: 1, mobile: false });
          // A full document reset prevents a prior popover/widget from satisfying
          // the next state's readiness check while a same-route navigation settles.
          await evaluate("localStorage.removeItem('studio.interview.active.v1');");
          await send('Page.navigate', { url: 'about:blank' });
          await until("location.href === 'about:blank' && document.readyState === 'complete'", 'blank page');
          await send('Page.navigate', { url: `${origin}${config.url}` });
          await until("document.readyState === 'complete' && document.querySelector('.catalog,.ws,.roadmap,.dash-body,.dash-card,.th,.dz-view,.lld-view,.pr-view,.problem-import')", 'view');
          await evaluate(`const settings = await import('/js/settings.js');
            settings.setSetting('theme', ${JSON.stringify(theme)}); settings.setSetting('mode', ${JSON.stringify(mode)});
            settings.setSetting('motion', false); settings.setSetting('celebrations', false);
            document.body.getBoundingClientRect(); await document.fonts.ready;
            await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);`);
          if (config.url.includes('/p/')) {
            await until("window.monaco?.editor.getEditors().length && document.querySelector('.tc-tab')", 'editor and cases');
          }
          if (config.setup) await evaluate(config.setup);
          await until(`(() => { const n = document.querySelector(${JSON.stringify(config.ready)}); return n && n.getClientRects().length && !n.closest('[hidden]') && getComputedStyle(n).visibility !== 'hidden'; })()`, config.ready);
          await evaluate('await document.fonts.ready; await sleep(250);');
          if (config.keyboardFocus) {
            const scrollTop = await evaluate(`return need(${JSON.stringify(config.keyboardFocus)}).scrollTop;`);
            await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
            await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
            await evaluate(`const reading=need(${JSON.stringify(config.keyboardFocus)});reading.focus({preventScroll:true});reading.scrollTop=${scrollTop};`);
          }
          if (config.assert) await evaluate(config.assert);
          if (state.startsWith('interviewReport')) await evaluate(`
            const scroll = need('.rp-scroll');
            if (scroll.scrollWidth > scroll.clientWidth + 1) throw Error('Report has horizontal overflow');
            for (const button of document.querySelectorAll('.rp-sheet button')) {
              if (!visible(button)) continue;
              const r = button.getBoundingClientRect();
              const minimum = button.classList.contains('btn--lg') ? 34 : 28;
              if (r.width < minimum - .5 || r.height < minimum - .5) throw Error('Report control below shared size: ' + button.textContent + ' / ' + button.getAttribute('aria-label'));
            }
          `);
          if (['chat', 'subsList', 'interviewDebrief', 'interviewLive'].includes(state)) {
            await checkSidebar(expression => evaluate('return ' + expression));
          }
          if (state === 'referenceTab') {
            // Exercise every token through the real highlighter on the real solution
            // tab surface, including tokens absent from the selected reference solution.
            const samples = await evaluate(`
              const pre = need('pre.solutioncode');
              const probe = document.createElement('span');
              probe.append((await import('/js/highlight.js')).highlightPython('def sample(): # comment' + String.fromCharCode(10) + '    return len("amber") + 42'));
              pre.append(probe);
              try {
                const luminance = channels => {
                  channels = channels.map(v => {
                    v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
                  });
                  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
                };
                let background;
                for (let node = pre; node; node = node.parentElement) {
                  const style = getComputedStyle(node);
                  if (style.backgroundImage !== 'none') throw Error('Syntax surface requires painted-background review');
                  if (style.backgroundColor.startsWith('rgb(')) { background = style.backgroundColor; break; }
                }
                if (!background) throw Error('Missing opaque syntax surface');
                return ['kw', 'str', 'num', 'com', 'def', 'bi'].map(token => {
                  const node = probe.querySelector('.tok-' + token);
                  if (!node) throw Error('Missing highlighter token: ' + token);
                  const foreground = getComputedStyle(node).color;
                  const fg = foreground.match(/[0-9.]+/g).map(Number);
                  const bg = background.match(/[0-9.]+/g).map(Number);
                  const alpha = fg[3] ?? 1;
                  const a = luminance(fg.slice(0, 3).map((v, i) => v * alpha + bg[i] * (1 - alpha))), b = luminance(bg);
                  return { token, foreground, background, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
                });
              } finally { probe.remove(); }
            `);
            syntaxContrast.push(...samples.map(sample => ({ theme, mode, ...sample })));
            for (const sample of samples) if (sample.ratio < 4.5) findings.push({
              theme, mode, state, kind: 'contrast', where: 'pre.solutioncode .tok-' + sample.token,
              detail: sample.ratio.toFixed(2) + ':1 (needs 4.5) ' + sample.foreground + ' on ' + sample.background,
            });
            await fsp.writeFile(path.join(output, 'syntax-contrast.json'), JSON.stringify(syntaxContrast, null, 2));
          }
          const rows = await evaluate(lint);
          if (!Array.isArray(rows)) throw Error('Visual lint did not return findings');
          findings.push(...rows.map(row => ({ theme, mode, state, ...row })));
        } catch (error) {
          findings.push({ theme, mode, state, kind: 'audit-error', where: config.ready, detail: error.message });
        }
        const screenshot = await send('Page.captureScreenshot', { format: 'png' });
        await fsp.writeFile(path.join(output, `${state}-${theme}-${mode}.png`), Buffer.from(screenshot.data, 'base64'));
        await fsp.writeFile(path.join(output, 'findings.json'), JSON.stringify(findings, null, 2));
        if (state === 'suggest') await evaluate(`if (typeof window.visualOriginalCode === 'string') { window.monaco.editor.getEditors()[0].setValue(window.visualOriginalCode); await sleep(500); }`);
      }
      console.log(`Visual audit: ${theme}/${mode}, ${Object.keys(states).length} states`);
    }
    if (process.env.STUDIO_REPORT_SHOTS) {
      const { captureReport } = await import('./capture-report.mjs');
      await captureReport({ send, evaluate, until, origin, output: process.env.STUDIO_REPORT_SHOTS });
    }
    return findings;
  } finally {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('Audit closed')); }
    pending.clear();
    socket.close();
  }
}
