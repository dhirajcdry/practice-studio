import { cleanupChrome } from './chrome-cleanup.mjs';
import { problemDir } from '../server/storage-layout.mjs';
// Python editor parity regression: shared editor controls in practice/LLD modes.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { newState } from '../server/interview/state.mjs';
import { InterviewStore } from '../server/interview/store.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-python-editor-'));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-python-editor-chrome-'));
const port = Number(process.env.STUDIO_CHECK_PORT) || 4211, debug = port + 5255;
const origin = `http://127.0.0.1:${port}`, debugUrl = `http://127.0.0.1:${debug}`;
let server, chrome, socket, seq = 0, logs = '';
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async code => { const r = await send('Runtime.evaluate', { expression: `(async()=>{${code}})()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
async function until(fn, label) { for (let i = 0; i < 180; i++) { try { if (await fn()) return; } catch {} await sleep(100); } throw Error(`Timed out: ${label}\n${logs}`); }
async function free(p) { await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(p, '127.0.0.1', () => s.close(resolve)); }); }

// Measure the ink, not the gutter box: short line numbers can hide a zero inset.
async function checkEditorEdges(label) {
  const results = await evaluate(String.raw`
    const editor=monaco.editor.getEditors()[0], model=editor.getModel();
    const original=model.getValue(), originalSize=editor.getOption(monaco.editor.EditorOption.fontSize), view=editor.saveViewState();
    const frame=document.querySelector('.python-editor-frame'), viewport=frame.querySelector('.python-editor-viewport');
    const settle=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const samples=[];
    try {
      for(const [lines,size,line] of [[140,14,110],[1240,20,1110]]) {
        model.setValue('class Booking:\n    def verify(self):\n'+Array.from({length:lines},(_,i)=>'        value_'+i+' = '+i+' # '+ 'long line '.repeat(30)).join('\n'));
        editor.updateOptions({fontSize:size,wordWrap:'off'});editor.layout();
        editor.setPosition({lineNumber:line,column:9});editor.revealLineInCenter(line);await settle();
        for(let attempt=0;attempt<30&&editor.getScrollWidth()<=editor.getLayoutInfo().width;attempt++)await settle();
        editor.setScrollLeft(120,monaco.editor.ScrollType.Immediate);await settle();
        const f=frame.getBoundingClientRect(),v=viewport.getBoundingClientRect();
        const numbers=[...frame.querySelectorAll('.line-numbers')].filter(n=>Number(n.textContent)>=100&&n.getBoundingClientRect().height);
        const ink=n=>{const r=document.createRange();r.selectNodeContents(n);return r.getBoundingClientRect().left-f.left;};
        const sticky=frame.querySelector('.sticky-widget')?.getBoundingClientRect();
        const layout=editor.getLayoutInfo();
        samples.push({lines,size,left:v.left-f.left,right:f.right-v.right,ink:Math.min(...numbers.map(ink)),
          digits:Math.max(...numbers.map(n=>n.textContent.trim().length)),width:layout.width,available:v.width,
          sticky:!sticky||!sticky.height||(sticky.left>=v.left-1&&sticky.right<=v.right+1),scroll:editor.getScrollLeft(),scrollWidth:editor.getScrollWidth(),wrap:editor.getOption(monaco.editor.EditorOption.wordWrap)});
      }
    } finally {
      model.setValue(original);editor.updateOptions({fontSize:originalSize,wordWrap:document.querySelector('.editor-wrap').getAttribute('aria-pressed')==='true'?'on':'off'});
      editor.restoreViewState(view);editor.layout();
    }
    return samples;
  `);
  for(const r of results) {
    assert.ok(r.left>=12&&r.right>=12&&r.ink>=12, `${label}: editor edge inset ${JSON.stringify(r)}`);
    assert.ok(r.digits===(r.lines>1000?4:3), `${label}: multi-digit lines actually rendered`);
    assert.ok(Math.abs(r.width-r.available)<=1&&r.sticky&&r.scroll>0, `${label}: Monaco coordinates/scroll ${JSON.stringify(r)}`);
  }
  console.log(`ok — ${label}: 3/4-digit line numbers keep a 12px inset at 14/20px font sizes`);
}

try {
  await free(port); await free(debug); await fs.mkdir(path.join(home, 'cache', 'leetcode'), { recursive: true });
  await fs.writeFile(path.join(home, 'cache/leetcode/two-sum.json'), JSON.stringify({ question: {
    title: 'Two Sum', titleSlug: 'two-sum', difficulty: 'Easy', questionId: '1', content: '<p>Return two indices.</p>',
    metaData: JSON.stringify({name:'twoSum',params:[{name:'nums',type:'integer[]'},{name:'target',type:'integer'}],return:{type:'integer[]'}}),
    exampleTestcases: '[2,7]\n9', codeSnippets: [{langSlug:'python3',code:'class Solution:\n    def twoSum(self, nums, target):\n        pass\n'}],
  } }));
  const store = new InterviewStore({ root: home });
  for (const [id, done] of [['1760000000000-00000009', false], ['1760000000000-00000010', true]]) {
    const state = {...newState({slug:'lld-locker',mode:'typed',startedAt:Date.now()}), discipline:'lld',targetLevel:'L4',pausedAt:Date.now(),lastCode:'# Candidate design\n',debriefed:done,endedAt:done?Date.now():null};
    await store.create('lld-locker',id,state);
    await store.append('lld-locker',id,{kind:'opening',elapsedMs:0,asked:'Design a parcel locker system.'});
  }
  server = spawn(process.execPath, ['--input-type=module', '--eval', "globalThis.fetch=async()=>{throw Error('network disabled')}; (await import('./server/index.mjs')).start();"], { cwd: root, env: { ...process.env, STUDIO_HOME: home, STUDIO_PORT: String(port), STUDIO_MIRROR_DIR: '', STUDIO_COACH_BINARY: path.join(root, 'server/coach/test/bin/fake-claude.mjs'), STUDIO_CODEX_BINARY: path.join(root, 'server/coach/test/bin/fake-codex.mjs'), STUDIO_TTS_PYTHON: path.join(root, 'server/tts/test/fake-helper.mjs'), STUDIO_TTS_SCRIPT: path.join(root, 'server/tts/test/fake-helper.mjs'), STUDIO_TTS_MODEL: path.join(root, 'server/tts/test/fake-helper.mjs'), STUDIO_TTS_VOICES: path.join(root, 'server/tts/test/fake-helper.mjs'), FAKE_INTERVIEW_TOKEN_MS: '8', FAKE_CLAUDE_MODE: 'tools', FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([{ tool: 'get_state', arguments: {} }, { tool: 'edit_code', arguments: { find: '# Agent fixture\npass\n', replace: "# Agent fixture\nprint('agent check')\n", why: 'Requested implementation' } }, { tool: 'save_note', arguments: { text: 'Fixture evidence: explicitly requested assistance; do not count it as unaided work.' } }, { tool: 'run_code', arguments: {} }]), FAKE_CODEX_TOOL_CALLS: JSON.stringify([{ tool: 'get_state', arguments: {} }, { tool: 'edit_code', arguments: { find: '# Agent fixture\npass\n', replace: "# Agent fixture\nprint('agent check')\n", why: 'Requested implementation' } }, { tool: 'save_note', arguments: { text: 'Fixture evidence: explicitly requested assistance; do not count it as unaided work.' } }, { tool: 'run_code', arguments: {} }]) }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', d => { logs = (logs + d).slice(-3000); });
  await until(async () => (await fetch(origin + '/api/health')).ok, 'server');
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${debug}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  await until(async () => (await fetch(debugUrl + '/json/list')).ok, 'Chrome');
  const tab = (await (await fetch(debugUrl + '/json/list')).json()).find(x => x.type === 'page'); socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  socket.addEventListener('message', e => {
    const m = JSON.parse(e.data), p = pending.get(m.id);
    if (m.method === 'Page.javascriptDialogOpening') {
      for (const [id, request] of pending) {
        clearTimeout(request.timer); pending.delete(id);
        request.reject(Error(`Unexpected ${m.params.type} dialog at ${m.params.url}`));
      }
    }
    if (p) {
      clearTimeout(p.timer); pending.delete(m.id);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await send('Page.enable'); await send('Runtime.enable');
  // Practice starts in voice mode. This editor-only fixture must not open a real
  // microphone or leave Chrome's permission request pending across navigation.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Microphone disabled in editor fixture', 'NotAllowedError');
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: origin + '/#/lld' });
  await until(() => evaluate("return !!document.querySelector('.th-practice')"), 'LLD launcher');
  await evaluate("document.querySelector('.th-practice').click()");
  await until(() => evaluate("return !!document.querySelector('.pr-coach') && !!document.querySelector('.editor-wrap') && !!window.monaco?.editor.getModels().length"), 'practice editor');
  const practiceHash = await evaluate('return location.hash');
  await checkEditorEdges('LLD practice');
  // Exercise the real provider bridges and HTTP acknowledgements against this scratch
  // workspace. Both providers must edit/save, run, record receipts, and support Undo.
  for (const provider of ['claude', 'codex']) {
    await fs.writeFile(path.join(home, 'coach-settings.json'), JSON.stringify({provider, model: provider === 'codex' ? 'gpt-6-astra' : 'opus'}));
    await evaluate("monaco.editor.getModels()[0].setValue('# Agent fixture\\npass\\n')");
    await until(() => evaluate("return document.querySelector('.pr-save').textContent==='Saved'"), 'agent fixture saved');
    await evaluate(`const {streamInterviewRequest}=await import('/js/interview-transport.js');
      const {showWorkspaceAction}=await import('/js/workspace-tools.js');
      const [, , , slug, id]=location.hash.split('/');
      await streamInterviewRequest('/api/practice/ask',{slug,id,requestId:crypto.randomUUID(),question:'Please implement this fixture and save the lesson.'}, (name,value)=>{
        if(name==='action') showWorkspaceAction(document.querySelector('.pr-thread'),value);
      });`);
    assert.match(await evaluate('return monaco.editor.getModels()[0].getValue()'), /print\('agent check'\)/, `${provider} edits the mounted workspace`);
    const practice = await (await fetch(origin + '/api/practice/' + practiceHash.split('/').slice(3).join('/'))).json();
    assert.match(practice.code, /agent check/, 'acknowledged code is saved');
    const receipts = practice.exchanges.at(-1).actions;
    assert.ok(receipts.some(a=>a.tool==='edit_code'&&a.status==='done'), 'successful edit durable');
    assert.ok(receipts.some(a=>a.tool==='run_code'&&a.result.stdout.includes('agent check')), 'coach executes saved edited Python');
    await evaluate("const rows=[...document.querySelectorAll('[data-action-id]')];rows.reverse().find(n=>n.textContent.includes('Edited your code')&&n.querySelector('button'))?.querySelector('button').click()");
    await until(() => evaluate("return monaco.editor.getModels()[0].getValue()==='# Agent fixture\\npass\\n' && document.querySelector('.pr-save').textContent==='Saved'"), 'agent edit undo saved');
  }
  assert.match(await fs.readFile(path.join(problemDir(home,practiceHash.split('/')[3]), 'NOTES.md'),'utf8'), /Fixture evidence/);

  const initial = await evaluate("return ({value:monaco.editor.getModels()[0].getValue(), wrap:document.querySelector('.editor-wrap').getAttribute('aria-pressed'), cursor:document.querySelector('.editor-cursor')?.textContent})");
  await evaluate("const e=monaco.editor.getEditors()[0];e.setValue('class A:\\n    pass\\n'+'x'.repeat(240));document.querySelector('.editor-wrap').click();e.setPosition({lineNumber:2,column:6});e.trigger('check','undo');e.trigger('check','redo')");
  assert.ok((await evaluate("return monaco.editor.getModels()[0].getValue()" )).startsWith('class A:\n    pass'), 'content preserved');
  assert.equal(await evaluate("return document.querySelector('.editor-wrap').getAttribute('aria-pressed')"), 'true', 'wrap toggles on');
  assert.match(await evaluate("return document.querySelector('.editor-cursor').textContent"), /Ln 2, Col 6/, 'cursor position');
  await evaluate("const e=monaco.editor.getEditors()[0];e.executeEdits('check',[{range:e.getModel().getFullModelRange(),text:'undo-me'}]);e.trigger('check','undo')");
  assert.ok(await evaluate("return monaco.editor.getModels()[0].getValue().startsWith('class A:')"), 'undo restores prior content');
  await evaluate("await monaco.editor.getEditors()[0].getAction('actions.find').run()");
  assert.equal(await evaluate("return !!document.querySelector('.find-widget')"), true, 'find opens');
  assert.equal(await evaluate("const e=monaco.editor.getEditors()[0],o=e.getOption(monaco.editor.EditorOption.wordWrap);return o"), 'on', 'Monaco wrap option');
  assert.ok(await evaluate("const e=monaco.editor.getEditors()[0];return e.getOption(monaco.editor.EditorOption.fontSize)" ) > 0, 'font option available');
  await until(() => evaluate("return document.querySelector('.pr-save').textContent==='Saved'"), 'saved before reload');
  await evaluate('window.beforeParityReload=true');
  await send('Page.reload'); await until(() => evaluate("return !window.beforeParityReload && !!document.querySelector('.editor-wrap') && !!window.monaco?.editor.getModels().length"), 'reload editor');
  assert.equal(await evaluate("return document.querySelector('.editor-wrap').getAttribute('aria-pressed')"), 'true', 'wrap follows reload');
  await evaluate("const s=await import('/js/settings.js');s.setSetting('codeSize',19)"); await sleep(100);
  assert.equal(await evaluate("const e=monaco.editor.getEditors()[0];return e.getOption(monaco.editor.EditorOption.fontSize)"), 19, 'font setting live');
  await evaluate("location.hash='#/lld'"); await until(() => evaluate("return !!document.querySelector('.th-practice')"), 'LLD library');
  assert.equal(await evaluate('return monaco.editor.getModels().length'), 0, 'route disposal releases the model');
  await evaluate("location.hash='#/p/two-sum'");
  await until(() => evaluate("return !!document.querySelector('.ws-host .monaco-editor')"), 'LeetCode shared editor');
  assert.equal(await evaluate("return document.querySelector('.editor-wrap').getAttribute('aria-pressed')"), 'true', 'wrap follows into LeetCode');
  assert.equal(await evaluate("return monaco.editor.getEditors()[0].getOption(monaco.editor.EditorOption.fontSize)"), 19, 'font follows into LeetCode');
  await checkEditorEdges('LeetCode');
  const saveBoundary = await evaluate(`const actions=await import('/js/coach-actions.js');
    const original=monaco.editor.getModels()[0].getValue(), realFetch=window.fetch;
    let release, started, resolved=false; const begun=new Promise(r=>started=r);
    window.fetch=async(url,options)=>{if(String(url).includes('/api/problems/two-sum/code')&&options?.method==='PUT'){started();await new Promise(r=>release=r);} return realFetch(url,options);};
    const action={id:crypto.randomUUID(),slug:'two-sum',tool:'edit_code',needsAck:true,status:'pending',args:{find:original,replace:'# delayed save fixture',why:'Fixture'}};
    const pending=actions.applyAction(action).then(r=>{resolved=true;return r;});
    await begun; const waited=!resolved; release(); const saved=await pending; window.fetch=realFetch;
    window.fetch=async(url,options)=>String(url).includes('/api/problems/two-sum/code')&&options?.method==='PUT'?new Response(JSON.stringify({error:{message:'Fixture save failure'}}),{status:500,headers:{'content-type':'application/json'}}):realFetch(url,options);
    const failed=await actions.applyAction({...action,id:crypto.randomUUID(),args:{find:'# delayed save fixture',replace:original,why:'Fixture'}});
    window.fetch=realFetch; const editor=await import('/js/editor.js');await editor.flushEditorSave('two-sum');
    return {waited,saved,failed};`);
  assert.equal(saveBoundary.waited,true,'code action waits for disk save');
  assert.equal(saveBoundary.saved.ok,true,'delayed save acknowledged after success');
  assert.equal(saveBoundary.failed.ok,false,'failed code save never acknowledged as done');

  await evaluate("document.querySelector('.editor-wrap').click(); location.hash='#/lld/lld-locker/1760000000000-00000009'");
  await until(() => evaluate("return !!document.querySelector('.lld-code .monaco-editor') && !!document.querySelector('.ci-panel')"), 'LLD mock shared editor');
  await checkEditorEdges('LLD mock');
  assert.equal(await evaluate("return document.querySelector('.editor-wrap').getAttribute('aria-pressed')"), 'false', 'wrap follows into mock');
  assert.equal(await evaluate("return monaco.editor.getModels()[0].getValue()"), '# Candidate design\n', 'mock document unchanged');
  assert.equal(await evaluate("return monaco.editor.getEditors()[0].getOption(monaco.editor.EditorOption.readOnly)"), false, 'active mock editable');
  await evaluate("monaco.editor.getModels()[0].setValue('# Agent fixture\\npass\\n')");
  await until(()=>evaluate("return document.querySelector('.lld-notice').textContent==='Saved to disk'"),'mock fixture saved');
  await fetch(origin+'/api/interview/resume',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({slug:'lld-locker',interviewId:'1760000000000-00000009'})});
  // Two turns use one native Codex conversation; both must bind the current tools.
  for (let turn=0;turn<2;turn++) {
    await evaluate(`const {streamInterviewRequest}=await import('/js/interview-transport.js'); const {showWorkspaceAction}=await import('/js/workspace-tools.js');
      await streamInterviewRequest('/api/interview/turn',{slug:'lld-locker',interviewId:'1760000000000-00000009',said:'Please implement this fixture and run it.',code:monaco.editor.getModels()[0].getValue(),requestId:crypto.randomUUID()},(name,value)=>{if(name==='action')showWorkspaceAction(document.querySelector('.ci-log'),value)});`);
    assert.match(await evaluate('return monaco.editor.getModels()[0].getValue()'),/agent check/,'Codex mock conversation can edit');
    await evaluate("const rows=[...document.querySelectorAll('[data-action-id]')];rows.reverse().find(n=>n.textContent.includes('Edited your code')&&n.querySelector('button'))?.querySelector('button').click()");
    await until(()=>evaluate("return monaco.editor.getModels()[0].getValue()==='# Agent fixture\\npass\\n' && document.querySelector('.lld-notice').textContent==='Saved to disk'"),'mock edit undone');
  }
  const mock = await (await fetch(origin+'/api/interview/lld-locker/1760000000000-00000009')).json();
  assert.ok(mock.turns.some(t=>t.kind==='tool_action'&&t.action.status==='done'&&t.action.tool==='edit_code'),'mock assistance persisted');
  assert.ok(mock.turns.some(t=>t.kind==='coach_run'&&t.result.stdout.includes('agent check')),'mock coach run is separate evidence');
  await evaluate("monaco.editor.getModels()[0].setValue('# Candidate design\\n')");
  await until(()=>evaluate("return document.querySelector('.lld-notice').textContent==='Saved to disk'"),'restore fixture');

  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', {width,height:900,deviceScaleFactor:1,mobile:false});
    const bounds = await evaluate("const bar=document.querySelector('.python-document-bar'),r=bar.getBoundingClientRect();return [...bar.children].every(n=>{const b=n.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom}) && document.documentElement.scrollWidth<=innerWidth");
    assert.ok(bounds, `file header controls stay inside pane at ${width}`);
  }
  await evaluate("location.hash='#/lld/lld-locker/1760000000000-00000010'");
  await until(() => evaluate("return !!document.querySelector('.lld-code .monaco-editor') && monaco.editor.getEditors()[0]?.getOption(monaco.editor.EditorOption.readOnly) === true"), 'completed mock');
  assert.equal(await evaluate("return monaco.editor.getEditors()[0].getOption(monaco.editor.EditorOption.readOnly)"), true, 'completed mock stays read-only');
  assert.equal(await evaluate("return document.querySelector('.python-run').disabled"), true, 'completed run disabled');
  await evaluate("monaco.editor.getEditors()[0].focus()"); await send('Input.insertText', {text:'cannot overwrite'});
  assert.equal(await evaluate("return monaco.editor.getModels()[0].getValue()"), '# Candidate design\n', 'read-only ignores typing');

  await evaluate("[...document.querySelectorAll('.ui-header-actions button')].find(b=>b.textContent==='Practise from this mock').click()");
  await until(() => evaluate("return !!document.querySelector('.pr-editor .monaco-editor') && !!document.querySelector('.pr-source-link')"), 'branch from completed LLD mock');
  assert.equal(await evaluate("return monaco.editor.getModels()[0].getValue()"),'# Candidate design\n','branch begins with the mock code');
  assert.equal(await evaluate("return document.querySelector('.pr-source-link').getAttribute('href')"),'#/lld/lld-locker/1760000000000-00000010');
  assert.match(await evaluate("return document.querySelector('.pr-feedback').textContent"),/No mock feedback/);
  await evaluate("monaco.editor.getModels()[0].setValue('# Changed in independent practice');");
  await until(() => evaluate("return document.querySelector('.pr-save').textContent==='Saved'"),'branch saves independently');
  assert.equal(await evaluate("return (await(await fetch('/api/lld/lld-locker/1760000000000-00000010/code')).json()).code"),'# Candidate design\n','original mock code is unchanged');
  await evaluate("location.hash='#/lld'"); await until(()=>evaluate("return !!document.querySelector('[data-slug=lld-locker] .th-expand')"),'history branch action');
  await evaluate("document.querySelector('[data-slug=lld-locker] .th-expand').click()");
  await until(()=>evaluate("return [...document.querySelectorAll('[data-slug=lld-locker] .th-history .btn')].some(n=>n.textContent==='Practise from it')"),'history practice action');
  await evaluate("[...document.querySelectorAll('[data-slug=lld-locker] .th-history .btn')].find(n=>n.textContent==='Practise from it').click()");
  await until(()=>evaluate("return !!document.querySelector('.pr-source-link')"),'branch from history');
  await until(()=>evaluate("return !!document.querySelector('.pr-editor .monaco-editor') && document.querySelector('.pr-save').textContent==='Saved'"),'history branch saved before navigation');

  // A fresh page with a failed loader exercises the real fallback in both modes.
  await send('Network.enable'); await send('Network.setCacheDisabled', {cacheDisabled:true});
  await send('Network.setBlockedURLs', {urls:['*/vendor/monaco/*']});
  await send('Page.navigate', {url:origin+'/?editor-fallback=1'+practiceHash});
  await until(() => evaluate("return !!document.querySelector('.pr-editor .ws-fallback')"), 'practice fallback');
  assert.ok(await evaluate("const a=document.querySelector('.ws-fallback').getBoundingClientRect(),h=document.querySelector('.python-editor-frame').getBoundingClientRect();return a.left-h.left>=12&&h.right-a.right>=12"),'fallback uses the same structural edge inset');
  const original = await evaluate("const a=document.querySelector('.ws-fallback');a.focus();a.setSelectionRange(0,0);return a.value");
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  assert.equal(await evaluate("return document.querySelector('.ws-fallback').value"), '    '+original, 'fallback Tab inserts four spaces');
  await evaluate("document.querySelector('.editor-wrap').click()");
  assert.equal(await evaluate("return document.querySelector('.ws-fallback').wrap"), 'soft', 'fallback wrap follows shared preference');
  await until(() => evaluate("return document.querySelector('.pr-save').textContent==='Saved'"), 'fallback save');
  await evaluate("location.hash='#/lld/lld-locker/1760000000000-00000010'");
  await until(() => evaluate("return !!document.querySelector('.lld-code .ws-fallback')"), 'read-only fallback');
  assert.equal(await evaluate("return document.querySelector('.ws-fallback').readOnly"), true);
  await evaluate("document.querySelector('.ws-fallback').focus()");
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  assert.equal(await evaluate("return document.querySelector('.ws-fallback').value"), '# Candidate design\n', 'Tab cannot mutate read-only fallback');
  assert.equal(await evaluate("document.querySelector('.editor-wrap').click();return document.querySelector('.ws-fallback').wrap"), 'off', 'read-only wrap remains usable');
  assert.equal(await evaluate("const {mountPythonEditor}=await import('/js/python-editor.js');const h=document.createElement('div');document.body.append(h);const e=mountPythonEditor(h,'keep');e.dispose();await e.ready;const n=h.children.length;h.remove();return n"), 0, 'late loader never resurrects disposed editor');
  console.log(`python-editor check passed (${initial.wrap}, ${initial.cursor})`);
  if(process.env.STUDIO_CHECK_REVIEW==='1') {
    console.log(`Manual review: ${origin}/${practiceHash}`);
    await new Promise(resolve=>{process.stdin.once('data',resolve);process.once('SIGUSR1',resolve);});
    process.stdin.pause();
  }
} finally {
  socket?.close(); chrome?.kill('SIGTERM'); server?.kill('SIGTERM');
  await cleanupChrome(chrome, profile); await fs.rm(home, { recursive: true, force: true }).catch(() => {});
}
