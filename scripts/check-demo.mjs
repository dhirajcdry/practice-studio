// Real browser checks for roadmap interaction, data integrity, themes, and narrow screens.
import {spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const profile = await mkdtemp(path.join(os.tmpdir(), 'studio-demo-ui-check-'));
const origin = process.env.STUDIO_ORIGIN || 'http://127.0.0.1:4196';
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=9353', `--user-data-dir=${profile}`,
  '--window-size=1600,1000', 'about:blank',
], {stdio: 'ignore'});
let ws;
try {
  let targets;
  for (let i = 0; i < 100; i++) {
    try { targets = await (await fetch('http://127.0.0.1:9353/json')).json(); break; }
    catch { await sleep(100); }
  }
  const page = targets?.find((target) => target.type === 'page');
  if (!page) throw new Error('Chrome remote debugging page did not start');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, {once: true}));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const requestId = ++id; pending.set(requestId, resolve);
    ws.send(JSON.stringify({id: requestId, method, params}));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (result.result?.exceptionDetails) throw Error(result.result.exceptionDetails.exception?.description);
    return result.result?.result?.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw Error(`Timed out: ${expression}`);
  };
  await send('Page.enable');await send('Network.enable');await send('Network.setCacheDisabled',{cacheDisabled:true});
  await send('Page.navigate',{url:origin+'/tests.html'});
  await until(`document.querySelector('#headline')?.textContent.includes('tests')`);
  const headline=await evaluate(`document.querySelector('#headline').textContent`);
  if(!headline.startsWith('All '))throw Error(headline+': '+await evaluate(`[...document.querySelectorAll('.t.fail')].map(n=>n.textContent).join(' | ')`));
  await send('Page.navigate',{url:origin+'/#/p/contains-duplicate'});
  await until(`Boolean(document.querySelector('.ws-run') && window.monaco?.editor.getModels().length)`);
  const checked=await evaluate(`(async()=>{
    const {api,submitCode}=await import('/js/api.js');
    const {shapeSubmitResult,renderSubmitResult}=await import('/js/submit.js');
    let posts=0;const actualFetch=window.fetch;window.fetch=(input,...args)=>{if(String(input).startsWith('/api/submit'))posts++;return actualFetch(input,...args);};
    const raw=await submitCode('contains-duplicate','unused');
    const shaped=shapeSubmitResult(raw,'contains-duplicate');const holder=document.createElement('div');renderSubmitResult(holder,shaped,{onResubmit:()=>{throw Error('Retry must not exist');}});
    let opened='';const originalOpen=window.open;window.open=url=>{opened=url;return null;};document.querySelector('.ws-submit').click();await new Promise(resolve=>setTimeout(resolve,100));window.open=originalOpen;window.fetch=actualFetch;
    return {demo:api.demo,label:document.querySelector('#srcLabel').textContent,button:document.querySelector('.ws-submit').textContent,posts,opened,text:holder.textContent,retry:holder.querySelector('.act')!==null,check:holder.querySelector('.sub-check')!==null,mic:document.querySelector('.coach-actions .vc')!==null};
  })()`);
  if(!checked.demo||checked.label!=='Demo'||checked.button!=='Submit'||checked.posts!==0||checked.opened!==''||checked.retry||checked.check||checked.mic||!checked.text.includes('Nothing was sent'))throw Error(JSON.stringify(checked));
  await send('Page.navigate',{url:'http://127.0.0.1:4173/#/p/contains-duplicate'});
  await until(`Boolean(document.querySelector('.ws-submit') && window.monaco?.editor.getModels().length)`);
  const regular=await evaluate(`(async()=>{const {api}=await import('/js/api.js');return !api.demo&&document.querySelector('.ws-submit').textContent==='Submit'&&document.querySelector('#srcLabel').textContent==='Live';})()`);
  if(!regular)throw Error('The regular Studio lost its Submit control');
  const direct=await evaluate(`(async()=>{
    // Stand in for the Studio Connector extension: one submit message per click, answered signed-out.
    let posts=0,opened=0,asked=0;const actualFetch=window.fetch;const actualOpen=window.open;
    document.documentElement.dataset.studioConnector='check';
    const connector=(event)=>{const d=event.data;if(d?.source!=='studio-page'||d.type!=='submit')return;asked++;
      window.postMessage({source:'studio-connector',id:d.id,result:{ok:false,code:'SIGNED_OUT',message:'Test connection',submissionState:'not_sent'}},location.origin);};
    window.addEventListener('message',connector);
    window.fetch=(input,init)=>{if(String(input).startsWith('/api/submit'))posts++;return actualFetch(input,init);};
    window.open=()=>{opened++;return null;};
    document.querySelector('.ws-submit').click();
    await new Promise(resolve=>setTimeout(resolve,500));
    window.fetch=actualFetch;window.open=actualOpen;window.removeEventListener('message',connector);delete document.documentElement.dataset.studioConnector;
    return {asked,posts,opened};
  })()`);
  if(direct.asked!==1||direct.posts!==0||direct.opened!==0)throw Error('Direct submit contract failed: '+JSON.stringify(direct));
  console.log(headline+'; demo is identified, Submit never redirects to LeetCode, and blocked demo states have no retry or uncertainty warning.');
} finally {
  ws?.close(); chrome.kill(); await sleep(200);
  await rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
