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
  // The floating launcher never shows; the rail (docked) or the file row's Show sidebar
  // button owns the toggle. Preserve the open state when a route restores it.
  const coach = `if (!document.querySelector('.coach-bar')?.getClientRects().length) {
    let toggle = null;
    for (let attempt = 0; attempt < 20 && !toggle; attempt++) {
      const selector = visible(document.querySelector('[data-pane="coach"]')) ? '[data-pane="coach"]' : '.editor-open-sidebar';
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
  // Run Python output (LLD mock and practice): the real button and panel, with only the
  // run request answered by a made-up runner result so no screenshot depends on Python.
  const scriptTrace = ['Traceback (most recent call last):',
    '  File "/tmp/studio-run/_studio_driver.py", line 5, in <module>',
    '    runpy.run_path("solution.py", run_name="__main__")',
    '  File "<frozen runpy>", line 287, in run_path',
    '  File "<frozen runpy>", line 98, in _run_module_code',
    '  File "<frozen runpy>", line 88, in _run_code',
    '  File "solution.py", line 14, in <module>',
    '    lockers.assign(Parcel("P-102", size="large"))',
    '  File "solution.py", line 9, in assign',
    '    slot = self.free[parcel.size].pop()',
    "KeyError: 'large'"].join('\n');
  const scriptRuns = {
    output: { status: 'ok', exitCode: 0, stdout: 'Locker L1 assigned to parcel P-100\nLocker L2 assigned to parcel P-101\nPickup code 4821 accepted for P-100\n', stderr: '', timedOut: false, truncated: false, ms: 41.6 },
    error: { status: 'ok', exitCode: 1, stdout: 'Locker L1 assigned to parcel P-100\n', stderr: scriptTrace + '\n', timedOut: false, truncated: false, ms: 38.2 },
    truncated: { status: 'output-limit', exitCode: null, stdout: Array.from({ length: 60 }, (_, i) => `tick ${i + 1}: locker L${(i % 4) + 1} polled`).join('\n') + '\n', stderr: '', timedOut: false, truncated: true, ms: 2140 },
  };
  const pythonRunState = ({ result, width, practice = false, ready = '.pyrun .rr-case', assert = '' }) => ({
    url: practice ? '/#/lld/practice/lld-locker/visual-practice-lld' : '/#/lld/lld-locker/1760000000000-00000009', width,
    ready,
    setup: `for(let i=0;i<200&&(!document.querySelector('.ci-panel,.pr-coach')||!document.querySelector('.python-run')||document.querySelector('.python-run').disabled||!window.monaco?.editor.getEditors().length);i++)await sleep(50);
      const real=window.fetch, endpoint=${JSON.stringify(practice ? '/api/practice/run' : '/api/lld/run')};
      window.fetch=(url,options)=>String(url)===endpoint?Promise.resolve(new Response(JSON.stringify(${JSON.stringify(result)}),{status:200,headers:{'content-type':'application/json'}})):real(url,options);
      try { need('.python-run').click(); for(let i=0;i<100&&!document.querySelector('.pyrun .rr-case');i++)await sleep(50); } finally { window.fetch=real; }
      need('.pyrun').scrollIntoView({block:'nearest'});`,
    assert: `const out=need('.pyrun'), doc=out.parentElement.getBoundingClientRect(), box=out.getBoundingClientRect();
      if (out.scrollWidth > out.clientWidth + 1) throw Error('Run output scrolls sideways');
      if (box.left < doc.left - 1 || box.right > doc.right + 1 || box.bottom > doc.bottom + 1) throw Error('Run output escapes the document pane');
      if (getComputedStyle(need('.pyrun .rr-headline')).color !== getComputedStyle(need('.pyrun .rr-dot')).backgroundColor) throw Error('Verdict dot and headline disagree');
      need('.pyrun [aria-label="Hide output"]');` + assert,
  });
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
  // The track home renders once its three saved-record requests arrive; every state
  // waits for that paint before it clicks, so a late render cannot move a target.
  const homeLoaded = `for (let i=0; i<100 && !document.querySelector('.th[data-state]'); i++) await sleep(50);
    await document.fonts.ready; await new Promise(requestAnimationFrame);`;
  const homeFits = `if (document.documentElement.scrollWidth > innerWidth) throw Error('The track home scrolls sideways');
    const wrap = need('.th-wrap').getBoundingClientRect(); if (wrap.width > 1321) throw Error('The track home is wider than its column');
    if (document.querySelectorAll('.th-problem[aria-pressed="true"]').length > 1) throw Error('At most one problem may be chosen');
    if (document.querySelectorAll('.th-detail .th-act').length !== 2) throw Error('The panel must always offer both Practise and Mock');
    if (document.querySelector('.th-problem[data-open]')) throw Error('The list holds only real problems');`;
  // Nothing chosen: both ways in, each with its Problem choice (LLD mocks offer Surprise me alone).
  const nothingChosen = track => `if (document.querySelector('.th-problem[aria-pressed="true"]')) throw Error('A problem is chosen on arrival');
    if (need('.th-detail-title').textContent !== 'Start something new') throw Error('The panel does not offer something new');
    need('.th-practice'); need('.th-mock .ci-start');
    if (need('.th-pick[data-kind="practise"] .ui-select-button').getAttribute('aria-label') !== 'Problem: Surprise me') throw Error('Practice does not default to Surprise me');
    ${track === 'design' ? `if (need('.th-pick[data-kind="mock"] .ui-select-button').getAttribute('aria-label') !== 'Problem: Surprise me') throw Error('The mock does not default to Surprise me');`
      : `if (document.querySelector('.th-pick[data-kind="mock"] .ui-select')) throw Error('An LLD mock offers a choice it cannot run'); need('.th-pick[data-kind="mock"] .th-pick-hint');`}
    for (const a of document.querySelectorAll('.th-act')) if (a.querySelector('.th-brief:not([hidden])')) throw Error('A brief field shows before My own problem is chosen');
    need('.th-act--practise [aria-label="Answer mode: Voice"]'); need('.th-act--practise .coach-model-picker');
    if (document.querySelector('.th-act--practise [aria-label^="Interview length"]')) throw Error('Practice offers a clock');`;
  const chooseProblem = (kind, text) => `need('.th-pick[data-kind="${kind}"] .ui-select-button').click(); await sleep(80); clickText('.ui-menu:not([hidden]) .ui-menu-item', '${text}'); await sleep(120);`;
  // Many made-up problems so the list is longer than the panel, for the pinned-card states.
  const longList = () => remount(`if (String(url).startsWith('/api/track-home')) { const d = await (await real(url, ...rest)).json();
      for (let i = 1; i <= 16; i++) d.problems.push({ slug: 'lld-sample-' + i, title: 'Sample problem ' + i, statement: 'A made-up problem for layout checks.', discipline: 'lld' });
      return json(d); }`) + ` for (let i=0; i<100 && !document.querySelector('.th[data-state="ready"] .th-problem[data-slug="lld-sample-16"]'); i++) await sleep(50); await new Promise(requestAnimationFrame);`;
  // Scrolled half way down the list: the panel stays whole on screen under the app bar and overlaps nothing.
  const cardPinned = `const bar = need('.topbar').getBoundingClientRect(), d = need('.th-detail').getBoundingClientRect(), list = need('.th-picker').getBoundingClientRect();
    if (getComputedStyle(need('.th-detail')).position !== 'sticky') throw Error('The panel is not pinned');
    if (scrollY < 200) throw Error('The page did not scroll');
    if (d.top < bar.bottom + 8) throw Error('The panel runs under the app bar: ' + d.top + ' vs ' + bar.bottom);
    if (d.bottom > innerHeight) throw Error('The pinned panel is cut off at the bottom');
    if (d.left < list.right) throw Error('The panel overlaps the list');
    const lower = need('.th-lower').getBoundingClientRect(); if (d.bottom > lower.top) throw Error('The panel overlaps Where you stand');
    const cont = document.querySelector('.th-continue')?.getBoundingClientRect(); if (cont && cont.bottom > d.top && cont.top < d.bottom) throw Error('The panel overlaps Continue');`;
  const reveal = selector => `{ const n = need(${JSON.stringify(selector)}); document.scrollingElement.scrollTo({ top: n.getBoundingClientRect().top + scrollY - (document.querySelector('.topbar')?.getBoundingClientRect().height || 0) - 40, behavior: 'instant' }); await sleep(80); }`;
  const stacked = `const l = need('.th-picker').getBoundingClientRect(), d = need('.th-detail').getBoundingClientRect(); if (d.top < l.bottom) throw Error('Narrow: the panel does not sit under the list');`;
  const pick = selector => ({
    url: '/#/lld',
    setup: `${homeLoaded} need(${JSON.stringify(selector)}).click(); await sleep(50);`,
    ready: `${selector}[aria-pressed="true"]`,
  });
  const lldSelection = { ...pick('.th-problem[data-slug="lld-vending-machine"]'), assert: homeFits + `
      for (const s of ['.th-mock .ci-start', '.th-practice']) { const n = need(s); document.scrollingElement.scrollTo({ top: n.getBoundingClientRect().top + scrollY - innerHeight / 2, behavior: 'instant' }); await sleep(50); const c = n.getBoundingClientRect();
        if (c.left<0 || c.right>innerWidth || c.top<0 || c.bottom>innerHeight) throw Error(s + ' is outside the viewport'); }
      if (!need('.th-detail-title').textContent.includes('Vending')) throw Error('The panel does not show the chosen problem');
      need('.th-past-list .th-past'); need('.th-clear');
      if (document.querySelector('.th-pick:not([hidden])')) throw Error('A chosen problem still offers Surprise me');` };
  // A workspace with no records at all: the real catalog, nothing done on it.
  const remount = override => `${homeLoaded}
    const real = window.fetch, json = value => new Response(JSON.stringify(value), { status: value.error ? 500 : 200, headers: { 'content-type': 'application/json' } });
    window.fetch = async (url, ...rest) => { ${override} return real(url, ...rest); };
    const { mountTrackHome } = await import('/js/track-home.js');
    mountTrackHome(need('.lld-view'), { discipline: 'lld', title: 'Low-level design', loadInterviews: async () => ({ interviews: [] }), openInterview() {}, startMock: async () => {} });
    await sleep(50);
    window.fetch = real;`;
  const lldEmpty = { url: '/#/lld', ready: '.th[data-state="ready"] .th-stand-empty',
    setup: remount(`const u = String(url); if (u.startsWith('/api/track-home')) { const d = await (await real(url, ...rest)).json(); d.assessments = []; return json(d); } if (u.startsWith('/api/practice?')) return json({ sessions: [] });`),
    assert: homeFits + `if (document.querySelector('.th-continue')) throw Error('Continue shows with nothing to continue');
      if (!need('.th-summary').textContent.startsWith('3 problems') || need('.th-summary').textContent.includes('·')) throw Error('Empty header counts: ' + need('.th-summary').textContent);
      need('.th-rubric-names li'); need('.th-mock .ci-start'); need('.th-practice');` };
  const lldError = { url: '/#/lld', ready: '.th[data-state="error"]',
    setup: remount(`if (String(url).startsWith('/api/track-home')) return json({ error: { message: 'The saved records could not be read.' } });`),
    assert: `if (!need('.th-picker .th-quiet').textContent.includes('could not be read')) throw Error('The read error is not shown'); if (document.querySelector('.th-detail:not(:empty)')) throw Error('A panel shows without records');` };
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
    const body=need('.pr-feedback .ui-conversation-text'), log=need('.pr-feedback-pane');
    if(!/no structured report/i.test(need('.pr-report-source').textContent))throw Error('Fallback feedback does not say which it is');
    if(visible(document.querySelector('.pr-compose'))||visible(document.querySelector('.pr-thread')))throw Error('Mock feedback tab shows the conversation or composer');
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
    url:'/#/lld/practice/lld-locker/visual-branch-lld', width, height:900, ready:'.pr-feedback', keyboardFocus:'.pr-feedback-pane',
    setup:`for(let i=0;i<100&&!document.querySelector('.pr-tabs [data-tab=feedback]');i++)await sleep(50);need('.pr-tabs [data-tab=feedback]').click();need('.pr-coach').scrollIntoView({block:'center'});const log=need('.pr-feedback-pane');log.scrollTop=${scrolled ? 240 : 0};log.focus({preventScroll:true});`,
    assert:feedbackAssertions + (scrolled ? `const f=need('.pr-feedback-pane');if(f.scrollTop<Math.min(200,f.scrollHeight-f.clientHeight-1)||f.scrollTop<1)throw Error('Feedback did not scroll');` : ''),
  });
  const mockTimeSetup = `for(let i=0;i<100&&document.querySelector('.mock-add-time')?.disabled;i++)await sleep(50);need('.ci-clock').textContent='+03:00';need('.mock-add-time').click();`;
  // A live system design mock, served entirely from this page: the record, resume and pause
  // answer locally, and every turn route is refused here, so nothing reaches a model.
  const liveDesignMock = (paused = false, overrides = {}) => `
    const real = window.fetch, json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    const startedAt = new Date(Date.now() - 780000).toISOString();
    const turns = [
      { kind: 'opening', phase: 'requirements', elapsedMs: 0, asked: 'Design a URL-shortening service. Where would you like to start?' },
      { kind: 'turn', phase: 'requirements', elapsedMs: 240000, said: 'Reads dominate, so I will plan for about a hundred reads per write.', asked: 'Good. What does the write path look like?' },
      { kind: 'turn', phase: 'api', elapsedMs: 600000, said: 'A POST that takes the long URL and returns the short code.', asked: 'How do you generate codes without collisions?' },
    ];
    const record = { id: 'visual-live-design', prompt: 'URL shortener', topicSlug: 'design-url-shortener', level: 'L4', minutes: 45, phase: 'api', mode: 'typed', startedAt, debriefed: false, resumable: true, rebuilt: false, turns, elements: [], ...${JSON.stringify(overrides)} };
    window.fetch = async (url, init) => {
      const u = String(url);
      if (u === '/api/design/visual-live-design') return json(record);
      if (u === '/api/design/resume') return json({ ...record, resumed: true, startedAt });
      if (u === '/api/design/pause') return json({ spentMs: 780000 });
      if (u.startsWith('/api/design/')) return json({ error: { message: 'Visual audit: no turns' } }, 409);
      return real(url, init);
    };
    location.hash = '#/design/visual-live-design';
    for (let i = 0; i < 100 && !(document.querySelector('.dz-log .dz-entry') && !need('.dz-pause').disabled); i++) await sleep(50);
    ${paused ? `need('.dz-pause').click(); for (let i = 0; i < 100 && document.querySelector('.dz-side .mock-paused')?.hidden; i++) await sleep(50);` : ''}`;
  // One session cluster in the header for every mock; Learning notes waits in More actions.
  const mockSessionAssert = (kind, paused) => `
    const header = need('.ui-screen-header'), toggle = need(${JSON.stringify(kind === 'design' ? '.dz-pause' : '.ci-pause')});
    if (!header.contains(toggle) || !visible(toggle)) throw Error('Pause/Resume is not in the header');
    if (!visible(need(${JSON.stringify(kind === 'design' ? '.dz-done' : '.ci-finish')}))) throw Error('Finish is not visible');
    if ([...header.querySelectorAll('button')].some(b => visible(b) && b.textContent.trim() === 'Learning notes')) throw Error('Learning notes sits beside Finish in a live mock');
    const band = document.querySelector('.mock-paused');
    if (!band) throw Error('Missing the paused band');
    if (${paused} !== Boolean(visible(band))) throw Error('Paused band visibility is wrong');
    if (${paused} && !/^Paused · \\d+:\\d\\d (left|over)Resume$/.test(band.textContent.trim())) throw Error('Paused band does not read in remaining time: ' + band.textContent);
    if (${paused} && toggle.getAttribute('aria-label') !== 'Resume interview') throw Error('The header toggle does not offer Resume');
    if (document.querySelector('.voice-panel')?.textContent.includes('Voice paused') && ${paused}) throw Error('The composer repeats the paused state');
    const steps = [...document.querySelectorAll('.ui-phase-stepper .ui-phase-step')].filter(visible).map(n => n.getBoundingClientRect());
    if (steps.length !== ${kind === 'design' ? 7 : 5}) throw Error('Phase steps missing: ' + steps.length);
    for (const s of steps) if (steps.some(t => Math.abs(t.top - s.top) < 1 && Math.abs(t.width - s.width) > 1)) throw Error('Phase steps on a row are not equal width');
    if (parseFloat(getComputedStyle(need('.ui-phase-label')).fontSize) < parseFloat(getComputedStyle(document.body).getPropertyValue('--text-sm')) - .1) throw Error('Phase labels are smaller than --text-sm');
    if (document.querySelectorAll('.ui-phase-stepper [aria-current=step]').length !== 1) throw Error('Exactly one current phase');
    if (document.documentElement.scrollWidth > innerWidth) throw Error('Mock screen overflows sideways');`;
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
  // Practice tabs: Coach, Problem and Mock feedback, each its own scroller.
  const practiceTab = ({ id, tab, width = 1440, ready, scroll = 0, assert = '' }) => ({
    url: `/#/lld/practice/lld-locker/${id}`, width, height: 900, ready,
    setup: `for(let i=0;i<100&&!document.querySelector('.pr-tabs [data-tab=${tab}]');i++)await sleep(50);need('.pr-tabs [data-tab=${tab}]').click();await sleep(60);${width < 900 ? "need('.pr-coach').scrollIntoView({block:'center'});" : ''}need('.pr-coach .ui-pane-scroll:not([hidden])').scrollTop=${scroll};`,
    assert: `const pane=need('.pr-coach .ui-pane-scroll:not([hidden])');if(pane.classList.contains('pr-thread'))throw Error('Tab did not switch');
      if(visible(document.querySelector('.pr-compose')))throw Error('The composer shows outside the Coach tab');
      if(need('.pr-tabs [data-tab=${tab}]').getAttribute('aria-selected')!=='true')throw Error('Tab not selected');
      const r=pane.getBoundingClientRect(),h=need('.pr-coach-head').getBoundingClientRect(),c=need('.pr-coach').getBoundingClientRect();
      if(r.top<h.bottom-1||r.bottom>c.bottom+1)throw Error('Tab panel escapes its pane');
      if(document.documentElement.scrollWidth>innerWidth)throw Error('Practice tab overflows sideways');` + assert,
  });
  // The pinned statement: the public one only, two lines until Show more.
  const LONG_PINNED = 'Design an in-memory reservation system for a made-up bank of parcel lockers in three sizes, where couriers deposit parcels and recipients collect them with single-use codes, codes expire after a configurable window, two couriers may race for the same compartment, and the operator can take a compartment out of service at any time without losing a parcel that is already inside it.';
  const pinnedAssert = (text, long) => `
    const pin=[...document.querySelectorAll('.ui-pinned-statement')].find(visible);if(!pin)throw Error('No pinned statement');
    const body=pin.querySelector('.ui-pinned-statement-text'),more=pin.querySelector('.ui-pinned-statement-more');
    if(body.textContent!==${JSON.stringify(text)})throw Error('Pinned statement is not the public statement: '+body.textContent);
    const line=parseFloat(getComputedStyle(body).lineHeight);if(body.getBoundingClientRect().height>line*2+1)throw Error('Pinned statement exceeds two lines');
    if(${long}!==Boolean(visible(more)))throw Error('Show more visibility is wrong');
    if(${long}&&!more.querySelector('svg'))throw Error('Show more is not a drawn control');
    const stepper=pin.parentElement.querySelector('.ui-phase-stepper');if(!stepper||pin.getBoundingClientRect().bottom>stepper.getBoundingClientRect().top+1)throw Error('Statement is not pinned above the phase stepper');
    if(document.documentElement.scrollWidth>innerWidth)throw Error('Pinned statement overflows');`;
  // A finished system design review served from this page: a made-up record and report in
  // the shape GET /api/design/:id returns. `board` is the last scene; `report: false` is a
  // debriefed interview with no report, so View report fails. No turn route is reachable.
  // `room` lets a section near the end scroll fully to the top instead of stopping wherever the end clamps it.
  const designReview = ({ id, board = [], report = true, open = true, scrollTo = null, block = 'start', room = false }) => `
    const real = window.fetch, json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    const minute = 60000, startedAt = new Date(Date.now() - 2 * 86400000).toISOString();
    const turns = [
      { kind: 'opening', elapsedMs: 0, asked: 'Design a parking garage system.' },
      { kind: 'candidate', elapsedMs: 4.5 * minute, phase: 'requirements', said: 'Drivers enter, park, and pay on exit. Three floors.' },
      { kind: 'turn', elapsedMs: 5 * minute, phase: 'entities', asked: 'What are the core entities?' },
      { kind: 'candidate', elapsedMs: 10.5 * minute, phase: 'entities', said: 'Spot, ticket, gate and payment.' },
      { kind: 'turn', elapsedMs: 11 * minute, phase: 'api', asked: 'What does the entry gate call?' },
      { kind: 'candidate', elapsedMs: 17.5 * minute, phase: 'api', said: 'POST /tickets returns a ticket and a spot.' },
      { kind: 'turn', elapsedMs: 18 * minute, phase: 'design', asked: 'Walk me through the high-level design.' },
      { kind: 'candidate', elapsedMs: 29.5 * minute, phase: 'design', said: 'Gate service, spot allocator, payments, one database.' },
      ...(${report} ? [{ kind: 'debrief', elapsedMs: 33 * minute, asked: '{}' }] : []),
    ];
    const rubric = ['Requirements', 'Estimation', 'Data modeling', 'Architecture', 'Trade-offs', 'Reliability', 'Communication'], ratings = ['Solid', null, 'Mixed', 'Solid', 'Weak', 'Mixed', 'Solid'];
    const report = ${report} ? {
      facts: { durationMs: 33 * minute, plannedMs: 45 * minute, mode: 'typed', hints: [], runs: [], verdicts: [], candidateTurns: 4, finalCode: null, finalBoard: ${board.length ? "{ nodes: [{ label: 'Gate service' }], edges: [], notes: [] }" : 'null'},
        phases: [['requirements', 4.5], ['entities', 6], ['api', 7], ['estimates', null], ['design', 12], ['deepdive', null], ['bottlenecks', null]].map(([phase, m]) => ({ phase, ms: m === null ? null : m * minute })) },
      judgement: { signal: 'Lean hire', headline: 'A clear gate flow; the allocator never faced contention.', summary: null,
        moveUp: 'Name the contention point on spot allocation and choose a locking strategy out loud.',
        dimensions: rubric.map((name, i) => ({ name, rating: ratings[i], summary: ratings[i] ? 'Observed in the ' + name.toLowerCase() + ' discussion.' : null, evidence: ratings[i] ? [{ at: 12 * minute, quote: null, note: 'Seen while discussing ' + name.toLowerCase() + '.', provenance: 'interpretation' }] : [] })),
        strengths: ['Settled the requirements before drawing.'], improvements: [], technicalErrors: [], missingConsiderations: [], discoveries: [],
        moments: [{ at: 18 * minute, kind: 'insight', text: 'Split the allocator from the gate.' }], code: null,
        practice: [{ title: 'Contention drill', why: 'Two drivers can be given the same spot.', fix: 'Lock one spot per allocation', at: 18 * minute }] },
    } : null;
    const record = { id: ${JSON.stringify(id)}, title: 'Parking garage', prompt: 'Parking garage', topicSlug: 'design-url-shortener', level: 'L4', minutes: 45, phase: 'design', mode: 'typed', startedAt,
      debriefed: true, resumable: false, rebuilt: false, elapsedMs: 33 * minute, turns, elements: ${JSON.stringify(board)}, scenes: ${board.length ? 1 : 0}, report, followups: [] };
    window.fetch = async (url, init) => String(url) === '/api/design/' + record.id ? json(record) : real(url, init);
    location.hash = '#/design/' + record.id;
    const viewReport = () => [...document.querySelectorAll('.ui-screen-header .btn--primary')].find(b => b.textContent.includes('View report'));
    for (let i = 0; i < 100 && !viewReport(); i++) await sleep(50);
    ${open ? `need('.dz-view'); viewReport().click();` : ''}
    ${scrollTo ? `for (let i = 0; i < 100 && !document.querySelector(${JSON.stringify(scrollTo)}); i++) await sleep(50); ${room ? "need('.rp-body').style.paddingBottom = '100vh';" : ''} need(${JSON.stringify(scrollTo)}).scrollIntoView({ block: ${JSON.stringify(block)} }); await sleep(100);` : ''}`;
  const reviewBox = (x, y, label, id) => [
    { id, type: 'rectangle', x, y, width: 180, height: 70, strokeColor: '#1e1e1e', backgroundColor: 'transparent', boundElements: [{ type: 'text', id: id + '-t' }] },
    { id: id + '-t', type: 'text', x: x + 10, y: y + 22, width: 160, height: 25, text: label, originalText: label, fontSize: 20, fontFamily: 5, lineHeight: 1.25, containerId: id, textAlign: 'center', verticalAlign: 'middle', strokeColor: '#1e1e1e' },
  ];
  const reviewBoard = [...reviewBox(0, 0, 'Gate service', 'gate'), ...reviewBox(300, 0, 'Spot allocator', 'alloc'), ...reviewBox(300, 160, 'Payments', 'pay'), ...reviewBox(600, 80, 'Garage DB', 'db'),
    { id: 'a1', type: 'arrow', x: 180, y: 35, width: 120, height: 0, points: [[0, 0], [120, 0]], strokeColor: '#1e1e1e' },
    { id: 'a2', type: 'arrow', x: 480, y: 35, width: 120, height: 80, points: [[0, 0], [120, 80]], strokeColor: '#1e1e1e' }];
  const boardFits = `const f = need('.rp-board').getBoundingClientRect(), s = need('.rp-board-svg').getBoundingClientRect(), sec = need('.rp-board-section').getBoundingClientRect();
    if (s.width > f.width + 1 || f.right > sec.right + 1) throw Error('The board is wider than its section');
    if (s.height < 40) throw Error('The board was not drawn');
    if (![...document.querySelectorAll('.rp-stat')].some(n => n.textContent === 'BoardDrawn')) throw Error('The Board stat does not say Drawn');`;
  const boardEmpty = `if (!need('.rp-board-section').textContent.includes('The board was empty.')) throw Error('An empty board is not stated');
    if (document.querySelector('.rp-board')) throw Error('An empty board drew a figure');
    if (![...document.querySelectorAll('.rp-stat')].some(n => n.textContent === 'BoardEmpty')) throw Error('The Board stat does not say Empty');`;
  const reviewError = `const status = need('.dz-review-status');
    if (status.getAttribute('role') !== 'alert' || !status.textContent.includes('could not be opened')) throw Error('The failure is not an alert');
    if ([...document.querySelectorAll('.dz-log .dz-entry')].some(n => n.textContent.includes('No completed report'))) throw Error('The failure was posted into the transcript');
    if (document.documentElement.scrollWidth > innerWidth) throw Error('The review overflows');`;
  // An LLD review whose debrief is prose with no structured judgement: only what it rated is shown as a rating.
  const lldProseReview = `const real = window.fetch; window.fetch = async (...args) => { const response = await real(...args); if (String(args[0]).startsWith('/api/interview/lld-locker/1760000000000-00000010')) { const data = await response.json(); for (const t of data.turns || []) if (t.kind === 'debrief') t.asked = ${JSON.stringify('## Hire signal\nLean hire — ownership was clear, expiry came late.\n\n## Interfaces\nSolid — `reserve()` and `release()` were small and named well.\n\n## Edge cases\nMixed — expiry during pickup was raised by the interviewer.\n\n## What to work on next\nTrace one expiry path before writing the class.')}; return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); } return response; }; location.hash = '#/lld/lld-locker/1760000000000-00000010';`;
  const lldProseAssert = `const t = need('.ci-feedback').textContent;
    if (/Problem solving|Testing|Not rated/.test(t)) throw Error('The LLD review lists the coding rubric');
    if (!t.includes('Interfaces') || !t.includes('Edge cases')) throw Error('The rated sections are missing');
    if ([...document.querySelectorAll('.ci-open-report')].length > 1 || !/^View report$/.test(need('.ci-open-report').textContent.trim())) throw Error('The pane does not offer one View report');`;
  const lldLongStatement = `const real=window.fetch;window.fetch=async(...args)=>{const response=await real(...args);if(String(args[0])==='/api/lld'){const data=await response.json();for(const p of data.scenarios)if(p.slug==='lld-locker')p.statement=${JSON.stringify(LONG_PINNED)};return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});}return response;};location.hash='#/lld/lld-locker/1760000000000-00000009';`;
  // Pictures go into the first two examples: a tall tree and a wide list, white like LeetCode's.
  const stmtFigureSetup = pane => `if (document.body.classList.contains('coach-open')) { need('.coach-hide').click(); await sleep(300); }
    need('.pbody.with-workspace').style.gridTemplateColumns = '${pane}px minmax(0,1fr)';
    for (let i = 0; i < 40 && !document.querySelector('.stmt-example .ex-body'); i++) await sleep(100);
    const draw = async (w, h, shapes) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.strokeStyle = '#222'; g.lineWidth = 4; shapes(g); const img = new Image(); img.alt = ''; img.src = c.toDataURL(); await img.decode(); const fig = document.createElement('div'); fig.className = 'ex-figure'; fig.append(img); return fig; };
    const cards = [...document.querySelectorAll('.stmt-example .ex-body')];
    cards[0].prepend(await draw(420, 460, g => { for (const [x, y] of [[210, 60], [110, 220], [310, 220], [250, 390], [370, 390]]) { g.beginPath(); g.arc(x, y, 44, 0, 7); g.stroke(); } }));
    cards[1].prepend(await draw(780, 150, g => { for (let i = 0; i < 6; i++) g.strokeRect(40 + i * 125, 45, 70, 60); }));
    await sleep(200);`;
  // Wherever a picture and a row share a line, at least 12px lie between them; stacked, 12px
  // lie between the picture's foot and the first row. No picture leaves its example.
  const stmtFigureAssert = `
    const figures = [...document.querySelectorAll('.stmt-example :is(.ex-figure, .ex-value.is-figure) img')];
    if (!figures.length) throw Error('Picture fixture missing');
    for (const img of figures) {
      const card = img.closest('.stmt-example').getBoundingClientRect(), r = img.getBoundingClientRect();
      if (r.height > 261) throw Error('An example picture is taller than its cap: ' + r.height);
      if (r.left < card.left - .5 || r.right > card.right + .5 || r.bottom > card.bottom + .5) throw Error('An example picture overflows its example');
      for (const n of img.closest('.stmt-example').querySelectorAll('.ex-label, .ex-value')) {
        if (n.contains(img)) continue;
        const t = n.getBoundingClientRect();
        if (!t.width || !t.height) continue;
        const beside = t.top < r.bottom - .5 && t.bottom > r.top + .5;
        if (beside) { const gap = t.left >= r.right ? t.left - r.right : r.left - t.right; if (gap < 12) throw Error('A picture sits ' + Math.round(gap) + 'px from "' + n.textContent.slice(0, 20) + '" beside it'); }
        else if (t.top >= r.bottom - .5 && t.top - r.bottom < 12) throw Error('A picture sits ' + Math.round(t.top - r.bottom) + 'px above "' + n.textContent.slice(0, 20) + '"');
      }
    }
    const starts = [...document.querySelectorAll('.stmt-example .ex-value')].map(n => Math.round(n.getBoundingClientRect().left));
    if (new Set(starts).size !== 1) throw Error('A picture moved its example values off the shared line: ' + starts.join(','));`;
  // A live conversation with a pinned header above it and a composer below it. Measured,
  // not eyeballed: every transcript line painted inside the scroll viewport must sit in the
  // gap between the header and the composer (never under either, never in a strip above the
  // header or below the composer); at the bottom the newest turn and its actions are whole;
  // Jump to latest floats clear of the composer and of turn actions.
  const transcriptClear = ({ panel, log, header, composer, atBottom = false, jump = false }) => `{
    const P = need(${JSON.stringify(panel)}), L = P.querySelector(${JSON.stringify(log)});
    const H = [...P.querySelectorAll(${JSON.stringify(header)})].find(visible), C = [...P.querySelectorAll(${JSON.stringify(composer)})].find(visible);
    if (!L || !H || !C) throw Error('Missing transcript, pinned header or composer');
    let S = L;
    while (S && S !== document.body && !(/auto|scroll/.test(getComputedStyle(S).overflowY) && S.scrollHeight > S.clientHeight + 1)) S = S.parentElement;
    if (!S || S === document.body) throw Error('The transcript fixture is too short to scroll');
    const sb = S.getBoundingClientRect(), lb = L.getBoundingClientRect();
    // Painted transcript = the scroller's client box, clipped again by the log when the log is not the scroller.
    const view = { top: Math.max(sb.top + S.clientTop, S === L ? -1e9 : lb.top), bottom: Math.min(sb.top + S.clientTop + S.clientHeight, sb.bottom, S === L ? 1e9 : lb.bottom) };
    const h = H.getBoundingClientRect(), c = C.getBoundingClientRect();
    const hit = (a, b) => a.left < b.right - .5 && a.right > b.left + .5 && a.top < b.bottom - .5 && a.bottom > b.top + .5;
    const range = document.createRange(), walker = document.createTreeWalker(L, NodeFilter.SHOW_TEXT);
    let t, shown = 0;
    while ((t = walker.nextNode())) {
      if (!t.textContent.trim() || !visible(t.parentElement)) continue;
      range.selectNodeContents(t);
      for (const line of range.getClientRects()) {
        if (!line.width || line.bottom <= view.top + .5 || line.top >= view.bottom - .5) continue;
        // Only the part of the line the scroller actually paints.
        const r = { left: line.left, right: line.right, top: Math.max(line.top, view.top), bottom: Math.min(line.bottom, view.bottom) };
        shown++;
        const what = JSON.stringify(t.textContent.trim().slice(0, 32));
        if (hit(r, h)) throw Error('Transcript text ' + what + ' is painted under the pinned header');
        if (hit(r, c)) throw Error('Transcript text ' + what + ' is painted under the composer (line ' + Math.round(r.top) + '-' + Math.round(r.bottom) + ', composer from ' + Math.round(c.top) + ', transcript to ' + Math.round(view.bottom) + ')');
        if (r.top < h.top - .5 && r.bottom > sb.top) throw Error('Transcript text ' + what + ' shows in the strip above the pinned header');
        if (r.bottom > c.bottom + .5) throw Error('Transcript text ' + what + ' shows below the composer');
      }
    }
    if (!shown) throw Error('No transcript text is on screen');
    const actions = [...L.querySelectorAll('.ui-message-action')].filter(visible).map(n => n.getBoundingClientRect()).filter(r => r.bottom > view.top && r.top < view.bottom);
    const pill = [...P.querySelectorAll('.ui-jump-latest')].find(visible);
    if (${atBottom}) {
      if (S.scrollHeight - S.scrollTop - S.clientHeight > 1) throw Error('The transcript is not pinned to the latest turn (' + Math.round(S.scrollHeight - S.scrollTop - S.clientHeight) + 'px short)');
      const last = [...L.querySelectorAll('.ui-message')].filter(visible).at(-1);
      const own = [...(last?.querySelectorAll('.ui-message-action') || [])].filter(visible);
      if (!own.length) throw Error('The newest turn has no actions to measure');
      for (const a of own.map(n => n.getBoundingClientRect())) {
        if (a.top < view.top - .5 || a.bottom > view.bottom + .5 || a.bottom > c.top - 4 || hit(a, h)) throw Error('The actions of the newest turn are cut or covered');
      }
      if (pill) throw Error('Jump to latest shows while the reader is at the latest turn');
    }
    if (${jump}) {
      if (!pill) throw Error('Jump to latest did not appear for unread content');
      const p = pill.getBoundingClientRect();
      if (c.top - p.bottom < 8 - .5) throw Error('Jump to latest is ' + Math.round(c.top - p.bottom) + 'px from the composer (needs 8)');
      if (p.top < view.top) throw Error('Jump to latest leaves the transcript');
      for (const a of actions) {
        const gap = Math.max(a.left - p.right, p.left - a.right, a.top - p.bottom, p.top - a.bottom);
        if (gap < 8 - .5) throw Error('Jump to latest is ' + Math.round(gap) + 'px from a turn action (needs 8)');
      }
    } }`;
  // The long live voice mock in the coach sidebar's Interviews tab. Served from this page:
  // the record answers as running, and it is not this browser's active interview, so the
  // panel never sends a turn. The live answer is put in the composer's draft (what the
  // voice bar shows) without an input event, so nothing is saved.
  const LIVE_ANSWER = 'So the plan is to keep a single furthest-reach value and walk the array once. '.repeat(9).trim();
  const liveVoiceMock = ({ scrolled = false, phone = false, narrow = false } = {}) => ({ url: problem,
    setup: `const originalFetch = window.fetch; window.fetch = async (...args) => { const response = await originalFetch(...args); if (String(args[0]).includes('/api/interview/jump-game/1760000000000-00000004')) { const data = await response.json(); data.startedAt = Date.now() - 1260000; data.pausedAt = null; data.lastSpeechAt = Date.now(); data.lastTypingAt = Date.now(); return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); } return response; };
      // A reading position saved by an earlier state would (rightly) be restored; start fresh.
      const back = document.querySelector('.interview-back'); if (visible(back)) { back.click(); await sleep(50); }
      (await import('/js/sidebar-state.js')).saveSidebar('jump-game', { interviewScroll: {} });
      ${narrow ? `{ const columns = need('.pbody').style.gridTemplateColumns.split(/ (?=minmax)/); columns[columns.length - 1] = '300px'; need('.pbody').style.gridTemplateColumns = columns.join(' '); await sleep(100); }` : ''}
      (await import('/js/interview.js')).openInterviewRecord('jump-game', '1760000000000-00000004');
      for (let i = 0; i < 100 && document.querySelectorAll('.ci-embedded .ci-log .ui-message').length < 19; i++) await sleep(50);
      document.querySelector('.ci-embedded .ci-input').value = ${JSON.stringify(LIVE_ANSWER)};
      for (let i = 0; i < 40 && !visible(document.querySelector('.ci-embedded .voice-transcript')); i++) await sleep(50);
      await sleep(150);
      ${phone ? `need('.ci-embedded .ui-composer').scrollIntoView({ block: 'end' }); await sleep(100);` : ''}
      ${scrolled ? `{ const log = need('.ci-embedded .ci-log'); let s = log; while (s !== document.body && !(/auto|scroll/.test(getComputedStyle(s).overflowY) && s.scrollHeight > s.clientHeight + 1)) s = s.parentElement;
        s.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true })); s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) * .55); await sleep(100);
        log.append(document.createElement('span')); await sleep(150); }` : ''}`,
    ready: '.ci-embedded[data-mode="voice"] .voice-transcript:not([hidden])',
    assert: `const words = need('.ci-embedded .voice-transcript'); if (!words.textContent.includes('walk the array once')) throw Error('The live answer is not shown');
      if (words.scrollHeight > words.clientHeight + 1 && words.scrollHeight - words.scrollTop - words.clientHeight > 2) throw Error('The newest dictated line is scrolled out of view');
      if (need('.ci-embedded .ui-composer').getBoundingClientRect().height > need('.ci-embedded').getBoundingClientRect().height * .5 + 1) throw Error('The composer takes more than half the interview');`
      + transcriptClear({ panel: '.ci-embedded', log: '.ci-log', header: '.ci-live-header', composer: '.ui-composer', atBottom: !scrolled, jump: scrolled }) });
  // The same measurement on every other surface with a pinned header above a transcript
  // and a composer below it. The conversation is lengthened on the page (copies of its own
  // turns, or made-up turns when it has none) so the transcript scrolls; the reader is at
  // the latest turn.
  const lengthen = (log) => `{
    const L = need(${JSON.stringify(log)}), conv = await import('/js/ui/conversation.js');
    if (!L.querySelector('.ui-message')) for (let i = 1; i <= 3; i++) {
      const m = document.createElement('div'); m.className = 'ui-message ui-turn';
      m.append(conv.conversationText('Made-up answer ' + i + '. ' + 'Compare the two traces before naming the gap, then test the boundary. '.repeat(3)));
      const row = document.createElement('div'); row.append(conv.messageAction(document.createElement('button'), 'copy', 'Copy reply')); m.append(row); L.append(m);
    }
    const turns = [...L.querySelectorAll('.ui-message')];
    for (let round = 0; round < 8 && L.scrollHeight < L.clientHeight * 2.5; round++) for (const t of turns) L.append(t.cloneNode(true));
    await sleep(100); L.scrollTop = L.scrollHeight; await sleep(200); }`;
  const surfaceClear = ({ panel, log, header, composer, ...state }) => ({ width: 1440, height: 900, ...state,
    setup: (state.setup || '') + `for (let i = 0; i < 100 && !document.querySelector(${JSON.stringify(panel + ' ' + log)}); i++) await sleep(50);` + lengthen(panel + ' ' + log),
    assert: (state.assert || '') + transcriptClear({ panel, log, header, composer, atBottom: true }) });
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
    designReportBoard: { url: '/#/design', width: 1440, height: 900, setup: designReview({ id: '2026-11-02T10-00-00-000Z', board: reviewBoard, scrollTo: '.rp-board[data-state=ready]' }), ready: '.rp-sheet[open] .rp-board[data-state=ready]', assert: boardFits },
    designReportBoardNarrow: { url: '/#/design', width: 390, setup: designReview({ id: '2026-11-02T10-00-00-000Z', board: reviewBoard, scrollTo: '.rp-board[data-state=ready]' }), ready: '.rp-sheet[open] .rp-board[data-state=ready]', assert: boardFits },
    designReportPhases: { url: '/#/design', width: 1440, height: 900, setup: designReview({ id: '2026-11-02T10-00-00-000Z', board: reviewBoard, scrollTo: '.rp-section:has(.rp-timeline)', block: 'start', room: true }), ready: '.rp-sheet[open] .rp-track', assert: `const l = need('.rp-legend').textContent; if (!l.includes('Requirements') || !l.includes('Not recorded: Estimates, Deep dive, Bottlenecks')) throw Error('Design phases are not labelled: ' + l);` },
    designReportEmpty: { url: '/#/design', width: 1440, height: 900, setup: designReview({ id: '2026-11-02T11-00-00-000Z', scrollTo: '.rp-board-section' }), ready: '.rp-sheet[open] .rp-board-section', assert: boardEmpty },
    designReportEmptyNarrow: { url: '/#/design', width: 390, setup: designReview({ id: '2026-11-02T11-00-00-000Z', scrollTo: '.rp-board-section' }), ready: '.rp-sheet[open] .rp-board-section', assert: boardEmpty },
    designReviewError: { url: '/#/design', width: 1440, height: 900, setup: designReview({ id: '2026-11-02T12-00-00-000Z', report: false }), ready: '.dz-review-status:not([hidden])', assert: reviewError },
    designReviewErrorNarrow: { url: '/#/design', width: 390, setup: designReview({ id: '2026-11-02T12-00-00-000Z', report: false }), ready: '.dz-review-status:not([hidden])', assert: reviewError },
    lldReviewNoJudgement: { url: '/#/lld', width: 1440, height: 900, setup: lldProseReview, ready: '.ci-feedback .ci-score-hero', assert: lldProseAssert },
    lldReviewNoJudgementNarrow: { url: '/#/lld', width: 390, setup: lldProseReview + `for(let i=0;i<100&&!document.querySelector('.ci-feedback .ci-score-hero');i++)await sleep(50);need('.ci-feedback').scrollIntoView({block:'start'});`, ready: '.ci-feedback .ci-score-hero', assert: lldProseAssert },
    practiceBranch: feedbackState(1440),
    practiceBranchNarrow: feedbackState(390),
    practiceBranchScrolled: feedbackState(1440,true),
    practiceBranchScrolledNarrow: feedbackState(390,true),
    practiceProblem: practiceTab({ id: 'visual-practice-lld', tab: 'problem', ready: '.pr-problem-pane .pr-statement', assert: `if(!/Design a locker system/.test(need('.pr-problem-pane').textContent))throw Error('Problem tab lacks the statement');` }),
    practiceProblemLong: practiceTab({ id: 'visual-practice-long', tab: 'problem', ready: '.pr-problem-pane .pr-statement', scroll: 260, assert: `const p=need('.pr-problem-pane');if(p.scrollHeight<=p.clientHeight)throw Error('Long statement should scroll in its tab');if(p.scrollTop<200)throw Error('Problem tab did not scroll');if(!p.querySelector('ul li strong,.rich strong'))throw Error('Statement Markdown is plain text');` }),
    practiceProblemLongNarrow: practiceTab({ id: 'visual-practice-long', tab: 'problem', width: 390, ready: '.pr-problem-pane .pr-statement', scroll: 260 }),
    practiceProblemEmpty: practiceTab({ id: 'visual-practice-open', tab: 'problem', ready: '.pr-problem-pane .pr-tab-empty', assert: `if(!/No problem recorded yet/.test(need('.pr-problem-pane').textContent))throw Error('Empty statement is not stated');` }),
    practiceFeedbackReport: practiceTab({ id: 'visual-branch-report-lld', tab: 'feedback', ready: '.pr-feedback-pane .rp-dim-row', assert: `const f=need('.pr-feedback-pane');if(!/report/.test(need('.pr-report-source').textContent))throw Error('Structured feedback does not say so');if(f.querySelectorAll('.rp-practice li').length!==3)throw Error('Fix these list missing');if(!f.querySelector('.rp-rating[data-tone]'))throw Error('Rating pills missing');if(!f.querySelector('.rp-evidence .rp-time'))throw Error('Evidence times missing');f.querySelector('.rp-evidence .rp-time').click();await sleep(60);if(!f.querySelector('.pr-mock-turn.rp-flash'))throw Error('A time does not jump to the mock conversation');if(f.scrollWidth>f.clientWidth+1)throw Error('Feedback overflows its tab');` }),
    practiceFeedbackReportNarrow: practiceTab({ id: 'visual-branch-report-lld', tab: 'feedback', width: 390, ready: '.pr-feedback-pane .rp-dim-row', assert: `const f=need('.pr-feedback-pane');if(f.scrollWidth>f.clientWidth+1||document.documentElement.scrollWidth>innerWidth)throw Error('Feedback overflows narrow');` }),
    practiceFeedbackReportScrolled: practiceTab({ id: 'visual-branch-report-lld', tab: 'feedback', ready: '.pr-feedback-pane .rp-dim-row', scroll: 700 }),
    lldPinnedStatement: { url: '/#/lld/lld-locker/1760000000000-00000009', width: 1440, height: 900, ready: '.ci-contained .ui-pinned-statement:not([hidden])', assert: pinnedAssert('Design a parcel locker system.', false) + `if(need('.ci-contained .ci-pane-title').textContent!=='Interviewer')throw Error('LLD pane is not named Interviewer');if(/One locker bank|courier return/.test(document.body.textContent))throw Error('Interviewer-only facts reached the screen');` },
    lldPinnedStatementLong: { url: '/#/lld', width: 1440, height: 900, setup: lldLongStatement, ready: '.ci-contained .ui-pinned-statement-more:not([hidden])', assert: pinnedAssert(LONG_PINNED, true) },
    lldPinnedStatementLongOpen: { url: '/#/lld', width: 1440, height: 900, setup: lldLongStatement + `for(let i=0;i<100&&!document.querySelector('.ci-contained .ui-pinned-statement-more:not([hidden])');i++)await sleep(50);need('.ui-pinned-statement-more').click();await sleep(60);`, ready: '.ci-contained .ui-pinned-statement.is-open', assert: `if(need('.ui-pinned-statement-more').getAttribute('aria-expanded')!=='true')throw Error('Show more did not open');if(need('.ui-pinned-statement-text').scrollHeight>need('.ui-pinned-statement-text').clientHeight+1&&getComputedStyle(need('.ui-pinned-statement-text')).overflowY!=='auto')throw Error('Open statement is cut');` },
    lldPinnedStatementLongNarrow: { url: '/#/lld', width: 390, setup: lldLongStatement + `for(let i=0;i<100&&!document.querySelector('.lld-interviewer');i++)await sleep(50);need('.lld-interviewer').scrollIntoView({block:'start'});`, ready: '.ci-contained .ui-pinned-statement-more:not([hidden])', assert: pinnedAssert(LONG_PINNED, true) },
    designPinnedStatement: { url: '/#/design', width: 1440, height: 900, setup: liveDesignMock(false, { title: 'URL shortener', prompt: 'Design a URL-shortening service.' }), ready: '.dz-side .ui-pinned-statement:not([hidden])', assert: pinnedAssert('Design a URL-shortening service.', false) + `if(need('.ui-screen-header h1').textContent!=='URL shortener')throw Error('Design header is not the title: '+need('.ui-screen-header h1').textContent);if(need('.dz-side .ui-pane-header strong').textContent!=='Interviewer')throw Error('Design pane is not named Interviewer');` + mockSessionAssert('design', false) },
    designPinnedStatementLong: { url: '/#/design', width: 1440, height: 900, setup: liveDesignMock(false, { title: 'Parcel lockers', prompt: LONG_PINNED }), ready: '.dz-side .ui-pinned-statement-more:not([hidden])', assert: pinnedAssert(LONG_PINNED, true) },
    designPinnedStatementLongNarrow: { url: '/#/design', width: 390, setup: liveDesignMock(false, { title: 'Parcel lockers', prompt: LONG_PINNED }) + `need('.dz-side').scrollIntoView({block:'start'});`, ready: '.dz-side .ui-pinned-statement-more:not([hidden])', assert: pinnedAssert(LONG_PINNED, true) },
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
    practiceTimerRunning: { url: '/#/lld/practice/lld-locker/visual-practice-lld', ready: '.pr-timer', setup: `for(let i=0;i<100&&need('.pr-timer button').disabled;i++)await sleep(50);if(need('.pr-timer-label').textContent!=='Elapsed')need('.pr-timer button').click();for(let i=0;i<100&&need('.pr-timer-label').textContent!=='Elapsed';i++)await sleep(50);`, assert: `if(need('.pr-timer-label').textContent!=='Elapsed')throw Error('Timer not running');` },
    practiceTimerPaused: { url: '/#/lld/practice/lld-locker/visual-practice-lld', ready: '.pr-timer', setup: `for(let i=0;i<100&&need('.pr-timer button').disabled;i++)await sleep(50);if(need('.pr-timer-label').textContent==='Untimed'){need('.pr-timer button').click();for(let i=0;i<100&&need('.pr-timer-label').textContent!=='Elapsed';i++)await sleep(50);await sleep(1100);for(let i=0;i<100&&need('.pr-timer button').disabled;i++)await sleep(50);}if(need('.pr-timer-label').textContent==='Elapsed')need('.pr-timer button').click();for(let i=0;i<100&&need('.pr-timer-label').textContent!=='Paused';i++)await sleep(50);`, assert: `if(need('.pr-timer-label').textContent!=='Paused')throw Error('Timer not paused');` },
    practiceTimerUntimed: { url: '/#/lld/practice/lld-locker/visual-practice-long', ready: '.pr-timer', assert: `if(need('.pr-timer-label').textContent!=='Untimed'||visible(document.querySelector('.pr-timer-value')))throw Error('A never-started timer must read Untimed with no time');if(need('.pr-timer button').getAttribute('aria-label')!=='Start practice timer')throw Error('Untimed timer offers Start');` },
    learningNotes: { url: '/#/lld', setup: `(await import('/js/learning.js')).openLearningNotes('lld-locker','Locker system');`, ready: '.ln-sheet[open] .ln-evidence' },
    learningNotesNarrow: { url: '/#/lld', width: 390, setup: `(await import('/js/learning.js')).openLearningNotes('lld-locker','A much longer problem title: reservations, ownership, and concurrent allocation');`, ready: '.ln-sheet[open] .ln-evidence' },
    lldLibrary: { url: '/#/lld', setup: homeLoaded, ready: '.th-continue .th-resume', assert: homeFits + `
      if (!need('.th-continue').textContent.includes('Locker system')) throw Error('Continue is not the newest unfinished mock');
      ${nothingChosen('lld')}
      if (document.querySelectorAll('.th-history .th-item').length !== 8 || !need('.th-history .th-all').textContent.startsWith('Show all')) throw Error('History shows 8 rows then Show all');` },
    lldLower: { url: '/#/lld', setup: `${homeLoaded} ${reveal('.th-lower')}`, ready: '.th-dim .th-marks', assert: homeFits + `
      if (document.querySelectorAll('.th-dim').length !== 9) throw Error('One row per LLD rubric skill');
      if (need('.th-dim .th-marks').children.length !== 5) throw Error('Five marks for the last five reports');
      need('.th-moveup');` },
    lldHistoryMocks: { url: '/#/lld', setup: `${homeLoaded} clickText('.th-filter .btn', 'Mocks'); await sleep(50); document.scrollingElement.scrollTo({ top: document.scrollingElement.scrollHeight - innerHeight - 12, behavior: 'instant' }); await sleep(80);`, ready: '.th-filter [aria-pressed="true"]', assert: `
      if ([...document.querySelectorAll('.th-history .th-item')].some(r => r.dataset.kind !== 'mock')) throw Error('The Mocks filter shows practice');` },
    lldNarrow: { url: '/#/lld', width: 720, setup: homeLoaded, ready: '.th-continue .th-resume', assert: homeFits + stacked },
    lldNarrowLower: { url: '/#/lld', width: 720, setup: `${homeLoaded} ${reveal('.th-stand')}`, ready: '.th-dim', assert: homeFits },
    lldPhone: { url: '/#/lld', width: 390, setup: homeLoaded, ready: '.th-continue .th-resume', assert: homeFits + stacked },
    lldPhoneDetail: { url: '/#/lld', width: 390, setup: `${homeLoaded} ${reveal('.th-detail')}`, ready: '.th-mock .ci-start', assert: homeFits },
    lldPhoneLower: { url: '/#/lld', width: 390, setup: `${homeLoaded} ${reveal('.th-history')}`, ready: '.th-history .th-item', assert: homeFits },
    lldNewMock: { url: '/#/lld', setup: homeLoaded, ready: '.th-mock .ci-start' },
    lldMockNarrow: { url: '/#/lld', width: 390, setup: `${homeLoaded} ${reveal('.th-mock')}`, ready: '.th-mock .ci-start', assert: `need('.th-mock [aria-label="Answer mode: Voice"]'); need('.th-mock [aria-label^="Target level:"]');` },
    lldSelected: lldSelection,
    lldSelectedNarrow: { ...lldSelection, width: 720 },
    lldNothing: { url: '/#/lld', setup: homeLoaded, ready: '.th[data-state="ready"] .th-detail .th-practice', assert: homeFits + nothingChosen('lld') + `
      if (!visible(need('.th-act--practise [aria-label^="Target level:"]'))) throw Error('A surprise practice problem is prepared for a level, so the level shows');` },
    lldOwnPractice: { url: '/#/lld', setup: `${homeLoaded} ${chooseProblem('practise', 'My own problem')}`, ready: '.th-act--practise .th-brief textarea', assert: homeFits + `
      if (document.activeElement !== need('.th-act--practise .th-brief textarea')) throw Error('Choosing My own problem does not put the cursor in the brief');
      if (visible(document.querySelector('.th-act--practise [aria-label^="Target level:"]'))) throw Error('LLD practice offers a level it ignores');` },
    lldClear: { ...pick('.th-problem[data-slug="lld-vending-machine"]'), setup: `${homeLoaded} need('.th-problem[data-slug="lld-vending-machine"]').click(); await sleep(50); need('.th-clear').click(); await sleep(50);`, ready: '.th-detail [data-chosen="none"]', assert: homeFits + nothingChosen('lld') },
    lldPinned: { url: '/#/lld', height: 900, setup: longList() + ` document.scrollingElement.scrollTo({ top: need('.th-problem[data-slug="lld-sample-10"]').getBoundingClientRect().top + scrollY - innerHeight / 2, behavior: 'instant' }); await sleep(120);`, ready: '.th-detail.is-pinned', assert: homeFits + cardPinned },
    lldPinnedSelected: { url: '/#/lld', height: 900, setup: longList() + ` need('.th-problem[data-slug="lld-sample-3"]').click(); await sleep(80); document.scrollingElement.scrollTo({ top: need('.th-problem[data-slug="lld-sample-12"]').getBoundingClientRect().top + scrollY - innerHeight / 2, behavior: 'instant' }); await sleep(120);`, ready: '.th-detail.is-pinned [data-chosen="lld-sample-3"]', assert: homeFits + cardPinned },
    // Too short a window for the whole panel: it scrolls with the page, so Start stays reachable.
    lldPinnedShort: { url: '/#/lld', height: 400, setup: longList() + ` document.scrollingElement.scrollTo({ top: 600, behavior: 'instant' }); await sleep(120);`, ready: '.th-detail', assert: homeFits + `
      if (getComputedStyle(need('.th-detail')).position === 'sticky') throw Error('A panel taller than the window is pinned');` },
    lldPinnedNarrow: { url: '/#/lld', width: 720, setup: longList() + ` document.scrollingElement.scrollTo({ top: need('.th-problem[data-slug="lld-sample-10"]').getBoundingClientRect().top + scrollY - 200, behavior: 'instant' }); await sleep(120);`, ready: '.th-picker', assert: homeFits + stacked + `
      if (getComputedStyle(need('.th-detail')).position === 'sticky') throw Error('One column must not pin the panel');` },
    lldEmpty,
    lldEmptyNarrow: { ...lldEmpty, width: 720 },
    lldError,
    lldLongDocument: { url: '/#/lld/lld-locker/1760000000000-00000009', width: 1024, height: 650, setup: `for(let i=0;i<100 && !document.querySelector('.ci-composer .ui-mode-switch:not(:disabled)');i++) await sleep(50); const log=need('.ci-log'); for(let i=0;i<20;i++){const p=document.createElement('p');p.textContent='Interviewer: How does reservation ownership prevent conflicting updates?';log.append(p);} log.scrollTop=log.scrollHeight;`, ready: '.ci-contained .ci-log' },
    lldDocumentNarrow: { url: '/#/lld/lld-locker/1760000000000-00000009', width: 390, ready: '.lld-workspace .ci-panel', setup: `for(let i=0;i<100 && !document.querySelector('.ci-panel');i++)await sleep(50);need('.lld-interviewer').scrollIntoView({block:'center'});` },
    lldDocument: { url: '/#/lld/lld-locker/1760000000000-00000009', ready: '.lld-workspace .ci-panel' },
    // The audit fixture is paused and not joined in this tab, so no idle tick can run.
    lldMockPaused: { url: '/#/lld/lld-locker/1760000000000-00000009', width: 1440, height: 900, ready: '.ci-contained .mock-paused:not([hidden])', assert: mockSessionAssert('lld', true) },
    lldMockPausedNarrow: { url: '/#/lld/lld-locker/1760000000000-00000009', width: 390, ready: '.ci-contained .mock-paused:not([hidden])', setup: `for(let i=0;i<100&&!document.querySelector('.ci-contained .mock-paused:not([hidden])');i++)await sleep(50);need('.lld-interviewer').scrollIntoView({block:'start'});`, assert: mockSessionAssert('lld', true) },
    lldMockLive: { url: '/#/lld', width: 1440, height: 900, setup: `const real = window.fetch; window.fetch = async (...args) => { const response = await real(...args); if (String(args[0]).startsWith('/api/interview/lld-locker/1760000000000-00000009')) { const data = await response.json(); data.startedAt = Date.now() - 600000; data.pausedAt = null; return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); } return response; }; location.hash = '#/lld/lld-locker/1760000000000-00000009';`, ready: '.ci-contained .ci-log .ui-turn', assert: mockSessionAssert('lld', false) },
    designMockLive: { url: '/#/design', width: 1440, height: 900, setup: liveDesignMock(), ready: '.dz-side .dz-phase[aria-current=step]', assert: mockSessionAssert('design', false) + `if (document.querySelector('.dz-side :is(.ui-pane-header, .dz-phase-actions) :is(.ui-select, select)')) throw Error('The live mock still has a phase filter');` },
    designMockPaused: { url: '/#/design', width: 1440, height: 900, setup: liveDesignMock(true), ready: '.dz-side .mock-paused:not([hidden])', assert: mockSessionAssert('design', true) },
    designMockNarrow: { url: '/#/design', width: 390, setup: liveDesignMock() + `need('.dz-side').scrollIntoView({block:'start'});`, ready: '.dz-side .dz-phase[aria-current=step]', assert: mockSessionAssert('design', false) },
    lldRunOutput: pythonRunState({ result: scriptRuns.output, ready: '.pyrun .rr-printed', assert: `
      if (need('.pyrun .rr-headline').textContent !== 'Ran · 42 ms · exit 0') throw Error('Wrong success verdict: ' + need('.pyrun .rr-headline').textContent);
      if (!need('.pyrun .rr-label').textContent.includes('Printed')) throw Error('Printed row is not labelled');` }),
    lldRunError: pythonRunState({ result: scriptRuns.error, ready: '.pyrun .rr-field.trace', assert: `
      if (need('.pyrun .rr-headline').textContent !== 'Error · KeyError') throw Error('The error does not lead with its exception');
      const shown = need('.pyrun .rr-trace-text:not(.is-full)').textContent;
      if (/_studio_driver|runpy|solution[.]py/.test(shown)) throw Error('Trimmed traceback shows driver frames or the runner file name');
      if (!/File "design[.]py", line 9/.test(shown)) throw Error('Traceback does not name design.py');
      const goTo = [...document.querySelectorAll('.pyrun .rr-goto')].find(visible);
      if (!goTo || goTo.textContent !== 'Go to line 9') throw Error('Missing Go to line 9');
      goTo.click(); await sleep(100);
      const inst = window.monaco.editor.getEditors()[0], lines = inst.getModel().getLineCount();
      if (inst.getPosition().lineNumber !== Math.min(9, lines) || !inst.hasTextFocus()) throw Error('Go to line did not move and focus the editor');` }),
    lldRunTruncated: pythonRunState({ result: scriptRuns.truncated, ready: '.pyrun .pyrun-note', assert: `
      if (!need('.pyrun .pyrun-note').textContent.startsWith('Output truncated')) throw Error('Truncation is not stated');` }),
    lldRunNarrow: pythonRunState({ result: scriptRuns.error, width: 390, ready: '.pyrun .rr-field.trace' }),
    practiceRunError: pythonRunState({ result: scriptRuns.error, practice: true, ready: '.pyrun .rr-field.trace' }),
    referenceTab,
    // Stacked (below 1081px) the pane sits above the editor; the tabs switch the same way.
    referenceTabNarrow: { ...referenceTab, width: 900 },
    interviewLive: { url: problem, setup: `const originalFetch = window.fetch; window.fetch = async (...args) => { const response = await originalFetch(...args); if (String(args[0]).includes('/api/interview/jump-game/')) { const data = await response.json(); data.startedAt = Date.now(); data.pausedAt = null; data.lastSpeechAt = Date.now(); data.lastTypingAt = Date.now(); return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); } return response; }; const m = await import('/js/interview.js'); m.openInterviewRecord('jump-game', '1760000000000-00000001');`, ready: '.ci-panel[data-mode="typed"] .ci-input', assert: `need('.ci-phases');` },
    interviewVoice: { url: problem, setup: `const originalFetch = window.fetch; window.fetch = async (...args) => { const response = await originalFetch(...args); if (String(args[0]).includes('/api/interview/jump-game/')) { const data = await response.json(); data.startedAt = Date.now(); data.pausedAt = null; data.lastSpeechAt = Date.now(); data.lastTypingAt = Date.now(); return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); } return response; }; const m = await import('/js/interview.js'); m.openInterviewRecord('jump-game', '1760000000000-00000002');`, ready: '.ci-panel[data-mode="voice"] .ci-voice', assert: `if (visible(document.querySelector('.ci-input'))) throw Error('Voice mode exposes text box'); need('.ci-voice .voice-state');` },
    interviewVoiceLong: liveVoiceMock(),
    interviewVoiceLongScrolled: liveVoiceMock({ scrolled: true }),
    interviewVoiceLongNarrow: liveVoiceMock({ narrow: true }),
    interviewVoiceLongPhone: { ...liveVoiceMock({ phone: true }), width: 390, height: 844 },
    interviewVoiceLongShort: { ...liveVoiceMock({ scrolled: true }), height: 640 },
    lldMockTranscript: surfaceClear({ url: '/#/lld', setup: `const real = window.fetch; window.fetch = async (...args) => { const response = await real(...args); if (String(args[0]).startsWith('/api/interview/lld-locker/1760000000000-00000009')) { const data = await response.json(); data.startedAt = Date.now() - 600000; data.pausedAt = null; return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); } return response; }; location.hash = '#/lld/lld-locker/1760000000000-00000009';`, ready: '.ci-contained .ci-log .ui-turn', panel: '.ci-contained', log: '.ci-log', header: '.ci-live-header', composer: '.ui-composer' }),
    designMockTranscript: surfaceClear({ url: '/#/design', setup: liveDesignMock(), ready: '.dz-side .dz-phase[aria-current=step]', panel: '.dz-side', log: '.dz-log', header: '.dz-phase-actions', composer: '.ui-composer' }),
    practiceTranscript: surfaceClear({ url: '/#/lld/practice/lld-locker/visual-practice-lld', ready: '.pr-coach .pr-answer', panel: '.pr-coach', log: '.pr-thread', header: '.pr-coach-head', composer: '.pr-compose' }),
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
    // After interviewNoResponse: it opens the finished interview, which the sidebar then remembers.
    reportFollowupTranscript: surfaceClear({ url: problem, setup: `const m = await import('/js/interview.js'); m.openInterviewRecord('jump-game', '1760000000000-00000003'); for (let i = 0; i < 100 && !document.querySelector('.ci-open-report'); i++) await sleep(50); need('.ci-open-report').click(); for (let i = 0; i < 100 && !document.querySelector('.rp-ask-thread'); i++) await sleep(50);`, ready: '.rp-sheet[open] .rp-ask-thread', panel: '.rp-ask', log: '.rp-ask-thread', header: '.rp-ask-head', composer: '.rp-ask-compose' }),
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
    collectionProblem: { url: '/#/p/time-based-key-value-store', setup: `if (document.body.classList.contains('coach-open')) need('.coach-hide').click(); need('[data-interview-prep]').open = true;`, ready: '[data-interview-prep]', assert: `
      if (!need('[data-interview-prep]').textContent.includes('Fixture caveat')) throw Error('Missing collection caveat');
      if (!need('.ptags').textContent.includes('${collectionFixture.id}')) throw Error('Missing collection tag');` },
    collectionProblemNarrow: { url: '/#/p/time-based-key-value-store', width: 390, setup: `need('[data-interview-prep]').open = true; need('[data-interview-prep]').scrollIntoView({block:'start'});`, ready: '[data-interview-prep]' },
    collectionRoadmap: { url: '/#/roadmap', setup: `clickText('.chip', '${collectionFixture.label}');`, ready: '.roadmap', assert: `
      const counts = [...document.querySelectorAll('.node-meta')].map(node => parseInt(node.textContent, 10));
      if (counts.reduce((a,b) => a+b, 0) !== ${collectionCount}) throw Error('Roadmap must include all ${collectionCount} collection problems');` },
    roadmap: { url: '/#/roadmap', ready: '.roadmap' },
    progress: { url: '/#/progress', ready: '.dash-patterns', assert: `const b=need('.dash-body').getBoundingClientRect();if(b.width>1201)throw Error('Progress is not a bounded column');if(document.querySelector('.dash [title]'))throw Error('Native title tooltip on Progress');` },
    progressNarrow: { url: '/#/progress', width: 390, ready: '.dash-patterns', assert: `if(document.documentElement.scrollWidth>innerWidth)throw Error('Progress overflows the phone width');` },
    design: { url: '/#/design', setup: homeLoaded, ready: '.th-history .th-item', assert: homeFits + `need('.th-stand-empty'); need('.th-rubric-names li');` },
    designSetup: { url: '/#/design', setup: homeLoaded, ready: '.th-mock .ci-start', assert: homeFits + nothingChosen('design') + `need('.th-mock [aria-label="Answer mode: Voice"]'); need('.th-act--practise [aria-label^="Target level:"]');` },
    designOwn: { url: '/#/design', setup: `${homeLoaded} ${chooseProblem('practise', 'My own problem')} ${chooseProblem('mock', 'My own problem')}`, ready: '.th-mock .th-brief textarea', assert: homeFits + `
      need('.th-act--practise .th-brief textarea'); need('.th-act--practise [aria-label^="Target level:"]');
      if (document.querySelector('.th-pick-hint:not([hidden])')) throw Error('My own problem still describes Surprise me');` },
    designOwnNarrow: { url: '/#/design', width: 390, setup: `${homeLoaded} ${reveal('.th-mock')} ${chooseProblem('mock', 'My own problem')}`, ready: '.th-mock .th-brief textarea', assert: homeFits },
    designSelected: { url: '/#/design', setup: `${homeLoaded} need('.th-problem[data-slug]').click(); await sleep(60);`, ready: '.th-problem[aria-pressed="true"]', assert: homeFits + `need('.th-clear'); need('.th-act--practise [aria-label^="Target level:"]'); if (document.querySelector('.th-pick:not([hidden])')) throw Error('A chosen problem still offers Surprise me');` },
    designSetupNarrow: { url: '/#/design', width: 390, setup: `${homeLoaded} ${reveal('.th-mock')}`, ready: '.th-mock .ci-start' },
    designNarrow: { url: '/#/design', width: 720, setup: homeLoaded, ready: '.th-history .th-item', assert: homeFits },
    problem: { url: problem, ready: '.ui-screen-header .ws-run', setup: `if (document.body.classList.contains('coach-open')) need('.coach-hide').click();` },
    // Between the docked layout and the phone layout the coach is a floating button; it must
    // never sit on a header, tab or the test panel's controls.
    coachFloatMid: { url: problem, width: 900, height: 900, ready: '.ui-screen-header .ws-run', setup: `if (document.body.classList.contains('coach-open')) need('.coach-hide').click(); document.scrollingElement.scrollTo({ top: document.scrollingElement.scrollHeight, behavior: 'instant' }); await sleep(150);`, assert: `
      const launch = [...document.querySelectorAll('.coach-launch')].find(visible);
      if (launch) {
        const l = launch.getBoundingClientRect();
        for (const n of document.querySelectorAll('.ui-pane-header, .ui-tabs, .ui-tab, .tc-tabs, .tc-tab, .tc-row-actions, .editor-tabs, .ui-screen-header, .rr-tabs')) {
          if (!visible(n)) continue;
          const r = n.getBoundingClientRect();
          if (r.width && r.height && l.left < r.right && l.right > r.left && l.top < r.bottom && l.bottom > r.top) throw Error('The floating Coach button covers ' + n.className);
        }
      }
      if (!visible(document.querySelector('.editor-open-sidebar')) && !visible(document.querySelector('[data-pane="coach"]'))) throw Error('No visible control opens the coach');` },
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
    stmtWide: { url: problem, width: 2200, setup: `if (document.body.classList.contains('coach-open')) { need('.coach-hide').click(); await sleep(300); } need('.pbody.with-workspace').style.gridTemplateColumns = '1100px minmax(0,1fr)'; await sleep(200);`, ready: '.stmt-example .ex-value', assert: `
      const lead = need('.stmt-lead').getBoundingClientRect(), examples = need('.stmt-examples').getBoundingClientRect();
      if (need('.pcol').getBoundingClientRect().width < 880) throw Error('Fixture pane is not wide');
      if (examples.left < lead.right) throw Error('In a wide pane the examples sit beside the description');
      if (Math.abs(examples.top - lead.top) > 2) throw Error('Description and examples should start level');
      const rest = need('.stmt-rest').getBoundingClientRect(); if (rest.top - lead.bottom > 40) throw Error('Tall examples push the constraints away from the description: ' + Math.round(rest.top - lead.bottom) + 'px');` },
    // Fixture statements carry no pictures (they would need the network), so a tall tree and a
    // wide list are drawn here. Every theme restyles example padding; the gap must survive it.
    stmtFigure: { url: problem, width: 2200, setup: stmtFigureSetup(1100), ready: '.stmt-example .ex-figure img', assert: stmtFigureAssert },
    stmtFigureNarrow: { url: problem, width: 2200, setup: stmtFigureSetup(400), ready: '.stmt-example .ex-figure img', assert: stmtFigureAssert },
    // Newer LeetCode problems put "Explanation:" on its own line and let a picture be the explanation.
    stmtPictureExplanation: { url: problem, setup: `for (let i = 0; i < 40 && !document.querySelector('.stmt'); i++) await sleep(100); const { structureStatement } = await import('/js/statement.js'); const c = document.createElement('canvas'); c.width = 400; c.height = 207; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 400, 207); g.strokeStyle = '#222'; g.lineWidth = 3; g.beginPath(); g.arc(200, 100, 40, 0, 7); g.stroke(); const rich = document.createElement('div'); rich.className = 'rich'; rich.innerHTML = '<p>Return what can be seen from the right side.</p><p><strong>Example 1:</strong></p><p><strong>Input:</strong> root = [1,2,3,null,5,null,4]</p><p><strong>Output:</strong> [1,3,4]</p><p><strong>Explanation:</strong></p><p><img alt=""></p><p><strong>Example 2:</strong></p><p><strong>Input:</strong> root = []</p><p><strong>Output:</strong> []</p><p><strong>Constraints:</strong></p><ul><li>The tree has at most 100 nodes.</li></ul>'; const img = rich.querySelector('img'); img.src = c.toDataURL(); await img.decode(); need('.stmt').replaceWith(structureStatement(rich)); await sleep(200);`, ready: '.stmt-example .ex-value', assert: `
      const first = need('.stmt-example');
      const labels = [...first.querySelectorAll('.ex-label')].map(n => n.textContent).join(',');
      if (labels !== 'Input,Output,Explanation') throw Error('A picture explanation lost its row: ' + labels);
      if (!first.querySelector('.ex-row .ex-value.is-figure img')) throw Error('The picture is not in the Explanation row');
      if (first.querySelector('.ex-raw') || first.querySelector('.ex-figure')) throw Error('The explanation label or picture was left outside its row');
      if (need('.stmt-example .ex-value.is-figure img').getBoundingClientRect().height > 261) throw Error('The picture exceeds its cap');` + stmtFigureAssert },
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
