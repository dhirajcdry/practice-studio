import { cleanupChrome } from './chrome-cleanup.mjs';
// End-to-end tutor handoff with fake providers and a fake Writer; never real notes.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { workspace } from '../server/coach/test/tools-fixture.mjs';
const ROOT=path.resolve(new URL('..',import.meta.url).pathname);
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const origin='http://127.0.0.1:4195',debugPort=9365;
const fixture=await workspace(),profile=await fsp.mkdtemp(path.join(os.tmpdir(),'studio-writer-chrome-'));
let server,chrome,socket,calls=0,payload;
const writer=http.createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.method==='POST'){let raw='';for await(const c of req)raw+=c;payload=JSON.parse(raw);calls++;}res.end(JSON.stringify({id:payload?.id,status:'done',stage:'Handout ready'}));});
async function until(read, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await read();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function connectBrowser() {
  const target = await until(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json`);
      return (await response.json()).find(tab => tab.type === 'page');
    } catch { return null; }
  }, 'Chrome');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, message => {
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  }
  return { call, evaluate, wait: expression => until(() => evaluate(expression), expression) };
}

try {
 await new Promise(resolve=>writer.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${writer.address().port}`;
 await fsp.writeFile(path.join(fixture.root,'coach-settings.json'),JSON.stringify({provider:'claude',model:'default'}));
 server=spawn(process.execPath,['server/index.mjs'],{cwd:ROOT,env:{...process.env,STUDIO_HOME:fixture.root,STUDIO_PORT:'4195',STUDIO_MIRROR_DIR:'',STUDIO_WRITER_URL:base,STUDIO_COACH_BINARY:path.join(ROOT,'server/coach/test/bin/fake-claude.mjs'),STUDIO_CODEX_BINARY:path.join(ROOT,'server/coach/test/bin/fake-codex.mjs'),FAKE_CLAUDE_MODE:'tools',FAKE_CLAUDE_TOOL_CALLS:JSON.stringify([{tool:'save_note',arguments:{text:'The learner independently explained lookup before insertion.'}},{tool:'start_notes_session',arguments:{title:'Complement lookups',message:'Explore related interview concepts.',context:'The learner understands lookup before insertion.'}}])},stdio:['ignore','ignore','pipe']});
 let logs='';server.stderr.on('data',b=>logs=(logs+b).slice(-3000));
 await until(async()=>{if(server.exitCode!==null)throw Error(logs);try{return (await fetch(origin+'/api/health')).ok;}catch{return false;}},'scratch server');
 chrome=spawn(CHROME,['--headless=new','--disable-background-networking','--no-first-run',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,'--window-size=1280,1000','about:blank'],{stdio:'ignore'});
 const {call,evaluate,wait}=await connectBrowser();await call('Network.enable');await call('Network.setBlockedURLs',{urls:['https://*']});await call('Page.navigate',{url:origin+'/#/p/two-sum'});
 await wait(`document.querySelector('.coach-compose textarea')`);
 await evaluate(`(()=>{document.body.classList.add('coach-open');const input=document.querySelector('.coach-compose textarea');input.value='Start a notes session about this insight.';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.coach-send').click();})()`);
 await wait(`document.querySelector('[data-tool="start_notes_session"] a')?.textContent.includes('Handout ready')`);
 assert.match(await evaluate(`document.querySelector('[data-tool="save_note"]').textContent`),/Updated tutor memory/);
 const href=await evaluate(`document.querySelector('[data-tool="start_notes_session"] a').href`);assert.equal(href,base+'/?session='+payload.id);assert.equal(calls,1);assert.equal(payload.source.app,'practice-studio');assert.match(payload.source.conversationId,/coding:two-sum/);assert.match(payload.source.url,/#\/p\/two-sum/);
 await wait(`!document.querySelector('.coach-send').disabled`);
 await call('Page.reload');
 await wait(`document.querySelector('.coach-compose textarea')`);
 await evaluate(`document.body.classList.add('coach-open')`);
 await wait(`document.querySelector('.recent-chat') || document.querySelector('[data-tool="start_notes_session"] a')`);
 await evaluate(`document.querySelector('.recent-chat')?.click()`);
 await wait(`document.querySelector('[data-tool="start_notes_session"] a')?.textContent.includes('Handout ready')`);assert.equal(calls,1);
 if(process.env.STUDIO_WRITER_SCREENSHOT){const screenshot=await call('Page.captureScreenshot',{format:'png'});await fsp.writeFile(process.env.STUDIO_WRITER_SCREENSHOT,Buffer.from(screenshot.data,'base64'));}
 console.log('passed: distinct tutor-memory receipt, tutor context handoff, durable delivery, source identity, linked live status, reload without duplicate generation');
} finally {
 socket?.close();for(const child of [chrome,server])if(child&&child.exitCode===null&&!child.signalCode)await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},3000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill();});
 await new Promise(resolve=>writer.close(resolve));await fixture.cleanup();await cleanupChrome(chrome, profile);
}
