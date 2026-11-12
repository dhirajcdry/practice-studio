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
    agentActions: { url: '/#/lld/practice/lld-locker/visual-practice-lld', ready: '.pr-coach .pr-answer', setup: `const {showWorkspaceAction}=await import('/js/workspace-tools.js');const log=need('.pr-thread');showWorkspaceAction(log,{id:'visual-code-edit',tool:'edit_code',status:'done',summary:'Edited your code: added cancellation validation while preserving the caller’s reservation and ownership checks.'},{replay:true});showWorkspaceAction(log,{id:'visual-memory',tool:'update_memory',status:'done',summary:'Updated LLD memory with the observed invariant and the next verification exercise.'},{replay:true});showWorkspaceAction(log,{id:'visual-run',tool:'run_code',status:'done',summary:'Ran Python (coach run)',result:{exitCode:0,stdout:'reservation trace '.repeat(40)}},{replay:true});if(log.lastElementChild.querySelector('details').open)throw Error('Successful run output must start collapsed');log.scrollTop=log.scrollHeight;` },
    agentActionsNarrow: { url: '/#/lld/practice/lld-locker/visual-practice-lld', width:390, ready: '.pr-coach .pr-answer', setup: `const {showWorkspaceAction}=await import('/js/workspace-tools.js');const log=need('.pr-thread');showWorkspaceAction(log,{id:'visual-code-edit',tool:'edit_code',status:'done',summary:'Edited your code: added cancellation validation while preserving the caller’s reservation and ownership checks.'},{replay:true});showWorkspaceAction(log,{id:'visual-memory',tool:'update_memory',status:'failed',summary:'Update learner memory',message:'The saved note changed. Read it again before replacing this passage.'},{replay:true});need('.pr-coach').scrollIntoView({block:'center'});log.scrollTop=log.scrollHeight;` },
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
    lldContextNarrow: { url: '/#/lld', width: 390, setup: `need('.learner-context summary').click();`, ready: '.learner-context > div:not([hidden])', assert: `if (!need('.learner-context').open) throw Error('Learning context did not expand');` },
    lldSelected: lldSelection,
    lldSelectedNarrow: { ...lldSelection, width: 390 },
    lldLongDocument: { url: '/#/lld/lld-locker/1760000000000-00000009', width: 1024, height: 650, setup: `for(let i=0;i<100 && !document.querySelector('.ci-composer .ui-mode-switch:not(:disabled)');i++) await sleep(50); const log=need('.ci-log'); for(let i=0;i<20;i++){const p=document.createElement('p');p.textContent='Interviewer: How does reservation ownership prevent conflicting updates?';log.append(p);} log.scrollTop=log.scrollHeight;`, ready: '.ci-contained .ci-log' },
    lldDocumentNarrow: { url: '/#/lld/lld-locker/1760000000000-00000009', width: 390, ready: '.lld-workspace .ci-panel', setup: `for(let i=0;i<100 && !document.querySelector('.ci-panel');i++)await sleep(50);need('.lld-interviewer').scrollIntoView({block:'center'});` },
    lldDocument: { url: '/#/lld/lld-locker/1760000000000-00000009', ready: '.lld-workspace .ci-panel' },
    reference: { url: problem, setup: `need('[data-panel="solution"]').click();`, ready: '.drawer.show .drawer-resize', assert: `need('.scrim.show'); const d=need('.drawer.show'); const s=getComputedStyle(d); if (s.backgroundColor==='transparent' || s.backgroundColor==='rgba(0, 0, 0, 0)') throw Error('Reference surface must be opaque'); if (d.getBoundingClientRect().width<280) throw Error('Reference surface too narrow');` },
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
    settingsSelects: { url: problem, setup: `await import('/js/settings.js').then(m => m.openSettings());`, ready: '.settings .ui-select', assert: `if ([...document.querySelectorAll('select')].some(visible)) throw Error('Native select');` },
    catalogNarrowRows: { url: '/#/', width: 390, setup: `need('.phead').scrollIntoView({block:'start'});`, ready: '.phead' },
    roadmapDetail: { url: '/#/roadmap', setup: `need('.roadmap-node').click(); need('.roadmap-detail').scrollIntoView({block:'center'});`, ready: '.roadmap-detail:not([hidden])' },
    catalogNarrow: { url: '/#/', width: 390, ready: '.catalog' },
    coachPicture: { url: problem, setup: `${coach} const picture=(await import('/js/coach-image.js')).renderImageCard(JSON.stringify({prompt:'An interval merging diagram',alt:'How overlapping intervals combine'})); need('.coach-log').append(picture);`, ready: '.pic-offer' },
    coachIllustration: { url: problem, setup: `${coach} const viz=(await import('/js/viz.js')).drawViz({type:'array',title:'Walking the array',values:[2,3,1,1,4],frames:[{note:'Start at the first index.'},{note:'Track the furthest reachable index.'}]}); need('.coach-log').append(viz);`, ready: '.viz-stepper' },
    catalog: { url: '/#/', ready: '.catalog' },
    trackerSettings: { url: '/#/', ready: '.catalog', setup: `need('.set-settings').click();for(let i=0;i<100&&need('.tracker-reset-all').disabled;i++)await sleep(50);`, assert: `if(document.querySelector('.tracker-actions'))throw Error('Unexpected per-problem tracker control');` },
    trackerReset: { url: '/#/', ready: '.catalog', setup: `await fetch('/api/tracker/restore',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});need('.set-settings').click();for(let i=0;i<100&&need('.tracker-reset-all').disabled;i++)await sleep(50);need('.tracker-reset-all').click();if(!need('.tracker-reset-all').textContent.includes('again'))throw Error('Reset must ask for a second click');if(document.querySelector('.tracker-restore-all').offsetParent)throw Error('Undo shown before any reset');need('.tracker-reset-all').click();for(let i=0;i<100&&!document.querySelector('.tracker-restore-all').offsetParent;i++)await sleep(50);`, assert: `const data=await(await fetch('/api/tracker')).json();if(!data.resetAt||data.problems.some(p=>p.status!=='empty'))throw Error('All tracker statuses must reset');if(!need('[aria-label="Problem tracker"]').textContent.includes('preserved'))throw Error('Missing preservation receipt');` },
    trackerSettingsNarrow: { url: '/#/', width: 390, ready: '.catalog', setup: `need('.set-settings').click();`, assert: `const r=need('.tracker-reset-all').getBoundingClientRect();if(r.left<0||r.right>innerWidth)throw Error('Reset control outside viewport');` },

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
    progress: { url: '/#/progress', ready: '.dash-card' },
    design: { url: '/#/design', ready: '.th-item' },
    designSetup: { url: '/#/design', ready: '.th-box--mock .ci-start', assert: `need('.th-box--mock [aria-label="Answer mode: Voice"]');` },
    designSetupNarrow: { url: '/#/design', width: 390, ready: '.th-box--mock .ci-start' },
    problem: { url: problem, ready: '.ui-screen-header .ws-run', setup: `if (document.body.classList.contains('coach-open')) need('.coach-hide').click();` },
    chat: { url: problem, setup: coach, ready: '.recent-chat', assert: historySpacing },
    chatNarrow: { url: problem, setup: `${coach} need('.recent-chats').style.width='260px'; need('.recent-title').textContent='I am struggling to understand how these overlapping intervals should merge, especially when the new interval spans several existing intervals.';`, ready: '.recent-chat', assert: historySpacing },
    chatActive: { url: problem, setup: `${coach} const chat = [...document.querySelectorAll('.recent-chat')].find(n => n.textContent.includes('Both are good')); if (!chat) throw Error('Missing coach chat fixture'); chat.click(); await sleep(300); need('.coach-chat-tools [aria-label="History"]').click();`, ready: '.chat-history-popover .recent-chat', assert: historySpacing },
    subsNarrow: { url: problem, setup: `${submissions} need('.submissions').style.width='260px';`, ready: '.submission-row' },
    interviewsNarrow: { url: problem, setup: `${coach} clickText('.coach-tab', 'Interviews'); document.querySelector('.interview-back')?.click(); need('.interviews-view').style.width='280px';`, ready: '.interviews-overview .interview-row' },
    subsList: { url: problem, setup: submissions, ready: '.submission-row' },
    subsAccepted: { url: problem, setup: `${submissions} const row = [...document.querySelectorAll('.submission-row')].find(n => n.textContent.includes('Accepted')); if (!row) throw Error('No accepted fixture'); row.click();`, ready: '.submission-hero.accepted', assert: `need('.submission-chart');` },
    subsTle: { url: problem, setup: `${submissions} const row = [...document.querySelectorAll('.submission-row')].find(n => n.textContent.includes('Time Limit Exceeded')); if (!row) throw Error('No TLE fixture'); row.click();`, ready: '.submission-hero.rejected' },
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
    runResult: { url: '/?simrun=pass#/p/jump-game', setup: `need('.ui-screen-header .ws-run').click();`, ready: '.rr-case' },
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
    cases: { url: '/#/p/cheapest-flights-within-k-stops', setup: `need('.tc-tab.is-mine').click();`, ready: '.tc-panel' },
    settingsVoice: { url: problem, setup: `await import('/js/settings.js').then(m => m.openSettings()); need('.set-voice').scrollIntoView({ block: 'center' });`, ready: '.set-voice', assert: `need('[aria-label^="Speech output"]'); need('[aria-label^="Natural voice"]'); need('[aria-label="Speech speed"]'); need('[aria-label="Preview voice"]');` },
    settings: { url: problem, setup: `await import('/js/settings.js').then(m => m.openSettings());`, ready: '.settings', assert: `
      const background = getComputedStyle(need('.settings')).backgroundColor;
      if (background.startsWith('rgba(') && !background.endsWith(', 1)')) throw Error('Reading overlay is translucent: ' + background);` },
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
          await until("document.readyState === 'complete' && document.querySelector('.catalog,.ws,.roadmap,.dash-card,.th,.dz-view,.lld-view,.pr-view,.problem-import')", 'view');
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
          if (state === 'reference') {
            // Exercise every token through the real highlighter on the real drawer
            // surface, including tokens absent from the selected reference solution.
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
